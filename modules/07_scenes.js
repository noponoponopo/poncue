// modules/07_scenes.js

import { state, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { dbRequest, openDB } from './04_db.js';
import { initAudioContext, getAudioBufferFromDataUrl, stopAllSounds, triggerWaveformUpdate, setMasterLimiterThreshold } from './06_audio.js';
import { showAlert, showConfirm, initDarkMode, updateDraggableState, hideModal, escapeHtml, updateMasterVolumeKnob } from './05_ui.js';
import { MAX_FILE_SIZE_MB, SETTINGS_STORE_NAME, SCENES_STORE_NAME, AUDIO_FILES_STORE_NAME, PERFORMANCE_MODE, DEFAULT_PERFORMANCE_MODE, FADE_EASING_TYPES, DEFAULT_FADE_EASING, TRIGGER_MODES, DEFAULT_TRIGGER_MODE } from './01_config.js';

// --- レンダリング関数を保持するオブジェクト ---
export const renderers = {
    renderSoundboard: () => {},
};

// --- ヘルパー関数 ---
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function dataURLtoBlob(dataurl) {
    if (!dataurl || typeof dataurl !== 'string') return null;
    try {
        const arr = dataurl.split(',');
        const mimeMatch = arr[0].match(/:(.*?);/);
        if (!mimeMatch) return null;
        const mime = mimeMatch[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    } catch (e) {
        return null;
    }
}

/**
 * sound オブジェクトのフェード関連フィールドを正規化する。
 * 旧スキーマ (fadeDuration 単体) を新スキーマ (fadeInDuration/fadeOutDuration + 各 easing) に寄せる。
 * DB保存時に呼ばれるため、安全に冪等に動作する。
 */
export function normalizeSoundFade(sound) {
    if (!sound || typeof sound !== 'object') return sound;
    const legacyFadeDuration = Number.isFinite(sound.fadeDuration) ? sound.fadeDuration : 0;
    if (!Number.isFinite(sound.fadeInDuration)) {
        sound.fadeInDuration = Math.max(0, legacyFadeDuration);
    }
    if (!Number.isFinite(sound.fadeOutDuration)) {
        sound.fadeOutDuration = Math.max(0, legacyFadeDuration);
    }
    if (!FADE_EASING_TYPES.includes(sound.fadeInEasing)) sound.fadeInEasing = DEFAULT_FADE_EASING;
    if (!FADE_EASING_TYPES.includes(sound.fadeOutEasing)) sound.fadeOutEasing = DEFAULT_FADE_EASING;
    return sound;
}

export function normalizeSoundTriggerMode(sound) {
    if (!sound || typeof sound !== 'object') return sound;
    if (!TRIGGER_MODES.includes(sound.triggerMode)) {
        sound.triggerMode = sound.holdToPlay ? 'momentary' : DEFAULT_TRIGGER_MODE;
    }
    delete sound.holdToPlay;
    return sound;
}

// --- V1からV2へのデータ移行処理 ---
async function checkForAndMigrateV1Data() {
    const migrationDone = localStorage.getItem('pon_v1_migration_complete');
    if (migrationDone) {
        return;
    }

    if (!('databases' in indexedDB)) {
        localStorage.setItem('pon_v1_migration_complete', 'true');
        return;
    }

    const dbs = await indexedDB.databases();
    const v1DbExists = dbs.some(db => db.name === 'ponndashiDB_v1');

    if (!v1DbExists) {
        localStorage.setItem('pon_v1_migration_complete', 'true');
        return;
    }

    showAlert("古いデータが見つかりました。新しい形式に変換します。完了後、ページが再読み込みされます。", "データ移行");

    try {
        const v1Db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('ponndashiDB_v1', 1);
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e.target.error);
        });

        const tx = v1Db.transaction('scenesStore', 'readonly');
        const oldScenes = await new Promise((resolve, reject) => {
            const request = tx.objectStore('scenesStore').getAll();
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e.target.error);
        });

        for (const scene of oldScenes) {
            const newScene = { ...scene, sounds: [] };
            for (const sound of scene.sounds) {
                if (sound.dataUrl) {
                    const blob = dataURLtoBlob(sound.dataUrl);
                    if (blob) {
                        const audioId = generateUniqueId('aud');
                        await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: blob });
                        const newSound = { ...sound, audioId: audioId };
                        delete newSound.dataUrl;
                        newScene.sounds.push(newSound);
                    }
                }
            }
            await dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', newScene);
        }

        v1Db.close();
        await new Promise((resolve, reject) => {
            const deleteRequest = indexedDB.deleteDatabase('ponndashiDB_v1');
            deleteRequest.onsuccess = resolve;
            deleteRequest.onerror = reject;
            deleteRequest.onblocked = () => {
                showAlert("古いデータベースの削除がブロックされました。他のタブを閉じてリロードしてください。");
                reject(new Error("V1 DB delete blocked"));
            };
        });
        
        localStorage.setItem('pon_v1_migration_complete', 'true');
        showAlert("データ移行が完了しました。ページを再読み込みします。", "完了");
        setTimeout(() => window.location.reload(), 2000);

    } catch (err) {
        showAlert(`データ移行中にエラーが発生しました: ${err.message}`, "エラー");
    }
}


// --- 初期化 ---
export async function initializeApp() {
    if (!initAudioContext()) {
        throw new Error("Critical: Failed to initialize AudioContext.");
    }
    
    await openDB();
    if (!state.db) {
        throw new Error("Database connection failed. App cannot start.");
    }

    await checkForAndMigrateV1Data();

    await Promise.all([loadSettings(), loadScenesFromDB()]);

    // --- Audio integrity check: verify each referenced audio record is usable ---
    const missingSounds = [];
    try {
        const referencedAudioIds = new Set();
        for (const sceneId in state.scenes) {
            for (const sound of state.scenes[sceneId].sounds) {
                if (sound.audioId) referencedAudioIds.add(sound.audioId);
            }
        }

        const validAudioIds = new Set();
        for (const audioId of referencedAudioIds) {
            const audioRecord = await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'get', audioId);
            if (audioRecord?.blob instanceof Blob && audioRecord.blob.size > 0) {
                validAudioIds.add(audioId);
            }
        }

        for (const sceneId in state.scenes) {
            const scene = state.scenes[sceneId];
            for (const sound of scene.sounds) {
                if (!sound.audioId || !validAudioIds.has(sound.audioId)) {
                    if (!sound.error) sound.error = 'Audio data missing';
                    missingSounds.push(`${scene.name} / ${sound.name}`);
                } else if (sound.error === 'Audio data missing') {
                    delete sound.error;
                }
            }
        }
    } catch (e) {
        console.error('Audio integrity check failed:', e);
    }
    // --- End of audio integrity check ---

    // --- Data Migration for missing durations ---
    let migrationNeeded = false;
    for (const sceneId in state.scenes) {
        for (const sound of state.scenes[sceneId].sounds) {
            if (typeof sound.duration !== 'number') {
                migrationNeeded = true;
                break;
            }
        }
        if (migrationNeeded) break;
    }

    if (migrationNeeded) {
        console.log("Data migration needed for audio durations. Starting...");
        showAlert("サウンドのメタデータを更新しています...", "データ更新");
        for (const sceneId in state.scenes) {
            const scene = state.scenes[sceneId];
            let sceneUpdated = false;
            for (const sound of scene.sounds) {
                if (typeof sound.duration !== 'number' && sound.audioId) {
                    try {
                        const audioRecord = await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'get', sound.audioId);
                        if (audioRecord && audioRecord.blob) {
                            const duration = await new Promise((resolve, reject) => {
                                const audio = new Audio(URL.createObjectURL(audioRecord.blob));
                                audio.addEventListener('loadedmetadata', () => {
                                    URL.revokeObjectURL(audio.src);
                                    resolve(audio.duration);
                                });
                                audio.addEventListener('error', (e) => {
                                    URL.revokeObjectURL(audio.src);
                                    reject(e);
                                });
                            });
                            sound.duration = duration;
                            sceneUpdated = true;
                        }
                    } catch (e) {
                        console.error(`Failed to get duration for sound ${sound.name}:`, e);
                    }
                }
            }
            if (sceneUpdated) {
                await saveCurrentSceneSounds(`migration-duration-${sceneId}`, sceneId);
            }
        }
        console.log("Duration migration finished.");
        hideModal(); // Hide the "Updating..." message
    }

    // --- Data Migration: fadeDuration → fadeInDuration/fadeOutDuration + easing ---
    let fadeMigrationNeeded = false;
    for (const sceneId in state.scenes) {
        for (const sound of state.scenes[sceneId].sounds) {
            if ('fadeDuration' in sound) { fadeMigrationNeeded = true; break; }
        }
        if (fadeMigrationNeeded) break;
    }
    if (fadeMigrationNeeded) {
        console.log("Fade schema migration needed. Starting...");
        for (const sceneId in state.scenes) {
            const scene = state.scenes[sceneId];
            let sceneUpdated = false;
            for (const sound of scene.sounds) {
                if ('fadeDuration' in sound) {
                    normalizeSoundFade(sound);
                    delete sound.fadeDuration;
                    sceneUpdated = true;
                }
            }
            if (sceneUpdated) {
                await saveCurrentSceneSounds(`migration-fade-${sceneId}`, sceneId);
            }
        }
        console.log("Fade schema migration finished.");
    }

    let triggerMigrationNeeded = false;
    for (const sceneId in state.scenes) {
        for (const sound of state.scenes[sceneId].sounds) {
            if (!TRIGGER_MODES.includes(sound.triggerMode) || 'holdToPlay' in sound) {
                triggerMigrationNeeded = true;
                break;
            }
        }
        if (triggerMigrationNeeded) break;
    }
    if (triggerMigrationNeeded) {
        for (const sceneId in state.scenes) {
            const scene = state.scenes[sceneId];
            let sceneUpdated = false;
            for (const sound of scene.sounds) {
                if (!TRIGGER_MODES.includes(sound.triggerMode) || 'holdToPlay' in sound) {
                    normalizeSoundTriggerMode(sound);
                    sceneUpdated = true;
                }
            }
            if (sceneUpdated) {
                await saveCurrentSceneSounds(`migration-trigger-${sceneId}`, sceneId);
            }
        }
    }
    // --- End of Data Migration ---

    initDarkMode();

    let sceneIdToSelect = state.currentSceneId;
    if (!sceneIdToSelect || !state.scenes[sceneIdToSelect]) {
        const sceneIds = Object.keys(state.scenes);
        if (sceneIds.length > 0) {
            sceneIdToSelect = sceneIds[0];
        } else {
            const defaultSceneId = generateUniqueId('scn');
            const defaultScene = { id: defaultSceneId, name: "Default Scene", sounds: [] };
            await dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', defaultScene);
            state.scenes[defaultSceneId] = defaultScene;
            sceneIdToSelect = defaultSceneId;
        }
        await saveSetting('currentSceneId', sceneIdToSelect);
    }

    if (sceneIdToSelect) {
        await selectScene(sceneIdToSelect);
    } else {
        renderFallbackUI("利用可能なシーンがありません。");
    }
    
    updateDraggableState();

    if (missingSounds.length > 0) {
        const list = missingSounds.map(s => `・${s}`).join('\n');
        await showAlert(
            `以下のサウンドの音源が見つかりません。ファイルが削除されたかデータが破損しています。\n\n${list}`,
            '音源チェック'
        );
    }
}

export function renderFallbackUI(message) {
    if (dom.soundboard) { dom.soundboard.innerHTML = `<div class="fallback-message">${escapeHtml(message)}</div>`; }
    if (dom.levelMeterArea) dom.levelMeterArea.innerHTML = '';
}

export function disableAppControls() {
    const elementsToDisable = [
        dom.addSoundBtn, dom.sceneSettingsBtn, dom.masterVolumeControl,
        dom.modalImportBtn, dom.modalExportBtn, dom.modalAddSceneBtn
    ];
    elementsToDisable.forEach(el => { if(el) el.disabled = true; });
}

// --- 設定管理 ---
export async function loadSettings() {
    try {
        const settingsToLoad = ['currentSceneId', 'darkMode', 'masterVolume', 'isSortableEnabled', 'shortcuts', 'performanceMode', 'showWaveform', 'padSize', 'masterEq', 'masterComp', 'masterDelay', 'masterPan', 'masterDistortion', 'masterReverb', 'masterLimiter', 'keyboardViewVisible'];
        const results = await Promise.all(settingsToLoad.map(key => dbRequest(SETTINGS_STORE_NAME, 'readonly', 'get', key).catch(() => null)));
        const settings = results.reduce((acc, res, index) => {
            if (res) acc[settingsToLoad[index]] = res.value;
            return acc;
        }, {});

        updateState({
            currentSceneId: settings.currentSceneId ?? null,
            masterVolume: settings.masterVolume ?? 1.0,
            isSortableEnabled: settings.isSortableEnabled ?? false,
            shortcuts: settings.shortcuts ?? {},
            performanceMode: settings.performanceMode ?? DEFAULT_PERFORMANCE_MODE,
            showWaveform: settings.showWaveform ?? true,
            padSize: settings.padSize ?? 160,
            masterEq: settings.masterEq ?? { low: 0, mid: 0, high: 0 },
            masterComp: settings.masterComp ?? { threshold: 0, ratio: 1 },
            masterDelay: settings.masterDelay ?? { time: 0.18, feedback: 0, level: 0 },
            masterPan: settings.masterPan ?? { value: 0 },
            masterDistortion: settings.masterDistortion ?? { amount: 0 },
            masterReverb: settings.masterReverb ?? { decay: 2.0, wet: 0 },
            masterLimiter: settings.masterLimiter ?? { threshold: -1 },
            keyboardViewVisible: settings.keyboardViewVisible ?? false
        });
        
        localStorage.setItem('darkModePref', settings.darkMode ?? 'system');
        
        updateMasterVolumeKnob(state.masterVolume);
        if (state.masterGainNode) state.masterGainNode.gain.setValueAtTime(state.masterVolume, state.audioContext.currentTime);
        setMasterLimiterThreshold(state.masterLimiter.threshold);
        if (dom.interactionClickRadio) dom.interactionClickRadio.checked = !state.isSortableEnabled;
        if (dom.interactionDragRadio) dom.interactionDragRadio.checked = state.isSortableEnabled;
        if (dom.perfHighRadio) dom.perfHighRadio.checked = (state.performanceMode === PERFORMANCE_MODE.HIGH_PERFORMANCE);
        if (dom.perfLowRadio) dom.perfLowRadio.checked = (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY);
        if (dom.waveformToggleCheckbox) dom.waveformToggleCheckbox.checked = state.showWaveform;
        if (dom.padSizeSlider) dom.padSizeSlider.value = state.padSize;
        if (dom.padSizeValue) dom.padSizeValue.textContent = state.padSize;
        updatePadSizeCSS(state.padSize);
    } catch (err) {
        if (state.showErrorPopups) showAlert("設定の読み込みに失敗しました。");
    }
}

export async function saveSetting(key, value) {
    try {
        await dbRequest(SETTINGS_STORE_NAME, 'readwrite', 'put', { key, value });
        if (key === 'darkMode') {
            localStorage.setItem('darkModePref', value);
        }
    } catch (err) {
        if (state.showErrorPopups) showAlert(`設定「${key}」の保存に失敗しました。`);
    }
}

// --- シーン管理 ---
export async function loadScenesFromDB() {
    try {
        const scenesArray = await dbRequest(SCENES_STORE_NAME, 'readonly', 'getAll');
        const loadedScenes = {};
        scenesArray.forEach(sceneData => {
            if (sceneData?.id) {
                loadedScenes[sceneData.id] = sceneData;
            }
        });
        updateState({ scenes: loadedScenes });
    } catch (err) {
        updateState({ scenes: {} });
        if (state.showErrorPopups) showAlert("シーンの読み込み中にエラーが発生しました。");
    }
}

async function getSceneWithPopulatedDataUrls(sceneId, force = false) {
    const scene = state.scenes[sceneId];
    if (!scene) return null;

    const sceneCopy = JSON.parse(JSON.stringify(scene));
    
    const audioFetchPromises = sceneCopy.sounds.map(async (sound) => {
        // Populate dataUrl if forced (for export) or if in high-perf mode.
        if ((force || state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY) && sound.audioId && !sound.dataUrl) {
            try {
                const audioRecord = await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'get', sound.audioId);
                if (audioRecord && audioRecord.blob) {
                    sound.dataUrl = await blobToDataURL(audioRecord.blob);
                } else {
                    sound.error = 'Audio data missing';
                }
            } catch (err) {
                sound.error = 'Audio load failed';
            }
        }
    });

    await Promise.all(audioFetchPromises);
    return sceneCopy;
}

export async function selectScene(sceneId) {
    stopAllSounds(false);
    updateState({ decodedAudioBuffers: {}, reversedAudioBuffers: {} });
    triggerWaveformUpdate();

    if (!state.scenes[sceneId]) {
        sceneId = Object.keys(state.scenes)[0] || null;
        if (!sceneId) {
            renderFallbackUI("表示できるシーンがありません。");
            updateState({ currentSceneId: null });
            await saveSetting('currentSceneId', null);
            renderers.renderSoundboard();
            return;
        }
    }

    updateState({ currentSceneId: sceneId });
    
    const sceneWithData = await getSceneWithPopulatedDataUrls(sceneId);
    if (sceneWithData) {
        state.scenes[sceneId] = sceneWithData;
        if (state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY) { // Only pre-decode if not in low memory mode
            await Promise.all(sceneWithData.sounds.map(async sound => {
                if (!sound.dataUrl) return;
                const audioBuffer = await getAudioBufferFromDataUrl(sound.id, sound.dataUrl);
                if (!audioBuffer) sound.error = 'Audio decode failed';
            }));
        }
    }

    const sceneColor = state.scenes[sceneId]?.color;
    const iconStyle = sceneColor ? ` style="color: ${sceneColor};"` : '';
    const h1 = document.querySelector('header h1');
    if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"${iconStyle}></i> ${escapeHtml(state.scenes[sceneId]?.name || 'シーンなし')}`;
    
    renderers.renderSoundboard();
    
    if (dom.sceneSettingsModal?.classList.contains('active')) {
        populateSceneModalList();
    }
    await saveSetting('currentSceneId', sceneId);
}

// --- サウンド管理 ---
export async function handleAudioFileSelect(event) {
    if (!state.currentSceneId) {
        showAlert("ファイルを追加するシーンが選択されていません。");
        event.target.value = null;
        return;
    }

    const files = Array.from(event.target.files);
    event.target.value = null;
    if (files.length === 0) return;

    const addedSounds = [];
    const failedSounds = [];

    for (const file of files) {
        if (!file.type.startsWith('audio/')) {
            failedSounds.push({ name: file.name, reason: '音声ファイル形式ではありません' });
            continue;
        }
        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            failedSounds.push({ name: file.name, reason: `ファイルサイズが${MAX_FILE_SIZE_MB}MBを超えています` });
            continue;
        }

        try {
            const audioId = generateUniqueId('aud');
            await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: file });

            // Get audio duration
            const duration = await new Promise((resolve, reject) => {
                const audio = new Audio(URL.createObjectURL(file));
                audio.addEventListener('loadedmetadata', () => {
                    URL.revokeObjectURL(audio.src);
                    resolve(audio.duration);
                });
                audio.addEventListener('error', (e) => {
                    URL.revokeObjectURL(audio.src);
                    reject(e);
                });
            });

            const newSound = {
                id: generateUniqueId('snd'),
                name: file.name.replace(/\.[^/.]+$/, ""),
                loop: false,
                volume: 1.0,
                pan: 0,
                audioId: audioId,
                triggerMode: DEFAULT_TRIGGER_MODE,
                fadeInDuration: 0.0,
                fadeOutDuration: 0.0,
                fadeInEasing: DEFAULT_FADE_EASING,
                fadeOutEasing: DEFAULT_FADE_EASING,
                reverse: false,
                playbackRate: 1.0,
                preservePitch: false,
                effects: { enabled: false },
                duration: duration, // Add duration to sound object
            };
            addedSounds.push(newSound);
        } catch (err) {
            failedSounds.push({ name: file.name, reason: 'データベースへの保存または音声の長さの取得に失敗しました' });
        }
    }

    if (addedSounds.length > 0) {
        const scene = state.scenes[state.currentSceneId];
        scene.sounds.push(...addedSounds);
        await saveCurrentSceneSounds("handleAudioFileSelect");
        await selectScene(state.currentSceneId);
    }

    if (failedSounds.length > 0 && state.showErrorPopups) {
        const errorMessage = `以下の${failedSounds.length}件のファイルを追加できませんでした:\n` +
                             failedSounds.map(f => `- ${f.name}: ${f.reason}`).join('\n');
        showAlert(errorMessage.trim());
    }
}

export async function removeSound(soundId) {
    if (state.decodedAudioBuffers[soundId] && state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY) {
        delete state.decodedAudioBuffers[soundId];
        triggerWaveformUpdate();
    }
    if (!state.currentSceneId) return;

    const scene = state.scenes[state.currentSceneId];
    const soundIndex = scene.sounds.findIndex(s => s.id === soundId);
    if (soundIndex === -1) return;

    const [removedSound] = scene.sounds.splice(soundIndex, 1);
    
    await saveCurrentSceneSounds(`removeSound-${soundId}`);
    renderers.renderSoundboard();

    if (removedSound.audioId) {
        try {
            await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', removedSound.audioId);
        } catch (err) {
            showAlert("音声ファイルの削除に失敗しました。");
        }
    }
}

export async function saveCurrentSceneSounds(triggeredBy = "unknown", sceneId = state.currentSceneId) {
    if (!sceneId) return;
    const scene = state.scenes[sceneId];
    if (!scene) return;

    const sceneToSave = JSON.parse(JSON.stringify(scene));
    sceneToSave.sounds.forEach(sound => {
        delete sound.dataUrl;
        delete sound.error;
    });

    await dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', sceneToSave);
}

// --- インポート・エクスポート ---

async function waitForJSZip(retries = 5, delay = 100) {
    for (let i = 0; i < retries; i++) {
        if (typeof JSZip !== 'undefined') {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    return false;
}

export async function exportSceneAsZip(sceneId) {
    const jszipReady = await waitForJSZip();
    if (!jszipReady) {
        showAlert("エクスポート機能の読み込みに失敗しました。ページを再読み込みしてください。");
        return;
    }

    // Force population of data URLs for export
    const scene = await getSceneWithPopulatedDataUrls(sceneId, true);
    if (!scene) {
        showAlert("エクスポート対象のシーンが見つかりません。");
        return;
    }

    const zip = new JSZip();

    const sceneMeta = JSON.parse(JSON.stringify(scene));
    const audioFiles = [];

    sceneMeta.sounds.forEach((sound, index) => {
        if (sound.dataUrl) {
            const blob = dataURLtoBlob(sound.dataUrl);
            if (blob) {
                const fileExtension = blob.type.split('/')[1] || 'mp3';
                const fileName = `audio/${sound.id}.${fileExtension}`;
                sound.fileName = fileName;
                audioFiles.push({ fileName, blob });
                delete sound.dataUrl;
                delete sound.audioId;
            }
        }
    });

    zip.file("scene.json", JSON.stringify(sceneMeta, null, 2));
    audioFiles.forEach(file => {
        zip.file(file.fileName, file.blob);
    });

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `ponndashi_scene_${scene.name.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function handleImportFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = null;

    if (file.name.endsWith('.zip')) {
        await handleZipImport(file);
    } else if (file.name.endsWith('.json')) {
        await handleLegacyJsonImport(file);
    } else {
        showAlert("ZIPまたはJSONファイルを選択してください。");
    }
}

async function handleZipImport(file) {
    const jszipReady = await waitForJSZip();
    if (!jszipReady) {
        showAlert("インポート機能の読み込みに失敗しました。ページを再読み込みしてください。");
        return;
    }

    const zip = await JSZip.loadAsync(file);
    const sceneJsonFile = zip.file("scene.json");
    if (!sceneJsonFile) {
        showAlert("ZIPファイル内にscene.jsonが見つかりません。");
        return;
    }

    try {
        const sceneMetaData = JSON.parse(await sceneJsonFile.async("string"));
        const importedScene = sceneMetaData;

        const existingNames = Object.values(state.scenes).map(s => s.name);
        let newName = importedScene.name;
        let counter = 1;
        while (existingNames.includes(newName)) {
            newName = `${importedScene.name} (${counter})`;
            counter++;
        }
        importedScene.name = newName;
        importedScene.id = generateUniqueId('scn');

        for (const sound of importedScene.sounds) {
            normalizeSoundFade(sound);
            if ('fadeDuration' in sound) delete sound.fadeDuration;
            normalizeSoundTriggerMode(sound);
            if (sound.fileName) {
                const audioFileInZip = zip.file(sound.fileName);
                if (audioFileInZip) {
                    const arrayBuffer = await audioFileInZip.async("arraybuffer");
                    const fileExtension = sound.fileName.split('.').pop().toLowerCase();
                    const mimeType = `audio/${fileExtension === 'mp3' ? 'mpeg' : fileExtension}`;
                    const blob = new Blob([arrayBuffer], { type: mimeType });

                    const audioId = generateUniqueId('aud');
                    await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: blob });
                    sound.audioId = audioId;
                    delete sound.fileName;
                }
            }
        }

        state.scenes[importedScene.id] = importedScene;
        await dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', importedScene);

        showAlert(`シーン「${importedScene.name}」をインポートしました。`);
        populateSceneModalList();
        await selectScene(importedScene.id);

    } catch (err) {
        showAlert(`ZIPファイルのインポート処理中にエラーが発生しました: ${err.message}`);
    }
}

async function handleLegacyJsonImport(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            if (typeof importedData !== 'object' || importedData === null) {
                throw new Error("無効なJSON形式です。");
            }

            let scenesToAdd = [];
            for (const sceneId in importedData) {
                scenesToAdd.push(importedData[sceneId]);
            }

            if (scenesToAdd.length === 0) {
                showAlert("インポートできる有効なシーンが見つかりませんでした。");
                return;
            }

            const existingNames = Object.values(state.scenes).map(s => s.name);
            let importedCount = 0;
            for (const importedScene of scenesToAdd) {
            let newName = importedScene.name;
            let counter = 1;
            while (existingNames.includes(newName)) {
                newName = `${importedScene.name} (${counter})`;
                counter++;
            }
            importedScene.name = newName;
            importedScene.id = generateUniqueId('scn');
            existingNames.push(newName);

            for (const sound of importedScene.sounds) {
                normalizeSoundFade(sound);
                if ('fadeDuration' in sound) delete sound.fadeDuration;
                normalizeSoundTriggerMode(sound);
                if (sound.dataUrl) {
                    const blob = dataURLtoBlob(sound.dataUrl);
                    if (blob) {
                        const audioId = generateUniqueId('aud');
                        await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: blob });
                        sound.audioId = audioId;
                        delete sound.dataUrl;
                    }
                }
            }
            
            state.scenes[importedScene.id] = importedScene;
            await dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', importedScene);
            importedCount++;
        }

        showAlert(`${importedCount}件のシーンを古い形式(.json)からインポートしました。`);
        populateSceneModalList();
        await selectScene(scenesToAdd[0].id);

    } catch (err) {
        showAlert(`JSONファイルのインポート処理中にエラーが発生しました: ${err.message}`);
    }
};
    reader.readAsText(file);
}


// --- UIレンダリング ---
export function populateSceneModalList() {
    if (!dom.modalSceneList) return;
    dom.modalSceneList.innerHTML = '';
    const sceneIds = Object.keys(state.scenes);
    
    const scenesArray = sceneIds.map(id => state.scenes[id]);
    scenesArray.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    if (scenesArray.length === 0) {
        dom.modalSceneList.innerHTML = '<li>シーンがありません</li>';
        dom.modalExportBtn.disabled = true;
        return;
    }

    scenesArray.forEach(scene => {
        const li = document.createElement('li');
        li.dataset.sceneId = scene.id;
        li.title = `${scene.name} (${scene.sounds.length} サウンド)`;
        if (scene.id === state.currentSceneId) li.classList.add('active');
        const sceneColor = scene.color || '';
        li.style.setProperty('--scene-color', sceneColor || 'transparent');
        li.innerHTML = `
            <span class="modal-scene-name">${escapeHtml(scene.name)}</span>
            <div class="modal-scene-actions">
                <button title="名前を変更" data-action="rename"><i class="fas fa-pencil-alt"></i></button>
                <button title="このシーンをエクスポート (.zip)" data-action="export"><i class="fas fa-file-archive"></i></button>
                <button title="色を変更" data-action="color"><i class="fas fa-palette"></i></button>
                <button title="削除" class="danger" data-action="delete" ${sceneIds.length <= 1 ? 'disabled' : ''}><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
        dom.modalSceneList.appendChild(li);
    });
    dom.modalExportBtn.disabled = false;
    dom.modalExportBtn.style.display = 'none';
}

// --- ユーティリティ ---
export function generateUniqueId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 11)}`;
}

export function updatePadSizeCSS(size) {
    document.documentElement.style.setProperty('--button-min-size', `${size}px`);
}

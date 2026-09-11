// modules/07_scenes.js

import { state, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { dbRequest, openDB } from './04_db.js';
import { initAudioContext, getAudioBufferForSound, stopAllSounds, triggerWaveformUpdate, setMasterLimiterThreshold, applyMasterEffectNodesFromState, setAudioOutputDevice, preloadRollParts, rollPartCacheKey, cacheDecodedBuffer } from './06_audio.js';
import { showAlert, showConfirm, initDarkMode, updateDraggableState, hideModal, escapeHtml, updateMasterVolumeKnob } from './05_ui.js';
import { MAX_FILE_SIZE_MB, SETTINGS_STORE_NAME, SCENES_STORE_NAME, AUDIO_FILES_STORE_NAME, PERFORMANCE_MODE, DEFAULT_PERFORMANCE_MODE, FADE_EASING_TYPES, DEFAULT_FADE_EASING, TRIGGER_MODES, DEFAULT_TRIGGER_MODE, DEFAULT_KEYBOARD_LAYOUT, KEYBOARD_LAYOUTS, AUDIO_DECODE_CONCURRENCY } from './01_config.js';

// --- レンダリング関数を保持するオブジェクト ---
export const renderers = {
    renderSoundboard: () => {},
};
const sceneDeletionGenerations = new Map();

export function markSceneDeleted(sceneId) {
    sceneDeletionGenerations.set(sceneId, (sceneDeletionGenerations.get(sceneId) || 0) + 1);
}

// --- ヘルパー関数 ---
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

function normalizeSceneShortcuts(shortcuts, sounds = []) {
    if (!shortcuts || typeof shortcuts !== 'object' || Array.isArray(shortcuts)) return {};
    const soundIds = new Set(sounds.map(sound => sound.id));
    return Object.fromEntries(
        Object.entries(shortcuts).filter(([shortcut, soundId]) =>
            typeof shortcut === 'string' && shortcut && typeof soundId === 'string' && soundIds.has(soundId)
        )
    );
}

async function migrateSceneShortcuts() {
    const legacyShortcuts = state.shortcuts;
    for (const scene of Object.values(state.scenes)) {
        const hasSceneShortcuts = Object.prototype.hasOwnProperty.call(scene, 'shortcuts');
        const source = hasSceneShortcuts ? scene.shortcuts : legacyShortcuts;
        const shortcuts = normalizeSceneShortcuts(source, scene.sounds);
        if (hasSceneShortcuts && JSON.stringify(source) === JSON.stringify(shortcuts)) continue;
        scene.shortcuts = shortcuts;
        await saveCurrentSceneSounds('migration-scene-shortcuts', scene.id);
    }
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
    if (!(await initAudioContext())) {
        throw new Error("Critical: Failed to initialize AudioContext.");
    }
    
    await openDB();
    if (!state.db) {
        throw new Error("Database connection failed. App cannot start.");
    }

    await checkForAndMigrateV1Data();

    await Promise.all([loadSettings(), loadScenesFromDB()]);
    await migrateSceneShortcuts();

    // --- Roll schema migration: 単一ループ形式を複数ループ配列へ寄せる ---
    for (const sceneId in state.scenes) {
        let sceneUpdated = false;
        for (const sound of state.scenes[sceneId].sounds) {
            if (normalizeRollSound(sound)) sceneUpdated = true;
        }
        if (sceneUpdated) {
            await saveCurrentSceneSounds(`migration-roll-${sceneId}`, sceneId);
        }
    }
    // --- End of roll schema migration ---

    // --- Audio integrity check: verify each referenced audio record is usable ---
    const missingSounds = [];
    try {
        const referencedAudioIds = new Set();
        const collectSoundAudioIds = (sound) => {
            if (sound.audioId) referencedAudioIds.add(sound.audioId);
            // ドラムロールはパートごとに音声を参照する
            if (sound.type === 'roll' && sound.rollParts) {
                if (sound.rollParts.intro) referencedAudioIds.add(sound.rollParts.intro);
                for (const loopAudioId of sound.rollParts.loops || []) {
                    if (loopAudioId) referencedAudioIds.add(loopAudioId);
                }
                if (sound.rollParts.end) referencedAudioIds.add(sound.rollParts.end);
                if (sound.rollParts.finish) referencedAudioIds.add(sound.rollParts.finish);
            }
        };
        for (const sceneId in state.scenes) {
            for (const sound of state.scenes[sceneId].sounds) {
                collectSoundAudioIds(sound);
            }
        }

        // 存在確認はキーだけで行う。blob本体を読むと起動時間が音声データ量に比例してしまう。
        // レコードは put の原子性により key+blob が必ず揃って書き込まれるため、
        // キーの存在確認で十分。blob破損などの詳細チェックは再生時のエラー処理に任せる。
        const validAudioIds = new Set(await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'getAllKeys'));

        const isSoundAudioValid = (sound) => {
            if (sound.type === 'roll') {
                // ロールはループパートのどれか1つでも読み込めれば再生可能
                return (sound.rollParts?.loops || []).some(loopAudioId => loopAudioId && validAudioIds.has(loopAudioId));
            }
            return Boolean(sound.audioId && validAudioIds.has(sound.audioId));
        };

        for (const sceneId in state.scenes) {
            const scene = state.scenes[sceneId];
            for (const sound of scene.sounds) {
                if (!isSoundAudioValid(sound)) {
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
            const defaultScene = { id: defaultSceneId, name: "Default Scene", sounds: [], shortcuts: {} };
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
        const settingsToLoad = ['currentSceneId', 'darkMode', 'masterVolume', 'audioOutputDeviceId', 'audioOutputDeviceLabel', 'isSortableEnabled', 'shortcuts', 'performanceMode', 'showWaveform', 'padSize', 'masterEq', 'masterComp', 'masterDelay', 'masterPan', 'masterDistortion', 'masterReverb', 'masterLimiter', 'keyboardViewVisible', 'keyboardLayout'];
        const results = await Promise.all(settingsToLoad.map(key => dbRequest(SETTINGS_STORE_NAME, 'readonly', 'get', key).catch(() => null)));
        const settings = results.reduce((acc, res, index) => {
            if (res) acc[settingsToLoad[index]] = res.value;
            return acc;
        }, {});

        updateState({
            currentSceneId: settings.currentSceneId ?? null,
            masterVolume: settings.masterVolume ?? 1.0,
            audioOutputDeviceId: settings.audioOutputDeviceId ?? 'default',
            audioOutputDeviceLabel: settings.audioOutputDeviceLabel ?? 'システム既定',
            audioOutputPending: false,
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
            keyboardViewVisible: settings.keyboardViewVisible ?? false,
            keyboardLayout: KEYBOARD_LAYOUTS.includes(settings.keyboardLayout) ? settings.keyboardLayout : DEFAULT_KEYBOARD_LAYOUT
        });
        
        localStorage.setItem('darkModePref', settings.darkMode ?? 'system');
        
        updateMasterVolumeKnob(state.masterVolume);
        if (state.masterGainNode) state.masterGainNode.gain.setValueAtTime(state.masterVolume, state.audioContext.currentTime);
        setMasterLimiterThreshold(state.masterLimiter.threshold);
        // マスターEQ/Comp/Delay/Pan/Distortion/Reverb を state の値でノードへ反映。
        // initAudioContext() がデフォルト値でノードを生成したまま loadSettings() が
        // state を更新するため、ここでノードへ再反映しないとリロード後に効かない。
        applyMasterEffectNodesFromState();
        if (dom.interactionClickRadio) dom.interactionClickRadio.checked = !state.isSortableEnabled;
        if (dom.interactionDragRadio) dom.interactionDragRadio.checked = state.isSortableEnabled;
        if (dom.perfHighRadio) dom.perfHighRadio.checked = (state.performanceMode === PERFORMANCE_MODE.HIGH_PERFORMANCE);
        if (dom.perfLowRadio) dom.perfLowRadio.checked = (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY);
        if (dom.waveformToggleCheckbox) dom.waveformToggleCheckbox.checked = state.showWaveform;
        if (dom.padSizeSlider) dom.padSizeSlider.value = state.padSize;
        if (dom.padSizeValue) dom.padSizeValue.textContent = state.padSize;
        updatePadSizeCSS(state.padSize);
        if (dom.keyboardLayoutSelect) dom.keyboardLayoutSelect.value = state.keyboardLayout;
        try {
            await setAudioOutputDevice(state.audioOutputDeviceId, state.audioOutputDeviceLabel);
        } catch (error) {
            // enumerateDevices() is permission-filtered and cannot prove that a
            // saved sink disappeared. Only NotFoundError is authoritative here.
            if (state.audioOutputDeviceId !== 'default' && error?.name === 'NotFoundError') {
                await setAudioOutputDevice('default', 'システム既定');
                await saveAudioOutputSettings(state.audioOutputDeviceId, state.audioOutputDeviceLabel);
            } else if (state.audioOutputDeviceId !== 'default') {
                updateState({ audioOutputPending: true });
                console.warn('Saved audio output is pending permission or unavailable.', error);
            }
        }
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

export async function saveAudioOutputSettings(deviceId, deviceLabel) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(SETTINGS_STORE_NAME, 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Audio output settings transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Audio output settings transaction aborted'));
        const store = transaction.objectStore(SETTINGS_STORE_NAME);
        store.put({ key: 'audioOutputDeviceId', value: deviceId });
        store.put({ key: 'audioOutputDeviceLabel', value: deviceLabel });
    });
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

export async function selectScene(sceneId) {
    const sceneGeneration = state.sceneGeneration + 1;
    updateState({ sceneGeneration });
    stopAllSounds(false);
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

    // パッドは即座に描画する。デコード済みでない音源は初回クリック時に遅延デコードされる。
    updateState({ shortcuts: state.scenes[sceneId]?.shortcuts ?? {} });

    const sceneColor = state.scenes[sceneId]?.color;
    const iconStyle = sceneColor ? ` style="color: ${sceneColor};"` : '';
    const h1 = document.querySelector('header h1');
    if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"${iconStyle}></i> ${escapeHtml(state.scenes[sceneId]?.name || 'シーンなし')}`;

    renderers.renderSoundboard();

    if (dom.sceneSettingsModal?.classList.contains('active')) {
        populateSceneModalList();
    }
    await saveSetting('currentSceneId', sceneId);

    if (state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY) {
        // 事前デコードは描画を待たせず後ろで進める。シーンが切り替わったら世代チェックで停止する。
        void warmUpSceneDecodes(sceneId, sceneGeneration);
    }
}

// シーンの全音源を制限付き並列で事前デコードする。
// キャッシュ済みの音源はスキップされるため、再訪時は実質即終了する。
function warmUpSceneDecodes(sceneId, sceneGeneration) {
    const scene = state.scenes[sceneId];
    const tasks = (scene?.sounds || []).map(sound => sound.type === 'roll'
        ? () => preloadRollParts(sound, sceneGeneration)
        : (sound.audioId && !state.decodedAudioBuffers[sound.id]
            ? async () => {
                const audioBuffer = await getAudioBufferForSound(sound.id, sound.audioId, sceneGeneration);
                if (audioBuffer) {
                    delete sound.error;
                } else {
                    sound.error = 'Audio decode failed';
                }
            }
            : null)).filter(Boolean);
    let nextTask = 0;
    return Promise.all(Array.from({ length: Math.min(AUDIO_DECODE_CONCURRENCY, tasks.length) }, async () => {
        while (nextTask < tasks.length && sceneGeneration === state.sceneGeneration) {
            await tasks[nextTask++]();
        }
    }));
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

// 音声blobの長さ（秒）を取得する
function readAudioDuration(blob) {
    return new Promise((resolve, reject) => {
        const audio = new Audio(URL.createObjectURL(blob));
        audio.addEventListener('loadedmetadata', () => {
            URL.revokeObjectURL(audio.src);
            resolve(audio.duration);
        });
        audio.addEventListener('error', (e) => {
            URL.revokeObjectURL(audio.src);
            reject(e);
        });
    });
}

/**
 * ドラムロールのスキーマ正規化。単一ループ (rollParts.loop) の旧形式を
 * 複数ループ (rollParts.loops 配列) の新形式へ寄せる。変更があったら true を返す。
 */
export function normalizeRollSound(sound) {
    if (!sound || sound.type !== 'roll') return false;
    let changed = false;
    if (!sound.rollParts || typeof sound.rollParts !== 'object') {
        sound.rollParts = {};
        changed = true;
    }
    if (!Array.isArray(sound.rollParts.loops)) {
        sound.rollParts.loops = sound.rollParts.loop ? [sound.rollParts.loop] : [];
        delete sound.rollParts.loop;
        changed = true;
    }
    if (sound.rollParts.loops.some(audioId => !audioId)) {
        sound.rollParts.loops = sound.rollParts.loops.filter(Boolean);
        changed = true;
    }
    if (sound.rollPartNames && !Array.isArray(sound.rollPartNames.loops)) {
        sound.rollPartNames.loops = sound.rollPartNames.loop ? [sound.rollPartNames.loop] : [];
        delete sound.rollPartNames.loop;
        changed = true;
    }
    if (sound.rollPartDurations && !Array.isArray(sound.rollPartDurations.loops)) {
        sound.rollPartDurations.loops = sound.rollPartDurations.loop ? [sound.rollPartDurations.loop] : [];
        delete sound.rollPartDurations.loop;
        changed = true;
    }
    return changed;
}

/**
 * ドラムロールセットの新規作成・更新。
 * soundId が null なら追加、既存IDなら更新する。
 * settings は showRollSettingsModal の結果:
 * { name, color, parts: { intro, loops: [...], end, finish } }（各スロットは { audioId, file, name }）
 */
export async function saveRollSound(soundId, settings) {
    const scene = state.scenes[state.currentSceneId];
    if (!scene) {
        showAlert("ファイルを追加するシーンが選択されていません。");
        return null;
    }
    const existingSound = soundId ? scene.sounds.find(s => s.id === soundId) : null;
    if (soundId && !existingSound) return null;

    const createdAudioIds = new Set();
    // パートスロットを保存済み音声参照に解決する（新規FileはDBへ保存し、長さも測る）
    const resolveSlot = async (slot) => {
        if (!slot) return null;
        if (slot.file) {
            const audioId = generateUniqueId('aud');
            await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: slot.file });
            createdAudioIds.add(audioId);
            let duration = 0;
            try {
                duration = await readAudioDuration(slot.file);
            } catch (e) { /* 長さ取得失敗時は 0 として扱う */ }
            return { audioId, name: slot.name || slot.file.name.replace(/\.[^/.]+$/, ""), duration };
        }
        if (slot.audioId) {
            let duration = 0;
            try {
                const audioRecord = await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'get', slot.audioId);
                const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
                if (blob) duration = await readAudioDuration(blob);
            } catch (e) { /* 長さ取得失敗時は 0 として扱う */ }
            return { audioId: slot.audioId, name: slot.name || '', duration };
        }
        return null;
    };

    const discardCreatedAudio = () => Promise.all([...createdAudioIds].map(audioId =>
        dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', audioId).catch(() => {})
    ));
    let intro;
    let end;
    let finish;
    const loops = [];
    try {
        intro = await resolveSlot(settings.parts?.intro);
        end = await resolveSlot(settings.parts?.end);
        finish = await resolveSlot(settings.parts?.finish);
        for (const slot of (settings.parts?.loops || [])) {
            const resolved = await resolveSlot(slot);
            if (resolved) loops.push(resolved);
        }
    } catch (error) {
        await discardCreatedAudio();
        throw error;
    }
    if (!loops.length) {
        await discardCreatedAudio();
        showAlert("ループ音声を1つ以上指定してください。", 'エラー');
        return null;
    }

    const rollParts = {
        intro: intro?.audioId ?? null,
        loops: loops.map(part => part.audioId),
        end: end?.audioId ?? null,
        finish: finish?.audioId ?? null
    };
    const rollPartNames = {
        intro: intro?.name ?? null,
        loops: loops.map(part => part.name),
        end: end?.name ?? null,
        finish: finish?.name ?? null
    };
    const rollPartDurations = {
        intro: intro?.duration ?? 0,
        loops: loops.map(part => part.duration ?? 0),
        end: end?.duration ?? 0,
        finish: finish?.duration ?? 0
    };

    // 差し替え・解除・削除されたパートの旧音声を削除する
    const oldParts = existingSound?.rollParts || {};
    const oldSingleIds = [oldParts.intro, oldParts.end, oldParts.finish].filter(Boolean);
    const oldLoopIds = (oldParts.loops || []).filter(Boolean);
    const newSingleIds = [rollParts.intro, rollParts.end, rollParts.finish].filter(Boolean);
    const newLoopIds = rollParts.loops;
    const staleAudioIds = [
        ...oldSingleIds.filter(id => !newSingleIds.includes(id)),
        ...oldLoopIds.filter(id => !newLoopIds.includes(id))
    ];
    for (const staleAudioId of staleAudioIds) {
        try {
            await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', staleAudioId);
        } catch (err) {
            console.error(`Failed to delete replaced roll part audio: ${staleAudioId}`, err);
        }
    }
    // ループは index 付きのキャッシュキーのため、旧・新の両方の範囲を掃除する
    if (existingSound) {
        for (const part of ['intro', 'end', 'finish']) {
            delete state.decodedAudioBuffers[rollPartCacheKey(existingSound.id, part)];
        }
        const maxLoopCount = Math.max(oldLoopIds.length, newLoopIds.length);
        for (let index = 0; index < maxLoopCount; index++) {
            delete state.decodedAudioBuffers[rollPartCacheKey(existingSound.id, `loop:${index}`)];
        }
    }

    const duration = rollPartDurations.intro
        + rollPartDurations.loops.reduce((sum, value) => sum + value, 0)
        + rollPartDurations.end
        + rollPartDurations.finish;

    if (existingSound) {
        existingSound.name = settings.name;
        existingSound.rollParts = rollParts;
        existingSound.rollPartNames = rollPartNames;
        existingSound.rollPartDurations = rollPartDurations;
        existingSound.duration = duration;
        if (settings.color === null) {
            delete existingSound.color;
        } else if (typeof settings.color === 'string') {
            existingSound.color = settings.color;
        }
        await saveCurrentSceneSounds(`saveRollSound-${existingSound.id}`);
        renderers.renderSoundboard();
        return existingSound;
    }

    const newSound = {
        id: generateUniqueId('snd'),
        type: 'roll',
        name: settings.name,
        triggerMode: 'roll',
        rollParts: rollParts,
        rollPartNames: rollPartNames,
        rollPartDurations: rollPartDurations,
        loop: false,
        volume: 1.0,
        pan: 0,
        color: typeof settings.color === 'string' ? settings.color : undefined,
        fadeInDuration: 0.0,
        fadeOutDuration: 0.0,
        fadeInEasing: DEFAULT_FADE_EASING,
        fadeOutEasing: DEFAULT_FADE_EASING,
        reverse: false,
        playbackRate: 1.0,
        preservePitch: false,
        effects: { enabled: false },
        duration: duration,
    };
    scene.sounds.push(newSound);
    await saveCurrentSceneSounds("saveRollSound");
    renderers.renderSoundboard();
    return newSound;
}

export async function addAudioBlobToScene(blob, name, sceneId = state.currentSceneId) {
    const scene = state.scenes[sceneId];
    if (!scene) throw new Error('録音を保存するシーンが見つかりません。');
    const deletionGeneration = sceneDeletionGenerations.get(sceneId) || 0;
    const assertSceneAvailable = () => {
        if (!state.scenes[sceneId] || (sceneDeletionGenerations.get(sceneId) || 0) !== deletionGeneration) {
            throw new Error('録音を保存するシーンが削除されました。');
        }
    };
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('録音データが空です。');
    if (blob.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        throw new Error(`録音データが${MAX_FILE_SIZE_MB}MBを超えています。`);
    }

    let audioBuffer;
    try {
        audioBuffer = await state.audioContext.decodeAudioData(await blob.arrayBuffer());
    } catch (error) {
        throw new Error('録音データを音声として読み込めませんでした。');
    }
    assertSceneAvailable();

    const audioId = generateUniqueId('aud');
    const newSound = {
        id: generateUniqueId('snd'),
        name,
        loop: false,
        volume: 1.0,
        pan: 0,
        audioId,
        triggerMode: DEFAULT_TRIGGER_MODE,
        fadeInDuration: 0.0,
        fadeOutDuration: 0.0,
        fadeInEasing: DEFAULT_FADE_EASING,
        fadeOutEasing: DEFAULT_FADE_EASING,
        reverse: false,
        playbackRate: 1.0,
        preservePitch: false,
        effects: { enabled: false },
        duration: audioBuffer.duration
    };

    let audioStored = false;
    let soundAdded = false;
    let targetScene = null;
    const removeAddedSound = sceneToRollback => {
        if (!sceneToRollback) return;
        const soundIndex = sceneToRollback.sounds.findIndex(sound => sound.id === newSound.id);
        if (soundIndex !== -1) sceneToRollback.sounds.splice(soundIndex, 1);
    };
    try {
        assertSceneAvailable();
        await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob });
        audioStored = true;
        assertSceneAvailable();
        targetScene = state.scenes[sceneId];
        targetScene.sounds.push(newSound);
        soundAdded = true;
        assertSceneAvailable();
        await saveCurrentSceneSounds('addAudioBlobToScene', sceneId);
        assertSceneAvailable();
    } catch (error) {
        if (soundAdded) {
            removeAddedSound(targetScene);
            const currentScene = state.scenes[sceneId];
            if (currentScene !== targetScene) removeAddedSound(currentScene);
            if (currentScene) {
                await saveCurrentSceneSounds('addAudioBlobToScene-rollback', sceneId);
            } else {
                await dbRequest(SCENES_STORE_NAME, 'readwrite', 'delete', sceneId);
            }
        }
        if (audioStored) {
            await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', audioId).catch(() => {});
        }
        throw error;
    }

    if (sceneId === state.currentSceneId) {
        if (state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY) {
            cacheDecodedBuffer(newSound.id, audioBuffer);
        }
        renderers.renderSoundboard();
    }
    return newSound;
}

export async function removeSound(soundId) {
    let cacheChanged = false;
    for (const cache of [state.decodedAudioBuffers, state.reversedAudioBuffers]) {
        for (const key of Object.keys(cache)) {
            if (key === soundId || key.startsWith(`${soundId}:`)) {
                delete cache[key];
                cacheChanged = true;
            }
        }
    }
    if (state.waveformPeaksCache[soundId]) {
        delete state.waveformPeaksCache[soundId];
        cacheChanged = true;
    }
    if (cacheChanged) triggerWaveformUpdate();
    if (!state.currentSceneId) return;

    const scene = state.scenes[state.currentSceneId];
    const soundIndex = scene.sounds.findIndex(s => s.id === soundId);
    if (soundIndex === -1) return;

    const [removedSound] = scene.sounds.splice(soundIndex, 1);

    // 削除したサウンドに割り当てられていた、このシーン内のキーを解放する。
    for (const [shortcut, assignedSoundId] of Object.entries(state.shortcuts)) {
        if (assignedSoundId === soundId) delete state.shortcuts[shortcut];
    }
    
    await saveCurrentSceneSounds(`removeSound-${soundId}`);
    renderers.renderSoundboard();

    if (removedSound.type === 'roll') {
        // ロールはパートごとに音声を持つため全て削除する
        const loopCount = (removedSound.rollParts?.loops || []).length;
        for (let index = 0; index < loopCount; index++) {
            delete state.decodedAudioBuffers[rollPartCacheKey(soundId, `loop:${index}`)];
        }
        const partAudioIds = [
            removedSound.rollParts?.intro,
            ...(removedSound.rollParts?.loops || []),
            removedSound.rollParts?.end,
            removedSound.rollParts?.finish
        ].filter(Boolean);
        for (const partAudioId of partAudioIds) {
            try {
                await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', partAudioId);
            } catch (err) {
                showAlert("音声ファイルの削除に失敗しました。");
            }
        }
        return;
    }

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

    // シャローコピーで一時フィールドを除いて保存する。
    // IndexedDB の put は structured clone で保存時点のスナップショットを取るため共有参照で安全。
    const TRANSIENT_SOUND_FIELDS = ['dataUrl', 'error', 'rollPartDataUrls'];
    const sceneToSave = {
        ...scene,
        sounds: scene.sounds.map(sound => {
            const copy = { ...sound };
            for (const field of TRANSIENT_SOUND_FIELDS) delete copy[field];
            return copy;
        })
    };

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

    // dataUrl (base64) を介さず IndexedDB の blob を直接 ZIP に書き込む。
    // sceneMeta は dataUrl を含まないメタデータのみのディープコピー (音質設定等の小さなデータ)。
    const scene = state.scenes[sceneId];
    if (!scene) {
        showAlert("エクスポート対象のシーンが見つかりません。");
        return;
    }

    const zip = new JSZip();

    const sceneMeta = JSON.parse(JSON.stringify(scene));
    const audioFiles = [];

    const loadAudioBlob = async (audioId) => {
        if (!audioId) return null;
        const audioRecord = await dbRequest(AUDIO_FILES_STORE_NAME, 'readonly', 'get', audioId);
        return audioRecord instanceof Blob ? audioRecord : audioRecord?.blob || null;
    };

    for (const sound of sceneMeta.sounds) {
        // ドラムロールのパート音声も個別ファイルとして書き出す
        if (sound.type === 'roll' && sound.rollParts) {
            sound.rollPartFiles = {};
            const writePartFile = async (partLabel, partAudioId) => {
                const blob = await loadAudioBlob(partAudioId);
                if (!blob) return null;
                const fileExtension = blob.type.split('/')[1] || 'mp3';
                const fileName = `audio/${sound.id}-${partLabel}.${fileExtension}`;
                audioFiles.push({ fileName, blob });
                return fileName;
            };
            sound.rollPartFiles.intro = await writePartFile('intro', sound.rollParts.intro);
            sound.rollPartFiles.loops = [];
            for (let loopIndex = 0; loopIndex < (sound.rollParts.loops || []).length; loopIndex++) {
                const fileName = await writePartFile(`loop${loopIndex}`, sound.rollParts.loops[loopIndex]);
                if (fileName) sound.rollPartFiles.loops.push(fileName);
            }
            sound.rollPartFiles.end = await writePartFile('end', sound.rollParts.end);
            sound.rollPartFiles.finish = await writePartFile('finish', sound.rollParts.finish);
            delete sound.rollParts;
            continue;
        }
        if (sound.audioId) {
            const blob = await loadAudioBlob(sound.audioId);
            if (blob) {
                const fileExtension = blob.type.split('/')[1] || 'mp3';
                const fileName = `audio/${sound.id}.${fileExtension}`;
                sound.fileName = fileName;
                audioFiles.push({ fileName, blob });
                delete sound.audioId;
            }
        }
    }

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
            if (sound.type === 'roll') sound.triggerMode = 'roll';
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
            // ドラムロールのパート音声を復元する
            if (sound.type === 'roll' && sound.rollPartFiles) {
                const restorePart = async (partFileName) => {
                    if (!partFileName) return null;
                    const audioFileInZip = zip.file(partFileName);
                    if (!audioFileInZip) return null;
                    const arrayBuffer = await audioFileInZip.async("arraybuffer");
                    const fileExtension = partFileName.split('.').pop().toLowerCase();
                    const mimeType = `audio/${fileExtension === 'mp3' ? 'mpeg' : fileExtension}`;
                    const blob = new Blob([arrayBuffer], { type: mimeType });
                    const audioId = generateUniqueId('aud');
                    await dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'put', { id: audioId, blob: blob });
                    return audioId;
                };
                sound.rollParts = {
                    intro: await restorePart(sound.rollPartFiles.intro),
                    loops: [],
                    end: await restorePart(sound.rollPartFiles.end),
                    finish: await restorePart(sound.rollPartFiles.finish)
                };
                for (const loopFileName of sound.rollPartFiles.loops || []) {
                    const loopAudioId = await restorePart(loopFileName);
                    if (loopAudioId) sound.rollParts.loops.push(loopAudioId);
                }
                delete sound.rollPartFiles;
            }
            normalizeRollSound(sound);
        }

        importedScene.shortcuts = normalizeSceneShortcuts(importedScene.shortcuts, importedScene.sounds);
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
                if (sound.type === 'roll') sound.triggerMode = 'roll';
                normalizeRollSound(sound);
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
            
            importedScene.shortcuts = normalizeSceneShortcuts(importedScene.shortcuts, importedScene.sounds);
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

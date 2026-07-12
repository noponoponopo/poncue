// modules/08_handlers.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { dbRequest } from './04_db.js';
import { showConfirm, showAlert, showPrompt, showSoundSettingsModal, hideModal, toggleDarkMode, updateDraggableState, clearDragStyles, clearDragOverStyles, createGhostElement, removeGhostElement, createMasterMeterElement, createMasterEffectKnobs, createMasterLimiterKnob, escapeHtml, setupCanvasResize } from './05_ui.js';
import { initAudioContext, resumeAudioContext, playSound, stopSound, stopAllSounds, forceStopSound, triggerWaveformUpdate, seekSound, updateActiveSoundEffects, updateActiveSoundPan, updateActiveSoundSpeed, normalizeSoundVolume, startMasterMeter, setMasterParam, setMasterLimiterThreshold } from './06_audio.js';
import {
    selectScene, saveSetting, saveCurrentSceneSounds, handleAudioFileSelect,
    removeSound, handleImportFileSelect, populateSceneModalList, generateUniqueId,
    renderers, // renderers object
    exportSceneAsZip, // New export function
    updatePadSizeCSS // Import updatePadSizeCSS
} from './07_scenes.js';
import { LONG_PRESS_DURATION, PERFORMANCE_MODE, DEFAULT_PERFORMANCE_MODE, TRIGGER_MODES } from './01_config.js';

// --- Debounce Utility ---
function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// Debounced version of saveCurrentSceneSounds
const debouncedSaveCurrentSceneSounds = debounce(saveCurrentSceneSounds, 300);
let resizeFrameId = null;

// Move master volume between header and master-effect-bar based on available width
function relocateMasterVolume() {
    const volumeControl = document.getElementById('master-volume-control');
    if (!volumeControl) return;
    const effectBar = dom.masterEffectBar;
    const headerControls = document.querySelector('header .controls');
    if (!effectBar || !headerControls) return;

    const wantInBar = window.innerWidth >= 900;
    const inBar = volumeControl.parentElement === effectBar;

    if (wantInBar && !inBar) {
        effectBar.appendChild(volumeControl);
    } else if (!wantInBar && inBar) {
        headerControls.insertBefore(volumeControl, headerControls.querySelector('#scene-settings-btn'));
    }
}

// --- Event Listener Setup ---
export function setupEventListeners() {
    createMasterMeterElement();
    createMasterLimiterKnob(state.masterLimiter.threshold, (value, save) => {
        setMasterLimiterThreshold(value);
        if (save) saveSetting('masterLimiter', state.masterLimiter);
    });
    createMasterEffectKnobs({ eq: state.masterEq, comp: state.masterComp, delay: state.masterDelay, pan: state.masterPan, distortion: state.masterDistortion, reverb: state.masterReverb }, (key, value) => {
        setMasterParam(key, value);
        const [group] = key.split('.');
        const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
        saveSetting(stateKey, state[stateKey]);
    });
    startMasterMeter();
    relocateMasterVolume();

    // Custom Modal — only close on genuine click, not drag-end on overlay
    let modalMouseDownPos = null;
    dom.customModalOverlay?.addEventListener('mousedown', (e) => {
        modalMouseDownPos = { x: e.clientX, y: e.clientY };
    });
    dom.customModalOkBtn?.addEventListener('click', handleModalOk);
    dom.customModalCancelBtn?.addEventListener('click', handleModalCancel);
    dom.customModalOverlay?.addEventListener('click', (e) => {
        const clickTarget = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
        if (clickTarget !== dom.customModalOverlay) return;
        if (modalMouseDownPos) {
            const dx = Math.abs(e.clientX - modalMouseDownPos.x);
            const dy = Math.abs(e.clientY - modalMouseDownPos.y);
            if (dx > 3 || dy > 3) return;
        }
        if (state.confirmResolve) state.confirmResolve(false);
        hideModal();
    });

    // Audio resume
    document.body.addEventListener('click', resumeAudioContext, { capture: true, once: true });
    document.body.addEventListener('touchend', resumeAudioContext, { capture: true, once: true });

    // Header & Main Controls
    dom.addSoundBtn?.addEventListener('click', () => { resumeAudioContext(); dom.fileInput.click(); });
    dom.stopAllBtn?.addEventListener('click', () => stopAllSounds(true));
    dom.fileInput?.addEventListener('change', handleAudioFileSelect);
    dom.masterVolumeSlider?.addEventListener('input', handleMasterVolumeChange);
    dom.masterVolumeSlider?.addEventListener('change', () => saveSetting('masterVolume', state.masterVolume));
    dom.masterVolumeSlider?.addEventListener('dblclick', () => {
        dom.masterVolumeSlider.value = 1;
        handleMasterVolumeChange();
        saveSetting('masterVolume', state.masterVolume);
    });
    
    // Scene Settings Modal
    dom.sceneSettingsBtn?.addEventListener('click', openSceneSettingsModal);
    dom.modalCloseBtn?.addEventListener('click', closeSceneSettingsModal);
    {
        let sceneMouseDownPos = null;
        dom.sceneSettingsModal?.addEventListener('mousedown', (e) => {
            sceneMouseDownPos = { x: e.clientX, y: e.clientY };
        });
        dom.sceneSettingsModal?.addEventListener('click', (e) => {
            const clickTarget = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
            if (clickTarget !== dom.sceneSettingsModal) return;
            if (sceneMouseDownPos) {
                const dx = Math.abs(e.clientX - sceneMouseDownPos.x);
                const dy = Math.abs(e.clientY - sceneMouseDownPos.y);
                if (dx > 3 || dy > 3) return;
            }
            closeSceneSettingsModal();
        });
    }
    dom.modalAddSceneBtn?.addEventListener('click', handleModalAddScene);
    dom.modalImportBtn?.addEventListener('click', () => { dom.importFileInput.click(); });
    dom.importFileInput?.addEventListener('change', handleImportFileSelect);
    // dom.modalExportBtn is now hidden, so no listener needed.
    dom.modalSceneList?.addEventListener('click', handleModalSceneListClick);
    
    // App Settings Toggles
    dom.darkModeToggle?.addEventListener('change', toggleDarkMode);
    dom.perfHighRadio?.addEventListener('change', handlePerformanceModeChange);
    dom.perfLowRadio?.addEventListener('change', handlePerformanceModeChange);
    dom.interactionClickRadio?.addEventListener('change', handleInteractionModeChange);
    dom.interactionDragRadio?.addEventListener('change', handleInteractionModeChange);
    dom.waveformToggleCheckbox?.addEventListener('change', handleWaveformToggleChange);
    dom.padSizeSlider?.addEventListener('input', handlePadSizeChange);
    dom.padSizeSlider?.addEventListener('change', () => saveSetting('padSize', state.padSize));

    // Soundboard Drag & Drop
    dom.soundboard.addEventListener('dragstart', handleDragStart);
    dom.soundboard.addEventListener('dragover', handleDragOver);
    dom.soundboard.addEventListener('dragleave', handleDragLeave);
    dom.soundboard.addEventListener('drop', handleDrop);
    dom.soundboard.addEventListener('dragend', handleDragEnd);
    dom.soundboard.addEventListener('touchstart', handleTouchStart, { passive: false });
    dom.soundboard.addEventListener('touchmove', handleTouchMove, { passive: false });
    dom.soundboard.addEventListener('touchend', handleTouchEnd);
    dom.soundboard.addEventListener('touchcancel', handleTouchCancel);
    
    window.addEventListener('resize', () => {
        if (resizeFrameId !== null) return;
        resizeFrameId = requestAnimationFrame(() => {
            resizeFrameId = null;
            setupCanvasResize();
            triggerWaveformUpdate();
            relocateMasterVolume();
        });
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    // Show Mode (fullscreen)
    dom.showModeBtn?.addEventListener('click', toggleShowMode);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}


// --- Show Mode (Fullscreen) ---
function toggleShowMode() {
    if (!state.showMode) {
        try {
            const el = document.documentElement;
            if (el.requestFullscreen) el.requestFullscreen();
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        } catch (e) { /* fullscreen request may fail silently */ }
        document.body.classList.add('show-mode');
        updateState({ showMode: true });
    } else {
        try {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (e) { /* exit fullscreen may fail silently */ }
        document.body.classList.remove('show-mode');
        updateState({ showMode: false });
    }
}

function handleFullscreenChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        document.body.classList.remove('show-mode');
        updateState({ showMode: false });
    }
}


// --- Custom Modal Handlers ---
function handleModalOk() {
    if (state.confirmResolve) state.confirmResolve(true);
    hideModal();
}
function handleModalCancel() {
    if (state.confirmResolve) state.confirmResolve(false);
    hideModal();
}

// --- Header & Main Control Handlers ---
function handleMasterVolumeChange() {
    updateState({ masterVolume: parseFloat(dom.masterVolumeSlider.value) });
    if (dom.masterVolumeValue) {
        dom.masterVolumeValue.textContent = `${Math.round(state.masterVolume * 100)}%`;
    }
    if (state.masterGainNode) {
        state.masterGainNode.gain.setTargetAtTime(state.masterVolume, state.audioContext.currentTime, 0.01);
    }
}

// --- App Settings Handlers ---
function handleInteractionModeChange(event) {
    const isDragMode = event.target.value === 'drag';
    updateState({ isSortableEnabled: isDragMode });
    saveSetting('isSortableEnabled', state.isSortableEnabled);
    updateDraggableState();
}

function handleWaveformToggleChange(event) {
    updateState({ showWaveform: event.target.checked });
    saveSetting('showWaveform', state.showWaveform);
    triggerWaveformUpdate(); // Update waveform display immediately
}

function handlePadSizeChange(event) {
    const newSize = parseInt(event.target.value, 10);
    updateState({ padSize: newSize });
    dom.padSizeValue.textContent = newSize;
    updatePadSizeCSS(newSize);
}

function handlePerformanceModeChange(event) {
    const newMode = event.target.value;
    updateState({ performanceMode: newMode });
    saveSetting('performanceMode', newMode);
    let message = '';
    if (newMode === PERFORMANCE_MODE.HIGH_PERFORMANCE) {
        message = '高パフォーマンスモードに設定しました。';
    } else { // LOW_MEMORY
        message = '低メモリモードに設定しました。';
    }
    showAlert(message, 'パフォーマンスモード変更');
    // ここでモードに応じた追加の処理を呼び出す
    // 例: オーディオバッファの再読み込み、波形表示の精度変更など
}

// --- Scene Modal Handlers ---
function openSceneSettingsModal() {
    if (!state.db) { showAlert("データベースに接続されていません。"); return; }
    populateSceneModalList();
    dom.sceneSettingsModal.classList.add('active');
}
function closeSceneSettingsModal() {
    dom.sceneSettingsModal.classList.remove('active');
}
async function handleModalAddScene() {
    const sceneName = await showPrompt(`新しいシーンの名前:`, `新しいシーン`, `Scene ${Object.keys(state.scenes).length + 1}`);
    if (sceneName?.trim()) {
        const newSceneId = generateUniqueId('scn');
        const newSceneData = { id: newSceneId, name: sceneName.trim(), color: null, sounds: [] };
        state.scenes[newSceneId] = newSceneData;
        await dbRequest('scenes', 'readwrite', 'put', newSceneData);
        populateSceneModalList();
        await selectScene(newSceneId);
        closeSceneSettingsModal();
    }
}
async function handleModalRenameScene(sceneId) {
    const scene = state.scenes[sceneId];
    if (!scene) return;
    const newName = await showPrompt(`「${scene.name}」の新しい名前:`, `シーン名変更`, scene.name);
    if (newName && newName.trim() !== scene.name) {
        scene.name = newName.trim();
        if (sceneId === state.currentSceneId) {
            const sceneColor = scene.color;
            const iconStyle = sceneColor ? ` style="color: ${sceneColor};"` : '';
            const h1 = document.querySelector('header h1');
            if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"${iconStyle}></i> ${escapeHtml(scene.name)}`;
        }
        populateSceneModalList();
        debouncedSaveCurrentSceneSounds("modalRename");
    }
}
async function handleModalDeleteScene(sceneId) {
    if (Object.keys(state.scenes).length <= 1) { showAlert("最後のシーンは削除できません。"); return; }
    const sceneName = state.scenes[sceneId].name;
    const confirmed = await showConfirm(`シーン「${sceneName}」を削除しますか？この操作は取り消せません。`, 'シーンの削除');
    if (confirmed) {
        const sceneToDelete = state.scenes[sceneId];
        for (const sound of sceneToDelete.sounds) {
            if (sound.audioId) {
                try {
                    await dbRequest('audio_files', 'readwrite', 'delete', sound.audioId);
                } catch (err) {
                    // Error deleting audio blob
                }
            }
        }

        delete state.scenes[sceneId];
        await dbRequest('scenes', 'readwrite', 'delete', sceneId);
        
        populateSceneModalList();
        
        if (sceneId === state.currentSceneId) {
            const nextSceneId = Object.keys(state.scenes)[0] || null;
            await selectScene(nextSceneId);
        }
    }
}

function handleModalSceneListClick(event) {
    const listItem = event.target.closest('li[data-scene-id]');
    if (!listItem) return;
    const sceneId = listItem.dataset.sceneId;
    const actionButton = event.target.closest('button[data-action]');
    if (actionButton) {
        event.stopPropagation();
        const action = actionButton.dataset.action;
        if (action === 'rename') handleModalRenameScene(sceneId);
        else if (action === 'color') handleSceneColorChange(sceneId);
        else if (action === 'delete') handleModalDeleteScene(sceneId);
        else if (action === 'export') exportSceneAsZip(sceneId);
    } else {
        if (sceneId !== state.currentSceneId) selectScene(sceneId);
        closeSceneSettingsModal();
    }
}

async function handleSceneColorChange(sceneId) {
    const scene = state.scenes[sceneId];
    if (!scene) return;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = scene.color || '#808080';
    input.style.position = 'absolute';
    input.style.opacity = '0';
    input.style.width = '0';
    input.style.height = '0';
    document.body.appendChild(input);
    const cleanup = () => { input.remove(); };
    input.addEventListener('change', async () => {
        const newColor = input.value;
        scene.color = newColor;
        cleanup();
        await saveCurrentSceneSounds(`sceneColor-${sceneId}`);
        populateSceneModalList();
        if (sceneId === state.currentSceneId) {
            const h1 = document.querySelector('header h1');
            if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt" style="color: ${newColor};"></i> ${scene.name}`;
        }
    });
    input.addEventListener('blur', cleanup, { once: true });
    input.click();
}

async function handleSoundSettings(soundId) {
    const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!sound) return;

    let currentShortcut = '';
    for (const key in state.shortcuts) {
        if (state.shortcuts[key] === soundId) {
            currentShortcut = key;
            break;
        }
    }

    const newSettings = await showSoundSettingsModal(soundId, currentShortcut, {
        onNormalize: async (targetLufs) => {
            const result = await normalizeSoundVolume(soundId, targetLufs);
            if (result) {
                debouncedSaveCurrentSceneSounds(`normalize-${soundId}`);
                renderers.renderSoundboard();
            }
            return result;
        }
    });

    if (newSettings !== null) { // User clicked Save or cleared
        const { newShortcut, newTriggerMode, newColor, newFadeInDuration, newFadeOutDuration, newFadeInEasing, newFadeOutEasing, newPan, newReverse, newPlaybackSpeed, preservePitch, newEffects } = newSettings;

        // Update shortcut
        if (currentShortcut && state.shortcuts[currentShortcut] === soundId) {
            delete state.shortcuts[currentShortcut];
        }

        if (newShortcut) {
            if (state.shortcuts[newShortcut] && state.shortcuts[newShortcut] !== soundId) {
                showAlert(`ショートカット「${newShortcut}」は既に別のサウンドに割り当てられています。`, 'エラー');
                if (currentShortcut) {
                    state.shortcuts[currentShortcut] = soundId;
                }
                return;
            }
            state.shortcuts[newShortcut] = soundId;
        }
        await saveSetting('shortcuts', state.shortcuts);

        if (TRIGGER_MODES.includes(newTriggerMode)) {
            sound.triggerMode = newTriggerMode;
        }
        delete sound.holdToPlay;

        // Update pad color
        if (newColor === null) {
            delete sound.color;
        } else if (typeof newColor === 'string') {
            sound.color = newColor;
        }
        // Update fade (in/out split + easing)
        sound.fadeInDuration = newFadeInDuration;
        sound.fadeOutDuration = newFadeOutDuration;
        sound.fadeInEasing = newFadeInEasing;
        sound.fadeOutEasing = newFadeOutEasing;
        if ('fadeDuration' in sound) delete sound.fadeDuration;
        // 逆再生設定。変更時に反転バッファキャッシュを破棄（次回再生で再生成）
        if (sound.reverse !== newReverse) {
            sound.reverse = newReverse;
            if (state.reversedAudioBuffers) delete state.reversedAudioBuffers[soundId];
        }
        if (Number.isFinite(newPlaybackSpeed)) {
            sound.playbackRate = Math.max(0.25, Math.min(4, newPlaybackSpeed));
        }
        sound.preservePitch = preservePitch;
        updateActiveSoundSpeed(soundId);
        sound.effects = newEffects;
        if (Number.isFinite(newPan)) {
            sound.pan = newPan;
            updateActiveSoundPan(soundId);
        }
        updateActiveSoundEffects(soundId);
        debouncedSaveCurrentSceneSounds(`soundSettingsChange-${soundId}`);

        showAlert(`サウンド「${sound.name}」の設定を更新しました。`, '通知');
        renderers.renderSoundboard();
    }
}

function normalizeKey(e) {
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('Control');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.metaKey) modifiers.push('Meta');

    let key = e.key;
    if (key === ' ') key = 'Space';
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) key = key.replace('Arrow', '');
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) key = '';
    if (key.length === 1 && key.match(/[a-z]/i)) key = key.toUpperCase();

    return [...modifiers, key].filter(Boolean).join('+');
}

async function handleKeyDown(event) {
    if (dom.customModalOverlay.classList.contains('active') ||
        dom.sceneSettingsModal.classList.contains('active') ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        stopAllSounds(true);
        return;
    }

    const normalizedKey = normalizeKey(event);
    const soundId = state.shortcuts[normalizedKey];

    if (soundId) {
        event.preventDefault();
        const soundButtonElement = dom.soundboard.querySelector(`.sound-button[data-id="${soundId}"]`);
        if (!soundButtonElement) return;
        const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
        const triggerMode = TRIGGER_MODES.includes(sound?.triggerMode) ? sound.triggerMode : 'toggle';
        if (triggerMode === 'momentary') {
            if (!event.repeat) startHoldPlayback(soundId, soundButtonElement, `key:${normalizedKey}`);
        } else if (!event.repeat) {
            if (triggerMode === 'retrigger') startRetriggerPlayback(soundId, soundButtonElement);
            else handleSoundButtonClick(soundId, soundButtonElement);
        }
    }
}

function handleKeyUp(event) {
    if (dom.customModalOverlay.classList.contains('active') ||
        dom.sceneSettingsModal.classList.contains('active') ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
        return;
    }

    const normalizedKey = normalizeKey(event);
    const soundId = state.shortcuts[normalizedKey];

    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    if (sound?.triggerMode !== 'momentary') return;
    event.preventDefault();
    endHoldPlayback(soundId, `key:${normalizedKey}`);
}

// --- Sound Button and Board Handlers ---

// Tracks sounds already toggled by pointerdown/touchend so the trailing
// click event doesn't fire a second toggle. Module-level to survive
// button re-renders; entries are consumed (deleted) by the click handler.
const _toggleHandled = new Set();
const _holdInputs = new Map();
const _longPressHandled = new Set();

async function startHoldPlayback(soundId, soundButtonElement, inputId) {
    let inputs = _holdInputs.get(soundId);
    if (!inputs) {
        inputs = new Set();
        _holdInputs.set(soundId, inputs);
    }
    if (inputs.has(inputId)) return;
    inputs.add(inputId);

    if (!state.activeAudios[soundId]) {
        await handleSoundButtonClick(soundId, soundButtonElement);
    }
    if (!_holdInputs.get(soundId)?.size && state.activeAudios[soundId]) {
        stopSound(soundId, soundButtonElement);
    }
}

function endHoldPlayback(soundId, inputId, soundButtonElement = null) {
    const inputs = _holdInputs.get(soundId);
    if (!inputs) return;
    inputs.delete(inputId);
    if (inputs.size) return;
    _holdInputs.delete(soundId);
    if (state.activeAudios[soundId]) stopSound(soundId, soundButtonElement);
}

async function handleSoundButtonClick(soundId, soundButtonElement) {
    const clickTime = performance.now(); // Capture timestamp at click
    if (!state.audioContext) { if (!initAudioContext()) { showAlert("オーディオ機能の初期化に失敗。", "エラー"); return; } }
    await resumeAudioContext();
    if (state.audioContext.state !== 'running') { showAlert("オーディオの準備ができていません。画面をクリック後、再度お試しください。", "通知"); return; }

    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (soundData?.error) {
        showAlert(`サウンド「${soundData.name}」の音声データを読み込めません。ファイルが破損しているか、インポートに失敗した可能性があります。`, 'エラー');
        return;
    }

    if (state.activeAudios[soundId]) {
        stopSound(soundId, soundButtonElement);
    } else {
        playSound(soundId, soundButtonElement, clickTime); // Pass clickTime
    }
}

// リトリガーモード用の再生開始。再生中なら即時停止（フェードなし）して頭出し再生。
async function startRetriggerPlayback(soundId, soundButtonElement) {
    const clickTime = performance.now();
    if (!state.audioContext) { if (!initAudioContext()) { return; } }
    await resumeAudioContext();
    if (state.audioContext?.state !== 'running') { return; }
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (soundData?.error) {
        showAlert(`サウンド「${soundData.name}」の音声データを読み込めません。ファイルが破損しているか、インポートに失敗した可能性があります。`, 'エラー');
        return;
    }
    forceStopSound(soundId, soundButtonElement);
    playSound(soundId, soundButtonElement, clickTime);
}

async function toggleLoop(soundId, loopBtnElement, soundBtnElement) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sd => sd.id === soundId);
    if (!soundData) return;
    soundData.loop = !soundData.loop;
    
    loopBtnElement.classList.toggle('active', soundData.loop);
    soundBtnElement.classList.toggle('loop-on', soundData.loop);

    const activeAudio = state.activeAudios[soundId];
    if (activeAudio?.audioElement) {
        activeAudio.audioElement.loop = soundData.loop;
    }
    debouncedSaveCurrentSceneSounds(`toggleLoop-${soundId}`);
}

function handleIndividualVolumeChange(soundId, volume) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sd => sd.id === soundId);
    if (!soundData) return;
    soundData.volume = volume;
    const activeAudio = state.activeAudios[soundId];
    if (activeAudio?.individualGain && !activeAudio.isFadingOut) {
        activeAudio.individualGain.gain.setTargetAtTime(volume, state.audioContext.currentTime, 0.01);
    }
    debouncedSaveCurrentSceneSounds(`volumeChange-${soundId}`);
}

function handleProgressBarClick(event, soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) return;

    const progressBar = soundButtonElement.querySelector('.progress-bar');
    if (!progressBar) return;

    const rect = progressBar.getBoundingClientRect();
    const seekRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / progressBar.offsetWidth));

    let duration;
    if (audioInfo.audioElement) {
        duration = audioInfo.audioElement.duration;
    } else if (audioInfo.audioBuffer) {
        duration = audioInfo.audioBuffer.duration;
    } else {
        return; // No duration available
    }

    if (!duration || !isFinite(duration)) return;

    const seekTime = duration * seekRatio;

    if (audioInfo.audioElement || audioInfo.audioBuffer) {
        seekSound(soundId, seekTime);
    }
}

// --- Drag & Drop Handlers ---
function handleDragStart(event) {
    if (!state.isSortableEnabled) { event.preventDefault(); return; }
    const target = event.target.closest('.sound-button');
    if (target?.draggable) {
        updateState({ draggedElement: target, draggedSoundId: target.dataset.id });
        event.dataTransfer.setData('text/plain', target.dataset.id);
        event.dataTransfer.effectAllowed = 'move';
        setTimeout(() => target.classList.add('dragging'), 0);
    }
}
function handleDragOver(event) {
    if (!state.isSortableEnabled || !state.draggedElement) return;
    event.preventDefault();
    const targetElement = event.target.closest('.sound-button');
    if (targetElement && targetElement !== state.draggedElement) {
        clearDragOverStyles();
        targetElement.classList.add('drag-over');
    }
}
function handleDragLeave(event) {
    if (!event.relatedTarget || !dom.soundboard.contains(event.relatedTarget)) {
        clearDragOverStyles();
    }
}
async function handleDrop(event) {
    if (!state.isSortableEnabled || !state.draggedElement) return;
    event.preventDefault();
    const dropTarget = event.target.closest('.sound-button');
    if (dropTarget && dropTarget !== state.draggedElement) {
        const sounds = state.scenes[state.currentSceneId].sounds;
        const fromIndex = sounds.findIndex(s => s.id === state.draggedSoundId);
        const toIndex = sounds.findIndex(s => s.id === dropTarget.dataset.id);
        if (fromIndex !== -1 && toIndex !== -1) {
            const [movedItem] = sounds.splice(fromIndex, 1);
            sounds.splice(toIndex, 0, movedItem);
            debouncedSaveCurrentSceneSounds('dragDrop');
            renderers.renderSoundboard();
        }
    }
    clearDragStyles();
    updateState({ draggedElement: null, draggedSoundId: null });
}
function handleDragEnd() {
    clearDragStyles();
    updateState({ draggedElement: null, draggedSoundId: null });
}

// --- Touch Drag & Drop Handlers ---
let longPressTimeoutId = null;
let isDraggingViaTouch = false;
let draggedElementTouch = null;
let draggedSoundIdTouch = null;
let touchStartX = 0;
let touchStartY = 0;
let touchMoveOccurred = false;

function handleTouchStart(event) {
    if (!state.isSortableEnabled) return;
    const targetButton = event.target.closest('.sound-button');
    if (!targetButton || isDraggingViaTouch || event.target.closest('.volume-control')) return;
    touchMoveOccurred = false;
    const touch = event.touches[0];
    draggedElementTouch = targetButton;
    draggedSoundIdTouch = targetButton.dataset.id;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    clearTimeout(longPressTimeoutId);
    longPressTimeoutId = setTimeout(() => {
        if (touchMoveOccurred) return;
        isDraggingViaTouch = true;
        _longPressHandled.add(draggedSoundIdTouch);
        createGhostElement(targetButton, touch);
        targetButton.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(50);
    }, LONG_PRESS_DURATION);
}

function handleTouchMove(event) {
    if (!isDraggingViaTouch) {
        const touch = event.touches[0];
        if (Math.abs(touch.clientX - touchStartX) > 10 || Math.abs(touch.clientY - touchStartY) > 10) {
            clearTimeout(longPressTimeoutId);
            touchMoveOccurred = true;
        }
        return;
    }
    event.preventDefault();
    const touch = event.touches[0];
    if (state.ghostElement) {
        state.ghostElement.style.transform = `translate(${touch.clientX - state.ghostOffsetX}px, ${touch.clientY - state.ghostOffsetY}px)`;
    }
    clearDragOverStyles();
    state.ghostElement.style.display = 'none';
    const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    state.ghostElement.style.display = '';
    const dropTarget = elementBelow?.closest('.sound-button');
    if (dropTarget && dropTarget !== draggedElementTouch) {
        dropTarget.classList.add('drag-over');
    }
}

async function handleTouchEnd(event) {
    clearTimeout(longPressTimeoutId);
    if (!isDraggingViaTouch) { resetTouchDragState(); return; }
    event.preventDefault();
    
    const touch = event.changedTouches[0];
    state.ghostElement.style.display = 'none';
    const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    state.ghostElement.style.display = '';
    const dropTarget = elementBelow?.closest('.sound-button');

    if (dropTarget && dropTarget !== draggedElementTouch) {
        const sounds = state.scenes[state.currentSceneId].sounds;
        const fromIndex = sounds.findIndex(s => s.id === draggedSoundIdTouch);
        const toIndex = sounds.findIndex(s => s.id === dropTarget.dataset.id);
        if (fromIndex !== -1 && toIndex !== -1) {
            const [movedItem] = sounds.splice(fromIndex, 1);
            sounds.splice(toIndex, 0, movedItem);
            debouncedSaveCurrentSceneSounds('touchDrop');
            renderers.renderSoundboard();
        }
    }
    resetTouchDragState();
}

function handleTouchCancel() {
    clearTimeout(longPressTimeoutId);
    if (draggedSoundIdTouch) _longPressHandled.delete(draggedSoundIdTouch);
    resetTouchDragState();
}

function resetTouchDragState() {
    removeGhostElement();
    if (draggedElementTouch) { draggedElementTouch.classList.remove('dragging'); }
    clearDragOverStyles();
    isDraggingViaTouch = false;
    draggedElementTouch = null;
    draggedSoundIdTouch = null;
    longPressTimeoutId = null;
    touchMoveOccurred = false;
}


// --- THE BIG RENDERER ---
import { updateButtonUI } from './05_ui.js';

function renderSoundboard() {
    if (!dom.soundboard) return;
    dom.soundboard.innerHTML = '';
    
    const currentScene = state.scenes[state.currentSceneId];
    if (!currentScene) {
        checkEmptyState(0, "シーンを選択してください。");
        return;
    }

    const sounds = currentScene.sounds || [];
    if (sounds.length > 0) {
        sounds.forEach(sound => {
            const buttonElement = createSoundButton(sound);
            dom.soundboard.appendChild(buttonElement);
            if (state.activeAudios[sound.id]) {
                updateButtonUI(sound.id, buttonElement, true);
            }
        });
    }
    checkEmptyState(sounds.length);
    updateDraggableState();
}

// Assign the renderer function to the exported object
renderers.renderSoundboard = renderSoundboard;

function createSoundButton(sound) {
    const buttonWrapper = document.createElement('div');
    buttonWrapper.className = 'sound-button';
    buttonWrapper.dataset.id = sound.id;
    buttonWrapper.title = sound.name;
    if (sound.loop) buttonWrapper.classList.add('loop-on');
    const triggerMode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
    if (triggerMode !== 'toggle') {
        buttonWrapper.classList.add(`trigger-${triggerMode}`);
    }
    if (sound.color) {
        buttonWrapper.style.setProperty('--pad-color', sound.color);
        buttonWrapper.classList.add('has-color');
    }
    if (sound.error) buttonWrapper.classList.add('error');

    let settingsButtonContent = '<i class="fas fa-cog"></i>';
    const assignedShortcut = Object.keys(state.shortcuts).find(key => state.shortcuts[key] === sound.id);

    if (assignedShortcut) {
        let displayShortcut = assignedShortcut.replace('Control+', 'Ctrl+').replace('Meta+', 'Cmd+');
        settingsButtonContent = displayShortcut.length > 7 ? '...' + displayShortcut.slice(-5) : displayShortcut;
    }

    const formatTime = (seconds) => {
        if (isNaN(seconds) || seconds < 0) return '--:--';
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    };

    const durationText = sound.duration ? `0:00 / ${formatTime(sound.duration)}` : '0:00 / --:--';

    const triggerIndicatorText = triggerMode === 'momentary' ? 'HOLD' : (triggerMode === 'retrigger' ? 'RETRIG' : '');

    buttonWrapper.innerHTML = `
        <span class="loop-indicator">LOOP</span>
        <span class="trigger-indicator">${triggerIndicatorText}</span>
        <div class="button-content">
            <i class="fas fa-play sound-icon"></i>
            <span class="sound-name">${escapeHtml(sound.name)}</span>
            <div class="time-display">${durationText}</div>
        </div>
        <div class="button-controls">
            <button class="loop-button fas fa-sync-alt ${sound.loop ? 'active' : ''}" title="ループ切り替え"></button>
            <div class="volume-control">
                <input type="range" min="0" max="${Math.max(2, Math.ceil(sound.volume ?? 1))}" step="0.01" value="${sound.volume ?? 1.0}" title="音量: ${Math.round((sound.volume ?? 1.0) * 100)}%">
            </div>
        </div>
        <div class="progress-bar"><div class="progress-bar-value"></div></div>
        <button class="delete-button" title="削除"><i class="fas fa-times"></i></button>
        <button class="settings-button" title="設定">${settingsButtonContent}</button>
    `;
    
    let touchFlag = false;
    const setTouchFlag = () => { touchFlag = true; setTimeout(() => touchFlag = false, 150); };

    const isControlTarget = target => target instanceof Element && target.closest('.loop-button, .volume-control, .progress-bar, .delete-button, .settings-button');

    buttonWrapper.addEventListener('pointerdown', e => {
        if (isControlTarget(e.target)) return;
        if (triggerMode === 'momentary' && !state.isSortableEnabled && e.button === 0) {
            e.preventDefault();
            const inputId = `pointer:${e.pointerId}`;
            _toggleHandled.add(sound.id);
            buttonWrapper.setPointerCapture?.(e.pointerId);
            startHoldPlayback(sound.id, buttonWrapper, inputId);
            const release = () => endHoldPlayback(sound.id, inputId, buttonWrapper);
            buttonWrapper.addEventListener('pointerup', release, { once: true });
            buttonWrapper.addEventListener('pointercancel', release, { once: true });
            return;
        }
        if (!state.isSortableEnabled && e.pointerType === 'mouse' && e.button === 0 && !isDraggingViaTouch) {
            e.preventDefault();
            _toggleHandled.add(sound.id);
            if (triggerMode === 'retrigger') startRetriggerPlayback(sound.id, buttonWrapper);
            else handleSoundButtonClick(sound.id, buttonWrapper);
        } else {
            _toggleHandled.delete(sound.id);
        }
    });
    buttonWrapper.addEventListener('touchend', e => {
        if (isControlTarget(e.target)) return;
        if ((triggerMode === 'momentary' && !state.isSortableEnabled) || _longPressHandled.delete(sound.id)) {
            e.preventDefault();
            _toggleHandled.add(sound.id);
            return;
        }
        if (!isDraggingViaTouch) {
            e.preventDefault();
            _toggleHandled.add(sound.id);
            if (triggerMode === 'retrigger') startRetriggerPlayback(sound.id, buttonWrapper);
            else handleSoundButtonClick(sound.id, buttonWrapper);
        }
        clearTimeout(longPressTimeoutId);
    }, { passive: false });
    buttonWrapper.addEventListener('click', e => {
        if (isControlTarget(e.target)) return;
        if (_toggleHandled.delete(sound.id)) return;
        if (!touchFlag && !isDraggingViaTouch) {
            if (triggerMode === 'retrigger') startRetriggerPlayback(sound.id, buttonWrapper);
            else if (triggerMode !== 'momentary') handleSoundButtonClick(sound.id, buttonWrapper);
        }
    });

    const loopButton = buttonWrapper.querySelector('.loop-button');
    loopButton.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); e.stopPropagation(); toggleLoop(sound.id, loopButton, buttonWrapper); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
    loopButton.addEventListener('click', e => { e.stopPropagation(); if (!touchFlag && !isDraggingViaTouch) toggleLoop(sound.id, loopButton, buttonWrapper); });

    const volumeSlider = buttonWrapper.querySelector('input[type="range"]');
    volumeSlider.addEventListener('input', e => { e.stopPropagation(); handleIndividualVolumeChange(sound.id, parseFloat(e.target.value)); e.target.title = `音量: ${Math.round(parseFloat(e.target.value) * 100)}%`; });
    volumeSlider.addEventListener('click', e => e.stopPropagation());
    volumeSlider.addEventListener('touchstart', e => { e.stopPropagation(); clearTimeout(longPressTimeoutId); }, { passive: true });
    
    const progressBar = buttonWrapper.querySelector('.progress-bar');
    progressBar.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); e.stopPropagation(); handleProgressBarClick(e.changedTouches[0], sound.id, buttonWrapper); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
    progressBar.addEventListener('click', e => { e.stopPropagation(); if (!touchFlag && !isDraggingViaTouch) handleProgressBarClick(e, sound.id, buttonWrapper); });

    const deleteButton = buttonWrapper.querySelector('.delete-button');
    const handleDelete = async () => { if (await showConfirm(`サウンド「${sound.name}」を削除しますか？`, '削除確認')) { stopSound(sound.id, buttonWrapper, false); removeSound(sound.id); }};
    deleteButton.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); e.stopPropagation(); handleDelete(); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
    deleteButton.addEventListener('click', e => { e.stopPropagation(); if (!touchFlag && !isDraggingViaTouch) handleDelete(); });

    const settingsButton = buttonWrapper.querySelector('.settings-button');
    settingsButton.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); e.stopPropagation(); handleSoundSettings(sound.id); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
    settingsButton.addEventListener('click', e => { e.stopPropagation(); if (!touchFlag && !isDraggingViaTouch) handleSoundSettings(sound.id); });

    return buttonWrapper;
}

function checkEmptyState(soundCount, message = "") {
    const defaultMessage = "音声ファイルがありません。「追加」ボタンからファイルを追加してください。";
    const container = dom.soundboard;
    let messageElement = container.querySelector('.empty-state-message');
    if (soundCount === 0) {
        if (!messageElement) {
            messageElement = document.createElement('p');
            messageElement.className = 'empty-state-message';
            container.appendChild(messageElement);
        }
        messageElement.textContent = message || defaultMessage;
        messageElement.style.display = 'block';
    } else {
        if (messageElement) messageElement.remove();
    }
}

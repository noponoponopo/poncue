// modules/08_handlers.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { dbRequest } from './04_db.js';
import { showConfirm, showAlert, showPrompt, showSoundSettingsModal, showRollSettingsModal, hideModal, toggleDarkMode, updateDraggableState, clearDragStyles, clearDragOverStyles, createGhostElement, removeGhostElement, createMasterMeterElement, createMasterEffectKnobs, createMasterLimiterKnob, createMasterVolumeKnob, escapeHtml, setupCanvasResize, updateButtonUI, updateSustainLayerBadge, refreshOptAffordance } from './05_ui.js';
import { initAudioContext, resumeAudioContext, playSound, stopSound, stopAllSounds, forceStopSound, pauseSound, resumeSound, togglePauseAllSounds, isSoundPaused, updatePauseAllButton, triggerWaveformUpdate, seekSound, updateActiveSoundLoop, updateActiveSoundEffects, updateActiveSoundPan, updateActiveSoundSpeed, normalizeSoundVolume, analyzeAndApplySilenceTrim, clearSilenceTrim, startMasterMeter, setMasterParam, setMasterLimiterThreshold, supportsAudioOutputSelection, listAudioOutputDevices, setAudioOutputDevice, chooseAudioOutputDevice, startSustainLayer, getSustainLayerCount, setSoundMuted, startRollPlayback, endRollPlayback } from './06_audio.js';
import {
    selectScene, saveSetting, saveCurrentSceneSounds, handleAudioFileSelect,
    removeSound, handleImportFileSelect, populateSceneModalList, generateUniqueId,
    renderers, // renderers object
    exportSceneAsZip, // New export function
    updatePadSizeCSS, saveAudioOutputSettings, saveRollSound // Import updatePadSizeCSS
} from './07_scenes.js';
import { LONG_PRESS_DURATION, PERFORMANCE_MODE, DEFAULT_PERFORMANCE_MODE, TRIGGER_MODES, HOLD_TRIGGER_MODES, SCROLL_PREVENT_KEYS, DEFAULT_KEYBOARD_LAYOUT } from './01_config.js';
import { renderKeyboardView, setKeyboardKeyPressed, getLayoutOptions, clearAllKeyboardKeyPressed } from './11_keyboard_view.js';

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

// --- Event Listener Setup ---
export function setupEventListeners() {
    createMasterMeterElement();
    createMasterVolumeKnob(state.masterVolume, (value, save) => {
        updateState({ masterVolume: value });
        if (state.masterGainNode) {
            state.masterGainNode.gain.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
        }
        if (save) saveSetting('masterVolume', value);
    });
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
    updatePauseAllButton();

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
    dom.addRollBtn?.addEventListener('click', () => { resumeAudioContext(); handleRollSettings(null); });
    dom.pauseAllBtn?.addEventListener('click', async () => {
        await resumeAudioContext();
        await togglePauseAllSounds();
    });
    dom.stopAllBtn?.addEventListener('click', () => {
        // Option押下中は全停止ではなく全ボイスの一時停止にする
        if (state.isOptHeld) togglePauseAllSounds();
        else stopAllSounds(true);
    });
    dom.keyboardViewBtn?.addEventListener('click', toggleKeyboardView);
    dom.keyboardView?.addEventListener('pointerdown', handleVirtualKeyDown);
    dom.keyboardView?.addEventListener('pointerup', handleVirtualKeyUp);
    dom.keyboardView?.addEventListener('pointercancel', handleVirtualKeyUp);
    dom.fileInput?.addEventListener('change', handleAudioFileSelect);
    updateKeyboardViewVisibility();

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

    // Operations Help Modal
    dom.modalHelpBtn?.addEventListener('click', openHelpModal);
    dom.helpModalCloseBtn?.addEventListener('click', closeHelpModal);
    dom.helpModal?.addEventListener('click', (e) => {
        if (e.target !== dom.helpModal) return;
        closeHelpModal();
    });
    
    // App Settings Toggles
    dom.darkModeToggle?.addEventListener('change', toggleDarkMode);
    dom.perfHighRadio?.addEventListener('change', handlePerformanceModeChange);
    dom.perfLowRadio?.addEventListener('change', handlePerformanceModeChange);
    dom.interactionClickRadio?.addEventListener('change', handleInteractionModeChange);
    dom.interactionDragRadio?.addEventListener('change', handleInteractionModeChange);
    dom.waveformToggleCheckbox?.addEventListener('change', handleWaveformToggleChange);
    dom.padSizeSlider?.addEventListener('input', handlePadSizeChange);
    dom.padSizeSlider?.addEventListener('change', () => saveSetting('padSize', state.padSize));
    populateKeyboardLayoutOptions();
    dom.keyboardLayoutSelect?.addEventListener('change', handleKeyboardLayoutChange);
    dom.audioOutputSelect?.addEventListener('change', handleAudioOutputChange);
    dom.audioOutputRefreshBtn?.addEventListener('click', () => { void refreshAudioOutputControls('出力一覧を更新しました。'); });
    dom.audioOutputPickerBtn?.addEventListener('click', handleAudioOutputPicker);
    navigator.mediaDevices?.addEventListener?.('devicechange', handleAudioDeviceChange);

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
        });
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    // ウィンドウ離脱やタブ切り替えで keyup が発火しなかった場合の押下残留を防ぐ
    window.addEventListener('blur', () => {
        clearAllKeyboardKeyPressed();
        if (state.isOptHeld) { state.isOptHeld = false; refreshOptAffordance(); }
        releaseAllHoldInputs();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearAllKeyboardKeyPressed();
            if (state.isOptHeld) { state.isOptHeld = false; refreshOptAffordance(); }
            releaseAllHoldInputs();
        }
    });

    // Show Mode (fullscreen)
    dom.showModeBtn?.addEventListener('click', toggleShowMode);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

function updateKeyboardViewVisibility() {
    if (!dom.keyboardView || !dom.keyboardViewBtn) return;
    dom.keyboardView.hidden = !state.keyboardViewVisible;
    dom.keyboardViewBtn.classList.toggle('active', state.keyboardViewVisible);
    dom.keyboardViewBtn.setAttribute('aria-pressed', String(state.keyboardViewVisible));
    dom.keyboardViewBtn.setAttribute('aria-label', state.keyboardViewVisible ? 'キーボードビューを閉じる' : 'キーボードビューを表示');
    if (state.keyboardViewVisible) renderKeyboardView();
}

function toggleKeyboardView() {
    updateState({ keyboardViewVisible: !state.keyboardViewVisible });
    saveSetting('keyboardViewVisible', state.keyboardViewVisible);
    updateKeyboardViewVisibility();
}

function handleVirtualKeyDown(event) {
    const key = event.target.closest('button[data-shortcut]');
    if (!key || key.disabled || event.button !== 0) return;
    event.preventDefault();
    try { key.setPointerCapture?.(event.pointerId); } catch (_) { /* pointer capture は環境によって失敗しても再生を続ける */ }
    setKeyboardKeyPressed(key.dataset.shortcut, true);
    triggerShortcutDown(key.dataset.shortcut, `virtual:${event.pointerId}`);
}

function handleVirtualKeyUp(event) {
    const key = event.target.closest('button[data-shortcut]')
        || dom.keyboardView?.querySelector(`button[data-shortcut].is-pressed`);
    if (!key) return;
    setKeyboardKeyPressed(key.dataset.shortcut, false);
    triggerShortcutUp(key.dataset.shortcut, `virtual:${event.pointerId}`);
}

function triggerShortcutDown(shortcut, inputId) {
    const soundId = state.shortcuts[shortcut];
    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    const button = dom.soundboard.querySelector(`.sound-button[data-id="${soundId}"]`);
    if (!sound || !button) return;
    const mode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
    if (HOLD_TRIGGER_MODES.includes(mode)) startHoldPlayback(soundId, button, inputId);
    else if (mode === 'retrigger') startRetriggerPlayback(soundId, button);
    else handleSoundButtonClick(soundId, button);
}

function triggerShortcutUp(shortcut, inputId) {
    const soundId = state.shortcuts[shortcut];
    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    if (HOLD_TRIGGER_MODES.includes(sound?.triggerMode)) endHoldPlayback(soundId, inputId);
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
    updateDraggableState();
}

function handleFullscreenChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        document.body.classList.remove('show-mode');
        updateState({ showMode: false });
        updateDraggableState();
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

function populateKeyboardLayoutOptions() {
    if (!dom.keyboardLayoutSelect) return;
    const current = state.keyboardLayout || DEFAULT_KEYBOARD_LAYOUT;
    dom.keyboardLayoutSelect.replaceChildren();
    for (const { id, label } of getLayoutOptions()) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        if (id === current) option.selected = true;
        dom.keyboardLayoutSelect.appendChild(option);
    }
}

function handleKeyboardLayoutChange(event) {
    const newLayout = event.target.value;
    updateState({ keyboardLayout: newLayout });
    saveSetting('keyboardLayout', newLayout);
    if (state.keyboardViewVisible) renderKeyboardView();
}

let audioOutputRefreshGeneration = 0;
let confirmedAudioOutputDeviceIds = null;
let audioOutputOperationGeneration = 0;
let audioOutputSelectionQueue = Promise.resolve();
let audioOutputPickerInFlight = false;
let audioOutputPendingSelectionCount = 0;

function updateAudioOutputDisplay(message = '') {
    const supported = supportsAudioOutputSelection();
    const canEnumerate = typeof navigator.mediaDevices?.enumerateDevices === 'function';
    const canPick = typeof navigator.mediaDevices?.selectAudioOutput === 'function';
    if (dom.audioOutputSelect) dom.audioOutputSelect.disabled = !supported;
    if (dom.audioOutputRefreshBtn) dom.audioOutputRefreshBtn.disabled = !canEnumerate;
    if (dom.audioOutputPickerBtn) dom.audioOutputPickerBtn.hidden = !supported || !canPick;
    if (!dom.audioOutputStatus) return;
    if (!supported) {
        dom.audioOutputStatus.textContent = 'このブラウザでは出力変更に対応していません。既定出力を使用します。';
        return;
    }
    const pendingMessage = state.audioOutputPending ? '（権限を確認してから適用）' : '';
    dom.audioOutputStatus.textContent = message || `現在: ${state.audioOutputDeviceLabel}${pendingMessage}`;
}

async function refreshAudioOutputControls(message = '') {
    const generation = ++audioOutputRefreshGeneration;
    updateAudioOutputDisplay(message);
    if (!dom.audioOutputSelect) return;

    const canEnumerate = typeof navigator.mediaDevices?.enumerateDevices === 'function';
    let devices = [];
    if (canEnumerate) {
        try {
            devices = await listAudioOutputDevices();
        } catch (error) {
            if (generation === audioOutputRefreshGeneration && dom.audioOutputStatus) {
                dom.audioOutputStatus.textContent = `出力一覧を取得できません: ${error.message || '権限を確認してください。'}`;
            }
            return;
        }
    }
    if (generation !== audioOutputRefreshGeneration) return;
    if (!state.audioOutputPending
        && state.audioOutputDeviceId !== 'default'
        && devices.some(device => device.deviceId === state.audioOutputDeviceId)) {
        confirmedAudioOutputDeviceIds = new Set(
            devices.filter(device => device.deviceId).map(device => device.deviceId)
        );
    }

    dom.audioOutputSelect.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'システム既定';
    dom.audioOutputSelect.appendChild(defaultOption);

    devices.filter(device => device.deviceId && device.deviceId !== 'default').forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `音声出力 ${index + 1}`;
        dom.audioOutputSelect.appendChild(option);
    });

    if (state.audioOutputDeviceId !== 'default'
        && !devices.some(device => device.deviceId === state.audioOutputDeviceId)) {
        const unavailableOption = document.createElement('option');
        unavailableOption.value = state.audioOutputDeviceId;
        unavailableOption.textContent = `${state.audioOutputDeviceLabel || '選択した出力'}（未接続または未許可）`;
        dom.audioOutputSelect.appendChild(unavailableOption);
    }
    dom.audioOutputSelect.value = state.audioOutputDeviceId;
    updateAudioOutputDisplay(message);
}

async function applyAudioOutputSelection(deviceId, label, expectedOperationGeneration = null) {
    const isDeviceChange = expectedOperationGeneration !== null;
    const operationGeneration = expectedOperationGeneration ?? ++audioOutputOperationGeneration;
    if (!isDeviceChange) audioOutputPendingSelectionCount += 1;
    const operation = audioOutputSelectionQueue.then(async () => {
        let stale = false;
        try {
            if (operationGeneration !== audioOutputOperationGeneration) {
                stale = true;
                return false;
            }

            if (dom.audioOutputSelect) dom.audioOutputSelect.disabled = true;
            if (dom.audioOutputRefreshBtn) dom.audioOutputRefreshBtn.disabled = true;
            if (dom.audioOutputPickerBtn) dom.audioOutputPickerBtn.disabled = true;
            if (dom.audioOutputStatus) dom.audioOutputStatus.textContent = '出力を切り替えています...';

            const requestedId = deviceId || 'default';
            const outputLabel = label || (requestedId === 'default' ? 'システム既定' : '選択した出力');
            await setAudioOutputDevice(requestedId, outputLabel, { commitState: false });
            if (operationGeneration !== audioOutputOperationGeneration) {
                stale = true;
                return false;
            }

            updateState({
                audioOutputDeviceId: requestedId,
                audioOutputDeviceLabel: outputLabel,
                audioOutputPending: false
            });
            await saveAudioOutputSettings(requestedId, outputLabel);
            if (operationGeneration !== audioOutputOperationGeneration) {
                stale = true;
                return false;
            }
            await refreshAudioOutputControls(`現在: ${outputLabel}`);
            return true;
        } catch (error) {
            if (['NotAllowedError', 'SecurityError'].includes(error.name)) {
                updateState({ audioOutputPending: true });
            }
            updateAudioOutputDisplay(`切替失敗: ${error.message || '出力デバイスを利用できません。'}`);
            if (dom.audioOutputSelect) dom.audioOutputSelect.value = state.audioOutputDeviceId;
            return false;
        } finally {
            if (!stale) {
                if (dom.audioOutputSelect) dom.audioOutputSelect.disabled = !supportsAudioOutputSelection();
                if (dom.audioOutputRefreshBtn) dom.audioOutputRefreshBtn.disabled = typeof navigator.mediaDevices?.enumerateDevices !== 'function';
                if (dom.audioOutputPickerBtn) {
                    dom.audioOutputPickerBtn.disabled = false;
                    dom.audioOutputPickerBtn.hidden = !supportsAudioOutputSelection()
                        || typeof navigator.mediaDevices?.selectAudioOutput !== 'function';
                }
            }
        }
    });
    audioOutputSelectionQueue = operation.catch(() => {});
    if (!isDeviceChange) {
        operation.then(
            () => { audioOutputPendingSelectionCount = Math.max(0, audioOutputPendingSelectionCount - 1); },
            () => { audioOutputPendingSelectionCount = Math.max(0, audioOutputPendingSelectionCount - 1); }
        );
    }
    return operation;
}

async function handleAudioOutputChange(event) {
    const option = event.target.selectedOptions?.[0];
    await applyAudioOutputSelection(event.target.value, option?.textContent || '選択した出力');
}

async function handleAudioOutputPicker() {
    if (audioOutputPickerInFlight) return;
    audioOutputPickerInFlight = true;
    if (dom.audioOutputPickerBtn) dom.audioOutputPickerBtn.disabled = true;
    try {
        const device = await chooseAudioOutputDevice();
        if (device?.deviceId) await applyAudioOutputSelection(device.deviceId, device.label || '選択した出力');
    } catch (error) {
        if (dom.audioOutputStatus) {
            dom.audioOutputStatus.textContent = error.name === 'NotAllowedError'
                ? '出力選択が許可されませんでした。HTTPS接続とユーザー操作を確認してください。'
                : (error.message || '出力デバイスを選択できませんでした。');
        }
    } finally {
        audioOutputPickerInFlight = false;
        if (dom.audioOutputPickerBtn) {
            dom.audioOutputPickerBtn.disabled = false;
            dom.audioOutputPickerBtn.hidden = !supportsAudioOutputSelection()
                || typeof navigator.mediaDevices?.selectAudioOutput !== 'function';
        }
    }
    void handleAudioDeviceChange();
}

async function handleAudioDeviceChange() {
    if (audioOutputPickerInFlight) {
        await refreshAudioOutputControls();
        return;
    }
    const refreshGeneration = ++audioOutputRefreshGeneration;
    const selectedDeviceId = state.audioOutputDeviceId;
    if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
        updateAudioOutputDisplay();
        return;
    }
    let devices;
    try {
        devices = await listAudioOutputDevices();
    } catch (error) {
        if (refreshGeneration === audioOutputRefreshGeneration) {
            updateAudioOutputDisplay(`出力一覧を更新できません: ${error.message || '権限を確認してください。'}`);
        }
        return;
    }
    if (refreshGeneration !== audioOutputRefreshGeneration
        || selectedDeviceId !== state.audioOutputDeviceId) return;
    if (audioOutputPendingSelectionCount > 0) {
        await refreshAudioOutputControls();
        return;
    }

    const selectedStillAvailable = selectedDeviceId === 'default'
        || devices.some(device => device.deviceId === selectedDeviceId);
    const selectedWasConfirmed = confirmedAudioOutputDeviceIds?.has(selectedDeviceId);
    if (!selectedStillAvailable && selectedWasConfirmed && devices.length > 0) {
        const operationGeneration = ++audioOutputOperationGeneration;
        const changed = await applyAudioOutputSelection('default', 'システム既定', operationGeneration);
        if (changed) updateAudioOutputDisplay('選択していた出力が切断されたため、システム既定へ戻しました。');
        return;
    }
    await refreshAudioOutputControls();
}

// --- Scene Modal Handlers ---
function openSceneSettingsModal() {
    if (!state.db) { showAlert("データベースに接続されていません。"); return; }
    populateSceneModalList();
    void refreshAudioOutputControls();
    dom.sceneSettingsModal.classList.add('active');
}
function closeSceneSettingsModal() {
    dom.sceneSettingsModal.classList.remove('active');
}

// --- Operations Help Modal ---
function openHelpModal() {
    dom.helpModal?.classList.add('active');
}
function closeHelpModal() {
    dom.helpModal?.classList.remove('active');
}
async function handleModalAddScene() {
    const sceneName = await showPrompt(`新しいシーンの名前:`, `新しいシーン`, `Scene ${Object.keys(state.scenes).length + 1}`);
    if (sceneName?.trim()) {
        const newSceneId = generateUniqueId('scn');
        const newSceneData = { id: newSceneId, name: sceneName.trim(), color: null, sounds: [], shortcuts: {} };
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
        await saveCurrentSceneSounds("modalRename");
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

    // ドラムロールは専用の設定モーダルで編集する
    if (sound.type === 'roll') {
        await handleRollSettings(soundId);
        return;
    }

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
                // 即時保存: ノーマライズは明示的操作なのでデバウンスせず保存する。
                // デバウンス中のリロードで音量設定が消えるのを防ぐ。
                await saveCurrentSceneSounds(`normalize-${soundId}`);
                renderers.renderSoundboard();
            }
            return result;
        },
        onTrimSilence: async (thresholdDb) => {
            const result = await analyzeAndApplySilenceTrim(soundId, thresholdDb);
            if (result && !result.silent) {
                await saveCurrentSceneSounds(`trim-silence-${soundId}`);
                renderers.renderSoundboard();
            }
            return result;
        },
        onResetTrim: async () => {
            if (!clearSilenceTrim(soundId)) return false;
            await saveCurrentSceneSounds(`reset-trim-${soundId}`);
            renderers.renderSoundboard();
            return true;
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
        // 即時保存: 「保存」は明示的操作なのでデバウンスせず保存する。
        // デバウンス中(300ms)のリロードでエフェクト設定が消えるのを防ぐ。
        await saveCurrentSceneSounds(`soundSettingsChange-${soundId}`);

        showAlert(`サウンド「${sound.name}」の設定を更新しました。`, '通知');
        renderers.renderSoundboard();
    }
}

// ドラムロールの追加・編集。soundId が null なら追加、既存IDなら編集。
async function handleRollSettings(soundId) {
    const sound = soundId
        ? state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId)
        : null;

    let currentShortcut = '';
    if (sound) {
        for (const key in state.shortcuts) {
            if (state.shortcuts[key] === sound.id) {
                currentShortcut = key;
                break;
            }
        }
    }

    const newSettings = await showRollSettingsModal(sound, currentShortcut);
    if (newSettings === null) return;

    const { name, shortcut, color, parts } = newSettings;

    // ショートカットの衝突のみ先に判定する（通常サウンドと同じ排他ルール）
    if (shortcut) {
        const conflictSoundId = state.shortcuts[shortcut];
        if (conflictSoundId && conflictSoundId !== soundId) {
            const conflictSound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === conflictSoundId);
            showAlert(`ショートカット「${shortcut}」は既に「${conflictSound?.name ?? '別のサウンド'}」に割り当てられています。`, 'エラー');
            return;
        }
    }

    // 既存の割り当てを外してから保存する（追加時は soundId が確定してから割り当てる）
    if (soundId && currentShortcut && state.shortcuts[currentShortcut] === soundId) {
        delete state.shortcuts[currentShortcut];
    }

    // 編集中に再生が残っている場合は止めてから更新する
    if (soundId && state.activeAudios[soundId]) stopSound(soundId, null, false);

    const saved = await saveRollSound(soundId, { name, color, parts });
    if (!saved) {
        if (currentShortcut) state.shortcuts[currentShortcut] = soundId;
        return;
    }

    if (shortcut) {
        state.shortcuts[shortcut] = saved.id;
    }
    await saveCurrentSceneSounds(`rollShortcut-${saved.id}`);
    // ショートカット確定後にパッドとキーボードビューへ割り当てを反映する
    renderers.renderSoundboard();

    if (sound) {
        showAlert(`ドラムロール「${saved.name}」の設定を更新しました。`, '通知');
    }
}

function normalizeKey(e) {    const modifiers = [];
    if (e.ctrlKey) modifiers.push('Control');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.metaKey) modifiers.push('Meta');

    let key = e.key;
    if (key === ' ') key = 'Space';
    if (key === '¥') key = 'Yen';
    // Mac/Win で英数・かなの event.key が割れるため代表名に正規化
    if (['English', 'Alphanumeric', 'Lang2', 'Eisu', 'RomanCharacters'].includes(key)) key = 'English';
    if (['Kana', 'KanaMode', 'JapaneseKana', 'Lang1', 'Hiragana'].includes(key)) key = 'Kana';
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) key = key.replace('Arrow', '');
    // 修飾キー単体の押下はショートカットとして扱わず、pressed 表示にも関与させない
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
    if (key.length === 1 && key.match(/[a-z]/i)) key = key.toUpperCase();

    return [...modifiers, key].filter(Boolean).join('+');
}

// ショートカット操作でブラウザ既定動作（ページスクロールやフォーカス中ボタンの活性クリック）
// を抑制すべきキーか。INPUT/TEXTAREA/モーダル表示中は呼び出し元でガード済み。
function shouldPreventDefaultKey(normalizedKey) {
    return Boolean(state.shortcuts[normalizedKey]) || SCROLL_PREVENT_KEYS.has(normalizedKey);
}

function getKeyboardHoldInputId(event, normalizedKey) {
    const code = event.code && event.code !== 'Unidentified' ? event.code : normalizedKey;
    return `key:${code}`;
}

async function handleKeyDown(event) {
    if (event.key === 'Alt') {
        if (!state.isOptHeld) { state.isOptHeld = true; refreshOptAffordance(); }
        return;
    }
    if (dom.customModalOverlay.classList.contains('active') ||
        dom.sceneSettingsModal.classList.contains('active') ||
        dom.helpModal?.classList.contains('active') ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
        return;
    }

    const normalizedKey = normalizeKey(event);

    // サウンド割当の有無にかかわらず、スペースや矢印などのスクロール系キーは
    // ページスクロールとフォーカス中ボタンのクリックを起こさないようにする。
    // 二重発火（ショートカット＋ボタンクリック）もこれで防がれる。
    if (shouldPreventDefaultKey(normalizedKey)) {
        event.preventDefault();
    }

    if (normalizedKey) setKeyboardKeyPressed(normalizedKey, true);

    if (event.key === 'Escape') {
        // Option押下中は全停止ではなく全ボイスの一時停止にする
        if (state.isOptHeld) togglePauseAllSounds();
        else stopAllSounds(true);
        return;
    }

    const soundId = state.shortcuts[normalizedKey];

    if (soundId) {
        const soundButtonElement = dom.soundboard.querySelector(`.sound-button[data-id="${soundId}"]`);
        if (!soundButtonElement) return;
        const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
        const triggerMode = TRIGGER_MODES.includes(sound?.triggerMode) ? sound.triggerMode : 'toggle';
        const isHoldTrigger = sound?.type === 'roll' || HOLD_TRIGGER_MODES.includes(triggerMode);
        if (isHoldTrigger) {
            if (!event.repeat) {
                const inputId = getKeyboardHoldInputId(event, normalizedKey);
                _keyboardHoldSounds.set(inputId, soundId);
                startHoldPlayback(soundId, soundButtonElement, inputId);
            }
        } else if (!event.repeat) {
            if (triggerMode === 'retrigger') startRetriggerPlayback(soundId, soundButtonElement);
            else handleSoundButtonClick(soundId, soundButtonElement);
        }
    }
}

function handleKeyUp(event) {
    const normalizedKey = normalizeKey(event);

    // pressed のリセットはガードより優先。フォーカス移動やモーダル表示で
    // keyup がガードされても押下状態を残留させない。
    if (normalizedKey) setKeyboardKeyPressed(normalizedKey, false);

    if (event.key === 'Alt') {
        if (state.isOptHeld) { state.isOptHeld = false; refreshOptAffordance(); }
        return;
    }

    // 修飾キーの解放順に左右されないよう、keydown 時の物理キーIDから対象音源を解決する。
    const inputId = getKeyboardHoldInputId(event, normalizedKey);
    const fallbackSoundId = state.shortcuts[normalizedKey];
    const wasTrackedHold = _keyboardHoldSounds.has(inputId);
    const heldSoundId = _keyboardHoldSounds.get(inputId) ?? fallbackSoundId;
    if (heldSoundId) {
        _keyboardHoldSounds.delete(inputId);
        const heldSound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === heldSoundId);
        if (wasTrackedHold || heldSound?.type === 'roll' || HOLD_TRIGGER_MODES.includes(heldSound?.triggerMode)) {
            endHoldPlayback(heldSoundId, inputId);
        }
    }

    if (dom.customModalOverlay.classList.contains('active') ||
        dom.sceneSettingsModal.classList.contains('active') ||
        dom.helpModal?.classList.contains('active') ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
        return;
    }

    if (shouldPreventDefaultKey(normalizedKey)) {
        event.preventDefault();
    }
}

// --- Sound Button and Board Handlers ---

// Tracks sounds already toggled by pointerdown/touchend so the trailing
// click event doesn't fire a second toggle. Module-level to survive
// button re-renders; entries are consumed (deleted) by the click handler.
const _toggleHandled = new Set();
const _holdInputs = new Map();
const _keyboardHoldSounds = new Map(); // key:${event.code} -> soundId（keyup時の修飾キー変化に耐える）
const _longPressHandled = new Set();

async function startHoldPlayback(soundId, soundButtonElement, inputId) {
    let inputs = _holdInputs.get(soundId);
    if (!inputs) {
        inputs = new Set();
        _holdInputs.set(soundId, inputs);
    }
    if (inputs.has(inputId)) return;
    inputs.add(inputId);

    const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const mode = TRIGGER_MODES.includes(sound?.triggerMode) ? sound.triggerMode : 'momentary';
    if (sound?.type === 'roll' || mode === 'roll') {
        // ドラムロール: 押下で起こり→ループ開始（離上は releaseHoldPlayback → endRollPlayback）
        await startRollPlayback(soundId, soundButtonElement);
    } else if (mode === 'muteHold' && state.activeAudios[soundId]?.muted) {
        // muteHold は押している間に消音を解除する
        setSoundMuted(soundId, false);
    } else if (!state.activeAudios[soundId]) {
        // 未再生なら通常の初期化・再生（paused 状態なら resumeSound へ進む）
        await handleSoundButtonClick(soundId, soundButtonElement);
    }

    // blur/visibilitychange が await 中に発生した場合も、開始直後に解放する。
    if (!_holdInputs.get(soundId)?.size && state.activeAudios[soundId]) {
        releaseHoldPlayback(soundId, soundButtonElement);
    }
}

function releaseHoldPlayback(soundId, soundButtonElement = null) {
    if (!state.activeAudios[soundId]) return;
    // 離した時の動作はモード依存: momentary=停止、pauseHold=一時停止、muteHold=消音、roll=終わり→締め。
    // Option(Alt)押下中はロール以外を一時停止に統一する。
    const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const mode = TRIGGER_MODES.includes(sound?.triggerMode) ? sound.triggerMode : 'momentary';
    if (sound?.type === 'roll' || mode === 'roll') endRollPlayback(soundId);
    else if (state.isOptHeld || mode === 'pauseHold') pauseSound(soundId, soundButtonElement);
    else if (mode === 'muteHold') setSoundMuted(soundId, true);
    else stopSound(soundId, soundButtonElement);
}

function endHoldPlayback(soundId, inputId, soundButtonElement = null) {
    const inputs = _holdInputs.get(soundId);
    if (!inputs) return;
    inputs.delete(inputId);
    if (inputs.size) return;
    _holdInputs.delete(soundId);
    releaseHoldPlayback(soundId, soundButtonElement);
}

// keyup/blurを取り逃しても、ホールド系の音源が鳴りっぱなし・消音しっぱなしにならないようにする。
function releaseAllHoldInputs() {
    const heldSoundIds = [..._holdInputs.keys()];
    _holdInputs.clear();
    _keyboardHoldSounds.clear();
    heldSoundIds.forEach(soundId => releaseHoldPlayback(soundId));
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

    // ドラムロールは押下〜離上で起こり→ループ→終わり→締めを再生する
    if (soundData?.type === 'roll') {
        await startRollPlayback(soundId, soundButtonElement);
        return;
    }

    if (state.activeAudios[soundId] || state.sustainLayers[soundId]?.length) {
        // Option(Alt)押下中はモードによらず一時停止（本体＋レイヤー全ボイス）に統一
        if (state.isOptHeld) {
            pauseSound(soundId, soundButtonElement);
            return;
        }
        const triggerMode = TRIGGER_MODES.includes(soundData?.triggerMode) ? soundData.triggerMode : 'toggle';
        if (triggerMode === 'sustain') {
            await startSustainLayer(soundId);
        } else if (triggerMode === 'pause') {
            pauseSound(soundId, soundButtonElement);
        } else if (triggerMode === 'mute') {
            setSoundMuted(soundId, !state.activeAudios[soundId].muted);
        } else if (triggerMode === 'pauseHold') {
            // 押下時は再生を続け、離した時に一時停止する（startHoldPlayback 経由）
        } else if (triggerMode === 'muteHold') {
            if (state.activeAudios[soundId].muted) setSoundMuted(soundId, false);
        } else {
            stopSound(soundId, soundButtonElement);
        }
    } else if (isSoundPaused(soundId)) {
        resumeSound(soundId, soundButtonElement);
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
    // Option押下中は頭出し再生ではなく一時停止/再開（全モード共通の挙動）
    if (state.isOptHeld) {
        if (state.activeAudios[soundId] || state.sustainLayers[soundId]?.length) {
            pauseSound(soundId, soundButtonElement);
            return;
        }
        if (isSoundPaused(soundId)) {
            resumeSound(soundId, soundButtonElement);
            return;
        }
    }
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

    updateActiveSoundLoop(soundId, soundData.loop);
    await saveCurrentSceneSounds(`toggleLoop-${soundId}`);
}

function handleIndividualVolumeChange(soundId, volume) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sd => sd.id === soundId);
    if (!soundData) return;
    soundData.volume = volume;
    const activeAudio = state.activeAudios[soundId];
    if (activeAudio?.individualGain && !activeAudio.isFadingOut && !activeAudio.muted) { // ミュート中は音量だけ更新し、ゲインは解除時に反映
        activeAudio.individualGain.gain.setTargetAtTime(volume, state.audioContext.currentTime, 0.01);
    }
    debouncedSaveCurrentSceneSounds(`volumeChange-${soundId}`);
}

function handleProgressBarClick(event, soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) return;
    if (audioInfo.isRoll) return; // ロールはパート連結再生のためシーク不可

    const progressBar = soundButtonElement.querySelector('.progress-bar');
    if (!progressBar) return;

    const rect = progressBar.getBoundingClientRect();
    const seekRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / progressBar.offsetWidth));

    const trimStart = Number.isFinite(audioInfo.trimStart) ? audioInfo.trimStart : 0;
    const trimEnd = Number.isFinite(audioInfo.trimEnd)
        ? audioInfo.trimEnd
        : audioInfo.audioBuffer?.duration ?? audioInfo.audioElement?.duration;
    const duration = trimEnd - trimStart;
    if (!duration || !isFinite(duration)) return;

    const seekTime = trimStart + duration * seekRatio;

    if (audioInfo.audioElement || audioInfo.audioBuffer) {
        seekSound(soundId, seekTime);
    }
}

// --- Drag & Drop Handlers ---
function handleDragStart(event) {
    if (!state.isSortableEnabled || state.showMode) { event.preventDefault(); return; }
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
            await saveCurrentSceneSounds('dragDrop');
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
    if (!state.isSortableEnabled || state.showMode) return;
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
            await saveCurrentSceneSounds('touchDrop');
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
            } else if (isSoundPaused(sound.id)) {
                updateButtonUI(sound.id, buttonElement, false, true);
            }
            updateSustainLayerBadge(sound.id, getSustainLayerCount(sound.id));
        });
    }
    checkEmptyState(sounds.length);
    updateDraggableState();
    if (state.keyboardViewVisible) renderKeyboardView();
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
    const isHoldTrigger = sound.type === 'roll' || HOLD_TRIGGER_MODES.includes(triggerMode);
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

    const trimStart = Number.isFinite(sound.trimStart) ? sound.trimStart : 0;
    const trimEnd = Number.isFinite(sound.trimEnd) ? sound.trimEnd : sound.duration;
    const playbackDuration = Number.isFinite(trimEnd) ? Math.max(0, trimEnd - trimStart) : sound.duration;
    const durationText = playbackDuration ? `0:00 / ${formatTime(playbackDuration)}` : '0:00 / --:--';
    const isRoll = sound.type === 'roll';

    // パッド右上の動作インジケーター（モードの次動作を示す。sustain はボイス数に置き換わる）
    const TRIGGER_INDICATOR_TEXTS = { momentary: 'HOLD', retrigger: 'RETRIG', sustain: 'LAYER', pause: 'PAUSE', pauseHold: 'HOLD+PAUSE', mute: 'MUTE', muteHold: 'HOLD+MUTE', roll: 'ROLL' };
    const triggerIndicatorText = TRIGGER_INDICATOR_TEXTS[triggerMode] ?? '';

    buttonWrapper.innerHTML = `
        <span class="loop-indicator">LOOP</span>
        <span class="trigger-indicator">${triggerIndicatorText}</span>
        <div class="button-content">
            <i class="${isRoll ? 'fas fa-drum' : 'fas fa-play'} sound-icon"></i>
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
    // ホールド系モード（momentary/pauseHold/muteHold）は押下〜離上で動作する

    buttonWrapper.addEventListener('pointerdown', e => {
        if (isControlTarget(e.target)) return;
        if (isHoldTrigger && !state.isSortableEnabled && e.button === 0) {
            e.preventDefault();
            const inputId = `pointer:${e.pointerId}`;
            _toggleHandled.add(sound.id);
            try { buttonWrapper.setPointerCapture?.(e.pointerId); } catch (_) { /* pointer capture は環境によって失敗しても再生を続ける */ }
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
        if ((isHoldTrigger && !state.isSortableEnabled) || _longPressHandled.delete(sound.id)) {
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
            else if (!isHoldTrigger) handleSoundButtonClick(sound.id, buttonWrapper);
        }
    });

    const loopButton = buttonWrapper.querySelector('.loop-button');
    if (isRoll) {
        // ロールはパート構成でループが決まるため、通常のループ切替ボタンは使わない
        loopButton.style.display = 'none';
    } else {
        loopButton.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); e.stopPropagation(); toggleLoop(sound.id, loopButton, buttonWrapper); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
        loopButton.addEventListener('click', e => { e.stopPropagation(); if (!touchFlag && !isDraggingViaTouch) toggleLoop(sound.id, loopButton, buttonWrapper); });
    }

    const volumeSlider = buttonWrapper.querySelector('input[type="range"]');
    volumeSlider.addEventListener('input', e => { e.stopPropagation(); handleIndividualVolumeChange(sound.id, parseFloat(e.target.value)); e.target.title = `音量: ${Math.round(parseFloat(e.target.value) * 100)}%`; });
    volumeSlider.addEventListener('click', e => e.stopPropagation());
    volumeSlider.addEventListener('touchstart', e => { e.stopPropagation(); clearTimeout(longPressTimeoutId); }, { passive: true });

    // ドラッグモード中にスライダー操作がカードのHTML5ドラッグに横取りされないよう、押下中のみカードのdraggableを無効化する
    volumeSlider.addEventListener('pointerdown', () => {
        if (!state.isSortableEnabled || state.showMode) return;
        buttonWrapper.draggable = false;
        const restoreDraggable = () => {
            window.removeEventListener('pointerup', restoreDraggable);
            window.removeEventListener('pointercancel', restoreDraggable);
            buttonWrapper.draggable = state.isSortableEnabled && !state.showMode;
        };
        window.addEventListener('pointerup', restoreDraggable);
        window.addEventListener('pointercancel', restoreDraggable);
    });

    const progressBar = buttonWrapper.querySelector('.progress-bar');
    if (isRoll) {
        // ロールはパート単位の短いサイクルでプログレスバーが忙しく動くため表示しない（シークも不可）
        progressBar.style.display = 'none';
    }
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

// modules/08_handlers.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { dbRequest } from './04_db.js';
import { showConfirm, showAlert, showPrompt, showSoundSettingsModal, hideModal, toggleDarkMode, updateDraggableState, clearDragStyles, clearDragOverStyles, createGhostElement, removeGhostElement, createMasterMeterElement, createMasterEffectKnobs, escapeHtml, setupCanvasResize } from './05_ui.js';
import { initAudioContext, resumeAudioContext, playSound, stopSound, stopAllSounds, triggerWaveformUpdate, seekSound, updateActiveSoundEffects, startMasterMeter, setMasterParam } from './06_audio.js';
import {
    selectScene, saveSetting, saveCurrentSceneSounds, handleAudioFileSelect,
    removeSound, handleImportFileSelect, populateSceneModalList, generateUniqueId,
    renderers, // renderers object
    exportSceneAsZip, // New export function
    updatePadSizeCSS // Import updatePadSizeCSS
} from './07_scenes.js';
import { LONG_PRESS_DURATION, PERFORMANCE_MODE, MIDI_GLOBAL_ACTIONS, MIDI_PLAYBACK_MODE } from './01_config.js';
import { enableMidiInput, disableMidiInput, updateMidiButtonState, getMidiInputOptions, formatMidiBinding, normalizeMidiSettings, beginMidiLearn, cancelMidiLearn, MIDI_GLOBAL_ACTION_LABELS } from './11_midi.js';

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
    createMasterEffectKnobs({ eq: state.masterEq, comp: state.masterComp, delay: state.masterDelay }, (key, value) => {
        setMasterParam(key, value);
        const [group] = key.split('.');
        const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
        saveSetting(stateKey, state[stateKey]);
    });
    startMasterMeter();
    relocateMasterVolume();
    renderMidiGlobalActions();

    // Custom Modal
    dom.customModalOkBtn?.addEventListener('click', handleModalOk);
    dom.customModalCancelBtn?.addEventListener('click', handleModalCancel);
    dom.customModalOverlay?.addEventListener('click', handleModalOverlayClick);

    // Audio resume
    document.body.addEventListener('click', resumeAudioContext, { capture: true, once: true });
    document.body.addEventListener('touchend', resumeAudioContext, { capture: true, once: true });

    // Header & Main Controls
    dom.addSoundBtn?.addEventListener('click', () => { resumeAudioContext(); dom.fileInput.click(); });
    dom.midiEnableBtn?.addEventListener('click', handleMidiEnableClick);
    dom.panicStopBtn?.addEventListener('click', () => dispatchControlAction({ type: MIDI_GLOBAL_ACTIONS.PANIC }));
    updateMidiButtonState();
    dom.fileInput?.addEventListener('change', handleAudioFileSelect);
    dom.masterVolumeSlider?.addEventListener('input', handleMasterVolumeChange);
    dom.masterVolumeSlider?.addEventListener('change', () => saveSetting('masterVolume', state.masterVolume));
    
    // Scene Settings Modal
    dom.sceneSettingsBtn?.addEventListener('click', openSceneSettingsModal);
    dom.modalCloseBtn?.addEventListener('click', closeSceneSettingsModal);
    dom.sceneSettingsModal?.addEventListener('click', (e) => { if (e.target === dom.sceneSettingsModal) closeSceneSettingsModal(); });
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
    dom.midiDeviceSelect?.addEventListener('change', handleMidiSettingsChange);
    dom.midiChannelSelect?.addEventListener('change', handleMidiSettingsChange);
    dom.midiFixedGridCheckbox?.addEventListener('change', handleMidiSettingsChange);
    dom.midiBaseNoteInput?.addEventListener('change', handleMidiSettingsChange);
    dom.midiGlobalActions?.addEventListener('click', handleMidiGlobalActionClick);

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

    // Auto-resume AudioContext when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.audioContext?.state === 'suspended') {
            resumeAudioContext().then(() => {
                updateMidiAudioStatus(state.audioContext?.state);
            });
        }
    });

    // Monitor AudioContext state changes
    if (state.audioContext) {
        state.audioContext.addEventListener('statechange', () => {
            updateMidiAudioStatus(state.audioContext?.state);
        });
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
function handleModalOverlayClick(e) {
    if (e.target === dom.customModalOverlay) {
        if (state.confirmResolve) state.confirmResolve(false);
        hideModal();
    }
}

// --- Header & Main Control Handlers ---
function handleMasterVolumeChange() {
    updateState({ masterVolume: parseFloat(dom.masterVolumeSlider.value) });
    if (state.masterGainNode) {
        state.masterGainNode.gain.setTargetAtTime(state.masterVolume, state.audioContext.currentTime, 0.01);
    }
}

async function handleMidiEnableClick() {
    try {
        // Toggle: if already enabled, disconnect cleanly
        if (state.midiEnabled) {
            disableMidiInput();
            await saveSetting('midiSettings', state.midiSettings);
            populateMidiSettingsUI();
            return;
        }

        if (!state.audioContext && !initAudioContext()) {
            showAlert('オーディオ機能の初期化に失敗しました。', 'MIDI');
            return;
        }

        await resumeAudioContext();
        const midiAccess = await enableMidiInput(handleMidiControlEvent);
        await saveSetting('midiSettings', state.midiSettings);
        populateMidiSettingsUI();

        if (midiAccess.inputs.size === 0) {
            showAlert('MIDI入力を有効化しましたが、入力デバイスが見つかりません。DAWから送る場合はOSの仮想MIDIポートを有効にしてください。', 'MIDI');
        }
    } catch (err) {
        console.error('Failed to enable MIDI input:', err);
        updateMidiButtonState(err.message?.includes('not supported') ? 'unsupported' : 'error');
        showAlert('MIDI入力を有効化できませんでした。Web MIDI対応ブラウザ、権限、MIDIデバイスを確認してください。', 'MIDI');
    }
}

function handleMidiControlEvent({ midiEvent, actions }) {
    actions.forEach(action => dispatchControlAction(action, midiEvent));
}

function updateMidiAudioStatus(ctxState) {
    if (!dom.midiStatusText) return;
    if (ctxState && ctxState !== 'running') {
        dom.midiStatusText.textContent = 'Audio一時停止中: ブラウザ画面を一度クリックしてください。';
        dom.midiStatusText.style.color = 'var(--danger-color)';
    } else if (state.midiEnabled) {
        const inputCount = getMidiInputOptions().filter(input => input.state !== 'disconnected').length;
        if (inputCount === 0) {
            dom.midiStatusText.textContent = 'MIDIは有効ですが入力がありません。DAWの出力先にIAC/loopMIDIなどの仮想ポートを選んでください。';
        } else {
            dom.midiStatusText.textContent = `MIDI入力 ${inputCount} 件。Learnまたは固定グリッドで操作できます。`;
        }
        dom.midiStatusText.style.color = '';
    }
}

async function dispatchControlAction(action, midiEvent = null) {
    if (action.type === 'sound.control') {
        await dispatchSoundAction(action.soundId, action.mode, midiEvent);
        return;
    }

    if (midiEvent?.phase === 'release') return;

    if (action.type === MIDI_GLOBAL_ACTIONS.STOP_ALL) {
        await stopAllSounds(false);
    } else if (action.type === MIDI_GLOBAL_ACTIONS.FADE_ALL) {
        await stopAllSounds(true);
    } else if (action.type === MIDI_GLOBAL_ACTIONS.PANIC) {
        updateState({ midiHeldKeys: {}, midiLearnTarget: null });
        await stopAllSounds(false);
        updateMidiButtonState();
    } else if (action.type === MIDI_GLOBAL_ACTIONS.SCENE_PREV) {
        await selectAdjacentScene(-1);
    } else if (action.type === MIDI_GLOBAL_ACTIONS.SCENE_NEXT) {
        await selectAdjacentScene(1);
    }
}

async function dispatchSoundAction(soundId, mode = MIDI_PLAYBACK_MODE.TOGGLE, midiEvent = null) {
    const phase = midiEvent?.phase || 'press';
    const soundButtonElement = dom.soundboard.querySelector(`.sound-button[data-id="${soundId}"]`);
    if (!soundButtonElement) return;

    if (!state.audioContext) {
        if (!initAudioContext()) {
            console.warn('[MIDI] AudioContext init failed');
            return;
        }
    }
    await resumeAudioContext();
    if (state.audioContext.state !== 'running') {
        updateMidiAudioStatus('suspended');
        return;
    }

    const audioInfo = state.activeAudios[soundId];
    const isPlaying = Boolean(audioInfo) && !audioInfo.isFadingOut;

    if (mode === MIDI_PLAYBACK_MODE.GATE) {
        if (phase === 'press' && !isPlaying) {
            await playSound(soundId, soundButtonElement, midiEvent?.receivedAt ?? performance.now());
        } else if (phase === 'release' && Boolean(audioInfo)) {
            await stopSound(soundId, soundButtonElement, true);
        }
        return;
    }

    if (phase === 'release') return;

    if (mode === MIDI_PLAYBACK_MODE.ONESHOT) {
        if (!isPlaying) {
            await playSound(soundId, soundButtonElement, midiEvent?.receivedAt ?? performance.now());
        }
    } else if (mode === MIDI_PLAYBACK_MODE.RETRIGGER) {
        if (Boolean(audioInfo)) await stopSound(soundId, soundButtonElement, false);
        await playSound(soundId, soundButtonElement, midiEvent?.receivedAt ?? performance.now());
    } else { // TOGGLE
        if (isPlaying) {
            await stopSound(soundId, soundButtonElement, true);
        } else {
            await playSound(soundId, soundButtonElement, midiEvent?.receivedAt ?? performance.now());
        }
    }
}

async function selectAdjacentScene(direction) {
    const sceneIds = Object.values(state.scenes)
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
        .map(scene => scene.id);
    if (sceneIds.length === 0) return;

    const currentIndex = Math.max(0, sceneIds.indexOf(state.currentSceneId));
    const nextIndex = (currentIndex + direction + sceneIds.length) % sceneIds.length;
    await selectScene(sceneIds[nextIndex]);
}

function populateMidiSettingsUI() {
    if (!dom.midiSettingsPanel) return;

    const settings = normalizeMidiSettings(state.midiSettings);
    updateState({ midiSettings: settings });

    if (dom.midiStatusText) {
        const inputCount = getMidiInputOptions().filter(input => input.state !== 'disconnected').length;
        if (!state.midiEnabled) {
            dom.midiStatusText.textContent = '未有効化。ヘッダーのMIDIボタンで権限取得とAudio有効化を行ってください。';
        } else if (inputCount === 0) {
            dom.midiStatusText.textContent = 'MIDIは有効ですが入力がありません。DAWの出力先にIAC/loopMIDIなどの仮想ポートを選んでください。';
        } else {
            dom.midiStatusText.textContent = `MIDI入力 ${inputCount} 件。Learnまたは固定グリッドで操作できます。`;
        }
    }

    if (dom.midiDeviceSelect) {
        const inputs = getMidiInputOptions();
        dom.midiDeviceSelect.innerHTML = '<option value="all">すべての入力</option>';
        inputs.forEach(input => {
            const option = document.createElement('option');
            option.value = input.id;
            option.textContent = `${input.name}${input.manufacturer ? ` (${input.manufacturer})` : ''}${input.state === 'disconnected' ? ' - 切断' : ''}`;
            option.dataset.name = input.name;
            dom.midiDeviceSelect.appendChild(option);
        });
        dom.midiDeviceSelect.value = inputs.some(input => input.id === settings.deviceId) ? settings.deviceId : 'all';
    }

    if (dom.midiChannelSelect) {
        dom.midiChannelSelect.innerHTML = '<option value="all">すべて</option>';
        for (let i = 0; i < 16; i++) {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = `Ch ${i + 1}`;
            dom.midiChannelSelect.appendChild(option);
        }
        dom.midiChannelSelect.value = String(settings.channel);
    }

    if (dom.midiFixedGridCheckbox) dom.midiFixedGridCheckbox.checked = settings.fixedGridEnabled;
    if (dom.midiBaseNoteInput) dom.midiBaseNoteInput.value = settings.baseNote;

    updateMidiGlobalActionLabels();
}

async function handleMidiSettingsChange() {
    const selectedDeviceOption = dom.midiDeviceSelect?.selectedOptions?.[0];
    const nextSettings = normalizeMidiSettings({
        ...state.midiSettings,
        deviceId: dom.midiDeviceSelect?.value || 'all',
        deviceName: selectedDeviceOption?.dataset?.name || '',
        channel: dom.midiChannelSelect?.value === 'all' ? 'all' : Number(dom.midiChannelSelect.value),
        fixedGridEnabled: Boolean(dom.midiFixedGridCheckbox?.checked),
        baseNote: Math.max(0, Math.min(127, Number(dom.midiBaseNoteInput?.value ?? 36)))
    });
    updateState({ midiSettings: nextSettings });
    await saveSetting('midiSettings', nextSettings);
    updateMidiButtonState();
    populateMidiSettingsUI();
}

async function handleMidiGlobalActionClick(event) {
    const button = event.target.closest('button[data-midi-action]');
    if (!button) return;

    const actionType = button.dataset.midiAction;
    const operation = button.dataset.operation;

    if (operation === 'clear') {
        const nextSettings = normalizeMidiSettings(state.midiSettings);
        nextSettings.globalMappings[actionType] = null;
        updateState({ midiSettings: nextSettings });
        await saveSetting('midiSettings', nextSettings);
        updateMidiGlobalActionLabels();
        return;
    }

    try {
        if (!state.midiEnabled) await handleMidiEnableClick();
        dom.midiStatusText.textContent = `${MIDI_GLOBAL_ACTION_LABELS[actionType] || actionType} に割り当てるMIDI入力を送ってください。`;
        const learned = await beginMidiLearn({ type: 'global', actionType });
        if (!learned?.binding) {
            populateMidiSettingsUI();
            return;
        }
        const nextSettings = normalizeMidiSettings(state.midiSettings);
        nextSettings.globalMappings[actionType] = learned.binding;
        updateState({ midiSettings: nextSettings });
        await saveSetting('midiSettings', nextSettings);
        populateMidiSettingsUI();
    } catch (err) {
        showAlert(err.message || 'MIDI Learnを開始できませんでした。', 'MIDI');
        populateMidiSettingsUI();
    }
}

function updateMidiGlobalActionLabels() {
    if (!dom.midiGlobalActions) return;
    const settings = normalizeMidiSettings(state.midiSettings);
    dom.midiGlobalActions.querySelectorAll('[data-midi-binding-label]').forEach(label => {
        const actionType = label.dataset.midiBindingLabel;
        label.textContent = formatMidiBinding(settings.globalMappings[actionType]);
    });
}

function renderMidiGlobalActions() {
    if (!dom.midiGlobalActions) return;
    const actions = [
        MIDI_GLOBAL_ACTIONS.STOP_ALL,
        MIDI_GLOBAL_ACTIONS.FADE_ALL,
        MIDI_GLOBAL_ACTIONS.PANIC,
        MIDI_GLOBAL_ACTIONS.SCENE_PREV,
        MIDI_GLOBAL_ACTIONS.SCENE_NEXT
    ];
    dom.midiGlobalActions.innerHTML = actions.map(actionType => `
        <div class="midi-global-action-row">
            <span>${MIDI_GLOBAL_ACTION_LABELS[actionType] || actionType}</span>
            <code data-midi-binding-label="${actionType}">${formatMidiBinding(state.midiSettings.globalMappings?.[actionType])}</code>
            <button type="button" data-operation="learn" data-midi-action="${actionType}">Learn</button>
            <button type="button" data-operation="clear" data-midi-action="${actionType}">Clear</button>
        </div>
    `).join('');
    updateMidiGlobalActionLabels();
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
    renderMidiGlobalActions();
    populateMidiSettingsUI();
    dom.sceneSettingsModal.classList.add('active');
}
function closeSceneSettingsModal() {
    cancelMidiLearn();
    dom.sceneSettingsModal.classList.remove('active');
}
async function handleModalAddScene() {
    const sceneName = await showPrompt(`新しいシーンの名前:`, `新しいシーン`, `Scene ${Object.keys(state.scenes).length + 1}`);
    if (sceneName?.trim()) {
        const newSceneId = generateUniqueId('scn');
        const newSceneData = { id: newSceneId, name: sceneName.trim(), sounds: [] };
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
            const h1 = document.querySelector('header h1');
            if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"></i> ${escapeHtml(scene.name)}`;
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
        else if (action === 'delete') handleModalDeleteScene(sceneId);
        else if (action === 'export') exportSceneAsZip(sceneId);
    } else {
        if (sceneId !== state.currentSceneId) selectScene(sceneId);
        closeSceneSettingsModal();
    }
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

    const newSettings = await showSoundSettingsModal(soundId, currentShortcut);

    if (newSettings !== null) { // User clicked Save or cleared
        const { newShortcut, newFadeDuration, newEffects, newMidi } = newSettings;

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

        // Update fade duration
        sound.fadeDuration = newFadeDuration;
        sound.effects = newEffects;
        sound.midi = newMidi ?? sound.midi ?? { binding: null, mode: MIDI_PLAYBACK_MODE.TOGGLE };
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

    const normalizedKey = normalizeKey(event);
    const soundId = state.shortcuts[normalizedKey];

    if (soundId) {
        event.preventDefault();
        const soundButtonElement = dom.soundboard.querySelector(`.sound-button[data-id="${soundId}"]`);
        if (soundButtonElement) {
            handleSoundButtonClick(soundId, soundButtonElement);
        }
    }
}

// --- Sound Button and Board Handlers ---

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

    if (audioInfo.audioElement) {
        audioInfo.audioElement.currentTime = seekTime;
        // Update startTime for waveform calculation in low-memory mode
        audioInfo.startTime = state.audioContext.currentTime - seekTime;
    } else if (audioInfo.audioBuffer) {
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
    const midiLabel = sound.midi?.binding ? `<span class="midi-indicator" title="MIDI: ${formatMidiBinding(sound.midi.binding)} / ${sound.midi.mode || MIDI_PLAYBACK_MODE.TOGGLE}">MIDI</span>` : '';

    buttonWrapper.innerHTML = `
        <span class="loop-indicator">LOOP</span>
        ${midiLabel}
        <div class="button-content">
            <i class="fas fa-play sound-icon"></i>
            <span class="sound-name">${escapeHtml(sound.name)}</span>
            <div class="time-display">${durationText}</div>
        </div>
        <div class="button-controls">
            <button class="loop-button fas fa-sync-alt ${sound.loop ? 'active' : ''}" title="ループ切り替え"></button>
            <div class="volume-control">
                <input type="range" min="0" max="1" step="0.01" value="${sound.volume ?? 1.0}" title="音量: ${Math.round((sound.volume ?? 1.0) * 100)}%">
            </div>
        </div>
        <div class="progress-bar"><div class="progress-bar-value"></div></div>
        <button class="delete-button" title="削除"><i class="fas fa-times"></i></button>
        <button class="settings-button" title="設定">${settingsButtonContent}</button>
    `;
    
    let touchFlag = false;
    let pointerFlag = false;
    const setTouchFlag = () => { touchFlag = true; setTimeout(() => touchFlag = false, 150); };
    const setPointerFlag = () => { pointerFlag = true; setTimeout(() => pointerFlag = false, 150); };

    const buttonContent = buttonWrapper.querySelector('.button-content');
    buttonContent.addEventListener('pointerdown', e => {
        if (!state.isSortableEnabled && e.pointerType === 'mouse' && e.button === 0 && !isDraggingViaTouch) {
            e.preventDefault();
            handleSoundButtonClick(sound.id, buttonWrapper);
            setPointerFlag();
        }
    });
    buttonContent.addEventListener('touchend', e => { if (!isDraggingViaTouch) { e.preventDefault(); handleSoundButtonClick(sound.id, buttonWrapper); setTouchFlag(); } clearTimeout(longPressTimeoutId); }, { passive: false });
    buttonContent.addEventListener('click', () => { if (!touchFlag && !pointerFlag && !isDraggingViaTouch) handleSoundButtonClick(sound.id, buttonWrapper); });

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

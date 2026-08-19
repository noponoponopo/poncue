// modules/03_state.js

import { DEFAULT_PERFORMANCE_MODE, DEFAULT_KEYBOARD_LAYOUT } from './01_config.js';

// --- Application State ---
export const state = {
    // Scene and Sound Data
    scenes: {},
    currentSceneId: null,
    
    // Audio related state
    audioContext: null,
    masterInputNode: null,
    masterGainNode: null,
    outputLimiterNode: null,
    outputSafetyLimiterNode: null,
    recordingDestinationNode: null,
    masterAnalyserL: null,
    masterAnalyserR: null,
    masterMeterDataL: null,
    masterMeterDataR: null,
    masterMeterFrameId: null,
    masterPeakL: 0,
    masterPeakR: 0,
    masterEqNode: null,
    masterEq: { low: 0, mid: 0, high: 0 },
    masterCompNode: null,
    masterComp: { threshold: 0, ratio: 1 },
    masterDelayNode: null,
    masterDelayReturn: null,
    masterDelay: { time: 0.18, feedback: 0, level: 0 },
    masterPanNode: null,
    masterPan: { value: 0 },
    masterDistortionNode: null,
    masterDistortion: { amount: 0 },
    masterReverbNode: null,
    masterReverb: { decay: 2.0, wet: 0 },
    masterLimiter: { threshold: -1 },
    activeAudios: {}, // { audioElement, sourceNode, ... }
    pausedSounds: {}, // { [soundId]: { position, pausedAt, layers } }
    sustainLayers: {}, // { [soundId]: [layer, ...] } sustainモードの重ね再生ボイス（メーター等のUIは持たない）
    decodedAudioBuffers: {}, // { soundId: AudioBuffer }
    reversedAudioBuffers: {}, // { soundId: AudioBuffer } 逆再生用の反転バッファキャッシュ
    waveformPeaksCache: {}, // { soundId: { buffer, peaks } } 波形描画用ピークのキャッシュ（本体とレイヤーで共用）
    audioStartMetrics: [],
    
    // UI and Settings State
    masterVolume: 1.0,
    audioOutputDeviceId: 'default',
    audioOutputDeviceLabel: 'システム既定',
    audioOutputPending: false,
    modalSelectedSceneId: null,
    showErrorPopups: true,
    isSortableEnabled: false,
    showWaveform: true,
    padSize: 160, // New setting for pad size
    performanceMode: DEFAULT_PERFORMANCE_MODE, // 'ultra-high-performance', 'high-performance' or 'low-memory'
    showMode: false,
    keyboardViewVisible: false,
    keyboardLayout: DEFAULT_KEYBOARD_LAYOUT, // 'us' or 'jis' (11_keyboard_view.js の LAYOUTS と対応)
    isOptHeld: false, // Option(Alt) キー押下中: 全モードで停止系の操作を一時停止に切替。Mac=Option、Windows/Linux=Alt

    // DB instance
    db: null,

    // Waveform rendering state
    isWaveformLoopRunning: false,
    waveformAnimationFrameId: null,
    
    // Drag & Drop State
    draggedElement: null,
    draggedSoundId: null,
    isDraggingViaTouch: false,
    draggedElementTouch: null,
    draggedSoundIdTouch: null,
    ghostElement: null,
    touchStartX: 0,
    touchStartY: 0,
    ghostOffsetX: 0,
    ghostOffsetY: 0,
    longPressTimeoutId: null,
    touchMoveOccurred: false,

    // Custom Modal Promise
    confirmResolve: null,

    // Shortcuts for the current scene
    shortcuts: {},
};

// --- State Modifiers ---
// It's good practice to use functions to modify state
// to easily track changes in the future.

export function setAudioContext(context, gainNode, limiterNode = null, inputNode = null) {
    state.audioContext = context;
    state.masterInputNode = inputNode;
    state.masterGainNode = gainNode;
    state.outputLimiterNode = limiterNode;
}

export function setDb(dbInstance) {
    state.db = dbInstance;
}

export function updateState(newState) {
    Object.assign(state, newState);
}

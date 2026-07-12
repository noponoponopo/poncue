// modules/03_state.js

import { DEFAULT_PERFORMANCE_MODE } from './01_config.js';

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
    decodedAudioBuffers: {}, // { soundId: AudioBuffer }
    reversedAudioBuffers: {}, // { soundId: AudioBuffer } 逆再生用の反転バッファキャッシュ
    audioStartMetrics: [],
    
    // UI and Settings State
    masterVolume: 1.0,
    modalSelectedSceneId: null,
    showErrorPopups: true,
    isSortableEnabled: false,
    showWaveform: true,
    padSize: 160, // New setting for pad size
    performanceMode: DEFAULT_PERFORMANCE_MODE, // 'ultra-high-performance', 'high-performance' or 'low-memory'
    showMode: false,
    
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

    // Shortcuts
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

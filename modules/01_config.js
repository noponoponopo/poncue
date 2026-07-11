// modules/01_config.js

export const DB_NAME = 'ponndashiDB_v2'; // Changed DB Name to force fresh start for users with old incompatible DB
export const DB_VERSION = 2; // Incremented for schema change

export const SCENES_STORE_NAME = 'scenes';
export const AUDIO_FILES_STORE_NAME = 'audio_files';
export const SETTINGS_STORE_NAME = 'settings';

export const MAX_FILE_SIZE_MB = 512;
export const LONG_PRESS_DURATION = 300;

export const ANALYSER_FFT_SIZE = 256;
export const WAVEFORM_SECONDS_AHEAD = 5;
export const WAVEFORM_DOWNSAMPLE = 10;
export const AUDIO_PARAM_RAMP_SECONDS = 0.01;
export const MIN_GAIN_RAMP_SECONDS = 0.005;
export const MIN_STOP_FADE_SECONDS = 0.015;

// フェードカーブの種別。applyFadeCurve (06_audio.js) の FADE_EASING_FUNCTIONS と対応。
export const FADE_EASING_TYPES = ['linear', 'easeIn', 'easeOut', 'sCurve'];
export const DEFAULT_FADE_EASING = 'linear';
export const WAVEFORM_COLORS_LIGHT = ['rgba(0, 123, 255, 0.6)', 'rgba(23, 162, 184, 0.6)', 'rgba(40, 167, 69, 0.6)', 'rgba(255, 193, 7, 0.6)', 'rgba(220, 53, 69, 0.6)', 'rgba(108, 117, 125, 0.6)'];
export const WAVEFORM_COLORS_DARK = ['rgba(77, 171, 247, 0.6)', 'rgba(32, 201, 151, 0.6)', 'rgba(52, 199, 89, 0.6)', 'rgba(255, 204, 0, 0.6)', 'rgba(233, 69, 96, 0.6)', 'rgba(173, 181, 189, 0.6)'];

export const PERFORMANCE_MODE = {
    HIGH_PERFORMANCE: 'high-performance',
    LOW_MEMORY: 'low-memory'
};
export const DEFAULT_PERFORMANCE_MODE = PERFORMANCE_MODE.HIGH_PERFORMANCE;

export const DEFAULT_EFFECT_SETTINGS = {
    enabled: false,
    wet: 0.35,
    eq: {
        enabled: false,
        low: 0,
        mid: 0,
        high: 0,
        lowFrequency: 400,
        highFrequency: 2500
    },
    delay: {
        enabled: false,
        time: 0.18,
        feedback: 0.25,
        level: 0.25
    },
    compressor: {
        enabled: false,
        threshold: -18,
        ratio: 3
    },
    distortion: {
        enabled: false,
        amount: 0.4
    },
    reverb: {
        enabled: false,
        decay: 2.0,
        preDelay: 0.01,
        wet: 0.35
    }
};

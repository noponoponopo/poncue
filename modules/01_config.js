// modules/01_config.js

export const DB_NAME = 'ponndashiDB_v2'; // Changed DB Name to force fresh start for users with old incompatible DB
export const DB_VERSION = 2; // Incremented for schema change

export const SCENES_STORE_NAME = 'scenes';
export const AUDIO_FILES_STORE_NAME = 'audio_files';
export const SETTINGS_STORE_NAME = 'settings';

export const MAX_FILE_SIZE_MB = 512;
export const LONG_PRESS_DURATION = 300;

// サウンドの起動モード（Soundplant の keymode 相当）。
// toggle=クリックで再生/停止、momentary=押している間だけ再生、retrigger=常に頭出し再生、
// sustain=再生中に再押で重ねて再生、pause=再クリックで一時停止/再開、mute=再クリックで消音切替。
// pauseHold/muteHold は pause/mute のホールド版（離した時に一時停止/消音）。
// roll=可変長ドラムロール（type:'roll' のサウンド専用）。
// なお Soundplant の fade/fade-hold は音源ごとのフェードイン/アウト設定＋toggleで同等になる。
export const TRIGGER_MODES = ['toggle', 'momentary', 'retrigger', 'sustain', 'pause', 'pauseHold', 'mute', 'muteHold', 'roll'];
export const DEFAULT_TRIGGER_MODE = 'toggle';
// 押下開始・離上で動作するモード（momentary 系）。
export const HOLD_TRIGGER_MODES = ['momentary', 'pauseHold', 'muteHold', 'roll'];

// ドラムロール: 起こり→ループ(複数パートを登録順に循環)→終わり→締め の4パート構成。
// ループのみ必須（1つ以上）。それ以外は任意で、無いパートは飛ばして遷移する。
// パート継ぎ目のクリックノイズ防止用の微小クロスフェード時間（秒）と、
// チェーン先読みスケジューラのポーリング間隔・先読み時間。
export const ROLL_CROSSFADE_SECONDS = 0.005;
export const ROLL_SCHEDULER_INTERVAL_MS = 100;
export const ROLL_SCHEDULER_LOOKAHEAD_SECONDS = 0.5;

// ミュート切替時のゲインフェード時間（秒）。
export const MUTE_FADE_SECONDS = 0.05;

// キーボードビューの配列。state.keyboardLayout と 11_keyboard_view.js の LAYOUTS のキーと対応。
export const KEYBOARD_LAYOUTS = ['us', 'jis', 'mac-jis', 'mac-us', 'dvorak'];
export const DEFAULT_KEYBOARD_LAYOUT = 'us';

// ショートカット操作時にブラウザ既定動作（ページスクロール、フォーカス中ボタンの活性クリック等）
// を一律で抑制するキー。Space はサウンド未割当でもスクロールを防ぐためここに含める。
export const SCROLL_PREVENT_KEYS = new Set(['Space', 'PageUp', 'PageDown', 'Home', 'End', 'Left', 'Down', 'Up', 'Right']);

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
    },
    limiter: {
        enabled: false,
        threshold: -1
    }
};

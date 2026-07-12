// modules/05_ui.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { saveSetting } from './07_scenes.js';
import { normalizeEffectSettings } from './09_effects.js';
import { FADE_EASING_TYPES, TRIGGER_MODES } from './01_config.js';
import { formatTimecode } from './11_timecode.js';

const TRIGGER_LABELS = { toggle: 'トグル', momentary: 'ホールド', retrigger: 'リトリガー' };
function triggerOptions(selected) {
    return TRIGGER_MODES
        .map(mode => `<option value="${mode}"${mode === selected ? ' selected' : ''}>${TRIGGER_LABELS[mode] ?? mode}</option>`)
        .join('');
}

// フェードイージングの表示ラベル（type リストは 01_config.js の FADE_EASING_TYPES と同期）
const EASING_LABELS = { linear: '直線', easeIn: 'イーズイン', easeOut: 'イーズアウト', sCurve: 'イーズインアウト' };
function easingOptions(selected) {
    return FADE_EASING_TYPES
        .map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${EASING_LABELS[t] ?? t}</option>`)
        .join('');
}

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- Custom Modal ---
export function showModal(title, message, type = 'showAlert', inputPlaceholder = '', inputDefaultValue = '') {
    return new Promise(resolve => {
        if (!dom.customModalOverlay) {
            window.alert(`[${title}]\n${message}`); // Fallback to native alert
            resolve(null); // Resolve with null for fallback
            return;
        }

        dom.customModalTitle.textContent = title;
        dom.customModalMessage.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');

        // Clear previous input if any
        const existingInput = dom.customModalBody.querySelector('input');
        if (existingInput) {
            existingInput.remove();
        }

        let inputElement = null;
        if (type === 'showPrompt') {
            inputElement = document.createElement('input');
            inputElement.type = 'text';
            inputElement.placeholder = inputPlaceholder;
            inputElement.value = inputDefaultValue;
            inputElement.classList.add('modal-input'); // Add a class for styling
            dom.customModalBody.appendChild(inputElement);
            dom.customModalOkBtn.textContent = 'OK';
            dom.customModalCancelBtn.style.display = 'inline-block';
        } else if (type === 'showAlert') {
            dom.customModalOkBtn.textContent = 'OK';
            dom.customModalCancelBtn.style.display = 'none';
        } else { // confirm
            dom.customModalOkBtn.textContent = 'OK';
            dom.customModalCancelBtn.style.display = 'inline-block';
        }

        // Remove previous listeners to prevent multiple calls
        dom.customModalOkBtn.onclick = null;
        dom.customModalCancelBtn.onclick = null;

        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            updateState({ confirmResolve: null });
            dom.customModalOverlay.classList.remove('active');
            resolve(value);
        };
        updateState({ confirmResolve: value => finish(type === 'showPrompt' ? null : value) });

        dom.customModalOkBtn.onclick = () => {
            if (type === 'showPrompt') {
                finish(inputElement ? inputElement.value : null);
            } else {
                finish(true);
            }
        };

        dom.customModalCancelBtn.onclick = () => {
            finish(false);
        };

        dom.customModalOverlay.classList.add('active');
        if (inputElement) {
            inputElement.focus();
            inputElement.select(); // Select text for easy editing
        }
    });
}

export function hideModal() {
    if (!dom.customModalOverlay) return;
    dom.customModalOverlay.classList.remove('active');
    if (state.confirmResolve) {
        updateState({ confirmResolve: null });
    }
}

export async function showAlert(message, title = '通知') {
    if (!state.showErrorPopups && (title.toLowerCase().includes('error') || title.toLowerCase().includes('エラー'))) {
        console.warn(`[showAlert suppressed] ${title}: ${message}`);
        return;
    }
    await showModal(title, message, 'showAlert');
}

export async function showConfirm(message, title = '確認') {
    return await showModal(title, message, 'confirm');
}

export async function showPrompt(message, title = '入力', defaultValue = '') {
    return await showModal(title, message, 'showPrompt', '', defaultValue);
}

export function formatPanValue(v) {
    const pct = Math.round(Math.abs(v) * 100);
    if (pct === 0) return 'C';
    return v < 0 ? `L${pct}` : `R${pct}`;
}

export async function showSoundSettingsModal(soundId, currentShortcut = '', callbacks = {}) {
    return new Promise(resolve => {
        if (!dom.customModalOverlay) {
            showAlert("設定モーダルを表示できません。", "エラー");
            resolve(null);
            return;
        }

        const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
        if (!sound) {
            showAlert("サウンドが見つかりません。", "エラー");
            resolve(null);
            return;
        }

        dom.customModalTitle.textContent = `${sound.name} の設定`;
        const effectSettings = normalizeEffectSettings(sound.effects);
        const triggerMode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
        const initialPan = Number.isFinite(sound.pan) ? sound.pan : 0;
        const fadeInDuration = Number.isFinite(sound.fadeInDuration) ? sound.fadeInDuration : 0;
        const fadeOutDuration = Number.isFinite(sound.fadeOutDuration) ? sound.fadeOutDuration : 0;
        const fadeInEasing = FADE_EASING_TYPES.includes(sound.fadeInEasing) ? sound.fadeInEasing : 'linear';
        const fadeOutEasing = FADE_EASING_TYPES.includes(sound.fadeOutEasing) ? sound.fadeOutEasing : 'linear';
        const initialColor = (typeof sound.color === 'string' && sound.color) ? sound.color : '#808080';
        const reverse = !!sound.reverse;
        const initialSpeed = Number.isFinite(sound.playbackRate) ? sound.playbackRate : 1;

        dom.customModalMessage.innerHTML = `
            <div class="effect-section">
                <div class="effect-param-row">
                    <label for="shortcut-input" class="effect-param-label">ショートカット</label>
                    <input type="text" id="shortcut-input" class="modal-input effect-text-input" readonly value="${currentShortcut}" placeholder="キーを押してください">
                </div>
                <div class="effect-param-row">
                    <label for="trigger-mode-input" class="effect-param-label">起動</label>
                    <select id="trigger-mode-input" class="modal-input effect-select">${triggerOptions(triggerMode)}</select>
                </div>
                <div class="effect-param-row">
                    <label for="pad-color-input" class="effect-param-label">カラー</label>
                    <input type="color" id="pad-color-input" class="modal-input effect-color-input" value="${initialColor}">
                    <button type="button" id="pad-color-clear-btn" class="modal-input effect-color-clear-btn">解除</button>
                </div>
                <div class="effect-knob-row">
                    <div class="effect-knob-slot" data-knob="fade-in"></div>
                    <div class="effect-knob-slot" data-knob="fade-out"></div>
                    <div class="effect-knob-slot" data-knob="pan"></div>
                    <div class="effect-knob-slot" data-knob="speed"></div>
                </div>
                <div class="easing-row">
                    <div class="easing-pair">
                        <label for="fade-in-easing-input" class="effect-param-label">イン カーブ</label>
                        <select id="fade-in-easing-input" class="modal-input effect-select">${easingOptions(fadeInEasing)}</select>
                    </div>
                    <div class="easing-pair">
                        <label for="fade-out-easing-input" class="effect-param-label">アウト カーブ</label>
                        <select id="fade-out-easing-input" class="modal-input effect-select">${easingOptions(fadeOutEasing)}</select>
                    </div>
                </div>
                <div class="effect-param-row">
                    <label for="reverse-input" class="effect-param-label">逆再生</label>
                    <input type="checkbox" id="reverse-input" ${reverse ? 'checked' : ''}>
                </div>
                <div class="effect-param-row effect-checkbox-row">
                    <span class="effect-param-label">ピッチ</span>
                    <label><input type="checkbox" id="preserve-pitch-input" ${sound.preservePitch ? 'checked' : ''}> 速度変更時も保持</label>
                </div>
                <div class="effect-action-row">
                    <div class="effect-knob-slot" data-knob="normalize-target"></div>
                    <button type="button" id="normalize-btn" class="modal-input effect-action-btn">LUFSノーマライズ</button>
                    <span id="normalize-result" class="effect-param-value" role="status"></span>
                </div>
            </div>
            <div class="effect-divider"></div>
            <div class="effect-section">
                <div class="effect-master-row">
                    <label class="effect-toggle"><input type="checkbox" id="effect-enabled-input" ${effectSettings.enabled ? 'checked' : ''}> エフェクト</label>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="wet"></div>
                    </div>
                </div>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="eq-enabled-input" ${effectSettings.eq.enabled ? 'checked' : ''}> 3バンドEQ</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="eq-low"></div>
                        <div class="effect-knob-slot" data-knob="eq-mid"></div>
                        <div class="effect-knob-slot" data-knob="eq-high"></div>
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="delay-enabled-input" ${effectSettings.delay.enabled ? 'checked' : ''}> ディレイ</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="delay-time"></div>
                        <div class="effect-knob-slot" data-knob="delay-feedback"></div>
                        <div class="effect-knob-slot" data-knob="delay-level"></div>
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="compressor-enabled-input" ${effectSettings.compressor.enabled ? 'checked' : ''}> コンプレッサー</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="comp-threshold"></div>
                        <div class="effect-knob-slot" data-knob="comp-ratio"></div>
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="distortion-enabled-input" ${effectSettings.distortion.enabled ? 'checked' : ''}> ディストーション</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="dist-amount"></div>
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="reverb-enabled-input" ${effectSettings.reverb.enabled ? 'checked' : ''}> リバーブ</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="reverb-decay"></div>
                        <div class="effect-knob-slot" data-knob="reverb-preDelay"></div>
                        <div class="effect-knob-slot" data-knob="reverb-wet"></div>
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="limiter-enabled-input" ${effectSettings.limiter.enabled ? 'checked' : ''}> リミッター</label></legend>
                    <div class="effect-knob-cluster">
                        <div class="effect-knob-slot" data-knob="limiter-threshold"></div>
                    </div>
                </fieldset>
            </div>
        `;

        // --- DOM 参照(トグル系・テキスト系) ---
        const shortcutInput = dom.customModalMessage.querySelector('#shortcut-input');
        const triggerModeInput = dom.customModalMessage.querySelector('#trigger-mode-input');
        const padColorInput = dom.customModalMessage.querySelector('#pad-color-input');
        const padColorClearBtn = dom.customModalMessage.querySelector('#pad-color-clear-btn');
        const fadeInEasingInput = dom.customModalMessage.querySelector('#fade-in-easing-input');
        const fadeOutEasingInput = dom.customModalMessage.querySelector('#fade-out-easing-input');
        const reverseInput = dom.customModalMessage.querySelector('#reverse-input');
        const preservePitchInput = dom.customModalMessage.querySelector('#preserve-pitch-input');
        const normalizeBtn = dom.customModalMessage.querySelector('#normalize-btn');
        const normalizeResult = dom.customModalMessage.querySelector('#normalize-result');
        const effectEnabledInput = dom.customModalMessage.querySelector('#effect-enabled-input');
        const eqEnabledInput = dom.customModalMessage.querySelector('#eq-enabled-input');
        const delayEnabledInput = dom.customModalMessage.querySelector('#delay-enabled-input');
        const compressorEnabledInput = dom.customModalMessage.querySelector('#compressor-enabled-input');
        const distortionEnabledInput = dom.customModalMessage.querySelector('#distortion-enabled-input');
        const reverbEnabledInput = dom.customModalMessage.querySelector('#reverb-enabled-input');
        const limiterEnabledInput = dom.customModalMessage.querySelector('#limiter-enabled-input');

        // --- ローカル状態 ---
        let newShortcut = currentShortcut;
        let newTriggerMode = triggerMode;
        let newColor = (typeof sound.color === 'string' && sound.color) ? sound.color : null;
        let newFadeInDuration = fadeInDuration;
        let newFadeOutDuration = fadeOutDuration;
        let newFadeInEasing = fadeInEasing;
        let newFadeOutEasing = fadeOutEasing;
        let newReverse = reverse;

        // --- Knob 生成ヘルパー ---
        const slot = key => dom.customModalMessage.querySelector(`[data-knob="${key}"]`);
        const mount = (key, knob) => { slot(key)?.appendChild(knob.element); };

        // 基本設定 knobs
        const fadeInKnob = createKnob({
            min: 0, max: 5, step: 0.01, default: 0, unit: 's', label: 'フェードイン',
            value: fadeInDuration, dragPixels: 600,
            onInput: v => { newFadeInDuration = v; }
        });
        mount('fade-in', fadeInKnob);

        const fadeOutKnob = createKnob({
            min: 0, max: 5, step: 0.01, default: 0, unit: 's', label: 'フェードアウト',
            value: fadeOutDuration, dragPixels: 600,
            onInput: v => { newFadeOutDuration = v; }
        });
        mount('fade-out', fadeOutKnob);

        const panKnob = createKnob({
            min: -1, max: 1, step: 0.01, default: 0, unit: 'pan', label: 'PAN',
            value: initialPan, dragPixels: 300
        });
        mount('pan', panKnob);

        const speedKnob = createKnob({
            min: 0.5, max: 2, step: 0.05, default: 1, unit: 'x', label: '速度',
            value: initialSpeed, dragPixels: 400
        });
        mount('speed', speedKnob);

        const normalizeTargetKnob = createKnob({
            min: -24, max: -9, step: 1, default: -18, unit: 'LUFS', label: '目標ラウドネス',
            value: -18, dragPixels: 200
        });
        mount('normalize-target', normalizeTargetKnob);

        // エフェクト knobs
        const wetKnob = createKnob({
            min: 0, max: 1, step: 0.01, default: 1, unit: '%', label: 'DRY/WET',
            value: effectSettings.wet
        });
        mount('wet', wetKnob);

        const eqLowKnob = createKnob({
            min: -12, max: 12, step: 0.5, default: 0, unit: 'dB', label: 'LOW',
            value: effectSettings.eq.low
        });
        mount('eq-low', eqLowKnob);

        const eqMidKnob = createKnob({
            min: -12, max: 12, step: 0.5, default: 0, unit: 'dB', label: 'MID',
            value: effectSettings.eq.mid
        });
        mount('eq-mid', eqMidKnob);

        const eqHighKnob = createKnob({
            min: -12, max: 12, step: 0.5, default: 0, unit: 'dB', label: 'HIGH',
            value: effectSettings.eq.high
        });
        mount('eq-high', eqHighKnob);

        const delayTimeKnob = createKnob({
            min: 0, max: 2, step: 0.01, default: 0.18, unit: 's', label: 'TIME',
            value: effectSettings.delay.time, dragPixels: 600
        });
        mount('delay-time', delayTimeKnob);

        const delayFeedbackKnob = createKnob({
            min: 0, max: 0.85, step: 0.01, default: 0, unit: '%', label: 'FBK',
            value: effectSettings.delay.feedback
        });
        mount('delay-feedback', delayFeedbackKnob);

        const delayLevelKnob = createKnob({
            min: 0, max: 1, step: 0.01, default: 0, unit: '%', label: 'LEVEL',
            value: effectSettings.delay.level
        });
        mount('delay-level', delayLevelKnob);

        const compThresholdKnob = createKnob({
            min: -60, max: 0, step: 1, default: 0, unit: 'dB', label: 'THRESH',
            value: effectSettings.compressor.threshold
        });
        mount('comp-threshold', compThresholdKnob);

        const compRatioKnob = createKnob({
            min: 1, max: 20, step: 0.5, default: 1, unit: ':1', label: 'RATIO',
            value: effectSettings.compressor.ratio
        });
        mount('comp-ratio', compRatioKnob);

        const distAmountKnob = createKnob({
            min: 0, max: 1, step: 0.01, default: 0, unit: '%', label: 'AMOUNT',
            value: effectSettings.distortion.amount
        });
        mount('dist-amount', distAmountKnob);

        const reverbDecayKnob = createKnob({
            min: 0.1, max: 10, step: 0.1, default: 2.0, unit: 's', label: 'DECAY',
            value: effectSettings.reverb.decay, dragPixels: 600
        });
        mount('reverb-decay', reverbDecayKnob);

        const reverbPreDelayKnob = createKnob({
            min: 0, max: 0.1, step: 0.001, default: 0.01, unit: 'ms', label: 'PRE',
            value: effectSettings.reverb.preDelay, dragPixels: 200
        });
        mount('reverb-preDelay', reverbPreDelayKnob);

        const reverbWetKnob = createKnob({
            min: 0, max: 1, step: 0.01, default: 0, unit: '%', label: 'WET',
            value: effectSettings.reverb.wet
        });
        mount('reverb-wet', reverbWetKnob);

        const limiterThresholdKnob = createKnob({
            min: -12, max: 0, step: 0.5, default: -1, unit: 'dBFS', label: 'CEILING',
            value: effectSettings.limiter.threshold
        });
        mount('limiter-threshold', limiterThresholdKnob);

        // --- ハンドラ(テキスト・トグル系) ---
        const handleKeydown = (e) => {
            e.preventDefault();
            if (e.key === 'Backspace' || e.key === 'Delete') {
                newShortcut = '';
                shortcutInput.value = '';
                return;
            }
            const modifiers = [];
            if (e.ctrlKey) modifiers.push('Control');
            if (e.altKey) modifiers.push('Alt');
            if (e.shiftKey) modifiers.push('Shift');
            if (e.metaKey) modifiers.push('Meta');
            let key = e.key;
            if (key === ' ') key = 'Space';
            if (modifiers.includes(key)) key = '';
            const displayKey = key.length === 1 ? key.toUpperCase() : key;
            newShortcut = [...modifiers, displayKey].filter(Boolean).join('+');
            shortcutInput.value = newShortcut;
        };

        const handlePadColorInput = (e) => { newColor = e.target.value; };
        const handlePadColorClear = () => {
            newColor = null;
            padColorInput.value = '#808080';
        };
        const handleFadeInEasingInput = (e) => { newFadeInEasing = e.target.value; };
        const handleFadeOutEasingInput = (e) => { newFadeOutEasing = e.target.value; };
        const handleReverseInput = (e) => { newReverse = e.target.checked; };
        const handleTriggerModeInput = (e) => { newTriggerMode = e.target.value; };

        const handleNormalize = async () => {
            normalizeBtn.disabled = true;
            normalizeResult.textContent = '解析中...';
            try {
                const result = await callbacks.onNormalize?.(normalizeTargetKnob.getValue());
                normalizeResult.textContent = result
                    ? `検出 ${result.measuredLufs.toFixed(1)} LUFS / 適用 ${result.achievedLufs.toFixed(1)} LUFS${result.limitedByPeak ? '（ピーク制約）' : ''} / 音量 ${Math.round(result.recommendedVolume * 100)}%`
                    : 'ノーマライズできませんでした';
            } finally {
                normalizeBtn.disabled = false;
            }
        };

        // --- 保存時にknob値から最終エフェクト設定を構築 ---
        const buildEffects = () => normalizeEffectSettings({
            enabled: effectEnabledInput.checked,
            wet: wetKnob.getValue(),
            eq: { enabled: eqEnabledInput.checked, low: eqLowKnob.getValue(), mid: eqMidKnob.getValue(), high: eqHighKnob.getValue() },
            delay: { enabled: delayEnabledInput.checked, time: delayTimeKnob.getValue(), feedback: delayFeedbackKnob.getValue(), level: delayLevelKnob.getValue() },
            compressor: { enabled: compressorEnabledInput.checked, threshold: compThresholdKnob.getValue(), ratio: compRatioKnob.getValue() },
            distortion: { enabled: distortionEnabledInput.checked, amount: distAmountKnob.getValue() },
            reverb: { enabled: reverbEnabledInput.checked, decay: reverbDecayKnob.getValue(), preDelay: reverbPreDelayKnob.getValue(), wet: reverbWetKnob.getValue() },
            limiter: { enabled: limiterEnabledInput.checked, threshold: limiterThresholdKnob.getValue() }
        });

        // --- 親エフェクトトグル連動 ---
        // 親(effect-enabled)がoffの時、内側のDRY/WET knobと各エフェクトグループを無効化
        // 音響ロジックは 09_effects.js 側でもガードしているが、UIでも視覚的に伝える
        const effectSection = dom.customModalMessage.querySelectorAll('.effect-section')[1];
        const updateEffectSectionState = () => {
            effectSection?.classList.toggle('is-inactive', !effectEnabledInput.checked);
        };
        updateEffectSectionState();

        // --- イベント登録 ---
        shortcutInput.addEventListener('keydown', handleKeydown);
        triggerModeInput.addEventListener('change', handleTriggerModeInput);
        padColorInput.addEventListener('input', handlePadColorInput);
        padColorClearBtn.addEventListener('click', handlePadColorClear);
        fadeInEasingInput.addEventListener('change', handleFadeInEasingInput);
        fadeOutEasingInput.addEventListener('change', handleFadeOutEasingInput);
        reverseInput.addEventListener('change', handleReverseInput);
        normalizeBtn.addEventListener('click', handleNormalize);
        effectEnabledInput.addEventListener('change', updateEffectSectionState);

        dom.customModalOkBtn.textContent = '保存';
        dom.customModalCancelBtn.textContent = 'キャンセル';
        dom.customModalCancelBtn.style.display = 'inline-block';

        const cleanup = () => {
            shortcutInput.removeEventListener('keydown', handleKeydown);
            triggerModeInput.removeEventListener('change', handleTriggerModeInput);
            padColorInput.removeEventListener('input', handlePadColorInput);
            padColorClearBtn.removeEventListener('click', handlePadColorClear);
            fadeInEasingInput.removeEventListener('change', handleFadeInEasingInput);
            fadeOutEasingInput.removeEventListener('change', handleFadeOutEasingInput);
            reverseInput.removeEventListener('change', handleReverseInput);
            normalizeBtn.removeEventListener('click', handleNormalize);
            effectEnabledInput.removeEventListener('change', updateEffectSectionState);
        };

        dom.customModalOkBtn.onclick = () => {
            cleanup();
            dom.customModalOverlay.classList.remove('active');
            resolve({
                newShortcut, newTriggerMode, newColor,
                newFadeInDuration, newFadeOutDuration, newFadeInEasing, newFadeOutEasing,
                newPan: panKnob.getValue(),
                newReverse,
                newPlaybackSpeed: speedKnob.getValue(),
                preservePitch: preservePitchInput.checked,
                newEffects: buildEffects()
            });
        };

        dom.customModalCancelBtn.onclick = () => {
            cleanup();
            dom.customModalOverlay.classList.remove('active');
            resolve(null);
        };

        dom.customModalOverlay.classList.add('active');
        shortcutInput.focus();
    });
}

// --- Dark Mode ---
export function initDarkMode() {
    const savedMode = localStorage.getItem('darkModePref') || 'system';
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const body = document.body;
    body.style.transition = 'none';
    let applyDarkMode = (savedMode === 'enabled') || (savedMode === 'system' && prefersDark);
    body.classList.toggle('dark-mode', applyDarkMode);
    if (dom.darkModeToggle) {
        dom.darkModeToggle.checked = applyDarkMode;
    }
    console.log(`Initializing dark mode. Saved: ${savedMode}, Prefers: ${prefersDark}, Applied: ${applyDarkMode}`);
    requestAnimationFrame(() => {
        setTimeout(() => {
            body.style.transition = 'background-color var(--transition-speed), color var(--transition-speed)';
        }, 50);
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        const currentPref = localStorage.getItem('darkModePref') || 'system';
        if (currentPref === 'system') {
            const osPrefersDark = e.matches;
            body.classList.toggle('dark-mode', osPrefersDark);
            if (dom.darkModeToggle) { dom.darkModeToggle.checked = osPrefersDark; }
            console.log(`OS color scheme changed. Applying dark mode: ${osPrefersDark}`);
            setupCanvasResize();
        }
    });
    setupCanvasResize();
}

export function toggleDarkMode() {
    const body = document.body;
    const isCurrentlyDark = body.classList.toggle('dark-mode');
    const newModePreference = isCurrentlyDark ? 'enabled' : 'disabled';
    saveSetting('darkMode', newModePreference);
    console.log(`Dark mode toggled by user. New preference: ${newModePreference}`);
    setupCanvasResize();
}


// --- Canvas and Meters ---
export function setupCanvasResize() {
    if (!dom.waveformCanvas || !dom.waveformDisplayArea || !dom.waveformCtx) {
        console.warn("Canvas elements not ready for resize setup.");
        return;
    }
    const displayAreaWidth = dom.waveformDisplayArea.clientWidth;
    const displayAreaHeight = dom.waveformDisplayArea.clientHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;
    dom.waveformCanvas.width = displayAreaWidth * devicePixelRatio;
    dom.waveformCanvas.height = displayAreaHeight * devicePixelRatio;
    dom.waveformCanvas.style.width = `${displayAreaWidth}px`;
    dom.waveformCanvas.style.height = `${displayAreaHeight}px`;
    dom.waveformCtx.scale(devicePixelRatio, devicePixelRatio);
    // Needs a function from audio.js, will be called from there
    // triggerWaveformUpdate(); 
}

export function createMeterElement(soundId, soundName) {
    if (!dom.levelMeterArea) return;
    removeMeterElement(soundId);
    const meterPair = document.createElement('div');
    meterPair.classList.add('meter-pair');
    meterPair.dataset.soundId = soundId;
    const barsContainer = document.createElement('div');
    barsContainer.classList.add('meter-bars-container');
    const leftBar = document.createElement('div');
    leftBar.classList.add('meter-bar', 'left');
    const leftValue = document.createElement('div');
    leftValue.classList.add('meter-value');
    leftBar.appendChild(leftValue);
    const leftPeak = document.createElement('div');
    leftPeak.classList.add('meter-peak');
    leftBar.appendChild(leftPeak);
    const rightBar = document.createElement('div');
    rightBar.classList.add('meter-bar', 'right');
    const rightValue = document.createElement('div');
    rightValue.classList.add('meter-value');
    rightBar.appendChild(rightValue);
    const rightPeak = document.createElement('div');
    rightPeak.classList.add('meter-peak');
    rightBar.appendChild(rightPeak);
    barsContainer.appendChild(leftBar);
    barsContainer.appendChild(rightBar);
    const label = document.createElement('div');
    label.classList.add('meter-label');
    label.textContent = soundName;
    label.title = soundName;
    meterPair.appendChild(barsContainer);
    meterPair.appendChild(label);
    dom.levelMeterArea.appendChild(meterPair);
}

export function createMasterMeterElement() {
    if (!dom.levelMeterArea) return;
    const existing = dom.levelMeterArea.querySelector('.master-meter');
    if (existing) return;
    const meterPair = document.createElement('div');
    meterPair.classList.add('meter-pair', 'master-meter');
    const barsContainer = document.createElement('div');
    barsContainer.classList.add('meter-bars-container');
    const leftBar = document.createElement('div');
    leftBar.classList.add('meter-bar', 'left');
    const leftValue = document.createElement('div');
    leftValue.classList.add('meter-value');
    leftBar.appendChild(leftValue);
    const leftPeak = document.createElement('div');
    leftPeak.classList.add('meter-peak');
    leftBar.appendChild(leftPeak);
    const rightBar = document.createElement('div');
    rightBar.classList.add('meter-bar', 'right');
    const rightValue = document.createElement('div');
    rightValue.classList.add('meter-value');
    rightBar.appendChild(rightValue);
    const rightPeak = document.createElement('div');
    rightPeak.classList.add('meter-peak');
    rightBar.appendChild(rightPeak);
    barsContainer.appendChild(leftBar);
    barsContainer.appendChild(rightBar);
    const label = document.createElement('div');
    label.classList.add('meter-label');
    label.textContent = 'MASTER';
    meterPair.appendChild(barsContainer);
    meterPair.appendChild(label);
    dom.levelMeterArea.insertBefore(meterPair, dom.levelMeterArea.firstChild);
}

export function createMasterLimiterKnob(value, onChange) {
    if (!dom.masterLimiterControl) return;
    const min = -12;
    const max = 0;
    const step = 0.5;
    dom.masterLimiterControl.innerHTML = `
        <div class="knob-group header-limiter-knob" title="マスター出力の上限">
            <div class="knob"><div class="knob-indicator"></div></div>
            <span class="knob-value"></span>
            <span class="knob-name">LIMIT</span>
        </div>
    `;
    const knob = dom.masterLimiterControl.querySelector('.knob');
    const valueLabel = dom.masterLimiterControl.querySelector('.knob-value');
    const render = next => {
        knob.style.setProperty('--knob-rotation', `${((next - min) / (max - min)) * 270 - 135}deg`);
        valueLabel.textContent = `${next} dB`;
    };
    render(value);

    knob.addEventListener('pointerdown', event => {
        event.preventDefault();
        const startY = event.clientY;
        const startValue = state.masterLimiter.threshold;
        const handleMove = moveEvent => {
            const raw = startValue + (startY - moveEvent.clientY) / 120 * (max - min);
            const next = Math.min(max, Math.max(min, Math.round(raw / step) * step));
            render(next);
            onChange(next, false);
        };
        const handleUp = () => {
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            onChange(state.masterLimiter.threshold, true);
        };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp, { once: true });
    });
}

// --- Master Volume Knob ---
// センター(0deg)=100%(1.0)、範囲0〜200%(0〜2.0)
// 既存の回転ロジック (v-min)/(max-min)*270-135 に min=0,max=2 を入れると
// v=1のとき 1/2*270-135=0deg になり、ちょうどセンターになる。
const MASTER_VOLUME_KNOB_MIN = 0;
const MASTER_VOLUME_KNOB_MAX = 2;
const MASTER_VOLUME_KNOB_STEP = 0.01;

export function createMasterVolumeKnob(value, onChange) {
    if (!dom.masterVolumeControl) return;
    dom.masterVolumeControl.innerHTML = `
        <div class="knob-group header-volume-knob">
            <div class="knob"><div class="knob-indicator"></div></div>
            <span class="knob-value"></span>
            <span class="knob-name">VOL</span>
        </div>
    `;
    const knob = dom.masterVolumeControl.querySelector('.knob');
    const valueLabel = dom.masterVolumeControl.querySelector('.knob-value');
    const render = next => {
        knob.style.setProperty('--knob-rotation', `${((next - MASTER_VOLUME_KNOB_MIN) / (MASTER_VOLUME_KNOB_MAX - MASTER_VOLUME_KNOB_MIN)) * 270 - 135}deg`);
        valueLabel.textContent = `${Math.round(next * 100)}%`;
    };
    render(value);

    knob.addEventListener('pointerdown', event => {
        event.preventDefault();
        const startY = event.clientY;
        const startValue = state.masterVolume;
        const handleMove = moveEvent => {
            const raw = startValue + (startY - moveEvent.clientY) / 200 * (MASTER_VOLUME_KNOB_MAX - MASTER_VOLUME_KNOB_MIN);
            const next = Math.min(MASTER_VOLUME_KNOB_MAX, Math.max(MASTER_VOLUME_KNOB_MIN, Math.round(raw / MASTER_VOLUME_KNOB_STEP) * MASTER_VOLUME_KNOB_STEP));
            render(next);
            onChange(next, false);
        };
        const handleUp = () => {
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            onChange(state.masterVolume, true);
        };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp, { once: true });
    });

    // ダブルクリックで100%(1.0)にリセット — センター位置
    knob.addEventListener('dblclick', () => {
        render(1);
        onChange(1, true);
    });
}

// 外部(設定読み込み時など)からknob表示を更新する
export function updateMasterVolumeKnob(value) {
    if (!dom.masterVolumeControl) return;
    const knob = dom.masterVolumeControl.querySelector('.knob');
    const valueLabel = dom.masterVolumeControl.querySelector('.knob-value');
    if (!knob || !valueLabel) return;
    knob.style.setProperty('--knob-rotation', `${((value - MASTER_VOLUME_KNOB_MIN) / (MASTER_VOLUME_KNOB_MAX - MASTER_VOLUME_KNOB_MIN)) * 270 - 135}deg`);
    valueLabel.textContent = `${Math.round(value * 100)}%`;
}

export function removeMeterElement(soundId) {
    const meterElement = dom.levelMeterArea?.querySelector(`.meter-pair[data-sound-id="${soundId}"]`);
    if (meterElement) {
        meterElement.remove();
    }
}

export function createMasterEffectKnobs(allValues, onChange) {
    if (!dom.masterEffectBar) return;
    dom.masterEffectBar.innerHTML = '';

    const groups = [
        {
            name: 'EQ',
            params: [
                { key: 'eq.low',  label: 'LOW',  min: -12, max: 12, step: 0.5, unit: 'dB', default: 0 },
                { key: 'eq.mid',  label: 'MID',  min: -12, max: 12, step: 0.5, unit: 'dB', default: 0 },
                { key: 'eq.high', label: 'HIGH', min: -12, max: 12, step: 0.5, unit: 'dB', default: 0 }
            ]
        },
        {
            name: 'COMP',
            params: [
                { key: 'comp.threshold', label: 'THRESH', min: -60, max: 0, step: 1, unit: 'dB', default: 0 },
                { key: 'comp.ratio',     label: 'RATIO',  min: 1,   max: 20, step: 0.5, unit: ':1', default: 1 }
            ]
        },
        {
            name: 'DELAY',
            params: [
                { key: 'delay.time',  label: 'TIME', min: 0, max: 2, step: 0.01, unit: 's', dragPixels: 600, default: 0.18 },
                { key: 'delay.level', label: 'MIX',  min: 0, max: 1, step: 0.01, unit: '%', default: 0 }
            ]
        },
        {
            name: 'PAN',
            params: [
                { key: 'pan.value', label: 'PAN', min: -1, max: 1, step: 0.01, unit: 'pan', dragPixels: 300, default: 0 }
            ]
        },
        {
            name: 'DIST',
            params: [
                { key: 'distortion.amount', label: 'AMOUNT', min: 0, max: 1, step: 0.01, unit: '%' }
            ]
        },
        {
            name: 'REVERB',
            params: [
                { key: 'reverb.decay', label: 'DECAY', min: 0.1, max: 10, step: 0.1,  unit: 's', dragPixels: 600 },
                { key: 'reverb.wet',   label: 'MIX',   min: 0,   max: 1,  step: 0.01, unit: '%' }
            ]
        }
    ];

    const formatVal = (v, spec) => {
        if (spec.unit === 'pan') return formatPanValue(v);
        if (spec.unit === '%') return `${Math.round(v * 100)}%`;
        if (spec.unit === ':1') return `${v.toFixed(1)}:1`;
        if (spec.unit === 'dB') return `${v > 0 ? '+' : ''}${v} dB`;
        return `${v.toFixed(2)}${spec.unit}`;
    };

    const rotationFor = (v, spec) => {
        const range = spec.max - spec.min;
        if (range === 0) return 0;
        return ((v - spec.min) / range) * 270 - 135;
    };

    for (const group of groups) {
        const cluster = document.createElement('div');
        cluster.classList.add('knob-cluster');

        const sep = document.createElement('div');
        sep.classList.add('knob-separator');
        const groupName = document.createElement('span');
        groupName.classList.add('knob-group-name');
        groupName.textContent = group.name;
        sep.appendChild(groupName);
        cluster.appendChild(sep);

        for (const spec of group.params) {
            const parts = spec.key.split('.');
            const value = allValues[parts[0]]?.[parts[1]] ?? 0;

            const knobGroup = document.createElement('div');
            knobGroup.classList.add('knob-group');
            knobGroup.dataset.param = spec.key;

            const knob = document.createElement('div');
            knob.classList.add('knob');
            const indicator = document.createElement('div');
            indicator.classList.add('knob-indicator');
            knob.appendChild(indicator);
            knob.style.setProperty('--knob-rotation', `${rotationFor(value, spec)}deg`);

            const valLabel = document.createElement('span');
            valLabel.classList.add('knob-value');
            valLabel.textContent = formatVal(value, spec);

            const nameLabel = document.createElement('span');
            nameLabel.classList.add('knob-name');
            nameLabel.textContent = spec.label;

            knobGroup.appendChild(knob);
            knobGroup.appendChild(valLabel);
            knobGroup.appendChild(nameLabel);

            // Drag interaction with window-level listeners for reliable release
            const onPointerDown = (e) => {
                e.preventDefault();
                const startY = e.clientY;
                const startVal = state[`master${parts[0][0].toUpperCase()}${parts[0].slice(1)}`]?.[parts[1]] ?? 0;

                const onWindowMove = (ev) => {
                    const delta = startY - ev.clientY;
                    const dragPixels = spec.dragPixels ?? (spec.unit === '%' ? 400 : (spec.max - spec.min) * 8);
                    let raw = startVal + delta / dragPixels * (spec.max - spec.min);
                    raw = Math.min(spec.max, Math.max(spec.min, raw));
                    const stepped = Math.round(raw / spec.step) * spec.step;

                    knob.style.setProperty('--knob-rotation', `${rotationFor(stepped, spec)}deg`);
                    valLabel.textContent = formatVal(stepped, spec);
                    onChange(spec.key, stepped);
                };
                const onWindowUp = () => {
                    window.removeEventListener('pointermove', onWindowMove);
                    window.removeEventListener('pointerup', onWindowUp);
                };
                window.addEventListener('pointermove', onWindowMove);
                window.addEventListener('pointerup', onWindowUp);
            };

            // Double-click to reset to default value
            const onDoubleClick = () => {
                const def = spec.default ?? 0;
                knob.style.setProperty('--knob-rotation', `${rotationFor(def, spec)}deg`);
                valLabel.textContent = formatVal(def, spec);
                onChange(spec.key, def);
            };

            knobGroup.addEventListener('pointerdown', onPointerDown);
            knobGroup.addEventListener('dblclick', onDoubleClick);
            cluster.appendChild(knobGroup);
        }

        dom.masterEffectBar.appendChild(cluster);
    }
}

// --- Generic Knob Builder ---
// モーダル内スライダーやその他のUIで使用する汎用knob生成関数。
// 仕様:
//   min, max, step: 値域とステップ
//   default: ダブルクリック時のリセット値(省略時はmin)
//   unit: フォーマット種別('dB','%','s','ms',':1','pan','x','LUFS','dBFS' または関数(v)=>string)
//   label: knob下に表示するラベル(省略可)
//   dragPixels: 縦ドラッグ感度(省略時は範囲から推測)
//   value: 初期値
//   onInput(value): 値変更時に毎フレーム呼ばれる
// 戻り値: { element, setValue(v), getValue() }
//   setValue(v, notify): 外部から値を設定(notify=trueでonInputも発火)
export function createKnob(spec) {
    const { min, max, step, unit, value: initialValue } = spec;
    const defaultValue = spec.default ?? min;
    const dragPixels = spec.dragPixels ?? (unit === '%' ? 400 : Math.max(200, (max - min) * 8));

    const formatter = (v) => {
        if (typeof unit === 'function') return unit(v);
        if (unit === 'pan') return formatPanValue(v);
        if (unit === '%') return `${Math.round(v * 100)}%`;
        if (unit === ':1') return `${v.toFixed(1)}:1`;
        if (unit === 'dB') return `${v > 0 ? '+' : ''}${v} dB`;
        if (unit === 'x') return `${v.toFixed(2)}x`;
        if (unit === 's') return `${v.toFixed(2)}s`;
        if (unit === 'ms') return `${Math.round(v * 1000)}ms`;
        if (unit === 'LUFS') return `${v} LUFS`;
        if (unit === 'dBFS') return `${v} dBFS`;
        return `${v.toFixed(2)}${unit ?? ''}`;
    };

    const rotationFor = (v) => {
        const range = max - min;
        if (range === 0) return 0;
        return ((v - min) / range) * 270 - 135;
    };

    const knobGroup = document.createElement('div');
    knobGroup.classList.add('knob-group', 'modal-knob');

    const knob = document.createElement('div');
    knob.classList.add('knob');
    const indicator = document.createElement('div');
    indicator.classList.add('knob-indicator');
    knob.appendChild(indicator);

    const valLabel = document.createElement('span');
    valLabel.classList.add('knob-value');

    knobGroup.appendChild(knob);
    knobGroup.appendChild(valLabel);

    if (spec.label) {
        const nameLabel = document.createElement('span');
        nameLabel.classList.add('knob-name');
        nameLabel.textContent = spec.label;
        knobGroup.appendChild(nameLabel);
    }

    let currentValue = initialValue;
    const onInput = spec.onInput;

    const render = (v) => {
        knob.style.setProperty('--knob-rotation', `${rotationFor(v)}deg`);
        valLabel.textContent = formatter(v);
    };
    render(initialValue);

    const setValue = (v, notify = false) => {
        currentValue = v;
        render(v);
        if (notify && onInput) onInput(v);
    };

    knob.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startVal = currentValue;
        const onMove = (ev) => {
            const delta = startY - ev.clientY;
            let raw = startVal + delta / dragPixels * (max - min);
            raw = Math.min(max, Math.max(min, raw));
            const stepped = Math.round(raw / step) * step;
            if (stepped !== currentValue) {
                setValue(stepped, true);
            }
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    knob.addEventListener('dblclick', () => {
        setValue(defaultValue, true);
    });

    return {
        element: knobGroup,
        setValue,
        getValue: () => currentValue
    };
}

// --- General UI Updates ---
export function updateButtonUI(soundId, soundButtonElement, isPlaying) {
    if (!soundButtonElement) return;
    const iconElement = soundButtonElement.querySelector('.sound-icon');
    soundButtonElement.classList.toggle('playing', isPlaying);
    if (iconElement) {
        iconElement.classList.toggle('fa-play', !isPlaying);
        iconElement.classList.toggle('fa-stop', isPlaying);
    }
}

export function resetProgressBar(soundButtonElement) {
    if (!soundButtonElement) return;
    const progressBarValueElement = soundButtonElement.querySelector('.progress-bar-value');
    if (progressBarValueElement) { progressBarValueElement.style.width = '0%'; }
    const timeDisplayElement = soundButtonElement.querySelector('.time-display');
    if (timeDisplayElement) {
        const soundId = soundButtonElement.dataset.id;
        // Find the sound data from the persistent scenes state to ensure duration is always available
        const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
        const duration = soundData?.duration || 0;

        const formatTime = (seconds) => {
            if (isNaN(seconds) || seconds < 0) return '--:--';
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        };
        
        timeDisplayElement.textContent = `0:00 / ${formatTime(duration)}`;
        const timecodeDisplay = soundButtonElement.querySelector('.timecode-display');
        if (timecodeDisplay) {
            timecodeDisplay.textContent = `${formatTimecode(0, state.timecodeFps)} / ${formatTimecode(duration, state.timecodeFps)}`;
        }
    }
}

export function updateDraggableState() {
    const buttons = dom.soundboard.querySelectorAll('.sound-button');
    buttons.forEach(button => {
        button.draggable = state.isSortableEnabled;
    });
}

// --- Drag & Drop UI ---
export function clearDragStyles() {
    const draggingElement = dom.soundboard.querySelector('.dragging');
    if (draggingElement) { draggingElement.classList.remove('dragging'); }
    clearDragOverStyles();
}

export function clearDragOverStyles() {
    dom.soundboard.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

export function createGhostElement(originalElement, touch) {
    removeGhostElement();
    const ghost = originalElement.cloneNode(true);
    ghost.classList.add('ghost-element');
    ghost.classList.remove('playing', 'loop-on', 'momentary', 'retrigger', 'dragging', 'drag-over');
    ghost.style.width = `${originalElement.offsetWidth}px`;
    ghost.style.height = `${originalElement.offsetHeight}px`;
    const rect = originalElement.getBoundingClientRect();
    const ghostOffsetX = touch.clientX - rect.left;
    const ghostOffsetY = touch.clientY - rect.top;
    ghost.style.position = 'fixed';
    ghost.style.left = '0px';
    ghost.style.top = '0px';
    ghost.style.pointerEvents = 'none';
    ghost.style.transform = `translate(${touch.clientX - ghostOffsetX}px, ${touch.clientY - ghostOffsetY}px)`;
    document.body.appendChild(ghost);
    updateState({ ghostElement: ghost, ghostOffsetX, ghostOffsetY });
}

export function removeGhostElement() {
    if (state.ghostElement?.parentNode) {
        state.ghostElement.parentNode.removeChild(state.ghostElement);
    }
    updateState({ ghostElement: null });
}

// modules/05_ui.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { saveSetting } from './07_scenes.js';
import { normalizeEffectSettings } from './09_effects.js';
import { FADE_EASING_TYPES } from './01_config.js';

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

        dom.customModalOkBtn.onclick = () => {
            dom.customModalOverlay.classList.remove('active');
            if (type === 'showPrompt') {
                resolve(inputElement ? inputElement.value : null);
            } else {
                resolve(true);
            }
        };

        dom.customModalCancelBtn.onclick = () => {
            dom.customModalOverlay.classList.remove('active');
            resolve(false);
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

export async function showSoundSettingsModal(soundId, currentShortcut = '') {
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
                    <label for="pad-color-input" class="effect-param-label">カラー</label>
                    <input type="color" id="pad-color-input" class="modal-input effect-color-input" value="${initialColor}">
                    <button type="button" id="pad-color-clear-btn" class="modal-input effect-color-clear-btn">解除</button>
                </div>
                <label class="effect-toggle hold-to-play-setting">
                    <input type="checkbox" id="hold-to-play-input" ${sound.holdToPlay ? 'checked' : ''}> ホールド中のみ再生
                </label>
                <div class="effect-param-row">
                    <label for="fade-in-duration-input" class="effect-param-label">フェードイン</label>
                    <span class="effect-param-value"><span id="fade-in-duration-value">${fadeInDuration.toFixed(2)}</span>s</span>
                    <input type="range" id="fade-in-duration-input" min="0" max="5" step="0.01" value="${fadeInDuration}" class="modal-input effect-slider">
                </div>
                <div class="effect-param-row">
                    <label for="fade-in-easing-input" class="effect-param-label">イン カーブ</label>
                    <select id="fade-in-easing-input" class="modal-input effect-select">${easingOptions(fadeInEasing)}</select>
                </div>
                <div class="effect-param-row">
                    <label for="fade-out-duration-input" class="effect-param-label">フェードアウト</label>
                    <span class="effect-param-value"><span id="fade-out-duration-value">${fadeOutDuration.toFixed(2)}</span>s</span>
                    <input type="range" id="fade-out-duration-input" min="0" max="5" step="0.01" value="${fadeOutDuration}" class="modal-input effect-slider">
                </div>
                <div class="effect-param-row">
                    <label for="fade-out-easing-input" class="effect-param-label">アウト カーブ</label>
                    <select id="fade-out-easing-input" class="modal-input effect-select">${easingOptions(fadeOutEasing)}</select>
                </div>
                <div class="effect-param-row">
                    <label for="pan-input" class="effect-param-label">Pan</label>
                    <span class="effect-param-value"><span id="pan-value">${formatPanValue(initialPan)}</span></span>
                    <div class="pan-slider-wrap">
                        <span class="pan-marker">L</span>
                        <input type="range" id="pan-input" min="-1" max="1" step="0.01" value="${initialPan}" class="modal-input effect-slider">
                        <span class="pan-marker">R</span>
                    </div>
                </div>
                <div class="effect-param-row">
                    <label for="reverse-input" class="effect-param-label">逆再生</label>
                    <input type="checkbox" id="reverse-input" ${reverse ? 'checked' : ''}>
                </div>
                <div class="effect-param-row">
                    <label for="playback-speed-input" class="effect-param-label">速度</label>
                    <span class="effect-param-value"><span id="playback-speed-value">${initialSpeed.toFixed(2)}</span>x</span>
                    <input type="range" id="playback-speed-input" min="0.5" max="2" step="0.05" value="${initialSpeed}" class="modal-input effect-slider">
                </div>
                <div class="effect-param-row effect-checkbox-row">
                    <span class="effect-param-label">ピッチ</span>
                    <label><input type="checkbox" id="preserve-pitch-input" ${sound.preservePitch ? 'checked' : ''}> 速度変更時も保持</label>
                </div>
            </div>
            <div class="effect-divider"></div>
            <div class="effect-section">
                <div class="effect-master-row">
                    <label class="effect-toggle"><input type="checkbox" id="effect-enabled-input" ${effectSettings.enabled ? 'checked' : ''}> エフェクト</label>
                    <div class="effect-param-row inline">
                        <span class="effect-param-label">Dry/Wet</span>
                        <span class="effect-param-value"><span id="effect-wet-value">${Math.round(effectSettings.wet * 100)}</span>%</span>
                        <input type="range" id="effect-wet-input" min="0" max="1" step="0.01" value="${effectSettings.wet}" class="modal-input effect-slider">
                    </div>
                </div>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="eq-enabled-input" ${effectSettings.eq.enabled ? 'checked' : ''}> 3バンドEQ</label></legend>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Low</span>
                        <span class="effect-param-value"><span id="eq-low-value">${effectSettings.eq.low > 0 ? '+' : ''}${effectSettings.eq.low}</span>dB</span>
                        <input type="range" id="eq-low-input" min="-12" max="12" step="0.5" value="${effectSettings.eq.low}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Mid</span>
                        <span class="effect-param-value"><span id="eq-mid-value">${effectSettings.eq.mid > 0 ? '+' : ''}${effectSettings.eq.mid}</span>dB</span>
                        <input type="range" id="eq-mid-input" min="-12" max="12" step="0.5" value="${effectSettings.eq.mid}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">High</span>
                        <span class="effect-param-value"><span id="eq-high-value">${effectSettings.eq.high > 0 ? '+' : ''}${effectSettings.eq.high}</span>dB</span>
                        <input type="range" id="eq-high-input" min="-12" max="12" step="0.5" value="${effectSettings.eq.high}" class="modal-input effect-slider">
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="delay-enabled-input" ${effectSettings.delay.enabled ? 'checked' : ''}> ディレイ</label></legend>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Time</span>
                        <span class="effect-param-value"><span id="delay-time-value">${effectSettings.delay.time.toFixed(2)}</span>s</span>
                        <input type="range" id="delay-time-input" min="0" max="2" step="0.01" value="${effectSettings.delay.time}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Feedback</span>
                        <span class="effect-param-value"><span id="delay-feedback-value">${Math.round(effectSettings.delay.feedback * 100)}</span>%</span>
                        <input type="range" id="delay-feedback-input" min="0" max="0.85" step="0.01" value="${effectSettings.delay.feedback}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Level</span>
                        <span class="effect-param-value"><span id="delay-level-value">${Math.round(effectSettings.delay.level * 100)}</span>%</span>
                        <input type="range" id="delay-level-input" min="0" max="1" step="0.01" value="${effectSettings.delay.level}" class="modal-input effect-slider">
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="compressor-enabled-input" ${effectSettings.compressor.enabled ? 'checked' : ''}> コンプレッサー</label></legend>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Threshold</span>
                        <span class="effect-param-value"><span id="compressor-threshold-value">${effectSettings.compressor.threshold}</span>dB</span>
                        <input type="range" id="compressor-threshold-input" min="-60" max="0" step="1" value="${effectSettings.compressor.threshold}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Ratio</span>
                        <span class="effect-param-value"><span id="compressor-ratio-value">${effectSettings.compressor.ratio.toFixed(1)}</span>:1</span>
                        <input type="range" id="compressor-ratio-input" min="1" max="20" step="0.1" value="${effectSettings.compressor.ratio}" class="modal-input effect-slider">
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="distortion-enabled-input" ${effectSettings.distortion.enabled ? 'checked' : ''}> ディストーション</label></legend>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Amount</span>
                        <span class="effect-param-value"><span id="distortion-amount-value">${Math.round(effectSettings.distortion.amount * 100)}</span>%</span>
                        <input type="range" id="distortion-amount-input" min="0" max="1" step="0.01" value="${effectSettings.distortion.amount}" class="modal-input effect-slider">
                    </div>
                </fieldset>
                <fieldset class="effect-group">
                    <legend><label><input type="checkbox" id="reverb-enabled-input" ${effectSettings.reverb.enabled ? 'checked' : ''}> リバーブ</label></legend>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Decay</span>
                        <span class="effect-param-value"><span id="reverb-decay-value">${effectSettings.reverb.decay.toFixed(1)}</span>s</span>
                        <input type="range" id="reverb-decay-input" min="0.1" max="10" step="0.1" value="${effectSettings.reverb.decay}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">PreDelay</span>
                        <span class="effect-param-value"><span id="reverb-preDelay-value">${(effectSettings.reverb.preDelay * 1000).toFixed(0)}</span>ms</span>
                        <input type="range" id="reverb-preDelay-input" min="0" max="0.1" step="0.001" value="${effectSettings.reverb.preDelay}" class="modal-input effect-slider">
                    </div>
                    <div class="effect-param-row">
                        <span class="effect-param-label">Wet</span>
                        <span class="effect-param-value"><span id="reverb-wet-value">${Math.round(effectSettings.reverb.wet * 100)}</span>%</span>
                        <input type="range" id="reverb-wet-input" min="0" max="1" step="0.01" value="${effectSettings.reverb.wet}" class="modal-input effect-slider">
                    </div>
                </fieldset>
            </div>
        `;

        const shortcutInput = dom.customModalMessage.querySelector('#shortcut-input');
        const padColorInput = dom.customModalMessage.querySelector('#pad-color-input');
        const padColorClearBtn = dom.customModalMessage.querySelector('#pad-color-clear-btn');
        const holdToPlayInput = dom.customModalMessage.querySelector('#hold-to-play-input');
        const fadeInDurationInput = dom.customModalMessage.querySelector('#fade-in-duration-input');
        const fadeInDurationValueSpan = dom.customModalMessage.querySelector('#fade-in-duration-value');
        const fadeInEasingInput = dom.customModalMessage.querySelector('#fade-in-easing-input');
        const fadeOutDurationInput = dom.customModalMessage.querySelector('#fade-out-duration-input');
        const fadeOutDurationValueSpan = dom.customModalMessage.querySelector('#fade-out-duration-value');
        const fadeOutEasingInput = dom.customModalMessage.querySelector('#fade-out-easing-input');
        const panInput = dom.customModalMessage.querySelector('#pan-input');
        const panValueSpan = dom.customModalMessage.querySelector('#pan-value');
        const reverseInput = dom.customModalMessage.querySelector('#reverse-input');
        const playbackSpeedInput = dom.customModalMessage.querySelector('#playback-speed-input');
        const playbackSpeedValueSpan = dom.customModalMessage.querySelector('#playback-speed-value');
        const preservePitchInput = dom.customModalMessage.querySelector('#preserve-pitch-input');
        const effectEnabledInput = dom.customModalMessage.querySelector('#effect-enabled-input');
        const effectWetInput = dom.customModalMessage.querySelector('#effect-wet-input');
        const eqEnabledInput = dom.customModalMessage.querySelector('#eq-enabled-input');
        const eqLowInput = dom.customModalMessage.querySelector('#eq-low-input');
        const eqMidInput = dom.customModalMessage.querySelector('#eq-mid-input');
        const eqHighInput = dom.customModalMessage.querySelector('#eq-high-input');
        const delayEnabledInput = dom.customModalMessage.querySelector('#delay-enabled-input');
        const delayTimeInput = dom.customModalMessage.querySelector('#delay-time-input');
        const delayFeedbackInput = dom.customModalMessage.querySelector('#delay-feedback-input');
        const delayLevelInput = dom.customModalMessage.querySelector('#delay-level-input');
        const compressorEnabledInput = dom.customModalMessage.querySelector('#compressor-enabled-input');
        const compressorThresholdInput = dom.customModalMessage.querySelector('#compressor-threshold-input');
        const compressorRatioInput = dom.customModalMessage.querySelector('#compressor-ratio-input');
        const distortionEnabledInput = dom.customModalMessage.querySelector('#distortion-enabled-input');
        const distortionAmountInput = dom.customModalMessage.querySelector('#distortion-amount-input');
        const reverbEnabledInput = dom.customModalMessage.querySelector('#reverb-enabled-input');
        const reverbDecayInput = dom.customModalMessage.querySelector('#reverb-decay-input');
        const reverbPreDelayInput = dom.customModalMessage.querySelector('#reverb-preDelay-input');
        const reverbWetInput = dom.customModalMessage.querySelector('#reverb-wet-input');

        let newShortcut = currentShortcut;
        let newColor = (typeof sound.color === 'string' && sound.color) ? sound.color : null;
        let newFadeInDuration = fadeInDuration;
        let newFadeOutDuration = fadeOutDuration;
        let newFadeInEasing = fadeInEasing;
        let newFadeOutEasing = fadeOutEasing;
        let newPan = initialPan;
        let newReverse = reverse;
        let newPlaybackSpeed = initialSpeed;
        let newEffects = effectSettings;

        const handleKeydown = (e) => {
            e.preventDefault(); // Prevent default browser actions for shortcuts

            if (e.key === 'Backspace' || e.key === 'Delete') {
                newShortcut = '';
                shortcutInput.value = '';
                return;
            }

            const modifiers = [];
            if (e.ctrlKey) modifiers.push('Control');
            if (e.altKey) modifiers.push('Alt');
            if (e.shiftKey) modifiers.push('Shift');
            if (e.metaKey) modifiers.push('Meta'); // Command on Mac, Windows key on Windows

            let key = e.key;
            if (key === ' ') key = 'Space'; // Display Space key nicely
            if (modifiers.includes(key)) key = ''; // Don't duplicate modifier in key display

            const displayKey = key.length === 1 ? key.toUpperCase() : key; // Single letters uppercase

            newShortcut = [...modifiers, displayKey].filter(Boolean).join('+');
            shortcutInput.value = newShortcut;
        };

        const handlePadColorInput = (e) => { newColor = e.target.value; };
        const handlePadColorClear = () => {
            newColor = null;
            padColorInput.value = '#808080';
        };

        const handlePlaybackSpeedInput = (e) => {
            newPlaybackSpeed = parseFloat(e.target.value);
            playbackSpeedValueSpan.textContent = newPlaybackSpeed.toFixed(2);
        };

        const handleFadeInDurationInput = (e) => {
            newFadeInDuration = parseFloat(e.target.value);
            fadeInDurationValueSpan.textContent = newFadeInDuration.toFixed(2);
        };
        const handleFadeOutDurationInput = (e) => {
            newFadeOutDuration = parseFloat(e.target.value);
            fadeOutDurationValueSpan.textContent = newFadeOutDuration.toFixed(2);
        };
        const handleFadeInEasingInput = (e) => { newFadeInEasing = e.target.value; };
        const handleFadeOutEasingInput = (e) => { newFadeOutEasing = e.target.value; };

        const handlePanInput = (e) => {
            newPan = parseFloat(e.target.value);
            panValueSpan.textContent = formatPanValue(newPan);
        };

        const handlePanDoubleClick = () => {
            newPan = 0;
            panInput.value = 0;
            panValueSpan.textContent = formatPanValue(0);
        };

        const handleReverseInput = (e) => { newReverse = e.target.checked; };

        const readEffects = () => normalizeEffectSettings({
            enabled: effectEnabledInput.checked,
            wet: parseFloat(effectWetInput.value),
            eq: {
                enabled: eqEnabledInput.checked,
                low: parseFloat(eqLowInput.value),
                mid: parseFloat(eqMidInput.value),
                high: parseFloat(eqHighInput.value)
            },
            delay: {
                enabled: delayEnabledInput.checked,
                time: parseFloat(delayTimeInput.value),
                feedback: parseFloat(delayFeedbackInput.value),
                level: parseFloat(delayLevelInput.value)
            },
            compressor: {
                enabled: compressorEnabledInput.checked,
                threshold: parseFloat(compressorThresholdInput.value),
                ratio: parseFloat(compressorRatioInput.value)
            },
            distortion: {
                enabled: distortionEnabledInput.checked,
                amount: parseFloat(distortionAmountInput.value)
            },
            reverb: {
                enabled: reverbEnabledInput.checked,
                decay: parseFloat(reverbDecayInput.value),
                preDelay: parseFloat(reverbPreDelayInput.value),
                wet: parseFloat(reverbWetInput.value)
            }
        });

        const handleEffectInput = () => {
            newEffects = readEffects();
            dom.customModalMessage.querySelector('#effect-wet-value').textContent = Math.round(newEffects.wet * 100);
            dom.customModalMessage.querySelector('#eq-low-value').textContent = (newEffects.eq.low > 0 ? '+' : '') + newEffects.eq.low;
            dom.customModalMessage.querySelector('#eq-mid-value').textContent = (newEffects.eq.mid > 0 ? '+' : '') + newEffects.eq.mid;
            dom.customModalMessage.querySelector('#eq-high-value').textContent = (newEffects.eq.high > 0 ? '+' : '') + newEffects.eq.high;
            dom.customModalMessage.querySelector('#delay-time-value').textContent = newEffects.delay.time.toFixed(2);
            dom.customModalMessage.querySelector('#delay-feedback-value').textContent = Math.round(newEffects.delay.feedback * 100);
            dom.customModalMessage.querySelector('#delay-level-value').textContent = Math.round(newEffects.delay.level * 100);
            dom.customModalMessage.querySelector('#compressor-threshold-value').textContent = newEffects.compressor.threshold;
            dom.customModalMessage.querySelector('#compressor-ratio-value').textContent = newEffects.compressor.ratio.toFixed(1);
            dom.customModalMessage.querySelector('#distortion-amount-value').textContent = Math.round(newEffects.distortion.amount * 100);
            dom.customModalMessage.querySelector('#reverb-decay-value').textContent = newEffects.reverb.decay.toFixed(1);
            dom.customModalMessage.querySelector('#reverb-preDelay-value').textContent = (newEffects.reverb.preDelay * 1000).toFixed(0);
            dom.customModalMessage.querySelector('#reverb-wet-value').textContent = Math.round(newEffects.reverb.wet * 100);
        };

        shortcutInput.addEventListener('keydown', handleKeydown);
        padColorInput.addEventListener('input', handlePadColorInput);
        padColorClearBtn.addEventListener('click', handlePadColorClear);
        fadeInDurationInput.addEventListener('input', handleFadeInDurationInput);
        fadeOutDurationInput.addEventListener('input', handleFadeOutDurationInput);
        fadeInEasingInput.addEventListener('change', handleFadeInEasingInput);
        fadeOutEasingInput.addEventListener('change', handleFadeOutEasingInput);
        panInput.addEventListener('input', handlePanInput);
        panInput.addEventListener('dblclick', handlePanDoubleClick);
        reverseInput.addEventListener('change', handleReverseInput);
        playbackSpeedInput.addEventListener('input', handlePlaybackSpeedInput);
        [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput, distortionEnabledInput, distortionAmountInput, reverbEnabledInput, reverbDecayInput, reverbPreDelayInput, reverbWetInput]
            .forEach(input => input.addEventListener('input', handleEffectInput));

        dom.customModalOkBtn.textContent = '保存';
        dom.customModalCancelBtn.textContent = 'キャンセル';
        dom.customModalCancelBtn.style.display = 'inline-block';

        dom.customModalOkBtn.onclick = () => {
            shortcutInput.removeEventListener('keydown', handleKeydown);
            padColorInput.removeEventListener('input', handlePadColorInput);
            padColorClearBtn.removeEventListener('click', handlePadColorClear);
            fadeInDurationInput.removeEventListener('input', handleFadeInDurationInput);
            fadeOutDurationInput.removeEventListener('input', handleFadeOutDurationInput);
            fadeInEasingInput.removeEventListener('change', handleFadeInEasingInput);
            fadeOutEasingInput.removeEventListener('change', handleFadeOutEasingInput);
            panInput.removeEventListener('input', handlePanInput);
            panInput.removeEventListener('dblclick', handlePanDoubleClick);
            reverseInput.removeEventListener('change', handleReverseInput);
            playbackSpeedInput.removeEventListener('input', handlePlaybackSpeedInput);
            [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput, distortionEnabledInput, distortionAmountInput, reverbEnabledInput, reverbDecayInput, reverbPreDelayInput, reverbWetInput]
                .forEach(input => input.removeEventListener('input', handleEffectInput));
            dom.customModalOverlay.classList.remove('active');
            resolve({ newShortcut, newColor, newHoldToPlay: holdToPlayInput.checked, newFadeInDuration, newFadeOutDuration, newFadeInEasing, newFadeOutEasing, newPan, newReverse, newPlaybackSpeed, preservePitch: preservePitchInput.checked, newEffects: readEffects() });
        };

        dom.customModalCancelBtn.onclick = () => {
            shortcutInput.removeEventListener('keydown', handleKeydown);
            padColorInput.removeEventListener('input', handlePadColorInput);
            padColorClearBtn.removeEventListener('click', handlePadColorClear);
            fadeInDurationInput.removeEventListener('input', handleFadeInDurationInput);
            fadeOutDurationInput.removeEventListener('input', handleFadeOutDurationInput);
            fadeInEasingInput.removeEventListener('change', handleFadeInEasingInput);
            fadeOutEasingInput.removeEventListener('change', handleFadeOutEasingInput);
            panInput.removeEventListener('input', handlePanInput);
            panInput.removeEventListener('dblclick', handlePanDoubleClick);
            reverseInput.removeEventListener('change', handleReverseInput);
            playbackSpeedInput.removeEventListener('input', handlePlaybackSpeedInput);
            [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput, distortionEnabledInput, distortionAmountInput, reverbEnabledInput, reverbDecayInput, reverbPreDelayInput, reverbWetInput]
                .forEach(input => input.removeEventListener('input', handleEffectInput));
            dom.customModalOverlay.classList.remove('active');
            resolve(null); // User cancelled
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
    ghost.classList.remove('playing', 'loop-on', 'dragging', 'drag-over');
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

// modules/05_ui.js

import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import { saveSetting } from './07_scenes.js';
import { normalizeEffectSettings } from './09_effects.js';

// --- Custom Modal ---
export function showModal(title, message, type = 'showAlert', inputPlaceholder = '', inputDefaultValue = '') {
    return new Promise(resolve => {
        if (!dom.customModalOverlay) {
            window.alert(`[${title}]\n${message}`); // Fallback to native alert
            resolve(null); // Resolve with null for fallback
            return;
        }

        dom.customModalTitle.textContent = title;
        dom.customModalMessage.innerHTML = message.replace(/\n/g, '<br>');

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
        const duration = sound.duration || 0;
        const initialCueIn = Math.max(0, Math.min(duration, sound.cueIn ?? 0));
        const initialCueOut = Number.isFinite(sound.cueOut) ? Math.max(initialCueIn, Math.min(duration, sound.cueOut)) : duration;

        dom.customModalMessage.innerHTML = `
            <div class="effect-section">
                <div class="effect-param-row">
                    <label for="shortcut-input" class="effect-param-label">ショートカット</label>
                    <input type="text" id="shortcut-input" class="modal-input effect-text-input" readonly value="${currentShortcut}" placeholder="キーを押してください">
                </div>
                <div class="effect-param-row">
                    <label for="fade-duration-input" class="effect-param-label">フェード時間</label>
                    <span class="effect-param-value"><span id="fade-duration-value">${(sound.fadeDuration ?? 0.0).toFixed(2)}</span>s</span>
                    <input type="range" id="fade-duration-input" min="0" max="5" step="0.01" value="${sound.fadeDuration ?? 0.0}" class="modal-input effect-slider">
                </div>
                <div class="effect-param-row">
                    <label for="cue-in-input" class="effect-param-label">開始位置</label>
                    <input type="number" id="cue-in-number" min="0" max="${duration.toFixed(3)}" step="0.01" value="${initialCueIn.toFixed(2)}" class="modal-input effect-number-input" ${duration <= 0 ? 'disabled' : ''}>
                    <input type="range" id="cue-in-input" min="0" max="${duration.toFixed(3)}" step="0.01" value="${initialCueIn}" class="modal-input effect-slider" ${duration <= 0 ? 'disabled' : ''}>
                </div>
                <div class="effect-param-row">
                    <label for="cue-out-input" class="effect-param-label">終了位置</label>
                    <input type="number" id="cue-out-number" min="0" max="${duration.toFixed(3)}" step="0.01" value="${initialCueOut.toFixed(2)}" class="modal-input effect-number-input" ${duration <= 0 ? 'disabled' : ''}>
                    <input type="range" id="cue-out-input" min="0" max="${duration.toFixed(3)}" step="0.01" value="${initialCueOut}" class="modal-input effect-slider" ${duration <= 0 ? 'disabled' : ''}>
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
            </div>
        `;

        const shortcutInput = dom.customModalMessage.querySelector('#shortcut-input');
        const fadeDurationInput = dom.customModalMessage.querySelector('#fade-duration-input');
        const fadeDurationValueSpan = dom.customModalMessage.querySelector('#fade-duration-value');
        const cueInInput = dom.customModalMessage.querySelector('#cue-in-input');
        const cueInNumberInput = dom.customModalMessage.querySelector('#cue-in-number');
        const cueOutInput = dom.customModalMessage.querySelector('#cue-out-input');
        const cueOutNumberInput = dom.customModalMessage.querySelector('#cue-out-number');
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

        let newShortcut = currentShortcut;
        let newFadeDuration = sound.fadeDuration ?? 0.0;
        let newCueIn = initialCueIn;
        let newCueOut = initialCueOut;
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

        const handleFadeDurationInput = (e) => {
            newFadeDuration = parseFloat(e.target.value);
            fadeDurationValueSpan.textContent = newFadeDuration.toFixed(2);
        };

        const handleCueInInput = (e) => {
            newCueIn = parseFloat(e.target.value);
            cueInNumberInput.value = newCueIn.toFixed(2);
            // 開始位置が終了位置を超えないよう同期
            if (newCueIn > newCueOut) {
                newCueOut = newCueIn;
                cueOutInput.value = newCueOut;
                cueOutNumberInput.value = newCueOut.toFixed(2);
            }
        };

        const handleCueOutInput = (e) => {
            newCueOut = parseFloat(e.target.value);
            cueOutNumberInput.value = newCueOut.toFixed(2);
            if (newCueOut < newCueIn) {
                newCueIn = newCueOut;
                cueInInput.value = newCueIn;
                cueInNumberInput.value = newCueIn.toFixed(2);
            }
        };

        const handleCueInNumberInput = (e) => {
            let v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) v = 0;
            v = Math.max(0, Math.min(duration, v));
            newCueIn = v;
            cueInInput.value = v;
            e.target.value = v.toFixed(2);
            if (newCueIn > newCueOut) {
                newCueOut = newCueIn;
                cueOutInput.value = newCueOut;
                cueOutNumberInput.value = newCueOut.toFixed(2);
            }
        };

        const handleCueOutNumberInput = (e) => {
            let v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) v = duration;
            v = Math.max(0, Math.min(duration, v));
            newCueOut = v;
            cueOutInput.value = v;
            e.target.value = v.toFixed(2);
            if (newCueOut < newCueIn) {
                newCueIn = newCueOut;
                cueInInput.value = newCueIn;
                cueInNumberInput.value = newCueIn.toFixed(2);
            }
        };

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
        };

        shortcutInput.addEventListener('keydown', handleKeydown);
        fadeDurationInput.addEventListener('input', handleFadeDurationInput);
        cueInInput.addEventListener('input', handleCueInInput);
        cueInNumberInput.addEventListener('input', handleCueInNumberInput);
        cueOutInput.addEventListener('input', handleCueOutInput);
        cueOutNumberInput.addEventListener('input', handleCueOutNumberInput);
        [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput]
            .forEach(input => input.addEventListener('input', handleEffectInput));

        dom.customModalOkBtn.textContent = '保存';
        dom.customModalCancelBtn.textContent = 'キャンセル';
        dom.customModalCancelBtn.style.display = 'inline-block';

        dom.customModalOkBtn.onclick = () => {
            shortcutInput.removeEventListener('keydown', handleKeydown);
            fadeDurationInput.removeEventListener('input', handleFadeDurationInput);
            cueInInput.removeEventListener('input', handleCueInInput);
            cueInNumberInput.removeEventListener('input', handleCueInNumberInput);
            cueOutInput.removeEventListener('input', handleCueOutInput);
            cueOutNumberInput.removeEventListener('input', handleCueOutNumberInput);
            [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput]
                .forEach(input => input.removeEventListener('input', handleEffectInput));
            dom.customModalOverlay.classList.remove('active');
            resolve({ newShortcut, newFadeDuration, newCueIn, newCueOut, newEffects: readEffects() });
        };

        dom.customModalCancelBtn.onclick = () => {
            shortcutInput.removeEventListener('keydown', handleKeydown);
            fadeDurationInput.removeEventListener('input', handleFadeDurationInput);
            cueInInput.removeEventListener('input', handleCueInInput);
            cueInNumberInput.removeEventListener('input', handleCueInNumberInput);
            cueOutInput.removeEventListener('input', handleCueOutInput);
            cueOutNumberInput.removeEventListener('input', handleCueOutNumberInput);
            [effectEnabledInput, effectWetInput, eqEnabledInput, eqLowInput, eqMidInput, eqHighInput, delayEnabledInput, delayTimeInput, delayFeedbackInput, delayLevelInput, compressorEnabledInput, compressorThresholdInput, compressorRatioInput]
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
                { key: 'eq.low',  label: 'LOW',  min: -12, max: 12, step: 0.5, unit: 'dB' },
                { key: 'eq.mid',  label: 'MID',  min: -12, max: 12, step: 0.5, unit: 'dB' },
                { key: 'eq.high', label: 'HIGH', min: -12, max: 12, step: 0.5, unit: 'dB' }
            ]
        },
        {
            name: 'COMP',
            params: [
                { key: 'comp.threshold', label: 'THRESH', min: -60, max: 0, step: 1, unit: 'dB' },
                { key: 'comp.ratio',     label: 'RATIO',  min: 1,   max: 20, step: 0.5, unit: ':1' }
            ]
        },
        {
            name: 'DELAY',
            params: [
                { key: 'delay.time',  label: 'TIME', min: 0, max: 2,    step: 0.01, unit: 's', dragPixels: 600 },
                { key: 'delay.level', label: 'MIX',  min: 0, max: 1,    step: 0.01, unit: '%' }
            ]
        }
    ];

    const formatVal = (v, spec) => {
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
        const sep = document.createElement('div');
        sep.classList.add('knob-separator');
        const groupName = document.createElement('span');
        groupName.classList.add('knob-group-name');
        groupName.textContent = group.name;
        sep.appendChild(groupName);
        dom.masterEffectBar.appendChild(sep);

        for (const spec of group.params) {
            const parts = spec.key.split('.');
            const value = allValues[parts[0]]?.[parts[1]] ?? 0;
            const pctValue = spec.unit === '%' ? value : value;

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

            knobGroup.addEventListener('pointerdown', onPointerDown);
            dom.masterEffectBar.appendChild(knobGroup);
        }
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

// modules/06_audio.js

import { state, setAudioContext, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { showAlert, createMeterElement, removeMeterElement, updateButtonUI, resetProgressBar, setupCanvasResize } from './05_ui.js';
import { renderFallbackUI, disableAppControls } from './07_scenes.js';
import { ANALYSER_FFT_SIZE, WAVEFORM_SECONDS_AHEAD, WAVEFORM_DOWNSAMPLE, PERFORMANCE_MODE, MIN_GAIN_RAMP_SECONDS, MIN_STOP_FADE_SECONDS } from './01_config.js';
import { dbRequest } from './04_db.js';
import { applyEffectSettings, createEffectRack, disposeEffectRack } from './09_effects.js';
import { attachToneContext, getToneClockSnapshot, resumeToneAudio } from './10_tone_transport.js';
import * as Tone from 'tone';

// --- AudioContext Management ---
export function initAudioContext() {
    if (state.audioContext) { return state.audioContext.state === 'running'; }
    if (!window.AudioContext && !window.webkitAudioContext) {
        renderFallbackUI("Web Audio API非対応ブラウザです。");
        disableAppControls();
        return false;
    }
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const masterGainNode = audioContext.createGain();
        const outputLimiterNode = audioContext.createDynamicsCompressor();
        outputLimiterNode.threshold.setValueAtTime(-1, audioContext.currentTime);
        outputLimiterNode.knee.setValueAtTime(0, audioContext.currentTime);
        outputLimiterNode.ratio.setValueAtTime(20, audioContext.currentTime);
        outputLimiterNode.attack.setValueAtTime(0.001, audioContext.currentTime);
        outputLimiterNode.release.setValueAtTime(0.05, audioContext.currentTime);
        masterGainNode.gain.setValueAtTime(state.masterVolume, audioContext.currentTime);

        // Master chain: EQ3 → Compressor → [dry + delay] → limiter
        attachToneContext(audioContext);
        const eqBridgeIn = new Tone.Gain(1);
        const masterEqNode = new Tone.EQ3({ low: state.masterEq.low, mid: state.masterEq.mid, high: state.masterEq.high, lowFrequency: 400, highFrequency: 2500 });
        eqBridgeIn.connect(masterEqNode);
        masterGainNode.connect(eqBridgeIn.input);

        const masterCompNode = new Tone.Compressor({ threshold: state.masterComp.threshold, ratio: state.masterComp.ratio, attack: 0.003, release: 0.12 });
        masterEqNode.connect(masterCompNode);

        const masterDryGain = new Tone.Gain(1);
        const masterDelayNode = new Tone.FeedbackDelay({ delayTime: state.masterDelay.time, feedback: state.masterDelay.feedback, maxDelay: 2 });
        const masterDelayReturn = new Tone.Gain(state.masterDelay.level);
        const masterMixOut = new Tone.Gain(1);
        masterCompNode.connect(masterDryGain);
        masterCompNode.connect(masterDelayNode);
        masterDelayNode.connect(masterDelayReturn);
        masterDryGain.connect(masterMixOut);
        masterDelayReturn.connect(masterMixOut);

        masterMixOut.output.connect(outputLimiterNode);
        outputLimiterNode.connect(audioContext.destination);
        updateState({ masterEqNode, masterCompNode, masterDelayNode, masterDelayReturn });

        setAudioContext(audioContext, masterGainNode, outputLimiterNode);

        // Master meter: tap from masterGainNode (read-only analysers)
        const masterSplitter = audioContext.createChannelSplitter(2);
        const masterAnalyserL = audioContext.createAnalyser();
        const masterAnalyserR = audioContext.createAnalyser();
        masterAnalyserL.fftSize = 256;
        masterAnalyserR.fftSize = 256;
        masterAnalyserL.smoothingTimeConstant = 0.6;
        masterAnalyserR.smoothingTimeConstant = 0.6;
        masterGainNode.connect(masterSplitter);
        masterSplitter.connect(masterAnalyserL, 0);
        masterSplitter.connect(masterAnalyserR, 1);
        updateState({
            masterAnalyserL, masterAnalyserR,
            masterMeterDataL: new Uint8Array(masterAnalyserL.fftSize),
            masterMeterDataR: new Uint8Array(masterAnalyserR.fftSize)
        });

        attachToneContext(audioContext);
        startMasterMeter();
        if (audioContext.state === 'suspended') {
            // AudioContext is suspended. Needs user interaction to resume.
        }
        return true;
    } catch (e) {
        renderFallbackUI("Web Audio API の初期化に失敗しました。");
        disableAppControls();
        setAudioContext(null, null);
        return false;
    }
}

export function setMasterParam(dottedKey, value) {
    const [group, param] = dottedKey.split('.');
    const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
    const nodeKey = `${stateKey}Node`;
    const stateObj = state[stateKey];
    const node = state[nodeKey];
    if (!stateObj || !param) return;

    stateObj[param] = value;

    if (node && state.audioContext) {
        try {
            if (group === 'eq') {
                node[param].setTargetAtTime(value, state.audioContext.currentTime, 0.01);
            } else if (group === 'comp') {
                node[param].setTargetAtTime(value, state.audioContext.currentTime, 0.01);
            } else if (group === 'delay') {
                if (param === 'level') {
                    state.masterDelayReturn?.gain?.setTargetAtTime?.(value, state.audioContext.currentTime, 0.01);
                } else if (param === 'time') {
                    node.delayTime.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
                } else {
                    node[param].setTargetAtTime(value, state.audioContext.currentTime, 0.01);
                }
            }
        } catch (e) { /* param not rampable */ }
    }
}

export function resumeAudioContext() {
    if (state.audioContext && state.audioContext.state === 'suspended') {
        return state.audioContext.resume().then(() => resumeToneAudio()).then(() => {
            document.body.removeEventListener('click', resumeAudioContext, { capture: true });
            document.body.removeEventListener('touchend', resumeAudioContext, { capture: true });
        }).catch(e => { /* Error resuming AudioContext */ });
    } else {
        document.body.removeEventListener('click', resumeAudioContext, { capture: true });
        document.body.removeEventListener('touchend', resumeAudioContext, { capture: true });
        return Promise.resolve();
    }
}

function recordStartMetric(soundId, requestedAt, startedAt) {
    if (!requestedAt || !startedAt) return;
    const sample = {
        soundId,
        inputToStartMs: startedAt - requestedAt,
        timestamp: startedAt,
        baseLatencyMs: state.audioContext?.baseLatency ? state.audioContext.baseLatency * 1000 : null,
        outputLatencyMs: state.audioContext?.outputLatency ? state.audioContext.outputLatency * 1000 : null,
        tone: getToneClockSnapshot()
    };
    state.audioStartMetrics.push(sample);
    if (state.audioStartMetrics.length > 200) state.audioStartMetrics.shift();
    window.__ponLatencySamples = state.audioStartMetrics;
}

// --- Audio Playback ---

const FADE_EASING_FUNCTIONS = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    sCurve: t => t * t * (3 - 2 * t)
};

/**
 * AudioParam にイージングカーブ付きのフェードをスケジュールする。
 * setValueCurveAtTime でサンプル配列を与えるため、任意の曲線（直線/イーズイン/アウト/インアウト）を表現可能。
 * fromVal/toVal は 0 を含むため exponentialRamp ではなく setValueCurve を使用（0 到達可）。
 */
function applyFadeCurve(param, fromVal, toVal, startTime, duration, easing) {
    const safeFrom = Number.isFinite(fromVal) ? fromVal : 0.0001;
    const safeTo = Number.isFinite(toVal) ? toVal : 0.0001;
    const safeDuration = Math.max(duration, MIN_GAIN_RAMP_SECONDS);
    const now = startTime;

    param.cancelScheduledValues(now);
    // 現在の開始値をピン留めし、カーブ開始前のクリックノイズを防止
    param.setValueAtTime(safeFrom, now);

    const fn = FADE_EASING_FUNCTIONS[easing] || FADE_EASING_FUNCTIONS.linear;
    const sampleStep = 0.005; // 5ms 粒度
    const samples = Math.max(2, Math.min(2048, Math.ceil(safeDuration / sampleStep)));
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        curve[i] = safeFrom + (safeTo - safeFrom) * fn(t);
    }
    param.setValueCurveAtTime(curve, now, safeDuration);
}

function scheduleNaturalFadeOut(soundId, currentPosition = 0) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo || !soundData || soundData.loop || !state.audioContext) return;

    const duration = audioInfo.audioBuffer?.duration || audioInfo.audioElement?.duration;
    const fadeDuration = Math.max(0, soundData.fadeOutDuration ?? 0);
    const remaining = duration - currentPosition;
    if (!Number.isFinite(remaining) || remaining <= 0 || fadeDuration <= 0) return;

    const now = state.audioContext.currentTime;
    const fadeInEndTime = now + Math.max(0, soundData.fadeInDuration ?? 0);
    const desiredStartTime = now + Math.max(0, remaining - fadeDuration);
    const fadeStartTime = Math.max(desiredStartTime, fadeInEndTime);
    const effectiveFadeDuration = now + remaining - fadeStartTime;
    if (effectiveFadeDuration <= 0) return;
    const startGain = Math.max(0.0001, soundData.volume ?? 1);
    applyFadeCurve(
        audioInfo.individualGain.gain,
        startGain,
        0.0001,
        fadeStartTime,
        effectiveFadeDuration,
        soundData.fadeOutEasing || 'linear'
    );
}

export async function playSound(soundId, soundButtonElement, clickTime = null, startOffset = 0) {
    if (!state.audioContext || state.audioContext.state !== 'running') { return; }

    if (state.activeAudios[soundId]) {
        // If it's already playing, we do nothing. The stop button should handle it.
        return;
    }

    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.audioId) { if (state.showErrorPopups) showAlert("サウンドデータが見つかりません。"); return; }

    let sourceNode;
    let audioElement = null;
    let objectUrl = null;
    let audioBuffer = null;

    try {
        if (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY) {
            const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
            const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;

            if (!blob) {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の音声データが見つかりません。`);
                return;
            }
            objectUrl = URL.createObjectURL(blob);
            audioElement = new Audio(objectUrl);
            audioElement.loop = soundData.loop;
            audioElement.preload = 'auto';
            audioElement.currentTime = Math.max(0, startOffset);
            sourceNode = state.audioContext.createMediaElementSource(audioElement);
            
            // For waveform, we still need the buffer
            try {
                const arrayBuffer = await blob.arrayBuffer();
                audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
            } catch (decodeError) {
                console.error("Error decoding audio for waveform in LOW_MEMORY mode:", decodeError);
            }

        } else { // HIGH_PERFORMANCE
            audioBuffer = state.decodedAudioBuffers[soundId];
            if (!audioBuffer) {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の音声データがキャッシュされていません。`);
                return;
            }
            sourceNode = state.audioContext.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.loop = soundData.loop;
        }

        const individualGain = state.audioContext.createGain();
        const effectRack = createEffectRack(soundData.effects);
        const splitter = state.audioContext.createChannelSplitter(2);
        const analyserL = state.audioContext.createAnalyser();
        const analyserR = state.audioContext.createAnalyser();

        let fftSizeMeter = state.performanceMode === PERFORMANCE_MODE.HIGH_PERFORMANCE ? ANALYSER_FFT_SIZE : 32;
        Object.assign(analyserL, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });
        Object.assign(analyserR, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });

        sourceNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        effectRack.exit.connect(state.masterGainNode);

        individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);

        state.activeAudios[soundId] = {
            audioElement, sourceNode, individualGain, effectRack,
            analyserL, analyserR, dataL: new Uint8Array(analyserL.fftSize), dataR: new Uint8Array(analyserR.fftSize),
            splitter, audioBuffer, waveformPeaks: audioBuffer ? precomputeWaveformPeaks(audioBuffer) : null,
            meterAnimationFrameId: null, progressBarInterval: null, isFadingOut: false, objectUrl: objectUrl,
            startTime: state.audioContext.currentTime - Math.max(0, startOffset),
            soundId: soundId,
            peakL: 0, peakR: 0
        };

        const onEnd = () => {
            const currentAudioInfo = state.activeAudios[soundId];
            if (currentAudioInfo && !currentAudioInfo.isFadingOut && !soundData.loop) {
                cleanupAfterStop(soundId, soundButtonElement);
            }
        };

        if (audioElement) { // LOW_MEMORY
            audioElement.onended = onEnd;
            audioElement.onerror = (e) => {
                const error = e.target?.error;
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の再生中にエラー(${error?.code || 'unknown'})が発生しました。`);
                stopSound(soundId, soundButtonElement, false);
            };
            audioElement.play().then(() => {
                updateButtonUI(soundId, soundButtonElement, true);
                createMeterElement(soundId, soundData.name);
                triggerWaveformUpdate();
                fadeInSound(soundId, soundData.volume);
                scheduleNaturalFadeOut(soundId, audioElement.currentTime);
                startProgressBarUpdate(soundId, soundButtonElement);
                startMeterUpdate(soundId);
            }).catch(err => {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の再生開始に失敗しました:
${err.message}`);
                cleanupAfterStop(soundId, soundButtonElement);
            });
        } else { // HIGH_PERFORMANCE
            sourceNode.onended = onEnd;
            const startedAt = performance.now();
            sourceNode.start(0, Math.max(0, startOffset));
            recordStartMetric(soundId, clickTime, startedAt);
            updateButtonUI(soundId, soundButtonElement, true);
            createMeterElement(soundId, soundData.name);
            triggerWaveformUpdate();
            fadeInSound(soundId, soundData.volume);
            scheduleNaturalFadeOut(soundId, Math.max(0, startOffset));
            startProgressBarUpdate(soundId, soundButtonElement);
            startMeterUpdate(soundId);
        }
    } catch (err) {
        console.error("Error in playSound:", err);
        if (state.showErrorPopups) showAlert('サウンドの再生準備中に予期せぬエラーが発生しました。');
        cleanupAfterStop(soundId, soundButtonElement);
    }
}

export function stopSound(soundId, soundButtonElement = null, useFadeOut = true) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.isFadingOut) return;

    if (!soundButtonElement) { soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`); }

    audioInfo.isFadingOut = true;

    if (audioInfo.meterAnimationFrameId) { cancelAnimationFrame(audioInfo.meterAnimationFrameId); }
    if (audioInfo.progressBarInterval) { clearInterval(audioInfo.progressBarInterval); }
    audioInfo.meterAnimationFrameId = null;
    audioInfo.progressBarInterval = null;
    triggerWaveformUpdate();

    const { audioElement, sourceNode, individualGain } = audioInfo;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const fadeOutDurationSeconds = useFadeOut
        ? Math.max(soundData?.fadeOutDuration ?? 0, MIN_STOP_FADE_SECONDS)
        : MIN_STOP_FADE_SECONDS;
    const fadeOutEasing = useFadeOut ? (soundData?.fadeOutEasing || 'linear') : 'linear';
    const currentGain = Number.isFinite(soundData?.volume)
        ? Math.max(0.0001, soundData.volume)
        : Math.max(0.0001, individualGain?.gain.value ?? 0.0001);

    const stopPlayback = () => {
        try {
            if (audioElement && !audioElement.paused) {
                audioElement.pause();
            }
            if (sourceNode && typeof sourceNode.stop === 'function') {
                sourceNode.stop();
            }
        } catch (e) { /* ignore */ }
        finally {
            cleanupAfterStop(soundId, soundButtonElement);
        }
    };

    if (state.audioContext && individualGain && currentGain > 0.0001) {
        applyFadeCurve(individualGain.gain, currentGain, 0.0001, state.audioContext.currentTime, fadeOutDurationSeconds, fadeOutEasing);
        setTimeout(stopPlayback, fadeOutDurationSeconds * 1000);
    } else {
        if (individualGain && state.audioContext) {
            individualGain.gain.cancelScheduledValues(state.audioContext.currentTime);
            individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
        }
        stopPlayback();
    }
}

export function stopAllSounds(fadeOut = true) {
    Object.keys(state.activeAudios).forEach(id => stopSound(id, null, fadeOut));
}

export function seekSound(soundId, seekTime) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !state.audioContext) return;

    if (audioInfo.audioElement) { // LOW_MEMORY
        audioInfo.individualGain.gain.cancelScheduledValues(state.audioContext.currentTime);
        audioInfo.individualGain.gain.setTargetAtTime(0.0001, state.audioContext.currentTime, MIN_STOP_FADE_SECONDS / 3);
        setTimeout(() => {
            if (!state.activeAudios[soundId]) return;
            audioInfo.audioElement.currentTime = seekTime;
            const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
            audioInfo.startTime = state.audioContext.currentTime - seekTime;
            fadeInSound(soundId, soundData?.volume ?? 1);
        }, MIN_STOP_FADE_SECONDS * 1000);
    } else if (audioInfo.audioBuffer) { // HIGH_PERFORMANCE
        // Seeking must not wait for the user-configured fade-out duration.
        stopSound(soundId, null, false);
        setTimeout(() => {
            const soundButton = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
            playSound(soundId, soundButton, performance.now(), seekTime);
        }, MIN_STOP_FADE_SECONDS * 1000);
    }
}

function fadeInSound(soundId, targetVolume) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !state.audioContext || !audioInfo.individualGain) return;
    const { individualGain } = audioInfo;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const fadeDurationSeconds = Math.max(soundData?.fadeInDuration ?? 0, MIN_GAIN_RAMP_SECONDS);
    const easing = soundData?.fadeInEasing || 'linear';
    const finalTargetVolume = Math.max(0.0001, targetVolume);
    const startTime = state.audioContext.currentTime;

    applyFadeCurve(individualGain.gain, 0.0001, finalTargetVolume, startTime, fadeDurationSeconds, easing);
}

export function updateActiveSoundEffects(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo?.effectRack || !soundData || !state.audioContext) return;
    applyEffectSettings(audioInfo.effectRack, soundData.effects, state.audioContext, false);
}

function cleanupAfterStop(soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];

    if (audioInfo) {
        if (audioInfo.sourceNode) {
            audioInfo.sourceNode.onended = null;
            try { audioInfo.sourceNode.disconnect(); } catch (e) { /* ignore */ }
        }
        if (audioInfo.audioElement) {
            audioInfo.audioElement.onended = null;
            audioInfo.audioElement.onerror = null;
            audioInfo.audioElement.src = '';
            audioInfo.audioElement.load();
            if (audioInfo.objectUrl) {
                URL.revokeObjectURL(audioInfo.objectUrl);
            }
        }
        try { audioInfo.individualGain?.disconnect(); } catch (e) { /* ignore */ }
        disposeEffectRack(audioInfo.effectRack);
        try { audioInfo.splitter?.disconnect(); } catch (e) { /* ignore */ }

        delete state.activeAudios[soundId];
    }

    if (!soundButtonElement) { soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`); }
    if (soundButtonElement) {
        updateButtonUI(soundId, soundButtonElement, false);
        resetProgressBar(soundButtonElement);
    }
    removeMeterElement(soundId);
    triggerWaveformUpdate();
}

export async function getAudioBufferFromDataUrl(soundId, dataUrl) {
    if (!state.audioContext) return null;
    if (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY) return null;
    if (state.decodedAudioBuffers[soundId]) return state.decodedAudioBuffers[soundId];
    
    try {
        const fetchResponse = await fetch(dataUrl);
        const arrayBuffer = await fetchResponse.arrayBuffer();
        const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        state.decodedAudioBuffers[soundId] = audioBuffer;
        return audioBuffer;
    } catch (error) {
        return null;
    }
}

// --- UI Update Loops (Progress, Meter, Waveform) ---

function startProgressBarUpdate(soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !soundButtonElement) return;

    const { audioElement, audioBuffer, startTime } = audioInfo;
    const progressBarValue = soundButtonElement.querySelector('.progress-bar-value');
    const timeDisplay = soundButtonElement.querySelector('.time-display');
    if (!progressBarValue || !timeDisplay) return;

    if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);

    const formatTime = (s) => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const duration = soundData?.duration || 0;

    const update = () => {
        if (!state.activeAudios[soundId] || !duration) {
            clearInterval(audioInfo.progressBarInterval);
            return;
        }
        let currentTime;
        if (audioElement) { // LOW_MEMORY mode
            currentTime = audioElement.currentTime;
        } else { // HIGH performance mode
            currentTime = (state.audioContext.currentTime - startTime) % duration;
        }

        progressBarValue.style.width = `${Math.min(100, (currentTime / duration) * 100)}%`;
        timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    };

    if (isFinite(duration)) {
        timeDisplay.textContent = `0:00 / ${formatTime(duration)}`;
    }
    update();
    audioInfo.progressBarInterval = setInterval(update, 250);
}

function startMeterUpdate(soundId) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.meterAnimationFrameId || !state.audioContext) return;

    const meterElement = dom.levelMeterArea?.querySelector(`.meter-pair[data-sound-id="${soundId}"]`);
    const leftValue = meterElement?.querySelector('.meter-bar.left .meter-value');
    const rightValue = meterElement?.querySelector('.meter-bar.right .meter-value');
    const leftPeak = meterElement?.querySelector('.meter-bar.left .meter-peak');
    const rightPeak = meterElement?.querySelector('.meter-bar.right .meter-peak');
    if (!leftValue || !rightValue) return;

    const { analyserL, analyserR, dataL, dataR } = audioInfo;
    let lastTime = performance.now();

    // Piecewise scale: -60..-12 dB → 0..55%, -12..0 dB → 55..100%.
    // Gives more visual space to the loud zone where clipping matters.
    const dbToPct = (rms) => {
        if (rms < 1e-6) return 0;
        const db = 20 * Math.log10(rms);
        if (db <= -60) return 0;
        if (db <= -12) return (db + 60) / 48 * 55;
        return 55 + (db + 12) / 12 * 45;
    };

    const loop = () => {
        if (!state.activeAudios[soundId] || state.activeAudios[soundId].isFadingOut) {
            leftValue.style.clipPath = 'inset(100% 0 0 0)';
            rightValue.style.clipPath = 'inset(100% 0 0 0)';
            if (leftPeak) leftPeak.style.bottom = '0%';
            if (rightPeak) rightPeak.style.bottom = '0%';
            audioInfo.peakL = 0;
            audioInfo.peakR = 0;
            audioInfo.meterAnimationFrameId = null;
            return;
        }

        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;

        analyserL.getByteTimeDomainData(dataL);
        analyserR.getByteTimeDomainData(dataR);

        let sumL = 0, sumR = 0;
        for (let i = 0; i < dataL.length; i++) {
            const vL = (dataL[i] - 128) / 128;
            const vR = (dataR[i] - 128) / 128;
            sumL += vL * vL;
            sumR += vR * vR;
        }
        const pctL = dbToPct(Math.sqrt(sumL / dataL.length));
        const pctR = dbToPct(Math.sqrt(sumR / dataR.length));

        leftValue.style.clipPath = `inset(${100 - pctL}% 0 0 0)`;
        rightValue.style.clipPath = `inset(${100 - pctR}% 0 0 0)`;

        // Peak-hold: holds max, decays at ~20 dB/s (~33%/s on -60..0 scale)
        const decay = 33 * dt;
        audioInfo.peakL = Math.max(pctL, audioInfo.peakL - decay);
        audioInfo.peakR = Math.max(pctR, audioInfo.peakR - decay);

        if (leftPeak) leftPeak.style.bottom = `${audioInfo.peakL}%`;
        if (rightPeak) rightPeak.style.bottom = `${audioInfo.peakR}%`;

        audioInfo.meterAnimationFrameId = requestAnimationFrame(loop);
    };
    audioInfo.meterAnimationFrameId = requestAnimationFrame(loop);
}

export function startMasterMeter() {
    if (state.masterMeterFrameId || !state.masterAnalyserL || !state.audioContext) return;
    const meterElement = dom.levelMeterArea?.querySelector('.master-meter');
    const leftValue = meterElement?.querySelector('.meter-bar.left .meter-value');
    const rightValue = meterElement?.querySelector('.meter-bar.right .meter-value');
    const leftPeak = meterElement?.querySelector('.meter-bar.left .meter-peak');
    const rightPeak = meterElement?.querySelector('.meter-bar.right .meter-peak');
    if (!leftValue || !rightValue) return;

    const dataL = state.masterMeterDataL;
    const dataR = state.masterMeterDataR;
    let lastTime = performance.now();

    // Piecewise scale: -60..-12 dB → 0..55%, -12..0 dB → 55..100%.
    // Gives more visual space to the loud zone where clipping matters.
    const dbToPct = (rms) => {
        if (rms < 1e-6) return 0;
        const db = 20 * Math.log10(rms);
        if (db <= -60) return 0;
        if (db <= -12) return (db + 60) / 48 * 55;
        return 55 + (db + 12) / 12 * 45;
    };

    const loop = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;

        state.masterAnalyserL.getByteTimeDomainData(dataL);
        state.masterAnalyserR.getByteTimeDomainData(dataR);

        let sumL = 0, sumR = 0;
        for (let i = 0; i < dataL.length; i++) {
            const vL = (dataL[i] - 128) / 128;
            const vR = (dataR[i] - 128) / 128;
            sumL += vL * vL;
            sumR += vR * vR;
        }
        const pctL = dbToPct(Math.sqrt(sumL / dataL.length));
        const pctR = dbToPct(Math.sqrt(sumR / dataR.length));

        leftValue.style.clipPath = `inset(${100 - pctL}% 0 0 0)`;
        rightValue.style.clipPath = `inset(${100 - pctR}% 0 0 0)`;

        const decay = 33 * dt;
        state.masterPeakL = Math.max(pctL, state.masterPeakL - decay);
        state.masterPeakR = Math.max(pctR, state.masterPeakR - decay);
        if (leftPeak) leftPeak.style.bottom = `${state.masterPeakL}%`;
        if (rightPeak) rightPeak.style.bottom = `${state.masterPeakR}%`;

        state.masterMeterFrameId = requestAnimationFrame(loop);
    };
    state.masterMeterFrameId = requestAnimationFrame(loop);
}

export function triggerWaveformUpdate() {
    if (!state.showWaveform) {
        stopWaveformDisplayLoop();
        clearWaveformDisplay();
        return;
    }
    const hasActiveSounds = Object.keys(state.activeAudios).some(id => !state.activeAudios[id].isFadingOut);
    if (hasActiveSounds && !state.isWaveformLoopRunning) {
        startWaveformDisplayLoop();
    } else if (!hasActiveSounds && state.isWaveformLoopRunning) {
        stopWaveformDisplayLoop();
    } else if (!hasActiveSounds && !state.isWaveformLoopRunning) {
        clearWaveformDisplay();
    }
}

function precomputeWaveformPeaks(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const peaksPerSecond = 500;
    const totalPeaks = Math.max(1, Math.ceil(duration * peaksPerSecond));
    const samplesPerPeak = Math.max(1, Math.floor(sampleRate / peaksPerSecond));
    const peaks = new Float32Array(totalPeaks * 2);

    for (let p = 0; p < totalPeaks; p++) {
        const start = p * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, channelData.length);
        let min = 1.0, max = -1.0;
        for (let i = start; i < end; i += WAVEFORM_DOWNSAMPLE) {
            const s = channelData[i];
            if (s < min) min = s;
            if (s > max) max = s;
        }
        peaks[p * 2] = min;
        peaks[p * 2 + 1] = max;
    }
    return { peaks, peaksPerSecond, duration };
}

function startWaveformDisplayLoop() {
    if (state.isWaveformLoopRunning || !dom.waveformCtx) return;

    updateState({ isWaveformLoopRunning: true });
    dom.waveformDisplayArea.style.display = 'flex';
    dom.levelMeterArea.classList.remove('no-waveform');

    // Cache CSS values outside the draw loop
    let cachedStyles = null;
    const refreshStyles = () => {
        const isDarkMode = document.body.classList.contains('dark-mode');
        const cs = getComputedStyle(document.documentElement);
        cachedStyles = {
            isDarkMode,
            bg: (isDarkMode ? cs.getPropertyValue('--waveform-bg-dark') : cs.getPropertyValue('--waveform-bg-light')).trim(),
            stroke: (isDarkMode ? cs.getPropertyValue('--primary-color-dark') : cs.getPropertyValue('--primary-color-light')).trim(),
            playhead: (isDarkMode ? cs.getPropertyValue('--waveform-playhead-dark') : cs.getPropertyValue('--waveform-playhead-light')).trim(),
            playheadWidth: parseFloat(cs.getPropertyValue('--waveform-playhead-width').trim()) || 2
        };
    };
    refreshStyles();

    function drawLoop() {
        if (!state.isWaveformLoopRunning) return;

        const { clientWidth: canvasWidth, clientHeight: canvasHeight } = dom.waveformCanvas;

        dom.waveformCtx.fillStyle = cachedStyles.bg;
        dom.waveformCtx.fillRect(0, 0, canvasWidth, canvasHeight);

        const activeSoundsInfo = Object.values(state.activeAudios).filter(info => !info.isFadingOut);
        if (activeSoundsInfo.length === 0) { stopWaveformDisplayLoop(); return; }

        dom.waveformCtx.strokeStyle = cachedStyles.stroke;
        dom.waveformCtx.lineWidth = 1;
        dom.waveformCtx.beginPath();

        for (let x = 0; x < canvasWidth; x++) {
            let summedMinPeak = 0;
            let summedMaxPeak = 0;
            let contributionCount = 0;

            // Pixel-snap: round base time to pixel grid so the same peak
            // maps to the same x every frame until the waveform advances
            // by a full pixel. Eliminates per-frame peak shimmer.
            const secondsPerPixel = WAVEFORM_SECONDS_AHEAD / canvasWidth;
            const timeOffsetFromLeftEdge = (x / canvasWidth) * WAVEFORM_SECONDS_AHEAD;

            for (const audioInfo of activeSoundsInfo) {
                const { audioBuffer, audioElement, waveformPeaks, individualGain, startTime } = audioInfo;
                if (!audioBuffer || !waveformPeaks) continue;

                const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === audioInfo.soundId);
                if (!soundData) continue;

                const gainValue = individualGain.gain.value;
                const duration = audioBuffer.duration;
                let rawBaseTime;

                if (audioElement) {
                    rawBaseTime = audioElement.currentTime;
                } else {
                    rawBaseTime = state.audioContext.currentTime - startTime;
                }

                // Snap to pixel grid
                const snappedBaseTime = Math.round(rawBaseTime / secondsPerPixel) * secondsPerPixel;
                let currentSoundBufferTime = snappedBaseTime + timeOffsetFromLeftEdge;

                if (soundData.loop && duration > 0) {
                    currentSoundBufferTime %= duration;
                }

                if (currentSoundBufferTime < 0 || currentSoundBufferTime >= duration) {
                    continue;
                }

                // Look up all peaks within this pixel's time range
                const peakIdxStart = Math.floor(currentSoundBufferTime * waveformPeaks.peaksPerSecond);
                const peakIdxEnd = Math.min(
                    Math.floor((currentSoundBufferTime + secondsPerPixel) * waveformPeaks.peaksPerSecond),
                    waveformPeaks.peaks.length / 2 - 1
                );

                let localMin = 1.0, localMax = -1.0;
                for (let pi = peakIdxStart; pi <= peakIdxEnd; pi++) {
                    const pBase = pi * 2;
                    if (pBase + 1 < waveformPeaks.peaks.length) {
                        localMin = Math.min(localMin, waveformPeaks.peaks[pBase]);
                        localMax = Math.max(localMax, waveformPeaks.peaks[pBase + 1]);
                    }
                }

                if (localMax >= localMin) {
                    summedMinPeak += localMin * gainValue;
                    summedMaxPeak += localMax * gainValue;
                    contributionCount++;
                }
            }

            let finalMinPeak = (contributionCount > 0) ? summedMinPeak / contributionCount : 0;
            let finalMaxPeak = (contributionCount > 0) ? summedMaxPeak / contributionCount : 0;

            const yMin = ((1 - finalMaxPeak) / 2) * canvasHeight;
            const yMax = ((1 - finalMinPeak) / 2) * canvasHeight;

            dom.waveformCtx.moveTo(x, yMin);
            dom.waveformCtx.lineTo(x, yMax);
        }
        dom.waveformCtx.stroke();

        dom.waveformCtx.strokeStyle = cachedStyles.playhead;
        dom.waveformCtx.lineWidth = cachedStyles.playheadWidth;
        dom.waveformCtx.beginPath();
        dom.waveformCtx.moveTo(0, 0);
        dom.waveformCtx.lineTo(0, canvasHeight);
        dom.waveformCtx.stroke();

        updateState({ waveformAnimationFrameId: requestAnimationFrame(drawLoop) });
    }
    updateState({ waveformAnimationFrameId: requestAnimationFrame(drawLoop) });
}

function stopWaveformDisplayLoop() {
    if (state.waveformAnimationFrameId) {
        cancelAnimationFrame(state.waveformAnimationFrameId);
        updateState({ waveformAnimationFrameId: null });
    }
    if (state.isWaveformLoopRunning) {
        updateState({ isWaveformLoopRunning: false });
        clearWaveformDisplay();
    }
}

function clearWaveformDisplay() {
    if (dom.waveformCtx && dom.waveformCanvas) {
        const { clientWidth: w, clientHeight: h } = dom.waveformCanvas;
        const isDarkMode = document.body.classList.contains('dark-mode');
        dom.waveformCtx.fillStyle = isDarkMode ? getComputedStyle(document.documentElement).getPropertyValue('--waveform-bg-dark').trim() : getComputedStyle(document.documentElement).getPropertyValue('--waveform-bg-light').trim();
        dom.waveformCtx.fillRect(0, 0, w, h);
        dom.waveformCtx.fillStyle = isDarkMode ? 'rgba(200, 200, 200, 0.6)' : 'rgba(100, 100, 100, 0.6)';
        dom.waveformCtx.font = "12px 'Noto Sans JP', sans-serif";
        dom.waveformCtx.textAlign = 'center';
        dom.waveformCtx.textBaseline = 'middle';
        dom.waveformCtx.fillText("再生中のサウンドはありません", w / 2, h / 2);
    }
    if (dom.levelMeterArea && !dom.levelMeterArea.classList.contains('no-waveform')) {
        dom.levelMeterArea.classList.add('no-waveform');
    }
}

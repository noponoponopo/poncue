// modules/06_audio.js

import { state, setAudioContext, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { showAlert, createMeterElement, removeMeterElement, updateButtonUI, resetProgressBar, setupCanvasResize } from './05_ui.js';
import { renderFallbackUI, disableAppControls } from './07_scenes.js';
import { ANALYSER_FFT_SIZE, WAVEFORM_SECONDS_AHEAD, WAVEFORM_DOWNSAMPLE, PERFORMANCE_MODE, MIN_GAIN_RAMP_SECONDS, MIN_STOP_FADE_SECONDS } from './01_config.js';
import { dbRequest } from './04_db.js';
import { applyEffectSettings, createEffectRack, disposeEffectRack, normalizeEffectSettings } from './09_effects.js';
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
        const masterInputNode = audioContext.createGain();
        const masterGainNode = audioContext.createGain();
        masterGainNode.gain.setValueAtTime(state.masterVolume, audioContext.currentTime);

        // Put distortion first so a neutral master EQ/compressor cannot alter
        // the waveform before this nonlinear stage.
        // Master chain: Distortion → EQ3 → Compressor → Reverb → [dry + delay] → volume → limiter
        attachToneContext(audioContext);
        const eqBridgeIn = new Tone.Gain(1);
        const masterEqNode = new Tone.EQ3({ low: state.masterEq.low, mid: state.masterEq.mid, high: state.masterEq.high, lowFrequency: 400, highFrequency: 2500 });
        masterInputNode.connect(eqBridgeIn.input);

        const masterDistortionNode = new Tone.Distortion({ distortion: state.masterDistortion.amount, wet: state.masterDistortion.amount > 0 ? 1 : 0 });
        eqBridgeIn.connect(masterDistortionNode);
        masterDistortionNode.connect(masterEqNode);

        const masterCompNode = new Tone.Compressor({ threshold: state.masterComp.threshold, ratio: state.masterComp.ratio, attack: 0.003, release: 0.12 });
        masterEqNode.connect(masterCompNode);

        // Reverb is transparent at its default wet value of zero.
        const masterReverbNode = new Tone.Reverb({ decay: state.masterReverb.decay, preDelay: 0.01, wet: state.masterReverb.wet });
        masterCompNode.connect(masterReverbNode);

        const masterDryGain = new Tone.Gain(1);
        const masterDelayNode = new Tone.FeedbackDelay({ delayTime: state.masterDelay.time, feedback: state.masterDelay.feedback, maxDelay: 2 });
        const masterDelayReturn = new Tone.Gain(state.masterDelay.level);
        const masterMixOut = new Tone.Gain(1);
        const outputLimiterNode = new Tone.Compressor({ threshold: state.masterLimiter.threshold, ratio: 20, knee: 0, attack: 0.001, release: 0.08 });
        const outputSafetyLimiterNode = new Tone.Compressor({ threshold: state.masterLimiter.threshold, ratio: 20, knee: 0, attack: 0, release: 0.03 });
        // Delay taps from reverb output — echoes are always shaped by the full chain
        masterReverbNode.connect(masterDryGain);
        masterReverbNode.connect(masterDelayNode);
        masterDelayNode.connect(masterDelayReturn);
        masterDryGain.connect(masterMixOut);
        masterDelayReturn.connect(masterMixOut);

        const masterPanNode = audioContext.createStereoPanner();
        masterPanNode.pan.setValueAtTime(Number.isFinite(state.masterPan.value) ? state.masterPan.value : 0, audioContext.currentTime);
        masterMixOut.output.connect(masterGainNode);
        masterGainNode.connect(masterPanNode);
        masterPanNode.connect(outputLimiterNode.input);
        outputLimiterNode.connect(outputSafetyLimiterNode);
        outputSafetyLimiterNode.output.connect(audioContext.destination);
        updateState({ masterEqNode, masterCompNode, masterDistortionNode, masterReverbNode, masterDelayNode, masterDelayReturn, masterPanNode, outputSafetyLimiterNode });

        setAudioContext(audioContext, masterGainNode, outputLimiterNode, masterInputNode);

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
        console.error('AudioContext initialization failed:', e);
        renderFallbackUI("Web Audio API の初期化に失敗しました。");
        disableAppControls();
        setAudioContext(null, null, null, null);
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
            } else if (group === 'pan') {
                node.pan.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
            } else if (group === 'distortion') {
                if (param === 'amount') {
                    try { node.distortion = value; } catch (e) { /* amount set directly */ }
                    node.wet.setTargetAtTime(value > 0 ? 1 : 0, state.audioContext.currentTime, 0.01);
                }
            } else if (group === 'reverb') {
                if (param === 'decay') {
                    try { node.decay = value; } catch (e) { /* decay triggers async regen */ }
                } else if (param === 'wet') {
                    node.wet.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
                }
            }
        } catch (e) { /* param not rampable */ }
    }
}

export function setMasterLimiterThreshold(value) {
    const threshold = Math.min(0, Math.max(-12, Number(value)));
    state.masterLimiter.threshold = threshold;
    if (state.outputLimiterNode?.threshold) {
        state.outputLimiterNode.threshold.rampTo(threshold, 0.01);
    }
    if (state.outputSafetyLimiterNode?.threshold) {
        state.outputSafetyLimiterNode.threshold.rampTo(threshold, 0.01);
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

function getCurrentSourcePosition(audioInfo) {
    if (audioInfo.audioElement) return audioInfo.audioElement.currentTime;
    return audioInfo.playbackPosition
        + (state.audioContext.currentTime - audioInfo.playbackPositionContextTime) * audioInfo.playbackRate;
}

function getCurrentPlaybackRate(audioInfo) {
    return audioInfo.audioElement ? audioInfo.audioElement.playbackRate : audioInfo.playbackRate;
}

export function getTrimBounds(sound, duration, reversed = false) {
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const configuredStart = Number.isFinite(sound?.trimStart) ? sound.trimStart : 0;
    const configuredEnd = Number.isFinite(sound?.trimEnd) ? sound.trimEnd : safeDuration;
    const start = Math.min(safeDuration, Math.max(0, configuredStart));
    const end = Math.min(safeDuration, Math.max(start, configuredEnd));
    if (!reversed) return { start, end, duration: end - start };
    return {
        start: safeDuration - end,
        end: safeDuration - start,
        duration: end - start
    };
}

function scheduleTrimBoundary(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
    if (!audioInfo || !soundData) return;

    clearTimeout(audioInfo.trimBoundaryTimeoutId);
    if (soundData.loop && !audioInfo.audioElement) return;
    const remaining = audioInfo.trimEnd - getCurrentSourcePosition(audioInfo);
    const rate = Math.max(0.25, getCurrentPlaybackRate(audioInfo) || 1);
    const handleBoundary = () => {
        const current = state.activeAudios[soundId];
        if (current !== audioInfo || audioInfo.isFadingOut) return;
        if (soundData.loop && audioInfo.audioElement) {
            audioInfo.audioElement.currentTime = audioInfo.trimStart;
            scheduleTrimBoundary(soundId);
        } else if (audioInfo.audioElement) {
            audioInfo.audioElement.pause();
            cleanupAfterStop(soundId, null);
        } else {
            audioInfo.sourceNode.stop();
        }
    };
    if (remaining <= 0.005) {
        handleBoundary();
        return;
    }
    audioInfo.trimBoundaryTimeoutId = setTimeout(handleBoundary, remaining / rate * 1000);
}

function cancelNaturalFadeOut(audioInfo, now) {
    const fadeStartTime = audioInfo.naturalFadeStartTime;
    if (!Number.isFinite(fadeStartTime)) return false;

    const gain = audioInfo.individualGain?.gain;
    if (!gain) return false;

    if (fadeStartTime <= now) {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        return true;
    }

    gain.cancelScheduledValues(fadeStartTime);
    return false;
}

function scheduleNaturalFadeOut(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo || !soundData || soundData.loop || audioInfo.isFadingOut || !state.audioContext) return;

    const now = state.audioContext.currentTime;
    const fadeWasInProgress = cancelNaturalFadeOut(audioInfo, now);
    audioInfo.naturalFadeStartTime = null;
    const duration = audioInfo.trimEnd;
    const fadeDuration = Math.max(0, soundData.fadeOutDuration ?? 0);
    const remaining = duration - getCurrentSourcePosition(audioInfo);
    const playbackRate = getCurrentPlaybackRate(audioInfo);
    if (!Number.isFinite(remaining) || remaining <= 0 || fadeDuration <= 0 || !Number.isFinite(playbackRate) || playbackRate <= 0) return;

    const playbackEndTime = now + remaining / playbackRate;
    const fadeInEndTime = audioInfo.fadeInEndTime ?? now;
    const desiredStartTime = playbackEndTime - fadeDuration;
    const fadeStartTime = Math.max(now, desiredStartTime, fadeInEndTime);
    const effectiveFadeDuration = playbackEndTime - fadeStartTime;
    if (effectiveFadeDuration <= 0) return;
    const startGain = fadeWasInProgress
        ? Math.max(0.0001, audioInfo.individualGain.gain.value)
        : Math.max(0.0001, soundData.volume ?? 1);
    applyFadeCurve(
        audioInfo.individualGain.gain,
        startGain,
        0.0001,
        fadeStartTime,
        effectiveFadeDuration,
        soundData.fadeOutEasing || 'linear'
    );
    audioInfo.naturalFadeStartTime = fadeStartTime;
}

export async function playSound(soundId, soundButtonElement, clickTime = null, startOffset = null) {
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
    let trimStart = 0;
    let trimEnd = 0;
    let playbackStart = 0;

    try {
        const wantsReverse = !!soundData.reverse;
        // reverse の場合は LOW_MEMORY でも BufferSource を使用（反転バッファが必要なため）
        const useBufferSource = state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY || wantsReverse;

        if (!useBufferSource) {
            const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
            const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;

            if (!blob) {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の音声データが見つかりません。`);
                return;
            }
            objectUrl = URL.createObjectURL(blob);
            audioElement = new Audio(objectUrl);
            audioElement.loop = false;
            audioElement.preservesPitch = Boolean(soundData.preservePitch);
            audioElement.playbackRate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
            audioElement.preload = 'auto';
            sourceNode = state.audioContext.createMediaElementSource(audioElement);

            // For waveform, we still need the buffer
            try {
                const arrayBuffer = await blob.arrayBuffer();
                audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
            } catch (decodeError) {
                console.error("Error decoding audio for waveform in LOW_MEMORY mode:", decodeError);
            }

            const trim = getTrimBounds(soundData, audioBuffer?.duration || soundData.duration, false);
            trimStart = trim.start;
            trimEnd = trim.end;
            playbackStart = Math.min(trimEnd, Math.max(trimStart, startOffset ?? trimStart));
            audioElement.currentTime = playbackStart;

        } else { // BufferSource 経路（HIGH_PERFORMANCE 常時、または reverse 時）
            let baseBuffer = state.decodedAudioBuffers[soundId];
            if (!baseBuffer && wantsReverse) {
                // LOW_MEMORY + reverse: blob からデコードしてキャッシュ
                const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
                const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
                if (!blob) {
                    if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の音声データが見つかりません。`);
                    return;
                }
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    baseBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
                    state.decodedAudioBuffers[soundId] = baseBuffer;
                } catch (decodeError) {
                    console.error("Error decoding audio for reverse:", decodeError);
                }
            }

            audioBuffer = wantsReverse
                ? getReversedAudioBuffer(soundId, baseBuffer)
                : baseBuffer;

            if (!audioBuffer) {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の音声データがキャッシュされていません。`);
                return;
            }
            const playbackRate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
            const trim = getTrimBounds(soundData, audioBuffer.duration, wantsReverse);
            trimStart = trim.start;
            trimEnd = trim.end;
            playbackStart = Math.min(trimEnd, Math.max(trimStart, startOffset ?? trimStart));
            sourceNode = new Tone.GrainPlayer({
                url: audioBuffer,
                loop: soundData.loop,
                loopStart: trimStart,
                loopEnd: trimEnd,
                playbackRate,
                detune: soundData.preservePitch ? 0 : 1200 * Math.log2(playbackRate)
            });
        }

        const pannerNode = state.audioContext.createStereoPanner();
        pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, state.audioContext.currentTime);
        const individualGain = state.audioContext.createGain();
        const effectRack = createEffectRack(soundData.effects);
        const splitter = state.audioContext.createChannelSplitter(2);
        const analyserL = state.audioContext.createAnalyser();
        const analyserR = state.audioContext.createAnalyser();

        let fftSizeMeter = state.performanceMode === PERFORMANCE_MODE.HIGH_PERFORMANCE ? ANALYSER_FFT_SIZE : 32;
        Object.assign(analyserL, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });
        Object.assign(analyserR, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });

        sourceNode.connect(pannerNode);
        pannerNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        effectRack.exit.connect(state.masterInputNode);

        individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);

        state.activeAudios[soundId] = {
            audioElement, sourceNode, pannerNode, individualGain, effectRack,
            analyserL, analyserR, dataL: new Uint8Array(analyserL.fftSize), dataR: new Uint8Array(analyserR.fftSize),
            splitter, audioBuffer, waveformPeaks: audioBuffer ? precomputeWaveformPeaks(audioBuffer) : null,
            meterAnimationFrameId: null, progressBarInterval: null, isFadingOut: false, objectUrl: objectUrl,
            playbackPosition: playbackStart,
            playbackPositionContextTime: state.audioContext.currentTime,
            playbackRate: Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1)),
            trimStart, trimEnd, trimBoundaryTimeoutId: null,
            fadeInEndTime: null, naturalFadeStartTime: null,
            soundId: soundId,
            peakL: 0, peakR: 0
        };

        if (audioElement) {
            const trimTimeUpdateHandler = () => {
                if (audioElement.currentTime >= trimEnd - 0.005) scheduleTrimBoundary(soundId);
            };
            state.activeAudios[soundId].trimTimeUpdateHandler = trimTimeUpdateHandler;
            audioElement.addEventListener('timeupdate', trimTimeUpdateHandler);
        }

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
                scheduleNaturalFadeOut(soundId);
                scheduleTrimBoundary(soundId);
                startProgressBarUpdate(soundId, soundButtonElement);
                startMeterUpdate(soundId);
            }).catch(err => {
                if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」の再生開始に失敗しました:
${err.message}`);
                cleanupAfterStop(soundId, soundButtonElement);
            });
        } else { // HIGH_PERFORMANCE
            if ('onended' in sourceNode) sourceNode.onended = onEnd;
            else sourceNode.onstop = onEnd;
            const startedAt = performance.now();
            sourceNode.start(0, playbackStart);
            recordStartMetric(soundId, clickTime, startedAt);
            updateButtonUI(soundId, soundButtonElement, true);
            createMeterElement(soundId, soundData.name);
            triggerWaveformUpdate();
            fadeInSound(soundId, soundData.volume);
            scheduleNaturalFadeOut(soundId);
            scheduleTrimBoundary(soundId);
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

// 即時停止（フェードなし）。retrigger の頭出し再再生で使用。
// 通常の stopSound は最低でも MIN_STOP_FADE_SECONDS の遅延が入るため、即座に playSound し直したい場合はこれを使う。
export function forceStopSound(soundId, soundButtonElement = null) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) return;
    if (audioInfo.meterAnimationFrameId) cancelAnimationFrame(audioInfo.meterAnimationFrameId);
    if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);
    try {
        if (audioInfo.audioElement && !audioInfo.audioElement.paused) audioInfo.audioElement.pause();
        if (audioInfo.sourceNode && typeof audioInfo.sourceNode.stop === 'function') audioInfo.sourceNode.stop();
    } catch (e) { /* ignore */ }
    cleanupAfterStop(soundId, soundButtonElement);
}

export function seekSound(soundId, seekTime) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !state.audioContext) return;

    if (audioInfo.audioElement) { // LOW_MEMORY
        audioInfo.naturalFadeStartTime = null;
        audioInfo.individualGain.gain.cancelScheduledValues(state.audioContext.currentTime);
        audioInfo.individualGain.gain.setTargetAtTime(0.0001, state.audioContext.currentTime, MIN_STOP_FADE_SECONDS / 3);
        setTimeout(() => {
            if (!state.activeAudios[soundId]) return;
            audioInfo.audioElement.currentTime = seekTime;
            const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
            fadeInSound(soundId, soundData?.volume ?? 1);
            scheduleNaturalFadeOut(soundId);
            scheduleTrimBoundary(soundId);
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
    audioInfo.fadeInEndTime = startTime + fadeDurationSeconds;
    audioInfo.naturalFadeStartTime = null;
}

export function updateActiveSoundEffects(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo?.effectRack || !soundData || !state.audioContext) return;
    applyEffectSettings(audioInfo.effectRack, soundData.effects, state.audioContext, false);
}

export function updateActiveSoundPan(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo?.pannerNode || !soundData || !state.audioContext) return;
    const pan = Number.isFinite(soundData.pan) ? soundData.pan : 0;
    audioInfo.pannerNode.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), state.audioContext.currentTime, 0.01);
}

export function updateActiveSoundSpeed(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!audioInfo || !soundData || !state.audioContext) return;
    const rate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
    if (!audioInfo.audioElement) {
        const now = state.audioContext.currentTime;
        audioInfo.playbackPosition += (now - audioInfo.playbackPositionContextTime) * audioInfo.playbackRate;
        audioInfo.playbackPositionContextTime = now;
        audioInfo.playbackRate = rate;
    }
    if (audioInfo.audioElement) {
        audioInfo.audioElement.preservesPitch = Boolean(soundData.preservePitch);
        audioInfo.audioElement.playbackRate = rate;
        scheduleTrimBoundary(soundId);
    } else if (audioInfo.sourceNode instanceof Tone.GrainPlayer) {
        audioInfo.sourceNode.playbackRate = rate;
        audioInfo.sourceNode.detune = soundData.preservePitch ? 0 : 1200 * Math.log2(rate);
    } else if (audioInfo.sourceNode?.playbackRate) {
        try {
            audioInfo.sourceNode.playbackRate.setTargetAtTime(rate, state.audioContext.currentTime, 0.05);
        } catch (e) {
            try { audioInfo.sourceNode.playbackRate.value = rate; } catch (_) { /* ignore */ }
        }
    }
    scheduleNaturalFadeOut(soundId);
}

export function updateActiveSoundLoop(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
    if (!audioInfo || !soundData) return;
    if (audioInfo.audioElement) {
        audioInfo.audioElement.loop = false;
        scheduleTrimBoundary(soundId);
    } else if (audioInfo.sourceNode instanceof Tone.GrainPlayer) {
        audioInfo.sourceNode.loopStart = audioInfo.trimStart;
        audioInfo.sourceNode.loopEnd = audioInfo.trimEnd;
        audioInfo.sourceNode.loop = soundData.loop;
    }
    scheduleNaturalFadeOut(soundId);
}

function cleanupAfterStop(soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];

    if (audioInfo) {
        if (audioInfo.sourceNode) {
            audioInfo.sourceNode.onended = null;
            if ('onstop' in audioInfo.sourceNode) audioInfo.sourceNode.onstop = () => {};
            try { audioInfo.sourceNode.disconnect(); } catch (e) { /* ignore */ }
            if (audioInfo.sourceNode instanceof Tone.GrainPlayer) audioInfo.sourceNode.dispose();
        }
        if (audioInfo.audioElement) {
            clearTimeout(audioInfo.trimBoundaryTimeoutId);
            audioInfo.audioElement.removeEventListener('timeupdate', audioInfo.trimTimeUpdateHandler);
            audioInfo.audioElement.onended = null;
            audioInfo.audioElement.onerror = null;
            audioInfo.audioElement.src = '';
            audioInfo.audioElement.load();
            if (audioInfo.objectUrl) {
                URL.revokeObjectURL(audioInfo.objectUrl);
            }
        }
        try { audioInfo.individualGain?.disconnect(); } catch (e) { /* ignore */ }
        try { audioInfo.pannerNode?.disconnect(); } catch (e) { /* ignore */ }
        disposeEffectRack(audioInfo.effectRack);
        try { audioInfo.splitter?.disconnect(); } catch (e) { /* ignore */ }

        delete state.activeAudios[soundId];
    }

    if (!soundButtonElement?.isConnected) {
        soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
    }
    if (soundButtonElement) {
        updateButtonUI(soundId, soundButtonElement, false);
        resetProgressBar(soundButtonElement);
    }
    removeMeterElement(soundId);
    triggerWaveformUpdate();
}

/**
 * 指定サウンドの逆再生用バッファを取得（キャッシュ）。
 * 元バッファのサンプルを逆順に並べ替えた新バッファを生成する。
 */
export function getReversedAudioBuffer(soundId, originalBuffer) {
    if (!originalBuffer) return null;
    const ctx = originalBuffer.context || state.audioContext;
    if (!ctx) return null;
    const cached = state.reversedAudioBuffers[soundId];
    if (cached && cached.length === originalBuffer.length && cached.sampleRate === originalBuffer.sampleRate) {
        return cached;
    }
    const reversed = ctx.createBuffer(originalBuffer.numberOfChannels, originalBuffer.length, originalBuffer.sampleRate);
    for (let ch = 0; ch < originalBuffer.numberOfChannels; ch++) {
        const src = originalBuffer.getChannelData(ch);
        const dst = reversed.getChannelData(ch);
        const len = src.length;
        for (let i = 0; i < len; i++) {
            dst[i] = src[len - 1 - i];
        }
    }
    state.reversedAudioBuffers[soundId] = reversed;
    return reversed;
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

/**
 * ITU-R BS.1770方式のK-weightingとゲーティングで統合ラウドネスを測定する。
 * HIGH_PERFORMANCE はキャッシュの AudioBuffer を使用、LOW_MEMORY は都度デコード。
 * 戻り値は { measuredLufs, targetLufs, recommendedVolume }、失敗時は null。
 */
export async function normalizeSoundVolume(soundId, targetLufs = -18) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.audioId || !state.audioContext || !Number.isFinite(targetLufs) || targetLufs < -70 || targetLufs > 0) return null;

    let audioBuffer = state.decodedAudioBuffers[soundId];
    if (!audioBuffer) {
        try {
            const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
            const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
            if (!blob) return null;
            const arrayBuffer = await blob.arrayBuffer();
            audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        } catch (e) {
            return null;
        }
    }
    if (!audioBuffer) return null;

    const measuredLufs = await measureIntegratedLufs(audioBuffer);
    if (!Number.isFinite(measuredLufs)) return null;

    const loudnessGain = 10 ** ((targetLufs - measuredLufs) / 20);
    const limiterSettings = normalizeEffectSettings(soundData.effects).limiter;
    let recommendedVolume = loudnessGain;
    let limitedByPeak = false;
    if (limiterSettings.enabled) {
        let samplePeak = 0;
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) samplePeak = Math.max(samplePeak, Math.abs(data[i]));
        }
        if (samplePeak > 0) {
            const peakSafeGain = 10 ** (limiterSettings.threshold / 20) / samplePeak;
            recommendedVolume = Math.min(loudnessGain, peakSafeGain);
            limitedByPeak = recommendedVolume < loudnessGain;
        }
    }
    soundData.volume = recommendedVolume;

    const activeAudio = state.activeAudios[soundId];
    if (activeAudio?.individualGain && !activeAudio.isFadingOut) {
        activeAudio.individualGain.gain.setTargetAtTime(recommendedVolume, state.audioContext.currentTime, 0.01);
    }

    return {
        measuredLufs,
        targetLufs,
        achievedLufs: measuredLufs + 20 * Math.log10(recommendedVolume),
        recommendedVolume,
        limitedByPeak
    };
}

export async function analyzeAndApplySilenceTrim(soundId, thresholdDb = -50, paddingSeconds = 0.02) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
    if (!soundData?.audioId || !state.audioContext) return null;

    const safeThresholdDb = Math.min(-20, Math.max(-80, Number(thresholdDb) || -50));
    let audioBuffer = state.decodedAudioBuffers[soundId];
    if (!audioBuffer) {
        try {
            const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
            const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
            if (!blob) return null;
            audioBuffer = await state.audioContext.decodeAudioData(await blob.arrayBuffer());
        } catch (_) {
            return null;
        }
    }
    if (!audioBuffer?.length || !audioBuffer.numberOfChannels) return null;

    const threshold = 10 ** (safeThresholdDb / 20);
    const frameSize = Math.max(1, Math.round(audioBuffer.sampleRate * 0.01));
    let firstActiveSample = -1;
    let lastActiveSample = -1;

    for (let frameStart = 0; frameStart < audioBuffer.length; frameStart += frameSize) {
        const frameEnd = Math.min(audioBuffer.length, frameStart + frameSize);
        let highestRms = 0;
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            const samples = audioBuffer.getChannelData(channel);
            let sumSquares = 0;
            for (let sample = frameStart; sample < frameEnd; sample++) {
                sumSquares += samples[sample] * samples[sample];
            }
            highestRms = Math.max(highestRms, Math.sqrt(sumSquares / (frameEnd - frameStart)));
        }
        if (highestRms >= threshold) {
            if (firstActiveSample < 0) firstActiveSample = frameStart;
            lastActiveSample = frameEnd;
        }
    }

    if (firstActiveSample < 0 || lastActiveSample <= firstActiveSample) {
        return { silent: true, thresholdDb: safeThresholdDb, duration: audioBuffer.duration };
    }

    const padding = Math.max(0, Math.min(0.25, Number(paddingSeconds) || 0));
    const trimStart = Math.max(0, firstActiveSample / audioBuffer.sampleRate - padding);
    const trimEnd = Math.min(audioBuffer.duration, lastActiveSample / audioBuffer.sampleRate + padding);
    forceStopSound(soundId);
    soundData.trimStart = trimStart;
    soundData.trimEnd = trimEnd;
    soundData.trimThresholdDb = safeThresholdDb;

    return {
        silent: false,
        thresholdDb: safeThresholdDb,
        trimStart,
        trimEnd,
        duration: trimEnd - trimStart,
        removedStart: trimStart,
        removedEnd: audioBuffer.duration - trimEnd,
        originalDuration: audioBuffer.duration
    };
}

export function clearSilenceTrim(soundId) {
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
    if (!soundData) return false;
    forceStopSound(soundId);
    delete soundData.trimStart;
    delete soundData.trimEnd;
    delete soundData.trimThresholdDb;
    return true;
}

async function measureIntegratedLufs(audioBuffer) {
    const offline = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate
    );
    const source = offline.createBufferSource();
    const shelf = offline.createBiquadFilter();
    const highpass = offline.createBiquadFilter();
    source.buffer = audioBuffer;
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681.974;
    shelf.gain.value = 4;
    highpass.type = 'highpass';
    highpass.frequency.value = 38.135;
    highpass.Q.value = 0.5;
    source.connect(shelf).connect(highpass).connect(offline.destination);
    source.start();
    const weighted = await offline.startRendering();

    const blockSize = Math.max(1, Math.round(weighted.sampleRate * 0.4));
    const stepSize = Math.max(1, Math.round(weighted.sampleRate * 0.1));
    const channelWeights = [1, 1, 1, 0, 1.41, 1.41];
    const energies = [];
    for (let start = 0; start < weighted.length; start += stepSize) {
        const end = Math.min(start + blockSize, weighted.length);
        if (end - start < Math.min(blockSize, weighted.length)) break;
        let energy = 0;
        for (let ch = 0; ch < weighted.numberOfChannels; ch++) {
            const data = weighted.getChannelData(ch);
            let sum = 0;
            for (let i = start; i < end; i++) sum += data[i] * data[i];
            energy += (channelWeights[ch] ?? 1) * sum / (end - start);
        }
        if (energy > 0) energies.push(energy);
    }
    if (energies.length === 0) return -Infinity;

    const loudness = energy => -0.691 + 10 * Math.log10(energy);
    const absoluteGated = energies.filter(energy => loudness(energy) >= -70);
    if (absoluteGated.length === 0) return -Infinity;
    const absoluteMean = absoluteGated.reduce((sum, energy) => sum + energy, 0) / absoluteGated.length;
    const relativeGate = loudness(absoluteMean) - 10;
    const relativeGated = absoluteGated.filter(energy => loudness(energy) >= relativeGate);
    const integratedEnergy = relativeGated.reduce((sum, energy) => sum + energy, 0) / relativeGated.length;
    return loudness(integratedEnergy);
}

// --- UI Update Loops (Progress, Meter, Waveform) ---

function startProgressBarUpdate(soundId, soundButtonElement) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !soundButtonElement) return;

    const { audioElement, audioBuffer } = audioInfo;

    if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);

    const formatTime = (s) => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const duration = Math.max(0, audioInfo.trimEnd - audioInfo.trimStart);

    const update = () => {
        if (!state.activeAudios[soundId] || !duration) {
            clearInterval(audioInfo.progressBarInterval);
            return;
        }
        if (!soundButtonElement?.isConnected) {
            soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
        }
        const progressBarValue = soundButtonElement?.querySelector('.progress-bar-value');
        const timeDisplay = soundButtonElement?.querySelector('.time-display');
        if (!progressBarValue || !timeDisplay) return;

        const sourcePosition = getCurrentSourcePosition(audioInfo);
        const elapsed = sourcePosition - audioInfo.trimStart;
        const currentTime = soundData?.loop
            ? ((elapsed % duration) + duration) % duration
            : Math.min(duration, Math.max(0, elapsed));

        progressBarValue.style.width = `${Math.min(100, (currentTime / duration) * 100)}%`;
        timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    };

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
                const { audioBuffer, waveformPeaks, individualGain } = audioInfo;
                if (!audioBuffer || !waveformPeaks) continue;

                const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === audioInfo.soundId);
                if (!soundData) continue;

                const gainValue = individualGain.gain.value;
                const trimStart = audioInfo.trimStart ?? 0;
                const trimEnd = audioInfo.trimEnd ?? audioBuffer.duration;
                const duration = trimEnd - trimStart;
                const rawBaseTime = getCurrentSourcePosition(audioInfo);
                const playbackRate = getCurrentPlaybackRate(audioInfo);

                // The canvas always represents the next five seconds of real playback.
                const sourceSecondsPerPixel = secondsPerPixel * playbackRate;
                const snappedBaseTime = Math.round(rawBaseTime / sourceSecondsPerPixel) * sourceSecondsPerPixel;
                let currentSoundBufferTime = snappedBaseTime + timeOffsetFromLeftEdge * playbackRate;

                if (soundData.loop && duration > 0) {
                    currentSoundBufferTime = trimStart + (((currentSoundBufferTime - trimStart) % duration) + duration) % duration;
                }

                if (currentSoundBufferTime < trimStart || currentSoundBufferTime >= trimEnd) {
                    continue;
                }

                // Look up all peaks within this pixel's time range
                const peakIdxStart = Math.floor(currentSoundBufferTime * waveformPeaks.peaksPerSecond);
                const peakIdxEnd = Math.min(
                    Math.floor((currentSoundBufferTime + sourceSecondsPerPixel) * waveformPeaks.peaksPerSecond),
                    Math.floor(trimEnd * waveformPeaks.peaksPerSecond),
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

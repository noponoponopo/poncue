// modules/06_audio.js

import { state, setAudioContext, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { showAlert, createMeterElement, removeMeterElement, updateButtonUI, updateSustainLayerBadge, resetProgressBar, setupCanvasResize } from './05_ui.js';
import { renderFallbackUI, disableAppControls } from './07_scenes.js';
import { ANALYSER_FFT_SIZE, WAVEFORM_SECONDS_AHEAD, WAVEFORM_DOWNSAMPLE, PERFORMANCE_MODE, MIN_GAIN_RAMP_SECONDS, MIN_STOP_FADE_SECONDS, MUTE_FADE_SECONDS, ROLL_CROSSFADE_SECONDS, ROLL_SCHEDULER_INTERVAL_MS, ROLL_SCHEDULER_LOOKAHEAD_SECONDS } from './01_config.js';
import { dbRequest } from './04_db.js';
import { applyEffectSettings, createEffectRack, disposeEffectRack, normalizeEffectSettings } from './09_effects.js';
import { attachToneContext, getToneClockSnapshot, resumeToneAudio } from './10_tone_transport.js';
import { setKeyboardKeyProgress } from './11_keyboard_view.js';
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

/**
 * state に保持されているマスター効果の値を、実際のオーディオノードへ反映する。
 *
 * 初期化順序の問題を補うための関数:
 *   initializeApp() は initAudioContext() → loadSettings() の順に呼ぶ。
 *   initAudioContext() はノード生成時に state.masterEq などを参照するが、
 *   この時点では設定未読み込みのためデフォルト値(フラット)でノードが作られる。
 *   その後 loadSettings() が state を復元するが、ノードへの再反映が漏れていたため、
 *   リロード後にマスターEQ等が効かない現象が起きていた。
 *
 * この関数は loadSettings() の state 復元後に呼ぶことで、
 * 保存済みの全マスター効果をノードへ確実に適用する。
 * setMasterParam は state の再代入(冪等)も行うが、値は既に正しいので無害。
 */
export function applyMasterEffectNodesFromState() {
    if (!state.audioContext) return;
    setMasterParam('eq.low', state.masterEq?.low ?? 0);
    setMasterParam('eq.mid', state.masterEq?.mid ?? 0);
    setMasterParam('eq.high', state.masterEq?.high ?? 0);
    setMasterParam('comp.threshold', state.masterComp?.threshold ?? 0);
    setMasterParam('comp.ratio', state.masterComp?.ratio ?? 1);
    setMasterParam('delay.time', state.masterDelay?.time ?? 0.18);
    setMasterParam('delay.feedback', state.masterDelay?.feedback ?? 0);
    setMasterParam('delay.level', state.masterDelay?.level ?? 0);
    setMasterParam('pan.value', state.masterPan?.value ?? 0);
    setMasterParam('distortion.amount', state.masterDistortion?.amount ?? 0);
    setMasterParam('reverb.decay', state.masterReverb?.decay ?? 2.0);
    setMasterParam('reverb.wet', state.masterReverb?.wet ?? 0);
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

export function supportsAudioOutputSelection() {
    return typeof state.audioContext?.setSinkId === 'function';
}

export async function listAudioOutputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'audiooutput');
}

export async function setAudioOutputDevice(deviceId = 'default', label = '', options = {}) {
    const requestedId = deviceId || 'default';
    const commitState = options?.commitState !== false;
    const outputLabel = label || (requestedId === 'default' ? 'システム既定' : '選択した出力');
    if (!supportsAudioOutputSelection()) {
        if (requestedId !== 'default') throw new Error('このブラウザは音声出力先の変更に対応していません。');
        if (commitState) updateState({ audioOutputDeviceId: 'default', audioOutputDeviceLabel: outputLabel, audioOutputPending: false });
        return false;
    }

    await state.audioContext.setSinkId(requestedId === 'default' ? '' : requestedId);
    if (commitState) {
        updateState({
            audioOutputDeviceId: requestedId,
            audioOutputDeviceLabel: outputLabel,
            audioOutputPending: false
        });
    }
    return true;
}

export async function chooseAudioOutputDevice() {
    if (typeof navigator.mediaDevices?.selectAudioOutput !== 'function') {
        throw new Error('OSの出力選択ダイアログはこのブラウザで利用できません。');
    }
    return navigator.mediaDevices.selectAudioOutput();
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

function formatPlaybackTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = Math.floor(safeSeconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function updatePausedProgress(soundId, soundButtonElement, position) {
    const button = soundButtonElement?.isConnected
        ? soundButtonElement
        : dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    const duration = sound?.duration;
    if (!button || !Number.isFinite(duration) || duration <= 0) return;

    const currentTime = sound.loop ? position % duration : Math.min(duration, position);
    const progress = button.querySelector('.progress-bar-value');
    const timeDisplay = button.querySelector('.time-display');
    if (progress) progress.style.width = `${Math.min(100, currentTime / duration * 100)}%`;
    if (timeDisplay) timeDisplay.textContent = `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`;
}

export function updatePauseAllButton() {
    const pauseAllButton = dom.pauseAllBtn;
    if (!pauseAllButton) return;

    const hasActiveSounds = Object.values(state.activeAudios).some(audio => !audio.isFadingOut);
    const hasPausedSounds = Object.keys(state.pausedSounds).length > 0;
    const resumeAll = !hasActiveSounds && hasPausedSounds;
    const icon = pauseAllButton.querySelector('i');
    const label = pauseAllButton.querySelector('span');
    pauseAllButton.disabled = !hasActiveSounds && !hasPausedSounds;
    pauseAllButton.title = resumeAll ? '一時停止中のサウンドを再開' : '再生中のサウンドを一時停止';
    pauseAllButton.setAttribute('aria-label', resumeAll ? '全てのサウンドを再開' : '全てのサウンドを一時停止');
    if (icon) {
        icon.classList.toggle('fa-pause', !resumeAll);
        icon.classList.toggle('fa-play', resumeAll);
    }
    if (label) label.textContent = resumeAll ? '再開' : '一時停止';
}

function getCurrentPlaybackRate(audioInfo) {
    return audioInfo.audioElement ? audioInfo.audioElement.playbackRate : audioInfo.playbackRate;
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
    if (!audioInfo || !soundData) return;
    scheduleNaturalFadeOutFor(audioInfo, soundData);
}

// 終端の自然フェードアウトをスケジュールする。playSound 本体と sustain レイヤーで共用。
// voice は individualGain / fadeInEndTime / naturalFadeStartTime / 再生位置情報を持つオブジェクト。
function scheduleNaturalFadeOutFor(voice, soundData) {
    if (soundData.loop || voice.isRoll || voice.isFadingOut || !state.audioContext) return;

    const now = state.audioContext.currentTime;
    const fadeWasInProgress = cancelNaturalFadeOut(voice, now);
    voice.naturalFadeStartTime = null;
    const duration = voice.audioBuffer?.duration || voice.audioElement?.duration;
    const fadeDuration = Math.max(0, soundData.fadeOutDuration ?? 0);
    const remaining = duration - getCurrentSourcePosition(voice);
    const playbackRate = getCurrentPlaybackRate(voice);
    if (!Number.isFinite(remaining) || remaining <= 0 || fadeDuration <= 0 || !Number.isFinite(playbackRate) || playbackRate <= 0) return;

    const playbackEndTime = now + remaining / playbackRate;
    const fadeInEndTime = voice.fadeInEndTime ?? now;
    const desiredStartTime = playbackEndTime - fadeDuration;
    const fadeStartTime = Math.max(now, desiredStartTime, fadeInEndTime);
    const effectiveFadeDuration = playbackEndTime - fadeStartTime;
    if (effectiveFadeDuration <= 0) return;
    const startGain = fadeWasInProgress
        ? Math.max(0.0001, voice.individualGain.gain.value)
        : Math.max(0.0001, soundData.volume ?? 1);
    applyFadeCurve(
        voice.individualGain.gain,
        startGain,
        0.0001,
        fadeStartTime,
        effectiveFadeDuration,
        soundData.fadeOutEasing || 'linear'
    );
    voice.naturalFadeStartTime = fadeStartTime;
}

// playSound / sustain レイヤー共通の音源ノード生成。
// LOW_MEMORY では <audio> 要素、それ以外（または逆再生時）は GrainPlayer を返す。
// 戻り値は { sourceNode, audioElement, objectUrl, audioBuffer } または { error }。
async function createSoundSourceNodes(soundData) {
    const wantsReverse = !!soundData.reverse;
    // reverse の場合は LOW_MEMORY でも BufferSource を使用（反転バッファが必要なため）
    const useBufferSource = state.performanceMode !== PERFORMANCE_MODE.LOW_MEMORY || wantsReverse;

    if (!useBufferSource) {
        const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
        const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;

        if (!blob) return { error: `サウンド「${soundData.name}」の音声データが見つかりません。` };
        const objectUrl = URL.createObjectURL(blob);
        const audioElement = new Audio(objectUrl);
        audioElement.loop = soundData.loop;
        audioElement.preservesPitch = Boolean(soundData.preservePitch);
        audioElement.playbackRate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
        audioElement.preload = 'auto';
        const sourceNode = state.audioContext.createMediaElementSource(audioElement);

        // For waveform, we still need the buffer
        let audioBuffer = null;
        try {
            const arrayBuffer = await blob.arrayBuffer();
            audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        } catch (decodeError) {
            console.error("Error decoding audio for waveform in LOW_MEMORY mode:", decodeError);
        }
        return { sourceNode, audioElement, objectUrl, audioBuffer };
    }

    // BufferSource 経路（HIGH_PERFORMANCE 常時、または reverse 時）
    let baseBuffer = state.decodedAudioBuffers[soundData.id];
    if (!baseBuffer && wantsReverse) {
        // LOW_MEMORY + reverse: blob からデコードしてキャッシュ
        const audioRecord = await dbRequest('audio_files', 'readonly', 'get', soundData.audioId);
        const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
        if (!blob) return { error: `サウンド「${soundData.name}」の音声データが見つかりません。` };
        try {
            const arrayBuffer = await blob.arrayBuffer();
            baseBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
            state.decodedAudioBuffers[soundData.id] = baseBuffer;
        } catch (decodeError) {
            console.error("Error decoding audio for reverse:", decodeError);
        }
    }

    const audioBuffer = wantsReverse
        ? getReversedAudioBuffer(soundData.id, baseBuffer)
        : baseBuffer;

    if (!audioBuffer) return { error: `サウンド「${soundData.name}」の音声データがキャッシュされていません。` };
    const playbackRate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
    const sourceNode = new Tone.GrainPlayer({
        url: audioBuffer,
        loop: soundData.loop,
        playbackRate,
        detune: soundData.preservePitch ? 0 : 1200 * Math.log2(playbackRate)
    });
    return { sourceNode, audioElement: null, objectUrl: null, audioBuffer };
}

export async function playSound(soundId, soundButtonElement, clickTime = null, startOffset = 0) {
    if (!state.audioContext || state.audioContext.state !== 'running') { return; }

    // Starting from a pad always supersedes a previously paused position.
    delete state.pausedSounds[soundId];

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
        const created = await createSoundSourceNodes(soundData);
        if (created.error) {
            if (state.showErrorPopups) showAlert(created.error);
            return;
        }
        ({ sourceNode, audioElement, objectUrl, audioBuffer } = created);
        if (audioElement) audioElement.currentTime = Math.max(0, startOffset);

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
            muted: false,
            progressPercent: 0,
            stopAfterLoop: false,
            loopStopTime: null,
            playbackPosition: Math.max(0, startOffset),
            playbackPositionContextTime: state.audioContext.currentTime,
            playbackRate: Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1)),
            fadeInEndTime: null, naturalFadeStartTime: null,
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
                updatePauseAllButton();
                createMeterElement(soundId, soundData.name);
                triggerWaveformUpdate();
                fadeInSound(soundId, soundData.volume);
                scheduleNaturalFadeOut(soundId);
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
            sourceNode.start(0, Math.max(0, startOffset));
            recordStartMetric(soundId, clickTime, startedAt);
            updateButtonUI(soundId, soundButtonElement, true);
            updatePauseAllButton();
            createMeterElement(soundId, soundData.name);
            triggerWaveformUpdate();
            fadeInSound(soundId, soundData.volume);
            scheduleNaturalFadeOut(soundId);
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
    stopSustainLayers(soundId, useFadeOut); // sustain モードの重ね再生ボイスも道連れに停止
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) {
        if (!state.pausedSounds[soundId]) return;
        delete state.pausedSounds[soundId];
        if (!soundButtonElement) soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
        updateButtonUI(soundId, soundButtonElement, false);
        resetProgressBar(soundButtonElement);
        updatePauseAllButton();
        return;
    }
    if (audioInfo.isFadingOut) return;

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
            if (audioInfo.isRoll) stopRollSources(audioInfo);
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
    // 本体が自然終了済みでレイヤーだけ残っているケース（stopSound 経由で消えない）への対応
    Object.keys(state.sustainLayers).forEach(id => stopSustainLayers(id, fadeOut));
    Object.keys(state.pausedSounds).forEach(id => stopSound(id, null, false));
}

// 即時停止（フェードなし）。retrigger の頭出し再再生で使用。
// 通常の stopSound は最低でも MIN_STOP_FADE_SECONDS の遅延が入るため、即座に playSound し直したい場合はこれを使う。
export function forceStopSound(soundId, soundButtonElement = null) {
    stopSustainLayers(soundId, false);
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) return;
    if (audioInfo.meterAnimationFrameId) cancelAnimationFrame(audioInfo.meterAnimationFrameId);
    if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);
    try {
        if (audioInfo.audioElement && !audioInfo.audioElement.paused) audioInfo.audioElement.pause();
        if (audioInfo.sourceNode && typeof audioInfo.sourceNode.stop === 'function') audioInfo.sourceNode.stop();
    } catch (e) { /* ignore */ }
    if (audioInfo.isRoll) stopRollSources(audioInfo);
    cleanupAfterStop(soundId, soundButtonElement);
}

// --- 可変長ドラムロール（roll）: 起こり→ループ(複数パートを順に循環)→終わり→締め のパート連結再生 ---

// パート音声のキャッシュキー（decodedAudioBuffers は通常サウンドを soundId で持つため接尾辞で区別する）
// part は 'intro' / 'loop:0' / 'end' / 'finish'
export function rollPartCacheKey(soundId, part) {
    return `${soundId}:${part}`;
}

// パート音声の AudioBuffer を取得。キャッシュが無ければDBのblobからデコードする。
// ロールはパート切替の無音隙を防ぐため、パフォーマンスモードに関わらず必ずバッファ再生する。
async function getRollPartBuffer(cacheKey, audioId, soundName) {
    if (!audioId || !state.audioContext) return null;
    if (state.decodedAudioBuffers[cacheKey]) return state.decodedAudioBuffers[cacheKey];
    try {
        const audioRecord = await dbRequest('audio_files', 'readonly', 'get', audioId);
        const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
        if (!blob) return null;
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        state.decodedAudioBuffers[cacheKey] = audioBuffer;
        return audioBuffer;
    } catch (error) {
        console.error(`Failed to decode roll part "${cacheKey}" of ${soundName}:`, error);
        return null;
    }
}

// シーン選択時の事前デコード。LOW_MEMORY は初回再生時にデコードする。
export async function preloadRollParts(soundData) {
    if (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY) return;
    const rollParts = soundData?.rollParts || {};
    const tasks = [];
    if (rollParts.intro) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'intro'), rollParts.intro, soundData.name));
    (rollParts.loops || []).forEach((audioId, index) => {
        if (audioId) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, `loop:${index}`), audioId, soundData.name));
    });
    if (rollParts.end) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'end'), rollParts.end, soundData.name));
    if (rollParts.finish) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'finish'), rollParts.finish, soundData.name));
    await Promise.all(tasks);
}

// ロールの全パートソースを即座に停止・切断する（フェードは individualGain 側で行う）
function stopRollSources(audioInfo) {
    if (!audioInfo?.scheduled) return;
    for (const item of audioInfo.scheduled) {
        item.source.onended = null;
        try { item.source.stop(0); } catch (e) { /* 未開始・既終了のソース */ }
        try { item.source.disconnect(); } catch (e) { /* ignore */ }
        try { item.gain.disconnect(); } catch (e) { /* ignore */ }
    }
    audioInfo.scheduled = [];
}

// パートバッファの波形ピークはロールでは使用しない（波形表示・プログレス更新の対象外のため）

// チェーンの1パートを生成し、名目開始時刻（オーディオクロック）から再生する。
// 直前パートとの継ぎ目は ROLL_CROSSFADE_SECONDS 秒の微小クロスフェードにする:
// 前パートは自然に鳴り終わる直前にフェードアウトし、新パートは継ぎ目直前からフェードインする。
function scheduleRollChainItem(info, kind, buffer, nominalStart, isTerminal) {
    const ctx = state.audioContext;
    const crossfade = Math.min(ROLL_CROSSFADE_SECONDS, buffer.duration / 2);
    const prev = info.scheduled[info.scheduled.length - 1] || null;
    const sourceStart = prev
        ? Math.max(nominalStart - crossfade, ctx.currentTime)
        : Math.max(nominalStart, ctx.currentTime);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(info.pannerNode);

    const item = {
        kind, buffer, source, gain,
        sourceStart,
        nominalStart,
        nominalEnd: nominalStart + buffer.duration
    };

    const boundary = Math.max(nominalStart, sourceStart);
    if (prev) {
        gain.gain.setValueAtTime(0.0001, sourceStart);
        gain.gain.linearRampToValueAtTime(1, boundary);
        prev.gain.gain.setValueAtTime(1, sourceStart);
        prev.gain.gain.linearRampToValueAtTime(0.0001, boundary);
    } else {
        // 先頭パートはロール全体のフェードイン (fadeInSound) に任せて全開で始める
        gain.gain.setValueAtTime(1, sourceStart);
    }

    if (isTerminal) {
        // 末尾パートは自然終端でフェードアウトし、終了時にロール全体を完了する
        const fadeOutStart = Math.max(item.nominalEnd - crossfade, boundary);
        gain.gain.setValueAtTime(1, fadeOutStart);
        gain.gain.linearRampToValueAtTime(0.0001, item.nominalEnd);
        const soundId = info.soundId;
        source.onended = () => {
            const current = state.activeAudios[soundId];
            if (!current || current.isFadingOut) return;
            cleanupAfterStop(soundId, null);
        };
    }

    source.start(sourceStart);
    info.scheduled.push(item);
    return item;
}

// チェーンの次パートを決定する。未離上なら起こり→ループ(循環)、離上後は終わり→締めの末尾。
function nextRollChainItem(info) {
    if (!info.introConsumed) {
        info.introConsumed = true;
        if (info.introBuffer) return { kind: 'intro', buffer: info.introBuffer, terminal: false };
    }
    if (!info.rollReleased) {
        const buffer = info.loopBuffers[info.loopCursor % info.loopBuffers.length];
        info.loopCursor += 1;
        return { kind: 'loop', buffer, terminal: false };
    }
    if (info.tailIndex < info.tailBuffers.length) {
        const index = info.tailIndex;
        info.tailIndex += 1;
        return {
            kind: info.tailKinds[index],
            buffer: info.tailBuffers[index],
            terminal: index === info.tailBuffers.length - 1
        };
    }
    return null;
}

// 先読みスケジューラ: 境界時刻に合わせて次パートを事前スケジュールし、継ぎ目を途切れさせない。
function pumpRoll(soundId) {
    const info = state.activeAudios[soundId];
    if (!info || !info.isRoll || info.isFadingOut || !state.audioContext) {
        if (info?.rollSchedulerId) { clearInterval(info.rollSchedulerId); info.rollSchedulerId = null; }
        return;
    }
    const now = state.audioContext.currentTime;
    const horizon = now + ROLL_SCHEDULER_LOOKAHEAD_SECONDS;

    // 終了済みアイテムの後始末（onended ではなく時刻で判定して破棄する）
    info.scheduled = info.scheduled.filter(item => {
        if (item.nominalEnd > now - 0.1) return true;
        item.source.onended = null;
        try { item.source.disconnect(); } catch (e) { /* ignore */ }
        try { item.gain.disconnect(); } catch (e) { /* ignore */ }
        return false;
    });

    while (info.chainTime < horizon) {
        const next = nextRollChainItem(info);
        if (!next) break; // 末尾までスケジュール済み
        scheduleRollChainItem(info, next.kind, next.buffer, info.chainTime, next.terminal);
        info.chainTime += next.buffer.duration;
    }

    // 離上後の末尾までスケジュールし終えたらポーリングを止める
    if (info.rollReleased && info.tailIndex >= info.tailBuffers.length) {
        clearInterval(info.rollSchedulerId);
        info.rollSchedulerId = null;
    }
}

// ロール再生を開始する。押下開始（キー/パッド/キーボードビュー）から呼ばれる。
// 起こり（無ければ省略）から始まり、ループパート群を登録順に循環させて鳴らし続ける。
export async function startRollPlayback(soundId, soundButtonElement, clickTime = null) {
    if (!state.audioContext) return false;
    if (state.audioContext.state !== 'running') await resumeAudioContext();
    if (state.audioContext.state !== 'running') {
        // 通常サウンド（handleSoundButtonClick）と同じ案内を出す
        if (state.showErrorPopups) showAlert("オーディオの準備ができていません。画面をクリック後、再度お試しください。", "通知");
        return false;
    }
    delete state.pausedSounds[soundId];

    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.rollParts) return false;

    const active = state.activeAudios[soundId];
    if (active?.isRoll) {
        // 押下中の再押下は無視（複数入力のホールド集約は 08_handlers 側で行う）
        if (!active.rollReleased) return true;
        // 終わり/締めの再生中に再押下した場合は頭出しでやり直す
        forceStopSound(soundId, soundButtonElement);
    } else if (active) {
        return false;
    }

    // パートバッファを先に全て用意する（起こり→ループ切替の隙を防ぐ）
    const partIds = soundData.rollParts;
    const introBuffer = partIds.intro ? await getRollPartBuffer(rollPartCacheKey(soundId, 'intro'), partIds.intro, soundData.name) : null;
    const loopBuffers = [];
    for (let index = 0; index < (partIds.loops || []).length; index++) {
        const audioId = partIds.loops[index];
        if (!audioId) continue;
        const buffer = await getRollPartBuffer(rollPartCacheKey(soundId, `loop:${index}`), audioId, soundData.name);
        if (buffer) loopBuffers.push(buffer);
    }
    const endBuffer = partIds.end ? await getRollPartBuffer(rollPartCacheKey(soundId, 'end'), partIds.end, soundData.name) : null;
    const finishBuffer = partIds.finish ? await getRollPartBuffer(rollPartCacheKey(soundId, 'finish'), partIds.finish, soundData.name) : null;

    if (!loopBuffers.length) {
        if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」のループ音声を読み込めません。`);
        return false;
    }
    // デコード待ちの間にシーン切替・削除があった場合は中断する
    if (!state.scenes[state.currentSceneId]?.sounds.some(s => s.id === soundId)) return false;

    const ctx = state.audioContext;
    const pannerNode = ctx.createStereoPanner();
    pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, ctx.currentTime);
    const individualGain = ctx.createGain();
    const effectRack = createEffectRack(soundData.effects);
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();

    let fftSizeMeter = state.performanceMode === PERFORMANCE_MODE.HIGH_PERFORMANCE ? ANALYSER_FFT_SIZE : 32;
    Object.assign(analyserL, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });
    Object.assign(analyserR, { fftSize: fftSizeMeter, smoothingTimeConstant: 0.6 });

    pannerNode.connect(individualGain);
    individualGain.connect(effectRack.entry);
    effectRack.exit.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    effectRack.exit.connect(state.masterInputNode);
    individualGain.gain.setValueAtTime(0.0001, ctx.currentTime);

    const now = ctx.currentTime;
    const audioInfo = {
        isRoll: true,
        soundId: soundId,
        audioElement: null, objectUrl: null, sourceNode: null,
        introBuffer, loopBuffers, endBuffer, finishBuffer,
        scheduled: [],           // チェーンのパート再生キュー（時刻順）
        chainTime: now,          // 次パートの名目開始時刻
        introConsumed: false,
        loopCursor: 0,
        tailBuffers: [], tailKinds: [], tailIndex: 0, // 離上後の終わり→締め
        rollSchedulerId: null,
        rollReleaseTime: null,
        rollReleased: false,
        pannerNode, individualGain, effectRack, splitter, analyserL, analyserR,
        dataL: new Uint8Array(analyserL.fftSize), dataR: new Uint8Array(analyserR.fftSize),
        audioBuffer: introBuffer ?? loopBuffers[0],
        waveformPeaks: null,
        meterAnimationFrameId: null, progressBarInterval: null,
        isFadingOut: false, muted: false, progressPercent: 0,
        playbackPosition: 0, playbackPositionContextTime: now, playbackRate: 1,
        fadeInEndTime: null, naturalFadeStartTime: null,
        peakL: 0, peakR: 0
    };
    state.activeAudios[soundId] = audioInfo;

    // 最初のパート（起こり or ループ）を即時スケジュールし、以降は先読みポーリングで継ぐ
    pumpRoll(soundId);
    audioInfo.rollSchedulerId = setInterval(() => pumpRoll(soundId), ROLL_SCHEDULER_INTERVAL_MS);

    recordStartMetric(soundId, clickTime, performance.now());
    updateButtonUI(soundId, soundButtonElement, true);
    updatePauseAllButton();
    createMeterElement(soundId, soundData.name);
    triggerWaveformUpdate();
    fadeInSound(soundId, soundData.volume);
    startMeterUpdate(soundId);
    return true;
}

// ロールを離上する。鳴っているパートは最後まで再生し、その境界から終わり→締めへ遷移する。
export function endRollPlayback(soundId) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo?.isRoll || audioInfo.rollReleased || audioInfo.isFadingOut) return;

    const ctx = state.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;

    audioInfo.rollReleased = true;
    audioInfo.rollReleaseTime = now;

    // 未開始のパートをキャンセルする（鳴り始めたパートは維持して最後まで聴かせる）
    audioInfo.scheduled = audioInfo.scheduled.filter(item => {
        if (item.sourceStart <= now) return true;
        item.source.onended = null;
        try { item.source.stop(0); } catch (e) { /* ignore */ }
        try { item.source.disconnect(); } catch (e) { /* ignore */ }
        try { item.gain.disconnect(); } catch (e) { /* ignore */ }
        return false;
    });

    const current = audioInfo.scheduled[audioInfo.scheduled.length - 1] || null;
    audioInfo.chainTime = current ? current.nominalEnd : now;
    audioInfo.tailBuffers = [];
    audioInfo.tailKinds = [];
    audioInfo.tailIndex = 0;
    if (audioInfo.endBuffer) { audioInfo.tailBuffers.push(audioInfo.endBuffer); audioInfo.tailKinds.push('end'); }
    if (audioInfo.finishBuffer) { audioInfo.tailBuffers.push(audioInfo.finishBuffer); audioInfo.tailKinds.push('finish'); }

    if (!audioInfo.tailBuffers.length) {
        // 終わりも締めも無いロールは現在パートの自然終了で完了する
        if (audioInfo.rollSchedulerId) { clearInterval(audioInfo.rollSchedulerId); audioInfo.rollSchedulerId = null; }
        if (!current) {
            cleanupAfterStop(soundId, null);
            return;
        }
        current.source.onended = () => {
            const info = state.activeAudios[soundId];
            if (!info || info.isFadingOut) return;
            cleanupAfterStop(soundId, null);
        };
        return;
    }

    pumpRoll(soundId);
}

// ロールはパート単位の短いサイクルで進捗・波形が忙しく動くため、
// プログレスバーや波形表示の更新対象に含めない（メーターのみ表示する）。


// --- sustain モード（重ね再生）のレイヤーボイス管理 ---
// メーター・プログレス等のUIは本体（activeAudios）側だけが持ち、レイヤーは
// 自然終了時に自分で後始末する。停止は stopSustainLayers 経由で明示的に行う。

export function getSustainLayerCount(soundId) {
    return state.sustainLayers[soundId]?.length ?? 0;
}

// sustain モード: 再生中のサウンドに重ねる追加ボイスを鳴らす。
// 開始に成功したら true を返す。
export async function startSustainLayer(soundId) {
    if (!state.audioContext || state.audioContext.state !== 'running') return false;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.audioId) return false;

    let sourceNode, audioElement, objectUrl, audioBuffer;
    try {
        const created = await createSoundSourceNodes(soundData);
        if (created.error) {
            if (state.showErrorPopups) showAlert(created.error);
            return false;
        }
        ({ sourceNode, audioElement, objectUrl, audioBuffer } = created);
    } catch (err) {
        console.error("Error in startSustainLayer:", err);
        return false;
    }

    try {
        const pannerNode = state.audioContext.createStereoPanner();
        pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, state.audioContext.currentTime);
        const individualGain = state.audioContext.createGain();
        const effectRack = createEffectRack(soundData.effects);
        individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
        sourceNode.connect(pannerNode);
        pannerNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(state.masterInputNode);

        const layer = {
            soundId, sourceNode, audioElement, objectUrl, audioBuffer,
            pannerNode, individualGain, effectRack,
            playbackPosition: 0,
            playbackPositionContextTime: state.audioContext.currentTime,
            playbackRate: Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1)),
            fadeInEndTime: null, naturalFadeStartTime: null, isFadingOut: false
        };

        const finishLayer = () => disposeSustainLayer(soundId, layer, false);
        if (audioElement) { // LOW_MEMORY
            audioElement.onended = finishLayer;
            audioElement.onerror = finishLayer;
        } else {
            if ('onended' in sourceNode) sourceNode.onended = finishLayer;
            else sourceNode.onstop = finishLayer;
            sourceNode.start(0);
        }

        (state.sustainLayers[soundId] ??= []).push(layer);

        const fadeDuration = Math.max(soundData.fadeInDuration ?? 0, MIN_GAIN_RAMP_SECONDS);
        applyFadeCurve(individualGain.gain, 0.0001, Math.max(0.0001, soundData.volume ?? 1), state.audioContext.currentTime, fadeDuration, soundData.fadeInEasing || 'linear');
        layer.fadeInEndTime = state.audioContext.currentTime + fadeDuration;

        if (audioElement) {
            try { await audioElement.play(); }
            catch (err) {
                console.error("Error starting sustain layer:", err);
                disposeSustainLayer(soundId, layer, false);
                return false;
            }
        }
        // LOW_MEMORY の <audio> は play() 後に duration が確定するため、ここで終端フェードを計算する。
        scheduleNaturalFadeOutFor(layer, soundData);
        updateSustainLayerBadge(soundId, getSustainLayerCount(soundId));
        return true;
    } catch (err) {
        console.error("Error in startSustainLayer:", err);
        return false;
    }
}

// レイヤーを1つ破棄する。useFadeOut なら設定のフェードアウトで消音してから破棄。
function disposeSustainLayer(soundId, layer, useFadeOut) {
    const layers = state.sustainLayers[soundId];
    if (!layers || !layers.includes(layer)) return; // 二重破棄ガード

    if (useFadeOut && !layer.isFadingOut && state.audioContext) {
        layer.isFadingOut = true;
        const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
        const fadeSeconds = Math.max(soundData?.fadeOutDuration ?? 0, MIN_STOP_FADE_SECONDS);
        applyFadeCurve(layer.individualGain.gain, Math.max(0.0001, layer.individualGain.gain.value), 0.0001, state.audioContext.currentTime, fadeSeconds, soundData?.fadeOutEasing || 'linear');
        setTimeout(() => disposeSustainLayer(soundId, layer, false), fadeSeconds * 1000);
        return;
    }

    const index = layers.indexOf(layer);
    layers.splice(index, 1);
    if (!layers.length) delete state.sustainLayers[soundId];

    try {
        if (layer.sourceNode && typeof layer.sourceNode.stop === 'function') layer.sourceNode.stop();
    } catch (e) { /* ignore */ }
    try { layer.sourceNode?.disconnect(); } catch (e) { /* ignore */ }
    if (layer.sourceNode instanceof Tone.GrainPlayer) layer.sourceNode.dispose();
    if (layer.audioElement) {
        layer.audioElement.onended = null;
        layer.audioElement.onerror = null;
        layer.audioElement.src = '';
        layer.audioElement.load();
    }
    if (layer.objectUrl) URL.revokeObjectURL(layer.objectUrl);
    try { layer.individualGain?.disconnect(); } catch (e) { /* ignore */ }
    try { layer.pannerNode?.disconnect(); } catch (e) { /* ignore */ }
    disposeEffectRack(layer.effectRack);
    updateSustainLayerBadge(soundId, getSustainLayerCount(soundId));
}

export function stopSustainLayers(soundId, useFadeOut = true) {
    const layers = state.sustainLayers[soundId];
    if (!layers) return;
    [...layers].forEach(layer => disposeSustainLayer(soundId, layer, useFadeOut));
}

// --- mute モード（消音切替） ---

// 再生位置は進めたまま音だけを消す/戻す。gain は個別音量と同期し、
// ミュート中に音量スライダーを動かしても解除時に新しい音量が反映される。
export function setSoundMuted(soundId, muted) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.isFadingOut || !state.audioContext || !audioInfo.individualGain) return false;
    muted = !!muted;
    if (audioInfo.muted === muted) return true;
    audioInfo.muted = muted;

    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const now = state.audioContext.currentTime;
    const targetVolume = muted ? 0.0001 : Math.max(0.0001, soundData?.volume ?? 1);
    applyFadeCurve(audioInfo.individualGain.gain, Math.max(0.0001, audioInfo.individualGain.gain.value), targetVolume, now, MUTE_FADE_SECONDS, 'linear');
    if (muted) {
        // 終端フェードアウトのスケジュールと競合しないよう解除してから 0 に向かわせる
        cancelNaturalFadeOut(audioInfo, now);
        audioInfo.naturalFadeStartTime = null;
    } else {
        scheduleNaturalFadeOut(soundId);
    }

    const soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
    if (soundButtonElement) updateButtonUI(soundId, soundButtonElement, true, false);
    return true;
}

export function isSoundPaused(soundId) {
    return Boolean(state.pausedSounds[soundId]);
}

export function pauseSound(soundId, soundButtonElement = null) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.isFadingOut || !state.audioContext) return false;

    // ロールは途中からの一時停止ができないため、停止として扱う
    if (audioInfo.isRoll) {
        stopSound(soundId, soundButtonElement);
        return true;
    }

    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    const duration = audioInfo.audioBuffer?.duration || audioInfo.audioElement?.duration || sound?.duration;
    let position = getCurrentSourcePosition(audioInfo);
    if (Number.isFinite(duration) && duration > 0) {
        position = sound?.loop ? position % duration : Math.min(duration, position);
    }
    if (!Number.isFinite(position) || position < 0) return false;

    state.pausedSounds[soundId] = { position, pausedAt: Date.now() };
    if (!soundButtonElement) soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);

    if (audioInfo.meterAnimationFrameId) cancelAnimationFrame(audioInfo.meterAnimationFrameId);
    if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);
    audioInfo.sourceNode.onended = null;
    if ('onstop' in audioInfo.sourceNode) audioInfo.sourceNode.onstop = null;
    try {
        if (audioInfo.audioElement && !audioInfo.audioElement.paused) audioInfo.audioElement.pause();
        if (audioInfo.sourceNode && typeof audioInfo.sourceNode.stop === 'function') audioInfo.sourceNode.stop();
    } catch (_) { /* the audio source may already have ended */ }
    cleanupAfterStop(soundId, soundButtonElement, false);
    updateButtonUI(soundId, soundButtonElement, false, true);
    updatePausedProgress(soundId, soundButtonElement, position);
    updatePauseAllButton();
    return true;
}

export async function resumeSound(soundId, soundButtonElement = null) {
    const paused = state.pausedSounds[soundId];
    if (!paused) return false;
    delete state.pausedSounds[soundId];
    await playSound(soundId, soundButtonElement, performance.now(), paused.position);
    updatePauseAllButton();
    return true;
}

export async function togglePauseAllSounds() {
    const activeIds = Object.entries(state.activeAudios)
        .filter(([, audio]) => !audio.isFadingOut)
        .map(([soundId]) => soundId);
    if (activeIds.length > 0) {
        activeIds.forEach(soundId => pauseSound(soundId));
        return;
    }
    await Promise.all(Object.keys(state.pausedSounds).map(soundId => resumeSound(soundId)));
}

export function seekSound(soundId, seekTime) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !state.audioContext) return;
    if (audioInfo.isRoll) return; // ロールはパート連結再生のためシーク不可

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

export function updateActiveSoundLoop(soundId, loop) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.isRoll || !state.audioContext) return; // ロールのループはパート構成で決まる

    const now = state.audioContext.currentTime;
    const duration = audioInfo.audioBuffer?.duration || audioInfo.audioElement?.duration;
    let position = getCurrentSourcePosition(audioInfo);
    const isGrainPlayer = audioInfo.sourceNode instanceof Tone.GrainPlayer;

    if (isGrainPlayer && !loop && Number.isFinite(duration) && duration > 0) {
        // GrainPlayer は loop=false への変更時に累積位置を見て即時停止するため、
        // 現在の周回の終端まで再生してから停止する。
        const loopPosition = Math.max(0, position % duration);
        const remaining = (duration - loopPosition) / Math.max(0.001, audioInfo.playbackRate);
        audioInfo.stopAfterLoop = true;
        audioInfo.loopStopTime = now + remaining;
        audioInfo.sourceNode.stop(audioInfo.loopStopTime);
        position = loopPosition;
    } else if (isGrainPlayer && loop && audioInfo.stopAfterLoop) {
        // 解除直後に再度ONにした場合は、終端停止の予約をリスタートで打ち消す。
        const loopPosition = Number.isFinite(duration) && duration > 0
            ? Math.max(0, position % duration)
            : 0;
        audioInfo.sourceNode.restart(now, loopPosition);
        audioInfo.stopAfterLoop = false;
        audioInfo.loopStopTime = null;
        audioInfo.playbackPosition = loopPosition;
        audioInfo.playbackPositionContextTime = now;
        position = loopPosition;
    } else if (!loop && !isGrainPlayer) {
        if (Number.isFinite(duration) && duration > 0) {
            position = Math.max(0, Math.min(duration, position));
        }
    }

    if (audioInfo.audioElement) {
        audioInfo.audioElement.loop = loop;
    }

    if (Number.isFinite(duration) && duration > 0) {
        const progressPercent = Math.min(100, Math.max(0, (position / duration) * 100));
        audioInfo.progressPercent = progressPercent;
        const soundButton = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
        soundButton?.style.setProperty('--progress', `${progressPercent}%`);
        const progressBarValue = soundButton?.querySelector('.progress-bar-value');
        if (progressBarValue) progressBarValue.style.width = `${progressPercent}%`;
        setKeyboardKeyProgress(soundId, progressPercent);
    }
}

function fadeInSound(soundId, targetVolume) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || !state.audioContext || !audioInfo.individualGain) return;
    const { individualGain } = audioInfo;
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    const fadeDurationSeconds = Math.max(soundData?.fadeInDuration ?? 0, MIN_GAIN_RAMP_SECONDS);
    const easing = soundData?.fadeInEasing || 'linear';
    const finalTargetVolume = Math.max(0.0001, audioInfo.muted ? 0.0001 : targetVolume); // ミュート中は無音のまま維持
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
    if (audioInfo.isRoll) return; // ロールはパート間の継ぎ目を保つため常に等速再生
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

function cleanupAfterStop(soundId, soundButtonElement, resetProgress = true) {
    const audioInfo = state.activeAudios[soundId];

    if (audioInfo) {
        if (audioInfo.isRoll) {
            // ロールはパートごとに複数ソースと先読みスケジューラを持つため全て破棄する
            stopRollSources(audioInfo);
            if (audioInfo.rollSchedulerId) { clearInterval(audioInfo.rollSchedulerId); audioInfo.rollSchedulerId = null; }
        }
        if (audioInfo.sourceNode) {
            audioInfo.sourceNode.onended = null;
            if ('onstop' in audioInfo.sourceNode) audioInfo.sourceNode.onstop = () => {};
            try { audioInfo.sourceNode.disconnect(); } catch (e) { /* ignore */ }
            if (audioInfo.sourceNode instanceof Tone.GrainPlayer) audioInfo.sourceNode.dispose();
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
        try { audioInfo.pannerNode?.disconnect(); } catch (e) { /* ignore */ }
        disposeEffectRack(audioInfo.effectRack);
        try { audioInfo.splitter?.disconnect(); } catch (e) { /* ignore */ }

        delete state.activeAudios[soundId];
        // 本体が自然終了しても、残っているレイヤー数をバッジへ反映する。
        updateSustainLayerBadge(soundId, getSustainLayerCount(soundId));
    }

    if (!soundButtonElement?.isConnected) {
        soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
    }
    if (soundButtonElement) {
        updateButtonUI(soundId, soundButtonElement, false);
        if (resetProgress) resetProgressBar(soundButtonElement);
    }
    removeMeterElement(soundId);
    triggerWaveformUpdate();
    updatePauseAllButton();
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
    if (activeAudio?.individualGain && !activeAudio.isFadingOut && !activeAudio.muted) {
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
    const duration = audioBuffer?.duration || audioElement?.duration || soundData?.duration || 0;

    const update = () => {
        if (!state.activeAudios[soundId] || !duration) {
            clearInterval(audioInfo.progressBarInterval);
            return;
        }
        if (!soundButtonElement?.isConnected) {
            soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
        }
        const timeDisplay = soundButtonElement?.querySelector('.time-display');
        if (!soundButtonElement || !timeDisplay) return;

        const sourcePosition = getCurrentSourcePosition(audioInfo);
        const currentTime = soundData?.loop || audioInfo.stopAfterLoop
            ? sourcePosition % duration
            : Math.min(duration, sourcePosition);

        const progressPercent = Math.min(100, (currentTime / duration) * 100);
        audioInfo.progressPercent = progressPercent;
        soundButtonElement.style.setProperty('--progress', `${progressPercent}%`);
        setKeyboardKeyProgress(soundId, progressPercent);
        const progressBarValue = soundButtonElement?.querySelector('.progress-bar-value');
        if (progressBarValue) progressBarValue.style.width = `${progressPercent}%`;
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
    // ロールは波形表示の対象外（パート切替で波形が飛び安定しないため）
    const hasActiveSounds = Object.values(state.activeAudios).some(audio => !audio.isFadingOut && !audio.isRoll);
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

        // ロールはパート切替ごとに波形が飛び安定しないため波形表示の対象外とする
        const activeSoundsInfo = Object.values(state.activeAudios).filter(info => !info.isFadingOut && !info.isRoll);
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
                const duration = audioBuffer.duration;
                const rawBaseTime = getCurrentSourcePosition(audioInfo);
                const playbackRate = getCurrentPlaybackRate(audioInfo);

                // The canvas always represents the next five seconds of real playback.
                const sourceSecondsPerPixel = secondsPerPixel * playbackRate;
                const snappedBaseTime = Math.round(rawBaseTime / sourceSecondsPerPixel) * sourceSecondsPerPixel;
                let currentSoundBufferTime = snappedBaseTime + timeOffsetFromLeftEdge * playbackRate;

                if (soundData.loop && duration > 0) {
                    currentSoundBufferTime %= duration;
                }

                if (currentSoundBufferTime < 0 || currentSoundBufferTime >= duration) {
                    continue;
                }

                // Look up all peaks within this pixel's time range
                const peakIdxStart = Math.floor(currentSoundBufferTime * waveformPeaks.peaksPerSecond);
                const peakIdxEnd = Math.min(
                    Math.floor((currentSoundBufferTime + sourceSecondsPerPixel) * waveformPeaks.peaksPerSecond),
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

// modules/06_audio.js

import { state, setAudioContext, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import { showAlert, createMeterElement, removeMeterElement, updateButtonUI, updateSustainLayerBadge, resetProgressBar, setupCanvasResize } from './05_ui.js';
import { renderFallbackUI, disableAppControls } from './07_scenes.js';
import { WAVEFORM_SECONDS_AHEAD, WAVEFORM_DOWNSAMPLE, PERFORMANCE_MODE, MIN_GAIN_RAMP_SECONDS, MIN_STOP_FADE_SECONDS, MUTE_FADE_SECONDS, ROLL_CROSSFADE_SECONDS, ROLL_SCHEDULER_INTERVAL_MS, ROLL_SCHEDULER_LOOKAHEAD_SECONDS } from './01_config.js';
import { dbRequest } from './04_db.js';
import { applyEffectSettings, createEffectRack, disposeEffectRack, normalizeEffectSettings, setEffectsContext, ensureWorkletModule, createMasterChain, disposeMasterChain, applyMasterChainSettings, applyMasterChainDelay, applyMasterChainReverb, applyMasterChainLimiter } from './09_effects.js';
import { attachToneContext, getToneClockSnapshot, resumeToneAudio } from './10_tone_transport.js';
import { setKeyboardKeyProgress } from './11_keyboard_view.js';
import * as Tone from 'tone';

// --- AudioContext Management ---
let _audioInitPromise = null;

// 並行呼び出し時は同一の初期化Promiseを共有する(async化に伴い必須)。
export function initAudioContext() {
    if (state.audioContext) { return Promise.resolve(state.audioContext.state === 'running'); }
    if (!_audioInitPromise) {
        _audioInitPromise = initAudioContextInner().then(result => {
            if (!result) _audioInitPromise = null;
            return result;
        }).catch(e => {
            _audioInitPromise = null;
            throw e;
        });
    }
    return _audioInitPromise;
}

async function initAudioContextInner() {
    if (!window.AudioContext && !window.webkitAudioContext) {
        renderFallbackUI("Web Audio API非対応ブラウザです。");
        disableAppControls();
        return false;
    }
    let audioContext = null;
    let masterChain = null;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        if (!audioContext.audioWorklet || !window.AudioWorkletNode) {
            renderFallbackUI("このブラウザは AudioWorklet に対応していません。");
            disableAppControls();
            try { await audioContext.close(); } catch (_) { /* ignore */ }
            setAudioContext(null, null, null, null);
            return false;
        }
        setEffectsContext(audioContext);
        // 全エフェクトは AudioWorklet プロセッサで動くため、最初にモジュールを登録する
        await ensureWorkletModule(audioContext);

        masterChain = await createMasterChain(audioContext, {
            eqLow: state.masterEq.low,
            eqMid: state.masterEq.mid,
            eqHigh: state.masterEq.high,
            compThreshold: state.masterComp.threshold,
            compRatio: state.masterComp.ratio,
            distortionAmount: state.masterDistortion.amount,
            reverbDecay: state.masterReverb.decay,
            reverbWet: state.masterReverb.wet,
            delayTime: state.masterDelay.time,
            delayFeedback: state.masterDelay.feedback,
            delayLevel: state.masterDelay.level,
            limiterThreshold: state.masterLimiter.threshold
        });

        const masterInputNode = audioContext.createGain();
        const masterGainNode = audioContext.createGain();
        masterGainNode.gain.setValueAtTime(state.masterVolume, audioContext.currentTime);
        const masterPanNode = audioContext.createStereoPanner();
        masterPanNode.pan.setValueAtTime(Number.isFinite(state.masterPan.value) ? state.masterPan.value : 0, audioContext.currentTime);
        const recordingDestinationNode = audioContext.createMediaStreamDestination();

        // wiring: input → master-front → (convolver) → master-back → volume → meter → pan → limit → 出力/録音
        masterInputNode.connect(masterChain.input);
        masterChain.back.connect(masterGainNode);
        masterGainNode.connect(masterChain.meterNode);
        masterChain.meterNode.connect(masterPanNode);
        masterPanNode.connect(masterChain.limit);
        masterChain.limit.connect(audioContext.destination);
        masterChain.limit.connect(recordingDestinationNode);

        attachToneContext(audioContext);
        updateState({ masterChain, masterPanNode, recordingDestinationNode });
        setAudioContext(audioContext, masterGainNode, masterChain.limit, masterInputNode);

        startMasterMeter();
        if (audioContext.state === 'suspended') {
            // AudioContext is suspended. Needs user interaction to resume.
        }
        return true;
    } catch (e) {
        console.error('AudioContext initialization failed:', e);
        disposeMasterChain(masterChain);
        setEffectsContext(null);
        try { await audioContext?.close(); } catch (_) { /* ignore */ }
        renderFallbackUI("Web Audio API の初期化に失敗しました。");
        disableAppControls();
        setAudioContext(null, null, null, null);
        return false;
    }
}

export function setMasterParam(dottedKey, value) {
    const [group, param] = dottedKey.split('.');
    const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
    const stateObj = state[stateKey];
    if (!stateObj || !param) return;

    stateObj[param] = value;
    const chain = state.masterChain;
    if (!chain || !state.audioContext) return;

    try {
        if (group === 'eq') {
            applyMasterChainSettings(chain, { eqLow: state.masterEq.low, eqMid: state.masterEq.mid, eqHigh: state.masterEq.high });
        } else if (group === 'comp') {
            applyMasterChainSettings(chain, { compThreshold: state.masterComp.threshold, compRatio: state.masterComp.ratio });
        } else if (group === 'delay') {
            applyMasterChainDelay(chain, { delayTime: state.masterDelay.time, delayFeedback: state.masterDelay.feedback, delayLevel: state.masterDelay.level });
        } else if (group === 'pan') {
            state.masterPanNode?.pan.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
        } else if (group === 'distortion' && param === 'amount') {
            applyMasterChainSettings(chain, { distortionAmount: value });
        } else if (group === 'reverb') {
            if (param === 'decay') {
                applyMasterChainReverb(chain, { decay: value, preDelay: 0.01, wet: state.masterReverb.wet });
            } else if (param === 'wet') {
                applyMasterChainReverb(chain, { decay: state.masterReverb.decay, preDelay: 0.01, wet: value });
            }
        }
    } catch (e) { /* param not rampable */ }
}

export function setMasterLimiterThreshold(value) {
    const threshold = Math.min(0, Math.max(-12, Number(value)));
    state.masterLimiter.threshold = threshold;
    applyMasterChainLimiter(state.masterChain, threshold);
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

// resume待ちの打ち切り時間。ジェスチャなしで呼ばれた resume() は
// ユーザー操作があるまで解けない (rejectもしない) ため、これがないと
// リモートコマンド経由の再生処理が永遠に await で固まる。
const RESUME_RACE_TIMEOUT_MS = 500;

export function resumeAudioContext() {
    if (state.audioContext && state.audioContext.state === 'suspended') {
        // resume/Tone.start の完了と短いタイムアウトを競合させる。
        // ジェスチャ内の呼び出し (ローカル操作) は即時解決、リモート経由でも
        // 呼び出し側が応答しない resume に引きずられて固まらない。
        const resumed = state.audioContext.resume().then(() => resumeToneAudio());
        const timeout = new Promise(resolve => setTimeout(resolve, RESUME_RACE_TIMEOUT_MS));
        return Promise.race([resumed, timeout])
            .catch(() => { /* Error resuming AudioContext */ });
    } else {
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

// 聴こえる出力は ctx の出力レイテンシ分だけ遅れる。表示系（波形・進捗）は
// ソースクロックではなく「いま聴こえている位置」に合わせるため、その分を差し引く。
function getAudibleLatencySeconds() {
    const ctx = state.audioContext;
    if (!ctx) return 0;
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    const output = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    return Math.max(0, base + output);
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
    const fullDuration = sound?.duration;
    const trimStart = Number.isFinite(sound?.trimStart) ? sound.trimStart : 0;
    const trimEnd = Number.isFinite(sound?.trimEnd) ? sound.trimEnd : fullDuration;
    const duration = Math.max(0, trimEnd - trimStart);
    if (!button || !Number.isFinite(duration) || duration <= 0) return;

    const elapsed = position - trimStart;
    const currentTime = sound.loop
        ? ((elapsed % duration) + duration) % duration
        : Math.min(duration, Math.max(0, elapsed));
    const progress = button.querySelector('.progress-bar-value');
    const timeDisplay = button.querySelector('.time-display');
    if (progress) progress.style.width = `${Math.min(100, currentTime / duration * 100)}%`;
    if (timeDisplay) timeDisplay.textContent = `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`;
}

export function updatePauseAllButton() {
    const pauseAllButton = dom.pauseAllBtn;
    if (!pauseAllButton) return;

    const hasActiveSounds = Object.values(state.activeAudios).some(audio => !audio.isFadingOut)
        || Object.values(state.sustainLayers).some(layers => layers.length > 0);
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

function scheduleTrimBoundaryForVoice(voice, soundData, onAudioElementBoundary, isCurrent = () => true) {
    if (!voice || !soundData || !Number.isFinite(voice.trimEnd)) return;
    if (voice.isFadingOut || !isCurrent()) return;

    clearTimeout(voice.trimBoundaryTimeoutId);
    voice.trimBoundaryTimeoutId = null;
    if (soundData.loop && !voice.audioElement) return;

    const remaining = voice.trimEnd - getCurrentSourcePosition(voice);
    const rate = Math.max(0.25, getCurrentPlaybackRate(voice) || 1);
    if (!Number.isFinite(remaining)) return;

    const handleBoundary = () => {
        if (!isCurrent() || voice.isFadingOut) return;
        if (soundData.loop && voice.audioElement) {
            voice.audioElement.currentTime = voice.trimStart;
            scheduleTrimBoundaryForVoice(voice, soundData, onAudioElementBoundary, isCurrent);
        } else if (voice.audioElement) {
            voice.audioElement.pause();
            onAudioElementBoundary?.();
        } else {
            try { voice.sourceNode?.stop(); } catch (_) { /* source may have ended */ }
        }
    };

    const isNativeSource = !voice.audioElement && !(voice.sourceNode instanceof Tone.GrainPlayer);
    if (isNativeSource) {
        // ネイティブソースはオーディオクロックで終端停止を予約する(メインスレッド遅延の影響を受けない)。
        const stopTime = state.audioContext.currentTime + Math.max(0, remaining) / rate;
        try {
            if (remaining <= 0.005) voice.sourceNode?.stop();
            else voice.sourceNode?.stop(stopTime);
        } catch (_) { /* source may have ended */ }
        return;
    }

    if (remaining <= 0.005) {
        handleBoundary();
        return;
    }
    const timeoutId = setTimeout(() => {
        if (voice.trimBoundaryTimeoutId !== timeoutId) return;
        voice.trimBoundaryTimeoutId = null;
        handleBoundary();
    }, remaining / rate * 1000);
    voice.trimBoundaryTimeoutId = timeoutId;
}

// ネイティブ AudioBufferSourceNode は再起動できないため、ループ位置から新しい
// ソースを作り直す(GrainPlayer.restart 相当)。旧ソースは即時停止する。
function restartNativeSource(audioInfo, soundData, position) {
    if (!audioInfo?.audioBuffer || !state.audioContext) return;
    const ctx = state.audioContext;
    try { audioInfo.sourceNode.onended = null; } catch (e) { /* ignore */ }
    try { audioInfo.sourceNode.stop(); } catch (e) { /* ignore */ }
    try { audioInfo.sourceNode.disconnect(); } catch (e) { /* ignore */ }

    const sound = soundData || state.scenes[state.currentSceneId]?.sounds.find(item => item.id === audioInfo.soundId);
    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = audioInfo.audioBuffer;
    sourceNode.loop = Boolean(sound?.loop);
    sourceNode.loopStart = audioInfo.trimStart;
    sourceNode.loopEnd = audioInfo.trimEnd;
    sourceNode.playbackRate.value = audioInfo.playbackRate;
    sourceNode.connect(audioInfo.pannerNode);
    const onEnd = () => {
        const current = state.activeAudios[audioInfo.soundId];
        if (current && !current.isFadingOut && !(sound?.loop)) {
            cleanupAfterStop(audioInfo.soundId, null);
        }
    };
    sourceNode.onended = onEnd;
    sourceNode.start(0, position);
    audioInfo.sourceNode = sourceNode;
    audioInfo.playbackPosition = position;
    audioInfo.playbackPositionContextTime = ctx.currentTime;
}

function soundDataForLoopRestart(soundId) {
    return state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
}

function scheduleTrimBoundary(soundId) {
    const audioInfo = state.activeAudios[soundId];
    const soundData = state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId);
    scheduleTrimBoundaryForVoice(
        audioInfo,
        soundData,
        () => cleanupAfterStop(soundId, null),
        () => state.activeAudios[soundId] === audioInfo
    );
}

// 再生中に preservePitch の条件が変わった場合も、現行の再生位置を
// 維持したまま適切なソース種別へ切り替える。
function replaceBufferPlaybackSource(audioInfo, soundData, position, playbackRate) {
    if (!audioInfo?.audioBuffer || !state.audioContext || audioInfo.audioElement) return false;
    const ctx = state.audioContext;
    const oldSource = audioInfo.sourceNode;
    try { oldSource.onended = null; } catch (e) { /* ignore */ }
    try { if ('onstop' in oldSource) oldSource.onstop = null; } catch (e) { /* ignore */ }
    try { oldSource.stop(); } catch (e) { /* source may have ended */ }
    try { oldSource.disconnect(); } catch (e) { /* ignore */ }
    if (oldSource instanceof Tone.GrainPlayer) {
        try { oldSource.dispose(); } catch (e) { /* ignore */ }
    }

    const sourceNode = createBufferPlaybackSource(audioInfo.audioBuffer, soundData, playbackRate);
    sourceNode.loopStart = audioInfo.trimStart;
    sourceNode.loopEnd = audioInfo.trimEnd;
    sourceNode.connect(audioInfo.pannerNode);
    const onEnd = () => {
        const current = state.activeAudios[audioInfo.soundId];
        if (current === audioInfo && !current.isFadingOut && !soundData.loop) {
            cleanupAfterStop(audioInfo.soundId, null);
        }
    };
    if ('onended' in sourceNode) sourceNode.onended = onEnd;
    else sourceNode.onstop = onEnd;
    sourceNode.start(ctx.currentTime, position);
    audioInfo.sourceNode = sourceNode;
    audioInfo.playbackPosition = position;
    audioInfo.playbackPositionContextTime = ctx.currentTime;
    audioInfo.playbackRate = playbackRate;
    return true;
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
    const fullDuration = voice.audioBuffer?.duration || voice.audioElement?.duration;
    const duration = Number.isFinite(voice.trimEnd) ? voice.trimEnd : fullDuration;
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
// LOW_MEMORY では <audio> 要素、それ以外は通常 BufferSource、速度変更時のピッチ保持だけ GrainPlayer を返す。
// 戻り値は { sourceNode, audioElement, objectUrl, audioBuffer } または { error }。

function needsPitchPreserve(soundData, playbackRate) {
    return Boolean(soundData?.preservePitch) && Math.abs(playbackRate - 1) > 1e-6;
}

function createBufferPlaybackSource(audioBuffer, soundData, playbackRate) {
    if (needsPitchPreserve(soundData, playbackRate)) {
        return new Tone.GrainPlayer({
            url: audioBuffer,
            loop: Boolean(soundData.loop),
            playbackRate,
            detune: 0
        });
    }
    const sourceNode = state.audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = Boolean(soundData.loop);
    sourceNode.playbackRate.value = playbackRate;
    return sourceNode;
}

function waitForMediaMetadata(audioElement) {
    if (!audioElement || audioElement.readyState >= 1 || Number.isFinite(audioElement.duration)) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            audioElement.removeEventListener('loadedmetadata', onLoaded);
            audioElement.removeEventListener('error', onError);
        };
        const onLoaded = () => { cleanup(); resolve(); };
        const onError = () => {
            cleanup();
            reject(audioElement.error || new Error('Audio metadata could not be loaded'));
        };
        audioElement.addEventListener('loadedmetadata', onLoaded, { once: true });
        audioElement.addEventListener('error', onError, { once: true });
        try { audioElement.load(); } catch (error) { cleanup(); reject(error); }
    });
}

async function setMediaElementPosition(audioElement, position) {
    await waitForMediaMetadata(audioElement);
    if (!Number.isFinite(position)) return;
    audioElement.currentTime = Math.max(0, position);
}
async function createSoundSourceNodes(soundData, expectedGeneration = state.sceneGeneration) {
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

        // LOW_MEMORY では再生中に AudioBuffer を保持しない。波形が必要な場合だけ
        // 初回再生時に一時デコードし、ピーク配列だけをキャッシュして即座に破棄する。
        let waveformPeaks = state.waveformPeaksCache[soundData.id]?.peaks || null;
        if (!waveformPeaks) {
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const decoded = await state.audioContext.decodeAudioData(arrayBuffer);
                waveformPeaks = precomputeWaveformPeaks(decoded);
                state.waveformPeaksCache[soundData.id] = { buffer: null, peaks: waveformPeaks };
            } catch (decodeError) {
                console.error("Error decoding audio for waveform in LOW_MEMORY mode:", decodeError);
            }
        }
        return { sourceNode, audioElement, objectUrl, audioBuffer: null, waveformPeaks };
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
            if (expectedGeneration === state.sceneGeneration) state.decodedAudioBuffers[soundData.id] = baseBuffer;
        } catch (decodeError) {
            console.error("Error decoding audio for reverse:", decodeError);
        }
    }

    const audioBuffer = wantsReverse
        ? getReversedAudioBuffer(soundData.id, baseBuffer)
        : baseBuffer;

    if (!audioBuffer) return { error: `サウンド「${soundData.name}」の音声データがキャッシュされていません。` };

    const playbackRate = Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1));
    // ピッチ保持は速度変更時のみ意味を持ち、該当時だけ粒合成を使う。
    // それ以外は生 AudioBufferSourceNode で再生する(メインスレッド非依存・群遅延ゼロ)。
    const sourceNode = createBufferPlaybackSource(audioBuffer, soundData, playbackRate);
    return { sourceNode, audioElement: null, objectUrl: null, audioBuffer };
}

// playSound 内の非同期ロード（IndexedDB 読み出し・デコード）の完了は activeAudios 登録より
// 前に発生するため、ロード中の再クリックが同じ soundId の再生を二重に開始し得る。
// この間の soundId を記録して直列化し、二重再生と停止不能な孤立プレイヤーを防ぐ。
const _startingSoundIds = new Set();
const _pendingStopIds = new Set();
const _pendingRollReleases = new Set();
const _cancelStartingRollIds = new Set();
const _pendingSustainStarts = new Map();

function cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl, individualGain, pannerNode, effectRack } = {}) {
    try { if (sourceNode && 'onended' in sourceNode) sourceNode.onended = null; } catch (e) { /* ignore */ }
    try { if (sourceNode && 'onstop' in sourceNode) sourceNode.onstop = null; } catch (e) { /* ignore */ }
    try { sourceNode?.stop?.(); } catch (e) { /* source may not have started */ }
    try { sourceNode?.disconnect?.(); } catch (e) { /* ignore */ }
    if (sourceNode instanceof Tone.GrainPlayer) {
        try { sourceNode.dispose(); } catch (e) { /* ignore */ }
    }
    try { audioElement?.pause?.(); } catch (e) { /* ignore */ }
    if (audioElement) {
        try { audioElement.src = ''; audioElement.load(); } catch (e) { /* ignore */ }
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    try { individualGain?.disconnect?.(); } catch (e) { /* ignore */ }
    try { pannerNode?.disconnect?.(); } catch (e) { /* ignore */ }
    disposeEffectRack(effectRack);
}

function isCurrentSceneRequest(sceneId, sceneGeneration, soundId) {
    return state.currentSceneId === sceneId
        && state.sceneGeneration === sceneGeneration
        && Boolean(state.scenes[sceneId]?.sounds.some(sound => sound.id === soundId));
}

export async function playSound(soundId, soundButtonElement, clickTime = null, startOffset = null) {
    if (!state.audioContext || state.audioContext.state !== 'running') { return; }

    const sceneId = state.currentSceneId;
    const sceneGeneration = state.sceneGeneration;
    const soundData = state.scenes[sceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.audioId) { if (state.showErrorPopups) showAlert("サウンドデータが見つかりません。"); return; }

    // 同一サウンドの再生開始が並走すると二重再生（片方は停止不能な孤立プレイヤー）になるため、
    // ロード中（activeAudios 登録前）の再開始要求は無視する。
    if (state.activeAudios[soundId] || _startingSoundIds.has(soundId)) { return; }
    _startingSoundIds.add(soundId);

    // Starting from a pad always supersedes a previously paused position.
    delete state.pausedSounds[soundId];

    let sourceNode;
    let audioElement = null;
    let objectUrl = null;
    let audioBuffer = null;
    let waveformPeaks = null;
    let pannerNode = null;
    let individualGain = null;
    let effectRack = null;

    let trimStart = 0;
    let trimEnd = 0;
    let playbackStart = 0;
    try {
        const created = await createSoundSourceNodes(soundData, sceneGeneration);
        if (created.error) {
            if (state.showErrorPopups) showAlert(created.error);
            return;
        }
        ({ sourceNode, audioElement, objectUrl, audioBuffer, waveformPeaks } = created);
        if (!isCurrentSceneRequest(sceneId, sceneGeneration, soundId)) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return;
        }
        if (audioElement) await waitForMediaMetadata(audioElement);
        const sourceDuration = audioBuffer?.duration || audioElement?.duration || soundData.duration;
        const trim = getTrimBounds(soundData, sourceDuration, Boolean(soundData.reverse));
        trimStart = trim.start;
        trimEnd = trim.end;
        playbackStart = Math.min(trimEnd, Math.max(trimStart, startOffset ?? trimStart));
        if (audioElement) {
            audioElement.loop = false;
            await setMediaElementPosition(audioElement, playbackStart);
        } else {
            sourceNode.loopStart = trimStart;
            sourceNode.loopEnd = trimEnd;
        }
        if (_pendingStopIds.delete(soundId)) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return;
        }
        if (!isCurrentSceneRequest(sceneId, sceneGeneration, soundId)) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return;
        }

        pannerNode = state.audioContext.createStereoPanner();
        pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, state.audioContext.currentTime);
        individualGain = state.audioContext.createGain();
        effectRack = createEffectRack(soundData.effects);

        sourceNode.connect(pannerNode);
        pannerNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(state.masterInputNode);

        individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);

        state.activeAudios[soundId] = {
            audioElement, sourceNode, pannerNode, individualGain, effectRack,
            audioBuffer, waveformPeaks: waveformPeaks || getWaveformPeaks(soundId, audioBuffer),
            meterAnimationFrameId: null, progressBarInterval: null, isFadingOut: false, objectUrl: objectUrl,
            muted: false,
            progressPercent: 0,
            stopAfterLoop: false,
            loopStopTime: null,
            playbackPosition: playbackStart,
            playbackPositionContextTime: state.audioContext.currentTime,
            playbackRate: Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1)),
            trimStart, trimEnd, trimBoundaryTimeoutId: null,
            fadeInEndTime: null, naturalFadeStartTime: null,
            soundId: soundId,
            sceneId,
            sceneGeneration,
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
                const currentAudio = state.activeAudios[soundId];
                if (currentAudio?.sceneGeneration !== sceneGeneration
                    || !isCurrentSceneRequest(sceneId, sceneGeneration, soundId)) {
                    cleanupAfterStop(soundId, soundButtonElement);
                    return;
                }
                recordStartMetric(soundId, clickTime, performance.now());
                updateButtonUI(soundId, soundButtonElement, true);
                updatePauseAllButton();
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
            updatePauseAllButton();
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
        if (state.activeAudios[soundId]) {
            cleanupAfterStop(soundId, soundButtonElement);
        } else {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl, individualGain, pannerNode, effectRack });
        }
    } finally {
        _startingSoundIds.delete(soundId);
        _pendingStopIds.delete(soundId);
    }
}

export function stopSound(soundId, soundButtonElement = null, useFadeOut = true) {
    stopSustainLayers(soundId, useFadeOut); // sustain モードの重ね再生ボイスも道連れに停止
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) {
        if (_startingSoundIds.has(soundId)) {
            _pendingStopIds.add(soundId);
            return;
        }
        if (_startingRollIds.has(soundId)) {
            _cancelStartingRollIds.add(soundId);
            _pendingRollReleases.delete(soundId);
            return;
        }
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
    for (const id of _startingSoundIds) _pendingStopIds.add(id);
    for (const id of _startingRollIds) _cancelStartingRollIds.add(id);
    for (const id of _startingRollIds) _pendingRollReleases.delete(id);
    for (const id of _pendingSustainStarts.keys()) stopSustainLayers(id, fadeOut);
}

// 即時停止（フェードなし）。retrigger の頭出し再再生で使用。
// 通常の stopSound は最低でも MIN_STOP_FADE_SECONDS の遅延が入るため、即座に playSound し直したい場合はこれを使う。
export function forceStopSound(soundId, soundButtonElement = null) {
    stopSustainLayers(soundId, false);
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo) {
        if (_startingSoundIds.has(soundId)) _pendingStopIds.add(soundId);
        if (_startingRollIds.has(soundId)) _cancelStartingRollIds.add(soundId);
        _pendingRollReleases.delete(soundId);
        return;
    }
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
async function getRollPartBuffer(cacheKey, audioId, soundName, expectedGeneration = state.sceneGeneration) {
    if (!audioId || !state.audioContext) return null;
    if (expectedGeneration !== state.sceneGeneration) return null;
    if (state.decodedAudioBuffers[cacheKey]) return state.decodedAudioBuffers[cacheKey];
    try {
        const audioRecord = await dbRequest('audio_files', 'readonly', 'get', audioId);
        const blob = audioRecord instanceof Blob ? audioRecord : audioRecord?.blob;
        if (!blob) return null;
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        if (expectedGeneration === state.sceneGeneration) {
            state.decodedAudioBuffers[cacheKey] = audioBuffer;
        }
        return audioBuffer;
    } catch (error) {
        console.error(`Failed to decode roll part "${cacheKey}" of ${soundName}:`, error);
        return null;
    }
}

// シーン選択時の事前デコード。LOW_MEMORY は初回再生時にデコードする。
export async function preloadRollParts(soundData, expectedGeneration = state.sceneGeneration) {
    if (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY || expectedGeneration !== state.sceneGeneration) return;
    const rollParts = soundData?.rollParts || {};
    const tasks = [];
    if (rollParts.intro) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'intro'), rollParts.intro, soundData.name, expectedGeneration));
    (rollParts.loops || []).forEach((audioId, index) => {
        if (audioId) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, `loop:${index}`), audioId, soundData.name, expectedGeneration));
    });
    if (rollParts.end) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'end'), rollParts.end, soundData.name, expectedGeneration));
    if (rollParts.finish) tasks.push(getRollPartBuffer(rollPartCacheKey(soundData.id, 'finish'), rollParts.finish, soundData.name, expectedGeneration));
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

// チェーンの1パートを生成する。前パートの終端よりクロスフェード分だけ早く開始し、
// 両方の音源が実際に重なる区間でGainを逆方向にランプする。
function scheduleRollChainItem(info, kind, buffer, requestedStart, isTerminal) {
    const ctx = state.audioContext;
    const prev = info.scheduled[info.scheduled.length - 1] || null;
    const crossfade = prev
        ? Math.min(ROLL_CROSSFADE_SECONDS, prev.buffer.duration / 2, buffer.duration / 2)
        : 0;
    const sourceStart = prev
        ? Math.max(prev.endTime - crossfade, ctx.currentTime)
        : Math.max(requestedStart, ctx.currentTime);
    const endTime = sourceStart + buffer.duration;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(info.pannerNode);

    const item = { kind, buffer, source, gain, sourceStart, endTime };
    const boundary = prev ? Math.max(prev.endTime, sourceStart) : sourceStart;
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
        const fadeOutSeconds = Math.min(ROLL_CROSSFADE_SECONDS, buffer.duration / 2);
        const fadeOutStart = Math.max(endTime - fadeOutSeconds, boundary);
        gain.gain.setValueAtTime(1, fadeOutStart);
        gain.gain.linearRampToValueAtTime(0.0001, endTime);
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
        if (item.endTime > now - 0.1) return true;
        item.source.onended = null;
        try { item.source.disconnect(); } catch (e) { /* ignore */ }
        try { item.gain.disconnect(); } catch (e) { /* ignore */ }
        return false;
    });

    while (info.chainTime < horizon) {
        const next = nextRollChainItem(info);
        if (!next) break; // 末尾までスケジュール済み
        const item = scheduleRollChainItem(info, next.kind, next.buffer, info.chainTime, next.terminal);
        info.chainTime = item.endTime;
    }

    // 離上後の末尾までスケジュールし終えたらポーリングを止める
    if (info.rollReleased && info.tailIndex >= info.tailBuffers.length) {
        clearInterval(info.rollSchedulerId);
        info.rollSchedulerId = null;
    }
}

// ロール再生を開始する。押下開始（キー/パッド/キーボードビュー）から呼ばれる。
// 起こり（無ければ省略）から始まり、ループパート群を登録順に循環させて鳴らし続ける。
const _startingRollIds = new Set();

export async function startRollPlayback(soundId, soundButtonElement, clickTime = null) {
    if (_startingRollIds.has(soundId)) return true;
    _startingRollIds.add(soundId);
    try {
        return await startRollPlaybackInternal(soundId, soundButtonElement, clickTime);
    } finally {
        _startingRollIds.delete(soundId);
        _pendingRollReleases.delete(soundId);
        _cancelStartingRollIds.delete(soundId);
    }
}
async function startRollPlaybackInternal(soundId, soundButtonElement, clickTime = null) {
    if (!state.audioContext) return false;
    if (state.audioContext.state !== 'running') await resumeAudioContext();
    if (state.audioContext.state !== 'running') {
        // 通常サウンド（handleSoundButtonClick）と同じ案内を出す
        if (state.showErrorPopups) showAlert("オーディオの準備ができていません。画面をクリック後、再度お試しください。", "通知");
        return false;
    }
    delete state.pausedSounds[soundId];
    const sceneId = state.currentSceneId;
    const sceneGeneration = state.sceneGeneration;
    const soundData = state.scenes[sceneId]?.sounds.find(s => s.id === soundId);
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
    const introBuffer = partIds.intro ? await getRollPartBuffer(rollPartCacheKey(soundId, 'intro'), partIds.intro, soundData.name, sceneGeneration) : null;
    const loopBuffers = [];
    for (let index = 0; index < (partIds.loops || []).length; index++) {
        const audioId = partIds.loops[index];
        if (!audioId) continue;
        const buffer = await getRollPartBuffer(rollPartCacheKey(soundId, `loop:${index}`), audioId, soundData.name, sceneGeneration);
        if (buffer) loopBuffers.push(buffer);
    }
    const endBuffer = partIds.end ? await getRollPartBuffer(rollPartCacheKey(soundId, 'end'), partIds.end, soundData.name, sceneGeneration) : null;
    const finishBuffer = partIds.finish ? await getRollPartBuffer(rollPartCacheKey(soundId, 'finish'), partIds.finish, soundData.name, sceneGeneration) : null;

    // デコード待ちの間にシーン切替・削除があった場合は中断する
    if (_cancelStartingRollIds.has(soundId) || !isCurrentSceneRequest(sceneId, sceneGeneration, soundId)) return false;
    if (!loopBuffers.length) {
        if (state.showErrorPopups) showAlert(`サウンド「${soundData.name}」のループ音声を読み込めません。`);
        return false;
    }

    const ctx = state.audioContext;
    let pannerNode = null;
    let individualGain = null;
    let effectRack = null;
    try {
        pannerNode = ctx.createStereoPanner();
        pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, ctx.currentTime);
        individualGain = ctx.createGain();
        effectRack = createEffectRack(soundData.effects);
        pannerNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(state.masterInputNode);
    } catch (err) {
        console.error("Error creating roll voice:", err);
        cleanupUnregisteredVoice({ individualGain, pannerNode, effectRack });
        return false;
    }
    individualGain.gain.setValueAtTime(0.0001, ctx.currentTime);

    const now = ctx.currentTime;
    const audioInfo = {
        isRoll: true,
        soundId: soundId,
        sceneId,
        sceneGeneration,
        audioElement: null, objectUrl: null, sourceNode: null,
        introBuffer, loopBuffers, endBuffer, finishBuffer,
        scheduled: [],           // チェーンのパート再生キュー（時刻順）
        chainTime: now,          // 最後にスケジュールしたパートの終了時刻
        introConsumed: false,
        loopCursor: 0,
        tailBuffers: [], tailKinds: [], tailIndex: 0, // 離上後の終わり→締め
        rollSchedulerId: null,
        rollReleaseTime: null,
        rollReleased: false,
        pannerNode, individualGain, effectRack,
        audioBuffer: introBuffer ?? loopBuffers[0],
        waveformPeaks: null,
        meterAnimationFrameId: null, progressBarInterval: null,
        isFadingOut: false, muted: false, progressPercent: 0,
        playbackPosition: 0, playbackPositionContextTime: now, playbackRate: 1,
        fadeInEndTime: null, naturalFadeStartTime: null,
        peakL: 0, peakR: 0
    };
    state.activeAudios[soundId] = audioInfo;
    if (_pendingRollReleases.delete(soundId)) endRollPlayback(soundId);

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
    if (!audioInfo?.isRoll || audioInfo.rollReleased || audioInfo.isFadingOut) {
        if (!audioInfo && _startingRollIds.has(soundId) && !_cancelStartingRollIds.has(soundId)) _pendingRollReleases.add(soundId);
        return;
    }

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
    audioInfo.chainTime = current ? current.endTime : now;
    audioInfo.tailBuffers = [];
    audioInfo.tailKinds = [];
    audioInfo.tailIndex = 0;
    if (audioInfo.endBuffer) { audioInfo.tailBuffers.push(audioInfo.endBuffer); audioInfo.tailKinds.push('end'); }
    if (audioInfo.finishBuffer) { audioInfo.tailBuffers.push(audioInfo.finishBuffer); audioInfo.tailKinds.push('finish'); }

    if (!audioInfo.tailBuffers.length) {
        // 終わりも締めも無いロールは現在パートの自然終了で完了する
        if (audioInfo.rollSchedulerId) { clearInterval(audioInfo.rollSchedulerId); audioInfo.rollSchedulerId = null; }
        if (!current || current.endTime <= now) {
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
// startOffset で一時停止からの再開位置を指定できる。
// 開始に成功したら true を返す。
export async function startSustainLayer(soundId, startOffset = 0) {
    if (!state.audioContext || state.audioContext.state !== 'running') return false;
    const sceneId = state.currentSceneId;
    const sceneGeneration = state.sceneGeneration;
    const soundData = state.scenes[sceneId]?.sounds.find(s => s.id === soundId);
    if (!soundData?.audioId) return false;

    const startToken = { cancelled: false };
    let pendingStarts = _pendingSustainStarts.get(soundId);
    if (!pendingStarts) _pendingSustainStarts.set(soundId, pendingStarts = new Set());
    pendingStarts.add(startToken);
    const startStillValid = () => !startToken.cancelled && isCurrentSceneRequest(sceneId, sceneGeneration, soundId);
    try {

    let sourceNode, audioElement, objectUrl, audioBuffer;
    let waveformPeaks = null;
    let pannerNode = null;
    let individualGain = null;
    let effectRack = null;
    let layer = null;
    let trimStart = 0;
    let trimEnd = 0;
    let playbackStart = 0;
    try {
        const created = await createSoundSourceNodes(soundData, sceneGeneration);
        if (created.error) {
            if (state.showErrorPopups) showAlert(created.error);
            return false;
        }
        ({ sourceNode, audioElement, objectUrl, audioBuffer, waveformPeaks } = created);
        if (!startStillValid()) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return false;
        }
        if (audioElement) await waitForMediaMetadata(audioElement);
        if (!startStillValid()) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return false;
        }
        const sourceDuration = audioBuffer?.duration || audioElement?.duration || soundData.duration;
        const trim = getTrimBounds(soundData, sourceDuration, Boolean(soundData.reverse));
        trimStart = trim.start;
        trimEnd = trim.end;
        playbackStart = Math.min(trimEnd, Math.max(trimStart, startOffset ?? trimStart));
        if (audioElement) {
            audioElement.loop = false;
            await setMediaElementPosition(audioElement, playbackStart);
            if (!startStillValid()) {
                cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
                return false;
            }
        } else {
            sourceNode.loopStart = trimStart;
            sourceNode.loopEnd = trimEnd;
        }
        if (!startStillValid()) {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl });
            return false;
        }
    } catch (err) {
        console.error("Error in startSustainLayer:", err);
        cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl, individualGain, pannerNode, effectRack });
        return false;
    }

    try {
        pannerNode = state.audioContext.createStereoPanner();
        pannerNode.pan.setValueAtTime(Number.isFinite(soundData.pan) ? soundData.pan : 0, state.audioContext.currentTime);
        individualGain = state.audioContext.createGain();
        effectRack = createEffectRack(soundData.effects);
        individualGain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
        sourceNode.connect(pannerNode);
        pannerNode.connect(individualGain);
        individualGain.connect(effectRack.entry);
        effectRack.exit.connect(state.masterInputNode);

        layer = {
            soundId, sourceNode, audioElement, objectUrl, audioBuffer,
            sceneId,
            sceneGeneration,
            waveformPeaks: waveformPeaks || getWaveformPeaks(soundId, audioBuffer),
            pannerNode, individualGain, effectRack,
            playbackPosition: playbackStart,
            playbackPositionContextTime: state.audioContext.currentTime,
            playbackRate: Math.max(0.25, Math.min(4, soundData.playbackRate ?? 1)),
            trimStart, trimEnd, trimBoundaryTimeoutId: null,
            fadeInEndTime: null, naturalFadeStartTime: null, isFadingOut: false
        };

        const finishLayer = () => disposeSustainLayer(soundId, layer, false);
        if (audioElement) {
            const trimTimeUpdateHandler = () => {
                if (audioElement.currentTime >= trimEnd - 0.005) {
                    scheduleTrimBoundaryForVoice(layer, soundData, finishLayer, () => state.sustainLayers[soundId]?.includes(layer));
                }
            };
            layer.trimTimeUpdateHandler = trimTimeUpdateHandler;
            audioElement.addEventListener('timeupdate', trimTimeUpdateHandler);
        }
        if (audioElement) { // LOW_MEMORY
            audioElement.onended = finishLayer;
            audioElement.onerror = finishLayer;
            await setMediaElementPosition(audioElement, playbackStart);
            if (!startStillValid()) {
                cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl, individualGain, pannerNode, effectRack });
                return false;
            }
        } else {
            if ('onended' in sourceNode) sourceNode.onended = finishLayer;
            else sourceNode.onstop = finishLayer;
            sourceNode.start(0, playbackStart);
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
            if (!startStillValid()) {
                disposeSustainLayer(soundId, layer, false);
                return false;
            }
        }
        scheduleTrimBoundaryForVoice(
            layer,
            soundData,
            finishLayer,
            () => state.sustainLayers[soundId]?.includes(layer)
        );
        // LOW_MEMORY の <audio> は play() 後に duration が確定するため、ここで終端フェードを計算する。
        scheduleNaturalFadeOutFor(layer, soundData);
        updateSustainLayerBadge(soundId, getSustainLayerCount(soundId));
        triggerWaveformUpdate();
        return true;
    } catch (err) {
        console.error("Error in startSustainLayer:", err);
        if (layer && state.sustainLayers[soundId]?.includes(layer)) {
            disposeSustainLayer(soundId, layer, false);
        } else {
            cleanupUnregisteredVoice({ sourceNode, audioElement, objectUrl, individualGain, pannerNode, effectRack });
        }
        return false;
    }
    } finally {
        const starts = _pendingSustainStarts.get(soundId);
        starts?.delete(startToken);
        if (starts?.size === 0) _pendingSustainStarts.delete(soundId);
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
    clearTimeout(layer.trimBoundaryTimeoutId);
    layer.trimBoundaryTimeoutId = null;
    if (layer.audioElement) {
        if (layer.trimTimeUpdateHandler) {
            layer.audioElement.removeEventListener('timeupdate', layer.trimTimeUpdateHandler);
        }
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
    triggerWaveformUpdate();
}

export function stopSustainLayers(soundId, useFadeOut = true) {
    const pending = _pendingSustainStarts.get(soundId);
    pending?.forEach(token => { token.cancelled = true; });
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

// ボイス（本体または sustain レイヤー）の現在位置をループ設定に沿って正規化する。
// 不正な位置は null を返す。
function normalizeVoicePosition(voice, sound) {
    const fullDuration = voice.audioBuffer?.duration || voice.audioElement?.duration || sound?.duration;
    const trimStart = Number.isFinite(voice.trimStart) ? voice.trimStart : 0;
    const trimEnd = Number.isFinite(voice.trimEnd) ? voice.trimEnd : fullDuration;
    const duration = trimEnd - trimStart;
    let position = getCurrentSourcePosition(voice);
    if (Number.isFinite(duration) && duration > 0) {
        position = sound?.loop
            ? trimStart + (((position - trimStart) % duration) + duration) % duration
            : Math.min(trimEnd, Math.max(trimStart, position));
    }
    return Number.isFinite(position) && position >= 0 ? position : null;
}

export function pauseSound(soundId, soundButtonElement = null) {
    const audioInfo = state.activeAudios[soundId];
    const layers = state.sustainLayers[soundId];
    const hasMain = Boolean(audioInfo) && !audioInfo.isFadingOut;
    const hasLayers = Boolean(layers?.length);
    if ((!hasMain && !hasLayers) || !state.audioContext) return false;

    // ロールは途中から再開できないため、Option(Alt)操作でも停止として扱う。
    if (audioInfo?.isRoll) {
        stopSound(soundId, soundButtonElement);
        return true;
    }

    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    const position = hasMain ? normalizeVoicePosition(audioInfo, sound) : null;
    const layerPositions = [];
    for (const layer of layers ?? []) {
        const pos = layer.isFadingOut ? null : normalizeVoicePosition(layer, sound);
        if (pos !== null) layerPositions.push(pos);
    }
    if (position === null && layerPositions.length === 0) return false;

    // sustain レイヤーも位置を保存して道連れに一時停止する
    for (const layer of [...(layers ?? [])]) {
        disposeSustainLayer(soundId, layer, false);
    }
    state.pausedSounds[soundId] = { position, pausedAt: Date.now(), layers: layerPositions };
    if (!soundButtonElement) soundButtonElement = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);

    if (hasMain) {
        if (audioInfo.meterAnimationFrameId) cancelAnimationFrame(audioInfo.meterAnimationFrameId);
        if (audioInfo.progressBarInterval) clearInterval(audioInfo.progressBarInterval);
        audioInfo.sourceNode.onended = null;
        if ('onstop' in audioInfo.sourceNode) audioInfo.sourceNode.onstop = null;
        try {
            if (audioInfo.audioElement && !audioInfo.audioElement.paused) audioInfo.audioElement.pause();
            if (audioInfo.sourceNode && typeof audioInfo.sourceNode.stop === 'function') audioInfo.sourceNode.stop();
        } catch (_) { /* the audio source may already have ended */ }
        cleanupAfterStop(soundId, soundButtonElement, false);
    }
    updateButtonUI(soundId, soundButtonElement, false, true);
    updatePausedProgress(soundId, soundButtonElement, position ?? layerPositions[0] ?? 0);
    updatePauseAllButton();
    return true;
}

export async function resumeSound(soundId, soundButtonElement = null) {
    const paused = state.pausedSounds[soundId];
    if (!paused) return false;
    delete state.pausedSounds[soundId];
    if (Number.isFinite(paused.position)) {
        await playSound(soundId, soundButtonElement, performance.now(), paused.position);
    }
    // 一時停止時に鳴っていた sustain レイヤーも同じ位置から再開する
    for (const layerPosition of paused.layers ?? []) {
        await startSustainLayer(soundId, layerPosition);
    }
    updatePauseAllButton();
    return true;
}

export async function togglePauseAllSounds() {
    const activeIds = new Set(Object.entries(state.activeAudios)
        .filter(([, audio]) => !audio.isFadingOut)
        .map(([soundId]) => soundId));
    // 本体が自然終了してレイヤーだけ鳴っているサウンドも対象にする
    Object.keys(state.sustainLayers).forEach(soundId => activeIds.add(soundId));
    if (activeIds.size > 0) {
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
            const trimStart = Number.isFinite(audioInfo.trimStart) ? audioInfo.trimStart : 0;
            const trimEnd = Number.isFinite(audioInfo.trimEnd) ? audioInfo.trimEnd : audioInfo.audioElement.duration;
            audioInfo.audioElement.currentTime = Math.max(trimStart, Math.min(trimEnd, seekTime));
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

export function updateActiveSoundLoop(soundId, loop) {
    const audioInfo = state.activeAudios[soundId];
    if (!audioInfo || audioInfo.isRoll || !state.audioContext) return; // ロールのループはパート構成で決まる

    const now = state.audioContext.currentTime;
    const fullDuration = audioInfo.audioBuffer?.duration || audioInfo.audioElement?.duration;
    const trimStart = Number.isFinite(audioInfo.trimStart) ? audioInfo.trimStart : 0;
    const trimEnd = Number.isFinite(audioInfo.trimEnd) ? audioInfo.trimEnd : fullDuration;
    const duration = Math.max(0, trimEnd - trimStart);
    let position = getCurrentSourcePosition(audioInfo);
    const isGrainPlayer = audioInfo.sourceNode instanceof Tone.GrainPlayer;
    const loopPosition = duration > 0
        ? trimStart + (((position - trimStart) % duration) + duration) % duration
        : trimStart;

    const isBufferSource = !isGrainPlayer && !audioInfo.audioElement;
    if (!audioInfo.audioElement && !loop && duration > 0) {
        // ループ解除: 現在の周回の終端まで再生してから停止する。
        // 終端での実際の停止は scheduleTrimBoundary がオーディオクロックで予約する。
        audioInfo.stopAfterLoop = true;
        audioInfo.loopStopTime = now + (trimEnd - loopPosition) / Math.max(0.001, audioInfo.playbackRate);
        position = loopPosition;
        if (isGrainPlayer) audioInfo.sourceNode.stop(audioInfo.loopStopTime);
    } else if (isGrainPlayer && loop && audioInfo.stopAfterLoop) {
        // 解除直後に再度ONにした場合は、終端停止の予約をリスタートで打ち消す。
        audioInfo.sourceNode.loopStart = trimStart;
        audioInfo.sourceNode.loopEnd = trimEnd;
        audioInfo.sourceNode.loop = true;
        audioInfo.sourceNode.restart(now, loopPosition);
        audioInfo.stopAfterLoop = false;
        audioInfo.loopStopTime = null;
        audioInfo.playbackPosition = loopPosition;
        audioInfo.playbackPositionContextTime = now;
        position = loopPosition;
    } else if (isBufferSource && loop && audioInfo.stopAfterLoop) {
        // ネイティブソースの終端停止予約は取消不能なため、ループ位置から再生成する。
        audioInfo.stopAfterLoop = false;
        audioInfo.loopStopTime = null;
        restartNativeSource(audioInfo, soundDataForLoopRestart(soundId), loopPosition);
        audioInfo.playbackPosition = loopPosition;
        audioInfo.playbackPositionContextTime = now;
        position = loopPosition;
    } else if (!loop && !isGrainPlayer) {
        if (Number.isFinite(duration) && duration > 0) {
            position = Math.max(trimStart, Math.min(trimEnd, position));
        }
    }

    if (audioInfo.audioElement) {
        // Native looping cannot honor a non-zero trim start, so boundaries are handled manually.
        audioInfo.audioElement.loop = false;
    } else {
        audioInfo.sourceNode.loopStart = trimStart;
        audioInfo.sourceNode.loopEnd = trimEnd;
        audioInfo.sourceNode.loop = Boolean(loop);
    }

    if (duration > 0) {
        const elapsed = position - trimStart;
        const currentTime = loop || audioInfo.stopAfterLoop
            ? ((elapsed % duration) + duration) % duration
            : Math.min(duration, Math.max(0, elapsed));
        const progressPercent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
        audioInfo.progressPercent = progressPercent;
        const soundButton = dom.soundboard?.querySelector(`.sound-button[data-id="${soundId}"]`);
        soundButton?.style.setProperty('--progress', `${progressPercent}%`);
        const progressBarValue = soundButton?.querySelector('.progress-bar-value');
        if (progressBarValue) progressBarValue.style.width = `${progressPercent}%`;
        setKeyboardKeyProgress(soundId, progressPercent);
    }
    scheduleTrimBoundary(soundId);
    scheduleNaturalFadeOut(soundId);
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
               const currentPosition = getCurrentSourcePosition(audioInfo);
               audioInfo.playbackPosition = currentPosition;
               audioInfo.playbackPositionContextTime = now;
               const shouldUseGrain = needsPitchPreserve(soundData, rate);
               const isGrainPlayer = audioInfo.sourceNode instanceof Tone.GrainPlayer;
               if (audioInfo.audioBuffer && isGrainPlayer !== shouldUseGrain) {
                   const restartPosition = normalizeVoicePosition(audioInfo, soundData) ?? currentPosition;
                   replaceBufferPlaybackSource(audioInfo, soundData, restartPosition, rate);
               } else if (audioInfo.sourceNode instanceof Tone.GrainPlayer) {
                   audioInfo.sourceNode.playbackRate = rate;
                   audioInfo.sourceNode.detune = soundData.preservePitch ? 0 : 1200 * Math.log2(rate);
                   audioInfo.playbackRate = rate;
               } else if (audioInfo.sourceNode?.playbackRate) {
                   try {
                       audioInfo.sourceNode.playbackRate.setTargetAtTime(rate, now, 0.05);
                   } catch (e) {
                       try { audioInfo.sourceNode.playbackRate.value = rate; } catch (_) { /* ignore */ }
                   }
                   audioInfo.playbackRate = rate;
               }
           } else {
               audioInfo.audioElement.preservesPitch = Boolean(soundData.preservePitch);
               audioInfo.audioElement.playbackRate = rate;
           }
           scheduleNaturalFadeOut(soundId);
           scheduleTrimBoundary(soundId);
       }

function cleanupAfterStop(soundId, soundButtonElement, resetProgress = true) {
    const audioInfo = state.activeAudios[soundId];

    if (audioInfo) {
        clearTimeout(audioInfo.trimBoundaryTimeoutId);
        audioInfo.trimBoundaryTimeoutId = null;
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
            if (audioInfo.trimTimeUpdateHandler) {
                audioInfo.audioElement.removeEventListener('timeupdate', audioInfo.trimTimeUpdateHandler);
            }
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

export async function getAudioBufferFromDataUrl(soundId, dataUrl, expectedGeneration = null) {
    if (!state.audioContext) return null;
    if (state.performanceMode === PERFORMANCE_MODE.LOW_MEMORY) return null;
    if (expectedGeneration !== null && expectedGeneration !== state.sceneGeneration) return null;
    if (state.decodedAudioBuffers[soundId]) return state.decodedAudioBuffers[soundId];

    try {
        const fetchResponse = await fetch(dataUrl);
        const arrayBuffer = await fetchResponse.arrayBuffer();
        const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
        if (expectedGeneration === null || expectedGeneration === state.sceneGeneration) {
            state.decodedAudioBuffers[soundId] = audioBuffer;
        }
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
    const fullDuration = audioBuffer?.duration || audioElement?.duration || soundData?.duration || 0;
    const trimStart = Number.isFinite(audioInfo.trimStart) ? audioInfo.trimStart : 0;
    const trimEnd = Number.isFinite(audioInfo.trimEnd) ? audioInfo.trimEnd : fullDuration;
    const duration = Math.max(0, trimEnd - trimStart);

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

        const sourcePosition = getCurrentSourcePosition(audioInfo)
            - getAudibleLatencySeconds() * audioInfo.playbackRate;
        const elapsed = sourcePosition - trimStart;
        const currentTime = soundData?.loop || audioInfo.stopAfterLoop
            ? ((elapsed % duration) + duration) % duration
            : Math.min(duration, Math.max(0, elapsed));

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

        // Worklet が計測した RMS (256サンプル窓) を参照する
        const meterValues = audioInfo.effectRack?.meter || { rmsL: 0, rmsR: 0 };
        const pctL = dbToPct(meterValues.rmsL);
        const pctR = dbToPct(meterValues.rmsR);

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
    if (state.masterMeterFrameId || !state.masterChain || !state.audioContext) return;
    const meterElement = dom.levelMeterArea?.querySelector('.master-meter');
    const leftValue = meterElement?.querySelector('.meter-bar.left .meter-value');
    const rightValue = meterElement?.querySelector('.meter-bar.right .meter-value');
    const leftPeak = meterElement?.querySelector('.meter-bar.left .meter-peak');
    const rightPeak = meterElement?.querySelector('.meter-bar.right .meter-peak');
    if (!leftValue || !rightValue) return;

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

        const meterValues = state.masterChain?.meter || { rmsL: 0, rmsR: 0 };
        const pctL = dbToPct(meterValues.rmsL);
        const pctR = dbToPct(meterValues.rmsR);

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
    // ロールは波形表示の対象外。本体が自然終了してレイヤーだけ鳴る場合は描画を継続する。
    const hasActiveSounds = Object.values(state.activeAudios).some(audio => !audio.isFadingOut && !audio.isRoll)
        || Object.values(state.sustainLayers).some(layers => layers.some(layer => !layer.isFadingOut));
    if (hasActiveSounds && !state.isWaveformLoopRunning) {
        startWaveformDisplayLoop();
    } else if (!hasActiveSounds && state.isWaveformLoopRunning) {
        stopWaveformDisplayLoop();
    } else if (!hasActiveSounds && !state.isWaveformLoopRunning) {
        clearWaveformDisplay();
    }
}

// 波形描画用のピークを soundId 単位でキャッシュする。本体と sustain レイヤーで共用し、
// バッファが差し替わったら（再インポート・逆再生など）計算し直す。
function getWaveformPeaks(soundId, audioBuffer) {
    if (!audioBuffer) return null;
    const cached = state.waveformPeaksCache[soundId];
    if (cached && cached.buffer === audioBuffer) return cached.peaks;
    const peaks = precomputeWaveformPeaks(audioBuffer);
    state.waveformPeaksCache[soundId] = { buffer: audioBuffer, peaks };
    return peaks;
}

function precomputeWaveformPeaks(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    // ピーク間隔は整数サンプルで確定し、実効レイトを保存する。44.1kHz など
    // sampleRate/500 が割り切れない場合、固定値 500 で索引すると時間のたびに
    // ズレが累積する(4分で約0.54秒)ため、必ず実効値を使う。
    const samplesPerPeak = Math.max(1, Math.round(sampleRate / 500));
    const peaksPerSecond = sampleRate / samplesPerPeak;
    const totalPeaks = Math.max(1, Math.ceil(duration * peaksPerSecond));
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
            playheadWidth: parseFloat(cs.getPropertyValue('--waveform-playhead-width').trim()) || 2,
            centerLine: isDarkMode ? '#333333' : '#dcdcdc'
        };
    };
    refreshStyles();

    function drawLoop() {
        if (!state.isWaveformLoopRunning) return;

        const { clientWidth: canvasWidth, clientHeight: canvasHeight } = dom.waveformCanvas;

        dom.waveformCtx.fillStyle = cachedStyles.bg;
        dom.waveformCtx.fillRect(0, 0, canvasWidth, canvasHeight);

        // 描画対象 = ロール以外の本体 (activeAudios) + sustain レイヤーの全ボイス。
        // レイヤーはUIを持たないが、波形には重ねて反映する。
        const voices = [];
        for (const audioInfo of Object.values(state.activeAudios)) {
            if (!audioInfo.isFadingOut && !audioInfo.isRoll) voices.push(audioInfo);
        }
        for (const layers of Object.values(state.sustainLayers)) {
            for (const layer of layers) {
                if (!layer.isFadingOut) voices.push(layer);
            }
        }
        if (voices.length === 0) { stopWaveformDisplayLoop(); return; }

        // 中央ガイド線（voxwarp方式: 波形の下地に薄い中心線を引く）
        const centerY = canvasHeight / 2;
        dom.waveformCtx.strokeStyle = cachedStyles.centerLine;
        dom.waveformCtx.lineWidth = 1;
        dom.waveformCtx.beginPath();
        dom.waveformCtx.moveTo(0, Math.round(centerY) + 0.5);
        dom.waveformCtx.lineTo(canvasWidth, Math.round(centerY) + 0.5);
        dom.waveformCtx.stroke();

        // --- パス1: 1ピクセル幅の min/max エンベロープを組み立てる ---
        const columns = Math.max(1, Math.ceil(canvasWidth));
        const rawMin = new Float32Array(columns);
        const rawMax = new Float32Array(columns);
        const active = new Uint8Array(columns);

        // Pixel-snap: round base time to pixel grid so the same peak
        // maps to the same x every frame until the waveform advances
        // by a full pixel. Eliminates per-frame peak shimmer.
        const secondsPerPixel = WAVEFORM_SECONDS_AHEAD / canvasWidth;
        const audibleLatencySeconds = getAudibleLatencySeconds();

        for (let x = 0; x < columns; x++) {
            let summedMinPeak = 0;
            let summedMaxPeak = 0;
            let contributionCount = 0;

            const timeOffsetFromLeftEdge = (x / canvasWidth) * WAVEFORM_SECONDS_AHEAD;

            for (const audioInfo of voices) {
                const { audioBuffer, waveformPeaks, individualGain } = audioInfo;
                if (!waveformPeaks) continue;

                const soundData = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === audioInfo.soundId);
                if (!soundData) continue;

                const gainValue = individualGain.gain.value;
                const trimStart = Number.isFinite(audioInfo.trimStart) ? audioInfo.trimStart : 0;
                const fullDuration = audioBuffer?.duration || waveformPeaks.duration || soundData.duration;
                const trimEnd = Number.isFinite(audioInfo.trimEnd) ? audioInfo.trimEnd : fullDuration;
                const duration = trimEnd - trimStart;
                if (duration <= 0) continue;
                const playbackRate = getCurrentPlaybackRate(audioInfo);
                // 描画基準は「いま聴こえている位置」。出力レイテンシ分の先読みを差し引く。
                const rawBaseTime = getCurrentSourcePosition(audioInfo) - audibleLatencySeconds * playbackRate;

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

            if (contributionCount > 0) {
                rawMin[x] = summedMinPeak / contributionCount;
                rawMax[x] = summedMaxPeak / contributionCount;
                active[x] = 1;
            }
        }

        let first = -1;
        let last = -1;
        for (let x = 0; x < columns; x++) {
            if (active[x]) {
                if (first < 0) first = x;
                last = x;
            }
        }

        if (first >= 0) {
            // --- パス2: 5タップbinomialカーネルでスムージング（voxwarpと同じ重み） ---
            const smooth = (source) => {
                const out = new Float32Array(columns);
                const weights = [1, 4, 6, 4, 1];
                for (let x = 0; x < columns; x++) {
                    if (!active[x]) continue;
                    let sum = 0;
                    let used = 0;
                    for (let k = -2; k <= 2; k++) {
                        const xi = Math.max(0, Math.min(columns - 1, x + k));
                        if (!active[xi]) continue;
                        const w = weights[k + 2];
                        sum += source[xi] * w;
                        used += w;
                    }
                    out[x] = sum / Math.max(1, used || 16);
                }
                return out;
            };
            const smoothMin = smooth(rawMin);
            const smoothMax = smooth(rawMax);

            // --- パス3: スムーズ値と生値を 74:26 でブレンド（子音・トランジェントを残す） ---
            const lower = new Float32Array(columns);
            const upper = new Float32Array(columns);
            const rawMix = 0.26;
            for (let x = first; x <= last; x++) {
                if (!active[x]) continue;
                lower[x] = smoothMin[x] * (1 - rawMix) + rawMin[x] * rawMix;
                upper[x] = smoothMax[x] * (1 - rawMix) + rawMax[x] * rawMix;
            }

            // --- パス4: 中点二次補間で塗りつぶし（DAW風の滑らかなエンベロープ） ---
            const amp = canvasHeight * 0.43;
            const yUpper = (x) => centerY - upper[x] * amp;
            const yLower = (x) => centerY - lower[x] * amp;

            dom.waveformCtx.fillStyle = cachedStyles.stroke;
            dom.waveformCtx.beginPath();
            dom.waveformCtx.moveTo(first, yUpper(first));
            for (let x = first + 1; x <= last; x++) {
                const midX = x - 0.5;
                const midY = (yUpper(x - 1) + yUpper(x)) / 2;
                dom.waveformCtx.quadraticCurveTo(x - 1, yUpper(x - 1), midX, midY);
            }
            dom.waveformCtx.lineTo(last, yUpper(last));
            dom.waveformCtx.lineTo(last, yLower(last));
            for (let x = last - 1; x >= first; x--) {
                const midX = x + 0.5;
                const midY = (yLower(x + 1) + yLower(x)) / 2;
                dom.waveformCtx.quadraticCurveTo(x + 1, yLower(x + 1), midX, midY);
            }
            dom.waveformCtx.lineTo(first, yLower(first));
            dom.waveformCtx.closePath();
            dom.waveformCtx.fill();
        }

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

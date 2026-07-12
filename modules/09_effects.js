// modules/09_effects.js
//
// Tone.js based effect rack with serial chain.
//
// Serial chain contract:
//   input → compensation → EQ3 → Compressor → Distortion → Reverb → [dry + delay mix] → limiter/bypass → output
//
// Every effect feeds the next. Disabling an effect makes it transparent
// (flat EQ, unity compressor, wet=0 for distortion/reverb) rather
// than removing it from the chain. The delay taps from the reverb output,
// so echoes are always shaped by EQ, compressor, distortion and reverb.
//
// Uniform latency: every signal passes through the compensation delay,
// so dry and wet stay time-aligned regardless of effect settings.
//
// Latency note: PitchShift is intentionally excluded — real-time pitch
// shifting requires a processing window (typically 50ms+) that violates
// the sub-20ms latency budget. Distortion (WaveShaper) and Reverb
// (ConvolverNode) are sample-accurate and add no inherent delay.

import * as Tone from 'tone';
import { AUDIO_PARAM_RAMP_SECONDS, DEFAULT_EFFECT_SETTINGS } from './01_config.js';

export const UNIFORM_COMPENSATION_SECONDS = 0.006;

function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
}

function rampParam(param, value, seconds = AUDIO_PARAM_RAMP_SECONDS) {
    if (!param) return;
    const ctx = param.context || Tone.getContext();
    const now = ctx.currentTime;
    try {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, seconds);
    } catch (e) {
        try { param.value = value; } catch (_) { /* param not settable */ }
    }
}

export function normalizeEffectSettings(settings = {}) {
    const base = DEFAULT_EFFECT_SETTINGS;
    const eq = settings.eq ?? {};
    const delay = settings.delay ?? {};
    const compressor = settings.compressor ?? {};
    const distortion = settings.distortion ?? {};
    const reverb = settings.reverb ?? {};
    const limiter = settings.limiter ?? {};

    return {
        enabled: Boolean(settings.enabled ?? base.enabled),
        wet: clamp(settings.wet ?? base.wet, 0, 1),
        eq: {
            enabled: Boolean(eq.enabled ?? base.eq.enabled),
            low: clamp(eq.low ?? base.eq.low, -12, 12),
            mid: clamp(eq.mid ?? base.eq.mid, -12, 12),
            high: clamp(eq.high ?? base.eq.high, -12, 12),
            lowFrequency: clamp(eq.lowFrequency ?? base.eq.lowFrequency, 50, 2000),
            highFrequency: clamp(eq.highFrequency ?? base.eq.highFrequency, 1000, 12000)
        },
        delay: {
            enabled: Boolean(delay.enabled ?? base.delay.enabled),
            time: clamp(delay.time ?? base.delay.time, 0, 2),
            feedback: clamp(delay.feedback ?? base.delay.feedback, 0, 0.85),
            level: clamp(delay.level ?? base.delay.level, 0, 1)
        },
        compressor: {
            enabled: Boolean(compressor.enabled ?? base.compressor.enabled),
            threshold: clamp(compressor.threshold ?? base.compressor.threshold, -60, 0),
            ratio: clamp(compressor.ratio ?? base.compressor.ratio, 1, 20)
        },
        distortion: {
            enabled: Boolean(distortion.enabled ?? base.distortion.enabled),
            amount: clamp(distortion.amount ?? base.distortion.amount, 0, 1)
        },
        reverb: {
            enabled: Boolean(reverb.enabled ?? base.reverb.enabled),
            decay: clamp(reverb.decay ?? base.reverb.decay, 0.1, 10),
            preDelay: clamp(reverb.preDelay ?? base.reverb.preDelay, 0, 0.1),
            wet: clamp(reverb.wet ?? base.reverb.wet, 0, 1)
        },
        limiter: {
            enabled: Boolean(limiter.enabled ?? base.limiter.enabled),
            threshold: clamp(limiter.threshold ?? base.limiter.threshold, -12, 0)
        }
    };
}

export function createEffectRack(settings = {}) {
    const input = new Tone.Gain(1);
    const compensation = new Tone.Delay(UNIFORM_COMPENSATION_SECONDS, UNIFORM_COMPENSATION_SECONDS * 2);
    const eq3 = new Tone.EQ3({ low: 0, mid: 0, high: 0, lowFrequency: 400, highFrequency: 2500 });
    const compressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.003, release: 0.12 });
    const distortionNode = new Tone.Distortion({ distortion: 0.4, wet: 0 });
    const reverbNode = new Tone.Reverb({ decay: 2.0, preDelay: 0.01, wet: 0 });
    const dryGain = new Tone.Gain(1);
    const wetGain = new Tone.Gain(0);
    const feedbackDelay = new Tone.FeedbackDelay({ delayTime: 0.18, feedback: 0, maxDelay: 2 });
    const delayReturn = new Tone.Gain(0);
    const output = new Tone.Gain(1);
    const limiter = new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0.001, release: 0.08 });
    const limiterSafety = new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0, release: 0.03 });
    const limiterDry = new Tone.Gain(1);
    const limiterWet = new Tone.Gain(0);
    const finalOutput = new Tone.Gain(1);

    // Serial chain: input → compensation → EQ3 → Compressor → Distortion → Reverb
    input.connect(compensation);
    compensation.connect(eq3);
    eq3.connect(compressor);
    compressor.connect(distortionNode);
    distortionNode.connect(reverbNode);

    // Dry tap: from reverb output (post-EQ/Comp/Distortion/Reverb)
    reverbNode.connect(dryGain);
    dryGain.connect(output);

    // Wet (EQ+Comp+Distortion+Reverb) level control
    reverbNode.connect(wetGain);
    wetGain.connect(output);

    // Delay taps from reverb output — echoes are always shaped by the full chain
    reverbNode.connect(feedbackDelay);
    feedbackDelay.connect(delayReturn);
    delayReturn.connect(output);

    output.connect(limiterDry);
    output.connect(limiter);
    limiterDry.connect(finalOutput);
    limiter.connect(limiterSafety);
    limiterSafety.connect(limiterWet);
    limiterWet.connect(finalOutput);

    const rack = {
        input, output, compensation,
        eq3, compressor,
        distortionNode, reverbNode,
        dryGain, wetGain,
        feedbackDelay, delayReturn, limiter, limiterSafety, limiterDry, limiterWet, finalOutput,
        entry: input.input,
        exit: finalOutput.output
    };

    applyEffectSettings(rack, settings, null, true);
    return rack;
}

export function applyEffectSettings(rack, settings, _audioContext = null, immediate = false) {
    if (!rack) return;
    const normalized = normalizeEffectSettings(settings);
    const ramp = immediate ? 0.001 : AUDIO_PARAM_RAMP_SECONDS;
    // 親トグルがoffの時は、子エフェクトのenabledに関わらず全て無効化する
    // (UI側でも制御するが、音響ロジックでも確実にガードする)
    const masterEnabled = normalized.enabled;

    // EQ3: disabled = flat (0 dB all bands)
    const eqActive = masterEnabled && normalized.eq.enabled;
    rampParam(rack.eq3.low, eqActive ? normalized.eq.low : 0, ramp);
    rampParam(rack.eq3.mid, eqActive ? normalized.eq.mid : 0, ramp);
    rampParam(rack.eq3.high, eqActive ? normalized.eq.high : 0, ramp);
    try {
        rack.eq3.lowFrequency.value = normalized.eq.lowFrequency;
        rack.eq3.highFrequency.value = normalized.eq.highFrequency;
    } catch (e) { /* frequency signals are set directly */ }

    // Compressor: disabled = unity (ratio 1, no reduction)
    const compActive = masterEnabled && normalized.compressor.enabled;
    rampParam(rack.compressor.threshold, compActive ? normalized.compressor.threshold : 0, ramp);
    rampParam(rack.compressor.ratio, compActive ? normalized.compressor.ratio : 1, ramp);

    // Distortion: disabled = wet 0 (bypass)
    const distortionActive = masterEnabled && normalized.distortion.enabled;
    rampParam(rack.distortionNode.wet, distortionActive ? 1 : 0, ramp);
    if (distortionActive) {
        try { rack.distortionNode.distortion = normalized.distortion.amount; } catch (e) { /* amount set directly */ }
    }

    // Reverb: disabled = wet 0 (bypass). decay/preDelay set directly (async generate, immediate .value is fine)
    const reverbActive = masterEnabled && normalized.reverb.enabled;
    try {
        rack.reverbNode.decay = normalized.reverb.decay;
        rack.reverbNode.preDelay = normalized.reverb.preDelay;
    } catch (e) { /* decay/preDelay set directly */ }
    rampParam(rack.reverbNode.wet, reverbActive ? normalized.reverb.wet : 0, ramp);

    // Delay: taps from reverb output, disabled = zero return
    const delayActive = masterEnabled && normalized.delay.enabled;
    rampParam(rack.feedbackDelay.delayTime, normalized.delay.time, ramp);
    rampParam(rack.feedbackDelay.feedback, delayActive ? normalized.delay.feedback : 0, ramp);
    rampParam(rack.delayReturn.gain, delayActive ? normalized.delay.level * normalized.wet : 0, ramp);

    // Limiter: 親トグル連動。thresholdは常に保持(有効化時に即座に効くように)
    const limiterActive = masterEnabled && normalized.limiter.enabled;
    rampParam(rack.limiter.threshold, normalized.limiter.threshold, ramp);
    rampParam(rack.limiterSafety.threshold, normalized.limiter.threshold, ramp);
    rampParam(rack.limiterDry.gain, limiterActive ? 0 : 1, ramp);
    rampParam(rack.limiterWet.gain, limiterActive ? 1 : 0, ramp);

    // Dry / wet balance
    // dryGain is always active — it carries the post-chain signal at a
    // level that depends on whether serial effects (EQ/Comp/Distortion)
    // are engaged. wetGain boosts the same signal further when those are active.
    // Reverb mixes internally via its own wet param, so it is not part of wetGain.
    const hasSerialEffect = eqActive || compActive || distortionActive;
    const anyEffect = masterEnabled && (hasSerialEffect || delayActive || reverbActive);

    if (anyEffect) {
        const wetLevel = normalized.wet;
        // dryGain carries (1 - wet) of the signal so total doesn't double
        rampParam(rack.dryGain.gain, 1 - Math.min(wetLevel, 0.95), ramp);
        rampParam(rack.wetGain.gain, hasSerialEffect ? wetLevel : 0, ramp);
    } else {
        rampParam(rack.dryGain.gain, 1, ramp);
        rampParam(rack.wetGain.gain, 0, ramp);
    }
}

export function disposeEffectRack(rack) {
    if (!rack) return;
    const nodes = [
        rack.input, rack.output, rack.compensation,
        rack.eq3, rack.compressor,
        rack.distortionNode, rack.reverbNode,
        rack.dryGain, rack.wetGain,
        rack.feedbackDelay, rack.delayReturn,
        rack.limiter, rack.limiterSafety, rack.limiterDry, rack.limiterWet, rack.finalOutput
    ];
    for (const node of nodes) {
        try { node?.dispose(); } catch (e) { /* ignore */ }
    }
}

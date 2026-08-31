// modules/09_effects.js
//
// AudioWorklet-based effect rack with serial chain.
//
// Serial chain contract (identical to the previous Tone.js rack):
//   input → EQ3 → Compressor → Distortion → Reverb → [dry + delay mix] → limiter/bypass → output
//
// Physical graph per rack (no added fixed group delay — the previous native
// DynamicsCompressorNode lookahead and 6ms uniform compensation
// delay are gone; IIR phase and intentional effect delays remain):
//
//   entry ──► pon-voice-front ──┬────────────────────────► pon-voice-back(in0)
//              (EQ3→Comp→Dist)  └─► [ConvolverNode] ────► pon-voice-back(in1)
//                                    (only while reverb wet > 0)
//   pon-voice-back ──► exit
//
// The ConvolverNode is the same native node type the previous rack used, so
// the reverb tail (including browser-side IR normalization) is unchanged.
// Its impulse response is generated with the exact Tone.js Reverb.generate()
// algorithm (white noise, exponential approach to 0 over `decay`, `preDelay`
// silence prefix), but only when reverb is first enabled or decay/preDelay
// changes — previously every playSound re-rendered the IR 3 times.
//
// Every effect feeds the next. Disabling an effect makes it transparent
// (flat EQ, unity compressor, wet=0 for distortion/reverb) rather than
// removing it from the chain. The delay taps from the reverb output, so
// echoes are always shaped by EQ, compressor, distortion and reverb.

import { DEFAULT_EFFECT_SETTINGS } from './01_config.js';

// The context the racks are built in. Set by initAudioContext().
let sharedContext = null;
let workletModulePromise = null;

export function setEffectsContext(audioContext) {
    if (sharedContext === audioContext && audioContext) return;
    sharedContext = audioContext;
    workletModulePromise = null;
}

// Loads the worklet module into the shared context (once).
export function ensureWorkletModule(audioContext = sharedContext) {
    if (!audioContext) return Promise.reject(new Error('AudioContext not ready'));
    if (!workletModulePromise || sharedContext !== audioContext) {
        const workletUrl = new URL('./worklets/pon-dsp.js', import.meta.url);
        workletModulePromise = audioContext.audioWorklet.addModule(workletUrl);
    }
    return workletModulePromise;
}

function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
}

let rackCounter = 0;

function wirePort(port, target, extraOnMessage) {
    port.onmessage = (event) => {
        const data = event.data;
        if (data && data.type === 'meter' && target) {
            target.rmsL = data.rmsL;
            target.rmsR = data.rmsR;
        }
        extraOnMessage?.(data);
    };
}

// ---------------------------------------------------------------------------
// Tone.js Reverb IR generation — exact algorithm port (white noise, exp decay)
// ---------------------------------------------------------------------------

export function generateReverbImpulse(audioContext, decay, preDelay) {
    const sampleRate = audioContext.sampleRate;
    const length = Math.max(1, Math.floor((decay + preDelay) * sampleRate));
    const ir = audioContext.createBuffer(2, length, sampleRate);
    const preDelaySamples = Math.min(length, Math.floor(preDelay * sampleRate));
    // Tone.Param.exponentialApproachValueAtTime uses a logarithmic approach
    // for 90% of the requested ramp, then a final 10% linear segment.
    const timeConstant = Math.log(decay + 1) / Math.log(200);
    const approachDuration = decay * 0.9;
    const approachEndGain = Math.exp(-approachDuration / timeConstant);
    for (let channel = 0; channel < 2; channel++) {
        const data = ir.getChannelData(channel);
        for (let i = preDelaySamples; i < length; i++) {
            const t = i / sampleRate - preDelay;
            let envelope;
            if (t <= 0) {
                envelope = 1;
            } else if (t < approachDuration) {
                envelope = Math.exp(-t / timeConstant);
            } else {
                envelope = approachEndGain * (1 - (t - approachDuration) / (decay * 0.1));
            }
            data[i] = (Math.random() * 2 - 1) * Math.max(0, envelope);
        }
    }
    return ir;
}

const REVERB_IR_DEBOUNCE_MS = 50;

function requestReverbImpulse(owner, audioContext, decay, preDelay) {
    const key = `${decay}:${preDelay}`;
    if (owner.impulse && owner.impulseDecay === decay && owner.impulsePreDelay === preDelay) return;
    owner.pendingImpulse = { decay, preDelay, key };
    clearTimeout(owner.reverbGenerationTimer);
    owner.reverbGenerationTimer = setTimeout(() => {
        owner.reverbGenerationTimer = null;
        const pending = owner.pendingImpulse;
        if (!pending || pending.key !== key || owner.disposed) return;
        // The timer coalesces rapid knob input; the expensive allocation is not
        // performed in the pointer/input event itself.
        const impulse = generateReverbImpulse(audioContext, pending.decay, pending.preDelay);
        owner.pendingImpulse = null;
        if (!owner.convolver || !owner.convolverActive || owner.disposed) return;
        owner.impulse = impulse;
        owner.impulseDecay = pending.decay;
        owner.impulsePreDelay = pending.preDelay;
        owner.convolver.buffer = impulse;
    }, REVERB_IR_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Settings normalization (unchanged public behavior)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rack construction
// ---------------------------------------------------------------------------

function makeWorkletNode(audioContext, processorName, nodeId, settings, numberOfInputs = 1) {
    return new AudioWorkletNode(audioContext, processorName, {
        numberOfInputs,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { nodeId, settings }
    });
}

// Reverb wiring: the native ConvolverNode is created on first use and its IR
// is regenerated only when decay/preDelay actually change (debounced).
function updateReverbWiring(rack, normalized) {
    const audioContext = sharedContext;
    const reverbActive = normalized.enabled && normalized.reverb.enabled && normalized.reverb.wet > 0;
    if (!reverbActive) {
        clearTimeout(rack.reverbGenerationTimer);
        rack.reverbGenerationTimer = null;
        rack.pendingImpulse = null;
        if (rack.convolver) {
            // Keep the node but starve it — the back worklet mixes it out (rw → 0).
            // Disconnecting the dry feed is not needed; input silence lets the
            // browser skip most convolution work.
            try { rack.front.disconnect(rack.convolver); } catch (e) { /* not connected */ }
            rack.convolverActive = false;
        }
        return;
    }

    if (!rack.convolver) {
        rack.convolver = audioContext.createConvolver(); // normalize=true, same as Tone.Reverb
        rack.convolver.connect(rack.back, 0, 1);         // wet return → back input 1
    }
    if (!rack.convolverActive) {
        rack.front.connect(rack.convolver);
        rack.convolverActive = true;
    }

    const decay = normalized.reverb.decay;
    const preDelay = normalized.reverb.preDelay;
    requestReverbImpulse(rack, audioContext, decay, preDelay);
}

export function createEffectRack(settings = {}) {
    const audioContext = sharedContext;
    if (!audioContext) throw new Error('AudioContext not initialized');
    if (!audioContext.audioWorklet) throw new Error('AudioWorklet not supported');
    // ensureWorkletModule must have resolved before racks are created
    // (initAudioContext awaits it).

    const normalized = normalizeEffectSettings(settings);
    const rackId = `v${++rackCounter}`;
    let front = null;
    let back = null;
    let rack = null;
    try {
        front = makeWorkletNode(audioContext, 'pon-voice-front', `${rackId}-f`, frontSettings(normalized));
        back = makeWorkletNode(audioContext, 'pon-voice-back', `${rackId}-b`, backSettings(normalized), 2);
        front.connect(back, 0, 0); // dry path (post EQ/comp/dist) → back input 0

        rack = {
            input: front,
            output: back,
            // Keep the old rack contract used by the playback code.
            entry: front,
            exit: back,
            front,
            back,
            convolver: null,
            disposed: false,
            pendingImpulse: null,
            reverbGenerationTimer: null,
            convolverActive: false,
            impulse: null,
            impulseDecay: null,
            impulsePreDelay: null,
            meterId: rackId,
            meter: { rmsL: 0, rmsR: 0 },
            settings: normalized
        };
        wirePort(back.port, rack.meter);
        updateReverbWiring(rack, normalized);
        return rack;
    } catch (error) {
        disposeEffectRack(rack || { front, back });
        throw error;
    }
}

export function disposeMasterChain(chain) {
    if (!chain) return;
    chain.disposed = true;
    clearTimeout(chain.reverbGenerationTimer);
    try { chain.front?.disconnect(); } catch (e) { /* ignore */ }
    try { chain.back?.disconnect(); } catch (e) { /* ignore */ }
    try { chain.limit?.disconnect(); } catch (e) { /* ignore */ }
    try { chain.meterNode?.disconnect(); } catch (e) { /* ignore */ }
    try { chain.convolver?.disconnect(); } catch (e) { /* ignore */ }
    try { chain.front?.port.close(); } catch (e) { /* ignore */ }
    try { chain.back?.port.close(); } catch (e) { /* ignore */ }
    try { chain.limit?.port.close(); } catch (e) { /* ignore */ }
    try { chain.meterNode?.port.close(); } catch (e) { /* ignore */ }
    chain.pendingImpulse = null;
    chain.convolver = null;
    chain.impulse = null;
}

function frontSettings(normalized) {
    return {
        enabled: normalized.enabled,
        eq: normalized.eq,
        compressor: normalized.compressor,
        distortion: normalized.distortion
    };
}

function backSettings(normalized) {
    const eqActive = normalized.enabled && normalized.eq.enabled;
    const compActive = normalized.enabled && normalized.compressor.enabled;
    const distActive = normalized.enabled && normalized.distortion.enabled;
    const delayActive = normalized.enabled && normalized.delay.enabled;
    const reverbActive = normalized.enabled && normalized.reverb.enabled;
    return {
        enabled: normalized.enabled,
        wet: normalized.wet,
        hasSerialEffect: eqActive || compActive || distActive,
        hasAnyEffect: normalized.enabled && ((eqActive || compActive || distActive) || delayActive || reverbActive),
        reverbWet: reverbActive ? normalized.reverb.wet : 0,
        delay: normalized.delay,
        limiter: normalized.limiter
    };
}

export function applyEffectSettings(rack, settings, _audioContext = null, _immediate = false) {
    if (!rack) return;
    const normalized = normalizeEffectSettings(settings);
    rack.settings = normalized;
    rack.front.port.postMessage({ type: 'settings', settings: frontSettings(normalized) });
    rack.back.port.postMessage({ type: 'settings', settings: backSettings(normalized) });
    updateReverbWiring(rack, normalized);
}

export function disposeEffectRack(rack) {
    if (!rack) return;
    rack.disposed = true;
    clearTimeout(rack.reverbGenerationTimer);
    try { rack.front?.disconnect(); } catch (e) { /* ignore */ }
    try { rack.back?.disconnect(); } catch (e) { /* ignore */ }
    try { rack.convolver?.disconnect(); } catch (e) { /* ignore */ }
    try { rack.front?.port.close(); } catch (e) { /* ignore */ }
    try { rack.back?.port.close(); } catch (e) { /* ignore */ }
    rack.convolver = null;
    rack.impulse = null;
    rack.pendingImpulse = null;
}

// ---------------------------------------------------------------------------
// Master chain
// ---------------------------------------------------------------------------
//
// graph: masterInput → pon-master-front (Dist→EQ3→Comp) ─┬─► pon-master-back(in0)
//                                                        └─► [Convolver] ─► back(in1)
//        back → masterGain → masterPan → pon-master-limit → destination / recorder
//
// Returns an object mirroring the previous master nodes' control surface.

export async function createMasterChain(audioContext, initialState = {}) {
    await ensureWorkletModule(audioContext);

    const masterId = 'master';
    let front = null;
    let back = null;
    let limit = null;
    let meter = null;
    let chain = null;
    try {
        front = makeWorkletNode(audioContext, 'pon-master-front', `${masterId}-f`, masterFrontSettings(initialState));
        back = makeWorkletNode(audioContext, 'pon-master-back', `${masterId}-b`, masterBackSettings(initialState), 2);
        limit = makeWorkletNode(audioContext, 'pon-master-limit', `${masterId}-l`, { threshold: initialState.limiterThreshold ?? -1 });
        meter = makeWorkletNode(audioContext, 'pon-master-meter', `${masterId}-m`, {});
        front.connect(back, 0, 0);

        chain = {
            input: front,
            output: limit,
            front,
            back,
            limit,
            meterNode: meter,
            convolver: null,
            disposed: false,
            pendingImpulse: null,
            reverbGenerationTimer: null,
            convolverActive: false,
            impulse: null,
            impulseDecay: null,
            impulsePreDelay: null,
            meter: { rmsL: 0, rmsR: 0 },
            frontState: {
                eqLow: initialState.eqLow ?? 0,
                eqMid: initialState.eqMid ?? 0,
                eqHigh: initialState.eqHigh ?? 0,
                compThreshold: initialState.compThreshold ?? 0,
                compRatio: initialState.compRatio ?? 1,
                distortionAmount: initialState.distortionAmount ?? 0
            },
            backState: {
                reverbWet: initialState.reverbWet ?? 0,
                delayTime: initialState.delayTime ?? 0.18,
                delayFeedback: initialState.delayFeedback ?? 0,
                delayLevel: initialState.delayLevel ?? 0
            }
        };
        wirePort(meter.port, chain.meter);
        chain.updateReverb = (reverbState) => updateMasterReverb(chain, audioContext, reverbState);
        chain.updateReverb({ decay: initialState.reverbDecay ?? 2.0, preDelay: 0.01, wet: initialState.reverbWet ?? 0 });
        return chain;
    } catch (error) {
        disposeMasterChain(chain || { front, back, limit, meterNode: meter });
        throw error;
    }
}
function masterFrontSettings(initialState) {
    return {
        // Master EQ/compressor are always "engaged" nodes — transparency comes
        // from their values (0dB bands, ratio 1), exactly like the previous chain.
        eq: {
            enabled: true,
            low: initialState.eqLow ?? 0,
            mid: initialState.eqMid ?? 0,
            high: initialState.eqHigh ?? 0,
            lowFrequency: 400,
            highFrequency: 2500
        },
        compressor: {
            enabled: true,
            threshold: initialState.compThreshold ?? 0,
            ratio: initialState.compRatio ?? 1
        },
        distortionAmount: initialState.distortionAmount ?? 0
    };
}

function masterBackSettings(initialState) {
    return {
        reverbWet: initialState.reverbWet ?? 0,
        delayTime: initialState.delayTime ?? 0.18,
        delayFeedback: initialState.delayFeedback ?? 0,
        delayLevel: initialState.delayLevel ?? 0
    };
}

function updateMasterReverb(chain, audioContext, reverbState) {
    const wet = clamp(reverbState?.wet ?? 0, 0, 1);
    chain.backState = { ...(chain.backState || {}), reverbWet: wet };
    const reverbActive = wet > 0;
    if (!reverbActive) {
        clearTimeout(chain.reverbGenerationTimer);
        chain.reverbGenerationTimer = null;
        chain.pendingImpulse = null;
        if (chain.convolver) {
            try { chain.front.disconnect(chain.convolver); } catch (e) { /* not connected */ }
            chain.convolverActive = false;
        }
        chain.back.port.postMessage({ type: 'settings', settings: masterBackSettings(chain.backState) });
        return;
    }
    if (!chain.convolver) {
        chain.convolver = audioContext.createConvolver();
        chain.convolver.connect(chain.back, 0, 1);
    }
    if (!chain.convolverActive) {
        chain.front.connect(chain.convolver);
        chain.convolverActive = true;
    }
    const decay = clamp(reverbState?.decay ?? 2.0, 0.1, 10);
    const preDelay = clamp(reverbState?.preDelay ?? 0.01, 0, 0.1);
    requestReverbImpulse(chain, audioContext, decay, preDelay);
    chain.back.port.postMessage({ type: 'settings', settings: masterBackSettings(chain.backState) });
}

// Partial master updates (used by setMasterParam). Partials are merged onto
// the last known state so every message carries complete stage settings.
export function applyMasterChainSettings(chain, partial) {
    if (!chain) return;
    chain.frontState = { ...(chain.frontState || {}), ...partial };
    chain.front.port.postMessage({ type: 'settings', settings: masterFrontSettings(chain.frontState) });
}

export function applyMasterChainDelay(chain, partial) {
    if (!chain) return;
    chain.backState = { ...(chain.backState || {}), ...partial };
    chain.back.port.postMessage({ type: 'settings', settings: masterBackSettings(chain.backState) });
}

export function applyMasterChainReverb(chain, reverbState) {
    chain?.updateReverb?.(reverbState);
}

export function applyMasterChainLimiter(chain, threshold) {
    if (!chain) return;
    chain.limit.port.postMessage({ type: 'settings', settings: { threshold } });
}

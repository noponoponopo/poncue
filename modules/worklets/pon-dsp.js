// modules/worklets/pon-dsp.js
//
// AudioWorklet processors implementing the poncue effect chain without fixed
// compensation or DynamicsCompressorNode lookahead latency.
//
// Registered processors (single module):
//   pon-voice-front  : EQ3 → Compressor → Distortion      (outputs pre-reverb signal)
//   pon-voice-back   : reverb dry/wet sum → rack dry/wet → Delay send → Limiter → Safety → out (+meter)
//   pon-master-front : Distortion → EQ3 → Compressor      (master order: distortion first)
//   pon-master-back  : reverb dry/wet sum → dry + Delay send → out
//   pon-master-meter : transparent pre-pan meter tap
//   pon-master-limit : Limiter → LimiterSafety
//
// The topology follows the previous Tone.js rack (main branch
// modules/09_effects.js). References:
//   - EQ3 = Tone MultibandSplit (4 biquads, Q=1, 12dB/oct) + band gains (dB→linear), summed
//   - Compressor/Limiter = selectable zero-lookahead gain-computer baseline;
//     its makeup/ballistics are a sound-quality decision, not claimed bit-identical
//   - Distortion = Tone.js WaveShaper curve (4096 points, linear interpolation, oversample none)
//   - Reverb mix = equal-power crossfade: dry·cos(rw·π/2) + wet·sin(rw·π/2)
//     (industry-standard insert mix; keeps perceived loudness constant for the
//     decorrelated dry + tail. Tone.Reverb's linear crossfade dipped -3dB at center)
//   - Delay = linear-interpolated feedback delay line (echo geometry impulse-verified)
//   - Metering = RMS over a rolling 256-sample window (replaces per-voice AnalyserNodes)

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

function dbToLin(db) {
    return Math.pow(10, db / 20);
}

// Clip to [min, max]; non-finite falls back to fallbackValue.
function clampNum(v, min, max, fallbackValue) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallbackValue;
    return n < min ? min : (n > max ? max : n);
}

// One-pole smoothing coefficient for a setTargetAtTime-like time constant.
function smoothCoef(timeConstant, sampleRate) {
    if (!(timeConstant > 0)) return 0; // instant
    return Math.exp(-1 / (timeConstant * sampleRate));
}

// Per-BLOCK step for values smoothed once per render quantum (128 samples).
// Applying the per-sample coefficient per block would make ramps 128x slower.
function blockStep(timeConstant, sampleRate) {
    const quantum = (typeof renderQuantum === 'number' && renderQuantum > 0) ? renderQuantum : 128;
    return 1 - Math.pow(smoothCoef(timeConstant, sampleRate), quantum);
}

// ---------------------------------------------------------------------------
// Biquad (WebAudio spec formulas — same coefficient math as BiquadFilterNode)
// ---------------------------------------------------------------------------

class Biquad {
    constructor(sampleRate, type, freq, q) {
        this.sampleRate = sampleRate;
        this.states = [
            { x1: 0, x2: 0, y1: 0, y2: 0 },
            { x1: 0, x2: 0, y1: 0, y2: 0 }
        ];
        this.configure(type || 'lowpass', freq || 350, q || 1);
    }

    configure(type, freq, q) {
        // Normalized frequency, clamped to (0, nyquist)
        const nyquist = this.sampleRate / 2;
        const f0 = clampNum(freq, 1, nyquist * 0.9999, 350) / this.sampleRate;
        const w0 = 2 * Math.PI * f0;
        const cosw0 = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        let b0, b1, b2, a0, a1, a2;

        if (type === 'lowpass') {
            b0 = (1 - cosw0) / 2;
            b1 = 1 - cosw0;
            b2 = (1 - cosw0) / 2;
            a0 = 1 + alpha;
            a1 = -2 * cosw0;
            a2 = 1 - alpha;
        } else { // highpass
            b0 = (1 + cosw0) / 2;
            b1 = -(1 + cosw0);
            b2 = (1 + cosw0) / 2;
            a0 = 1 + alpha;
            a1 = -2 * cosw0;
            a2 = 1 - alpha;
        }
        this.b0 = b0 / a0;
        this.b1 = b1 / a0;
        this.b2 = b2 / a0;
        this.a1 = a1 / a0;
        this.a2 = a2 / a0;
    }

    // Per-channel direct form processing. input may be null (treated as silence).
    run(input, output, start, end, offset, channel = 0) {
        const state = this.states[channel] || this.states[0];
        let { x1, x2, y1, y2 } = state;
        const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
        for (let i = start; i < end; i++) {
            const x = input ? input[i + offset] : 0;
            const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            output[i] = y;
        }
        // denormal flush
        if (x1 > -1e-20 && x1 < 1e-20) x1 = 0;
        if (x2 > -1e-20 && x2 < 1e-20) x2 = 0;
        if (y1 > -1e-20 && y1 < 1e-20) y1 = 0;
        if (y2 > -1e-20 && y2 < 1e-20) y2 = 0;
        state.x1 = x1; state.x2 = x2; state.y1 = y1; state.y2 = y2;
    }
}

// Tone.js EQ3 equivalent topology: parallel low / mid / high bands.
// low:  lowpass(lowFrequency, Q=1)
// mid:  highpass(lowFrequency, Q=1) → lowpass(highFrequency, Q=1)
// high: highpass(highFrequency, Q=1)
class Eq3 {
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.lowF = 400;
        this.highF = 2500;
        this.gLow = 1; this.gMid = 1; this.gHigh = 1;          // smoothed (linear)
        this.targetLow = 1; this.targetMid = 1; this.targetHigh = 1;
        this.lowBiquad = new Biquad(sampleRate, 'lowpass', 400, 1);
        this.midHp = new Biquad(sampleRate, 'highpass', 400, 1);
        this.midLp = new Biquad(sampleRate, 'lowpass', 2500, 1);
        this.highBiquad = new Biquad(sampleRate, 'highpass', 2500, 1);
        this.scratch = new Float32Array(128);
    }

    set(lowDb, midDb, highDb, lowF, highF) {
        this.targetLow = dbToLin(lowDb);
        this.targetMid = dbToLin(midDb);
        this.targetHigh = dbToLin(highDb);
        const lf = clampNum(lowF, 50, 2000, 400);
        const hf = clampNum(highF, 1000, 12000, 2500);
        if (lf !== this.lowF || hf !== this.highF) {
            this.lowF = lf;
            this.highF = hf;
            this.lowBiquad.configure('lowpass', lf, 1);
            this.midHp.configure('highpass', lf, 1);
            this.midLp.configure('lowpass', hf, 1);
            this.highBiquad.configure('highpass', hf, 1);
        }
    }

    smooth(step) {
        this.gLow += step * (this.targetLow - this.gLow);
        this.gMid += step * (this.targetMid - this.gMid);
        this.gHigh += step * (this.targetHigh - this.gHigh);
    }

    // Sum into outL/outR over [start, end). Each filter keeps independent
    // state for left and right, as native BiquadFilterNode does.
    run(inL, inR, outL, outR, start, end, offsetL, offsetR) {
        const n = end - start;
        if (this.scratch.length < n) this.scratch = new Float32Array(n);
        const scratch = this.scratch;
        const gL = this.gLow, gM = this.gMid, gH = this.gHigh;

        this.lowBiquad.run(inL, outL, start, end, offsetL, 0);
        for (let i = start; i < end; i++) outL[i] *= gL;
        this.lowBiquad.run(inR, outR, start, end, offsetR, 1);
        for (let i = start; i < end; i++) outR[i] *= gL;

        this.midHp.run(inL, scratch, start, end, offsetL, 0);
        this.midLp.run(scratch, scratch, 0, n, 0, 0);
        for (let i = 0; i < n; i++) outL[start + i] += scratch[i] * gM;

        this.midHp.run(inR, scratch, start, end, offsetR, 1);
        this.midLp.run(scratch, scratch, 0, n, 0, 1);
        for (let i = 0; i < n; i++) outR[start + i] += scratch[i] * gM;

        this.highBiquad.run(inL, scratch, start, end, offsetL, 0);
        for (let i = 0; i < n; i++) outL[start + i] += scratch[i] * gH;
        this.highBiquad.run(inR, scratch, start, end, offsetR, 1);
        for (let i = 0; i < n; i++) outR[start + i] += scratch[i] * gH;
    }
}

// ---------------------------------------------------------------------------
// Compressor / Limiter — DynamicsCompressorNode algorithm, zero lookahead
// ---------------------------------------------------------------------------

class DynamicsProcessor {
    constructor(sampleRate, threshold, ratio, knee, attack, release, bypassed) {
        this.sampleRate = sampleRate;
        this.attackCoef = 0;
        this.releaseCoef = 0;
        this.smoothedGain = 1;
        this.set(threshold, ratio, knee, attack, release, bypassed);
    }

    set(threshold, ratio, knee, attack, release, bypassed) {
        this.targetThreshold = clampNum(threshold, -60, 0, 0);
        this.ratio = clampNum(ratio, 1, 20, 1);
        this.knee = clampNum(knee, 0, 40, 0);
        this.attack = clampNum(attack, 0, 1, 0.003);
        this.release = clampNum(release, 0, 1, 0.12);
        this.bypassed = Boolean(bypassed) || this.ratio <= 1;
        this.attackCoef = this.attack > 0 ? Math.exp(-1 / (this.attack * this.sampleRate)) : 0;
        this.releaseCoef = this.release > 0 ? Math.exp(-1 / (this.release * this.sampleRate)) : 0;
        if (this.threshold === undefined) this.threshold = this.targetThreshold;
    }
    // Static gain computer (dB in → dB out). One-sided quadratic knee, continuous
    // with the linear (above-knee) region.
    static gainDb(x2, threshold, ratio, knee) {
        if (x2 <= threshold) return x2;
        const slope = 1 / ratio - 1;
        if (knee > 0) {
            const kneeEnd = threshold + knee;
            if (x2 < kneeEnd) {
                const x = x2 - threshold;
                return x2 + slope * x * x / knee;
            }
        }
        return threshold + slope * (x2 - threshold);
    }

    run(inL, inR, outL, outR, start, end, offsetL, offsetR) {
        if (this.bypassed) {
            for (let i = start; i < end; i++) {
                outL[i] = inL ? inL[i + offsetL] : 0;
                outR[i] = inR ? inR[i + offsetR] : 0;
            }
            return;
        }
        const ratio = this.ratio, knee = this.knee;
        let g = this.smoothedGain;
        const aCoef = this.attackCoef, rCoef = this.releaseCoef;
        let threshold = this.threshold;
        const thTarget = this.targetThreshold;
        const thStep = 1 - smoothCoef(PARAM_RAMP_SECONDS, this.sampleRate); // per-sample threshold smoothing
        for (let i = start; i < end; i++) {
            const l = inL ? inL[i + offsetL] : 0;
            const r = inR ? inR[i + offsetR] : 0;
            const abs = Math.max(Math.abs(l), Math.abs(r));
            let target;
            if (abs > 1e-8) {
                const x2 = 20 * Math.log10(abs);
                const y2 = DynamicsProcessor.gainDb(x2, threshold, ratio, knee);
                target = dbToLin(y2 - x2);
            } else {
                target = 1;
            }
            // Ballistics: fast when reducing (attack), slow when recovering (release)
            if (target < g) {
                g = aCoef === 0 ? target : target + aCoef * (g - target);
            } else {
                g = rCoef === 0 ? target : target + rCoef * (g - target);
            }
            outL[i] = l * g;
            outR[i] = r * g;
            threshold += (thTarget - threshold) * thStep;
        }
        if (g > -1e-20 && g < 1e-20) g = 1e-20;
        this.threshold = threshold;
        this.smoothedGain = g;
    }
}

// ---------------------------------------------------------------------------
// Distortion — Tone.js WaveShaper port (4096-point curve, linear interpolation)
// ---------------------------------------------------------------------------

class Waveshaper {
    constructor() {
        this.length = 4096;
        this.curve = new Float32Array(this.length);
        this.wet = 0;
        this.targetWet = 0;
        this.amount = -1;
        this.setAmount(0.4);
    }

    setAmount(amount) {
        const a = clampNum(amount, 0, 1, 0);
        if (a === this.amount) return;
        this.amount = a;
        const k = a * 100;
        const deg = Math.PI / 180;
        const n = this.length;
        const curve = this.curve;
        for (let i = 0; i < n; i++) {
            const x = (i * 2) / (n - 1) - 1;
            // Tone.js Distortion.setDistortion — identical formula
            curve[i] = Math.abs(x) < 0.001 ? 0 : ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
    }

    setWet(wet) {
        this.targetWet = clampNum(wet, 0, 1, 0);
    }

    smooth(step) {
        this.wet += step * (this.targetWet - this.wet);
    }

    static sample(curve, n, x) {
        // Native WaveShaperNode indexing + linear interpolation
        const idx = (x + 1) * ((n - 1) / 2);
        if (idx <= 0) return curve[0];
        if (idx >= n - 1) return curve[n - 1];
        const i0 = idx | 0;
        const frac = idx - i0;
        return curve[i0] + frac * (curve[i0 + 1] - curve[i0]);
    }

    // Wet crossfade matching the Tone Effect topology.
    run(inL, inR, outL, outR, start, end, offsetL, offsetR) {
        const wet = this.wet;
        if (wet <= 0.00001) {
            for (let i = start; i < end; i++) {
                outL[i] = inL ? inL[i + offsetL] : 0;
                outR[i] = inR ? inR[i + offsetR] : 0;
            }
            return;
        }
        const curve = this.curve, n = this.length;
        for (let i = start; i < end; i++) {
            const l = inL ? inL[i + offsetL] : 0;
            const r = inR ? inR[i + offsetR] : 0;
            outL[i] = (1 - wet) * l + wet * Waveshaper.sample(curve, n, l);
            outR[i] = (1 - wet) * r + wet * Waveshaper.sample(curve, n, r);
        }
    }
}

// ---------------------------------------------------------------------------
// Feedback delay — DelayNode + feedback gain equivalent (linear interpolation)
// ---------------------------------------------------------------------------

class FeedbackDelayLine {
    constructor(sampleRate, maxSeconds) {
        this.sampleRate = sampleRate;
        this.size = Math.ceil((maxSeconds || 2) * sampleRate) + 4;
        this.bufL = new Float32Array(this.size);
        this.bufR = new Float32Array(this.size);
        this.fbL = 0;
        this.fbR = 0;
        this.writeIndex = 0;
        this.delayTimeSeconds = 0.18;
        this.delaySamples = 0.18 * sampleRate;
        this.targetDelay = 0.18 * sampleRate;
        this.feedback = 0;
        this.targetFeedback = 0;
        this.level = 0;
        this.targetLevel = 0;
        this.moveCoef = 1 - smoothCoef(0.01, sampleRate); // per-sample step fraction
    }

    set(timeSeconds, feedback, level) {
        const t = clampNum(timeSeconds, 0, 2, 0.18);
        this.delayTimeSeconds = t;
        this.targetDelay = Math.min(this.size - 2, t * this.sampleRate);
        this.targetFeedback = clampNum(feedback, 0, 0.85, 0);
        this.targetLevel = clampNum(level, 0, 1, 0);
        if (this.level === undefined) this.level = this.targetLevel;
    }

    // Writes the (level × tapped) delay output into outL/outR over [start, end).
    run(inL, inR, outL, outR, start, end, offsetL, offsetR) {
        const size = this.size;
        const bufL = this.bufL, bufR = this.bufR;
        let feedback = this.feedback;
        const targetFeedback = this.targetFeedback;
        let lvl = this.level;
        let fbL = this.fbL, fbR = this.fbR;
        let readPos = this.delaySamples;
        const target = this.targetDelay;
        const step = this.moveCoef;
        let write = this.writeIndex;
        const lvlTarget = this.targetLevel;

        for (let i = start; i < end; i++) {
            const l = inL ? inL[i + offsetL] : 0;
            const r = inR ? inR[i + offsetR] : 0;
            feedback += (targetFeedback - feedback) * step;
            bufL[write] = l + feedback * fbL;
            bufR[write] = r + feedback * fbR;

            // read `readPos` samples behind the write position, linear interpolation
            const i0 = Math.floor(readPos);
            const frac = readPos - i0;
            const iA = write - i0;
            const iB = iA - 1;
            const iA2 = iA < 0 ? iA + size : iA;
            const iB2 = iB < 0 ? iB + size : iB;
            const dl = bufL[iA2] + frac * (bufL[iB2] - bufL[iA2]);
            const dr = bufR[iA2] + frac * (bufR[iB2] - bufR[iA2]);
            fbL = dl;
            fbR = dr;
            outL[i] = dl * lvl;
            outR[i] = dr * lvl;
            lvl += (lvlTarget - lvl) * step;

            write = (write + 1) % size;
            readPos += (target - readPos) * step;
        }
        this.fbL = fbL > -1e-20 && fbL < 1e-20 ? 0 : fbL;
        this.fbR = fbR > -1e-20 && fbR < 1e-20 ? 0 : fbR;
        this.writeIndex = write;
        this.delaySamples = readPos;
        this.feedback = feedback;
        this.level = lvl;
    }
}

// ---------------------------------------------------------------------------
// Rolling RMS meter (256-sample window ≈ previous AnalyserNode fftSize 256)
// ---------------------------------------------------------------------------

class RmsMeter {
    constructor() {
        this.window = 256;
        this.bufL = new Float32Array(this.window);
        this.bufR = new Float32Array(this.window);
        this.pos = 0;
        this.filled = 0;
        this.sumL = 0;
        this.sumR = 0;
        this.rmsL = 0;
        this.rmsR = 0;
    }

    push(inL, inR, start, end, offsetL, offsetR) {
        const w = this.window;
        const bufL = this.bufL, bufR = this.bufR;
        let pos = this.pos, filled = this.filled, sumL = this.sumL, sumR = this.sumR;
        for (let i = start; i < end; i++) {
            const l = inL ? inL[i + offsetL] : 0;
            const r = inR ? inR[i + offsetR] : 0;
            const oldL = bufL[pos], oldR = bufR[pos];
            sumL += l * l - oldL * oldL;
            sumR += r * r - oldR * oldR;
            bufL[pos] = l;
            bufR[pos] = r;
            pos = pos + 1 === w ? 0 : pos + 1;
            if (filled < w) filled++;
        }
        this.pos = pos;
        this.filled = filled;
        this.sumL = sumL > 0 ? sumL : 0;
        this.sumR = sumR > 0 ? sumR : 0;
        this.rmsL = filled ? Math.sqrt(this.sumL / filled) : 0;
        this.rmsR = filled ? Math.sqrt(this.sumR / filled) : 0;
    }
}

// ---------------------------------------------------------------------------
// Processor base
// ---------------------------------------------------------------------------

const PARAM_RAMP_SECONDS = 0.01; // mirrors AUDIO_PARAM_RAMP_SECONDS on the main thread

class PonBaseProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        // AudioWorkletProcessor receives the node options array; the user
        // payload lives in nodeOptions.processorOptions (fallback for engines
        // that pass it directly).
        // Chrome/spec variants: options may be [nodeOptionsDict], the dict
        // itself, or [processorOptions]. Extract the user payload robustly.
        const raw = options;
        let nodeOptions = {};
        if (Array.isArray(raw)) nodeOptions = raw[0] || {};
        else if (raw && typeof raw === 'object') nodeOptions = raw;
        const opts = nodeOptions.processorOptions || nodeOptions;
        this.nodeId = String(opts.nodeId || '');
        this.initSettings = opts.settings || {};
        this.rampCoef = smoothCoef(PARAM_RAMP_SECONDS, sampleRate); // per-sample
        this.blockStep = blockStep(PARAM_RAMP_SECONDS, sampleRate); // per-block
        this.meterCounter = 0;
        this.meterEvery = 6; // blocks (~16ms @ 128/48k)
        this.meter = new RmsMeter();
        this.scratch = { l: new Float32Array(128), r: new Float32Array(128) };
        this.port.onmessage = (e) => this.handleMessage(e.data);
        // NOTE: subclass constructors must call this.applySettings(this.initSettings)
        // AFTER initializing their DSP fields — never from this base constructor.
    }

    handleMessage(data) {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'settings') {
            try { this.applySettings(data.settings || {}); } catch (err) { /* ignore bad payload */ }
        } else if (data.type === 'config') {
            if (Number.isFinite(data.meterEvery)) this.meterEvery = Math.max(1, data.meterEvery | 0);
        }
    }

    applySettings() { /* subclass */ }

    scratchBufs(n) {
        if (this.scratch.l.length < n) {
            this.scratch.l = new Float32Array(n);
            this.scratch.r = new Float32Array(n);
        }
        return this.scratch;
    }

    maybePostMeter() {
        if (++this.meterCounter >= this.meterEvery) {
            this.meterCounter = 0;
            this.port.postMessage({
                type: 'meter',
                nodeId: this.nodeId,
                rmsL: this.meter.rmsL,
                rmsR: this.meter.rmsR
            });
        }
    }

    // Stereo view of an input with mono→stereo upmix semantics.
    static stereo(input) {
        const ch0 = input && input[0] ? input[0] : null;
        const ch1 = input && input[1] ? input[1] : ch0;
        return [ch0, ch1];
    }

    copyInput(inL, inR, outL, outR) {
        const n = outL.length;
        if (inL === inR || !inR) {
            for (let i = 0; i < n; i++) {
                const v = inL ? inL[i] : 0;
                outL[i] = v;
                outR[i] = v;
            }
        } else {
            for (let i = 0; i < n; i++) {
                outL[i] = inL ? inL[i] : 0;
                outR[i] = inR ? inR[i] : 0;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Front stages
// ---------------------------------------------------------------------------

// pon-voice-front: EQ3 → Compressor → Distortion
class VoiceFrontProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
        this.eq = new Eq3(sampleRate);
        this.comp = new DynamicsProcessor(sampleRate, 0, 1, 30, 0.003, 0.12, true);
        this.dist = new Waveshaper();
        this.eqEnabled = false;
        this.applySettings(this.initSettings);
    }

    applySettings(s) {
        const master = s.enabled === true;
        const eqOn = master && s.eq && s.eq.enabled === true;
        this.eqEnabled = eqOn;
        this.eq.set(
            eqOn ? clampNum(s.eq.low, -12, 12, 0) : 0,
            eqOn ? clampNum(s.eq.mid, -12, 12, 0) : 0,
            eqOn ? clampNum(s.eq.high, -12, 12, 0) : 0,
            s.eq ? s.eq.lowFrequency : 400,
            s.eq ? s.eq.highFrequency : 2500
        );
        const compOn = master && s.compressor && s.compressor.enabled === true;
        this.comp.set(
            compOn ? clampNum(s.compressor.threshold, -60, 0, 0) : 0,
            compOn ? clampNum(s.compressor.ratio, 1, 20, 1) : 1,
            30,          // Tone.Compressor default knee
            0.003, 0.12, // rack compressor attack/release
            !compOn
        );
        const distOn = master && s.distortion && s.distortion.enabled === true;
        this.dist.setAmount(distOn ? clampNum(s.distortion.amount, 0, 1, 0.4) : 0);
        this.dist.setWet(distOn ? 1 : 0);
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [inL, inR] = PonBaseProcessor.stereo(inputs[0]);

        if (!this.eqEnabled && this.comp.bypassed && this.dist.targetWet <= 0.00001 && this.dist.wet <= 0.00001) {
            this.copyInput(inL, inR, outL, outR);
            return true;
        }

        this.eq.smooth(this.blockStep);
        this.dist.smooth(this.blockStep);
        const s = this.scratchBufs(n);

        if (this.eqEnabled) {
            this.eq.run(inL, inR, outL, outR, 0, n, 0, 0);
        } else {
            this.copyInput(inL, inR, outL, outR);
        }
        this.comp.run(outL, outR, s.l, s.r, 0, n, 0, 0);
        this.dist.run(s.l, s.r, outL, outR, 0, n, 0, 0);
        return true;
    }
}

// pon-master-front: Distortion → EQ3 → Compressor (distortion first, per master chain)
class MasterFrontProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
        this.eq = new Eq3(sampleRate);
        this.comp = new DynamicsProcessor(sampleRate, 0, 1, 30, 0.003, 0.12, true);
        this.dist = new Waveshaper();
        this.eqEnabled = true;
        this.settings = {
            eq: { enabled: true, low: 0, mid: 0, high: 0, lowFrequency: 400, highFrequency: 2500 },
            compressor: { enabled: true, threshold: 0, ratio: 1 },
            distortionAmount: 0
        };
        this.applySettings(this.initSettings);
    }

    applySettings(s = {}) {
        // Master updates arrive as partial messages. Merge them so changing
        // one knob cannot reset unrelated saved EQ/comp/distortion values.
        const previous = this.settings;
        const next = {
            ...previous,
            ...s,
            eq: { ...previous.eq, ...(s.eq || {}) },
            compressor: { ...previous.compressor, ...(s.compressor || {}) }
        };
        this.settings = next;

        const eqOn = next.eq.enabled !== false;
        this.eqEnabled = eqOn;
        this.eq.set(
            eqOn ? clampNum(next.eq.low, -12, 12, 0) : 0,
            eqOn ? clampNum(next.eq.mid, -12, 12, 0) : 0,
            eqOn ? clampNum(next.eq.high, -12, 12, 0) : 0,
            next.eq.lowFrequency,
            next.eq.highFrequency
        );
        const compOn = next.compressor.enabled !== false;
        this.comp.set(
            compOn ? clampNum(next.compressor.threshold, -60, 0, 0) : 0,
            compOn ? clampNum(next.compressor.ratio, 1, 20, 1) : 1,
            30,
            0.003, 0.12,
            !compOn
        );
        const distAmount = clampNum(next.distortionAmount, 0, 1, 0);
        this.dist.setAmount(distAmount);
        this.dist.setWet(distAmount > 0 ? 1 : 0);
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [inL, inR] = PonBaseProcessor.stereo(inputs[0]);
        const s = this.scratchBufs(n);

        this.dist.smooth(this.blockStep);
        this.eq.smooth(this.blockStep);
        this.dist.run(inL, inR, outL, outR, 0, n, 0, 0);
        if (this.eqEnabled) {
            this.eq.run(outL, outR, s.l, s.r, 0, n, 0, 0);
        } else {
            this.copyInput(outL, outR, s.l, s.r);
        }
        this.comp.run(s.l, s.r, outL, outR, 0, n, 0, 0);
        return true;
    }
}

// ---------------------------------------------------------------------------
// Shared reverb-sum + delay helper math
// ---------------------------------------------------------------------------

// Equal-power (constant-power) dry/wet mix — the industry-standard insert mix.
// Dry and the reverb return are decorrelated, so dry·cos(rw·π/2) + wet·sin(rw·π/2)
// holds perceived loudness roughly constant across the mix range. The previous
// Tone.Reverb linear crossfade attenuated the dry by (1-rw) and dipped -3dB at center.
function reverbSum(dryL, dryR, wetL, wetR, rw, outL, outR, n) {
    if (rw <= 0.00001) {
        for (let i = 0; i < n; i++) {
            outL[i] = dryL ? dryL[i] : 0;
            outR[i] = dryR ? dryR[i] : 0;
        }
    } else {
        const dryGain = Math.cos(rw * Math.PI / 2);
        const wetGain = Math.sin(rw * Math.PI / 2);
        for (let i = 0; i < n; i++) {
            const l = dryL ? dryL[i] : 0;
            const r = dryR ? dryR[i] : 0;
            outL[i] = dryGain * l + wetGain * (wetL ? wetL[i] : 0);
            outR[i] = dryGain * r + wetGain * (wetR ? wetR[i] : 0);
        }
    }
}

// ---------------------------------------------------------------------------
// pon-voice-back: reverb sum → rack dry/wet → delay send → limiter×2 → out
// ---------------------------------------------------------------------------

class VoiceBackProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
        this.limiter = new DynamicsProcessor(sampleRate, -1, 20, 0, 0.001, 0.08, true);
        this.limiterSafety = new DynamicsProcessor(sampleRate, -1, 20, 0, 0, 0.03, true);
        this.delay = new FeedbackDelayLine(sampleRate, 2);
        this.delay.set(0.18, 0, 0);
        this.reverbWet = 0;
        this.dryGain = 1;
        this.wetGain = 0;
        this.targetReverbWet = 0;
        this.targetDryGain = 1;
        this.targetWetGain = 0;
        this.gainStep = blockStep(PARAM_RAMP_SECONDS, sampleRate); // per-block step
        this.applySettings(this.initSettings);
    }

    applySettings(s) {
        const master = s.enabled === true;
        const rw = clampNum(s.reverbWet, 0, 1, 0);
        this.targetReverbWet = master ? rw : 0;
        const wet = clampNum(s.wet, 0, 1, 0.35);
        const delayActive = master && s.delay && s.delay.enabled === true;
        // rack dry/wet mix — ported verbatim from applyEffectSettings
        if (s.hasAnyEffect) {
            this.targetDryGain = 1 - Math.min(wet, 0.95);
            this.targetWetGain = s.hasSerialEffect ? wet : 0;
        } else {
            this.targetDryGain = 1;
            this.targetWetGain = 0;
        }
        this.delay.set(
            s.delay ? s.delay.time : 0.18,
            delayActive ? clampNum(s.delay.feedback, 0, 0.85, 0) : 0,
            delayActive ? clampNum(s.delay.level, 0, 1, 0) * wet : 0
        );
        const limiterActive = master && s.limiter && s.limiter.enabled === true;
        const lt = clampNum(s.limiter ? s.limiter.threshold : -1, -12, 0, -1);
        this.limiter.set(lt, 20, 0, 0.001, 0.08, !limiterActive);
        this.limiterSafety.set(lt, 20, 0, 0, 0.03, !limiterActive);
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [dryL, dryR] = PonBaseProcessor.stereo(inputs[0]);  // from front worklet
        const [wetL, wetR] = PonBaseProcessor.stereo(inputs[1]);  // from external Convolver
        const epsilon = 0.00001;
        const bypassReverb = this.reverbWet <= epsilon && this.targetReverbWet <= epsilon;
        const bypassDelay = this.delay.level <= epsilon
            && this.delay.targetLevel <= epsilon
            && this.delay.feedback <= epsilon
            && this.delay.targetFeedback <= epsilon;
        const bypassRackMix = this.dryGain >= 1 - epsilon
            && this.targetDryGain >= 1 - epsilon
            && this.wetGain <= epsilon
            && this.targetWetGain <= epsilon;
        const bypassLimiters = this.limiter.bypassed && this.limiterSafety.bypassed;
        if (bypassReverb && bypassDelay && bypassRackMix && bypassLimiters) {
            this.copyInput(dryL, dryR, outL, outR);
            this.meter.push(outL, outR, 0, n, 0, 0);
            this.maybePostMeter();
            return true;
        }
        const s = this.scratchBufs(n);

        // Per-block smoothing toward targets (mirrors setTargetAtTime ramps)
        this.reverbWet += (this.targetReverbWet - this.reverbWet) * this.gainStep;
        this.dryGain += (this.targetDryGain - this.dryGain) * this.gainStep;
        this.wetGain += (this.targetWetGain - this.wetGain) * this.gainStep;

        // Reverb internal mix
        reverbSum(dryL, dryR, wetL, wetR, this.reverbWet, s.l, s.r, n);

        // Rack dry/wet sum + delay send (delay taps from reverb output)
        const sumL = this._sumL && this._sumL.length >= n ? this._sumL : (this._sumL = new Float32Array(n));
        const sumR = this._sumR && this._sumR.length >= n ? this._sumR : (this._sumR = new Float32Array(n));
        this.delay.run(s.l, s.r, sumL, sumR, 0, n, 0, 0);
        const dryG = this.dryGain, wetG = this.wetGain;
        if (dryG === 1 && wetG === 0) {
            for (let i = 0; i < n; i++) {
                sumL[i] += s.l[i];
                sumR[i] += s.r[i];
            }
        } else {
            for (let i = 0; i < n; i++) {
                sumL[i] += s.l[i] * (dryG + wetG);
                sumR[i] += s.r[i] * (dryG + wetG);
            }
        }

        // Limiter section
        const limL = this._limL && this._limL.length >= n ? this._limL : (this._limL = new Float32Array(n));
        const limR = this._limR && this._limR.length >= n ? this._limR : (this._limR = new Float32Array(n));
        this.limiter.run(sumL, sumR, limL, limR, 0, n, 0, 0);
        this.limiterSafety.run(limL, limR, outL, outR, 0, n, 0, 0);

        this.meter.push(outL, outR, 0, n, 0, 0);
        this.maybePostMeter();
        return true;
    }
}

// ---------------------------------------------------------------------------
// pon-master-back: reverb sum → dry + delay send → out
// ---------------------------------------------------------------------------

class MasterBackProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
        this.delay = new FeedbackDelayLine(sampleRate, 2);
        this.reverbWet = 0;
        this.targetReverbWet = 0;
        this.delayReturn = 0;
        this.targetDelayReturn = 0;
        this.applySettings(this.initSettings);
    }

    applySettings(s = {}) {
        // Messages are partial: preserve every field not present in this update.
        if (Object.prototype.hasOwnProperty.call(s, 'reverbWet')) {
            this.targetReverbWet = clampNum(s.reverbWet, 0, 1, 0);
        }
        if (Object.prototype.hasOwnProperty.call(s, 'delayLevel')) {
            this.targetDelayReturn = clampNum(s.delayLevel, 0, 1, 0);
        }
        const time = Object.prototype.hasOwnProperty.call(s, 'delayTime')
            ? s.delayTime : this.delay.delayTimeSeconds;
        const feedback = Object.prototype.hasOwnProperty.call(s, 'delayFeedback')
            ? s.delayFeedback : this.delay.targetFeedback;
        this.delay.set(time, feedback, 1); // return level applied below
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [dryL, dryR] = PonBaseProcessor.stereo(inputs[0]);
        const [wetL, wetR] = PonBaseProcessor.stereo(inputs[1]);
        const epsilon = 0.00001;
        const bypassReverb = this.reverbWet <= epsilon && this.targetReverbWet <= epsilon;
        const bypassDelay = this.delayReturn <= epsilon
            && this.targetDelayReturn <= epsilon
            && this.delay.targetFeedback <= epsilon;
        if (bypassReverb && bypassDelay) {
            this.copyInput(dryL, dryR, outL, outR);
            return true;
        }
        const s = this.scratchBufs(n);

        this.reverbWet += (this.targetReverbWet - this.reverbWet) * this.blockStep;
        this.delayReturn += (this.targetDelayReturn - this.delayReturn) * this.blockStep;
        reverbSum(dryL, dryR, wetL, wetR, this.reverbWet, s.l, s.r, n);

        const dL = this._dL && this._dL.length >= n ? this._dL : (this._dL = new Float32Array(n));
        const dR = this._dR && this._dR.length >= n ? this._dR : (this._dR = new Float32Array(n));
        this.delay.run(s.l, s.r, dL, dR, 0, n, 0, 0);
        const retG = this.delayReturn;
        for (let i = 0; i < n; i++) {
            outL[i] = s.l[i] + dL[i] * retG;
            outR[i] = s.r[i] + dR[i] * retG;
        }
        return true;
    }
}

// pon-master-meter: transparent tap after masterGain and before masterPan.
class MasterMeterProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [inL, inR] = PonBaseProcessor.stereo(inputs[0]);
        this.copyInput(inL, inR, outL, outR);
        this.meter.push(inL, inR, 0, n, 0, 0);
        this.maybePostMeter();
        return true;
    }
}

// ---------------------------------------------------------------------------
// pon-master-limit: Limiter → LimiterSafety (no meter tap here)
// ---------------------------------------------------------------------------

class MasterLimitProcessor extends PonBaseProcessor {
    constructor(options) {
        super(options);
        this.limiter = new DynamicsProcessor(sampleRate, -1, 20, 0, 0.001, 0.08, false);
        this.limiterSafety = new DynamicsProcessor(sampleRate, -1, 20, 0, 0, 0.03, false);
        this.applySettings(this.initSettings);
    }

    applySettings(s = {}) {
        const lt = clampNum(s.threshold, -12, 0, -1);
        this.limiter.set(lt, 20, 0, 0.001, 0.08, false);
        this.limiterSafety.set(lt, 20, 0, 0, 0.03, false);
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1] || outputs[0][0];
        const n = outL.length;
        const [inL, inR] = PonBaseProcessor.stereo(inputs[0]);
        const s = this.scratchBufs(n);
        this.limiter.run(inL, inR, s.l, s.r, 0, n, 0, 0);
        this.limiterSafety.run(s.l, s.r, outL, outR, 0, n, 0, 0);
        return true;
    }
}

registerProcessor('pon-voice-front', VoiceFrontProcessor);
registerProcessor('pon-voice-back', VoiceBackProcessor);
registerProcessor('pon-master-front', MasterFrontProcessor);
registerProcessor('pon-master-back', MasterBackProcessor);
registerProcessor('pon-master-meter', MasterMeterProcessor);
registerProcessor('pon-master-limit', MasterLimitProcessor);

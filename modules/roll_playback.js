import { ROLL_CROSSFADE_SECONDS } from './01_config.js';

const SILENCE = 0.0001;
const crossfade = (a, b) => Math.min(ROLL_CROSSFADE_SECONDS, a.duration / 2, b.duration / 2);

// 各パートの開始位置を残し、周回境界も含めてクロスフェードを焼き込む。
export function createRollLoop(context, buffers) {
    const sampleRate = buffers[0].sampleRate;
    const parts = [];
    let length = 0;
    for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        const next = buffers[(i + 1) % buffers.length];
        const overlap = Math.min(Math.round(ROLL_CROSSFADE_SECONDS * sampleRate), Math.floor(buffer.length / 2), Math.floor(next.length / 2));
        parts.push({ buffer, start: length, overlap });
        length += buffer.length - overlap;
    }
    const buffer = context.createBuffer(Math.max(...buffers.map(b => b.numberOfChannels)), length, sampleRate);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const incoming = parts[(i + parts.length - 1) % parts.length].overlap;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const input = part.buffer.getChannelData(Math.min(ch, part.buffer.numberOfChannels - 1));
            const output = buffer.getChannelData(ch);
            for (let frame = 0; frame < input.length; frame++) {
                const fadeIn = incoming && frame < incoming ? SILENCE + (1 - SILENCE) * frame / incoming : 1;
                const remaining = input.length - frame;
                const fadeOut = part.overlap && remaining < part.overlap ? SILENCE + (1 - SILENCE) * remaining / part.overlap : 1;
                output[(part.start + frame) % length] += input[frame] * fadeIn * fadeOut;
            }
        }
    }
    return { buffer, parts };
}

function addSource(context, info, buffer, start, offset = 0, loop = false) {
    const source = context.createBufferSource();
    const gain = context.createGain();
    const item = { source, gain, buffer, sourceStart: start, endTime: loop ? Infinity : start + buffer.duration - offset };
    info.scheduled.push(item);
    source.buffer = buffer;
    source.loop = loop;
    source.loopEnd = buffer.duration;
    source.connect(gain);
    gain.connect(info.pannerNode);
    source.start(start, offset);
    return item;
}

function fadeBetween(previous, next) {
    previous.gain.gain.setValueAtTime(1, next.sourceStart);
    previous.gain.gain.linearRampToValueAtTime(SILENCE, previous.endTime);
    next.gain.gain.value = SILENCE;
    next.gain.gain.setValueAtTime(SILENCE, next.sourceStart);
    next.gain.gain.linearRampToValueAtTime(1, previous.endTime);
}

function scheduleTail(context, info, previous, start, onEnd) {
    for (const buffer of [info.endBuffer, info.finishBuffer].filter(Boolean)) {
        const when = previous ? Math.max(start, previous.endTime - crossfade(previous.buffer, buffer)) : start;
        const next = addSource(context, info, buffer, when);
        if (previous) fadeBetween(previous, next);
        previous = next;
    }
    if (!previous) {
        onEnd();
        return;
    }
    const fadeStart = Math.max(start, previous.endTime - Math.min(ROLL_CROSSFADE_SECONDS, previous.buffer.duration / 2));
    previous.gain.gain.setValueAtTime(1, fadeStart);
    previous.gain.gain.linearRampToValueAtTime(SILENCE, previous.endTime);
    previous.source.onended = onEnd;
}

export function startRollSources(context, info, onEnd) {
    // ノード生成中に開始時刻を過ぎないよう、2 render quantum 先から始める。
    const start = context.currentTime + 256 / context.sampleRate;
    if (info.rollReleased) {
        const intro = info.introBuffer ? addSource(context, info, info.introBuffer, start) : null;
        scheduleTail(context, info, intro, start, onEnd);
        return;
    }
    info.rollLoop = createRollLoop(context, info.loopBuffers);
    // 結合処理の所要時間を開始時刻に持ち込まない。
    const now = context.currentTime + 256 / context.sampleRate;
    const intro = info.introBuffer ? addSource(context, info, info.introBuffer, now) : null;
    const first = info.loopBuffers[0];
    info.rollLoopStart = intro ? intro.endTime - crossfade(intro.buffer, first) : now;
    const initial = addSource(context, info, first, info.rollLoopStart);
    if (intro) fadeBetween(intro, initial);

    // 最初だけ周回前の末尾を混ぜずに再生し、次の継ぎ目から結合バッファへ引き継ぐ。
    const { buffer, parts } = info.rollLoop;
    const offset = (first.length - parts[0].overlap) / buffer.sampleRate;
    const handoff = info.rollLoopStart + offset;
    initial.stopTime = handoff;
    initial.source.stop(handoff);
    addSource(context, info, buffer, handoff, offset % buffer.duration, true);
}

export function releaseRollSources(context, info, onEnd) {
    const safeTime = context.currentTime + 256 / context.sampleRate;
    let current;
    if (info.introBuffer && safeTime < info.rollLoopStart) {
        const intro = info.scheduled[0];
        current = { buffer: intro.buffer, start: intro.sourceStart, end: intro.endTime, nextStart: info.rollLoopStart };
    } else {
        const { buffer, parts } = info.rollLoop;
        const elapsed = Math.max(0, safeTime - info.rollLoopStart);
        const cycle = Math.floor(elapsed / buffer.duration);
        const position = Math.max(0, (elapsed - cycle * buffer.duration) * buffer.sampleRate);
        const part = parts.findLast(p => p.start <= position);
        const start = info.rollLoopStart + cycle * buffer.duration + part.start / buffer.sampleRate;
        current = {
            buffer: part.buffer,
            start,
            end: start + part.buffer.duration,
            nextStart: start + (part.buffer.length - part.overlap) / buffer.sampleRate
        };
    }

    const tail = info.endBuffer || info.finishBuffer;
    const fade = tail ? crossfade(current.buffer, tail) : Math.min(ROLL_CROSSFADE_SECONDS, current.buffer.duration / 2);
    const tailStart = Math.max(safeTime, current.end - fade);
    // 焼き込まれた次パートが入る前に、現在パートの元音声へ差し替える。
    const splice = Math.max(safeTime, Math.min(current.nextStart, tailStart));
    const originals = [...info.scheduled];
    const bridge = addSource(context, info, current.buffer, splice, Math.max(0, splice - current.start));
    scheduleTail(context, info, bridge, tailStart, onEnd);
    for (const item of originals) {
        item.source.onended = null;
        try { item.source.stop(Math.min(splice, item.stopTime ?? item.endTime)); } catch { /* 終了済み */ }
    }
}

export function stopRollSources(info) {
    for (const item of info.scheduled || []) {
        item.source.onended = null;
        try { item.source.stop(0); } catch { /* 終了済み */ }
        try { item.source.disconnect(); } catch { /* ignore */ }
        try { item.gain.disconnect(); } catch { /* ignore */ }
    }
    info.scheduled = [];
    info.rollLoop = null;
}

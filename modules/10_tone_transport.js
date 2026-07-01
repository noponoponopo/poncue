// modules/10_tone_transport.js

import * as Tone from 'tone';

let attachedAudioContext = null;
let scheduledCueIds = new Map();

export function attachToneContext(audioContext) {
    if (!audioContext || attachedAudioContext === audioContext) return;
    Tone.setContext(audioContext, false);
    attachedAudioContext = audioContext;

    const transport = Tone.getTransport();
    transport.bpm.value = 120;
    transport.swing = 0;
}

export async function resumeToneAudio() {
    if (!attachedAudioContext) return;
    await Tone.start();
}

export function getToneClockSnapshot() {
    if (!attachedAudioContext) {
        return {
            ready: false,
            now: null,
            immediate: null,
            transportSeconds: null,
            state: 'unavailable',
            bpm: null
        };
    }

    const transport = Tone.getTransport();
    return {
        ready: true,
        now: Tone.now(),
        immediate: Tone.immediate(),
        transportSeconds: transport.seconds,
        state: transport.state,
        bpm: transport.bpm.value
    };
}

export function setTransportBpm(bpm) {
    const transport = Tone.getTransport();
    const nextBpm = Math.min(300, Math.max(20, Number(bpm) || 120));
    transport.bpm.rampTo(nextBpm, 0.02);
}

export function startTransport(time = '+0') {
    Tone.getTransport().start(time);
}

export function stopTransport(time = '+0') {
    Tone.getTransport().stop(time);
}

export function clearTransportCues() {
    const transport = Tone.getTransport();
    for (const cueId of scheduledCueIds.values()) {
        transport.clear(cueId);
    }
    scheduledCueIds.clear();
}

export function scheduleTransportCue(key, transportTime, callback) {
    if (!key || typeof callback !== 'function') return null;
    const transport = Tone.getTransport();
    if (scheduledCueIds.has(key)) {
        transport.clear(scheduledCueIds.get(key));
    }
    const cueId = transport.scheduleOnce(time => callback(time), transportTime);
    scheduledCueIds.set(key, cueId);
    return cueId;
}

export function cancelTransportCue(key) {
    if (!scheduledCueIds.has(key)) return;
    Tone.getTransport().clear(scheduledCueIds.get(key));
    scheduledCueIds.delete(key);
}

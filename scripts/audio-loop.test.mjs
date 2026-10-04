import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { state } from '../modules/03_state.js';
import { updateActiveSoundLoop } from '../modules/06_audio.js';
import * as Tone from 'tone';

function createSource() {
    return {
        loop: false,
        playbackRate: { value: 1 },
        onended: () => {},
        stopTimes: [],
        start(...args) { this.startArgs = args; },
        stop(time = 0) { this.stopTimes.push(time); },
        connect(node) { this.output = node; },
        disconnect() { this.disconnected = true; }
    };
}

let sound, voice, context, gain;
beforeEach(() => {
    sound = { id: 'sound', loop: false, volume: 0.6, fadeOutDuration: 0 };
    gain = {
        value: sound.volume,
        cancelledTimes: [],
        setValueAtTime(value) { this.value = value; },
        cancelScheduledValues(time) { this.cancelledTimes.push(time); },
        setTargetAtTime(...args) { this.targetArgs = args; }
    };
    context = { currentTime: 1, createBufferSource: createSource };
    voice = {
        soundId: sound.id,
        sourceNode: createSource(),
        audioBuffer: { duration: 8 },
        pannerNode: {},
        individualGain: { gain },
        trimStart: 2,
        trimEnd: 6,
        playbackPosition: 2,
        playbackPositionContextTime: 0,
        playbackRate: 1,
        stopAfterLoop: false,
        loopStopTime: null,
        naturalFadeStartTime: null
    };
    state.audioContext = context;
    state.currentSceneId = 'scene';
    state.scenes = { scene: { sounds: [sound] } };
    state.activeAudios = { [sound.id]: voice };
});

afterEach(() => clearTimeout(voice.trimBoundaryTimeoutId));

function toggle(loop) {
    sound.loop = loop;
    updateActiveSoundLoop(sound.id, loop);
}

test('first loop enable replaces the native source with a scheduled end stop', () => {
    voice.playbackRate = 2;
    const oldSource = voice.sourceNode;
    oldSource.stop(2); // Non-looping playback schedules a stop at the trim end.
    toggle(true);

    const source = voice.sourceNode;
    assert.notEqual(source, oldSource);
    assert.equal(oldSource.onended, null);
    assert.equal(oldSource.disconnected, true);
    assert.deepEqual(oldSource.stopTimes, [2, 0]);
    assert.deepEqual(source.stopTimes, []);
    assert.deepEqual(source.startArgs, [0, 4]);
    assert.equal(source.buffer, voice.audioBuffer);
    assert.equal(source.output, voice.pannerNode);
    assert.equal(source.playbackRate.value, 2);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 2);
    assert.equal(source.loopEnd, 6);
});

test('loop disable after several cycles stops at the end of the current cycle', () => {
    sound.loop = voice.sourceNode.loop = true;
    context.currentTime = 10.5;
    toggle(false);

    assert.equal(voice.playbackPosition, 4.5);
    assert.equal(voice.playbackPositionContextTime, 10.5);
    assert.equal(voice.loopStopTime, 12);
    assert.deepEqual(voice.sourceNode.stopTimes, [12]);
    assert.equal(voice.sourceNode.loop, false);
});

function createGrainPlayer() {
    return Object.setPrototypeOf({
        ...createSource(),
        loop: true,
        loopStart: 0,
        loopEnd: 0,
        restart(...args) { this.restartArgs = args; },
        dispose() { this.wasDisposed = true; }
    }, Tone.GrainPlayer.prototype);
}

for (const { duration, rate } of [
    { duration: 0.5, rate: 1.5 },
    { duration: 0.1, rate: 4 },
    { duration: 4, rate: 0.5 }
]) {
    test(`pitch-preserving loop disable keeps the current cycle playing (${duration}s, ${rate}x)`, () => {
        sound.loop = true;
        voice.sourceNode = createGrainPlayer();
        voice.playbackRate = rate;
        voice.trimEnd = voice.trimStart + duration;
        context.currentTime = duration * 3.25 / rate;
        const source = voice.sourceNode;
        toggle(false);

        assert.equal(voice.sourceNode, source);
        assert.equal(source.loop, true); // GrainPlayer's clock offset keeps growing across loops.
        assert.equal(voice.stopAfterLoop, true);
        assert.ok(Math.abs(voice.playbackPosition - (voice.trimStart + duration * 0.25)) < 1e-9);
        assert.ok(Math.abs(voice.loopStopTime - duration * 4 / rate) < 1e-9);
        assert.deepEqual(source.stopTimes, [voice.loopStopTime]);
        assert.equal(source.loopStart, voice.trimStart);
        assert.equal(source.loopEnd, voice.trimEnd);
    });
}

test('pitch-preserving loop off then on cancels the pending stop at the current position', () => {
    sound.loop = true;
    voice.sourceNode = createGrainPlayer();
    voice.playbackRate = 2;
    context.currentTime = 6.5;
    toggle(false);
    const source = voice.sourceNode;
    context.currentTime = 6.75;
    toggle(true);

    assert.equal(voice.sourceNode, source);
    assert.equal(source.loop, true);
    assert.deepEqual(source.restartArgs, [6.75, 3.5]);
    assert.equal(voice.stopAfterLoop, false);
    assert.equal(voice.loopStopTime, null);
});

for (const reenable of [false, true]) {
    test(`early onstop waits for the loop boundary (reenable=${reenable})`, t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        toggle(true);
        // Reuse the shared production completion callback for GrainPlayer's early onstop.
        const onstop = voice.sourceNode.onended;
        voice.sourceNode = createGrainPlayer();
        toggle(false);
        const source = voice.sourceNode;
        const stopTime = voice.loopStopTime;
        context.currentTime = stopTime - 0.05;
        onstop();

        assert.equal(state.activeAudios[sound.id], voice);
        assert.equal(source.disconnected, undefined);
        if (reenable) toggle(true);
        context.currentTime = stopTime;
        t.mock.timers.tick(100);

        if (reenable) {
            assert.equal(state.activeAudios[sound.id], voice);
            assert.equal(source.wasDisposed, undefined);
        } else {
            assert.equal(state.activeAudios[sound.id], undefined);
            assert.equal(source.disconnected, true);
            assert.equal(source.wasDisposed, true);
        }
    });
}

test('pitch-preserving loop disable fades through the current cycle end', () => {
    sound.loop = true;
    sound.fadeOutDuration = 0.5;
    voice.sourceNode = createGrainPlayer();
    voice.playbackRate = 2;
    context.currentTime = 6.5;
    gain.setValueCurveAtTime = (...args) => { gain.curveArgs = args; };
    toggle(false);

    assert.equal(voice.loopStopTime, 8);
    assert.equal(voice.naturalFadeStartTime, 7.5);
    assert.equal(gain.curveArgs[1] + gain.curveArgs[2], voice.loopStopTime);
    assert.equal(voice.sourceNode.loop, true);
});

test('loop off then on removes the pending stop without resetting playback', () => {
    sound.loop = voice.sourceNode.loop = true;
    toggle(false);
    const oldSource = voice.sourceNode;
    context.currentTime = 1.25;
    toggle(true);

    assert.notEqual(voice.sourceNode, oldSource);
    assert.deepEqual(voice.sourceNode.startArgs, [0, 3.25]);
    assert.deepEqual(voice.sourceNode.stopTimes, []);
    assert.equal(voice.stopAfterLoop, false);
    assert.equal(voice.loopStopTime, null);
});

test('loop enable cancels a future natural fade without disturbing fade-in', () => {
    voice.naturalFadeStartTime = 3;
    toggle(true);

    assert.deepEqual(gain.cancelledTimes, [3]);
    assert.equal(voice.naturalFadeStartTime, null);
    assert.equal(gain.targetArgs, undefined);
});

for (const muted of [false, true]) {
    test(`loop enable restores volume during natural fade (muted=${muted})`, () => {
        voice.naturalFadeStartTime = 0.5;
        voice.muted = muted;
        gain.value = 0.2;
        toggle(true);

        assert.deepEqual(gain.cancelledTimes, [1]);
        assert.equal(voice.naturalFadeStartTime, null);
        assert.equal(gain.targetArgs[0], muted ? 0.0001 : sound.volume);
        assert.equal(gain.targetArgs[1], context.currentTime);
        assert.ok(gain.targetArgs[2] > 0);
    });
}

test('loop enable leaves media-element looping under the trim-boundary scheduler', () => {
    voice.audioElement = { currentTime: 3, duration: 8, playbackRate: 1, loop: false };
    const source = voice.sourceNode;
    toggle(true);

    assert.equal(voice.sourceNode, source);
    assert.equal(voice.audioElement.loop, false);
    assert.ok(voice.trimBoundaryTimeoutId);
});

test('loop enable does not restart a voice already being stopped', () => {
    voice.isFadingOut = true;
    const source = voice.sourceNode;
    toggle(true);

    assert.equal(voice.sourceNode, source);
    assert.deepEqual(source.stopTimes, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { MIDI_PLAYBACK_MODE } from '../modules/01_config.js';
import { state, updateState } from '../modules/03_state.js';
import {
    disableMidiInput,
    enableMidiInput,
    parseMidiMessage
} from '../modules/11_midi.js';

function createInput(id) {
    return {
        id,
        name: id,
        state: 'connected',
        connection: 'open',
        onmidimessage: null,
        closeCalls: 0,
        close() {
            this.closeCalls += 1;
        }
    };
}

function createAccess(inputs) {
    return {
        inputs: new Map(inputs.map(input => [input.id, input])),
        onstatechange: null
    };
}

function send(input, data, timeStamp = 0) {
    input.onmidimessage({
        data: Uint8Array.from(data),
        timeStamp,
        currentTarget: input
    });
}

function setSound(mode = MIDI_PLAYBACK_MODE.TOGGLE) {
    updateState({
        scenes: {
            scene: {
                sounds: [{
                    id: 'sound-1',
                    midi: { binding: { type: 'note', channel: 0, number: 60 }, mode }
                }]
            }
        },
        currentSceneId: 'scene',
        midiHeldKeys: {},
        midiSettings: {
            ...state.midiSettings,
            deviceId: 'all',
            channel: 'all',
            fixedGridEnabled: false,
            globalMappings: {}
        }
    });
}

test.afterEach(() => {
    disableMidiInput();
    delete globalThis.navigator;
});

test('parses zero-velocity Note On as Note Off', () => {
    assert.deepEqual(parseMidiMessage(Uint8Array.of(0x92, 64, 0)), {
        type: 'noteoff', channel: 2, number: 64, velocity: 0
    });
});

test('shares a concurrent access request and attaches each input once', async () => {
    const input = createInput('main');
    const access = createAccess([input]);
    let requests = 0;
    globalThis.navigator = {
        requestMIDIAccess: async () => {
            requests += 1;
            return access;
        }
    };

    const [first, second] = await Promise.all([
        enableMidiInput(() => {}),
        enableMidiInput(() => {})
    ]);

    assert.equal(requests, 1);
    assert.equal(first, access);
    assert.equal(second, access);
    assert.equal(typeof input.onmidimessage, 'function');
});

test('cancels access that resolves after MIDI was disabled', async () => {
    const input = createInput('late');
    const access = createAccess([input]);
    let resolveAccess;
    globalThis.navigator = {
        requestMIDIAccess: () => new Promise(resolve => { resolveAccess = resolve; })
    };

    const pending = enableMidiInput(() => {});
    disableMidiInput();
    resolveAccess(access);

    await assert.rejects(pending, /cancelled/);
    assert.equal(state.midiEnabled, false);
    assert.equal(state.midiAccess, null);
    assert.equal(input.closeCalls, 1);
});

test('does not drop identical notes arriving from different inputs', async () => {
    const first = createInput('first');
    const second = createInput('second');
    globalThis.navigator = { requestMIDIAccess: async () => createAccess([first, second]) };
    setSound(MIDI_PLAYBACK_MODE.TOGGLE);
    const events = [];
    await enableMidiInput(event => events.push(event));

    send(first, [0x90, 60, 100]);
    send(second, [0x90, 60, 100]);

    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.midiEvent.inputId), ['first', 'second']);
});

test('suppresses held toggle notes but permits retrigger repeats', async () => {
    const input = createInput('main');
    globalThis.navigator = { requestMIDIAccess: async () => createAccess([input]) };
    const events = [];

    setSound(MIDI_PLAYBACK_MODE.TOGGLE);
    await enableMidiInput(event => events.push(event));
    send(input, [0x90, 60, 100]);
    send(input, [0x90, 60, 100]);
    assert.equal(events.length, 1);

    send(input, [0x80, 60, 0]);
    setSound(MIDI_PLAYBACK_MODE.RETRIGGER);
    send(input, [0x90, 60, 100]);
    send(input, [0x90, 60, 100]);
    assert.equal(events.length, 4);
});

test('tracks Note and CC presses independently', async () => {
    const input = createInput('main');
    globalThis.navigator = { requestMIDIAccess: async () => createAccess([input]) };
    setSound(MIDI_PLAYBACK_MODE.TOGGLE);
    const events = [];
    await enableMidiInput(event => events.push(event));

    send(input, [0xb0, 60, 127]);
    send(input, [0x90, 60, 100]);

    assert.equal(events.length, 1);
    assert.equal(events[0].midiEvent.type, 'noteon');
});

test('clears held notes when an input disconnects and reconnects', async () => {
    const input = createInput('main');
    const access = createAccess([input]);
    globalThis.navigator = { requestMIDIAccess: async () => access };
    setSound(MIDI_PLAYBACK_MODE.TOGGLE);
    const events = [];
    await enableMidiInput(event => events.push(event));

    send(input, [0x90, 60, 100]);
    input.state = 'disconnected';
    access.onstatechange({ currentTarget: access });
    input.state = 'connected';
    access.onstatechange({ currentTarget: access });
    send(input, [0x90, 60, 100]);

    assert.equal(events.length, 2);
});

test('ignores high-rate realtime messages without dispatching', async () => {
    const input = createInput('main');
    globalThis.navigator = { requestMIDIAccess: async () => createAccess([input]) };
    setSound();
    let dispatches = 0;
    await enableMidiInput(() => { dispatches += 1; });

    for (let i = 0; i < 1000; i += 1) {
        send(input, [i % 2 ? 0xf8 : 0xfe]);
    }

    assert.equal(dispatches, 0);
    assert.deepEqual(state.midiHeldKeys, {});
});

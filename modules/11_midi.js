// modules/11_midi.js

import { DEFAULT_MIDI_SETTINGS, MIDI_GLOBAL_ACTIONS, MIDI_PLAYBACK_MODE } from './01_config.js';
import { dom } from './02_dom.js';
import { state, updateState } from './03_state.js';

let controlEventHandler = null;
let midiAccessRequest = null;
let connectionGeneration = 0;
let connectedInputIds = new Set();

export function isMidiSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

export function normalizeMidiSettings(settings = {}) {
    return {
        ...structuredClone(DEFAULT_MIDI_SETTINGS),
        ...settings,
        globalMappings: {
            ...structuredClone(DEFAULT_MIDI_SETTINGS).globalMappings,
            ...(settings.globalMappings ?? {})
        }
    };
}

export async function enableMidiInput(onControlEvent) {
    controlEventHandler = onControlEvent;

    if (!isMidiSupported()) {
        updateState({ midiStatus: 'unsupported', midiEnabled: false });
        updateMidiButtonState('unsupported');
        throw new Error('Web MIDI API is not supported in this browser.');
    }

    if (state.midiAccess && state.midiEnabled) {
        refreshMidiInputs();
        return state.midiAccess;
    }

    if (midiAccessRequest) return midiAccessRequest;

    const generation = ++connectionGeneration;
    updateState({ midiStatus: 'connecting' });
    updateMidiButtonState('connecting');

    const request = navigator.requestMIDIAccess({ sysex: false }).then(midiAccess => {
        if (generation !== connectionGeneration) {
            closeMidiAccess(midiAccess);
            throw new Error('MIDI connection was cancelled.');
        }

        updateState({
            midiAccess,
            midiEnabled: true,
            midiSettings: normalizeMidiSettings({ ...state.midiSettings, enabled: true })
        });
        midiAccess.onstatechange = handleMidiStateChange;
        refreshMidiInputs();
        return midiAccess;
    }).catch(err => {
        if (generation === connectionGeneration) {
            updateState({ midiStatus: 'error', midiEnabled: false });
            updateMidiButtonState('error');
        }
        throw err;
    }).finally(() => {
        if (midiAccessRequest === request) midiAccessRequest = null;
    });

    midiAccessRequest = request;
    return request;
}

export function disableMidiInput() {
    connectionGeneration += 1;
    midiAccessRequest = null;
    cancelMidiLearn();
    const access = state.midiAccess;
    if (access) closeMidiAccess(access);
    updateState({
        midiAccess: null,
        midiEnabled: false,
        midiHeldKeys: {},
        midiStatus: 'idle',
        midiSettings: normalizeMidiSettings({ ...state.midiSettings, enabled: false })
    });
    connectedInputIds = new Set();
    updateMidiButtonState('idle');
}

export function beginMidiLearn(target) {
    cancelMidiLearn();

    if (!state.midiEnabled || !state.midiAccess) {
        return Promise.reject(new Error('MIDI入力が有効化されていません。先にヘッダーのMIDIボタンを押してください。'));
    }

    return new Promise(resolve => {
        updateState({ midiLearnTarget: { target, resolve } });
        updateMidiButtonState('learning');
    });
}

export function cancelMidiLearn() {
    if (state.midiLearnTarget?.resolve) {
        state.midiLearnTarget.resolve(null);
    }
    updateState({ midiLearnTarget: null });
    if (state.midiEnabled) updateMidiButtonState(getConnectedInputCount() > 0 ? 'connected' : 'waiting');
}

export function getMidiInputOptions() {
    if (!state.midiAccess) return [];
    return Array.from(state.midiAccess.inputs.values()).map(input => ({
        id: input.id,
        name: input.name || '名称不明のMIDI入力',
        manufacturer: input.manufacturer || '',
        state: input.state,
        connection: input.connection
    }));
}

export function updateMidiButtonState(status = state.midiStatus) {
    if (!dom.midiEnableBtn) return;

    const inputCount = getConnectedInputCount();
    let nextStatus = status;
    if (nextStatus === 'connected' && inputCount === 0) nextStatus = 'waiting';
    if (state.midiLearnTarget) nextStatus = 'learning';
    updateState({ midiStatus: nextStatus });

    dom.midiEnableBtn.classList.remove(
        'midi-status-idle',
        'midi-status-connecting',
        'midi-status-connected',
        'midi-status-waiting',
        'midi-status-learning',
        'midi-status-error',
        'midi-status-unsupported'
    );
    dom.midiEnableBtn.classList.add(`midi-status-${nextStatus}`);

    const label = dom.midiEnableBtn.querySelector('span');
    if (label) {
        if (nextStatus === 'connecting') label.textContent = '接続中';
        else if (nextStatus === 'learning') label.textContent = '学習中';
        else label.textContent = 'MIDI';
    }

    dom.midiEnableBtn.disabled = nextStatus === 'connecting' || nextStatus === 'unsupported';
    dom.midiEnableBtn.title = getMidiButtonTitle(nextStatus, inputCount);
}

export function parseMidiMessage(data) {
    if (!data || data.length === 0) return null;

    const statusByte = data[0];
    const command = statusByte & 0xf0;
    const channel = statusByte & 0x0f;

    if (statusByte === 0xf0) return { type: 'sysex', data: Array.from(data) };
    if (statusByte === 0xf1 && data.length >= 2) return { type: 'mtcQuarterFrame', value: data[1] };
    if (statusByte === 0xf2 && data.length >= 3) return { type: 'songPosition', value: data[1] | (data[2] << 7) };
    if (statusByte === 0xf8) return { type: 'clock' };
    if (statusByte === 0xfa) return { type: 'transport', command: 'start' };
    if (statusByte === 0xfb) return { type: 'transport', command: 'continue' };
    if (statusByte === 0xfc) return { type: 'transport', command: 'stop' };
    if (statusByte === 0xfe) return { type: 'activeSensing' };

    if (data.length < 2) return null;

    if (command === 0x80 && data.length >= 3) {
        return { type: 'noteoff', channel, number: data[1], velocity: data[2] };
    }
    if (command === 0x90 && data.length >= 3) {
        return data[2] > 0
            ? { type: 'noteon', channel, number: data[1], velocity: data[2] }
            : { type: 'noteoff', channel, number: data[1], velocity: 0 };
    }
    if (command === 0xa0 && data.length >= 3) {
        return { type: 'polyAftertouch', channel, number: data[1], value: data[2] };
    }
    if (command === 0xb0 && data.length >= 3) {
        return { type: 'cc', channel, number: data[1], value: data[2] };
    }
    if (command === 0xc0) {
        return { type: 'program', channel, number: data[1] };
    }
    if (command === 0xd0) {
        return { type: 'channelPressure', channel, value: data[1] };
    }
    if (command === 0xe0 && data.length >= 3) {
        return { type: 'pitchbend', channel, value: data[1] | (data[2] << 7) };
    }

    return null;
}

export function getMidiEventPhase(midiEvent) {
    if (midiEvent.type === 'noteoff') return 'release';
    if (midiEvent.type === 'cc') return midiEvent.value > 0 ? 'press' : 'release';
    if (midiEvent.type === 'activeSensing' || midiEvent.type === 'clock') return 'ignore';
    if (midiEvent.type === 'mtcQuarterFrame' || midiEvent.type === 'songPosition' || midiEvent.type === 'pitchbend' || midiEvent.type === 'channelPressure' || midiEvent.type === 'polyAftertouch') return 'change';
    return 'press';
}

export function createBindingFromMidiEvent(midiEvent) {
    if (!midiEvent) return null;
    if (midiEvent.type === 'noteon' || midiEvent.type === 'noteoff') {
        return { type: 'note', channel: midiEvent.channel, number: midiEvent.number };
    }
    if (midiEvent.type === 'cc') {
        return { type: 'cc', channel: midiEvent.channel, number: midiEvent.number };
    }
    if (midiEvent.type === 'program') {
        return { type: 'program', channel: midiEvent.channel, number: midiEvent.number };
    }
    if (midiEvent.type === 'pitchbend') {
        return { type: 'pitchbend', channel: midiEvent.channel };
    }
    if (midiEvent.type === 'transport') {
        return { type: 'transport', command: midiEvent.command };
    }
    return null;
}

export function formatMidiBinding(binding) {
    if (!binding) return '未割り当て';
    if (binding.type === 'transport') return `Transport ${binding.command}`;
    const channel = typeof binding.channel === 'number' ? `ch${binding.channel + 1}` : 'ch?';
    if (binding.type === 'note') return `${channel} Note ${binding.number}`;
    if (binding.type === 'cc') return `${channel} CC ${binding.number}`;
    if (binding.type === 'program') return `${channel} Program ${binding.number}`;
    if (binding.type === 'pitchbend') return `${channel} Pitch Bend`;
    return `${binding.type}`;
}

export function resolveMidiActions(midiEvent) {
    const actions = [];
    const phase = getMidiEventPhase(midiEvent);
    if (phase === 'ignore') return actions;

    if (midiEvent.type === 'cc' && (midiEvent.number === 120 || midiEvent.number === 123)) {
        actions.push({ type: MIDI_GLOBAL_ACTIONS.PANIC });
        return actions;
    }

    const globalMappings = state.midiSettings.globalMappings || {};
    for (const actionType in globalMappings) {
        const binding = globalMappings[actionType];
        if (binding && midiEventMatchesBinding(midiEvent, binding)) {
            actions.push({ type: actionType });
        }
    }

    const sounds = state.scenes[state.currentSceneId]?.sounds || [];
    for (const sound of sounds) {
        if (sound.midi?.binding && midiEventMatchesBinding(midiEvent, sound.midi.binding)) {
            actions.push({
                type: 'sound.control',
                soundId: sound.id,
                mode: sound.midi.mode || MIDI_PLAYBACK_MODE.TOGGLE
            });
        }
    }

    if (actions.length === 0 && state.midiSettings.fixedGridEnabled && midiEvent.type === 'noteon') {
        const soundIndex = midiEvent.number - Number(state.midiSettings.baseNote ?? DEFAULT_MIDI_SETTINGS.baseNote);
        if (soundIndex >= 0 && soundIndex < sounds.length) {
            actions.push({ type: 'sound.control', soundId: sounds[soundIndex].id, mode: MIDI_PLAYBACK_MODE.TOGGLE, fixedGrid: true });
        }
    }

    return actions;
}

function handleMidiStateChange(event) {
    if (event?.currentTarget && event.currentTarget !== state.midiAccess) return;
    refreshMidiInputs();
}

function refreshMidiInputs() {
    if (!state.midiAccess) {
        updateMidiButtonState('idle');
        return;
    }

    let connectedCount = 0;
    const nextConnectedInputIds = new Set();
    for (const input of state.midiAccess.inputs.values()) {
        if (input.state !== 'disconnected') {
            input.onmidimessage = handleMidiMessage;
            nextConnectedInputIds.add(input.id);
            connectedCount += 1;
        } else {
            input.onmidimessage = null;
        }
    }

    // A disconnect can prevent Note Off from arriving. Do not carry stale held
    // state into a reconnect, where it would suppress the first Note On.
    if ([...connectedInputIds].some(id => !nextConnectedInputIds.has(id))) {
        updateState({ midiHeldKeys: {} });
    }
    connectedInputIds = nextConnectedInputIds;

    updateMidiButtonState(connectedCount > 0 ? 'connected' : 'waiting');
}

function handleMidiMessage(event) {
    const data = event.data;
    if (!data || data.length === 0) return;

    // Clock and Active Sensing can arrive hundreds of times per second. Reject
    // them before allocations or state work on the latency-sensitive path.
    if (data[0] === 0xf8 || data[0] === 0xfe) return;

    const receivedAt = performance.now();
    const midiEvent = parseMidiMessage(data);
    if (!midiEvent) return;

    midiEvent.receivedAt = receivedAt;
    midiEvent.inputId = event.currentTarget?.id || '';
    midiEvent.inputName = event.currentTarget?.name || '';
    midiEvent.phase = getMidiEventPhase(midiEvent);

    // Silently drop System Real-Time / System Common messages with no binding
    // (Clock, Active Sensing, etc.) — no spam log.
    if (midiEvent.phase === 'ignore') return;

    if (!passesMidiFilters(midiEvent)) return;

    const held = state.midiHeldKeys || (state.midiHeldKeys = {});
    let isDuplicateNoteOn = false;

    if (midiEvent.type === 'noteon') {
        const key = noteStateKey(midiEvent);
        isDuplicateNoteOn = Boolean(held[key]);
        held[key] = true;
    } else if (midiEvent.type === 'noteoff') {
        delete held[noteStateKey(midiEvent)];
    } else if (midiEvent.type === 'cc') {
        // CC as toggle: ignore repeated >0 while held
        const key = noteStateKey(midiEvent);
        const isPressed = midiEvent.value > 0;
        const wasPressed = Boolean(held[key]);
        if (isPressed && wasPressed) {
            return;
        }
        if (isPressed) held[key] = true;
        else delete held[key];
    }

    // Learn mode takes priority over action dispatch
    if (state.midiLearnTarget) {
        const binding = createBindingFromMidiEvent(midiEvent);
        if (binding) {
            const resolver = state.midiLearnTarget.resolve;
            updateState({ midiLearnTarget: null });
            updateMidiButtonState(getConnectedInputCount() > 0 ? 'connected' : 'waiting');
            resolver({ binding, midiEvent });
        }
        return;
    }

    const actions = resolveMidiActions(midiEvent);
    if (actions.length === 0) return;

    // Filter duplicate Note On:
    //  - TOGGLE / GATE sounds: a held key stays triggered; ignore duplicates
    //  - Global actions bound to a note: ignore duplicates (avoid STOP_ALL/PANIC spam)
    //  - RETRIGGER / ONESHOT: pass through per spec (ONESHOT already no-ops while playing)
    let dispatchable = actions;
    if (isDuplicateNoteOn) {
        dispatchable = actions.filter(action => {
            if (action.type === 'sound.control') {
                return action.mode !== MIDI_PLAYBACK_MODE.TOGGLE
                    && action.mode !== MIDI_PLAYBACK_MODE.GATE;
            }
            return false;
        });
    }

    if (dispatchable.length > 0 && typeof controlEventHandler === 'function') {
        controlEventHandler({ midiEvent, actions: dispatchable });
    }
}

function noteStateKey(midiEvent) {
    const ident = midiEvent.number ?? midiEvent.command ?? midiEvent.value ?? 'none';
    const family = midiEvent.type === 'noteon' || midiEvent.type === 'noteoff' ? 'note' : midiEvent.type;
    return `${midiEvent.inputId || 'all'}:${family}:${midiEvent.channel ?? 'sys'}:${ident}`;
}

function closeMidiAccess(access) {
    try {
        access.onstatechange = null;
        for (const input of access.inputs.values()) {
            input.onmidimessage = null;
            if (typeof input.close === 'function') {
                Promise.resolve(input.close()).catch(err => console.warn('[MIDI] input close error:', err));
            }
        }
    } catch (err) {
        console.warn('[MIDI] disconnect error:', err);
    }
}

function passesMidiFilters(midiEvent) {
    const settings = state.midiSettings || DEFAULT_MIDI_SETTINGS;
    if (settings.deviceId && settings.deviceId !== 'all') {
        const matchedById = midiEvent.inputId === settings.deviceId;
        const matchedByName = settings.deviceName && midiEvent.inputName === settings.deviceName;
        if (!matchedById && !matchedByName) return false;
    }

    if (settings.channel !== 'all' && typeof midiEvent.channel === 'number') {
        if (midiEvent.channel !== Number(settings.channel)) return false;
    }

    return true;
}

function midiEventMatchesBinding(midiEvent, binding) {
    if (!binding) return false;
    if (binding.type === 'note') {
        return (midiEvent.type === 'noteon' || midiEvent.type === 'noteoff') && midiEvent.channel === binding.channel && midiEvent.number === binding.number;
    }
    if (binding.type === 'cc') {
        return midiEvent.type === 'cc' && midiEvent.channel === binding.channel && midiEvent.number === binding.number;
    }
    if (binding.type === 'program') {
        return midiEvent.type === 'program' && midiEvent.channel === binding.channel && midiEvent.number === binding.number;
    }
    if (binding.type === 'pitchbend') {
        return midiEvent.type === 'pitchbend' && midiEvent.channel === binding.channel;
    }
    if (binding.type === 'transport') {
        return midiEvent.type === 'transport' && midiEvent.command === binding.command;
    }
    return false;
}

function getConnectedInputCount() {
    if (!state.midiAccess) return 0;
    let count = 0;
    for (const input of state.midiAccess.inputs.values()) {
        if (input.state !== 'disconnected') count += 1;
    }
    return count;
}

function getMidiButtonTitle(status, inputCount) {
    const settings = state.midiSettings || DEFAULT_MIDI_SETTINGS;
    const filter = `入力: ${settings.deviceId === 'all' ? 'すべて' : (settings.deviceName || '選択デバイス')} / チャンネル: ${settings.channel === 'all' ? 'すべて' : Number(settings.channel) + 1}`;
    const mapping = `MIDI Learnを優先し、未割り当てNoteは${settings.fixedGridEnabled ? `Note ${settings.baseNote}からパッド順` : '固定グリッド無効'}で扱います。`;

    if (status === 'connected') return `MIDI入力: 接続済み（${inputCount}入力）。${filter}。${mapping}`;
    if (status === 'waiting') return `MIDI入力: 有効、入力待ち。DAWの出力先に仮想MIDIポートを選んでください。${filter}。`;
    if (status === 'learning') return 'MIDI Learn中です。割り当てたいMIDIキー/ボタン/Transportを送ってください。';
    if (status === 'connecting') return 'MIDI入力: 接続中です。';
    if (status === 'error') return 'MIDI入力: 接続できませんでした。ブラウザ権限とMIDIデバイスを確認してください。';
    if (status === 'unsupported') return 'このブラウザはWeb MIDI APIに対応していません。Chrome/Edgeなどで試してください。';
    return `MIDI入力を有効化します。${mapping}`;
}

export const MIDI_GLOBAL_ACTION_LABELS = {
    [MIDI_GLOBAL_ACTIONS.STOP_ALL]: 'Stop All',
    [MIDI_GLOBAL_ACTIONS.FADE_ALL]: 'Fade All',
    [MIDI_GLOBAL_ACTIONS.PANIC]: 'Panic',
    [MIDI_GLOBAL_ACTIONS.SCENE_PREV]: 'Scene Prev',
    [MIDI_GLOBAL_ACTIONS.SCENE_NEXT]: 'Scene Next'
};

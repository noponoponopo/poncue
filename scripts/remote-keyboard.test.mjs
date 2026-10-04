import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { dom } from '../modules/02_dom.js';
import { state } from '../modules/03_state.js';
import { normalizeKey } from '../modules/keyboard_shortcuts.js';
import { createRemoteKeyboardHandlers } from '../modules/remote_keyboard.js';

const originalDocument = globalThis.document;
let commands, keyboard, sound, pressedKeys;
beforeEach(() => {
    commands = [];
    pressedKeys = new Set();
    sound = { id: 'sound', triggerMode: 'toggle' };
    state.currentSceneId = 'scene';
    state.scenes = { scene: { sounds: [sound] } };
    state.shortcuts = { A: sound.id };
    globalThis.document = { activeElement: { tagName: 'BODY' }, getElementById: () => null };
    dom.customModalOverlay = dom.sceneSettingsModal = dom.remoteOverlay = null;
    dom.keyboardView = {
        querySelectorAll: () => ['A', 'Control+A'].map(shortcut => ({
            dataset: { shortcut },
            classList: {
                toggle: (_, on) => on ? pressedKeys.add(shortcut) : pressedKeys.delete(shortcut),
                remove: () => pressedKeys.delete(shortcut),
            },
        })),
    };
    keyboard = createRemoteKeyboardHandlers(command => { commands.push(command); return true; });
});
afterEach(() => {
    globalThis.document = originalDocument;
    dom.keyboardView = null;
});

function key(overrides = {}) {
    return {
        key: 'a', code: 'KeyA', defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...overrides,
    };
}

test('normalization matches main shortcuts, including modifiers and Japanese keys', () => {
    for (const [event, expected] of [
        [key(), 'A'],
        [key({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), 'Control+Alt+Shift+Meta+A'],
        [key({ key: ' ' }), 'Space'],
        [key({ key: 'ArrowLeft' }), 'Left'],
        [key({ key: '¥' }), 'Yen'],
        [key({ key: 'Lang2' }), 'English'],
        [key({ key: 'Hiragana' }), 'Kana'],
        [key({ key: 'Shift', shiftKey: true }), ''],
    ]) assert.equal(normalizeKey(event), expected);
});

test('tap modes send one command per press, suppress repeats and default button clicks', () => {
    for (const mode of ['toggle', 'retrigger', 'sustain', 'pause', 'mute']) {
        sound.triggerMode = mode;
        commands.length = 0;
        const down = key();
        keyboard.handleKeyDown(down);
        keyboard.handleKeyDown(key({ repeat: true }));
        keyboard.handleKeyDown(key());
        assert.equal(down.defaultPrevented, true);
        assert.equal(pressedKeys.has('A'), true);
        keyboard.handleKeyUp(key());
        assert.equal(pressedKeys.size, 0);
        assert.deepEqual(commands, [{ t: 'tg', id: sound.id, k: 'tap', c: 'key:KeyA' }]);
    }
});

test('hold modes and drum rolls send paired down/up commands', () => {
    for (const mode of ['momentary', 'pauseHold', 'muteHold', 'roll', 'toggle']) {
        sound.triggerMode = mode;
        sound.type = mode === 'toggle' ? 'roll' : undefined;
        commands.length = 0;
        keyboard.handleKeyDown(key());
        keyboard.handleKeyDown(key({ repeat: true }));
        keyboard.handleKeyUp(key());
        assert.deepEqual(commands, ['down', 'up'].map(k => ({ t: 'tg', id: sound.id, k, c: 'key:KeyA' })));
    }
});

test('keyup releases the original hold after modifiers, focus and shortcut assignments change', () => {
    sound.triggerMode = 'momentary';
    state.shortcuts = { 'Control+A': sound.id };
    keyboard.handleKeyDown(key({ ctrlKey: true }));
    keyboard.handleKeyUp(key({ key: 'Control', code: 'ControlLeft' }));
    document.activeElement = { tagName: 'INPUT' };
    state.shortcuts = { A: 'another-sound' };
    keyboard.handleKeyUp(key());
    assert.deepEqual(commands, ['down', 'up'].map(k => ({ t: 'tg', id: sound.id, k, c: 'key:KeyA' })));
    assert.equal(pressedKeys.size, 0);
});

test('releaseAll ends each held key once and permits the next press', () => {
    sound.triggerMode = 'momentary';
    keyboard.handleKeyDown(key());
    keyboard.releaseAll();
    keyboard.releaseAll();
    keyboard.handleKeyUp(key());
    assert.deepEqual(commands.map(command => command.k), ['down', 'up']);
    assert.equal(pressedKeys.size, 0);
    keyboard.handleKeyDown(key());
    assert.equal(commands.at(-1).k, 'down');
});

test('editing and open overlays block playback', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
        document.activeElement = { tagName };
        keyboard.handleKeyDown(key());
    }
    document.activeElement = { tagName: 'DIV', isContentEditable: true };
    keyboard.handleKeyDown(key());
    document.activeElement = { tagName: 'BODY' };
    for (const modal of ['customModalOverlay', 'sceneSettingsModal']) {
        dom[modal] = { classList: { contains: () => true } };
        keyboard.handleKeyDown(key());
        dom[modal] = null;
    }
    dom.remoteOverlay = { hidden: false };
    keyboard.handleKeyDown(key());
    dom.remoteOverlay = null;
    document.getElementById = () => ({ hidden: false });
    keyboard.handleKeyDown(key());
    assert.deepEqual(commands, []);
});

test('unassigned scrolling keys are prevented, Escape remains with the controller', () => {
    const space = key({ key: ' ', code: 'Space' });
    keyboard.handleKeyDown(space);
    assert.equal(space.defaultPrevented, true);
    keyboard.handleKeyUp(space);
    keyboard.handleKeyDown(key({ key: 'Escape', code: 'Escape' }));
    assert.deepEqual(commands, []);
});

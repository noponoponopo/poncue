import { dom } from './02_dom.js';
import { state } from './03_state.js';
import { TRIGGER_MODES, HOLD_TRIGGER_MODES, SCROLL_PREVENT_KEYS } from './01_config.js';
import { normalizeKey } from './keyboard_shortcuts.js';
import { setKeyboardKeyPressed, clearAllKeyboardKeyPressed } from './11_keyboard_view.js';

function isKeyboardBlocked() {
    return dom.customModalOverlay?.classList.contains('active')
        || dom.sceneSettingsModal?.classList.contains('active')
        || (dom.remoteOverlay && !dom.remoteOverlay.hidden)
        || document.getElementById('remote-connect-overlay')?.hidden === false
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
        || document.activeElement?.isContentEditable;
}

export function createRemoteKeyboardHandlers(send) {
    const pressed = new Map();
    const inputId = (event, shortcut) => `key:${event.code && event.code !== 'Unidentified' ? event.code : shortcut}`;

    function handleKeyDown(event) {
        // Escape はコントローラー側でモーダルを閉じる処理を優先する。
        if (event.key === 'Escape' || isKeyboardBlocked()) return;
        const shortcut = normalizeKey(event);
        if (!shortcut) return;
        if (state.shortcuts[shortcut] || SCROLL_PREVENT_KEYS.has(shortcut)) event.preventDefault();
        if (event.repeat) return;
        const id = inputId(event, shortcut);
        if (pressed.has(id)) return;
        setKeyboardKeyPressed(shortcut, true);
        const soundId = state.shortcuts[shortcut];
        const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
        const mode = TRIGGER_MODES.includes(sound?.triggerMode) ? sound.triggerMode : 'toggle';
        const hold = sound?.type === 'roll' || HOLD_TRIGGER_MODES.includes(mode);
        pressed.set(id, { shortcut, soundId, hold });
        if (sound) send({ t: 'tg', id: soundId, k: hold ? 'down' : 'tap', c: id });
    }

    function releaseInput(id) {
        const entry = pressed.get(id);
        if (!entry) return;
        pressed.delete(id);
        setKeyboardKeyPressed(entry.shortcut, false);
        if (entry.hold) send({ t: 'tg', id: entry.soundId, k: 'up', c: id });
    }

    function handleKeyUp(event) {
        const shortcut = normalizeKey(event);
        // keydown 時の対象を保持し、修飾キー・フォーカス・割り当てが変わっても解放する。
        releaseInput(inputId(event, shortcut));
        if (!isKeyboardBlocked() && (state.shortcuts[shortcut] || SCROLL_PREVENT_KEYS.has(shortcut))) {
            event.preventDefault();
        }
    }

    function releaseAll() {
        for (const id of pressed.keys()) releaseInput(id);
        clearAllKeyboardKeyPressed();
    }

    return { handleKeyDown, handleKeyUp, releaseAll };
}

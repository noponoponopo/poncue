import { dom } from './02_dom.js';
import { state } from './03_state.js';

const KEY_ROWS = [
    [key('Esc', 'Escape', 1.3), ...range(1, 12).map(number => key(`F${number}`, `F${number}`))],
    [key('`', '`'), ...'1234567890'.split('').map(value => key(value, value)), key('-', '-'), key('=', '='), key('Backspace', 'Backspace', 1.7)],
    [key('Tab', 'Tab', 1.4), ...'QWERTYUIOP'.split('').map(value => key(value, value)), key('[', '['), key(']', ']'), key('\\', '\\', 1.3)],
    [key('Caps', 'CapsLock', 1.6), ...'ASDFGHJKL'.split('').map(value => key(value, value)), key(';', ';'), key("'", "'"), key('Enter', 'Enter', 1.8)],
    [key('Shift', 'Shift', 2), ...'ZXCVBNM'.split('').map(value => key(value, value)), key(',', ','), key('.', '.'), key('/', '/'), key('Shift', 'Shift', 2)],
    [key('Ctrl', 'Control', 1.3), key('Alt', 'Alt', 1.2), key('Space', 'Space', 5), key('Meta', 'Meta', 1.3), key('←', 'Left'), key('↓', 'Down'), key('↑', 'Up'), key('→', 'Right')]
];

function key(label, shortcut, width = 1) {
    return { label, shortcut, width };
}

function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function soundForShortcut(shortcut) {
    const soundId = state.shortcuts[shortcut];
    return state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId) || null;
}

export function renderKeyboardView() {
    if (!dom.keyboardView) return;
    dom.keyboardView.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'keyboard-view-heading';
    heading.innerHTML = '<strong>キーボード</strong><span>割り当て済みのキーをクリックして操作できます</span>';
    dom.keyboardView.appendChild(heading);

    const keyboard = document.createElement('div');
    keyboard.className = 'keyboard-layout';
    for (const rowData of KEY_ROWS) {
        const row = document.createElement('div');
        row.className = 'keyboard-row';
        for (const item of rowData) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'keyboard-key';
            button.dataset.shortcut = item.shortcut;
            button.style.setProperty('--key-width', item.width);
            const sound = soundForShortcut(item.shortcut);
            button.disabled = !sound;
            button.title = sound ? `${item.shortcut}: ${sound.name}` : `${item.shortcut}: 未割り当て`;
            const keyLabel = document.createElement('span');
            keyLabel.className = 'keyboard-key-label';
            keyLabel.textContent = item.label;
            button.appendChild(keyLabel);
            if (sound) {
                const soundLabel = document.createElement('span');
                soundLabel.className = 'keyboard-sound-label';
                soundLabel.textContent = sound.name;
                button.appendChild(soundLabel);
            }
            row.appendChild(button);
        }
        keyboard.appendChild(row);
    }
    dom.keyboardView.appendChild(keyboard);

    const layoutShortcuts = new Set(KEY_ROWS.flat().map(item => item.shortcut));
    const combinations = Object.keys(state.shortcuts)
        .filter(shortcut => !layoutShortcuts.has(shortcut) && soundForShortcut(shortcut));
    if (combinations.length) {
        const list = document.createElement('div');
        list.className = 'keyboard-combinations';
        for (const shortcut of combinations) {
            const sound = soundForShortcut(shortcut);
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.shortcut = shortcut;
            button.innerHTML = `<kbd></kbd><span></span>`;
            button.querySelector('kbd').textContent = shortcut;
            button.querySelector('span').textContent = sound.name;
            list.appendChild(button);
        }
        dom.keyboardView.appendChild(list);
    }
}

export function setKeyboardKeyPressed(shortcut, pressed) {
    if (!dom.keyboardView) return;
    for (const button of dom.keyboardView.querySelectorAll('[data-shortcut]')) {
        if (button.dataset.shortcut === shortcut) button.classList.toggle('is-pressed', pressed);
    }
}

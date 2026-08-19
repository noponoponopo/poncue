import { dom } from './02_dom.js';
import { state } from './03_state.js';
import { KEYBOARD_LAYOUTS, DEFAULT_KEYBOARD_LAYOUT } from './01_config.js';

// メインキー。row=0(数字段)〜4(最下段), col=0-59(0.25u単位), span=グリッド幅(1u=4), rowSpan=行またぎ(L字Enter=2)
function mk(label, shortcut, row, col, span = 4, rowSpan = 1, shape = null) {
    return { label, shortcut, row, col, span, rowSpan, shape };
}

// F段キー（flex 配置、key-width 比率）
function fk(label, shortcut, width = 1) {
    return { label, shortcut, width };
}

function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

// 各レイアウト。mainKeys は 60グリッド(15u)の Grid に座標配置。
// Enter が2行にまたがる配列(JIS/Mac)では rowSpan=2 で L字を表現。
const LAYOUTS = {
    us: {
        label: 'US配列',
        fnKeys: [fk('Esc', 'Escape', 1.25), ...range(1, 12).map(n => fk(`F${n}`, `F${n}`))],
        rows: 5,
        mainKeys: [
            // 数字段
            mk('`', '`', 0, 0), ...'1234567890'.split('').map((v, i) => mk(v, v, 0, 4 + i * 4)),
            mk('-', '-', 0, 44), mk('=', '=', 0, 48), mk('Backspace', 'Backspace', 0, 52, 8),
            // Q段
            mk('Tab', 'Tab', 1, 0, 6), ...'QWERTYUIOP'.split('').map((v, i) => mk(v, v, 1, 6 + i * 4)),
            mk('[', '[', 1, 46), mk(']', ']', 1, 50), mk('\\', '\\', 1, 54, 6),
            // A段
            mk('Caps', 'CapsLock', 2, 0, 7), ...'ASDFGHJKL'.split('').map((v, i) => mk(v, v, 2, 7 + i * 4)),
            mk(';', ';', 2, 43), mk("'", "'", 2, 47), mk('Enter', 'Enter', 2, 51, 9),
            // Z段
            mk('Shift', 'Shift', 3, 0, 9), ...'ZXCVBNM'.split('').map((v, i) => mk(v, v, 3, 9 + i * 4)),
            mk(',', ',', 3, 37), mk('.', '.', 3, 41), mk('/', '/', 3, 45), mk('Shift', 'Shift', 3, 49, 11),
            // 最下段
            mk('Ctrl', 'Control', 4, 0, 5), mk('Alt', 'Alt', 4, 5, 5), mk('Space', 'Space', 4, 10, 25),
            mk('Meta', 'Meta', 4, 35, 5), mk('←', 'Left', 4, 44, 4), mk('↓', 'Down', 4, 48, 4),
            mk('↑', 'Up', 4, 52, 4), mk('→', 'Right', 4, 56, 4)
        ]
    },
    jis: {
        label: '日本語配列 (JIS)',
        fnKeys: [fk('Esc', 'Escape', 1.25), ...range(1, 12).map(n => fk(`F${n}`, `F${n}`))],
        rows: 5,
        mainKeys: [
            // 数字段: 半/全 1-0 - ^ ¥ Backspace
            mk('半/全', 'HalfWidthFullWidth', 0, 0), ...'1234567890'.split('').map((v, i) => mk(v, v, 0, 4 + i * 4)),
            mk('-', '-', 0, 44), mk('^', '^', 0, 48), mk('¥', 'Yen', 0, 52), mk('Backspace', 'Backspace', 0, 56, 4),
            // Q段: Tab Q-P @ [ Enter(上部)
            mk('Tab', 'Tab', 1, 0, 6), ...'QWERTYUIOP'.split('').map((v, i) => mk(v, v, 1, 6 + i * 4)),
            mk('@', '@', 1, 46), mk('[', '[', 1, 50), mk('Enter', 'Enter', 1, 54, 6, 2),
            // A段: Caps A-L ; : ] (Enter が col 55-59 にまたがる)
            mk('Caps', 'CapsLock', 2, 0, 7), ...'ASDFGHJKL'.split('').map((v, i) => mk(v, v, 2, 7 + i * 4)),
            mk(';', ';', 2, 43), mk(':', ':', 2, 47), mk(']', ']', 2, 51, 3),
            // Z段: Shift Z-M , . / \ Shift
            mk('Shift', 'Shift', 3, 0, 9), ...'ZXCVBNM'.split('').map((v, i) => mk(v, v, 3, 9 + i * 4)),
            mk(',', ',', 3, 37), mk('.', '.', 3, 41), mk('/', '/', 3, 45), mk('\\', '\\', 3, 49, 4), mk('Shift', 'Shift', 3, 53, 7),
            // 最下段: Ctrl 無変換 Space 変換 かな Alt 矢印
            mk('Ctrl', 'Control', 4, 0, 5), mk('無変換', 'NonConvert', 4, 5, 5), mk('Space', 'Space', 4, 10, 18),
            mk('変換', 'Convert', 4, 28, 5), mk('かな', 'Kana', 4, 33, 5), mk('Alt', 'Alt', 4, 38, 5),
            mk('←', 'Left', 4, 43, 4), mk('↓', 'Down', 4, 47, 4), mk('↑', 'Up', 4, 51, 4), mk('→', 'Right', 4, 55, 4)
        ]
    },
    'mac-jis': {
        label: 'Mac 日本語配列',
        fnKeys: [fk('Esc', 'Escape', 1.25), ...range(1, 12).map(n => fk(`F${n}`, `F${n}`))],
        rows: 5,
        mainKeys: [
            // 数字段
            ...'1234567890'.split('').map((v, i) => mk(v, v, 0, i * 4)),
            mk('-', '-', 0, 40), mk('^', '^', 0, 44), mk('¥', 'Yen', 0, 48), mk('delete', 'Backspace', 0, 52, 8),
            // Q段: Tab Q-P @ [ Return(上部、L字)
            mk('Tab', 'Tab', 1, 0, 6), ...'QWERTYUIOP'.split('').map((v, i) => mk(v, v, 1, 6 + i * 4)),
            mk('@', '@', 1, 46), mk('[', '[', 1, 50), mk('Return', 'Enter', 1, 54, 6, 2),
            // A段: Mac JIS は Caps Lock ではなく control が左端
            mk('ctrl', 'Control', 2, 0, 7), ...'ASDFGHJKL'.split('').map((v, i) => mk(v, v, 2, 7 + i * 4)),
            mk(';', ';', 2, 43), mk(':', ':', 2, 47), mk(']', ']', 2, 51, 3),
            // Z段: Shift Z-M , . / \ Shift
            mk('Shift', 'Shift', 3, 0, 9), ...'ZXCVBNM'.split('').map((v, i) => mk(v, v, 3, 9 + i * 4)),
            mk(',', ',', 3, 37), mk('.', '.', 3, 41), mk('/', '/', 3, 45), mk('\\', '\\', 3, 49, 4), mk('Shift', 'Shift', 3, 53, 7),
            // 最下段: Caps option command 英数 Space かな command fn 矢印
            mk('Caps', 'CapsLock', 4, 0, 4), mk('option', 'Alt', 4, 4, 5), mk('command', 'Meta', 4, 9, 5),
            mk('英数', 'English', 4, 14, 5), mk('Space', 'Space', 4, 19, 14), mk('かな', 'Kana', 4, 33, 5),
            mk('command', 'Meta', 4, 38, 5), mk('fn', 'Fn', 4, 43, 5)
        ],
        arrowKeys: [
            mk('←', 'Left', 0, 0, 1, 2), mk('↓', 'Down', 1, 1, 1), mk('↑', 'Up', 0, 1, 1), mk('→', 'Right', 0, 2, 1, 2)
        ]
    },
    'mac-us': {
        label: 'Mac US配列',
        fnKeys: [fk('Esc', 'Escape', 1.25), ...range(1, 12).map(n => fk(`F${n}`, `F${n}`))],
        rows: 5,
        mainKeys: [
            // 数字段: ` 1-0 - = delete
            mk('`', '`', 0, 0), ...'1234567890'.split('').map((v, i) => mk(v, v, 0, 4 + i * 4)),
            mk('-', '-', 0, 44), mk('=', '=', 0, 48), mk('delete', 'Backspace', 0, 52, 8),
            // Q段
            mk('Tab', 'Tab', 1, 0, 6), ...'QWERTYUIOP'.split('').map((v, i) => mk(v, v, 1, 6 + i * 4)),
            mk('[', '[', 1, 46), mk(']', ']', 1, 50), mk('\\', '\\', 1, 54, 6),
            // A段: Mac ANSI の横長 Return
            mk('Caps', 'CapsLock', 2, 0, 7), ...'ASDFGHJKL'.split('').map((v, i) => mk(v, v, 2, 7 + i * 4)),
            mk(';', ';', 2, 43), mk("'", "'", 2, 47), mk('Return', 'Enter', 2, 51, 9),
            // Z段
            mk('Shift', 'Shift', 3, 0, 9), ...'ZXCVBNM'.split('').map((v, i) => mk(v, v, 3, 9 + i * 4)),
            mk(',', ',', 3, 37), mk('.', '.', 3, 41), mk('/', '/', 3, 45), mk('Shift', 'Shift', 3, 49, 11),
            // 最下段: fn control option command Space command option 矢印
            mk('fn', 'Fn', 4, 0, 4), mk('control', 'Control', 4, 4, 5), mk('option', 'Alt', 4, 9, 5),
            mk('command', 'Meta', 4, 14, 5), mk('Space', 'Space', 4, 19, 19),
            mk('command', 'Meta', 4, 38, 5), mk('option', 'Alt', 4, 43, 5)
        ],
        arrowKeys: [
            mk('←', 'Left', 0, 0, 1, 2), mk('↓', 'Down', 1, 1, 1), mk('↑', 'Up', 0, 1, 1), mk('→', 'Right', 0, 2, 1, 2)
        ]
    },
    dvorak: {
        label: 'Dvorak',
        fnKeys: [fk('Esc', 'Escape', 1.25), ...range(1, 12).map(n => fk(`F${n}`, `F${n}`))],
        rows: 5,
        mainKeys: [
            // 数字段
            mk('`', '`', 0, 0), ...'1234567890'.split('').map((v, i) => mk(v, v, 0, 4 + i * 4)),
            mk('[', '[', 0, 44), mk(']', ']', 0, 48), mk('Backspace', 'Backspace', 0, 52, 8),
            // Q段: Tab ' , . P Y F G C R L / = \
            mk('Tab', 'Tab', 1, 0, 6),
            ...`',.PYFGCRL`.split('').map((v, i) => mk(v, v, 1, 6 + i * 4)),
            mk('/', '/', 1, 46), mk('=', '=', 1, 50), mk('\\', '\\', 1, 54, 6),
            // A段: Caps A O E U I D H T N S - Enter
            mk('Caps', 'CapsLock', 2, 0, 7), ...'AOEUIDHTNS'.split('').map((v, i) => mk(v, v, 2, 7 + i * 4)),
            mk('-', '-', 2, 47), mk('Enter', 'Enter', 2, 51, 9),
            // Z段: Shift ; Q J K X B M W V Z Shift
            mk('Shift', 'Shift', 3, 0, 9), ...';QJKXBMWVZ'.split('').map((v, i) => mk(v, v, 3, 9 + i * 4)),
            mk(',', ',', 3, 49), mk('.', '.', 3, 53), mk('/', '/', 3, 57, 3),
            // 最下段
            mk('Ctrl', 'Control', 4, 0, 5), mk('Alt', 'Alt', 4, 5, 5), mk('Space', 'Space', 4, 10, 25),
            mk('cmd', 'Meta', 4, 35, 5), mk('←', 'Left', 4, 44, 4), mk('↓', 'Down', 4, 48, 4),
            mk('↑', 'Up', 4, 52, 4), mk('→', 'Right', 4, 56, 4)
        ]
    }
};

export function getLayout(id) {
    return LAYOUTS[id] || LAYOUTS[DEFAULT_KEYBOARD_LAYOUT];
}

export function getLayoutOptions() {
    return KEYBOARD_LAYOUTS.map(id => ({ id, label: LAYOUTS[id].label }));
}

function soundForShortcut(shortcut) {
    const soundId = state.shortcuts[shortcut];
    return state.scenes[state.currentSceneId]?.sounds.find(sound => sound.id === soundId) || null;
}

function createKeyButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'keyboard-key';
    if (item.shape) button.classList.add(`keyboard-key--${item.shape}`);
    button.dataset.shortcut = item.shortcut;
    const sound = soundForShortcut(item.shortcut);
    button.disabled = !sound;
    button.title = sound ? `${item.shortcut}: ${sound.name}${sound.type === 'roll' ? '（ドラムロール）' : ''}` : `${item.shortcut}: 未割り当て`;
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
    return button;
}

export function renderKeyboardView() {
    if (!dom.keyboardView) return;
    dom.keyboardView.replaceChildren();

    const layout = getLayout(state.keyboardLayout);
    const keyboard = document.createElement('div');
    keyboard.className = 'keyboard-layout';

    // F段（flex）
    if (layout.fnKeys?.length) {
        const fnRow = document.createElement('div');
        fnRow.className = 'keyboard-fn-row';
        for (const item of layout.fnKeys) {
            const button = createKeyButton(item);
            button.style.setProperty('--key-width', item.width);
            fnRow.appendChild(button);
        }
        keyboard.appendChild(fnRow);
    }

    // メイン（CSS Grid、60グリッド = 15u）
    const main = document.createElement('div');
    main.className = 'keyboard-main';
    main.style.gridTemplateColumns = 'repeat(60, 1fr)';
    main.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;
    for (const item of layout.mainKeys) {
        const button = createKeyButton(item);
        button.style.gridColumn = `${item.col + 1} / span ${item.span}`;
        button.style.gridRow = `${item.row + 1} / span ${item.rowSpan}`;
        main.appendChild(button);
    }
    if (layout.arrowKeys?.length) {
        const arrows = document.createElement('div');
        arrows.className = 'keyboard-arrow-cluster';
        for (const item of layout.arrowKeys) {
            const button = createKeyButton(item);
            button.classList.add(`keyboard-arrow-${item.shortcut.toLowerCase()}`);
            button.style.gridColumn = `${item.col + 1} / span ${item.span}`;
            button.style.gridRow = `${item.row + 1} / span ${item.rowSpan}`;
            arrows.appendChild(button);
        }
        main.appendChild(arrows);
    }
    keyboard.appendChild(main);
    dom.keyboardView.appendChild(keyboard);

    // 現在の配列に無いショートカットの組み合わせ表示
    const layoutShortcuts = new Set([
        ...layout.fnKeys.map(k => k.shortcut),
        ...layout.mainKeys.map(k => k.shortcut),
        ...(layout.arrowKeys || []).map(k => k.shortcut)
    ]);
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

    // ビューを再生中に開いた場合も、既存の再生状態と進捗を新しいキーへ反映する。
    for (const [soundId, audioInfo] of Object.entries(state.activeAudios)) {
        setKeyboardKeyPlaying(soundId, true);
        setKeyboardKeyProgress(soundId, audioInfo.progressPercent ?? 0);
    }
}

export function setKeyboardKeyPressed(shortcut, pressed) {
    if (!dom.keyboardView) return;
    for (const button of dom.keyboardView.querySelectorAll('[data-shortcut]')) {
        if (button.dataset.shortcut === shortcut) button.classList.toggle('is-pressed', pressed);
    }
}

// soundId に割り当てられたショートカットキー一覧を返す
function shortcutsForSound(soundId) {
    return Object.keys(state.shortcuts).filter(k => state.shortcuts[k] === soundId);
}

// 再生状態をキーボードビューのキーに反映する
export function setKeyboardKeyPlaying(soundId, playing) {
    if (!dom.keyboardView) return;
    const shortcuts = shortcutsForSound(soundId);
    if (!shortcuts.length) return;
    for (const button of dom.keyboardView.querySelectorAll('[data-shortcut]')) {
        if (!shortcuts.includes(button.dataset.shortcut)) continue;
        button.classList.toggle('is-playing', playing);
        if (!playing) button.style.setProperty('--progress', '0%');
    }
}

// 再生進捗(0-100)をキーボードビューのキーに反映する
export function setKeyboardKeyProgress(soundId, progressPercent) {
    if (!dom.keyboardView) return;
    const shortcuts = shortcutsForSound(soundId);
    if (!shortcuts.length) return;
    for (const button of dom.keyboardView.querySelectorAll('[data-shortcut]')) {
        if (!shortcuts.includes(button.dataset.shortcut)) continue;
        button.style.setProperty('--progress', `${progressPercent}%`);
    }
}

// keyup が発火しなかったケース（ウィンドウ離脱、タブ切り替え、OSによる修飾キー吸収）
// で pressed 状態が残留しないよう、一括で解除する。
export function clearAllKeyboardKeyPressed() {
    if (!dom.keyboardView) return;
    for (const button of dom.keyboardView.querySelectorAll('[data-shortcut].is-pressed')) {
        button.classList.remove('is-pressed');
    }
}

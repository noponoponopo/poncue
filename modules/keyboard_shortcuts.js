export function normalizeKey(event) {
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Meta');

    let key = event.key;
    if (key === ' ') key = 'Space';
    if (key === '¥') key = 'Yen';
    // Mac/Win で異なる英数・かなキーの名前を揃える。
    if (['English', 'Alphanumeric', 'Lang2', 'Eisu', 'RomanCharacters'].includes(key)) key = 'English';
    if (['Kana', 'KanaMode', 'JapaneseKana', 'Lang1', 'Hiragana'].includes(key)) key = 'Kana';
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) key = key.replace('Arrow', '');
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
    if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();

    return [...modifiers, key].filter(Boolean).join('+');
}

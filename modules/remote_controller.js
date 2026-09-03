// modules/remote_controller.js - /remote/ 専用リモコンページ
//
// サウンドボード本体 (音声エンジン・DB) を持たない軽量ページ。
// ホストが配信する状態をミラーしてパッドUIを表示し、コマンドを送信する。
// ルームIDの生成は行わない。必ずホスト側で表示されたIDを入力する。

import { REMOTE_ROOM_LENGTH } from './01_config.js';
import { createRemoteLink, randomId } from './remote_link.js';

const STORAGE_KEY = 'poncue_remote_controller';

const ui = {
    statusText: document.getElementById('remote-status-text'),
    meta: document.getElementById('remote-meta'),
    roomChip: document.getElementById('remote-room-chip'),
    body: document.getElementById('remote-body'),
    themeBtn: document.getElementById('remote-theme-btn'),
};

const state = {
    room: '',
    link: null,
    mirror: null,
    mirrorPadsKey: '',
    mirrorSceneKey: '',
    renderedOnce: false,
    volSendTimer: null,
};

// --- 保存 ---

function loadStoredRoom() {
    try {
        const obj = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return normalizeRoomId(obj?.room);
    } catch (_) {
        return '';
    }
}

function storeRoom() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ room: state.room }));
    } catch (_) { /* ストレージ使用不可でも動作は続ける */ }
}

function normalizeRoomId(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, REMOTE_ROOM_LENGTH + 2);
}

// --- テーマ ---

function initTheme() {
    const stored = localStorage.getItem('remote_dark');
    const dark = stored === null ? true : stored === '1'; // 舞台運用向きに既定はダーク
    document.body.classList.toggle('dark-mode', dark);
    updateThemeIcon();
    ui.themeBtn?.addEventListener('click', () => {
        const next = !document.body.classList.contains('dark-mode');
        document.body.classList.toggle('dark-mode', next);
        try { localStorage.setItem('remote_dark', next ? '1' : '0'); } catch (_) { /* noop */ }
        updateThemeIcon();
    });
}

function updateThemeIcon() {
    if (!ui.themeBtn) return;
    const dark = document.body.classList.contains('dark-mode');
    ui.themeBtn.innerHTML = `<i class="fas ${dark ? 'fa-sun' : 'fa-moon'}"></i>`;
}

// --- 接続 ---

function connectRoom(room) {
    state.room = room;
    state.mirror = null;
    state.mirrorPadsKey = '';
    state.mirrorSceneKey = '';
    state.renderedOnce = false;
    storeRoom();
    renderWaiting('接続しています…');

    state.link?.close();
    state.link = createRemoteLink({
        role: 'controller',
        room,
        onOpen: () => state.link.send({ t: 'sy' }),
        onJoin: () => state.link.send({ t: 'sy' }),
        onMessage: (msg) => {
            if (msg.t === 'st') applyMirror(msg);
        },
        onStatus: updateStatusUI,
    });
    state.link.connect();
    updateStatusUI();
}

function disconnect() {
    state.link?.close();
    state.link = null;
    state.mirror = null;
    renderConnectForm();
    updateStatusUI();
}

// --- 状態ミラー ---

function applyMirror(st) {
    state.mirror = st;
    const padsKey = `${st.cs}:${(st.pd ?? []).map(p => `${p.i}:${p.n}:${p.m}:${p.h ?? 0}:${p.lp ?? 0}:${p.k ?? ''}:${p.c ?? ''}`).join('|')}`;
    const sceneKey = (st.sc ?? []).map(s => `${s.i}:${s.n}`).join('|');
    const structureChanged = padsKey !== state.mirrorPadsKey || sceneKey !== state.mirrorSceneKey;
    state.mirrorPadsKey = padsKey;
    state.mirrorSceneKey = sceneKey;
    if (structureChanged || !state.renderedOnce) {
        state.renderedOnce = true;
        renderControllerPanel();
    } else {
        updateControllerActivity();
    }
}

// --- 送信 ---

function send(obj) {
    return state.link?.send(obj) ?? false;
}

// --- UI: ステータス ---

function statusLabel(link) {
    switch (link?.status) {
        case 'open': return '接続';
        case 'connecting': return '接続中…';
        case 'reconnecting': return `再接続中…`;
        case 'error': return '切断';
        default: return '未接続';
    }
}

function metaLabel(link) {
    if (!link) return '';
    const parts = [];
    if (link.rtt !== null) parts.push(`${link.rtt}ms`);
    if (link.clients > 0) parts.push(`${link.clients}台`);
    return parts.join(' / ');
}

function updateStatusUI() {
    const link = state.link;
    if (ui.statusText) ui.statusText.textContent = statusLabel(link);
    if (ui.meta) ui.meta.textContent = metaLabel(link);
    if (ui.roomChip) {
        const connected = link && link.status !== 'off';
        ui.roomChip.hidden = !connected;
        ui.roomChip.textContent = state.room;
        ui.roomChip.title = connected ? 'タップでルームを変更' : '';
    }
    setThemeStatusClass(ui.statusText?.parentElement, link?.status);
}

function setThemeStatusClass(el, status) {
    if (!el) return;
    el.classList.remove('is-open', 'is-busy', 'is-error', 'is-off');
    if (status === 'open') el.classList.add('is-open');
    else if (status === 'connecting' || status === 'reconnecting') el.classList.add('is-busy');
    else if (status === 'error') el.classList.add('is-error');
    else el.classList.add('is-off');
}

// --- UI: 接続フォーム (ルームID入力。生成はしない) ---

function renderConnectForm() {
    const body = ui.body;
    if (!body) return;
    body.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'remote-host';

    const label = document.createElement('p');
    label.className = 'remote-hint';
    label.textContent = 'ホスト側のシーン設定に表示されているルームIDを入力してください。';

    const form = document.createElement('form');
    form.className = 'remote-connect-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'remote-room-input';
    input.className = 'remote-room-input';
    input.placeholder = 'ルームID';
    input.maxLength = 10;
    input.autocomplete = 'off';
    input.autocapitalize = 'characters';
    input.spellcheck = false;
    input.value = state.room;
    input.setAttribute('aria-label', 'ルームID');
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'remote-btn-danger remote-connect-btn';
    btn.innerHTML = '<i class="fas fa-plug"></i> 接続';
    form.append(input, btn);
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const room = normalizeRoomId(input.value);
        if (!room) {
            input.focus();
            return;
        }
        connectRoom(room);
    });

    wrap.append(label, form);
    body.appendChild(wrap);
    setTimeout(() => input.focus(), 50);
}

// --- UI: コントローラーパネル ---

function renderWaiting(text) {
    const body = ui.body;
    if (!body) return;
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'remote-empty';
    const icon = document.createElement('i');
    icon.className = 'fas fa-spinner remote-wait-spin';
    const p = document.createElement('p');
    p.className = 'remote-hint';
    p.textContent = text;
    wrap.append(icon, p);
    body.appendChild(wrap);
}

function renderControllerPanel() {
    const body = ui.body;
    const st = state.mirror;
    if (!body) return;
    body.innerHTML = '';

    if (!st) {
        renderWaiting('ホストの状態を待っています…');
        return;
    }

    // シーン切替チップ
    if ((st.sc ?? []).length > 1) {
        const sceneRow = document.createElement('div');
        sceneRow.className = 'remote-scenes';
        for (const scene of st.sc) {
            const chip = document.createElement('button');
            chip.className = 'remote-scene-chip';
            chip.textContent = scene.n || '無題';
            if (scene.i === st.cs) chip.classList.add('active');
            chip.addEventListener('click', () => send({ t: 'sc', id: scene.i }));
            sceneRow.appendChild(chip);
        }
        body.appendChild(sceneRow);
    }

    // パッドグリッド
    const grid = document.createElement('div');
    grid.className = 'remote-grid';
    for (const pad of st.pd ?? []) {
        grid.appendChild(createRemotePad(pad));
    }
    body.appendChild(grid);

    // 下部操作バー
    const footer = document.createElement('div');
    footer.className = 'remote-footer';

    const stopBtn = document.createElement('button');
    stopBtn.className = 'remote-btn-danger';
    stopBtn.innerHTML = '<i class="fas fa-stop"></i> 全停止';
    stopBtn.addEventListener('click', () => send({ t: 'sa' }));

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'remote-btn-secondary';
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i> 一時停止/再開';
    pauseBtn.addEventListener('click', () => send({ t: 'pa' }));

    const volWrap = document.createElement('label');
    volWrap.className = 'remote-vol';
    const volIcon = document.createElement('i');
    volIcon.className = 'fas fa-volume-high';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1';
    vol.step = '0.01';
    vol.value = String(st.mv ?? 1);
    const volValue = document.createElement('span');
    volValue.className = 'remote-vol-value';
    const volPercent = () => `${Math.round(Number(vol.value) * 100)}%`;
    volValue.textContent = volPercent();
    vol.addEventListener('input', () => {
        volValue.textContent = volPercent();
        clearTimeout(state.volSendTimer);
        state.volSendTimer = setTimeout(() => send({ t: 'vol', v: Number(vol.value) }), 60);
    });
    vol.addEventListener('change', () => send({ t: 'vol', v: Number(vol.value), save: 1 }));
    volWrap.append(volIcon, vol, volValue);

    footer.append(stopBtn, pauseBtn, volWrap);
    body.appendChild(footer);

    updateControllerActivity();
}

function formatShortcut(shortcut) {
    if (!shortcut) return '';
    return shortcut
        .split('+')
        .map(part => part.replace(/^Key|^Digit/, ''))
        .map(part => ({ Control: 'Ctrl', Meta: 'Cmd', Alt: 'Opt', Shift: 'Shift' }[part] ?? part))
        .join('+');
}

function createRemotePad(pad) {
    const btn = document.createElement('button');
    btn.className = 'remote-pad';
    btn.dataset.id = pad.i;
    if (pad.c) {
        btn.style.setProperty('--pad-color', pad.c);
        btn.classList.add('has-color');
    }
    if (pad.m !== 'toggle') btn.classList.add(`trigger-${pad.m}`);
    if (pad.h) btn.classList.add('hold');
    if (pad.lp) btn.classList.add('loop-on');

    const icon = document.createElement('i');
    icon.className = `remote-pad-icon fas ${pad.m === 'roll' ? 'fa-drum' : 'fa-play'}`;
    btn.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'remote-pad-name';
    name.textContent = pad.n || '無題';
    btn.appendChild(name);

    if (pad.k) {
        const key = document.createElement('span');
        key.className = 'remote-pad-key';
        key.textContent = formatShortcut(pad.k);
        btn.appendChild(key);
    }
    if (pad.m !== 'toggle') {
        const badge = document.createElement('span');
        badge.className = 'remote-pad-mode';
        badge.textContent = pad.h ? 'HOLD' : pad.m.toUpperCase();
        btn.appendChild(badge);
    }

    if (pad.h) {
        const inputId = randomId(4, '0123456789abcdef');
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            btn.classList.add('pressing');
            try { btn.setPointerCapture?.(e.pointerId); } catch (_) { /* noop */ }
            send({ t: 'tg', id: pad.i, k: 'down', c: inputId });
            const release = () => {
                btn.classList.remove('pressing');
                send({ t: 'tg', id: pad.i, k: 'up', c: inputId });
            };
            btn.addEventListener('pointerup', release, { once: true });
            btn.addEventListener('pointercancel', release, { once: true });
        });
        btn.addEventListener('contextmenu', e => e.preventDefault());
    } else {
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            send({ t: 'tg', id: pad.i, k: 'tap' });
        });
    }
    return btn;
}

function updateControllerActivity() {
    const grid = ui.body?.querySelector('.remote-grid');
    if (!grid) return;
    const ac = state.mirror?.ac ?? {};
    for (const el of grid.querySelectorAll('.remote-pad')) {
        const info = ac[el.dataset.id];
        el.classList.toggle('playing', !!info && !info.p);
        el.classList.toggle('paused', !!info?.p);
        el.classList.toggle('muted', !!info?.u);
        const layers = info?.l ?? 0;
        let badge = el.querySelector('.remote-pad-layers');
        if (layers > 1) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'remote-pad-layers';
                el.appendChild(badge);
            }
            badge.textContent = `x${layers}`;
        } else if (badge) {
            badge.remove();
        }
    }
}

// --- 初期化 ---

initTheme();
state.room = loadStoredRoom();
ui.roomChip?.addEventListener('click', () => {
    if (state.link) disconnect(); // ルームチップ tap で入力フォームへ戻る
});

if (state.room) connectRoom(state.room);
else renderConnectForm();

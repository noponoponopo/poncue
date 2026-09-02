// modules/12_remote.js - リモート操作 (ホスト/コントローラー)
//
// cfws (ws.nopo.dev) の透過中継ルーム経由で別デバイスのポン出しを操作する。
// - ホスト: この端末で再生する。コントローラーからのコマンドをローカル再生パイプラインで実行し、
//   パッド一覧と再生状態を差分ブロードキャストする。
// - コントローラー: ホストが配信する状態をミラーしてパッドUIを表示し、タップ/ホールドを送信する。
//
// 安定化のための方針:
// - 心跳 (5s) で RTT 計測と接続保持を兼ね、無応答なら自ら切って再接続する。
// - 再接続は指数バックオフ + ジッター。 open したら hello と state で必ず再同期する。
// - コマンドは小型 JSON。喪失しても次の state 同期で UI が収束するため送信キューは持たない。

import { state, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import {
    TRIGGER_MODES, HOLD_TRIGGER_MODES,
    REMOTE_WS_BASE, REMOTE_SERVICE,
    REMOTE_HEARTBEAT_MS, REMOTE_DEAD_AFTER_MS,
    REMOTE_BACKOFF_BASE_MS, REMOTE_BACKOFF_MAX_MS,
    REMOTE_STATE_POLL_MS, REMOTE_MAX_PADS, REMOTE_MAX_SCENES,
    REMOTE_SETTINGS_KEY, REMOTE_ROOM_CHARS, REMOTE_ROOM_LENGTH
} from './01_config.js';
import { selectScene, saveSetting } from './07_scenes.js';
import { stopAllSounds, togglePauseAllSounds } from './06_audio.js';
import { updateMasterVolumeKnob } from './05_ui.js';
import { handleSoundButtonClick, startHoldPlayback, endHoldPlayback, startRetriggerPlayback } from './08_handlers.js';

// --- モジュール状態 ---
const remote = {
    mode: 'off',            // 'off' | 'host' | 'controller'
    room: '',
    ws: null,
    status: 'off',          // 'off' | 'connecting' | 'open' | 'reconnecting' | 'error'
    attempt: 0,
    intentionalClose: false,
    rtt: null,
    clients: 0,
    conflict: false,        // 別ホスト検知
    connId: '',             // コントローラーのホールド入力識別用 (host 側の _holdInputs と対応)
    lastPongAt: 0,
    heartbeatTimer: null,
    reconnectTimer: null,
    pollTimer: null,
    lastStateJson: '',
    volSendTimer: null,
    // コントローラー側ミラー
    mirror: null,
    mirrorPadsKey: '',
    mirrorSceneKey: '',
    overlayOpen: false,
    renderedOnce: false,
};

// --- ユーティリティ ---

function randomId(length, chars) {
    const buf = new Uint32Array(length);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
    return out;
}

function generateRoomId() {
    // 接頭辞なしの8文字。アルファベットに紛らわしい文字を含まず、大文字小文字の正規化とも衝突しない
    return randomId(REMOTE_ROOM_LENGTH, REMOTE_ROOM_CHARS);
}

function normalizeRoomId(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 32);
}

function findPadElement(soundId) {
    if (!dom.soundboard || !soundId) return null;
    try {
        return dom.soundboard.querySelector(`.sound-button[data-id="${CSS.escape(soundId)}"]`);
    } catch (_) {
        return null;
    }
}

function isHoldTriggerSound(sound) {
    return sound?.type === 'roll' || HOLD_TRIGGER_MODES.includes(sound?.triggerMode);
}

function formatShortcut(shortcut) {
    if (!shortcut) return '';
    return shortcut
        .split('+')
        .map(part => part.replace(/^Key|^Digit/, ''))
        .map(part => ({ Control: 'Ctrl', Meta: 'Cmd', Alt: 'Opt', Shift: 'Shift' }[part] ?? part))
        .join('+');
}

function setThemeStatusClass(el, status) {
    if (!el) return;
    el.classList.remove('is-open', 'is-busy', 'is-error', 'is-off');
    if (status === 'open') el.classList.add('is-open');
    else if (status === 'connecting' || status === 'reconnecting') el.classList.add('is-busy');
    else if (status === 'error') el.classList.add('is-error');
    else el.classList.add('is-off');
}

// --- 設定の読み書き ---

function loadStoredSettings() {
    try {
        const raw = localStorage.getItem(REMOTE_SETTINGS_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return {
            mode: ['off', 'host', 'controller'].includes(obj?.mode) ? obj.mode : 'off',
            room: normalizeRoomId(obj?.room),
        };
    } catch (_) {
        return null;
    }
}

function storeSettings() {
    try {
        localStorage.setItem(REMOTE_SETTINGS_KEY, JSON.stringify({ mode: remote.mode, room: remote.room }));
    } catch (_) { /* ストレージ使用不可でも動作は続ける */ }
}

// --- 接続管理 ---

function setStatus(status) {
    remote.status = status;
    updateStatusUI();
}

function wsUrl() {
    return `${REMOTE_WS_BASE}/${REMOTE_SERVICE}/${encodeURIComponent(remote.room)}`;
}

function connect() {
    if (remote.mode === 'off' || !remote.room) return;
    if (remote.ws && (remote.ws.readyState === WebSocket.OPEN || remote.ws.readyState === WebSocket.CONNECTING)) return;

    remote.intentionalClose = false;
    if (!remote.connId) remote.connId = randomId(6, '23456789abcdefghijklmnopqrstuvwxyz');
    setStatus(remote.attempt > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try {
        ws = new WebSocket(wsUrl());
    } catch (err) {
        console.error('[remote] WebSocket生成失敗', err);
        setStatus('error');
        scheduleReconnect();
        return;
    }
    remote.ws = ws;

    ws.onopen = () => {
        remote.attempt = 0;
        remote.lastPongAt = Date.now();
        remote.rtt = null;
        setStatus('open');
        send({ t: 'he', role: remote.mode });
        if (remote.mode === 'host') sendHostState(true);
        else send({ t: 'sy' }); // コントローラーは即座にフル同期を要求
        updateStatusUI();
    };

    ws.onmessage = (evt) => handleMessage(evt);

    ws.onclose = () => {
        if (remote.ws !== ws) return;
        remote.ws = null;
        stopHeartbeat();
        remote.rtt = null; // 古いRTT/台数表示をクリア
        remote.clients = 0;
        if (remote.mode === 'off' || remote.intentionalClose) {
            setStatus(remote.mode === 'off' ? 'off' : 'error');
            return;
        }
        scheduleReconnect();
    };

    ws.onerror = () => { /* onclose が続くのでここでは何もしない */ };

    startHeartbeat();
}

function disconnect() {
    remote.intentionalClose = true;
    clearTimeout(remote.reconnectTimer);
    remote.reconnectTimer = null;
    stopHeartbeat();
    stopHostPoll();
    if (remote.ws) {
        try { remote.ws.close(1000, 'client-off'); } catch (_) { /* 既に閉じている */ }
        remote.ws = null;
    }
    remote.rtt = null;
    remote.clients = 0;
    remote.conflict = false;
    remote.mirror = null;
    remote.mirrorPadsKey = '';
    remote.mirrorSceneKey = '';
    remote.attempt = 0;
    setStatus('off');
}

function scheduleReconnect() {
    if (remote.mode === 'off' || remote.reconnectTimer) return;
    const attempt = ++remote.attempt;
    const base = Math.min(REMOTE_BACKOFF_MAX_MS, REMOTE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% ジッター
    setStatus('reconnecting');
    remote.reconnectTimer = setTimeout(() => {
        remote.reconnectTimer = null;
        connect();
    }, delay);
    updateStatusUI();
}

function send(obj) {
    const ws = remote.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(obj));
        return true;
    } catch (err) {
        console.warn('[remote] 送信失敗', err);
        return false;
    }
}

function startHeartbeat() {
    stopHeartbeat();
    remote.heartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'hidden') return; // バックグラウンド中の誤切断を防ぐ
        const ws = remote.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (remote.lastPongAt && Date.now() - remote.lastPongAt > REMOTE_DEAD_AFTER_MS) {
            // 応答なし → 自ら切って onclose 経由で再接続させる
            try { ws.close(4000, 'heartbeat-timeout'); } catch (_) { /* noop */ }
            return;
        }
        send({ t: 'pi', ts: Date.now() });
    }, REMOTE_HEARTBEAT_MS);
}

function stopHeartbeat() {
    clearInterval(remote.heartbeatTimer);
    remote.heartbeatTimer = null;
}

// --- メッセージ処理 ---

function handleMessage(evt) {
    let msg;
    try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
    } catch (_) {
        return; // JSON以外 (他クライアントのバイナリ等) は無視
    }
    // cfws の join/leave 通知は {sys,cid,clients} で t フィールドを持たない
    if (typeof msg.sys === 'string') {
        if (Number.isFinite(msg.clients)) remote.clients = msg.clients;
        if (msg.sys === 'join') {
            // 新規参加者のため即同期 (ホストは状態を、コントローラーは同期要求を出す)
            if (remote.mode === 'host') sendHostState(true);
            else if (remote.mode === 'controller') send({ t: 'sy' });
        }
        updateStatusUI();
        return;
    }

    switch (msg.t) {
        case 'pi': // 心跳 → 全員が応答する (送信者がRTT計測)
            send({ t: 'po', ts: msg.ts });
            return;
        case 'po': {
            const ts = Number(msg.ts);
            if (Number.isFinite(ts)) {
                remote.rtt = Math.max(0, Date.now() - ts);
                remote.lastPongAt = Date.now();
                updateStatusUI();
            }
            return;
        }
        case 'he': {
            if (msg.role === 'host' && remote.mode === 'host') remote.conflict = true;
            if (msg.role === 'host' && remote.mode === 'controller') send({ t: 'sy' });
            updateStatusUI();
            return;
        }
        case 'st':
            if (remote.mode === 'controller') applyMirror(msg);
            return;
        case 'sy':
            if (remote.mode === 'host') sendHostState(true);
            return;
        case 'tg':
        case 'sa':
        case 'pa':
        case 'sc':
        case 'vol':
            if (remote.mode === 'host') handleCommand(msg);
            return;
        default:
            return;
    }
}

// --- ホスト: コマンド実行 ---

function handleCommand(msg) {
    switch (msg.t) {
        case 'tg': {
            const soundId = String(msg.id ?? '');
            const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
            if (!sound) return;
            const el = findPadElement(soundId);
            const inputId = `remote:${remote.connId}:${msg.c ?? ''}`;
            if (msg.k === 'down') {
                startHoldPlayback(soundId, el, inputId);
            } else if (msg.k === 'up') {
                endHoldPlayback(soundId, inputId, el);
            } else { // tap
                if (isHoldTriggerSound(sound)) return; // ホールド系は down/up のみ受け付ける
                const mode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
                if (mode === 'retrigger') startRetriggerPlayback(soundId, el);
                else handleSoundButtonClick(soundId, el);
            }
            return;
        }
        case 'sa': // 全停止
            stopAllSounds(true);
            return;
        case 'pa': // 全一時停止 / 全再開 (本体のヘッダーボタンと同じ挙動)
            togglePauseAllSounds();
            return;
        case 'sc': {
            const sceneId = String(msg.id ?? '');
            if (state.scenes[sceneId] && sceneId !== state.currentSceneId) selectScene(sceneId);
            return;
        }
        case 'vol':
            applyMasterVolume(Number(msg.v), Boolean(msg.save));
            return;
        default:
            return;
    }
}

function applyMasterVolume(value, save) {
    if (!Number.isFinite(value)) return;
    const vol = Math.min(1, Math.max(0, value));
    updateState({ masterVolume: vol });
    if (state.masterGainNode && state.audioContext) {
        state.masterGainNode.gain.setTargetAtTime(vol, state.audioContext.currentTime, 0.01);
    }
    updateMasterVolumeKnob(vol);
    if (save) saveSetting('masterVolume', vol);
}

// --- ホスト: 状態配信 ---

function collectHostState() {
    const scene = state.scenes[state.currentSceneId];
    const shortcutByPad = {};
    for (const [key, sid] of Object.entries(state.shortcuts ?? {})) shortcutByPad[sid] = key;

    const pd = (scene?.sounds ?? []).slice(0, REMOTE_MAX_PADS).map(s => ({
        i: s.id,
        n: String(s.name ?? ''),
        m: TRIGGER_MODES.includes(s.triggerMode) ? s.triggerMode : 'toggle',
        h: isHoldTriggerSound(s) ? 1 : undefined,
        lp: s.loop ? 1 : undefined,
        k: shortcutByPad[s.id],
    }));

    const ac = {};
    for (const [id, audio] of Object.entries(state.activeAudios)) {
        if (audio?.isFadingOut) continue;
        const layers = state.sustainLayers[id]?.length ?? 0;
        ac[id] = { u: audio?.muted ? 1 : 0, l: layers > 1 ? layers : 0 };
    }
    for (const id of Object.keys(state.pausedSounds)) {
        if (!ac[id]) ac[id] = { p: 1 };
    }

    return {
        t: 'st', v: 1,
        cs: state.currentSceneId,
        sn: String(scene?.name ?? ''),
        sc: Object.entries(state.scenes).slice(0, REMOTE_MAX_SCENES)
            .map(([id, s]) => ({ i: id, n: String(s?.name ?? '') })),
        pd, ac,
        mv: Math.round((state.masterVolume ?? 1) * 100) / 100,
    };
}

function sendHostState(force = false) {
    const msg = collectHostState();
    const json = JSON.stringify(msg);
    if (!force && json === remote.lastStateJson) return;
    remote.lastStateJson = json;
    send(msg);
}

function startHostPoll() {
    stopHostPoll();
    remote.lastStateJson = '';
    remote.pollTimer = setInterval(() => sendHostState(false), REMOTE_STATE_POLL_MS);
}

function stopHostPoll() {
    clearInterval(remote.pollTimer);
    remote.pollTimer = null;
    remote.lastStateJson = '';
}

// --- コントローラー: ミラー状態の反映 ---

function applyMirror(st) {
    remote.mirror = st;
    const padsKey = `${st.cs}:${(st.pd ?? []).map(p => `${p.i}:${p.n}:${p.m}:${p.h ?? 0}:${p.lp ?? 0}:${p.k ?? ''}`).join('|')}`;
    const sceneKey = (st.sc ?? []).map(s => `${s.i}:${s.n}`).join('|');
    const structureChanged = padsKey !== remote.mirrorPadsKey;
    const scenesChanged = sceneKey !== remote.mirrorSceneKey;
    remote.mirrorPadsKey = padsKey;
    remote.mirrorSceneKey = sceneKey;
    if (!remote.overlayOpen) return;
    if (structureChanged || scenesChanged || !remote.renderedOnce) {
        remote.renderedOnce = true;
        renderControllerPanel();
    } else {
        updateControllerActivity();
    }
}

// --- UI: ステータス表示 ---

function statusLabel() {
    switch (remote.status) {
        case 'open': return '接続';
        case 'connecting': return '接続中…';
        case 'reconnecting': return `再接続中… (${remote.attempt})`;
        case 'error': return '切断';
        default: return 'オフ';
    }
}

function metaLabel() {
    const parts = [];
    if (remote.rtt !== null) parts.push(`${remote.rtt}ms`);
    if (remote.clients > 0) parts.push(`${remote.clients}台`);
    return parts.join(' / ');
}

function updateStatusUI() {
    if (dom.remoteStatusText) dom.remoteStatusText.textContent = statusLabel();
    if (dom.remoteMeta) dom.remoteMeta.textContent = metaLabel();
    setThemeStatusClass(dom.remoteBtn, remote.status);
    // ヘッダーボタンとオーバーレイ内の状態ドットの両方に状態色を反映する
    setThemeStatusClass(document.querySelector('#remote-overlay .remote-dot'), remote.status);
    setThemeStatusClass(document.querySelector('#remote-btn .remote-dot'), remote.status);
    if (dom.remoteSettingStatus) dom.remoteSettingStatus.textContent = `${statusLabel()}${remote.room ? ` / ${remote.room}` : ''}${metaLabel() ? ` / ${metaLabel()}` : ''}`;
    const hostRoomStatus = document.getElementById('remote-host-status');
    if (hostRoomStatus) hostRoomStatus.textContent = `${statusLabel()}${metaLabel() ? ` / ${metaLabel()}` : ''}${remote.conflict ? ' / ⚠ 別のホストも接続中' : ''}`;
}

// --- UI: オーバーレイパネル ---

function openOverlay() {
    if (!dom.remoteOverlay) return;
    dom.remoteOverlay.hidden = false;
    remote.overlayOpen = true;
    remote.renderedOnce = false;
    renderPanel();
}

function closeOverlay() {
    if (!dom.remoteOverlay) return;
    dom.remoteOverlay.hidden = true;
    remote.overlayOpen = false;
}

function renderPanel() {
    const body = dom.remoteBody;
    if (!body) return;
    body.innerHTML = '';
    if (remote.mode === 'controller') renderControllerPanel();
    else if (remote.mode === 'host') renderHostPanel();
    else renderOffPanel();
}

function renderOffPanel() {
    const body = dom.remoteBody;
    const p = document.createElement('p');
    p.className = 'remote-hint';
    p.textContent = 'シーン設定の「リモート操作」でホストまたはコントローラーを選ぶと、この画面がリモコンになります。';
    const btn = document.createElement('button');
    btn.className = 'remote-btn-secondary';
    btn.textContent = '設定を開く';
    btn.addEventListener('click', () => { closeOverlay(); dom.sceneSettingsBtn?.click(); });
    body.append(p, btn);
}

function renderHostPanel() {
    const body = dom.remoteBody;
    const label = document.createElement('p');
    label.className = 'remote-hint';
    label.textContent = 'この端末がホストです。コントローラー側で同じルームIDを入力してください。';
    const roomRow = document.createElement('div');
    roomRow.className = 'remote-room-row';
    const roomId = document.createElement('span');
    roomId.className = 'remote-room-id';
    roomId.textContent = remote.room || '—';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'remote-btn-secondary';
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(remote.room);
            copyBtn.textContent = 'コピーしました';
        } catch (_) {
            copyBtn.textContent = '失敗';
        }
        setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1200);
    });
    roomRow.append(roomId, copyBtn);
    const status = document.createElement('p');
    status.className = 'remote-hint';
    status.id = 'remote-host-status';
    body.append(label, roomRow, status);
    updateStatusUI();
}

function renderControllerPanel() {
    const body = dom.remoteBody;
    const st = remote.mirror;
    body.innerHTML = '';

    if (!st) {
        const p = document.createElement('p');
        p.className = 'remote-hint';
        p.textContent = 'ホストの状態を待っています…';
        body.appendChild(p);
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

    // フッター操作
    const footer = document.createElement('div');
    footer.className = 'remote-footer';

    const stopBtn = document.createElement('button');
    stopBtn.className = 'remote-btn-danger';
    stopBtn.textContent = '全停止';
    stopBtn.addEventListener('click', () => send({ t: 'sa' }));

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'remote-btn-secondary';
    pauseBtn.textContent = '一時停止/再開';
    pauseBtn.addEventListener('click', () => send({ t: 'pa' }));

    const volWrap = document.createElement('label');
    volWrap.className = 'remote-vol';
    const volText = document.createElement('span');
    volText.textContent = '音量';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1';
    vol.step = '0.01';
    vol.value = String(st.mv ?? 1);
    vol.addEventListener('input', () => {
        clearTimeout(remote.volSendTimer);
        remote.volSendTimer = setTimeout(() => send({ t: 'vol', v: Number(vol.value) }), 60);
    });
    vol.addEventListener('change', () => send({ t: 'vol', v: Number(vol.value), save: 1 }));
    volWrap.append(volText, vol);

    footer.append(stopBtn, pauseBtn, volWrap);
    body.appendChild(footer);

    updateControllerActivity();
}

function createRemotePad(pad) {
    const btn = document.createElement('button');
    btn.className = 'remote-pad';
    btn.dataset.id = pad.i;
    if (pad.m !== 'toggle') btn.classList.add(`trigger-${pad.m}`);
    if (pad.h) btn.classList.add('hold');
    if (pad.lp) btn.classList.add('loop-on');

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

    const sendTap = () => send({ t: 'tg', id: pad.i, k: 'tap' });
    if (pad.h) {
        const inputId = randomId(4, '0123456789abcdef');
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            try { btn.setPointerCapture?.(e.pointerId); } catch (_) { /* noop */ }
            send({ t: 'tg', id: pad.i, k: 'down', c: inputId });
            const release = () => send({ t: 'tg', id: pad.i, k: 'up', c: inputId });
            btn.addEventListener('pointerup', release, { once: true });
            btn.addEventListener('pointercancel', release, { once: true });
        });
        btn.addEventListener('contextmenu', e => e.preventDefault());
    } else {
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            sendTap();
        });
    }
    return btn;
}

function updateControllerActivity() {
    const grid = dom.remoteBody?.querySelector('.remote-grid');
    if (!grid) return;
    const ac = remote.mirror?.ac ?? {};
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

// --- 設定UI (シーン設定モーダル内) ---

function applyMode(nextMode, nextRoom, { openPanel = false } = {}) {
    const mode = ['off', 'host', 'controller'].includes(nextMode) ? nextMode : 'off';
    const room = normalizeRoomId(nextRoom);
    const modeChanged = mode !== remote.mode || room !== remote.room;

    remote.mode = mode;
    remote.room = room;
    storeSettings();
    if (dom.remoteModeSelect) dom.remoteModeSelect.value = mode;
    if (dom.remoteRoomInput) dom.remoteRoomInput.value = room;

    if (modeChanged) disconnect();
    if (mode !== 'off') {
        if (!room) {
            remote.room = generateRoomId();
            if (dom.remoteRoomInput) dom.remoteRoomInput.value = remote.room;
            storeSettings();
        }
        connect();
        if (mode === 'host') startHostPoll();
        if (openPanel) openOverlay();
        else if (remote.overlayOpen) renderPanel();
    } else {
        stopHostPoll();
        if (remote.overlayOpen) renderPanel();
    }
    updateStatusUI();
}

function initRemoteUI() {
    dom.remoteBtn?.addEventListener('click', () => {
        if (remote.overlayOpen) closeOverlay();
        else openOverlay();
    });
    dom.remoteCloseBtn?.addEventListener('click', closeOverlay);

    dom.remoteModeSelect?.addEventListener('change', () => {
        applyMode(dom.remoteModeSelect.value, dom.remoteRoomInput?.value, { openPanel: true });
    });
    dom.remoteRoomInput?.addEventListener('change', () => {
        applyMode(remote.mode, dom.remoteRoomInput.value);
    });
    dom.remoteRoomGenBtn?.addEventListener('click', () => {
        const room = generateRoomId();
        if (dom.remoteRoomInput) dom.remoteRoomInput.value = room;
        applyMode(remote.mode, room);
    });
    dom.remotePanelBtn?.addEventListener('click', () => {
        if (remote.overlayOpen) closeOverlay();
        else openOverlay();
    });
}

// --- 初期化 ---

export function initRemote() {
    const stored = loadStoredSettings();
    remote.mode = stored?.mode ?? 'off';
    remote.room = stored?.room ?? '';
    initRemoteUI();
    if (dom.remoteModeSelect) dom.remoteModeSelect.value = remote.mode;
    if (dom.remoteRoomInput) dom.remoteRoomInput.value = remote.room;
    if (remote.mode !== 'off') applyMode(remote.mode, remote.room);
    updateStatusUI();

    // ページを離れるときは意図的な切断として扱い、再接続レースを防ぐ
    const bye = () => { if (remote.ws) { remote.intentionalClose = true; try { remote.ws.close(1000, 'unload'); } catch (_) { /* noop */ } } };
    window.addEventListener('pagehide', bye);
    window.addEventListener('beforeunload', bye);

    // 復帰時は即心跳で死活を確認する
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            if (remote.ws?.readyState === WebSocket.OPEN) send({ t: 'pi', ts: Date.now() });
            updateStatusUI();
        }
    });
}

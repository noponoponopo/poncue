// modules/12_remote.js - リモート操作 (ホスト側)
//
// この端末で音を出しながら、/remote/ のリモコンからの操作を受け付ける。
// - コマンド (パッドtap/hold、シーン切替、全停止、全一時停止、マスター音量) を
//   ローカル再生パイプラインで実行する
// - パッド一覧と再生状態をポーリング差分でブロードキャストする
// コントローラー側は remote/index.html (/remote/) の remote_controller.js を使う。

import { state, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import {
    TRIGGER_MODES, HOLD_TRIGGER_MODES,
    REMOTE_STATE_POLL_MS, REMOTE_MAX_PADS, REMOTE_MAX_SCENES,
    REMOTE_SETTINGS_KEY, REMOTE_ROOM_CHARS, REMOTE_ROOM_LENGTH
} from './01_config.js';
import { selectScene, saveSetting } from './07_scenes.js';
import { stopAllSounds, togglePauseAllSounds } from './06_audio.js';
import { updateMasterVolumeKnob } from './05_ui.js';
import { handleSoundButtonClick, startHoldPlayback, endHoldPlayback, startRetriggerPlayback } from './08_handlers.js';
import { createRemoteLink, randomId } from './remote_link.js';

// --- モジュール状態 ---
const remote = {
    mode: 'off',            // 'off' | 'host' (コントローラーは /remote/ 専用ページを使う)
    room: '',
    link: null,
    overlayOpen: false,
    renderedOnce: false,
    pollTimer: null,
    lastStateJson: '',
};

// --- ユーティリティ ---

function generateRoomId() {
    // 接頭辞なしの8文字。アルファベットに紛らわしい文字を含まず、大文字小文字の正規化とも衝突しない
    return randomId(REMOTE_ROOM_LENGTH, REMOTE_ROOM_CHARS);
}

function normalizeRoomId(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, REMOTE_ROOM_LENGTH + 2);
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
            // 旧バージョンの 'controller' は /remote/ 専用ページへ移行済みのため off 扱い
            mode: ['off', 'host'].includes(obj?.mode) ? obj.mode : 'off',
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

// --- ホスト起動/停止 ---

function startHost() {
    stopHost();
    renderPanel();
    remote.link = createRemoteLink({
        role: 'host',
        room: remote.room,
        onOpen: () => sendHostState(true),
        onJoin: () => sendHostState(true),
        onMessage: (msg) => {
            if (msg.t === 'sy') sendHostState(true);
            else if (msg.t === 'tg' || msg.t === 'sa' || msg.t === 'pa' || msg.t === 'sc' || msg.t === 'vol') handleCommand(msg);
        },
        onStatus: updateStatusUI,
    });
    remote.link.connect();
    startHostPoll();
    updateStatusUI();
}

function stopHost() {
    remote.link?.close();
    remote.link = null;
    stopHostPoll();
}

// --- ホスト: コマンド実行 ---

function handleCommand(msg) {
    switch (msg.t) {
        case 'tg': {
            const soundId = String(msg.id ?? '');
            const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
            if (!sound) return;
            const el = findPadElement(soundId);
            const inputId = `remote:${msg.c ?? ''}`;
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
        c: s.color || undefined,
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
    remote.link?.send(msg);
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

// --- UI: ステータス表示 ---

function statusLabel() {
    const link = remote.link;
    switch (link?.status) {
        case 'open': return '接続';
        case 'connecting': return '接続中…';
        case 'reconnecting': return '再接続中…';
        case 'error': return '切断';
        default: return 'オフ';
    }
}

function metaLabel() {
    const link = remote.link;
    if (!link) return '';
    const parts = [];
    if (link.rtt !== null) parts.push(`${link.rtt}ms`);
    if (link.clients > 0) parts.push(`${link.clients}台`);
    return parts.join(' / ');
}

function updateStatusUI() {
    if (dom.remoteStatusText) dom.remoteStatusText.textContent = statusLabel();
    if (dom.remoteMeta) dom.remoteMeta.textContent = metaLabel();
    setThemeStatusClass(dom.remoteBtn, remote.link?.status);
    // ヘッダーボタンとオーバーレイ内の状態ドットの両方に状態色を反映する
    setThemeStatusClass(document.querySelector('#remote-overlay .remote-dot'), remote.link?.status);
    setThemeStatusClass(document.querySelector('#remote-btn .remote-dot'), remote.link?.status);
    if (dom.remoteRoomChip) {
        const show = remote.link && remote.link.status !== 'off' && remote.room;
        dom.remoteRoomChip.hidden = !show;
        if (show) dom.remoteRoomChip.textContent = remote.room;
    }
    if (dom.remoteSettingStatus) {
        dom.remoteSettingStatus.textContent = `${statusLabel()}${metaLabel() ? ` / ${metaLabel()}` : ''}`;
    }
    const hostRoomStatus = document.getElementById('remote-host-status');
    if (hostRoomStatus) {
        hostRoomStatus.textContent = `${statusLabel()}${metaLabel() ? ` / ${metaLabel()}` : ''}${remote.link?.conflict ? ' / ⚠ 別のホストも接続中' : ''}`;
    }
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
    if (remote.mode === 'host') renderHostPanel();
    else renderOffPanel();
}

function renderOffPanel() {
    const body = dom.remoteBody;
    const wrap = document.createElement('div');
    wrap.className = 'remote-empty';
    const icon = document.createElement('i');
    icon.className = 'fas fa-tower-broadcast';
    const p = document.createElement('p');
    p.className = 'remote-hint';
    p.textContent = 'シーン設定の「リモート操作」でホストを有効にすると、この端末を遠隔操作できるようになります。';
    const btn = document.createElement('button');
    btn.className = 'remote-btn-secondary';
    btn.textContent = '設定を開く';
    btn.addEventListener('click', () => { closeOverlay(); dom.sceneSettingsBtn?.click(); });
    wrap.append(icon, p, btn);
    body.appendChild(wrap);
}

function renderHostPanel() {
    const body = dom.remoteBody;
    const wrap = document.createElement('div');
    wrap.className = 'remote-host';

    const label = document.createElement('p');
    label.className = 'remote-hint';
    label.textContent = 'この端末がホストです。コントローラー側で同じルームIDを入力してください。';

    const roomCard = document.createElement('div');
    roomCard.className = 'remote-room-card';
    const roomId = document.createElement('span');
    roomId.className = 'remote-room-id';
    roomId.textContent = remote.room || '—';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'remote-btn-secondary';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> コピー';
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(remote.room);
            copyBtn.innerHTML = '<i class="fas fa-check"></i> コピーしました';
        } catch (_) {
            copyBtn.innerHTML = '<i class="fas fa-xmark"></i> 失敗';
        }
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i> コピー'; }, 1200);
    });
    roomCard.append(roomId, copyBtn);

    const url = document.createElement('p');
    url.className = 'remote-hint';
    url.innerHTML = `コントローラー: <span class="remote-url"></span> を開いて入力`;
    url.querySelector('.remote-url').textContent = `${location.origin}/remote/`;

    const status = document.createElement('p');
    status.className = 'remote-hint remote-host-status';
    status.id = 'remote-host-status';

    wrap.append(label, roomCard, url, status);
    body.appendChild(wrap);
    updateStatusUI();
}

// --- 設定UI (シーン設定モーダル内) ---

function applyMode(nextMode, nextRoom, { openPanel = false } = {}) {
    const mode = ['off', 'host'].includes(nextMode) ? nextMode : 'off';
    const room = normalizeRoomId(nextRoom);
    const changed = mode !== remote.mode || room !== remote.room;

    remote.mode = mode;
    remote.room = room;
    if (dom.remoteModeSelect) dom.remoteModeSelect.value = mode;
    if (dom.remoteRoomInput) dom.remoteRoomInput.value = room;

    if (mode === 'host' && !room) {
        remote.room = generateRoomId();
        if (dom.remoteRoomInput) dom.remoteRoomInput.value = remote.room;
    }
    storeSettings();

    if (changed) stopHost();
    if (mode === 'host') {
        if (changed || !remote.link) startHost();
        if (openPanel) openOverlay();
        else if (remote.overlayOpen) renderPanel();
    } else {
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
    if (remote.mode === 'host') applyMode(remote.mode, remote.room);
    updateStatusUI();
    if (dom.remoteHint) dom.remoteHint.textContent = `コントローラー: ${location.origin}/remote/ を開いてルームIDを入力`;
}

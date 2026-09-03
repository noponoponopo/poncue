// modules/remote_controller.js - /remote/ 専用リモコンページ
//
// メインアプリと同じ画面・同じUIモジュール (05_ui.js / 11_keyboard_view.js) を使い、
// ホストが配信する状態をミラーして描画する。音の再生はホスト側で行い、
// このページからの操作はすべてリモートコマンドとして送信する。
// 波形・レベルメーター・ノーマライズ/トリム解析など、ホストの実データが
// 必要な機能だけを省略している。
// ルームIDの生成は行わない。必ずホスト側で表示されたIDを入力する。

import {
    TRIGGER_MODES, HOLD_TRIGGER_MODES,
    KEYBOARD_LAYOUTS, DEFAULT_KEYBOARD_LAYOUT, REMOTE_ROOM_LENGTH
} from './01_config.js';
import { dom, initDom } from './02_dom.js';
import { state, updateState } from './03_state.js';
import {
    showConfirm, showPrompt, showSoundSettingsModal, hideModal,
    createMasterEffectKnobs, createMasterVolumeKnob, createMasterLimiterKnob,
    initDarkMode, toggleDarkMode,
    updateDraggableState, clearDragStyles, clearDragOverStyles, escapeHtml
} from './05_ui.js';
import {
    renderKeyboardView, setKeyboardKeyPressed, setKeyboardKeyPlaying,
    setKeyboardKeyProgress, getLayoutOptions
} from './11_keyboard_view.js';
import { createRemoteLink } from './remote_link.js';

const ROOM_STORAGE_KEY = 'poncue_remote_controller'; // 旧リモコンページと共通
const UI_STORAGE_KEY = 'poncue_remote_ui';

const ctrl = {
    room: '',
    link: null,
    lastStructureJson: '',
    lastActivity: {},
    lastActivityJson: '',
    pendingStructure: null,
    interactionDepth: 0,
    throttles: {},
};

// --- 保存 ---
function loadStoredRoom() {
    try {
        const obj = JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY));
        return normalizeRoomId(obj?.room);
    } catch (_) {
        return '';
    }
}

function storeRoom() {
    try {
        localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify({ room: ctrl.room }));
    } catch (_) { /* ストレージ使用不可でも動作は続ける */ }
}

function loadLocalUi() {
    try {
        const obj = JSON.parse(localStorage.getItem(UI_STORAGE_KEY)) ?? {};
        return {
            padSize: Number.isFinite(obj.padSize) ? obj.padSize : 160,
            isSortableEnabled: Boolean(obj.isSortableEnabled),
            keyboardLayout: KEYBOARD_LAYOUTS.includes(obj.keyboardLayout) ? obj.keyboardLayout : DEFAULT_KEYBOARD_LAYOUT,
            keyboardViewVisible: Boolean(obj.keyboardViewVisible),
        };
    } catch (_) {
        return { padSize: 160, isSortableEnabled: false, keyboardLayout: DEFAULT_KEYBOARD_LAYOUT, keyboardViewVisible: false };
    }
}

function storeLocalUi() {
    try {
        localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
            padSize: state.padSize,
            isSortableEnabled: state.isSortableEnabled,
            keyboardLayout: state.keyboardLayout,
            keyboardViewVisible: state.keyboardViewVisible,
        }));
    } catch (_) { /* noop */ }
}

function normalizeRoomId(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, REMOTE_ROOM_LENGTH + 2);
}

// --- 送信 ---
function send(obj) {
    return ctrl.link?.send(obj) ?? false;
}

// リード + トレーリング throttle。knobやスライダーの連続操作を間引く。
function throttleSend(key, obj, interval = 60) {
    const now = Date.now();
    let entry = ctrl.throttles[key];
    if (!entry) entry = ctrl.throttles[key] = { last: 0, timer: null, pending: null };
    if (now - entry.last >= interval) {
        entry.last = now;
        send(obj);
        return;
    }
    entry.pending = obj;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
        entry.last = Date.now();
        if (entry.pending) send(entry.pending);
        entry.pending = null;
    }, interval - (now - entry.last));
}

// --- 操作中の再描画遅延 ---
// knob / スライダー操作中にホストのエコーでUIを組み替えると操作が中断されるため、
// ポインタ操作が終わるまで構造の再適用を遅らせる。
function watchInteractions() {
    document.addEventListener('pointerdown', (e) => {
        if (e.target instanceof Element && e.target.closest('.knob-group, .volume-control, input[type="range"]')) {
            ctrl.interactionDepth++;
        }
    }, true);
    const release = () => {
        if (ctrl.interactionDepth === 0) return;
        ctrl.interactionDepth--;
        if (ctrl.interactionDepth === 0 && ctrl.pendingStructure) {
            const st = ctrl.pendingStructure;
            ctrl.pendingStructure = null;
            applyStructure(st);
        }
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
}

// --- 接続 ---
function connectRoom(room) {
    ctrl.room = room;
    storeRoom();
    ctrl.lastStructureJson = '';
    ctrl.lastActivity = {};
    ctrl.lastActivityJson = '';
    showConnectOverlay(true);
    renderSoundboardWaiting();
    ctrl.link?.close();
    ctrl.link = createRemoteLink({
        role: 'controller',
        room,
        onOpen: () => send({ t: 'sy' }),
        onJoin: () => send({ t: 'sy' }),
        onMessage: (msg) => {
            if (msg.t === 'st') applyStructure(msg);
            else if (msg.t === 'ac') applyActivity(msg);
        },
        onStatus: updateStatusUI,
    });
    ctrl.link.connect();
    updateStatusUI();
}

function disconnect() {
    ctrl.link?.close();
    ctrl.link = null;
    updateState({ scenes: {}, currentSceneId: null, shortcuts: {} });
    renderSoundboardWaiting();
    showConnectOverlay(true);
    updateStatusUI();
}

// --- 状態ミラー: 構造 ---
function soundFromPad(p) {
    return {
        id: p.i,
        name: p.n || '無題',
        triggerMode: TRIGGER_MODES.includes(p.m) ? p.m : 'toggle',
        holdToPlay: !!p.h,
        loop: !!p.lp,
        shortcut: p.k,
        color: p.c,
        isRoll: !!p.ty,
        type: p.ty ? 'roll' : undefined,
        volume: p.v ?? 1,
        fadeInDuration: p.fi,
        fadeOutDuration: p.fo,
        fadeInEasing: p.fie,
        fadeOutEasing: p.foe,
        pan: p.p,
        playbackRate: p.sp,
        preservePitch: !!p.pp,
        reverse: !!p.rv,
        duration: p.d,
        trimStart: p.ts,
        trimEnd: p.te,
        effects: p.fx,
        error: p.e ? '音声データはホスト側にあります' : undefined,
    };
}

function applyStructure(st) {
    if (!st || typeof st !== 'object') return;
    const json = JSON.stringify(st);
    if (json === ctrl.lastStructureJson) return;
    if (ctrl.interactionDepth > 0) {
        ctrl.pendingStructure = st;
        return;
    }
    ctrl.lastStructureJson = json;

    const sounds = (st.pd ?? []).map(soundFromPad);
    const shortcuts = {};
    for (const s of sounds) {
        if (s.shortcut) shortcuts[s.shortcut] = s.id;
    }
    const scenes = {};
    for (const sc of st.sc ?? []) {
        scenes[sc.i] = {
            id: sc.i,
            name: sc.n || '無題',
            color: sc.c || null,
            // 現在シーン以外はカウントだけ使えればよい (リスト表示用)
            sounds: sc.i === st.cs ? sounds : { length: sc.ct ?? 0 },
            shortcuts: {},
        };
    }
    const fx = st.fx ?? {};

    updateState({
        scenes,
        currentSceneId: st.cs,
        shortcuts,
        masterVolume: st.mv ?? 1,
        masterEq: { low: fx.e?.[0] ?? 0, mid: fx.e?.[1] ?? 0, high: fx.e?.[2] ?? 0 },
        masterComp: { threshold: fx.c?.[0] ?? 0, ratio: fx.c?.[1] ?? 1 },
        masterDelay: { time: fx.d?.[0] ?? 0.18, feedback: fx.d?.[1] ?? 0, level: fx.d?.[2] ?? 0 },
        masterPan: { value: fx.p ?? 0 },
        masterDistortion: { amount: fx.s ?? 0 },
        masterReverb: { decay: fx.r?.[0] ?? 2.0, wet: fx.r?.[1] ?? 0, preDelay: 0.01 },
        masterLimiter: { threshold: fx.l ?? -1 },
    });

    showConnectOverlay(false);
    renderHeaderTitle();
    renderMasterControls();
    renderSoundboard();
    if (dom.sceneSettingsModal?.classList.contains('active')) populateSceneModalList();
    if (state.keyboardViewVisible) renderKeyboardView();
    updateRecordButton(!!st.rc);
    updatePauseAllButtonRemote();
    refreshPadActivity();
}

// --- 状態ミラー: 活動 (再生状態) ---
function applyActivity(msg) {
    const ac = msg.ac ?? {};
    const json = JSON.stringify(msg);
    if (json === ctrl.lastActivityJson) return;
    ctrl.lastActivityJson = json;
    ctrl.lastActivity = ac;
    refreshPadActivity();
}

// 再描画後も活動状態が消えないよう、JSON差分にかかわらず現在の ac を再適用する
function refreshPadActivity() {
    for (const el of dom.soundboard?.querySelectorAll('.sound-button') ?? []) {
        updatePadActivity(el, ctrl.lastActivity[el.dataset.id]);
    }
    updatePauseAllButtonRemote();
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function trimmedSpan(sound) {
    const trimStart = Number.isFinite(sound.trimStart) ? sound.trimStart : 0;
    const trimEnd = Number.isFinite(sound.trimEnd) ? sound.trimEnd : sound.duration;
    return Math.max(0, (trimEnd ?? 0) - trimStart);
}

// updateButtonUI + applyPlayingIcon + updateSustainLayerBadge のリモート版
// (ローカルの activeAudios を参照できないため、ホスト配信の ac から再現する)
function updatePadActivity(el, info) {
    const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === el.dataset.id);
    if (!sound) return;
    const mode = sound.triggerMode;
    const isRoll = sound.type === 'roll' || mode === 'roll';
    const playing = !!info && !info.p;
    const paused = !!info?.p;
    const muted = playing && ['mute', 'muteHold'].includes(mode) && !!info?.u;

    el.classList.toggle('playing', playing);
    el.classList.toggle('paused', paused);
    el.classList.toggle('muted', muted);

    const showAsPause = playing && !isRoll && mode === 'pause';
    const showAsPlay = playing && !isRoll && (mode === 'retrigger' || mode === 'sustain');
    const showAsMuted = playing && muted;
    const icon = el.querySelector('.sound-icon');
    if (icon) {
        icon.classList.toggle('fa-drum', isRoll && !playing);
        icon.classList.toggle('fa-play', !isRoll && (!playing || showAsPlay));
        icon.classList.toggle('fa-stop', playing && !showAsPause && !showAsPlay && !showAsMuted);
        icon.classList.toggle('fa-pause', showAsPause);
        icon.classList.toggle('fa-volume-xmark', showAsMuted);
    }

    const span = trimmedSpan(sound);
    const progress = Math.min(100, Math.max(0, info?.g ?? 0));
    el.style.setProperty('--progress', `${progress}%`);
    const progressValue = el.querySelector('.progress-bar-value');
    if (progressValue) progressValue.style.width = `${progress}%`;
    const timeDisplay = el.querySelector('.time-display');
    if (timeDisplay) {
        timeDisplay.textContent = (playing || paused) && span > 0
            ? `${formatTime(span * progress / 100)} / ${formatTime(span)}`
            : `0:00 / ${formatTime(span)}`;
    }

    const indicator = el.querySelector('.trigger-indicator');
    if (indicator && mode === 'sustain') {
        indicator.textContent = (info?.l ?? 0) > 1 ? `LAYER×${info.l}` : 'LAYER';
    }

    setKeyboardKeyPlaying(sound.id, playing);
    if (playing) setKeyboardKeyProgress(sound.id, progress);
}

// updatePauseAllButton のリモート版。pa: 1=全再開, 0=一時停止, undefined=無効
function updatePauseAllButtonRemote() {
    const btn = dom.pauseAllBtn;
    if (!btn) return;
    const entries = Object.values(ctrl.lastActivity);
    const hasActive = entries.some(info => !info.p);
    const resumeAll = entries.length > 0 && !hasActive;
    btn.disabled = entries.length === 0;
    btn.title = resumeAll ? '一時停止中のサウンドを再開' : '再生中のサウンドを一時停止';
    const icon = btn.querySelector('i');
    const label = btn.querySelector('span');
    if (icon) {
        icon.classList.toggle('fa-pause', !resumeAll);
        icon.classList.toggle('fa-play', resumeAll);
    }
    if (label) label.textContent = resumeAll ? '再開' : '一時停止';
}

function updateRecordButton(recording) {
    if (!dom.recordBtn) return;
    dom.recordBtn.classList.toggle('is-recording', recording);
    dom.recordBtn.setAttribute('aria-pressed', String(recording));
    const label = dom.recordBtn.querySelector('.record-label');
    if (label) label.textContent = recording ? '録音中' : '録音';
}

// --- 描画 ---
function renderHeaderTitle() {
    const scene = state.scenes[state.currentSceneId];
    const iconStyle = scene?.color ? ` style="color: ${scene.color};"` : '';
    const h1 = document.querySelector('header h1');
    if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"${iconStyle}></i> ${escapeHtml(scene?.name || 'シーンなし')}`;
}

function renderMasterControls() {
    createMasterVolumeKnob(state.masterVolume, (value, save) => {
        updateState({ masterVolume: value });
        if (save) send({ t: 'vol', v: value, save: 1 });
        else throttleSend('vol', { t: 'vol', v: value });
    });
    createMasterLimiterKnob(state.masterLimiter.threshold, (value, save) => {
        state.masterLimiter.threshold = value;
        if (save) send({ t: 'mx', k: 'limiter.threshold', v: value, save: 1 });
        else throttleSend('mx-lim', { t: 'mx', k: 'limiter.threshold', v: value });
    });
    createMasterEffectKnobs({
        eq: state.masterEq, comp: state.masterComp, delay: state.masterDelay,
        pan: state.masterPan, distortion: state.masterDistortion, reverb: state.masterReverb,
    }, (key, value) => {
        const [group, param] = key.split('.');
        const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
        if (state[stateKey] && param in state[stateKey]) state[stateKey][param] = value;
        // knob は連続で動くため保存(save)付きで送り、ホスト側の設定保存も兼ねる
        throttleSend(`mx-${key}`, { t: 'mx', k: key, v: value, save: 1 }, 50);
    });
}

function updatePadSizeCSS(size) {
    document.documentElement.style.setProperty('--button-min-size', `${size}px`);
}

function renderSoundboardWaiting() {
    if (!dom.soundboard) return;
    dom.soundboard.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty-state-message';
    p.textContent = 'ホストに接続するとパッドが表示されます。';
    dom.soundboard.appendChild(p);
}

function renderSoundboard() {
    if (!dom.soundboard) return;
    dom.soundboard.innerHTML = '';
    const scene = state.scenes[state.currentSceneId];
    const sounds = scene?.sounds ?? [];
    if (!scene || sounds.length === 0) {
        const p = document.createElement('p');
        p.className = 'empty-state-message';
        p.textContent = 'ホストのシーンにサウンドがありません。追加はホスト側で行えます。';
        dom.soundboard.appendChild(p);
        return;
    }
    for (const sound of sounds) {
        dom.soundboard.appendChild(createRemoteSoundButton(sound));
    }
    updateDraggableState();
}

function shortcutDisplay(shortcut) {
    return String(shortcut ?? '')
        .replace('Control+', 'Ctrl+')
        .replace('Meta+', 'Cmd+');
}

// createSoundButton (08_handlers.js) と同じマークアップのリモート版。
// 再生系の操作はローカルで実行せずホストへコマンドを送る。
function createRemoteSoundButton(sound) {
    const el = document.createElement('div');
    el.className = 'sound-button';
    el.dataset.id = sound.id;
    el.title = sound.name;
    if (sound.loop) el.classList.add('loop-on');
    const triggerMode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
    const isHoldTrigger = sound.type === 'roll' || HOLD_TRIGGER_MODES.includes(triggerMode);
    if (triggerMode !== 'toggle') el.classList.add(`trigger-${triggerMode}`);
    if (sound.color) {
        el.style.setProperty('--pad-color', sound.color);
        el.classList.add('has-color');
    }
    if (sound.error) el.classList.add('error');

    const shortcutText = sound.shortcut ? shortcutDisplay(sound.shortcut) : '';
    const settingsContent = shortcutText
        ? (shortcutText.length > 7 ? '...' + shortcutText.slice(-5) : shortcutText)
        : '<i class="fas fa-cog"></i>';

    const span = trimmedSpan(sound);
    const TRIGGER_INDICATOR_TEXTS = { momentary: 'HOLD', retrigger: 'RETRIG', sustain: 'LAYER', pause: 'PAUSE', pauseHold: 'HOLD+PAUSE', mute: 'MUTE', muteHold: 'HOLD+MUTE', roll: 'ROLL' };

    el.innerHTML = `
        <span class="loop-indicator">LOOP</span>
        <span class="trigger-indicator">${TRIGGER_INDICATOR_TEXTS[triggerMode] ?? ''}</span>
        <div class="button-content">
            <i class="${sound.type === 'roll' ? 'fas fa-drum' : 'fas fa-play'} sound-icon"></i>
            <span class="sound-name">${escapeHtml(sound.name)}</span>
            <div class="time-display">0:00 / ${formatTime(span)}</div>
        </div>
        <div class="button-controls">
            <button class="loop-button fas fa-sync-alt ${sound.loop ? 'active' : ''}" title="ループ切り替え"></button>
            <div class="volume-control">
                <input type="range" min="0" max="${Math.max(2, Math.ceil(sound.volume ?? 1))}" step="0.01" value="${sound.volume ?? 1.0}" title="音量: ${Math.round((sound.volume ?? 1.0) * 100)}%">
            </div>
        </div>
        <div class="progress-bar"><div class="progress-bar-value"></div></div>
        <button class="delete-button" title="削除 (ホストから削除)"><i class="fas fa-times"></i></button>
        <button class="settings-button" title="設定">${settingsContent}</button>
    `;

    // --- 再生 (tap / hold) ---
    if (isHoldTrigger) {
        const inputId = `remote-pointer-${sound.id}`;
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            if (e.target instanceof Element && e.target.closest('.loop-button, .volume-control, .progress-bar, .delete-button, .settings-button')) return;
            e.preventDefault();
            try { el.setPointerCapture?.(e.pointerId); } catch (_) { /* noop */ }
            send({ t: 'tg', id: sound.id, k: 'down', c: inputId });
            const release = () => send({ t: 'tg', id: sound.id, k: 'up', c: inputId });
            el.addEventListener('pointerup', release, { once: true });
            el.addEventListener('pointercancel', release, { once: true });
        });
        el.addEventListener('contextmenu', e => e.preventDefault());
    } else {
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            if (e.target instanceof Element && e.target.closest('.loop-button, .volume-control, .progress-bar, .delete-button, .settings-button')) return;
            e.preventDefault();
            if (triggerMode === 'retrigger') send({ t: 'tg', id: sound.id, k: 'tap', r: 1 });
            else send({ t: 'tg', id: sound.id, k: 'tap' });
        });
    }

    // --- ループ切替 ---
    const loopButton = el.querySelector('.loop-button');
    if (sound.type === 'roll') {
        loopButton.style.display = 'none';
    } else {
        loopButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = !sound.loop;
            sound.loop = next;
            loopButton.classList.toggle('active', next);
            el.classList.toggle('loop-on', next);
            send({ t: 'lp', id: sound.id });
        });
    }

    // --- パッド音量 ---
    const volumeSlider = el.querySelector('input[type="range"]');
    volumeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        const value = parseFloat(e.target.value);
        sound.volume = value;
        e.target.title = `音量: ${Math.round(value * 100)}%`;
        throttleSend(`pv-${sound.id}`, { t: 'pv', id: sound.id, v: value });
    });
    volumeSlider.addEventListener('change', () => {
        send({ t: 'pv', id: sound.id, v: sound.volume, save: 1 });
    });
    volumeSlider.addEventListener('click', e => e.stopPropagation());
    volumeSlider.addEventListener('pointerdown', () => {
        if (!state.isSortableEnabled || state.showMode) return;
        el.draggable = false;
        const restoreDraggable = () => {
            window.removeEventListener('pointerup', restoreDraggable);
            window.removeEventListener('pointercancel', restoreDraggable);
            el.draggable = state.isSortableEnabled && !state.showMode;
        };
        window.addEventListener('pointerup', restoreDraggable);
        window.addEventListener('pointercancel', restoreDraggable);
    });

    // --- シーク ---
    const progressBar = el.querySelector('.progress-bar');
    if (sound.type === 'roll') {
        progressBar.style.display = 'none';
    } else {
        progressBar.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = progressBar.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / progressBar.offsetWidth));
            send({ t: 'sk', id: sound.id, r: ratio });
        });
    }

    // --- 削除 ---
    el.querySelector('.delete-button').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await showConfirm(`サウンド「${sound.name}」をホストから削除しますか？`, '削除確認')) {
            send({ t: 'dl', id: sound.id });
        }
    });

    // --- 設定 ---
    const settingsButton = el.querySelector('.settings-button');
    if (sound.type === 'roll') {
        // ロールのパート音声はホスト側のデータが必要なためリモコンでは編集できない
        settingsButton.style.display = 'none';
    } else {
        settingsButton.addEventListener('click', (e) => {
            e.stopPropagation();
            openSoundSettings(sound.id);
        });
    }

    return el;
}

// showSoundSettingsModal (05_ui.js) をそのまま使い、保存内容をホストへ送る。
// LUFSノーマライズ/無音トリムはホストの音声データ解析が必要なため対象外 (CSSで非表示)。
async function openSoundSettings(soundId) {
    const sound = state.scenes[state.currentSceneId]?.sounds.find(s => s.id === soundId);
    if (!sound) return;
    let currentShortcut = '';
    for (const key in state.shortcuts) {
        if (state.shortcuts[key] === soundId) {
            currentShortcut = key;
            break;
        }
    }
    const s = await showSoundSettingsModal(soundId, currentShortcut, {});
    if (!s) return;
    send({
        t: 'ps',
        id: soundId,
        p: {
            n: s.newName,
            sc: s.newShortcut,
            m: s.newTriggerMode,
            c: s.newColor,
            fi: s.newFadeInDuration,
            fo: s.newFadeOutDuration,
            fie: s.newFadeInEasing,
            foe: s.newFadeOutEasing,
            p: s.newPan,
            rv: s.newReverse,
            sp: s.newPlaybackSpeed,
            pp: s.preservePitch,
            fx: s.newEffects,
        },
    });
    // 保存結果はホストの状態エコーで画面に反映されるためアラートは出さない
}

// --- シーン設定モーダル ---
// populateSceneModalList (07_scenes.js) と同じ見た目のリモート版。
function populateSceneModalList() {
    if (!dom.modalSceneList) return;
    dom.modalSceneList.innerHTML = '';
    const sceneIds = Object.keys(state.scenes);
    const scenesArray = sceneIds.map(id => state.scenes[id]).sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    if (scenesArray.length === 0) {
        dom.modalSceneList.innerHTML = '<li>シーンがありません</li>';
        return;
    }

    scenesArray.forEach(scene => {
        const li = document.createElement('li');
        li.dataset.sceneId = scene.id;
        li.title = `${scene.name} (${scene.sounds.length} サウンド)`;
        if (scene.id === state.currentSceneId) li.classList.add('active');
        li.style.setProperty('--scene-color', scene.color || 'transparent');
        li.innerHTML = `
            <span class="modal-scene-name">${escapeHtml(scene.name)}</span>
            <div class="modal-scene-actions">
                <button title="名前を変更" data-action="rename"><i class="fas fa-pencil-alt"></i></button>
                <button title="色を変更" data-action="color"><i class="fas fa-palette"></i></button>
                <button title="削除" class="danger" data-action="delete" ${sceneIds.length <= 1 ? 'disabled' : ''}><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
        dom.modalSceneList.appendChild(li);
    });
}

function handleSceneListClick(event) {
    const listItem = event.target.closest('li[data-scene-id]');
    if (!listItem) return;
    const sceneId = listItem.dataset.sceneId;
    const actionButton = event.target.closest('button[data-action]');
    if (actionButton) {
        event.stopPropagation();
        const action = actionButton.dataset.action;
        if (action === 'rename') {
            const scene = state.scenes[sceneId];
            showPrompt(`「${scene?.name}」の新しい名前:`, 'シーン名変更', scene?.name ?? '').then(name => {
                if (name && name.trim()) send({ t: 'sc-ren', id: sceneId, n: name.trim() });
            });
        } else if (action === 'color') {
            pickColor(state.scenes[sceneId]?.color).then(color => {
                if (color !== null) send({ t: 'sc-col', id: sceneId, c: color });
            });
        } else if (action === 'delete') {
            const scene = state.scenes[sceneId];
            showConfirm(`シーン「${scene?.name}」をホストから削除しますか？この操作は取り消せません。`, 'シーンの削除')
                .then(ok => { if (ok) send({ t: 'sc-del', id: sceneId }); });
        }
    } else {
        if (sceneId !== state.currentSceneId) send({ t: 'sc', id: sceneId });
        closeSceneSettingsModal();
    }
}

// ホストと同じ隠し color input を使った色選択。キャンセル時は null。
function pickColor(current) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = current || '#808080';
        input.style.position = 'absolute';
        input.style.opacity = '0';
        input.style.width = '0';
        input.style.height = '0';
        document.body.appendChild(input);
        const cleanup = () => { input.remove(); };
        input.addEventListener('change', () => {
            cleanup();
            resolve(input.value);
        });
        input.addEventListener('blur', () => {
            cleanup();
            resolve(null);
        }, { once: true });
        input.click();
    });
}

function openSceneSettingsModal() {
    if (!dom.sceneSettingsModal) return;
    populateSceneModalList();
    if (dom.interactionClickRadio) dom.interactionClickRadio.checked = !state.isSortableEnabled;
    if (dom.interactionDragRadio) dom.interactionDragRadio.checked = state.isSortableEnabled;
    if (dom.padSizeSlider) dom.padSizeSlider.value = state.padSize;
    if (dom.padSizeValue) dom.padSizeValue.textContent = state.padSize;
    if (dom.keyboardLayoutSelect) dom.keyboardLayoutSelect.value = state.keyboardLayout;
    dom.sceneSettingsModal.classList.add('active');
}

function closeSceneSettingsModal() {
    dom.sceneSettingsModal?.classList.remove('active');
}

// --- ドラッグ並べ替え (メインの handleDrag* と同じ挙動。確定時にホストへ送信) ---
function handleDragStart(event) {
    if (!state.isSortableEnabled || state.showMode) { event.preventDefault(); return; }
    const target = event.target.closest('.sound-button');
    if (target?.draggable) {
        updateState({ draggedElement: target, draggedSoundId: target.dataset.id });
        event.dataTransfer.setData('text/plain', target.dataset.id);
        event.dataTransfer.effectAllowed = 'move';
        setTimeout(() => target.classList.add('dragging'), 0);
    }
}

function handleDragOver(event) {
    if (!state.isSortableEnabled || !state.draggedElement) return;
    event.preventDefault();
    const targetElement = event.target.closest('.sound-button');
    if (targetElement && targetElement !== state.draggedElement) {
        clearDragOverStyles();
        targetElement.classList.add('drag-over');
    }
}

function handleDragLeave(event) {
    if (!event.relatedTarget || !dom.soundboard.contains(event.relatedTarget)) {
        clearDragOverStyles();
    }
}

function handleDrop(event) {
    if (!state.isSortableEnabled || !state.draggedElement) return;
    event.preventDefault();
    const dropTarget = event.target.closest('.sound-button');
    if (dropTarget && dropTarget !== state.draggedElement) {
        const sounds = state.scenes[state.currentSceneId]?.sounds ?? [];
        const toIndex = sounds.findIndex(s => s.id === dropTarget.dataset.id);
        if (toIndex !== -1) {
            // ホスト側でメインと同じ splice(from → to) を行う
            send({ t: 'sr', id: state.draggedSoundId, to: toIndex });
        }
    }
    clearDragStyles();
    updateState({ draggedElement: null, draggedSoundId: null });
}

function handleDragEnd() {
    clearDragStyles();
    updateState({ draggedElement: null, draggedSoundId: null });
}

// --- キーボードビュー (メインと同じビュー。キー操作はホストへ送信) ---
function updateKeyboardViewVisibility() {
    if (!dom.keyboardView || !dom.keyboardViewBtn) return;
    dom.keyboardView.hidden = !state.keyboardViewVisible;
    dom.keyboardViewBtn.classList.toggle('active', state.keyboardViewVisible);
    dom.keyboardViewBtn.setAttribute('aria-pressed', String(state.keyboardViewVisible));
    if (state.keyboardViewVisible) renderKeyboardView();
}

function shortcutHoldTarget(shortcut) {
    const soundId = state.shortcuts[shortcut];
    const sound = state.scenes[state.currentSceneId]?.sounds.find(item => item.id === soundId);
    if (!sound) return null;
    const mode = TRIGGER_MODES.includes(sound.triggerMode) ? sound.triggerMode : 'toggle';
    return { soundId, hold: sound.type === 'roll' || HOLD_TRIGGER_MODES.includes(mode) };
}

function handleVirtualKeyDown(event) {
    const key = event.target.closest('button[data-shortcut]');
    if (!key || key.disabled || event.button !== 0) return;
    event.preventDefault();
    try { key.setPointerCapture?.(event.pointerId); } catch (_) { /* noop */ }
    setKeyboardKeyPressed(key.dataset.shortcut, true);
    const target = shortcutHoldTarget(key.dataset.shortcut);
    if (!target) return;
    send({ t: 'tg', id: target.soundId, k: target.hold ? 'down' : 'tap', c: `virtual:${event.pointerId}` });
}

function handleVirtualKeyUp(event) {
    const key = event.target.closest('button[data-shortcut]')
        || dom.keyboardView?.querySelector(`button[data-shortcut].is-pressed`);
    if (!key) return;
    setKeyboardKeyPressed(key.dataset.shortcut, false);
    const target = shortcutHoldTarget(key.dataset.shortcut);
    if (!target?.hold) return;
    send({ t: 'tg', id: target.soundId, k: 'up', c: `virtual:${event.pointerId}` });
}

// --- 本番モード (メインと同じくローカルの表示切替) ---
function toggleShowMode() {
    if (!state.showMode) {
        try {
            const el = document.documentElement;
            if (el.requestFullscreen) el.requestFullscreen();
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        } catch (_) { /* fullscreen request may fail silently */ }
        document.body.classList.add('show-mode');
        updateState({ showMode: true });
    } else {
        try {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (_) { /* noop */ }
        document.body.classList.remove('show-mode');
        updateState({ showMode: false });
    }
    updateDraggableState();
}

function handleFullscreenChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        document.body.classList.remove('show-mode');
        updateState({ showMode: false });
        updateDraggableState();
    }
}

// --- ステータス表示 ---
function statusLabel() {
    switch (ctrl.link?.status) {
        case 'open': return '接続';
        case 'connecting': return '接続中…';
        case 'reconnecting': return '再接続中…';
        case 'error': return '切断';
        default: return '未接続';
    }
}

function setThemeStatusClass(el, status) {
    if (!el) return;
    el.classList.remove('is-open', 'is-busy', 'is-error', 'is-off');
    if (status === 'open') el.classList.add('is-open');
    else if (status === 'connecting' || status === 'reconnecting') el.classList.add('is-busy');
    else if (status === 'error') el.classList.add('is-error');
    else el.classList.add('is-off');
}

function updateStatusUI() {
    const status = ctrl.link?.status ?? 'off';
    const label = statusLabel();
    const meta = [];
    if (ctrl.link?.rtt !== null && ctrl.link?.rtt !== undefined) meta.push(`${ctrl.link.rtt}ms`);
    if ((ctrl.link?.clients ?? 0) > 0) meta.push(`${ctrl.link.clients}台`);
    if (dom.remoteStatusText) dom.remoteStatusText.textContent = label;
    if (dom.remoteMeta) dom.remoteMeta.textContent = meta.join(' / ');
    setThemeStatusClass(dom.remoteBtn, status);
    setThemeStatusClass(document.querySelector('#remote-btn .remote-dot'), status);
    setThemeStatusClass(document.querySelector('#remote-overlay .remote-dot'), status);
    setThemeStatusClass(document.querySelector('#remote-connect-overlay .remote-dot'), status);
    const connectStatus = document.getElementById('remote-connect-status');
    if (connectStatus) connectStatus.textContent = label;
    const roomPanelStatus = document.getElementById('remote-room-status');
    if (roomPanelStatus) {
        roomPanelStatus.textContent = `${label}${meta.length ? ` / ${meta.join(' / ')}` : ''}`;
    }
}

// --- 接続オーバーレイ / ルームパネル ---
function showConnectOverlay(show) {
    const overlay = document.getElementById('remote-connect-overlay');
    if (overlay) overlay.hidden = !show;
    if (show) {
        const input = document.getElementById('remote-room-input');
        if (input) input.value = ctrl.room;
    }
}

function renderRoomPanel() {
    const body = dom.remoteBody;
    if (!body) return;
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'remote-host';

    const label = document.createElement('p');
    label.className = 'remote-hint';
    label.textContent = 'この端末はコントローラーです。';

    const roomCard = document.createElement('div');
    roomCard.className = 'remote-room-card';
    const roomId = document.createElement('span');
    roomId.className = 'remote-room-id';
    roomId.textContent = ctrl.room || '—';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'remote-btn-secondary';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> コピー';
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(ctrl.room);
            copyBtn.innerHTML = '<i class="fas fa-check"></i> コピーしました';
        } catch (_) {
            copyBtn.innerHTML = '<i class="fas fa-xmark"></i> 失敗';
        }
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i> コピー'; }, 1200);
    });
    roomCard.append(roomId, copyBtn);

    const status = document.createElement('p');
    status.className = 'remote-hint';
    status.id = 'remote-room-status';

    const changeBtn = document.createElement('button');
    changeBtn.className = 'remote-btn-danger';
    changeBtn.innerHTML = '<i class="fas fa-rotate"></i> ルームを変更';
    changeBtn.addEventListener('click', () => {
        disconnect();
        if (dom.remoteOverlay) dom.remoteOverlay.hidden = true;
    });

    wrap.append(label, roomCard, status, changeBtn);
    body.appendChild(wrap);
    updateStatusUI();
}

// --- イベント接続 ---
function setupEventListeners() {
    // ヘッダー操作
    dom.stopAllBtn?.addEventListener('click', () => send({ t: 'sa' }));
    dom.pauseAllBtn?.addEventListener('click', () => send({ t: 'pa' }));
    dom.recordBtn?.addEventListener('click', () => send({ t: 'rec' }));
    dom.showModeBtn?.addEventListener('click', toggleShowMode);
    dom.keyboardViewBtn?.addEventListener('click', () => {
        updateState({ keyboardViewVisible: !state.keyboardViewVisible });
        storeLocalUi();
        updateKeyboardViewVisibility();
    });
    dom.keyboardView?.addEventListener('pointerdown', handleVirtualKeyDown);
    dom.keyboardView?.addEventListener('pointerup', handleVirtualKeyUp);
    dom.keyboardView?.addEventListener('pointercancel', handleVirtualKeyUp);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    // カスタムモーダル (OK/Cancel は 05_ui 側で onclick を差し替える)。オーバーレイクリックで閉じる
    dom.customModalOverlay?.addEventListener('click', (e) => {
        if (e.target !== dom.customModalOverlay) return;
        hideModal();
    });

    // シーン設定モーダル
    dom.sceneSettingsBtn?.addEventListener('click', openSceneSettingsModal);
    dom.modalCloseBtn?.addEventListener('click', closeSceneSettingsModal);
    dom.modalSceneList?.addEventListener('click', handleSceneListClick);
    dom.modalAddSceneBtn?.addEventListener('click', () => {
        showPrompt('新しいシーンの名前:', '新しいシーン', `Scene ${Object.keys(state.scenes).length + 1}`).then(name => {
            if (name && name.trim()) send({ t: 'sc-add', n: name.trim() });
        });
    });

    // ローカル設定 (リモコン自身の見た目)
    dom.darkModeToggle?.addEventListener('change', () => {
        const pref = toggleDarkMode();
        try { localStorage.setItem('darkModePref', pref); } catch (_) { /* noop */ }
    });
    dom.interactionClickRadio?.addEventListener('change', () => {
        updateState({ isSortableEnabled: false });
        storeLocalUi();
        updateDraggableState();
    });
    dom.interactionDragRadio?.addEventListener('change', () => {
        updateState({ isSortableEnabled: true });
        storeLocalUi();
        updateDraggableState();
    });
    dom.padSizeSlider?.addEventListener('input', (e) => {
        const size = parseInt(e.target.value, 10);
        updateState({ padSize: size });
        if (dom.padSizeValue) dom.padSizeValue.textContent = String(size);
        updatePadSizeCSS(size);
        storeLocalUi();
    });
    if (dom.keyboardLayoutSelect) {
        dom.keyboardLayoutSelect.replaceChildren();
        for (const { id, label } of getLayoutOptions()) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = label;
            dom.keyboardLayoutSelect.appendChild(option);
        }
        dom.keyboardLayoutSelect.addEventListener('change', (e) => {
            updateState({ keyboardLayout: e.target.value });
            storeLocalUi();
            if (state.keyboardViewVisible) renderKeyboardView();
        });
    }

    // ドラッグ並べ替え
    dom.soundboard?.addEventListener('dragstart', handleDragStart);
    dom.soundboard?.addEventListener('dragover', handleDragOver);
    dom.soundboard?.addEventListener('dragleave', handleDragLeave);
    dom.soundboard?.addEventListener('drop', handleDrop);
    dom.soundboard?.addEventListener('dragend', handleDragEnd);

    // ルーム接続
    document.getElementById('remote-connect-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('remote-room-input');
        const room = normalizeRoomId(input?.value);
        if (!room) {
            input?.focus();
            return;
        }
        connectRoom(room);
    });
    dom.remoteBtn?.addEventListener('click', () => {
        if (!ctrl.link) {
            showConnectOverlay(true);
            return;
        }
        if (dom.remoteOverlay) {
            if (dom.remoteOverlay.hidden) {
                renderRoomPanel();
                dom.remoteOverlay.hidden = false;
            } else {
                dom.remoteOverlay.hidden = true;
            }
        }
    });
    dom.remoteCloseBtn?.addEventListener('click', () => {
        if (dom.remoteOverlay) dom.remoteOverlay.hidden = true;
    });

    // Esc で全停止 (メインと同じ)。モーダルやオーバーレイが開いている時はそちらを優先
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (dom.sceneSettingsModal?.classList.contains('active')) {
            closeSceneSettingsModal();
            return;
        }
        if (dom.customModalOverlay?.classList.contains('active')) return; // カスタムモーダル優先 (メインと同じ)
        if (dom.remoteOverlay && !dom.remoteOverlay.hidden) {
            dom.remoteOverlay.hidden = true;
            return;
        }
        send({ t: 'sa' });
    });

    // knob / スライダー操作中は再描画を遅らせる
    watchInteractions();
}

// --- 初期化 ---
const localUi = loadLocalUi();
updateState({
    padSize: localUi.padSize,
    isSortableEnabled: localUi.isSortableEnabled,
    keyboardLayout: localUi.keyboardLayout,
    keyboardViewVisible: localUi.keyboardViewVisible,
    scenes: {},
    currentSceneId: null,
    shortcuts: {},
    masterVolume: 1,
    masterEq: { low: 0, mid: 0, high: 0 },
    masterComp: { threshold: 0, ratio: 1 },
    masterDelay: { time: 0.18, feedback: 0, level: 0 },
    masterPan: { value: 0 },
    masterDistortion: { amount: 0 },
    masterReverb: { decay: 2.0, wet: 0, preDelay: 0.01 },
    masterLimiter: { threshold: -1 },
});

initDom();
initDarkMode();
updatePadSizeCSS(state.padSize);
setupEventListeners();
updateKeyboardViewVisibility();
renderSoundboardWaiting();

ctrl.room = loadStoredRoom();
if (ctrl.room) connectRoom(ctrl.room);
else showConnectOverlay(true);

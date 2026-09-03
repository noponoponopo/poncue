// modules/12_remote.js - リモート操作 (ホスト側)
//
// この端末で音を出しながら、/remote/ のリモコンからの操作を受け付ける。
// - コマンド (パッド再生・シーン切替・全停止・音量・エフェクト調整・シーン/サウンド管理) を
//   ローカル再生パイプラインで実行する
// - 「構造」(シーン/パッド設定/マスターエフェクト) と「活動」(再生状態) を
//   別メッセージでポーリング差分ブロードキャストする
// コントローラー側は remote/index.html (/remote/) の remote_controller.js を使う。

import { state, updateState } from './03_state.js';
import { dom } from './02_dom.js';
import {
    TRIGGER_MODES, HOLD_TRIGGER_MODES,
    REMOTE_STATE_POLL_MS, REMOTE_MAX_PADS, REMOTE_MAX_SCENES,
    REMOTE_SETTINGS_KEY, REMOTE_ROOM_CHARS, REMOTE_ROOM_LENGTH,
    SCENES_STORE_NAME, AUDIO_FILES_STORE_NAME
} from './01_config.js';
import {
    selectScene, saveSetting, saveCurrentSceneSounds, markSceneDeleted,
    populateSceneModalList, generateUniqueId, removeSound, renderers
} from './07_scenes.js';
import { dbRequest } from './04_db.js';
import {
    stopAllSounds, stopSound, seekSound, togglePauseAllSounds,
    updateActiveSoundLoop, updateActiveSoundPan, updateActiveSoundEffects,
    updateActiveSoundSpeed, setMasterParam, setMasterLimiterThreshold
} from './06_audio.js';
import { updateMasterVolumeKnob, escapeHtml } from './05_ui.js';
import { getMasterRecordingStatus } from './11_recording.js';
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
    lastStructureJson: '',
    lastActivityJson: '',
    saveTimer: null,
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

function currentScene() {
    return state.scenes[state.currentSceneId] ?? null;
}

function findSound(soundId) {
    return currentScene()?.sounds.find(s => s.id === soundId) ?? null;
}

function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function debouncedSaveCurrentSceneSounds() {
    clearTimeout(remote.saveTimer);
    remote.saveTimer = setTimeout(() => saveCurrentSceneSounds('remoteChange'), 300);
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
        onOpen: () => sendStructure(true),
        onJoin: () => sendStructure(true),
        onMessage: (msg) => {
            if (msg.t === 'sy') sendStructure(true);
            else handleCommand(msg);
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
            const sound = findSound(soundId);
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
        case 'pv': // パッド音量
            applySoundVolume(String(msg.id ?? ''), Number(msg.v), Boolean(msg.save));
            return;
        case 'lp': { // ループ切替
            const sound = findSound(String(msg.id ?? ''));
            if (!sound || sound.type === 'roll') return;
            sound.loop = !sound.loop;
            updateActiveSoundLoop(sound.id, sound.loop);
            debouncedSaveCurrentSceneSounds();
            return;
        }
        case 'sk': { // シーク (r = トリム区間内の比率 0..1)
            const sound = findSound(String(msg.id ?? ''));
            if (!sound || sound.type === 'roll') return;
            const duration = Number(sound.duration);
            if (!Number.isFinite(duration) || duration <= 0) return;
            const trimStart = Number.isFinite(sound.trimStart) ? sound.trimStart : 0;
            const trimEnd = Number.isFinite(sound.trimEnd) ? sound.trimEnd : duration;
            const span = trimEnd - trimStart;
            if (!(span > 0)) return;
            seekSound(sound.id, trimStart + span * clamp(msg.r, 0, 1));
            return;
        }
        case 'ps': // サウンド設定のまとめ適用 (設定モーダルの保存)
            applySoundSettings(String(msg.id ?? ''), msg.p ?? {});
            return;
        case 'dl': // サウンド削除
            removeRemoteSound(String(msg.id ?? ''));
            return;
        case 'sr': // 並べ替え (to = 移動先インデックス)
            reorderSound(String(msg.id ?? ''), Number(msg.to));
            return;
        case 'mx': // マスターエフェクト (k = setMasterParam と同じドットキー)
            applyMasterParam(String(msg.k ?? ''), msg.v, Boolean(msg.save));
            return;
        case 'sc-add': // シーン追加
            addRemoteScene(String(msg.n ?? ''));
            return;
        case 'sc-ren': // シーン名変更
            renameRemoteScene(String(msg.id ?? ''), String(msg.n ?? ''));
            return;
        case 'sc-del': // シーン削除
            deleteRemoteScene(String(msg.id ?? ''));
            return;
        case 'sc-col': // シーン色変更
            colorRemoteScene(String(msg.id ?? ''), msg.c);
            return;
        case 'rec': // 録音切替 (本体の録音ボタンと同じ経路で動かす)
            dom.recordBtn?.click();
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

function applyMasterParam(dottedKey, value, save) {
    if (dottedKey === 'limiter.threshold') {
        setMasterLimiterThreshold(clamp(value, -12, 0));
        if (save) saveSetting('masterLimiter', state.masterLimiter);
        return;
    }
    setMasterParam(dottedKey, value);
    if (save) {
        const [group] = dottedKey.split('.');
        if (!group) return;
        const stateKey = `master${group[0].toUpperCase()}${group.slice(1)}`;
        if (state[stateKey]) saveSetting(stateKey, state[stateKey]);
    }
}

function applySoundVolume(soundId, value, save) {
    const sound = findSound(soundId);
    if (!sound || !Number.isFinite(value)) return;
    const vol = Math.min(2, Math.max(0, value));
    sound.volume = vol;
    const activeAudio = state.activeAudios[soundId];
    if (activeAudio?.individualGain && !activeAudio.isFadingOut && !activeAudio.muted && state.audioContext) {
        activeAudio.individualGain.gain.setTargetAtTime(vol, state.audioContext.currentTime, 0.01);
    }
    if (save) saveCurrentSceneSounds(`remoteVolume-${soundId}`);
    else debouncedSaveCurrentSceneSounds();
}

// 設定モーダルの保存内容をローカルのサウンドへ反映する (handleSoundSettings と同じ項目)。
function applySoundSettings(soundId, patch) {
    const sound = findSound(soundId);
    if (!sound) return;

    if (typeof patch.n === 'string' && patch.n) sound.name = patch.n;

    // ショートカット (ホスト側キーボードへの割当)
    let currentShortcut = '';
    for (const key in state.shortcuts) {
        if (state.shortcuts[key] === soundId) {
            currentShortcut = key;
            break;
        }
    }
    const newShortcut = typeof patch.sc === 'string' ? patch.sc : currentShortcut;
    if (currentShortcut && state.shortcuts[currentShortcut] === soundId) {
        delete state.shortcuts[currentShortcut];
    }
    if (newShortcut) state.shortcuts[newShortcut] = soundId;

    if (TRIGGER_MODES.includes(patch.m)) sound.triggerMode = patch.m;
    delete sound.holdToPlay;

    if (patch.c === null) delete sound.color;
    else if (typeof patch.c === 'string' && patch.c) sound.color = patch.c;

    if (Number.isFinite(patch.fi)) sound.fadeInDuration = patch.fi;
    if (Number.isFinite(patch.fo)) sound.fadeOutDuration = patch.fo;
    if (typeof patch.fie === 'string') sound.fadeInEasing = patch.fie;
    if (typeof patch.foe === 'string') sound.fadeOutEasing = patch.foe;
    if ('fadeDuration' in sound) delete sound.fadeDuration;

    if (patch.rv !== undefined && sound.reverse !== !!patch.rv) {
        sound.reverse = !!patch.rv;
        if (state.reversedAudioBuffers) delete state.reversedAudioBuffers[soundId];
    }
    if (Number.isFinite(patch.sp)) sound.playbackRate = clamp(patch.sp, 0.25, 4);
    if (patch.pp !== undefined) sound.preservePitch = !!patch.pp;
    if (patch.fx && typeof patch.fx === 'object') sound.effects = patch.fx;
    if (Number.isFinite(patch.p)) {
        sound.pan = clamp(patch.p, -1, 1);
        updateActiveSoundPan(soundId);
    }
    updateActiveSoundSpeed(soundId);
    updateActiveSoundEffects(soundId);
    saveCurrentSceneSounds(`remoteSoundSettings-${soundId}`);
    renderers.renderSoundboard();
}

function removeRemoteSound(soundId) {
    const sound = findSound(soundId);
    if (!sound) return;
    stopSound(soundId, findPadElement(soundId), false);
    // removeSound は削除・DB保存・再描画まで行う
    removeSound(soundId);
}

function reorderSound(soundId, toIndex) {
    const scene = currentScene();
    const fromIndex = scene?.sounds.findIndex(s => s.id === soundId) ?? -1;
    if (!scene || fromIndex === -1 || !Number.isFinite(toIndex)) return;
    const to = clamp(toIndex, 0, scene.sounds.length - 1);
    const [moved] = scene.sounds.splice(fromIndex, 1);
    scene.sounds.splice(to, 0, moved);
    saveCurrentSceneSounds(`remoteReorder-${soundId}`);
    renderers.renderSoundboard();
}

function addRemoteScene(name) {
    const sceneName = name.trim();
    if (!sceneName) return;
    const newSceneId = generateUniqueId('scn');
    state.scenes[newSceneId] = { id: newSceneId, name: sceneName, color: null, sounds: [], shortcuts: {} };
    dbRequest(SCENES_STORE_NAME, 'readwrite', 'put', state.scenes[newSceneId]).catch(() => { /* 保存失敗時もUIは維持 */ });
    populateSceneModalList();
    selectScene(newSceneId);
}

function renameRemoteScene(sceneId, newName) {
    const scene = state.scenes[sceneId];
    const name = String(newName ?? '').trim();
    if (!scene || !name || name === scene.name) return;
    scene.name = name;
    saveCurrentSceneSounds('remoteRename', sceneId);
    populateSceneModalList();
    if (sceneId === state.currentSceneId) updateHeaderTitle();
}

function deleteRemoteScene(sceneId) {
    if (Object.keys(state.scenes).length <= 1 || !state.scenes[sceneId]) return;
    const scene = state.scenes[sceneId];
    const audioIdsToDelete = new Set();
    for (const sound of [...scene.sounds]) {
        if (sound.audioId) audioIdsToDelete.add(sound.audioId);
        const parts = sound.rollParts || {};
        for (const audioId of [parts.intro, parts.end, parts.finish, ...(parts.loops || [])]) {
            if (audioId) audioIdsToDelete.add(audioId);
        }
    }
    markSceneDeleted(sceneId);
    delete state.scenes[sceneId];
    dbRequest(SCENES_STORE_NAME, 'readwrite', 'delete', sceneId).catch(() => { /* noop */ });
    for (const audioId of audioIdsToDelete) {
        dbRequest(AUDIO_FILES_STORE_NAME, 'readwrite', 'delete', audioId).catch(() => { /* noop */ });
    }
    populateSceneModalList();
    if (sceneId === state.currentSceneId) {
        selectScene(Object.keys(state.scenes)[0] || null);
    }
}

function colorRemoteScene(sceneId, color) {
    const scene = state.scenes[sceneId];
    if (!scene) return;
    if (typeof color === 'string' && color) scene.color = color;
    else delete scene.color;
    saveCurrentSceneSounds(`remoteSceneColor-${sceneId}`, sceneId);
    populateSceneModalList();
    if (sceneId === state.currentSceneId) updateHeaderTitle();
}

function updateHeaderTitle() {
    const scene = currentScene();
    // リモコンから設定される値のため、色はhexのみ、名前はエスケープして挿入する
    const safeColor = (typeof scene?.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(scene.color)) ? scene.color : '';
    const iconStyle = safeColor ? ` style="color: ${safeColor};"` : '';
    const h1 = document.querySelector('header h1');
    if (h1) h1.innerHTML = `<i class="fas fa-headphones-alt"${iconStyle}></i> ${escapeHtml(scene?.name || 'シーンなし')}`;
}

// --- ホスト: 状態配信 ---
// パッドの設定系フィールド。既定値は省略してメッセージを小さく保つ。
function padFields(s, shortcut) {
    const pad = {
        i: s.id,
        n: String(s.name ?? ''),
        m: TRIGGER_MODES.includes(s.triggerMode) ? s.triggerMode : 'toggle',
        h: isHoldTriggerSound(s) ? 1 : undefined,
        lp: s.loop ? 1 : undefined,
        k: shortcut || undefined,
        c: s.color || undefined,
    };
    if (s.type === 'roll') pad.ty = 1;
    if (Number.isFinite(s.volume) && s.volume !== 1) pad.v = Math.round(s.volume * 100) / 100;
    if (Number.isFinite(s.fadeInDuration) && s.fadeInDuration > 0) pad.fi = Math.round(s.fadeInDuration * 100) / 100;
    if (Number.isFinite(s.fadeOutDuration) && s.fadeOutDuration > 0) pad.fo = Math.round(s.fadeOutDuration * 100) / 100;
    if (s.fadeInEasing && s.fadeInEasing !== 'linear') pad.fie = s.fadeInEasing;
    if (s.fadeOutEasing && s.fadeOutEasing !== 'linear') pad.foe = s.fadeOutEasing;
    if (Number.isFinite(s.pan) && s.pan !== 0) pad.p = Math.round(s.pan * 100) / 100;
    if (Number.isFinite(s.playbackRate) && s.playbackRate !== 1) pad.sp = Math.round(s.playbackRate * 100) / 100;
    if (s.preservePitch) pad.pp = 1;
    if (s.reverse) pad.rv = 1;
    if (Number.isFinite(s.duration)) pad.d = Math.round(s.duration * 100) / 100;
    if (Number.isFinite(s.trimStart)) pad.ts = Math.round(s.trimStart * 100) / 100;
    if (Number.isFinite(s.trimEnd)) pad.te = Math.round(s.trimEnd * 100) / 100;
    if (s.effects && (s.effects.enabled || s.effects.eq?.enabled || s.effects.delay?.enabled
        || s.effects.compressor?.enabled || s.effects.distortion?.enabled
        || s.effects.reverb?.enabled || s.effects.limiter?.enabled)) pad.fx = s.effects;
    if (s.error) pad.e = 1;
    return pad;
}

function collectStructure() {
    const scene = currentScene();
    const shortcutByPad = {};
    for (const [key, sid] of Object.entries(state.shortcuts ?? {})) shortcutByPad[sid] = key;

    const pd = (scene?.sounds ?? []).slice(0, REMOTE_MAX_PADS).map(s => padFields(s, shortcutByPad[s.id]));

    return {
        t: 'st', v: 2,
        cs: state.currentSceneId,
        sc: Object.entries(state.scenes).slice(0, REMOTE_MAX_SCENES)
            .map(([id, s]) => ({ i: id, n: String(s?.name ?? ''), c: s?.color || undefined, ct: (s?.sounds?.length ?? 0) })),
        pd,
        // マスター効果。e=EQ dB x3, c=COMP [threshold,ratio], d=DELAY [time,feedback,level],
        // p=PAN, s=DIST amount, r=REVERB [decay,wet], l=リミッター閾値
        fx: {
            e: [state.masterEq?.low ?? 0, state.masterEq?.mid ?? 0, state.masterEq?.high ?? 0],
            c: [state.masterComp?.threshold ?? 0, state.masterComp?.ratio ?? 1],
            d: [state.masterDelay?.time ?? 0.18, state.masterDelay?.feedback ?? 0, state.masterDelay?.level ?? 0],
            p: state.masterPan?.value ?? 0,
            s: state.masterDistortion?.amount ?? 0,
            r: [state.masterReverb?.decay ?? 2.0, state.masterReverb?.wet ?? 0],
            l: state.masterLimiter?.threshold ?? -1,
        },
        mv: Math.round((state.masterVolume ?? 1) * 100) / 100,
        rc: getMasterRecordingStatus().isRecording ? 1 : undefined,
    };
}

function sendStructure(force = false) {
    if (!remote.link) return;
    const msg = collectStructure();
    const json = JSON.stringify(msg);
    if (!force && json === remote.lastStructureJson) return;
    remote.lastStructureJson = json;
    remote.link.send(msg);
}

// 進捗% (メイン基板のプログレスバーと同じ計算)。リモコンのバー表示に使う
function collectActivity() {
    const scene = currentScene();
    const trimById = new Map();
    for (const s of scene?.sounds ?? []) {
        trimById.set(s.id, {
            trimStart: Number.isFinite(s.trimStart) ? s.trimStart : 0,
            trimEnd: Number.isFinite(s.trimEnd) ? s.trimEnd : s.duration,
            loop: Boolean(s.loop),
        });
    }
    const progressPercentFor = (soundId, position) => {
        const b = trimById.get(soundId);
        if (!b || !Number.isFinite(position)) return undefined;
        const duration = b.trimEnd - b.trimStart;
        if (!(duration > 0)) return undefined;
        const elapsed = position - b.trimStart;
        const current = b.loop
            ? ((elapsed % duration) + duration) % duration
            : Math.min(duration, Math.max(0, elapsed));
        return Math.min(100, Math.max(0, (current / duration) * 100));
    };

    const ac = {};
    for (const [id, audio] of Object.entries(state.activeAudios)) {
        if (audio?.isFadingOut) continue;
        // sustain レイヤーを含む総ボイス数 (updateSustainLayerBadge と同じ数え方)
        const voices = (state.sustainLayers[id]?.length ?? 0) + 1;
        ac[id] = { u: audio?.muted ? 1 : 0, l: voices > 1 ? voices : 0 };
        const progress = Math.round(Number.isFinite(audio?.progressPercent)
            ? audio.progressPercent
            : (progressPercentFor(id, audio?.playbackPosition) ?? 0));
        if (progress > 0) ac[id].g = progress;
    }
    for (const [id, paused] of Object.entries(state.pausedSounds)) {
        if (!ac[id]) ac[id] = { p: 1 };
        const progress = Math.round(progressPercentFor(id, paused?.position) ?? 0);
        if (progress > 0) ac[id].g = progress;
    }

    const entries = Object.values(ac);
    const hasActive = entries.some(info => !info.p);
    // pa: 一時停止ボタンの状態。1=全再開に切り替わる, 0=一時停止可, 省略=無効
    const pa = entries.length === 0 ? undefined : (hasActive ? 0 : 1);

    return { t: 'ac', ac, pa };
}

function sendActivity(force = false) {
    if (!remote.link) return;
    const msg = collectActivity();
    const json = JSON.stringify(msg);
    if (!force && json === remote.lastActivityJson) return;
    remote.lastActivityJson = json;
    remote.link.send(msg);
}

function startHostPoll() {
    stopHostPoll();
    remote.lastStructureJson = '';
    remote.lastActivityJson = '';
    remote.pollTimer = setInterval(() => {
        sendStructure(false);
        sendActivity(false);
    }, REMOTE_STATE_POLL_MS);
}

function stopHostPoll() {
    clearInterval(remote.pollTimer);
    remote.pollTimer = null;
    remote.lastStructureJson = '';
    remote.lastActivityJson = '';
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

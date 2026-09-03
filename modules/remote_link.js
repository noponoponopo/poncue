// modules/remote_link.js - リモート操作の共有接続層 (ホスト/コントローラー両方から使う)
//
// cfws (ws.nopo.dev) の透過中継ルームへの WebSocket 接続を担う。
// - 心跳 (5s) で RTT 計測と接続保持を兼ね、無応答なら自ら切って再接続する
// - 再接続は指数バックオフ + ジッター
// - sys (join/leave) と he (role 宣言) を内部で処理し、他のメッセージを onMessage へ流す

import {
    REMOTE_WS_BASE, REMOTE_SERVICE,
    REMOTE_HEARTBEAT_MS, REMOTE_DEAD_AFTER_MS,
    REMOTE_BACKOFF_BASE_MS, REMOTE_BACKOFF_MAX_MS
} from './01_config.js';

export function randomId(length, chars) {
    const buf = new Uint32Array(length);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
    return out;
}

/**
 * リンクを作成する。
 * @param {object} opts
 * @param {'host'|'controller'} opts.role
 * @param {string} opts.room ルームID (正規化済み)
 * @param {(msg: object) => void} [opts.onMessage] アプリプロトコル (pi/po/sys 以外)
 * @param {() => void} [opts.onOpen] 接続が確立した (hello 送信済み)
 * @param {() => void} [opts.onJoin] 誰かがルームに入室した
 * @param {(snap: {status:string, rtt:number|null, clients:number, conflict:boolean}) => void} [opts.onStatus]
 */

/** close() 済みのリンクを外すためのレジストリ。グローバルリスナーはページ単位で一度だけ登録する */
const activeLinks = new Set();
export function createRemoteLink({ role, room, onMessage, onOpen, onJoin, onStatus }) {
    const state = {
        ws: null,
        status: 'off',      // 'off' | 'connecting' | 'open' | 'reconnecting' | 'error'
        attempt: 0,
        intentionalClose: false,
        rtt: null,
        clients: 0,
        conflict: false,    // 別ホスト検知 (role==='host' のときのみ意味を持つ)
        lastPongAt: 0,
        heartbeatTimer: null,
        reconnectTimer: null,
        closed: false,      // close() 後の再接続を完全に止める
    };

    function notify() {
        onStatus?.({ status: state.status, rtt: state.rtt, clients: state.clients, conflict: state.conflict });
    }

    function setStatus(status) {
        state.status = status;
        notify();
    }

    function send(obj) {
        const ws = state.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(obj));
            return true;
        } catch (err) {
            console.warn('[remote] 送信失敗', err);
            return false;
        }
    }

    function handleMessage(evt) {
        let msg;
        try {
            msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
        } catch (_) {
            return; // JSON以外 (他クライアントのバイナリ等) は無視
        }
        if (!msg || typeof msg !== 'object') return;

        // cfws の join/leave 通知は {sys,cid,clients} で t フィールドを持たない
        if (typeof msg.sys === 'string') {
            if (Number.isFinite(msg.clients)) state.clients = msg.clients;
            if (msg.sys === 'join') onJoin?.();
            notify();
            return;
        }

        switch (msg.t) {
            case 'pi': // 心跳 → 対向がRTT計測できるよう全員が応答する
                send({ t: 'po', ts: msg.ts });
                return;
            case 'po': {
                const ts = Number(msg.ts);
                if (Number.isFinite(ts)) {
                    state.rtt = Math.max(0, Date.now() - ts);
                    state.lastPongAt = Date.now();
                    notify();
                }
                return;
            }
            case 'he': {
                if (msg.role === 'host' && role === 'host') state.conflict = true;
                notify();
                return;
            }
            default:
                break;
        }
        onMessage?.(msg);
    }

    function startHeartbeat() {
        stopHeartbeat();
        state.heartbeatTimer = setInterval(() => {
            if (document.visibilityState === 'hidden') return; // バックグラウンド中の誤切断を防ぐ
            const ws = state.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (state.lastPongAt && Date.now() - state.lastPongAt > REMOTE_DEAD_AFTER_MS) {
                // 応答なし → 自ら切って onclose 経由で再接続させる
                try { ws.close(4000, 'heartbeat-timeout'); } catch (_) { /* noop */ }
                return;
            }
            // ホストは毎心跳で存在を再告知し、別ホスト検知を自己治愈させる
            if (role === 'host') {
                const hadConflict = state.conflict;
                state.conflict = false;
                send({ t: 'he', role: 'host' });
                if (hadConflict) notify();
            }
            send({ t: 'pi', ts: Date.now() });
        }, REMOTE_HEARTBEAT_MS);
    }

    function stopHeartbeat() {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
    }

    function connect() {
        if (state.closed || !room) return;
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

        state.intentionalClose = false;
        setStatus(state.attempt > 0 ? 'reconnecting' : 'connecting');

        let ws;
        try {
            ws = new WebSocket(`${REMOTE_WS_BASE}/${REMOTE_SERVICE}/${encodeURIComponent(room)}`);
        } catch (err) {
            console.error('[remote] WebSocket生成失敗', err);
            setStatus('error');
            scheduleReconnect();
            return;
        }
        state.ws = ws;

        ws.onopen = () => {
            state.attempt = 0;
            state.lastPongAt = Date.now();
            state.rtt = null;
            setStatus('open');
            send({ t: 'he', role });
            onOpen?.();
            notify();
        };

        ws.onmessage = handleMessage;

        ws.onclose = () => {
            if (state.ws !== ws) return;
            state.ws = null;
            stopHeartbeat();
            state.rtt = null;
            state.clients = 0;
            if (state.closed || state.intentionalClose) {
                setStatus('off');
                return;
            }
            scheduleReconnect();
        };

        ws.onerror = () => { /* onclose が続くのでここでは何もしない */ };

        startHeartbeat();
    }

    function scheduleReconnect() {
        if (state.closed || state.reconnectTimer) return;
        const attempt = ++state.attempt;
        const base = Math.min(REMOTE_BACKOFF_MAX_MS, REMOTE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
        const delay = Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% ジッター
        setStatus('reconnecting');
        state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            connect();
        }, delay);
    }

    function close() {
        state.closed = true;
        state.intentionalClose = true;
        activeLinks.delete(api);
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
        stopHeartbeat();
        if (state.ws) {
            try { state.ws.close(1000, 'client-close'); } catch (_) { /* 既に閉じている */ }
            state.ws = null;
        }
        state.rtt = null;
        state.clients = 0;
        state.conflict = false;
        setStatus('off');
    }

    function onVisible() {
        // 復帰時は即心跳で死活を確認する
        if (state.ws?.readyState === WebSocket.OPEN) send({ t: 'pi', ts: Date.now() });
        notify();
    }

    function onHide() {
        // ページ離脱は意図的な切断として扱い、再接続レースを防ぐ
        if (state.ws) {
            state.intentionalClose = true;
            try { state.ws.close(1000, 'unload'); } catch (_) { /* noop */ }
        }
    }

    const api = {
        connect,
        close,
        send,
        handleVisible: onVisible,
        handleHide: onHide,
        get status() { return state.status; },
        get rtt() { return state.rtt; },
        get clients() { return state.clients; },
        get conflict() { return state.conflict; },
    };
    activeLinks.add(api);
    return api;
}

// --- ページ単位で一度だけ登録するグローバルリスナー ---
// インスタンスは activeLinks 経由で呼び出し、close() で外れる。

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const link of activeLinks) link.handleVisible();
});
window.addEventListener('pagehide', () => {
    for (const link of activeLinks) link.handleHide();
});
window.addEventListener('beforeunload', () => {
    for (const link of activeLinks) link.handleHide();
});

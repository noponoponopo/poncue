// modules/04_db.js

import { DB_NAME, DB_VERSION, SCENES_STORE_NAME, AUDIO_FILES_STORE_NAME, SETTINGS_STORE_NAME } from './01_config.js';
import { state, setDb } from './03_state.js';
import { showAlert } from './05_ui.js';

// --- DB Management ---
export function openDB() {
    return new Promise((resolve, reject) => {
        if (state.db) {
            try { state.db.close(); } catch (e) { /* Ignore */ }
            setDb(null);
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;

            // --- V2 Schema Creation ---
            if (e.oldVersion < 2) {
                if (!db.objectStoreNames.contains(SCENES_STORE_NAME)) {
                    db.createObjectStore(SCENES_STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(AUDIO_FILES_STORE_NAME)) {
                    db.createObjectStore(AUDIO_FILES_STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
                    db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'key' });
                }
            }
        };

        request.onsuccess = e => {
            const dbInstance = e.target.result;
            dbInstance.onversionchange = () => {
                try { dbInstance.close(); } catch (_) { /* already closed */ }
                setDb(null);
            };
            setDb(dbInstance);
            dbInstance.onerror = (event) => {
                showAlert(`データベースエラーが発生しました: ${event.target.error.message}`);
            };
            resolve(dbInstance);
        };

        request.onerror = e => {
            setDb(null);
            reject(e.target.error);
        };

        request.onblocked = () => {
            showAlert("データベース接続がブロックされました。他のタブでこのアプリを開いている場合は閉じてから、ページを再読み込みしてください。");
            reject(new Error("DB open blocked"));
        };
    });
}

export async function dbRequest(storeName, mode, operation, data = null) {
    if (!state.db) {
        try {
            await openDB();
        } catch (dbOpenError) {
            if (state.showErrorPopups) showAlert("データベース接続エラーが発生しました。");
            return Promise.reject(dbOpenError);
        }
    }

    const isWrite = mode === 'readwrite';

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            let request;
            switch (operation) {
                case 'get': request = store.get(data); break;
                case 'getAll': request = store.getAll(); break;
                case 'put': request = store.put(data); break;
                case 'delete': request = store.delete(data); break;
                case 'clear': request = store.clear(); break;
                default:
                    return reject(new Error(`Invalid DB operation: ${operation}`));
            }

            if (isWrite) {
                let writeResult;
                request.onsuccess = event => { writeResult = event.target.result; };
                transaction.oncomplete = () => resolve(writeResult);
                transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('DB transaction failed'));
                transaction.onabort = () => reject(transaction.error ?? new Error('DB transaction aborted'));
            } else {
                request.onsuccess = event => resolve(event.target.result);
                request.onerror = event => {
                    reject(event.target.error);
                };
            }
        } catch (err) {
            reject(err);
        }
    });
}
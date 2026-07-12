import { state } from './03_state.js';

const MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4'
];

let recordingSession = null;

function getSupportedMimeType() {
    if (!window.MediaRecorder) return '';
    return MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

export function isMasterRecordingSupported() {
    return Boolean(window.MediaRecorder && state.recordingDestinationNode?.stream);
}

export function getMasterRecordingStatus() {
    return {
        isRecording: Boolean(recordingSession),
        startedAt: recordingSession?.startedAt ?? null,
        mimeType: recordingSession?.mimeType ?? null,
        recorderState: recordingSession?.recorder.state ?? 'inactive'
    };
}

export function startMasterRecording() {
    if (!isMasterRecordingSupported()) {
        throw new Error('このブラウザはマスター出力の録音に対応していません。');
    }
    if (recordingSession) throw new Error('録音はすでに開始されています。');

    const mimeType = getSupportedMimeType();
    const options = { audioBitsPerSecond: 192000 };
    if (mimeType) options.mimeType = mimeType;

    const chunks = [];
    const recorder = new MediaRecorder(state.recordingDestinationNode.stream, options);
    recorder.addEventListener('dataavailable', event => {
        if (event.data.size > 0) chunks.push(event.data);
    });
    const session = {
        recorder,
        chunks,
        startedAt: Date.now(),
        mimeType: recorder.mimeType || mimeType || 'audio/webm'
    };
    recorder.start(1000);
    recordingSession = session;
    return getMasterRecordingStatus();
}

export function stopMasterRecording() {
    if (!recordingSession) return Promise.reject(new Error('録音は開始されていません。'));
    const session = recordingSession;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            recordingSession = null;
            const blob = new Blob(session.chunks, { type: session.mimeType });
            if (blob.size === 0) {
                reject(new Error('録音データを作成できませんでした。'));
                return;
            }
            resolve(blob);
        };
        session.recorder.addEventListener('stop', finish, { once: true });
        session.recorder.addEventListener('error', event => {
            if (settled) return;
            settled = true;
            recordingSession = null;
            reject(event.error || new Error('録音中にエラーが発生しました。'));
        }, { once: true });

        if (session.recorder.state === 'inactive') finish();
        else session.recorder.stop();
    });
}

export function downloadRecording(blob, name) {
    const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

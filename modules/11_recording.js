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
    let resolveCompletion;
    const completion = new Promise(resolve => {
        resolveCompletion = resolve;
    });
    const session = {
        recorder,
        chunks,
        startedAt: Date.now(),
        mimeType: recorder.mimeType || mimeType || 'audio/webm',
        completion,
        failureReason: null,
        settled: false
    };

    recorder.addEventListener('dataavailable', event => {
        if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', event => {
        session.failureReason = event.error || new Error('録音中にエラーが発生しました。');
    }, { once: true });
    recorder.addEventListener('stop', () => {
        if (session.settled) return;
        session.settled = true;
        if (recordingSession === session) recordingSession = null;
        const blob = new Blob(session.chunks, { type: session.mimeType });
        const error = session.failureReason
            || (blob.size === 0 ? new Error('録音データを作成できませんでした。') : null);
        resolveCompletion({ blob, error });
    }, { once: true });

    recordingSession = session;
    try {
        recorder.start(1000);
    } catch (error) {
        recordingSession = null;
        session.settled = true;
        throw error;
    }
    return completion;
}

export function stopMasterRecording() {
    if (!recordingSession) return Promise.reject(new Error('録音は開始されていません。'));
    const session = recordingSession;
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    return session.completion;
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

import { state } from './03_state.js';
import { dom } from './02_dom.js';
import { forceStopSound, getActivePlaybackSnapshot, playSound, resumeAudioContext } from './06_audio.js';
import { selectScene } from './07_scenes.js';
import { showConfirm } from './05_ui.js';

const RECOVERY_KEY = 'poncue-playback-recovery-v1';
const RECOVERY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let checkpointIntervalId = null;

export function savePlaybackCheckpoint() {
    const sounds = getActivePlaybackSnapshot();
    if (!state.currentSceneId || sounds.length === 0) {
        localStorage.removeItem(RECOVERY_KEY);
        return;
    }
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({
        version: 1,
        sceneId: state.currentSceneId,
        savedAt: Date.now(),
        sounds
    }));
}

export function clearPlaybackCheckpoint() {
    localStorage.removeItem(RECOVERY_KEY);
}

export function readPlaybackCheckpoint() {
    try {
        const checkpoint = JSON.parse(localStorage.getItem(RECOVERY_KEY));
        if (checkpoint?.version !== 1 || !checkpoint.sceneId || !Array.isArray(checkpoint.sounds)) return null;
        if (!Number.isFinite(checkpoint.savedAt) || Date.now() - checkpoint.savedAt > RECOVERY_MAX_AGE_MS) return null;
        return checkpoint;
    } catch (_) {
        return null;
    }
}

export async function offerPlaybackRecovery() {
    const originalCheckpoint = localStorage.getItem(RECOVERY_KEY);
    const checkpoint = readPlaybackCheckpoint();
    if (!checkpoint) {
        clearPlaybackCheckpoint();
        return false;
    }

    const scene = state.scenes[checkpoint.sceneId];
    const validSounds = checkpoint.sounds.flatMap(entry => {
        const sound = scene?.sounds.find(item => item.id === entry.soundId);
        if (!sound || !Number.isFinite(entry.position) || entry.position < 0) return [];

        const duration = Number(sound.duration) || 0;
        const position = sound.loop && duration > 0 ? entry.position % duration : entry.position;
        if (!sound.loop && duration > 0 && position >= duration) return [];
        return [{ soundId: entry.soundId, position }];
    });
    if (!scene || validSounds.length === 0) {
        clearPlaybackCheckpoint();
        return false;
    }

    const savedTime = new Date(checkpoint.savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const confirmed = await showConfirm(
        `${savedTime} に中断した「${scene.name}」の再生 ${validSounds.length} 件を、保存位置から復旧しますか？`,
        '再生セッションの復旧'
    );
    if (!confirmed) {
        clearPlaybackCheckpoint();
        return false;
    }

    const startedSoundIds = [];
    const rollback = () => {
        startedSoundIds.forEach(soundId => {
            try { forceStopSound(soundId); } catch (_) { /* Continue cleanup */ }
        });
        localStorage.setItem(RECOVERY_KEY, originalCheckpoint);
    };

    try {
        if (!await resumeAudioContext()) {
            rollback();
            return false;
        }
        await selectScene(checkpoint.sceneId);
        for (const entry of validSounds) {
            const button = dom.soundboard?.querySelector(`.sound-button[data-id="${entry.soundId}"]`);
            startedSoundIds.push(entry.soundId);
            if (!await playSound(entry.soundId, button, performance.now(), entry.position)) {
                rollback();
                return false;
            }
        }
    } catch (error) {
        rollback();
        throw error;
    }

    savePlaybackCheckpoint();
    return true;
}

export function startPlaybackCheckpointing() {
    if (checkpointIntervalId !== null) return;
    checkpointIntervalId = window.setInterval(savePlaybackCheckpoint, 1000);
    window.addEventListener('pagehide', savePlaybackCheckpoint);
    window.addEventListener('poncue-playback-statechange', savePlaybackCheckpoint);
}

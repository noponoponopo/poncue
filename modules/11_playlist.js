import { dom } from './02_dom.js';
import { state } from './03_state.js';

export function normalizePlaylist(scene) {
    if (!scene) return { soundIds: [], autoAdvance: true, repeat: false };
    const validIds = new Set(scene.sounds.map(sound => sound.id));
    const sourceIds = Array.isArray(scene.playlist?.soundIds) ? scene.playlist.soundIds : [];
    const soundIds = [...new Set(sourceIds)].filter(id => validIds.has(id));
    scene.playlist = {
        soundIds,
        autoAdvance: scene.playlist?.autoAdvance !== false,
        repeat: Boolean(scene.playlist?.repeat)
    };
    return scene.playlist;
}

export function renderPlaylist() {
    if (!dom.playlistPanel || !dom.playlistList) return;
    const scene = state.scenes[state.currentSceneId];
    const playlist = normalizePlaylist(scene);
    const playback = state.playlistPlayback;

    dom.playlistList.replaceChildren();
    playlist.soundIds.forEach((soundId, index) => {
        const sound = scene.sounds.find(item => item.id === soundId);
        const row = document.createElement('li');
        row.dataset.index = String(index);
        row.dataset.soundId = soundId;
        if (playback.sceneId === state.currentSceneId && playback.soundId === soundId) {
            row.classList.add('is-current');
        }

        const number = document.createElement('span');
        number.className = 'playlist-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'playlist-item-play';
        name.dataset.action = 'play';
        name.textContent = sound.name;
        name.title = sound.name;
        const duration = document.createElement('span');
        duration.className = 'playlist-duration';
        duration.textContent = formatDuration(sound.duration);
        const actions = document.createElement('div');
        actions.className = 'playlist-item-actions';
        actions.innerHTML = `
            <button type="button" data-action="up" aria-label="上へ" ${index === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
            <button type="button" data-action="down" aria-label="下へ" ${index === playlist.soundIds.length - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
            <button type="button" data-action="remove" aria-label="プレイリストから削除"><i class="fas fa-times"></i></button>
        `;
        row.append(number, name, duration, actions);
        dom.playlistList.appendChild(row);
    });

    if (!playlist.soundIds.length) {
        const empty = document.createElement('li');
        empty.className = 'playlist-empty';
        empty.textContent = 'サウンドを追加すると順番に再生できます。';
        dom.playlistList.appendChild(empty);
    }

    dom.playlistAddSelect.replaceChildren();
    const available = scene?.sounds.filter(sound => !playlist.soundIds.includes(sound.id)) || [];
    dom.playlistAddSelect.add(new Option(available.length ? '追加するサウンドを選択' : '追加できるサウンドはありません', ''));
    available.forEach(sound => dom.playlistAddSelect.add(new Option(sound.name, sound.id)));
    dom.playlistAddSelect.disabled = !available.length;
    dom.playlistAddBtn.disabled = !available.length;
    dom.playlistAutoAdvance.checked = playlist.autoAdvance;
    dom.playlistRepeat.checked = playlist.repeat;

    const hasItems = playlist.soundIds.length > 0;
    const isPlaying = playback.sceneId === state.currentSceneId && playback.isPlaying;
    dom.playlistPlayBtn.disabled = !hasItems;
    dom.playlistPrevBtn.disabled = !hasItems;
    dom.playlistNextBtn.disabled = !hasItems;
    dom.playlistStopBtn.disabled = !isPlaying;
    dom.playlistPlayBtn.classList.toggle('is-active', isPlaying);
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '--:--';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

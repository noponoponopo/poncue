export const TIMECODE_FPS_OPTIONS = [24, 25, 30];

export function normalizeTimecodeFps(value) {
    const fps = Number(value);
    return TIMECODE_FPS_OPTIONS.includes(fps) ? fps : 30;
}

export function formatTimecode(seconds, fps = 30) {
    const safeFps = normalizeTimecodeFps(fps);
    const totalFrames = Math.max(0, Math.floor((Number(seconds) || 0) * safeFps));
    const frames = totalFrames % safeFps;
    const totalSeconds = Math.floor(totalFrames / safeFps);
    const secs = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600) % 24;
    return [hours, minutes, secs, frames].map(value => String(value).padStart(2, '0')).join(':');
}

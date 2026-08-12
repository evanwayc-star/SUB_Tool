import { clamp } from './util.js';

// 時間尺同時是主要 seek / scrub 命中區；36px 讓頻繁點按更容易，又不過度壓縮軌道空間。
export const RULER_H = 36;
export const ROW_H = 64;
export const VROW_H = 44;
export const AROW_H = 48;
export const AUDIO_HEAD_H = 0;
export const AUDIO_MAX_VIEW_H = 216;
export const AUDIO_MIN_SUB_H = 72;

export function trackH(tracks, tk) {
  return tracks[tk]?.height || ROW_H;
}

export function tracksHeight(tracks, trackCount) {
  let h = 0;
  for (let i = 0; i < trackCount; i++) h += trackH(tracks, i);
  return h;
}

export function yToTrack(tracks, trackCount, y) {
  let c = 0;
  for (let i = 0; i < trackCount; i++) {
    c += trackH(tracks, i);
    if (y < c) return i;
  }
  return Math.max(0, trackCount - 1);
}

export function vtrackCount(videoTracks) {
  return Math.max(1, videoTracks.length);
}

export function vtrackH(videoTracks, v) {
  return videoTracks[v]?.height || VROW_H;
}

export function vtracksHeight(videoTracks, hasSeq, collapsed) {
  if (!hasSeq || collapsed) return 0;
  let h = 0;
  const N = vtrackCount(videoTracks);
  for (let v = 0; v < N; v++) h += vtrackH(videoTracks, v);
  return h;
}

export function vtrackTop(videoTracks, v) {
  const N = vtrackCount(videoTracks);
  let top = 0;
  for (let disp = 0; disp < N; disp++) {
    const vv = N - 1 - disp;
    if (vv === v) return top;
    top += vtrackH(videoTracks, vv);
  }
  return 0;
}

export function sourceAudioRowH(row) {
  const h = Number(row?.height);
  return Number.isFinite(h) ? clamp(h, 32, 160) : AROW_H;
}

export function audioRowsHeight(layout) {
  return layout.reduce((sum, row) => sum + row.h, 0);
}

export function audioViewportH(layout, layerH, vHeight) {
  const full = audioRowsHeight(layout);
  if (!full) return 0;
  const room = layerH ? layerH - RULER_H - vHeight - AUDIO_HEAD_H - AUDIO_MIN_SUB_H : AUDIO_MAX_VIEW_H;
  const cap = Math.max(36, Math.min(AUDIO_MAX_VIEW_H, room));
  return Math.min(full, cap);
}

export function atracksHeight(layout, layerH, vHeight) {
  return layout.length ? AUDIO_HEAD_H + audioViewportH(layout, layerH, vHeight) : 0;
}

export function tracksTop(vHeight, aHeight) {
  return RULER_H + vHeight + aHeight;
}

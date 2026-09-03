/* ==============================================================================
   SUB Tool — Subtitle Snapshot Engine ("src/subtitle-snapshot-engine.js")
   ==============================================================================
   純粹無 DOM 的字幕快照渲染與軌道過濾引擎 (Zero-DOM Subtitle Snapshot Engine)。
   專門提供交付工作、視訊預覽渲染與背景轉檔使用：
   1. renderASS: 從顯式給予的 cues、tracks 與 fps 快照輸出 ASS 字串（鐵律 §0.1 三路一致）。
   2. burnedSubtitleTrackNames: 從給定軌道與字幕集過濾出實際可見或含內容的燒錄軌道名稱。
   ============================================================================== */

import { SubFormats } from './formats.js';
import { ASS_PLAY_RES } from './substyle.js';

/**
 * 從字幕快照輸出 ASS 格式字串。
 * 刻意不讀取可變的 State，保證交付與背景導出的不可變性。
 */
export function renderASS(cues, { fps, tracks = [], dropFrame = false, ...options } = {}) {
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(Array.isArray(cues) ? cues : [], fps, tracks, RX, RY, {
    ...options,
    dropFrame,
  });
}

/**
 * 依可見性與實際內容過濾出燒錄軌道名稱清單。
 * 不依賴任何 UI 或編輯狀態模組。
 */
export function burnedSubtitleTrackNames(tracks, cues = null) {
  const list = Array.isArray(tracks) ? tracks : [];
  const includedTracks = Array.isArray(cues)
    ? new Set(cues.map(cue => Number.isInteger(cue?.track) ? cue.track : 0))
    : null;
  const lastTrack = includedTracks?.size ? Math.max(...includedTracks) : list.length - 1;

  return Array.from({ length: Math.max(list.length, lastTrack + 1) }, (_, index) => {
    if (includedTracks && !includedTracks.has(index)) return null;
    const track = list[index];
    return (!track || track.visible !== false) ? (track?.name || `軌道 ${index + 1}`) : null;
  }).filter(Boolean);
}

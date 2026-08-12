import { State, newId, syncTrackCount, DESK } from '../state.js';
import { trackStyleSnapshot } from '../substyle.js';
import { sortCues } from '../subtitles.js';
import { escapeHTML } from '../util.js';
import { showToast, openModal, closeModal } from '../ui.js';
import { recordHistory } from '../history.js';
import { emit } from '../events.js';
import { openSubtitleCompareSession } from '../subtitle-compare-session.js';

export function currentSubtitleCompareSnapshot() {
  return {
    tracks: State.tracks,
    cues: State.cues,
    fps: State.fps,
    dropFrame: State.dropFrame,
  };
}

export function doCompareTrack() {
  if (State.tracks.length < 1) { showToast('沒有足夠的字幕軌道可供比對'); return; }
  if (DESK?.openCompareWindow) {
    openSubtitleCompareSession(currentSubtitleCompareSnapshot());
  } else {
    showToast('此功能僅限桌面版使用');
  }
}

export function doCopyTrack() {
  const srcIdx = State.listTrack;
  const srcTrack = State.tracks[srcIdx];
  if (!srcTrack) { showToast('請先選擇一個字幕軌道'); return; }
  const srcCues = State.cues.filter(c => (c.track || 0) === srcIdx);
  openModal('複製字幕軌道',
    `<p>將 <b>${escapeHTML(srcTrack.name)}</b> 的 <b>${srcCues.length}</b> 條字幕複製到新軌道，請選擇複製方式：</p>`,
    [
      { label: '含文字內容', primary: true, act: () => { closeModal(); _execCopyTrack(srcIdx, true); } },
      { label: '僅複製時間點（文字清空）', act: () => { closeModal(); _execCopyTrack(srcIdx, false); } },
      { label: '取消', act: closeModal }
    ]
  );
}

function _execCopyTrack(srcIdx, withText) {
  const srcTrack = State.tracks[srcIdx]; if (!srcTrack) return;
  // 產生唯一軌道名稱
  const base = srcTrack.name + '_複製';
  let name = base, n = 1;
  const names = State.tracks.map(t => t.name);
  while (names.includes(name)) name = base + (n++);
  
  // 複製軌道屬性
  const tk = { name, visible: true, locked: false, ...trackStyleSnapshot(srcTrack) };
  const newIdx = State.tracks.length;
  State.tracks.push(tk); syncTrackCount();
  
  // 複製字幕
  const srcCues = State.cues.filter(c => (c.track || 0) === srcIdx);
  for (const c of srcCues) {
    State.cues.push({ id: newId(), start: c.start, end: c.end, text: withText ? (c.text || '') : '', track: newIdx, timed: c.timed });
  }
  
  sortCues();
  State.listTrack = newIdx;
  
  emit('render:all');
  emit('timeline:invalidate'); // instead of drawTimeline()
  emit('render:listTrackSel'); // for renderListTrackSel()
  
  // We need to trigger renderSubList, which is usually included in renderAll, but we explicitly trigger it here if needed.
  // Actually, app.js renderAll() calls renderSubList(), so emit('render:all') is sufficient.
  
  recordHistory('複製字幕軌道');
  showToast(`已複製到「${name}」（${srcCues.length} 條）`);
}

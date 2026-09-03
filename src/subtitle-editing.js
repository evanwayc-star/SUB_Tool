/* ==============================================================================
   SUB Tool — 字幕 In/Out 點設定與上字幕模式 (Subtitle Editing Module)
   ==============================================================================
   深層模組：負責時間軸字幕 I/O 快錄、起迄點設定與上字幕模式序列推進。
   所有時間計算一律經由 snapTimeToFrame 吸附影格格網 (FPS-SYNC)。
   ============================================================================== */
import { State, cueSuffix } from './state.js';
import { fmtClock, snapTimeToFrame } from './time.js';
import { Media } from './media.js';
import { selectCueSingle, commitCueTimeEdit } from './subtitles.js';
import { addCue, cueTrackLocked } from './subtitle-model.js';
import { ensureProjectSaved } from './project.js';
import { recordHistory } from './history.js';
import { setStatus } from './ui.js';

export async function setIn() {
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  let c = State.cues.find(x => x.id === State.selectedId);
  if (!c) {
    const tk = State.tracks.length === 0 ? 0 : Math.min(State.tracks.length - 1, Math.max(0, State.listTrack));
    c = addCue(t, snapTimeToFrame(t + 2, State.fps, State.dropFrame), '', tk, { historyLabel: '新增字幕(I)' });
    if (!c) return;
    setStatus('已新增字幕，起點 ' + fmtClock(t), 'ok');
    return;
  }
  if (cueTrackLocked(c, '調整字幕起點')) return;
  const wasUntimed = c.timed === false;
  c.start = t;
  if (State.subMode) {
    State.cues.forEach(cue => {
      if (cue._tempEnd && cue.id !== c.id) {
        cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
        delete cue._tempEnd;
      }
    });
    c.end = (State.duration && State.duration > c.start) ? State.duration : c.start + 3600;
    c._tempEnd = true;
    if (!State._subModeTouchedIds) State._subModeTouchedIds = new Set();
    State._subModeTouchedIds.add(c.id);
  } else if (wasUntimed || c.end <= c.start) {
    c.end = snapTimeToFrame(c.start + 0.5, State.fps, State.dropFrame);
  }
  c.timed = true;
  commitCueTimeEdit(c, 'start');
  recordHistory('設定起點 I' + cueSuffix(c)); setStatus('起點 ' + fmtClock(t), 'ok');
}

export async function setOut() {
  await ensureProjectSaved();
  if (State.selectedIds.length > 1) { setStatus('多選模式 — 請用 P 鍵整體位移', 'err'); return; }
  let t = snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame);
  const c = State.cues.find(x => x.id === State.selectedId);
  if (!c) { setStatus('請先選擇字幕（或按 I 新建）', 'err'); return; }
  if (cueTrackLocked(c, '調整字幕終點')) return;

  const wasUntimed = c.timed === false;
  if (wasUntimed) {
    c.end = t;
    c.start = snapTimeToFrame(Math.max(0, t - 0.5), State.fps, State.dropFrame);
  } else {
    if (t <= c.start) { setStatus('終點不得早於或等於起點', 'err'); return; }
    c.end = t;
  }

  c.timed = true;
  delete c._tempEnd;
  commitCueTimeEdit(c, 'end');
  recordHistory('設定終點 O' + cueSuffix(c)); setStatus('終點 ' + fmtClock(c.end), 'ok');
  autoAdvanceSubMode();
}

export function autoAdvanceSubMode() {
  if (!State.subMode || !State._subModeSequence) return;

  const seq = State._subModeSequence;
  const currIdx = seq.indexOf(State.selectedId);

  if (currIdx >= 0) {
    let nextIdx = currIdx + 1;
    while (nextIdx < seq.length) {
      const nextId = seq[nextIdx];
      const nextCue = State.cues.find(c => c.id === nextId);
      const currCue = State.cues.find(c => c.id === State.selectedId);
      if (nextCue && currCue && (nextCue.track || 0) === (currCue.track || 0)) {
        selectCueSingle(nextId, false);
        setStatus(`🎯 上字幕 (依原順序) — 按 I 設起點`, 'ok');
        return;
      }
      nextIdx++;
    }
  }

  selectCueSingle(null);
  setStatus('🎯 上字幕模式：已無下一句，取消選取 ✓', 'ok');
}

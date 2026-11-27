import { State, newId, newTrack, setSelection, syncTrackCount } from './state.js';
import { snapTimeToFrame } from './time.js';
import { extendDurationForCues, snapCueToFrames, sortCues } from './subtitle-model.js';
import { normalizeRecognitionEvidence } from './recognition-evidence.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';

export const PLAYHEAD_OCR_DURATION_SECONDS = 2;

// Called after the user confirms the OCR text. Time is the captured project
// playhead, even if playback or the current selection has moved since capture.
export function commitPlayheadOcrCue({
  text, time, fps = State.fps, dropFrame = State.dropFrame, originalText = text, provider,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw Error('請輸入要新增的字幕文字。');
  if (!Number.isFinite(time) || time < 0) throw Error('無法取得擷取畫格的時間。');
  if (!Number.isFinite(fps) || fps <= 0 || fps !== State.fps || dropFrame !== State.dropFrame) {
    throw Error('專案格率或時碼設定已變更，請重新擷取畫格。');
  }
  const existing = State.tracks.findIndex(track => track.name === 'OCR');
  if (existing >= 0 && State.tracks[existing].locked) throw Error('「OCR」字幕軌已鎖定，請先解鎖。');
  const track = existing < 0 ? State.tracks.length : existing;
  // FPS-SYNC: measure the duration from the snapped capture frame.
  const start = snapTimeToFrame(time, fps, dropFrame);
  const cue = {
    id:newId(), track, text, timed:true, start, end:start + PLAYHEAD_OCR_DURATION_SECONDS,
    recognition:normalizeRecognitionEvidence({kind:'screen', originalText, provider, timingEvidence:'frame'}),
  };
  snapCueToFrames(cue, {fps, dropFrame});

  if (existing < 0) {
    State.tracks.push(newTrack('OCR'));
    syncTrackCount();
  }
  State.cues.push(cue);
  sortCues();
  State.listTrack = track;
  setSelection({kind:'sub', ids:[cue.id]});
  State.activeEdge = 'start';
  extendDurationForCues([cue]);
  recordHistory('播放點 OCR 新增字幕');
  if (existing < 0) emit('timeline:invalidate');
  emit('render:listTrackSel');
  emit('render:all');
  emit('render:selection');
  return cue;
}

import { sourceTime, timelineTime } from './sequence-time.js';
import { trimRange } from './project-audio.js';

// A video placement and an external audio placement share the project clock.
// Older ASR callers may have start/dur instead of offset/duration.
function placementOf(clip) {
  if (!clip) return null;
  const { trimStart, trimEnd } = trimRange({
    in:clip.in ?? clip.trimStart, out:clip.out ?? clip.trimEnd ?? clip.duration ?? clip.dur,
  });
  const offset = Number(clip.offset ?? clip.start ?? 0);
  if (!Number.isFinite(offset) || !Number.isFinite(trimStart) || trimEnd <= trimStart) return null;
  const speed = Number(clip.speed);
  return { in:trimStart, out:trimEnd, offset, reverse:clip.type !== 'image' && !!clip.reverse,
    speed:clip.type !== 'image' && Number.isFinite(speed) && speed > 0 ? speed : 1 };
}

function endOf(placement) {
  return timelineTime(placement.reverse ? placement.in : placement.out, placement);
}

export function getRecognitionClipRange(clip) {
  const placement = placementOf(clip);
  if (!placement) return null;
  const end = endOf(placement);
  return Number.isFinite(end) && end > placement.offset ? { start:placement.offset, end } : null;
}

export function resolveRecognitionRange(mode, state, { pendingClips = [], liveExternalSources = [] } = {}) {
  if (mode !== 'all' && mode !== 'export') return { start:0, end:0, error:'請選擇辨識範圍。' };
  // The delivery timeline ends at media, including offline or muted media.
  // Live external placements supersede their persisted positions.
  const external = new Map();
  for (const source of [...(state.externalAudioState || []), ...liveExternalSources]) {
    if (source) external.set(source.audioSourceId || source.id || source, source);
  }
  let mediaEnd = 0;
  for (const clip of [...(state.clips || []), ...pendingClips, ...external.values()]) {
    const range = getRecognitionClipRange(clip);
    if (range) mediaEnd = Math.max(mediaEnd, range.end);
  }
  const start = mode === 'export' ? Number(state.exportIn ?? 0) : 0;
  const end = mode === 'export' ? Number(state.exportOut ?? mediaEnd) : mediaEnd;
  let error = '';
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    error = mode === 'export' ? '輸出範圍無效，請確認 Out 點晚於 In 點。' : '時間軸上沒有可辨識的影音範圍。';
  }
  return { start, end, error };
}

// Output marks are already in project seconds. Keep the absolute offset so
// source-relative OCR/ASR segments are written back to their original position.
export function sliceRecognitionClip(clip, range) {
  const placement = placementOf(clip);
  if (!placement || range?.error || !Number.isFinite(range?.start) || !Number.isFinite(range?.end)) return null;
  const clipEnd = endOf(placement);
  const start = Math.max(placement.offset, range.start);
  const end = Math.min(clipEnd, range.end);
  // At a shared cut the two representations of the same second may differ by
  // an ulp (for example 0.1 + 0.2 versus 0.3).
  if (end - start <= Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end))) return null;
  const first = start === placement.offset
    ? (placement.reverse ? placement.out : placement.in) : sourceTime(start, placement);
  const last = end === clipEnd
    ? (placement.reverse ? placement.in : placement.out) : sourceTime(end, placement);
  const trimStart = Math.max(placement.in, Math.min(first, last));
  const trimEnd = Math.min(placement.out, Math.max(first, last));
  if (trimEnd <= trimStart) return null;
  return { ...clip, ...placement, in:trimStart, out:trimEnd, trimStart, trimEnd, offset:start };
}

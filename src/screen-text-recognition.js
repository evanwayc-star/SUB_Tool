import { audioMotherPath } from '../shared/audio-loudness.cjs';
import { Media } from './media.js';
import { Project } from './project.js';
import { getRecognitionClipRange, resolveRecognitionRange, sliceRecognitionClip } from './recognition-range.js';
import { Seq } from './sequence.js';
import { insertAsrSubtitles } from './speech-recognition.js';
import { State, videoTrackVisible } from './state.js';

export function screenTextSourcePath(clip) {
  const path = audioMotherPath(clip) || (clip?.primary && State.mediaPath);
  return typeof path === 'string' && path.trim() ? path : null;
}

function sourceWindow(clip, slice, range, offline = false) {
  const path = screenTextSourcePath(clip);
  if (offline || !path) {
    throw Object.assign(new Error(`請先重新連結影片「${clip.name || '影片片段'}」的原始檔案。`), { range });
  }
  const { in:start, out:end, offset, speed, reverse } = slice;
  return { clip, path, start, end, placement:{ in:start, out:end, offset, speed, reverse } };
}

// The playing video follows Seq.clipAt: highest visible moving-video track
// wins; static overlays are rendered separately. Only scan active overlaps at
// cut points, so long timelines of successive shots do not require N² lookups.
function visibleSourceWindows(range, pending) {
  const cuts = new Map();
  const cutAt = time => {
    if (!cuts.has(time)) cuts.set(time, { starts:[], ends:[] });
    return cuts.get(time);
  };
  for (const [order, clip] of [...State.clips, ...pending].entries()) {
    const track = clip.vtrack || 0;
    if (!videoTrackVisible(track) || Seq.isStill(clip)) continue;
    const bounds = getRecognitionClipRange(clip);
    if (!bounds) continue;
    const start = Math.max(range.start, bounds.start);
    const end = Math.min(range.end, bounds.end);
    if (!(end > start)) continue;
    const candidate = { clip, order, track, offline:order >= State.clips.length };
    cutAt(start).starts.push(candidate);
    cutAt(end).ends.push(candidate);
  }
  const active = new Set(), spans = [];
  const times = [...cuts.keys()].sort((a,b) => a - b);
  for (let index = 0; index < times.length - 1; index++) {
    const start = times[index], end = times[index + 1];
    const cut = cuts.get(start);
    for (const entry of cut.ends) active.delete(entry);
    for (const entry of cut.starts) active.add(entry);
    let top = null;
    for (const entry of active) {
      if (!top || entry.track > top.track || (entry.track === top.track && entry.order > top.order)) top = entry;
    }
    if (!top) continue;
    const previous = spans.at(-1);
    if (previous?.top === top && previous.end === start) previous.end = end;
    else spans.push({ top, start, end });
  }
  const windows = [];
  for (const { top, start, end } of spans) {
    const slice = sliceRecognitionClip(top.clip, { start, end });
    if (slice) windows.push(sourceWindow(top.clip, slice, range, top.offline));
  }
  if (!windows.length) throw Object.assign(new Error('這個範圍沒有可辨識的影片畫面。'), { range });
  return windows;
}

function selectedClipWindow(clip) {
  const range = getRecognitionClipRange(clip);
  const slice = range && sliceRecognitionClip(clip, range);
  if (!slice || !State.clips.includes(clip) || Seq.isStill(clip) || clip.in < 0) {
    throw new Error('請選擇已連結原始檔案的影片片段。');
  }
  return { range, windows:[sourceWindow(clip, slice, range)] };
}

export function getScreenTextPlan(clip, scope = 'clip') {
  const grid = { fps:State.fps || 24, dropFrame:!!State.dropFrame };
  if (scope === 'clip') return { ...selectedClipWindow(clip), scope, ...grid };
  if (scope !== 'all' && scope !== 'export') throw new Error('請選擇有效的辨識範圍。');
  const pending = Project.unrestoredClips();
  const { start, end, error } = resolveRecognitionRange(scope, State, {
    pendingClips:pending, liveExternalSources:Media.externalAudio.list(),
  });
  if (error) throw new Error(error);
  const range = { start, end };
  return { range, windows:visibleSourceWindows(range, pending), scope, ...grid };
}

function planIsCurrent(plan, clip) {
  let windows;
  try {
    windows = plan.scope === 'clip' ? selectedClipWindow(clip).windows
      : visibleSourceWindows(plan.range, Project.unrestoredClips());
  } catch { return false; }
  return windows.length === plan.windows.length && windows.every((item,index) => {
    const saved = plan.windows[index];
    return item.clip === saved.clip && item.path === saved.path
      && Object.keys(item.placement).every(key => item.placement[key] === saved.placement[key]);
  });
}

function appendWindowCues(results, cues, window, previousWindow, processedEnd = window.end) {
  let { placement } = window;
  if (processedEnd <= placement.in) return;
  if (processedEnd < placement.out) {
    const offset = placement.reverse ? Seq.toTimeline(processedEnd, placement) : placement.offset;
    placement = { ...placement, out:processedEnd, offset };
  }
  const start = placement.offset, end = start + Seq.len(placement);
  const sameFootage = previousWindow?.path === window.path && previousWindow.placement.speed === placement.speed
    && previousWindow.placement.reverse === placement.reverse
    && Math.abs(previousWindow.placement.offset + Seq.len(previousWindow.placement) - start) < 1e-8
    && Math.abs(placement.reverse ? previousWindow.start - window.end : previousWindow.end - window.start) < 1e-8;
  // Each continuous stretch owns its grid bounds. An off-grid cut or output
  // mark cannot leak a cue into the next shot or into a black gap.
  if (!sameFootage) results.push({ clip:{ offset:start, in:0, out:0 }, segments:[] });
  const group = results.at(-1);
  group.clip.out = end - group.clip.offset;
  const mapped = cues.map(cue => {
    const first = Seq.toTimeline(cue.start, placement), last = Seq.toTimeline(cue.end, placement);
    return { start:Math.min(first,last) - group.clip.offset, end:Math.max(first,last) - group.clip.offset,
      text:cue.text, kind:cue.kind === 'dialogue' ? 'dialogue' : 'card', slot:cue.slot };
  }).sort((a,b) => a.start - b.start);
  // Text alone does not identify the card across two different shots. Join
  // only when both the timeline and the underlying footage continue at a cut.
  const boundary = start - group.clip.offset;
  const previousSegments = sameFootage ? group.segments.filter(item => Math.abs(item.end - boundary) < 1e-8) : [];
  for (const segment of mapped) {
    const previousIndex = Math.abs(segment.start - boundary) < 1e-8
      ? previousSegments.findIndex(item => item.kind === segment.kind && item.slot === segment.slot
        && item.text === segment.text) : -1;
    const previous = previousIndex >= 0 ? previousSegments.splice(previousIndex, 1)[0] : null;
    if (previous) previous.end = segment.end;
    else group.segments.push(segment);
  }
}

export async function recognizeClipText(clip, {
  provider = 'openai', model = 'gpt-5.4-mini', sourceLang = 'auto', sampleFps = 2,
  frameWidth = 1280, smartAccuracy = true, signal, onProgress, preserveSelection = () => false,
  scope = 'clip', plan:acceptedPlan,
} = {}) {
  const bridge = window.subtool;
  if (!bridge?.recognizeScreenText) throw new Error('畫面文字辨識需要桌面版。');
  const ownsWorkspace = Project.captureWorkspaceOwnership();
  const cancelled = () => new DOMException('畫面文字辨識已取消。', 'AbortError');
  if (signal?.aborted) throw cancelled();
  const plan = acceptedPlan ?? getScreenTextPlan(clip, scope);
  const { windows } = plan;
  const totalSeconds = windows.reduce((sum, item) => sum + item.end - item.start, 0);
  let stopMode = null, requestId = null, index = 0, processedSeconds = 0;
  const stop = mode => {
    if (stopMode === 'discard' || stopMode === mode) return;
    stopMode = mode;
    if (!requestId) return;
    const pending = mode === 'keep' ? bridge.cancelScreenText(requestId, true) : bridge.cancelScreenText(requestId);
    void pending.catch(() => {});
  };
  const onAbort = () => stop(signal.reason?.keepScreenTextResults ? 'keep' : 'discard');
  const unsubscribe = bridge.onScreenTextProgress(event => {
    if (!requestId || event.requestId !== requestId || stopMode) return;
    const seconds = windows[index].end - windows[index].start;
    onProgress?.({ ...event, progress:(processedSeconds + event.progress * seconds) / totalSeconds,
      message:windows.length > 1 ? `第 ${index + 1}／${windows.length} 段 · ${event.message || '正在辨識畫面文字'}` : event.message });
  });
  const release = Project.onWorkspaceInvalidated(() => stop('discard'));
  signal?.addEventListener('abort', onAbort, { once:true });
  const results = [];
  const commit = () => {
    if (!ownsWorkspace() || stopMode === 'discard') throw cancelled();
    if (!planIsCurrent(plan, clip)) {
      throw new Error('辨識期間影片片段已變更，請重新辨識。');
    }
    // FPS-SYNC: normal and partially recognized windows share one transaction
    // and the project grid frozen when the user started this job.
    return insertAsrSubtitles(results.splice(0), {
      trackNameForSegment:segment => segment.kind === 'dialogue' ? '畫面對白' : '畫面字卡',
      historyLabel:'辨識畫面文字', requireValidTimes:true, allowPartialValidTimes:true, allowOverlap:true,
      preserveSelection:preserveSelection(), boundToPlacement:plan.scope !== 'clip' || stopMode === 'keep',
      timelineFps:plan.fps, timelineDropFrame:plan.dropFrame,
    });
  };
  try {
    for (; index < windows.length; index++) {
      const { path, start, end } = windows[index];
      requestId = crypto.randomUUID();
      const result = await bridge.recognizeScreenText({ requestId, path, start, end,
        provider, model, sourceLang, samplesPerSecond:sampleFps, frameWidth, smartAccuracy });
      requestId = null;
      if (!ownsWorkspace() || stopMode === 'discard' || (result.cancelled && stopMode !== 'keep')) throw cancelled();
      appendWindowCues(results, result.cues, windows[index], windows[index - 1], result.processedEnd);
      if (stopMode === 'keep') {
        const count = results.reduce((total, group) => total + group.segments.length, 0);
        if (!count) throw cancelled();
        return { count, commitPartial:commit };
      }
      processedSeconds += end - start;
    }
    return { count:commit() };
  } catch (error) {
    if (stopMode === 'discard' || !ownsWorkspace()) throw cancelled();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    release();
    unsubscribe();
  }
}

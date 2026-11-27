import { audioMotherPath } from '../shared/audio-loudness.cjs';
import { SCREEN_TEXT_DEFAULTS as DEFAULTS, SCREEN_TEXT_DEFAULT_MODELS } from '../shared/screen-text-options.cjs';
import { Media } from './media.js';
import { Project } from './project.js';
import { getRecognitionClipRange, resolveRecognitionRange, sliceRecognitionClip } from './recognition-range.js';
import { Seq } from './sequence.js';
import { insertAsrSubtitles } from './speech-recognition.js';
import { State, videoTrackVisible } from './state.js';
import { combineScreenTextMetrics, screenTextUsageLabel } from './screen-text-usage.js';

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

export function screenTextTrialPlan(clip, scope) {
  const whole=getScreenTextPlan(clip,scope),cursor=Media.displayTime?.();
  const start=cursor>=whole.range.start&&cursor<whole.range.end?cursor:whole.range.start;
  const range={start,end:Math.min(whole.range.end,start+20)};
  const windows=whole.windows.flatMap(window=>{
    const slice=sliceRecognitionClip(window.placement,range);
    return slice?[sourceWindow(window.clip,slice,range)]:[];
  });
  if(!windows.length)throw new Error('播放點附近 20 秒沒有可用的影片畫面。');
  return {...whole,range,windows,trial:true};
}

function planIsCurrent(plan, clip) {
  let windows;
  try {
    windows = plan.scope === 'clip' ? selectedClipWindow(clip).windows
      : visibleSourceWindows(plan.range, Project.unrestoredClips());
    if(plan.trial && plan.scope==='clip')windows=windows.flatMap(window=>{
      const slice=sliceRecognitionClip(window.placement,plan.range);
      return slice?[sourceWindow(window.clip,slice,plan.range)]:[];
    });
  } catch { return false; }
  return windows.length === plan.windows.length && windows.every((item,index) => {
    const saved = plan.windows[index];
    return item.clip === saved.clip && item.path === saved.path
      && Object.keys(item.placement).every(key => item.placement[key] === saved.placement[key]);
  });
}

function appendWindowCues(results, cues, window, previousWindow, provider, processedEnd = window.end) {
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
      text:cue.text, kind:cue.kind === 'dialogue' ? 'dialogue' : 'card', slot:cue.slot,
      parts:[{clipId:window.clip.id,path:window.path,start:cue.start,end:cue.end}],
      recognition:{kind:'screen',screenKind:cue.kind==='dialogue'?'dialogue':'card',provider,originalText:cue.originalText??cue.text,timingEvidence:'frame',sourceId:window.clip.id,
        sourceStart:cue.start,sourceEnd:cue.end,slot:cue.slot} };
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
    if (previous) {
      previous.end = segment.end;previous.parts.push(...segment.parts);
      previous.recognition.sourceStart=Math.min(previous.recognition.sourceStart,segment.recognition.sourceStart);
      previous.recognition.sourceEnd=Math.max(previous.recognition.sourceEnd,segment.recognition.sourceEnd);
    }
    else group.segments.push(segment);
  }
}

export async function recognizeClipText(clip, {
  provider = DEFAULTS.provider, model = SCREEN_TEXT_DEFAULT_MODELS[provider], sourceLang = DEFAULTS.sourceLang,
  sampleFps = DEFAULTS.sampleFps, frameWidth = DEFAULTS.frameWidth, smartAccuracy = DEFAULTS.smartAccuracy,
  contentMode, region, maxNewRequests, reviewMode, stageReview,
  signal, onProgress, preserveSelection = () => false,
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
  const totals={};
  let lastMetrics={},receivedMetrics=false;
  const totalMetrics = current=>combineScreenTextMetrics(totals,current);
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
    if(event.metrics){receivedMetrics=true;Object.assign(lastMetrics,event.metrics);}
    onProgress?.({ ...event, ...(event.metrics?{metrics:totalMetrics(lastMetrics)}:{}), progress:(processedSeconds + event.progress * seconds) / totalSeconds,
      message:windows.length > 1 ? `第 ${index + 1}／${windows.length} 段 · ${event.message || '正在辨識畫面文字'}` : event.message });
  });
  const release = Project.onWorkspaceInvalidated(() => stop('discard'));
  signal?.addEventListener('abort', onAbort, { once:true });
  const results = [];
  const apply = groups => insertAsrSubtitles(groups, {
    trackNameForSegment:segment => segment.kind === 'dialogue' ? '畫面對白' : '畫面字卡',
    historyLabel:'辨識畫面文字', requireValidTimes:true, allowPartialValidTimes:true, allowOverlap:true,
    preserveSelection:preserveSelection(), boundToPlacement:plan.scope !== 'clip' || plan.trial || stopMode === 'keep',
    timelineFps:plan.fps, timelineDropFrame:plan.dropFrame,
  });
  let staged=false;
  function rebase(groups) {
    const updated=[];
    for(const group of groups)for(const segment of group.segments){
      const spans=[];
      for(const part of segment.parts||[]){
        const live=State.clips.find(c=>c.id===part.clipId);
        if(!live||screenTextSourcePath(live)!==part.path||part.start<live.in-1e-7||part.end>live.out+1e-7)return null;
        const times=[part.start,part.end].map(t=>Seq.toTimeline(t,live)).sort((a,b)=>a-b);
        if(plan.scope!=='clip'){
          let visible;
          try{visible=visibleSourceWindows({start:times[0],end:times[1]},Project.unrestoredClips());}catch{return null;}
          if(visible.length!==1||visible[0].clip!==live)return null;
        }
        spans.push(times);
      }
      if(!spans.length || spans.some((span,i)=>i>0&&Math.abs(span[0]-spans[i-1][1])>1e-7))return null;
      const offset=spans[0][0],duration=spans.at(-1)[1]-offset;
      updated.push({clip:{offset,in:0,out:duration},segments:[{...segment,start:0,end:duration}]});
    }
    return updated;
  }
  async function rerun(group,i,signal){
    const segment=group.segments[i],parts=segment.parts;
    if(!parts?.length)return null;
    const first=parts[0], sourceStart=Math.min(...parts.map(p=>p.start)),sourceEnd=Math.max(...parts.map(p=>p.end));
    const bounds=windows.filter(w=>w.path===first.path && parts.some(part=>part.clipId===w.clip.id));
    if(!bounds.length)return null;
    const start=Math.max(Math.min(...bounds.map(w=>w.start)),sourceStart-.5),end=Math.min(Math.max(...bounds.map(w=>w.end)),sourceEnd+.5,start+30);
    const id=crypto.randomUUID(),abort=()=>{void bridge.cancelScreenText(id).catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    try{
      const res=await bridge.recognizeScreenText({requestId:id,path:first.path,start,end,provider,model,sourceLang,samplesPerSecond:sampleFps,frameWidth,smartAccuracy,
        ...(contentMode&&{contentMode}),...(region&&{region}),...(Number.isInteger(maxNewRequests)&&{maxNewRequests:Math.max(0,maxNewRequests-(totals.newRequests||0))})});
      if(res.metrics)Object.assign(totals,totalMetrics(res.metrics));
      if(signal.aborted)throw cancelled();
      if(res.error)throw new Error(res.error);
      const overlap=s=>Math.min(sourceEnd,s.end)-Math.max(sourceStart,s.start);
      const best=(res.cues||[]).filter(s=>s.kind===segment.kind && (!segment.slot||!s.slot||s.slot===segment.slot) && overlap(s)>0).sort((a,b)=>overlap(b)-overlap(a))[0];
      return best?{...segment,text:best.text}:null;
    }finally{signal.removeEventListener('abort',abort);}
  }
  const commit = () => {
    if (!ownsWorkspace() || stopMode === 'discard') throw cancelled();
    if(stageReview && results.some(group=>group.segments.length) && (reviewMode || !planIsCurrent(plan,clip))){
      staged=true;
      return stageReview({groups:results,fps:plan.fps,dropFrame:plan.dropFrame,changed:()=>!planIsCurrent(plan,clip),apply,rebase,rerun,
        usage:()=>screenTextUsageLabel(totals),rerunLabel:maxNewRequests===0?'僅用快取重跑這段':'僅重跑這段（雲端可能計費）'});
    }
    if (!planIsCurrent(plan, clip)) {
      throw new Error('辨識期間影片片段已變更，請重新辨識。');
    }
    // FPS-SYNC: normal and partially recognized windows share one transaction
    // and the project grid frozen when the user started this job.
    return apply(results.splice(0));
  };
  try {
    for (; index < windows.length; index++) {
      const { path, start, end } = windows[index];
      requestId = crypto.randomUUID();
      lastMetrics={};
      const result = await bridge.recognizeScreenText({ requestId, path, start, end,
        provider, model, sourceLang, samplesPerSecond:sampleFps, frameWidth, smartAccuracy,
        ...(contentMode?{contentMode}:{}),...(region?{region}:{}),
        ...(Number.isInteger(maxNewRequests)?{maxNewRequests:Math.max(0,maxNewRequests-(totals.newRequests||0))}:{}) });
      requestId = null;
      if(result.metrics){receivedMetrics=true;Object.assign(lastMetrics,result.metrics);}
      Object.assign(totals,totalMetrics(lastMetrics));
      if(result.cancelled&&result.error&&stopMode!=='discard')stopMode='keep';
      if (!ownsWorkspace() || stopMode === 'discard' || (result.cancelled && stopMode !== 'keep')) throw cancelled();
      appendWindowCues(results, result.cues||[], windows[index], windows[index - 1], provider, result.processedEnd);
      if (stopMode === 'keep') {
        const count = results.reduce((total, group) => total + group.segments.length, 0);
        if (!count) {if(result.error)throw Object.assign(new Error(result.error),{metrics:totals});throw cancelled();}
        return { count, commitPartial:commit, wasStaged:()=>staged, error:result.error, metrics:totals };
      }
      processedSeconds += end - start;
    }
    const count=commit();
    return { count,...(staged?{review:true}:{}),...(receivedMetrics?{metrics:totals}:{}) };
  } catch (error) {
    if (stopMode === 'discard' || !ownsWorkspace()) throw cancelled();
    const count=results.reduce((total,group)=>total+group.segments.length,0);
    if(requestId && error?.name!=='AbortError'){
      Object.assign(totals,totalMetrics(lastMetrics));
      if(count){
        stopMode='keep';
        return {count,commitPartial:commit,wasStaged:()=>staged,error:error.message,metrics:totals};
      }
      if(receivedMetrics)throw Object.assign(new Error(error.message),{metrics:totals});
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    release();
    unsubscribe();
  }
}

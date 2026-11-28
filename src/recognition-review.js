import { Project } from './project.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { State } from './state.js';
import { secToEncore, getExactFps, snapTimeToFrame } from './time.js';
import { openModal, showToast } from './ui.js';

const pending = new Map();
function segmentInterval(clip, segment) {
  if (segment.timed === false || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return null;
  const placement = { ...clip, in:clip.in ?? clip.trimStart ?? 0, out:clip.out ?? clip.trimEnd ?? clip.duration ?? clip.dur,
    offset:clip.offset ?? clip.start ?? 0 };
  return [segment.start, segment.end].map(t => Seq.toTimeline(placement.in + t, placement)).sort((a,b)=>a-b);
}
const reasonFor = segment => {
  if (segment.timed === false || !Number.isFinite(segment.start)) return '未定時';
  const timing = segment.alignment?.timingEvidence ?? segment.timingEvidence;
  if (timing === 'interpolated') return '推估時間';
  if (timing === 'segment' || (!segment.kind && !segment.words?.length && !timing)) return '句級時間';
  if (segment.needsReview || segment.alignment?.status === 'review') return '需要複核';
  return '';
};

export function stageRecognitionReview(kind, { groups, fps, dropFrame, changed, apply, retry, rerun, rerunLabel, rebase, onResolve, usage, terms = [] }) {
  pending.get(kind)?.forget();
  const owns = Project.captureWorkspaceOwnership();
  const rows = groups.flatMap((group, groupIndex) => {
    const groupRows=group.segments.map((segment, index) => {
    const interval=segmentInterval(group.clip,segment);
    const frames=interval?.map(time=>snapTimeToFrame(time,fps,dropFrame));
    const short=frames && frames[0]===frames[1] ? '起訖落在同一格' :
      segment.kind==='card' && interval && interval[1]-interval[0]<=1.5/getExactFps(fps) ? '短暫字卡' : '';
      const corner=segment.kind==='card' && ['top_left','top_right'].includes(segment.slot) && segment.end-segment.start>=20;
      return {groupIndex,index,original:segment.originalText??segment.recognition?.originalText??segment.text,
        text:segment.text,keep:true,reason:short||reasonFor(segment)||(corner?'長時間固定角標':'')};
    });
    const active=new Map();
    for(const row of groupRows.slice().sort((a,b)=>group.segments[a.index].start-group.segments[b.index].start)){
      const segment=group.segments[row.index];
      if(segment.timed===false || !(segment.end>segment.start))continue;
      const slot=segment.slot || (segment.speaker!=null?'speech':null);
      if(!slot)continue;
      const previous=active.get(slot);
      if(previous && segment.start<previous.segment.end && segment.text!==previous.segment.text){
        const label=segment.slot?'同一位置的文字時段重疊':'語音時段重疊';
        row.reason=label;previous.row.reason=label;
      }
      if(!previous || segment.end>previous.segment.end)active.set(slot,{segment,row});
    }
    return groupRows;
  });
  let unsubscribe;
  const review = { groups, rows, terms, fps, dropFrame, changed, apply, retry, rerun, rerunLabel, rebase, usage, owns,
    forget() { if (pending.get(kind) === review) pending.delete(kind); unsubscribe?.();review.dismiss?.();onResolve?.(); } };
  pending.set(kind, review);
  unsubscribe = Project.onWorkspaceInvalidated(review.forget);
  return rows.length;
}

export function openRecognitionReview(kind) {
  const review = pending.get(kind);
  if (!review?.owns()) return false;
  let position = 0, indices = review.rows.map((_, index) => index), modal;
  const field = id => document.getElementById('recognitionReview'+id);
  const changed = () => !!review.changed?.();
  const filteredGroups = () => review.groups.map((group, groupIndex) => ({ ...group,
    segments:group.segments.flatMap((segment, index) => {
      const row = rowMaps[groupIndex][index];
      return row.keep && row.text.trim() ? [{ ...segment, ...row.approved, originalText:segment.originalText??row.original, text:row.text.trim() }] : [];
    }) }));
  const rowMaps = review.groups.map(() => []);
  for (const row of review.rows) rowMaps[row.groupIndex][row.index] = row;
  const row = () => review.rows[indices[position]];
  function apply() {
    if (!modal.isCurrent() || !review.owns()) return;
    const moved = changed();
    if (moved && !field('Position').value) { render(); field('Position').focus(); return; }
    let groups = filteredGroups();
    if (moved && field('Position').value === 'current') {
      groups = review.rebase?.(groups);
      if (!groups) { field('Status').textContent='來源已移除或範圍超出新剪點，請選原位置或重新辨識。'; return; }
    }
    if (!groups.some(group => group.segments.length)) { field('Status').textContent='請先保留至少一則候選。'; return; }
    try {
      const count = review.apply(groups);
      if(!count){field('Status').textContent='選取的結果未達一個可加入的畫格。';return;}
      review.forget(); showToast(`已加入 ${count} 句字幕。`);
    } catch (error) { field('Status').textContent = error.message; }
  }
  function bounds(context = false) {
    const entry = row(); if (!entry) return null;
    const { clip, segments } = review.groups[entry.groupIndex];
    let segment = entry.approved || segments[entry.index];
    if (context && (segment.timed === false || !Number.isFinite(segment.start))) {
      const before = segments.slice(0,entry.index).findLast(s=>s.timed!==false && Number.isFinite(s.end));
      const after = segments.slice(entry.index+1).find(s=>s.timed!==false && Number.isFinite(s.start));
      if(!before && !after)return null;
      const start=Math.max(0,(before?.end ?? after.start)-1.5);
      const end=Math.min(Number(clip.out??clip.trimEnd??clip.dur)-(clip.in??clip.trimStart??0),start+10,(after?.start??start+8)+1.5);
      segment={start,end};
    }
    return segmentInterval(clip,segment);
  }
  function render() {
    const entry = row(), interval = bounds(), moved = changed();
    field('Moved').hidden = !moved;
    field('Index').textContent = entry ? `第 ${indices[position]+1} 行　${position+1} / ${indices.length}` : '沒有符合的候選';
    field('Reason').textContent = entry ? entry.reason || '辨識結果' : '';
    field('Text').value = entry?.text || '';
    field('Original').textContent = entry?.original || '';
    const segment=entry && review.groups[entry.groupIndex].segments[entry.index];
    field('Evidence').textContent=[segment?.heardText && '對應語音：'+segment.heardText,
      segment?.speaker!=null && '說話者：'+segment.speaker,segment?.slot && '畫面位置：'+segment.slot].filter(Boolean).join('\n');
    const exact=review.terms.filter(term => entry?.text.includes(term));
    const similar=review.terms.filter(term=>!exact.includes(term) && term.length>=3 &&
      [...term].some((_,i,letters)=>i+1<letters.length && entry?.text.includes(letters.slice(i,i+2).join(''))));
    field('Words').textContent=[exact.length && '命中專案詞：'+exact.join('、'),similar.length && '相似專案詞：'+similar.join('、')].filter(Boolean).join('\n');
    field('Compare').textContent = interval ? (State.cues||[]).filter(cue=>cue.timed!==false && cue.start<interval[1] && cue.end>interval[0] &&
      (kind==='speech'?(cue.recognition?.screenKind??cue.kind)==='dialogue' || State.tracks?.[cue.track]?.name==='畫面對白'
        :['speech','alignment'].includes(cue.recognition?.kind) || ['語音辨識','文本匹配'].includes(State.tracks?.[cue.track]?.name))).map(cue=>cue.text).join('\n') : '';
    field('Compare').parentElement.hidden=!field('Compare').textContent;
    field('Keep').checked = !!entry?.keep;
    field('Time').textContent = interval ? interval.map(t=>secToEncore(t, review.fps, review.dropFrame)).join(' → ') : '未定時';
    field('Back').disabled = position <= 0;
    field('Next').disabled = position + 1 >= indices.length;
    for (const id of ['Text','Keep']) field(id).disabled=!entry;
    const hasContext=!!bounds(true) && !moved;
    for (const id of ['Before','In','Out','After','Play']) field(id).disabled=!hasContext;
    field('Play').textContent=interval?'播放這句':'播放相鄰語境';
    field('Rerun').hidden=!review.rerun;
    field('Rerun').textContent=review.rerunLabel||'僅重跑這段';
    field('Rerun').disabled=!entry || moved || !!job;
    field('Suggestion').hidden=!entry?.suggestion;
    field('SuggestedText').textContent=entry?.suggestion?.text||'';
    field('UseSuggestion').disabled=!entry?.suggestion;
    field('Usage').textContent=review.usage?.()||'';
    field('Usage').parentElement.hidden=!review.usage;
  }
  const html = `<div class="asr-workspace recognition-review"><div id="recognitionReviewMoved" hidden><p>辨識後來源位置已變更。請選擇字幕位置。</p>
    <select id="recognitionReviewPosition" aria-label="字幕位置"><option value="">選擇位置…</option><option value="original">保留開始辨識時的位置</option>
    ${review.rebase ? '<option value="current">按目前來源位置重新對位</option>' : ''}</select></div>
    <label>顯示 <select id="recognitionReviewFilter"><option value="all">全部候選</option><option value="issues">待核對</option></select></label>
    <div class="review-paging"><button id="recognitionReviewBack" type="button">上一則</button><output id="recognitionReviewIndex"></output><button id="recognitionReviewNext" type="button">下一則</button></div>
    <p class="review-timing"><strong id="recognitionReviewReason"></strong><span id="recognitionReviewTime"></span></p>
    <label>字幕文字<textarea id="recognitionReviewText" rows="3" dir="auto"></textarea></label>
    <div class="review-transport"><button type="button" id="recognitionReviewBefore">起點前一格</button><button type="button" id="recognitionReviewIn">定位起點</button><button type="button" id="recognitionReviewOut">定位末格</button><button type="button" id="recognitionReviewAfter">定位 Out 點</button><button type="button" id="recognitionReviewPlay">播放這句</button></div>
    <details><summary>原始文字、時間依據與專案詞</summary><p id="recognitionReviewOriginal" dir="auto"></p><p id="recognitionReviewEvidence"></p><p id="recognitionReviewWords"></p></details>
    <details hidden><summary>同時段的${kind==='speech'?'畫面對白':'語音／文本匹配'}</summary><p id="recognitionReviewCompare"></p></details>
    <details hidden><summary>本次辨識用量</summary><p id="recognitionReviewUsage"></p></details>
    <button type="button" id="recognitionReviewRerun">僅重跑這段</button><div id="recognitionReviewSuggestion" hidden><p id="recognitionReviewSuggestedText"></p><button type="button" id="recognitionReviewUseSuggestion">採用這次建議</button></div>
    <label><input type="checkbox" id="recognitionReviewKeep"> 加入這則字幕</label><p id="recognitionReviewStatus" role="status"></p></div>`;
  let playing=false, timer=null, alive=true, job=null, transportGeneration=0;
  const stop = () => { transportGeneration++;clearTimeout(timer); if (playing) Media.pause(); playing=false; };
  const close = () => { alive=false; stop(); job?.abort();review.dismiss=null; };
  modal=openModal('複核候選字幕', html, [
    { label:'稍後複核', act:()=>modal.close() },
    { label:'捨棄候選', act:()=>review.forget() },
    ...(review.retry ? [{ label:'重設整段辨識', act:()=>{ review.forget();review.retry(); } }] : []),
    { label:'加入新字幕軌', primary:true,enterDefault:true, act:apply },
  ], { width:'600px', keepVideo:true, onDismiss:close, onReplaced:close });
  review.dismiss=()=>{ if(modal.isCurrent()){close();modal.close({committed:true});} };
  if (!field('Text')) return true;
  field('Filter').onchange = () => {
    stop();indices=review.rows.flatMap((item,i) => field('Filter').value==='all'||item.reason ? [i] : []);
    position=0;render();
  };
  field('Text').oninput=()=>{row().text=field('Text').value;};
  field('Keep').onchange=()=>{row().keep=field('Keep').checked;};
  field('Rerun').onclick=async()=>{
    const entry=row();
    if(!entry || job || changed() || !review.owns())return;
    const controller=new AbortController();job=controller;
    render();field('Status').textContent='正在重跑這段，已編輯的文字仍會保留。';
    try{
      entry.suggestion=await review.rerun(review.groups[entry.groupIndex],entry.index,controller.signal);
      if(alive && !controller.signal.aborted && entry===row())field('Status').textContent=entry.suggestion?'已取得新建議。採用後才會更新這則候選。':'在附近找不到可採用的結果。';
    }catch(error){if(alive && !controller.signal.aborted)field('Status').textContent=error.message;}
    finally{job=null;if(alive)render();}
  };
  field('UseSuggestion').onclick=()=>{
    const entry=row();if(!entry?.suggestion)return;
    entry.approved=entry.suggestion;
    if(!entry.approved.alignment)entry.text=entry.approved.text;
    entry.reason=reasonFor(entry.approved);entry.suggestion=null;render();
  };
  function go(step){stop();position+=step;field('Status').textContent='';render();}
  field('Back').onclick=()=>go(-1);
  field('Next').onclick=()=>go(1);
  const locate = async action => {
    stop(); const span=bounds(true);
    if (!span || !review.owns() || changed()) {render();return;}
    const generation=transportGeneration;
    const [first,out]=span.map(time=>snapTimeToFrame(time,review.fps,review.dropFrame));
    const frame=1/getExactFps(review.fps);
    const targets={Before:Math.max(0,first-frame),In:first,Out:Math.max(first,out-frame),After:out,Play:first};
    await Media.seek(targets[action]);
    if (action==='Play' && alive && generation===transportGeneration && review.owns() && !changed()) {
      playing=true;Media.play();timer=setTimeout(stop,Math.min(30,span[1]-span[0])*1000);
    }
  };
  for(const id of ['Before','In','Out','After','Play'])field(id).onclick=()=>locate(id).catch(error=>{if(alive)field('Status').textContent=error.message;});
  render();return true;
}

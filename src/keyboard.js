/* SUB Tool — 鍵盤快捷鍵 + I/O 上字幕 + 邊界步進 + JKL 穿梭輪 */
import { $, video, sublist } from './dom.js';
import { State, cueSuffix } from './state.js';
import { clamp } from './util.js';
import { fmtClock, secToEncore } from './time.js';
import { Media } from './media.js';
import { addCue, selectCue, selectCueSingle, deleteSelected, addCueRelative, sortCues, cancelSwapMode, refreshSelectionUI, copyCues, pasteCues } from './subtitles.js';
import { updatePlayhead, zoomFit, zoomFitVideo, setZoom, drawTimeline } from './timeline.js';
import { Project, ensureProjectSaved } from './project.js';
import { History, recordHistory, renderHistory } from './history.js';
import { addNote, renderNotes, updateNoteActive } from './notes.js';
import { emit } from './events.js';
import { setStatus, closeModal, showOsd } from './ui.js';

/* ===== JKL 穿梭輪 ======================================================= */
/* _jklSpeed: 0=暫停, 1=正常播放, 2=2x播放, -1=1x倒帶, -2=2x倒帶 */
let _jklSpeed = 0;
let _jklTimer = null;

function jklClear(){
  if(_jklTimer){ clearInterval(_jklTimer); _jklTimer=null; }
}
function updateSpeedIndicator(){
  const el = document.getElementById('speedIndicator');
  if(!el) return;
  if (_jklSpeed === 0 || _jklSpeed === 1) {
    el.textContent = '1x';
    el.style.color = 'var(--text-faint)';
  } else if (_jklSpeed < 0) {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#ff4444';
  } else {
    el.textContent = _jklSpeed + 'x';
    el.style.color = '#44ff44';
  }
}
function resetPlaybackSpeed(){
  jklClear();
  _jklSpeed=0;
  Media.setRate(1);
  updateSpeedIndicator();
}
function jklApply(){
  jklClear();
  if(_jklSpeed===0){
    Media.pause();
    Media.setRate(1);
  } else if(_jklSpeed>0){
    Media.setRate(_jklSpeed);
    if(!Media.playing) Media.play();
  } else {
    // 負速度：暫停影片，用 interval 逐格倒退
    Media.pause();
    Media.setRate(1);
    const fps=30, step=Math.abs(_jklSpeed)/fps;
    const capturedSpeed=_jklSpeed;
    _jklTimer=setInterval(()=>{
      if(_jklSpeed!==capturedSpeed){ jklClear(); return; }
      const t=Media.vTime();
      if(t<=0){ jklClear(); _jklSpeed=0; setStatus('已到開頭',''); return; }
      const newT = Math.max(0,t-step);
      Media.seek(newT);
      updatePlayhead();
      emit('playhead:ensure');
      emit('render:videoSub');
      if(!video.src){
        $('tcCur').textContent=secToEncore(Media.vTime(),State.fps,State.dropFrame);
        $('seekBar').value=Math.round(Media.vTime()*1000);
      }
      Media.scrubAudio(newT, Math.max(step, 0.08));
    }, 1000/fps);
  }
  const spd=Math.abs(_jklSpeed);
  const label=_jklSpeed===0?'暫停':(_jklSpeed>0?`▶ ${spd}x 正播`:`◀ ${spd}x 倒帶`);
  const osd=_jklSpeed===0?'⏸':(_jklSpeed>0?`▶ ${spd}×`:`◀ ${spd}×`);
  setStatus(label, _jklSpeed!==0?'ok':'');
  showOsd(osd);
  updateSpeedIndicator();
}
/* 停止並重置 JKL（從外部呼叫，例如時間軸拖曳） */
function jklReset(){
  jklClear();
  _jklSpeed=0;
  Media.pause();
  Media.setRate(1);
  updateSpeedIndicator();
}

/* ===== 7. 鍵盤 (I/O 上字幕) =========================================== */
/* I = 設定目前被選字幕的「開始點」為播放點；無選取則新建一條 */
async function setIn(){
  await ensureProjectSaved();
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移',''); return; }
  const t=Media.vTime();
  let c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ c=addCue(t,t+2,'',0); selectCue(c.id); recordHistory('新增字幕(I)'); setStatus('已新增字幕，起點 '+fmtClock(t),'ok'); return; }
  c.start=t; if(c.end<=c.start)c.end=c.start+0.5; c.timed=true;
  sortCues(); emit('render:all'); selectCue(c.id); State.activeEdge='start';
  recordHistory('設定起點 I'+cueSuffix(c)); setStatus('起點 '+fmtClock(t),'ok');
}
/* O = 設定目前被選字幕的「結束點」為播放點 */
async function setOut(){
  await ensureProjectSaved();
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移',''); return; }
  const t=Media.vTime();
  const c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ setStatus('請先選擇字幕（或按 I 新建）',''); return; }
  if(t<=c.start){ setStatus('終點不得早於或等於起點',''); return; }
  c.end=t; c.timed=true;
  sortCues(); emit('render:all'); selectCue(c.id); State.activeEdge='end';
  recordHistory('設定終點 O'+cueSuffix(c)); setStatus('終點 '+fmtClock(c.end),'ok');
  autoAdvanceSubMode();
}
/* 上字幕模式：O 後自動選取下一句，全部完成則關閉模式 */
function autoAdvanceSubMode(){
  if(!State.subMode)return;
  const sel=State.cues.find(c=>c.id===State.selectedId); if(!sel)return;
  const tk=sel.track||0;
  const trackCues=State.cues.filter(c=>(c.track||0)===tk);
  const idx=trackCues.findIndex(c=>c.id===State.selectedId);
  if(idx>=0&&idx<trackCues.length-1){
    selectCueSingle(trackCues[idx+1].id,false);
    setStatus('🎯 上字幕模式：下一句選中 — 按 I 設起點','ok');
  }else{
    State.subMode=false;
    const btn=$('subModeBtn'); if(btn)btn.classList.remove('sub-active');
    jklReset();
    setStatus('🎯 上字幕模式：所有字幕完成 ✓','ok');
  }
}

const editingText=()=>document.activeElement?.classList.contains('txt')&&document.activeElement.contentEditable==='true';
window.addEventListener('keydown',e=>{
  if($('modalBg').classList.contains('show')){ if(e.key==='Escape')closeModal(); return; }
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(editingText()){
    // 編輯字幕時僅允許少數快捷
    return;
  }
  const k=e.key.toLowerCase();
  switch(k){
    case ' ':
      e.preventDefault();
      jklClear(); _jklSpeed=0; Media.setRate(1); updateSpeedIndicator();
      Media.toggle();
      setStatus(Media.playing?'▶ 正播':'⏸ 暫停', Media.playing?'ok':''); // 狀態列同步播放/暫停（非僅 JKL）
      break;
    case 'j': // 倒帶：-1 → -5 (每階 -0.5)
      e.preventDefault();
      if(_jklSpeed>=0) _jklSpeed=-1;
      else _jklSpeed=Math.max(-5, _jklSpeed-0.5);
      jklApply(); break;
    case 'k': // 暫停
      e.preventDefault(); _jklSpeed=0; jklApply(); break;
    case '2':
      e.preventDefault();
      jklClear(); _jklSpeed=0; video.playbackRate=1; Media.pause();
      jumpToCueInMinusFrames(1, 5);
      break;
    case '5':
      e.preventDefault();
      jklClear(); _jklSpeed=0; video.playbackRate=1; Media.pause();
      jumpToCueInMinusFrames(-1, 5);
      break;
    case 'l': // 正播：1 → 5 (每階 0.5)
      e.preventDefault();
      if(_jklSpeed<=0) _jklSpeed=1;
      else _jklSpeed=Math.min(5, _jklSpeed+0.5);
      jklApply(); break;
    case 'i': e.preventDefault(); setIn(); break;
    case 'o': e.preventDefault(); setOut(); break;
    case 'arrowleft':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ nudge(-5); }   // Ctrl+Shift = 後退 5 秒
      else if(e.ctrlKey||e.metaKey){ jumpToNote(-1); }       // Ctrl = 跳到上一個備註點
      else if(e.shiftKey){ nudge(-1); }                      // Shift = 後退 1 秒
      else if(e.repeat){ if(_jklSpeed>=0){_jklSpeed=-1;jklApply();} }
      else nudge(-1/State.fps);                              // 後退 1 格
      break;
    case 'arrowright':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ nudge(5); }    // Ctrl+Shift = 前進 5 秒
      else if(e.ctrlKey||e.metaKey){ jumpToNote(1); }        // Ctrl = 跳到下一個備註點
      else if(e.shiftKey){ nudge(1); }                       // Shift = 前進 1 秒
      else if(e.repeat){ if(_jklSpeed<=0){_jklSpeed=1;jklApply();} }
      else nudge(1/State.fps);                               // 前進 1 格
      break;
    case 'arrowup':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ jumpToFirstLastCue(-1); }
      else if(e.shiftKey){ seekHome(); }
      else if(e.ctrlKey||e.metaKey){ 
        if(Media.playing) Media.pause();
        stepBoundary(-1); 
      }
      else jumpToAdjacentCue(-1);
      break;
    case 'arrowdown':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ jumpToFirstLastCue(1); }
      else if(e.shiftKey){ seekEnd(); }
      else if(e.ctrlKey||e.metaKey){ 
        if(Media.playing) Media.pause();
        stepBoundary(1); 
      }
      else jumpToAdjacentCue(1);
      break;
    case 'home': e.preventDefault(); seekHome(); break;
    case 'end': e.preventDefault(); seekEnd(); break;
    case 'enter': e.preventDefault(); { const sel=State.selectedId; if(sel){ const row=sublist.querySelector(`.sub-row[data-id="${sel}"]`); if(row)row.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window})); } } break;
    case 'delete': if(State.selectedIds.length||State.selectedId){e.preventDefault();deleteSelected();} break;
    case 'escape':
      cancelSwapMode();
      if(State.subMode){ e.preventDefault(); State.subMode=false;
        const esb=$('subModeBtn'); if(esb)esb.classList.remove('sub-active');
        jklReset(); setStatus('上字幕模式已關閉',''); }
      if(State.selectedId||State.selectedIds.length){
        e.preventDefault();
        State.selectedId=null; State.selectedIds=[];
        refreshSelectionUI();
      }
      break;
    case 'p': e.preventDefault(); {
      const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
      if(!ids.length)break;
      const jCues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
      if(!jCues.length)break;
      const minStart=Math.min(...jCues.map(c=>c.start));
      const jt=Media.vTime(), delta=jt-minStart;
      for(const jc of jCues){ jc.start=Math.max(0,jc.start+delta); jc.end=Math.max(jc.start+0.001,jc.end+delta); }
      sortCues(); emit('render:all'); drawTimeline();
      recordHistory('時間碼位移 P');
      setStatus(`P 位移 ${delta>=0?'+':''}${delta.toFixed(3)}s（${jCues.length} 條）`,'ok');
    } break;
    case 'a':
      if(e.ctrlKey||e.metaKey){
        e.preventDefault();
        const tkCues=State.cues.filter(c=>(c.track||0)===State.listTrack);
        if(tkCues.length){ State.selectedIds=tkCues.map(c=>c.id); State.selectedId=tkCues[0].id; refreshSelectionUI(); }
      } else { e.preventDefault(); emit('panel:toggle','historyPanel'); renderHistory(); }
      break;
    case 's':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); Project.save(); }
      else { e.preventDefault(); emit('panel:toggle','notesPanel'); renderNotes(); }
      break;
    case 'd': e.preventDefault(); emit('action','mixer'); break;
    case 'x':
      e.preventDefault();
      if(!State.subMode){
        const t=Media.vTime();
        const hit=State.cues.find(c=>(c.track||0)===State.listTrack&&c.timed!==false&&c.start<=t&&c.end>=t);
        if(hit) selectCue(hit.id,{seek:false});
        else setStatus('目前時間點無字幕','');
      }
      break;
    case 'c':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); copyCues(); }
      else { e.preventDefault(); setOut(); }
      break;
    case 'v':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); pasteCues(); }
      else { e.preventDefault(); addNote(); }
      break;
    case 'm': e.preventDefault(); addNote(); break;
    case 'f':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); const sd=document.getElementById('searchDialog'); if(sd){ const show=sd.style.display==='none'||!sd.style.display; sd.style.display=show?'flex':'none'; if(show)setTimeout(()=>document.getElementById('searchInput')?.focus(),20); } }
      else { e.preventDefault(); emit('action','check-panel'); }
      break;
    case ']': e.preventDefault(); zoomFit(); break;
    case 'z':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); e.shiftKey?History.redo():History.undo(); }
      else { e.preventDefault(); setIn(); }
      break;
    case '-': case '_': e.preventDefault(); setZoom(State.pxPerSec*0.77); break;
    case '+': case '=': e.preventDefault(); setZoom(State.pxPerSec*1.3); break;
    case '\\': case '|': e.preventDefault(); zoomFitVideo(); break;
  }
});
window.addEventListener('keyup',e=>{
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ if(_jklSpeed!==0)jklReset(); }
});
function nudge(d){ 
  const t=Media.vTime()+d; 
  Media.seek(t); 
  updatePlayhead(); 
  emit('playhead:ensure'); 
  updateNoteActive(t); 
  if (!Media.playing && Math.abs(d) < 0.2) {
    Media.scrubAudio(t);
  }
}
function seekHome(){ Media.seek(0); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(0); }
function seekEnd(){ const t=State.duration||0; Media.seek(t); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(t); }

/* Ctrl+左/右：跳到上一個/下一個備註時間點 */
function jumpToNote(dir){
  if(!State.notes.length) return;
  const t=Media.vTime(), EPS=1e-4;
  let target=null;
  if(dir>0){ for(const n of State.notes){ if(n.time>t+EPS&&(target===null||n.time<target.time))target=n; } }
  else      { for(const n of State.notes){ if(n.time<t-EPS&&(target===null||n.time>target.time))target=n; } }
  if(!target) return;
  Media.seek(target.time); updatePlayhead(); emit('playhead:ensure'); updateNoteActive(target.time);
}

/* Shift+Home/End：跳到同軌第一句 / 最後一句並選取 */
function jumpToFirstLastCue(dir){
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack&&c.timed!==false);
  if(!list.length)return;
  const target=dir<0?list[0]:list[list.length-1];
  selectCueSingle(target.id,false);
  Media.seek(target.start);
  _pendingStep=null;
  updatePlayhead();emit('playhead:ensure');
}

/* Ctrl+上/下：跳到同軌上一句/下一句的起點並選取 */
function jumpToAdjacentCue(dir){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  const track=sel?(sel.track||0):State.listTrack;
  const list=State.cues.filter(c=>(c.track||0)===track);
  if(!list.length) return;
  let idx;
  if(sel){
    idx=list.findIndex(c=>c.id===sel.id)+dir;
  } else {
    const t=Media.vTime();
    if(dir<0){
      idx=list.filter(c=>c.start<t-1e-4).length-1;
      if(Media.playing) idx -= 1;
    }
    else      idx=list.findIndex(c=>c.start>t+1e-4);
  }
  idx=Math.max(0,Math.min(list.length-1,idx));
  const target=list[idx];
  if(!target) return;
  if(Media.playing){
    State.selectedId=null;
    State.selectedIds=[];
    refreshSelectionUI();
    const stSel = document.getElementById('stSel');
    if(stSel) stSel.textContent='';
  } else {
    selectCueSingle(target.id, false);
  }
  Media.seek(target.start);
  _pendingStep=null;
  updatePlayhead(); emit('playhead:ensure');
}

function jumpToCueInMinusFrames(dir, frames){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  const track=sel?(sel.track||0):State.listTrack;
  const list=State.cues.filter(c=>(c.track||0)===track);
  if(!list.length) return;
  let idx;
  if(sel){
    idx=list.findIndex(c=>c.id===sel.id)+dir;
  } else {
    const t=Media.vTime();
    if(dir<0) idx=list.filter(c=>c.start<t-1e-4).length-1;
    else      idx=list.findIndex(c=>c.start>t+1e-4);
  }
  idx=Math.max(0,Math.min(list.length-1,idx));
  const target=list[idx];
  if(!target) return;
  selectCueSingle(target.id, false);
  const targetTime = Math.max(0, target.start - (frames / State.fps));
  Media.seek(targetTime);
  _pendingStep=null;
  updatePlayhead(); emit('playhead:ensure');
}

/* 上下鍵步進邏輯：
   - 只看被選字幕所在軌道的字幕
   - 向下：A.end → B.start(預覽，仍選A) → B.start(確認，切選B) → B.end → C.start(預覽) → ...
   - 向上：C.start → B.end(預覽，仍選C) → B.end(確認，切選B) → B.start → A.end(預覽) → ... */
let _pendingStep=null; // { cueId, edge, t, dir } — 等待確認的下一句

function stepBoundary(dir){
  const selCue=State.cues.find(c=>c.id===State.selectedId);

  if(!selCue){
    // 無選取：找播放點附近最近邊界（限當前軌道）
    const timed=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
    if(!timed.length)return;
    const bnd=[]; for(const c of timed){bnd.push({c,edge:'start',t:c.start});bnd.push({c,edge:'end',t:c.end});}
    const t=Media.vTime();
    let idx;
    if(dir>0){idx=bnd.findIndex(b=>b.t>t+1e-4);if(idx<0)idx=bnd.length-1;}
    else{idx=0;for(let i=0;i<bnd.length;i++){if(bnd[i].t<t-1e-4)idx=i;}}
    const b=bnd[idx]; selectCueSingle(b.c.id); State.activeEdge=b.edge;
    Media.seek(b.t); _pendingStep=null; emit('playhead:ensure'); updatePlayhead(); return;
  }

  // 只考慮被選字幕所在軌道
  const selTrack=selCue.track||0;
  const timed=State.cues.filter(c=>c.timed!==false&&(c.track||0)===selTrack);
  if(!timed.length)return;
  const bnd=[]; for(const c of timed){bnd.push({c,edge:'start',t:c.start});bnd.push({c,edge:'end',t:c.end});}

  // 有預覽中的字幕且方向相同 → 確認切換
  if(_pendingStep && _pendingStep.dir===dir && Math.abs(Media.vTime()-_pendingStep.t)<0.5){
    selectCueSingle(_pendingStep.cueId); State.activeEdge=_pendingStep.edge;
    _pendingStep=null; emit('playhead:ensure'); updatePlayhead(); return;
  }
  _pendingStep=null;

  const ci=timed.findIndex(c=>c.id===State.selectedId);
  const curIdx=ci*2+(State.activeEdge==='end'?1:0);
  const nextIdx=clamp(curIdx+dir,0,bnd.length-1);
  if(nextIdx===curIdx)return;
  const b=bnd[nextIdx];
  Media.seek(b.t);

  if(b.c.id===State.selectedId){
    State.activeEdge=b.edge; // 同一字幕內移動
  } else if(dir>0 && b.edge==='start'){
    _pendingStep={cueId:b.c.id, edge:b.edge, t:b.t, dir}; // 向下預覽：先到B.start，不切換選取
  } else if(dir<0 && b.edge==='end'){
    _pendingStep={cueId:b.c.id, edge:b.edge, t:b.t, dir}; // 向上預覽：先到B.end，不切換選取
  } else {
    selectCueSingle(b.c.id); State.activeEdge=b.edge;
  }
  emit('playhead:ensure'); updatePlayhead();
}

export { setIn, setOut, nudge, stepBoundary, jklReset, resetPlaybackSpeed };

/* SUB Tool — 鍵盤快捷鍵 + I/O 上字幕 + 邊界步進 + JKL 穿梭輪 */
import { $, video, sublist } from './dom.js';
import { State, cueSuffix } from './state.js';
import { clamp } from './util.js';
import { fmtClock, secToEncore, snapTimeToFrame } from './time.js';
import { Media } from './media.js';
import { addCue, selectCue, selectCueSingle, commitCueTimeEdit, deleteSelected, addCueRelative, sortCues, cancelSwapMode, refreshSelectionUI, copyCues, pasteCues, sweepContainedCues } from './subtitles.js';
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
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移','err'); return; }
  const t=Media.vTime();
  let c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ c=addCue(t,t+2,'',0); selectCue(c.id); recordHistory('新增字幕(I)'); setStatus('已新增字幕，起點 '+fmtClock(t),'ok'); return; }
  c.start=t; if(c.end<=c.start)c.end=c.start+0.5; c.timed=true;
  commitCueTimeEdit(c,'start'); // 局部更新（順序不變時不重建整列）
  recordHistory('設定起點 I'+cueSuffix(c)); setStatus('起點 '+fmtClock(t),'ok');
}
/* O = 設定目前被選字幕的「結束點」為播放點 */
async function setOut(){
  await ensureProjectSaved();
  if(State.selectedIds.length>1){ setStatus('多選模式 — 請用 P 鍵整體位移','err'); return; }
  const t=Media.vTime();
  const c=State.cues.find(x=>x.id===State.selectedId);
  if(!c){ setStatus('請先選擇字幕（或按 I 新建）','err'); return; }
  if(t<=c.start){ setStatus('終點不得早於或等於起點','err'); return; }
  c.end=t; c.timed=true;
  commitCueTimeEdit(c,'end'); // 局部更新（end 不影響排序，必走局部）
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
    setStatus(`🎯 上字幕 ${idx+2}/${trackCues.length} — 按 I 設起點`,'ok');
  }else{
    State.subMode=false;
    const btn=$('subModeBtn'); if(btn)btn.classList.remove('sub-active');
    document.body.classList.remove('sub-mode-on');
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
    case '1': e.preventDefault(); setZoom(State.pxPerSec*0.77); break;
    case '2': 
      e.preventDefault();
      if(e.code === 'Numpad2') jumpToCueInMinusFrames(1, 5);
      else setZoom(State.pxPerSec*1.3);
      break;
    case '5':
      e.preventDefault();
      if(e.code === 'Numpad5') jumpToCueInMinusFrames(-1, 5);
      break;
    case '7': e.preventDefault(); emit('action', 'history'); break;
    case '8': e.preventDefault(); emit('action', 'notes'); break;
    case '9': e.preventDefault(); emit('action', 'check-panel'); break;
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
    case 'e':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ jumpToFirstLastCue(-1); }
      else if(e.shiftKey){ seekHome(); }
      else if(e.ctrlKey||e.metaKey){ jumpToAdjacentCue(-1); }
      else {
        if(Media.playing) Media.pause();
        stepBoundary(-1);
      }
      break;
    case 'arrowdown':
    case 'd':
      e.preventDefault();
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ jumpToFirstLastCue(1); }
      else if(e.shiftKey){ seekEnd(); }
      else if(e.ctrlKey||e.metaKey){ jumpToAdjacentCue(1); }
      else {
        if(Media.playing) Media.pause();
        stepBoundary(1);
      }
      break;
    case 'home': e.preventDefault(); seekHome(); break;
    case 'end': e.preventDefault(); seekEnd(); break;
    case 'enter': e.preventDefault(); { const sel=State.selectedId; if(sel){ const row=sublist.querySelector(`.sub-row[data-id="${sel}"]`); if(row)row.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window})); } } break;
    case 'backspace':
    case 'delete': if(State.selectedIds.length||State.selectedId){e.preventDefault();deleteSelected();} break;
    case 'escape':
      cancelSwapMode();
      if(State.subMode){ e.preventDefault(); State.subMode=false;
        const esb=$('subModeBtn'); if(esb)esb.classList.remove('sub-active');
        document.body.classList.remove('sub-mode-on');
        jklReset(); setStatus('上字幕模式已關閉',''); }
      if(State.selectedId||State.selectedIds.length){
        e.preventDefault();
        State.selectedId=null; State.selectedIds=[];
        refreshSelectionUI();
        const stSel = document.getElementById('stSel');
        if(stSel) stSel.textContent='';
      }
      break;
    case 'p':
    case 'r': e.preventDefault(); {
      const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
      if(!ids.length)break;
      const jCues=ids.map(id=>State.cues.find(c=>c.id===id)).filter(c=>c&&c.timed!==false);
      if(!jCues.length)break;
      const minStart=Math.min(...jCues.map(c=>c.start));
      const jt=Media.vTime(), delta=jt-minStart;
      for(const jc of jCues){ jc.start=Math.max(0,jc.start+delta); jc.end=Math.max(jc.start+0.001,jc.end+delta); }
      sweepContainedCues(jCues);
      sortCues(); emit('render:all'); drawTimeline();
      recordHistory('時間碼位移 P');
      setStatus(`P 位移 ${delta>=0?'+':''}${delta.toFixed(3)}s（${jCues.length} 條）`,'ok');
    } break;
    case 'a':
      if(e.ctrlKey||e.metaKey){
        e.preventDefault();
        const tkCues=State.cues.filter(c=>(c.track||0)===State.listTrack);
        if(tkCues.length){ State.selectedIds=tkCues.map(c=>c.id); State.selectedId=tkCues[0].id; refreshSelectionUI(); }
      } else {
        e.preventDefault();
        if(State.selectedId){
          const c = State.cues.find(x => x.id === State.selectedId);
          if(c && c.timed !== false){
            Media.seek(c.start); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub');
          }
        }
      }
      break;
    case 's':
      if(e.ctrlKey||e.metaKey){
        e.preventDefault();
        if(e.shiftKey) Project.saveAs();
        else Project.save();
      }
      else {
        e.preventDefault();
        if(State.selectedId){
          const c = State.cues.find(x => x.id === State.selectedId);
          if(c && c.timed !== false){
            Media.seek(c.end); updatePlayhead(); emit('playhead:ensure'); emit('render:videoSub');
          }
        }
      }
      break;

    case 'q': e.preventDefault(); setIn(); break;
    case 'w': e.preventDefault(); setOut(); break;
    case 'z':
      if((e.ctrlKey||e.metaKey)&&e.shiftKey){ e.preventDefault(); emit('action','redo'); }
      else if(e.ctrlKey||e.metaKey){ e.preventDefault(); emit('action','undo'); }
      else { e.preventDefault(); emit('action','toggle-auto-select'); }
      break;
    case 'x':
      e.preventDefault();
      emit('action', 'toggle-overwrite');
      break;
    case 'c':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); copyCues(); }
      else { e.preventDefault(); emit('action', 'toggle-ow-keep'); }
      break;
    case 'g':
      e.preventDefault();
      const t = Media.vTime();
      const tk = State.listTrack || 0;
      const c = State.cues.find(cx => (cx.track || 0) === tk && cx.timed !== false && cx.start <= t && cx.end > t);
      if (c) {
        selectCueSingle(c.id, false);
        setStatus('已選取目前字幕', 'ok');
      } else {
        setStatus('目前時間點沒有字幕', '');
      }
      break;
    case 'v':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); pasteCues(); }
      else { e.preventDefault(); addNote(); }
      break;
    case 'm': e.preventDefault(); addNote(); break;
    case 'f':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); const sd=document.getElementById('searchDialog'); if(sd){ const show=sd.style.display==='none'||!sd.style.display; sd.style.display=show?'flex':'none'; if(show)setTimeout(()=>document.getElementById('searchInput')?.focus(),20); } }
      break;
    case 'z':
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); e.shiftKey?History.redo():History.undo(); }
      else { e.preventDefault(); emit('action','toggle-overwrite'); }
      break;
    case '*':
    case '\\':
    case '|':
    case '`':
      e.preventDefault();
      if(window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
      else { zoomFit(); window._lastZoomMode = 'fit'; }
      break;
    case '-': case '_': e.preventDefault(); setZoom(State.pxPerSec*0.77); break;
    case '+': case '=': e.preventDefault(); setZoom(State.pxPerSec*1.3); break;
  }
});
window.addEventListener('keyup',e=>{
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ if(_jklSpeed!==0)jklReset(); }
});
function nudge(d){
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：以權威播放點（暫停時為已對齊幀格的 _lastSeekTime）
  // 為基準，避免讀 video.currentTime 的浮點 ε 經 seek 重新 round 後被放大，
  // 造成逐格時跳兩格／退不動（29.97fps 尤甚）
  const t=Media.displayTime()+d;
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
  updatePlayhead(); emit('playhead:ensure');
}

function stepBoundary(dir){
  const t = Media.vTime();
  const EPS = 0.05; // 50ms寬容度，避免播放器時間小數點誤差

  const selTrack = State.listTrack;
  const timed = State.cues.filter(c => c.timed !== false && (c.track || 0) === selTrack);
  if (!timed.length) return;

  const selIdx = timed.findIndex(c => c.id === State.selectedId);
  let c = selIdx >= 0 ? timed[selIdx] : null;
  let cIdx = selIdx;

  // 如果播放點已經不在被選取的字幕範圍內（包含邊界寬容度），代表被手動拖走了，這時放棄當前選取，改依時間 t 尋找
  if (c && (t < c.start - EPS || t > c.end + EPS)) {
    c = null;
    cIdx = -1;
  }

  let targetId = null;
  let targetEdge = 'start';
  let targetTime = 0;

  if (dir > 0) {
    if (!c) {
      const bnd = [];
      for (const cue of timed) { bnd.push({id: cue.id, edge: 'start', t: cue.start}); bnd.push({id: cue.id, edge: 'end', t: cue.end}); }
      bnd.sort((a,b) => a.t - b.t);
      const nextBnd = bnd.find(b => b.t > t + EPS);
      if (nextBnd) { targetId = nextBnd.id; targetEdge = nextBnd.edge; targetTime = nextBnd.t; }
    } else {
      if (t < c.start - EPS) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else if (t < c.end - EPS) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else {
        if (cIdx < timed.length - 1) {
          const next = timed[cIdx + 1];
          targetId = next.id; targetEdge = 'start'; targetTime = next.start;
        } else {
          return;
        }
      }
    }
  } else {
    if (!c) {
      const bnd = [];
      for (const cue of timed) { bnd.push({id: cue.id, edge: 'start', t: cue.start}); bnd.push({id: cue.id, edge: 'end', t: cue.end}); }
      bnd.sort((a,b) => a.t - b.t);
      let prevBnd = null;
      for (let i = bnd.length - 1; i >= 0; i--) {
        if (bnd[i].t < t - EPS) { prevBnd = bnd[i]; break; }
      }
      if (prevBnd) { targetId = prevBnd.id; targetEdge = prevBnd.edge; targetTime = prevBnd.t; }
    } else {
      if (t > c.end + EPS) {
        targetId = c.id; targetEdge = 'end'; targetTime = c.end;
      } else if (t > c.start + EPS) {
        targetId = c.id; targetEdge = 'start'; targetTime = c.start;
      } else {
        if (cIdx > 0) {
          const prev = timed[cIdx - 1];
          targetId = prev.id; targetEdge = 'end'; targetTime = prev.end;
        } else {
          return;
        }
      }
    }
  }

  if (targetId) {
    selectCueSingle(targetId);
    State.activeEdge = targetEdge;
    Media.seek(targetTime);
    emit('playhead:ensure');
    updatePlayhead();
  }
}

export { setIn, setOut, nudge, stepBoundary, jklReset, resetPlaybackSpeed };

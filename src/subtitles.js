/* SUB Tool — 字幕列表：渲染、選取（多選）、新增/刪除、軌道切換/樣式 */
import { $, sublist, video } from './dom.js';
import { State, isSel, newId, trackVisible } from './state.js';
import { escapeHTML } from './util.js';
import { fmtClock, secToEncore } from './time.js';
import { Media } from './media.js';
import { renderCueBlocks, drawTimeline, updatePlayhead, refreshTrackGutterActive } from './timeline.js';
import { renderAll, renderVideoSub, ensurePlayheadVisible, parseTimecodeInput, renderListTrackSel, showToast } from './app.js';
import { recordHistory } from './history.js';
import { showCueMenu } from './menus.js';

/* ===== 字幕對調模式 ================================================= */
let _swapSource = null;

function enterSwapMode(id){
  _swapSource = id;
  sublist.querySelectorAll('.sub-row').forEach(r=>r.classList.remove('swap-src'));
  const srcRow=sublist.querySelector(`.sub-row[data-id="${id}"]`);
  if(srcRow)srcRow.classList.add('swap-src');
  sublist.classList.add('swap-mode');
  showToast('字幕對調模式：點選目標字幕（Esc 取消）');
}
function cancelSwapMode(){
  _swapSource=null;
  sublist.querySelectorAll('.sub-row').forEach(r=>r.classList.remove('swap-src'));
  sublist.classList.remove('swap-mode');
}

/* ===== 搜尋狀態 ===================================================== */
let _searchTerms = [];
let _searchMatches = []; // cue ids of matches in list order
let _searchIdx = -1;

function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function txtHTML(text){
  if(!_searchTerms.length) return escapeHTML(text||'');
  let result = escapeHTML(text||'');
  for(const term of _searchTerms){
    if(!term) continue;
    const re = new RegExp(escRe(escapeHTML(term)),'gi');
    result = result.replace(re, m=>`<span class="search-match">${m}</span>`);
  }
  return result;
}

/* ===== 時間點內嵌編輯 =============================================== */
function openInlineTimeEdit(el, curSec, onCommit){
  if(el.querySelector('input')) return;
  const origText = el.textContent;
  const inp = document.createElement('input');
  inp.className = 'tc-edit'; inp.style.width = '98px'; inp.value = origText;
  el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const fin = (commit) => {
    if(done) return; done = true;
    if(commit){
      const t = parseTimecodeInput(inp.value);
      if(t !== null){ onCommit(t); return; } // onCommit → renderAll rebuilds DOM
    }
    inp.remove(); el.textContent = origText;
  };
  inp.addEventListener('keydown', e=>{ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); fin(true); }
    else if(e.key==='Escape'){ e.preventDefault(); fin(false); }
  });
  inp.addEventListener('blur', ()=>fin(true));
  inp.addEventListener('mousedown', e=>e.stopPropagation());
}

/* ===== 6. 字幕列表 ==================================================== */
function updateTlSel(){
  const el=$('tlSel'); if(!el)return;
  const n=State.selectedIds.length;
  el.textContent=n===0?'無選取':`已選 ${n} 條`;
  el.classList.remove('sel-none','sel-one','sel-multi');
  el.classList.add(n===0?'sel-none':n===1?'sel-one':'sel-multi');
}

function renderCheckPanel(){
  const panel=$('checkPanel'); if(!panel||panel.style.display==='none')return;
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  // 時間碼重疊
  const overlapSet=new Set();
  const tmd=list.filter(c=>c.timed!==false);
  for(let i=0;i<tmd.length;i++) for(let j=i+1;j<tmd.length;j++){
    if(tmd[i].start<tmd[j].end&&tmd[j].start<tmd[i].end){overlapSet.add(tmd[i].id);overlapSet.add(tmd[j].id);}
  }
  const overlapNums=list.map((c,i)=>overlapSet.has(c.id)?i+1:null).filter(n=>n!==null);
  // 多行
  const multiNums=list.map((c,i)=>((c.text||'').match(/\n|\/\//g)||[]).length>=2?i+1:null).filter(n=>n!==null);
  const twoNums  =list.map((c,i)=>((c.text||'').match(/\n|\/\//g)||[]).length===1?i+1:null).filter(n=>n!==null);
  // 空白字幕
  const blankNums=list.map((c,i)=>!(c.text||'').trim()?i+1:null).filter(n=>n!==null);
  const mkNums=nums=>nums.length?nums.map(n=>`<span class="cp-num" data-idx="${n}">${n}</span>`).join(', '):'無';
  const ro=$('cpOverlap'),rm=$('cpMulti'),r2=$('cpTwo'),rb=$('cpBlank');
  if(ro)ro.querySelector('.cp-nums').innerHTML=mkNums(overlapNums);
  if(rm)rm.querySelector('.cp-nums').innerHTML=mkNums(multiNums);
  if(r2)r2.querySelector('.cp-nums').innerHTML=mkNums(twoNums);
  if(rb)rb.querySelector('.cp-nums').innerHTML=mkNums(blankNums);
  panel.querySelectorAll('.cp-num').forEach(el=>{
    el.onclick=()=>{
      const idx=parseInt(el.dataset.idx)-1; const c=list[idx]; if(!c)return;
      selectCue(c.id,{seek:false});
      const row=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);
      if(row)row.scrollIntoView({block:'center'});
    };
  });
}

function renderSubList(){
  sublist.innerHTML='';
  const list = State.cues.filter(c=>(c.track||0)===State.listTrack);
  if(list.length===0){
    sublist.innerHTML='<div class="empty">'+(State.cues.length?'此軌道沒有字幕':'尚無字幕<br><br>· 匯入字幕檔，或<br>· 選一條字幕後按 <b>I</b>/<b>O</b> 設定起訖<br>· 或點 <b>⬆＋ / ⬇＋</b> 新增')+'</div>';
    $('subCount').textContent=list.length+' 條'; return;
  }
  $('subCount').textContent=list.length+' 條';
  // 偵測同軌道時間重疊
  const overlaps=new Set();
  const timed=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
  for(let i=0;i<timed.length;i++) for(let j=i+1;j<timed.length;j++){
    if(timed[i].start<timed[j].end-1e-9&&timed[j].start<timed[i].end-1e-9){ overlaps.add(timed[i].id); overlaps.add(timed[j].id); }
  }
  const frag=document.createDocumentFragment();
  list.forEach((c,i)=>frag.appendChild(buildSubRow(c,i,overlaps)));
  sublist.appendChild(frag);
  sublist.onkeydown=e=>{ if(e.key==='ArrowUp'||e.key==='ArrowDown')e.preventDefault(); };
  renderCheckPanel();
}

function lineCountClass(text){
  const n=((text||'').match(/\n|\/\//g)||[]).length;
  return n>=2?' multi-line':n===1?' two-line':'';
}
function _rowClass(text){ return !(text||'').trim()?'blank':lineCountClass(text).trim(); }
function _txtInner(text){ return !(text||'').trim()?'<span class="blank-label">(空白字幕)</span>':txtHTML(text||''); }
function buildSubRow(c,i,overlaps){
  const row=document.createElement('div');
  const rc=_rowClass(c.text);
  row.className='sub-row'+(rc?' '+rc:'')+(isSel(c.id)?' sel':'')+(c.id===State.selectedId?' primary':'')+(c.id===State.activeId?' active':'')+(overlaps?.has(c.id)?' overlap':'');
  row.dataset.id=c.id;
  const timed=c.timed!==false;
  row.innerHTML=
    `<div class="idx">${i+1}</div>`+
    `<div class="body">`+
      `<div class="times">`+
        (timed?`<span class="tin">${secToEncore(c.start,State.fps)}</span> → <span class="tout">${secToEncore(c.end,State.fps)}</span>`
              :`<span class="untimed">未定時 — 用 I/O 標記</span>`)+
        (timed?`<span class="dur">${(c.end-c.start).toFixed(2)}s</span>`:``)+
      `</div>`+
      `<div class="txt" contenteditable="false" spellcheck="false">${_txtInner(c.text)}</div>`+
    `</div>`+
    (State.trackCount>1?`<div class="tk">軌${(c.track||0)+1}</div>`:``);
  function _syncRowClass(){
    const rc2=_rowClass(c.text);
    row.classList.remove('blank','two-line','multi-line'); if(rc2)row.classList.add(rc2);
  }

  // 時間點點擊編輯
  if(timed){
    row.querySelector('.tin').addEventListener('click',e=>{
      e.stopPropagation();
      openInlineTimeEdit(row.querySelector('.tin'), c.start, t=>{
        c.start=Math.max(0,Math.min(t,c.end-0.001));
        sortCues(); renderAll(); renderVideoSub(); recordHistory('修改起點');
      });
    });
    row.querySelector('.tout').addEventListener('click',e=>{
      e.stopPropagation();
      openInlineTimeEdit(row.querySelector('.tout'), c.end, t=>{
        c.end=Math.max(c.start+0.001,t);
        sortCues(); renderAll(); renderVideoSub(); recordHistory('修改終點');
      });
    });
  }

  row.addEventListener('mousedown',e=>{
    if(e.button===2) return;
    // 字幕對調模式：點選目標字幕
    if(_swapSource!==null){
      e.preventDefault();
      if(c.id!==_swapSource){
        const src=State.cues.find(x=>x.id===_swapSource);
        if(src){ const tmp=src.text||''; src.text=c.text||''; c.text=tmp; renderAll(); recordHistory('字幕對調'); }
      }
      cancelSwapMode(); return;
    }
    const txtEl=row.querySelector('.txt');
    // 若已在文字編輯模式且點擊在 txt 內，讓瀏覽器自行定位游標
    if(txtEl && txtEl.contentEditable==='true' && (e.target===txtEl||txtEl.contains(e.target))) return;
    if(document.activeElement===txtEl) txtEl.blur();
    selectCue(c.id,{additive:e.ctrlKey||e.metaKey, range:e.shiftKey, seek:!(e.ctrlKey||e.metaKey||e.shiftKey)});
  });
  row.addEventListener('dblclick',e=>{
    if(e.ctrlKey||e.metaKey||e.shiftKey) return;
    // 時間點有自己的點擊處理，不在此觸發文字編輯
    if(e.target.closest('.tin')||e.target.closest('.tout')) return;
    e.preventDefault();
    const t=row.querySelector('.txt');
    _orig=c.text||'';
    t.innerText=c.text||''; // 清除搜尋高亮 span
    t.contentEditable='true'; t.focus();
    try{ const r=document.createRange(),s=window.getSelection(); r.selectNodeContents(t); r.collapse(false); s.removeAllRanges(); s.addRange(r); }catch(_){}
  });
  row.addEventListener('contextmenu',e=>{ e.preventDefault();
    if(!isSel(c.id))selectCue(c.id);
    else { State.selectedId=c.id; refreshSelectionUI(); }
    showCueMenu(e.clientX,e.clientY);
  });

  const txt=row.querySelector('.txt');
  let _orig=c.text||'';
  txt.addEventListener('input',()=>{
    c.text=txt.innerText; _syncRowClass(); renderCueBlocks(); renderVideoSub();
  });
  txt.addEventListener('blur',()=>{
    if(txt.contentEditable!=='true') return;
    c.text=txt.innerText;
    txt.contentEditable='false';
    txt.innerHTML=_txtInner(c.text);
    _syncRowClass();
    if((c.text||'')!==_orig) recordHistory('編輯字幕文字');
  });
  txt.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); txt.blur(); }
    else if(e.key==='Escape'){ e.preventDefault(); txt.innerText=_orig; txt.blur(); }
    e.stopPropagation();
  });
  return row;
}

function renderSubRow(id){
  const row=sublist.querySelector(`.sub-row[data-id="${id}"]`); if(!row)return;
  const c=State.cues.find(x=>x.id===id); if(!c)return;
  const timed=c.timed!==false;
  const times=row.querySelector('.times');
  if(timed)times.innerHTML=`<span class="tin">${secToEncore(c.start,State.fps)}</span> → <span class="tout">${secToEncore(c.end,State.fps)}</span><span class="dur">${(c.end-c.start).toFixed(2)}s</span>`;
  const txt=row.querySelector('.txt');
  if(txt&&txt.contentEditable!=='true') txt.innerHTML=_txtInner(c.text);
}

function selectCue(id,opts){
  opts=opts||{};
  if(opts.additive){
    const i=State.selectedIds.indexOf(id);
    if(i>=0)State.selectedIds.splice(i,1); else State.selectedIds.push(id);
    State.selectedId=State.selectedIds[State.selectedIds.length-1]||null;
  }else if(opts.range && State.selectedId){
    const ids=State.cues.map(c=>c.id);
    const a=ids.indexOf(State.selectedId), b=ids.indexOf(id);
    if(a>=0&&b>=0){ const lo=Math.min(a,b),hi=Math.max(a,b); State.selectedIds=ids.slice(lo,hi+1); }
  }else{ State.selectedIds=[id]; State.selectedId=id; }
  State.activeEdge='start';
  const c=State.cues.find(x=>x.id===id);
  if(c && !opts.additive && !opts.range){
    const tk=c.track||0;
    if(tk!==State.listTrack){ State.listTrack=tk; renderListTrackSel(); renderSubList(); refreshTrackGutterActive(); }
  }
  refreshSelectionUI();
  if(opts.seek&&c&&c.timed!==false){ Media.seek(c.start); ensurePlayheadVisible(); }
  const pc=State.cues.find(x=>x.id===State.selectedId);
  $('stSel').textContent=State.selectedIds.length?('已選 '+State.selectedIds.length+' 條'+(pc?(' · #'+(State.cues.indexOf(pc)+1)):'')):'';
  updatePlayhead();
}
function selectCueSingle(id,seek){ selectCue(id,{seek}); }
function refreshSelectionUI(){
  sublist.querySelectorAll('.sub-row').forEach(r=>{
    r.classList.toggle('sel',isSel(r.dataset.id));
    r.classList.toggle('primary',r.dataset.id===State.selectedId);
  });
  const row=State.selectedId&&sublist.querySelector(`.sub-row[data-id="${State.selectedId}"]`);
  if(row)row.scrollIntoView({block:'nearest'});
  renderCueBlocks();
  updateTlSel();
}
function addCue(start,end,text,track){
  const c={id:newId(),start:start||0,end:end!=null?end:(start||0),text:text||'',track:track||0,timed:(start!=null&&end!=null)};
  State.cues.push(c); sortCues(); renderAll(); selectCue(c.id); return c;
}
function addCueAfter(id){
  const c=addCue(null,null,'',0); c.timed=false; c.start=0;c.end=0;
  renderAll(); selectCue(c.id);
  setTimeout(()=>{const r=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));},30);
}
function addCueRelative(dir){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  if(sel && sel.timed===false){
    const c={id:newId(),start:0,end:0,text:'',track:sel.track||0,timed:false};
    State.cues.splice(State.cues.indexOf(sel)+(dir>0?1:0),0,c);
    renderAll(); selectCue(c.id); recordHistory('新增空白字幕');
    setTimeout(()=>{const r=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));},30);
    return c;
  }
  const tk=sel?(sel.track||0):0;
  let start,end;
  if(sel){ if(dir>0){ start=sel.end; end=sel.end+2; } else { end=sel.start; start=Math.max(0,sel.start-2); } }
  else { start=Media.vTime(); end=start+2; }
  const c=addCue(start,end,'',tk); recordHistory(dir>0?'下方新增字幕':'上方新增字幕');
  setTimeout(()=>{const r=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));},30);
  return c;
}
function deleteSelected(){
  const ids=State.selectedIds.length?State.selectedIds.slice():[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  const idxs=ids.map(id=>State.cues.findIndex(c=>c.id===id)).filter(i=>i>=0);
  const firstIdx=idxs.length?Math.min(...idxs):0;
  State.cues=State.cues.filter(c=>!ids.includes(c.id));
  State.selectedId=State.cues[Math.min(firstIdx,State.cues.length-1)]?.id||null;
  State.selectedIds=State.selectedId?[State.selectedId]:[]; State.activeEdge='start';
  renderAll(); updateTlSel(); recordHistory('刪除字幕');
}
function deleteCue(id){ if(id){State.selectedIds=[id];State.selectedId=id;} deleteSelected(); }

function shiftTextsDown(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i<=0||!(list[i-1].text||'').trim())return;
  let start=i-1;
  while(start>0&&(list[start-1].text||'').trim())start--;
  for(let j=i;j>start;j--)list[j].text=list[j-1].text;
  list[start].text='';
  renderAll(); recordHistory('上方字幕文字往下移動');
}

function shiftTextsUp(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i>=list.length-1||!(list[i+1].text||'').trim())return;
  let end=i+1;
  while(end<list.length-1&&(list[end+1].text||'').trim())end++;
  for(let j=i;j<end;j++)list[j].text=list[j+1].text;
  list[end].text='';
  renderAll(); recordHistory('下方字幕文字往上移動');
}

function sortCues(){ State.cues.sort((a,b)=>{
  const at=a.timed===false?Infinity:a.start, bt=b.timed===false?Infinity:b.start;
  return at-bt;
});}

/* ===== 複製 / 貼上 ===================================================== */
function copyCues(){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length){ showToast('沒有選取的字幕'); return; }
  State.clipboard=State.cues.filter(c=>ids.includes(c.id)).map(c=>({...c}));
  showToast(`已複製 ${State.clipboard.length} 條字幕`);
}
function pasteCues(){
  if(!State.clipboard?.length){ showToast('剪貼簿是空的'); return; }
  const timedClip=State.clipboard.filter(c=>c.timed!==false);
  const minStart=timedClip.length ? Math.min(...timedClip.map(c=>c.start)) : 0;
  const delta=Media.vTime()-minStart;
  const newCues=State.clipboard.map(c=>{
    if(c.timed===false) return {...c, id:newId(), track:State.listTrack};
    const s=Math.max(0, c.start+delta);
    return {...c, id:newId(), track:State.listTrack, start:s, end:Math.max(s+0.001, c.end+delta)};
  });
  State.cues.push(...newCues);
  sortCues();
  State.selectedIds=newCues.map(c=>c.id);
  State.selectedId=newCues[0].id;
  renderAll(); refreshSelectionUI(); recordHistory('貼上字幕');
  showToast(`已貼上 ${newCues.length} 條字幕`);
}

/* ===== 搜尋 / 取代 ===================================================== */
function searchUpdate(){
  const inp=$('searchInput');
  const raw=(inp?inp.value:'').trim();
  if(!raw){ _searchTerms=[]; _searchMatches=[]; _searchIdx=-1; updateSearchCount(); renderSubList(); return; }
  _searchTerms=raw.split('||').map(s=>s.trim()).filter(Boolean);
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  _searchMatches=list.filter(c=>{
    const text=(c.text||'').toLowerCase();
    return _searchTerms.some(t=>text.includes(t.toLowerCase()));
  }).map(c=>c.id);
  _searchIdx=_searchMatches.length?0:-1;
  renderSubList();
  if(_searchIdx>=0) selectCue(_searchMatches[_searchIdx],{seek:false});
  updateSearchCount();
}

function searchNav(dir){
  if(!_searchMatches.length) return;
  _searchIdx=(_searchIdx+dir+_searchMatches.length)%_searchMatches.length;
  selectCue(_searchMatches[_searchIdx],{seek:true});
  updateSearchCount();
}

function searchReplace(all){
  const ri=$('replaceInput'); const repText=ri?ri.value:'';
  if(!_searchTerms.length) return;
  const cues=all
    ? State.cues.filter(c=>(c.track||0)===State.listTrack)
    : (_searchIdx>=0?[State.cues.find(c=>c.id===_searchMatches[_searchIdx])].filter(Boolean):[]);
  let count=0;
  for(const c of cues){
    if(!c) continue;
    const orig=c.text||'';
    let text=orig;
    for(const term of _searchTerms){
      const re=new RegExp(escRe(term),'gi');
      text=text.replace(re,repText);
    }
    if(text!==orig){ c.text=text; count++; }
  }
  if(count){ recordHistory(all?'全部取代':'取代字幕'); searchUpdate(); renderAll(); }
}

function updateSearchCount(){
  const el=$('searchCount'); if(!el) return;
  if(!_searchTerms.length){ el.textContent=''; return; }
  el.textContent=_searchMatches.length?`${_searchIdx+1}/${_searchMatches.length}`:'無結果';
}

export { renderSubList, renderCheckPanel, buildSubRow, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel,
  addCue, addCueAfter, addCueRelative, deleteSelected, deleteCue, sortCues, shiftTextsDown, shiftTextsUp,
  enterSwapMode, cancelSwapMode,
  searchUpdate, searchNav, searchReplace, openInlineTimeEdit,
  copyCues, pasteCues };

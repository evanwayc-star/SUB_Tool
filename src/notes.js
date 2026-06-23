/* SUB Tool — 備註 */
import { $, video } from './dom.js';
import { State, newId } from './state.js';
import { secToEncore } from './time.js';
import { escapeHTML, downloadBytes } from './util.js';
import { Media } from './media.js';
import { updatePlayhead, drawRuler } from './timeline.js';
import { recordHistory } from './history.js';
import { ensurePlayheadVisible, showToast, setStatus, parseTimecodeInput, openModal, closeModal } from './app.js';
import { showCtx } from './menus.js';

/* ===== 備註 active 狀態 ===== */
let _activeNoteId=null;
let _selectedNoteIds=new Set(); // 多選集合
let _lastSelectedNoteId=null; // 用於 Shift 多選

function setNoteActive(id){
  if(_activeNoteId===id)return;
  _activeNoteId=id;
  _refreshNoteSelectionUI();
}
function _refreshNoteSelectionUI(){
  const list=$('notesList'); if(!list)return;
  list.querySelectorAll('.note-item').forEach(r=>{
    const id=r.dataset.id;
    r.classList.toggle('nt-active',id===_activeNoteId);
    r.classList.toggle('nt-selected',_selectedNoteIds.has(id));
  });
}
function updateNoteActive(t){
  const W=0.5/(State.fps||24);
  let best=null, bd=Infinity;
  for(const n of State.notes){ const d=Math.abs(n.time-t); if(d<=W&&d<bd){bd=d;best=n;} }
  setNoteActive(best?.id??null);
}

/* ===== 備註 ===== */
function addNote(){
  const t=Media.vTime();
  const n={id:newId(),time:t,text:'',done:false};
  State.notes.push(n); State.notes.sort((a,b)=>a.time-b.time);
  _selectedNoteIds.clear(); _selectedNoteIds.add(n.id); _lastSelectedNoteId=n.id;
  setNoteActive(n.id);
  $('notesPanel').classList.add('show'); renderNotes(); drawRuler();
  recordHistory('新增備註');
  setTimeout(()=>{
    const r=$('notesList').querySelector(`.note-item[data-id="${n.id}"] .nt-text`);
    if(r){ r.innerText=''; r.contentEditable='true'; r.focus(); }
  },30);
}

function clearAllNotes(){
  if(!State.notes.length){ showToast('沒有備註可清除'); return; }
  if(!confirm(`確定要清除全部 ${State.notes.length} 條備註嗎？`)) return;
  State.notes=[];
  _selectedNoteIds.clear(); _activeNoteId=null; _lastSelectedNoteId=null;
  renderNotes(); drawRuler();
  recordHistory('清除所有備註');
  showToast('已清除所有備註');
}

function renderNotes(){
  const el=$('notesList'); if(!el)return;
  if(!State.notes.length){ el.innerHTML='<div class="empty">尚無備註<br>播放到某處 → 點「＋ 新增」</div>'; return; }
  el.innerHTML='';
  for(const n of State.notes){
    const isSel=_selectedNoteIds.has(n.id);
    const row=document.createElement('div');
    row.className='note-item'+(n.done?' done':'')+(n.id===_activeNoteId?' nt-active':'')+(isSel?' nt-selected':'');
    row.dataset.id=n.id;
    row.innerHTML=
      `<input type="checkbox" class="nt-done-cb" ${n.done?'checked':''} title="完成">`+
      `<span class="nt-time">${escapeHTML(secToEncore(n.time,State.fps,State.dropFrame))}</span>`+
      `<span class="nt-text" contenteditable="false" spellcheck="false">${escapeHTML(n.text)}</span>`+
      `<button class="nt-del" title="刪除">✕</button>`;

    // 勾選（完成狀態）
    row.querySelector('.nt-done-cb').onchange=e=>{ n.done=e.target.checked; row.classList.toggle('done',n.done); recordHistory('備註打勾'); };

    // 時間點：單擊 → 跳到時間點；雙擊 → 內嵌編輯時間
    const timeEl=row.querySelector('.nt-time');
    timeEl.addEventListener('click',e=>{
      e.stopPropagation();
      if(timeEl.querySelector('input')) return;
      setNoteActive(n.id); Media.seek(n.time); updatePlayhead(); ensurePlayheadVisible();
    });
    timeEl.addEventListener('dblclick',e=>{
      e.stopPropagation();
      if(timeEl.querySelector('input')) return;
      const origText=timeEl.textContent;
      const inp=document.createElement('input');
      inp.className='nt-te'; inp.value=origText;
      timeEl.textContent=''; timeEl.appendChild(inp); inp.focus(); inp.select();
      let done=false;
      const fin=(commit)=>{
        if(done)return; done=true;
        if(commit){
          const t=parseTimecodeInput(inp.value);
          if(t!==null){ n.time=t; State.notes.sort((a,b)=>a.time-b.time); renderNotes(); recordHistory('修改備註時間'); return; }
        }
        inp.remove(); timeEl.textContent=origText;
      };
      inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();fin(true);} else if(e.key==='Escape'){e.preventDefault();fin(false);} });
      inp.addEventListener('blur',()=>fin(true));
      inp.addEventListener('mousedown',e=>e.stopPropagation());
    });

    // 備註文字：預設唯讀；雙擊進入編輯
    const txt=row.querySelector('.nt-text');
    let _orig=n.text||'';
    txt.addEventListener('dblclick',e=>{
      e.stopPropagation();
      _orig=n.text||'';
      txt.innerText=n.text||'';
      txt.contentEditable='true'; txt.focus();
    });
    txt.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();txt.blur();} else if(e.key==='Escape'){e.preventDefault();txt.innerText=_orig;txt.blur();} });
    txt.addEventListener('blur',()=>{
      if(txt.contentEditable!=='true')return;
      const val=txt.innerText;
      n.text=val; txt.contentEditable='false'; txt.innerHTML=escapeHTML(val);
      if(val!==_orig) recordHistory('編輯備註');
    });

    // 整列點擊 → 多選支援（Ctrl 加選，Shift 範圍，普通單選）
    row.addEventListener('click',e=>{
      if(e.target.closest('.nt-done-cb')||e.target.closest('.nt-del')||e.target.closest('.nt-time')) return;
      if(e.target===txt && txt.contentEditable==='true') return;
      
      if(e.shiftKey && _lastSelectedNoteId){
        const allIds = State.notes.map(x=>x.id);
        const idx1 = allIds.indexOf(_lastSelectedNoteId);
        const idx2 = allIds.indexOf(n.id);
        if(idx1 !== -1 && idx2 !== -1){
          const start = Math.min(idx1, idx2);
          const end = Math.max(idx1, idx2);
          if(!e.ctrlKey && !e.metaKey) _selectedNoteIds.clear();
          for(let i=start; i<=end; i++){
            _selectedNoteIds.add(allIds[i]);
          }
        }
      } else if(e.ctrlKey||e.metaKey){
        if(_selectedNoteIds.has(n.id)) _selectedNoteIds.delete(n.id);
        else { _selectedNoteIds.add(n.id); _lastSelectedNoteId=n.id; }
      } else {
        _selectedNoteIds.clear(); _selectedNoteIds.add(n.id); _lastSelectedNoteId=n.id;
        Media.seek(n.time); updatePlayhead(); ensurePlayheadVisible();
      }
      setNoteActive(n.id);
      _refreshNoteSelectionUI();
    });

    // 右鍵 → 備註右鍵選單
    row.addEventListener('contextmenu',e=>{
      e.preventDefault(); e.stopPropagation();
      // 如果右鍵的這條不在選取集合中，先選取它
      if(!_selectedNoteIds.has(n.id)){
        _selectedNoteIds.clear(); _selectedNoteIds.add(n.id);
        setNoteActive(n.id); _refreshNoteSelectionUI();
      }
      _showNoteCtx(e.clientX,e.clientY);
    });

    row.querySelector('.nt-del').onclick=e=>{ e.stopPropagation(); State.notes=State.notes.filter(x=>x.id!==n.id); _selectedNoteIds.delete(n.id); renderNotes(); drawRuler(); recordHistory('刪除備註'); };
    el.appendChild(row);
  }
}

/* 備註右鍵選單 */
function _showNoteCtx(x,y){
  const cnt=_selectedNoteIds.size;
  const items=[{heading:true,label:`已選 ${cnt} 條備註`}];
  if(cnt>=1){
    items.push({label:'✏ 統一編輯文字…',act:()=>_batchEditNotes()});
  }
  if(cnt>=2){
    items.push({label:'☑ 全部標記完成',act:()=>{
      for(const id of _selectedNoteIds){ const n=State.notes.find(x=>x.id===id); if(n) n.done=true; }
      renderNotes(); recordHistory('批次標記完成');
    }});
    items.push({label:'☐ 全部取消完成',act:()=>{
      for(const id of _selectedNoteIds){ const n=State.notes.find(x=>x.id===id); if(n) n.done=false; }
      renderNotes(); recordHistory('批次取消完成');
    }});
  }
  items.push({sep:true});
  items.push({label:'🗑 刪除選取備註',act:()=>{
    if(cnt>1 && !confirm(`確定要刪除 ${cnt} 條備註嗎？`)) return;
    State.notes=State.notes.filter(n=>!_selectedNoteIds.has(n.id));
    _selectedNoteIds.clear(); _activeNoteId=null; _lastSelectedNoteId=null;
    renderNotes(); drawRuler(); recordHistory('刪除備註');
  }});
  showCtx(x,y,items);
}

/* 批次編輯備註文字 */
function _batchEditNotes(){
  const cnt=_selectedNoteIds.size;
  const first=State.notes.find(n=>_selectedNoteIds.has(n.id));
  const defText=first?.text||'';
  
  openModal(`統一編輯 ${cnt} 條備註`, `
    <div style="margin-bottom:10px;color:var(--text)">將這 ${cnt} 條備註的內容統一修改為：</div>
    <textarea id="batchNoteInput" style="width:100%;height:100px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;font-size:14px;resize:vertical;" placeholder="請輸入新的備註文字…">${escapeHTML(defText)}</textarea>
  `,[
    {label:'取消', act: closeModal},
    {label:'儲存變更', primary:true, act: ()=>{
      const newText = document.getElementById('batchNoteInput').value;
      for(const id of _selectedNoteIds){
        const n=State.notes.find(x=>x.id===id);
        if(n) n.text=newText;
      }
      renderNotes();
      recordHistory('批次編輯備註');
      showToast(`已更新 ${cnt} 條備註`);
      closeModal();
    }}
  ]);
  
  setTimeout(()=>{
    const el = document.getElementById('batchNoteInput');
    if(el){ el.focus(); el.select(); }
  }, 50);
}

function exportNotes(){
  if(!State.notes.length){ showToast('沒有備註可匯出'); return; }
  const makeBom=csv=>{ const BOM=new Uint8Array([0xEF,0xBB,0xBF]),body=new TextEncoder().encode(csv),out=new Uint8Array(BOM.length+body.length); out.set(BOM);out.set(body,BOM.length); return out; };

  // 原始格式
  const csvF=v=>{ const s=String(v); return (s.includes(',')||s.includes('"')||s.includes('\n'))?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=['狀態,時間,內容'];
  for(const n of State.notes){
    const time=secToEncore(n.time,State.fps,State.dropFrame);
    const content=(n.text||'').replace(/\r?\n/g,' ');
    lines.push(`${csvF(n.done?'V':'K')},${csvF(time)},${csvF(content)}`);
  }
  downloadBytes(makeBom(lines.join('\r\n')),'notes.csv','text/csv;charset=utf-8');

  // EDIUS Marker list 格式
  const d=new Date();
  const DAY=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh=v=>String(v).padStart(2,'0');
  const dateStr=`${DAY[d.getDay()]} ${MON[d.getMonth()]} ${String(d.getDate()).padStart(2,' ')} ${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())} ${d.getFullYear()}`;
  const eLines=[
    '# EDIUS Marker list',
    '# Format Version 2',
    `# Created Date : ${dateStr}`,
    '#',
    '# No, Position, Duration, Comment',
  ];
  State.notes.forEach((n,i)=>{
    const time=secToEncore(n.time,State.fps,State.dropFrame);
    const comment=(n.text||'').replace(/"/g,'""');
    eLines.push(`${i+1},"${time}", ,"${comment}"`);
  });
  downloadBytes(makeBom(eLines.join('\r\n')),'notes_EDIUS.csv','text/csv;charset=utf-8');

  setStatus('備註已匯出：notes.csv + notes_EDIUS.csv','ok');
}

export { addNote, renderNotes, exportNotes, setNoteActive, updateNoteActive, clearAllNotes };

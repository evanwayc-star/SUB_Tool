/* SUB Tool — 備註 */
import { $, video } from './dom.js';
import { State, newId } from './state.js';
import { secToEncore } from './time.js';
import { escapeHTML, downloadBytes } from './util.js';
import { Media } from './media.js';
import { updatePlayhead, drawRuler } from './timeline.js';
import { recordHistory } from './history.js';
import { ensurePlayheadVisible, showToast, setStatus, parseTimecodeInput } from './app.js';

/* ===== 備註 ===== */
function addNote(){
  const t=Media.vTime();
  const n={id:newId(),time:t,text:'',done:false};
  State.notes.push(n); State.notes.sort((a,b)=>a.time-b.time);
  $('notesPanel').classList.add('show'); renderNotes(); drawRuler();
  recordHistory('新增備註');
  setTimeout(()=>{
    const r=$('notesList').querySelector(`.note-item[data-id="${n.id}"] .nt-text`);
    if(r){ r.innerText=''; r.contentEditable='true'; r.focus(); }
  },30);
}

function renderNotes(){
  const el=$('notesList'); if(!el)return;
  if(!State.notes.length){ el.innerHTML='<div class="empty">尚無備註<br>播放到某處 → 點「＋ 新增」</div>'; return; }
  el.innerHTML='';
  for(const n of State.notes){
    const row=document.createElement('div'); row.className='note-item'+(n.done?' done':''); row.dataset.id=n.id;
    row.innerHTML=
      `<input type="checkbox" ${n.done?'checked':''}>`+
      `<span class="nt-time">${escapeHTML(secToEncore(n.time,State.fps))}</span>`+
      `<span class="nt-text" contenteditable="false" spellcheck="false">${escapeHTML(n.text)}</span>`+
      `<button class="nt-del" title="刪除">✕</button>`;

    // 勾選
    row.querySelector('input').onchange=e=>{ n.done=e.target.checked; row.classList.toggle('done',n.done); recordHistory('備註打勾'); };

    // 時間點：單擊 → 跳到時間點；雙擊 → 內嵌編輯時間
    const timeEl=row.querySelector('.nt-time');
    timeEl.addEventListener('click',e=>{
      e.stopPropagation();
      if(timeEl.querySelector('input')) return;
      Media.seek(n.time); updatePlayhead(); ensurePlayheadVisible();
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

    // 備註文字：預設唯讀；雙擊進入編輯；單擊跳到時間點（由 row click 處理）
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

    // 整列點擊 → 跳到時間點（排除互動元素及文字編輯中）
    row.addEventListener('click',e=>{
      if(e.target.closest('input')||e.target.closest('.nt-del')||e.target.closest('.nt-time')) return;
      if(e.target===txt && txt.contentEditable==='true') return;
      Media.seek(n.time); updatePlayhead(); ensurePlayheadVisible();
    });

    row.querySelector('.nt-del').onclick=e=>{ e.stopPropagation(); State.notes=State.notes.filter(x=>x.id!==n.id); renderNotes(); recordHistory('刪除備註'); };
    el.appendChild(row);
  }
}

function exportNotes(){
  if(!State.notes.length){ showToast('沒有備註可匯出'); return; }
  const csvF=v=>{ const s=String(v); return (s.includes(',')||s.includes('"')||s.includes('\n'))?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=['狀態,時間,內容'];
  for(const n of State.notes){
    const status=n.done?'V':'K';
    const time=secToEncore(n.time,State.fps);
    const content=(n.text||'').replace(/\r?\n/g,' ');
    lines.push(`${csvF(status)},${csvF(time)},${csvF(content)}`);
  }
  const csv=lines.join('\r\n');
  const BOM=new Uint8Array([0xEF,0xBB,0xBF]);
  const body=new TextEncoder().encode(csv);
  const out=new Uint8Array(BOM.length+body.length);
  out.set(BOM); out.set(body,BOM.length);
  downloadBytes(out,'notes.csv','text/csv;charset=utf-8');
  setStatus('備註已匯出：notes.csv','ok');
}

export { addNote, renderNotes, exportNotes };

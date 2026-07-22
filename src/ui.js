/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/ui.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — UI 基本元件：狀態列 / Toast / OSD / 對話框（葉節點，僅依賴 dom + media 執行期狀態） */
import { $ } from './dom.js';
import { Media } from './media.js';

/* 狀態列 / toast / modal */
// X6：狀態點除顏色外提供文字等價（aria-label），供報讀器與非顏色辨識
const _DOT_LABEL={ ok:'就緒', err:'錯誤', busy:'處理中', '':'閒置' };
let _statusLocked = false;
function setStatus(msg, kind, force = false){
  if (_statusLocked && !force) return;
  if (force === 'lock') _statusLocked = true;
  else if (force === 'unlock') _statusLocked = false;
  
  $('stMsg').textContent=msg;
  const d=$('stDot'); d.className='dot'+(kind?(' '+kind):'');
  d.setAttribute('aria-label', _DOT_LABEL[kind||''] ?? '');
}
let toastT;
function showToast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3500); }
let _osdT;
function showOsd(text){ const el=$('speedOsd'); if(!el)return; el.textContent=text; el.classList.add('show'); clearTimeout(_osdT); _osdT=setTimeout(()=>el.classList.remove('show'),1000); }
let _modalKeepVideo=false; // 目前對話框是否「不遮影片」（靠右停＋透明遮罩＋不隱藏 mpv）
function openModal(title,html,buttons,opts={}){
  $('modalTitle').textContent=title; $('modalBody').innerHTML=html;
  const foot=$('modalFoot'); foot.innerHTML='';
  (buttons||[{label:'關閉',primary:true,act:closeModal}]).forEach(b=>{
    const btn=document.createElement('button'); btn.textContent=b.label; if(b.primary)btn.className='primary';
    btn.onclick=b.act; foot.appendChild(btn);
  });
  const bg=$('modalBg');
  const modalEl=bg.querySelector('.modal');
  if(modalEl) modalEl.style.width=opts.width||'';
  // keepVideo：編輯字幕文字時要看得到後面的畫面 → 對話框靠右停、遮罩透明、且【不】隱藏 mpv。
  //  （mpv 是 OS 層置頂視窗，靠右停才不會蓋到／被它蓋到；WebCodecs 走 HTML canvas 則本來就疊得上。）
  _modalKeepVideo = !!opts.keepVideo;
  bg.classList.toggle('dock-right', _modalKeepVideo || opts.dock==='right');
  bg.classList.toggle('clear-bg', _modalKeepVideo);
  // X2：記住觸發元素，顯示後把焦點移進對話框（第一個可聚焦元素，通常是輸入框或「取消」）
  // 用 _lastFocusedOutsideModal（focusin 追蹤）而非 document.activeElement，因為觸發點擊
  // 可能在 openModal 執行前就把焦點移走，導致還原目標錯誤。
  _modalPrevFocus = _lastFocusedOutsideModal || document.activeElement;
  bg.classList.add('show');
  setTimeout(()=>{ _focusables()[0]?.focus(); }, 0);
  // mpv 覆蓋視窗會蓋住置中的對話框，開啟對話框時先隱藏（keepVideo 例外：保留畫面）
  if(!_modalKeepVideo && Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(false).catch(()=>{});
}
function closeModal(){
  const prev=_modalPrevFocus; _modalPrevFocus=null;
  const bg=$('modalBg');
  bg.classList.remove('show','dock-right','clear-bg');
  _modalKeepVideo=false;
  // X2：把焦點還給開啟前的元素。延到下一個 tick，避免「隱藏對話框→焦點元素被瀏覽器
  // 同步 blur 到 body」覆蓋掉我們的還原。
  if(prev && prev.focus){ setTimeout(()=>{ try{ prev.focus(); }catch(e){} }, 0); }
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(true).catch(()=>{});
}
// X2：對話框內可聚焦元素（用於初始聚焦與 Tab 焦點陷阱）
let _modalPrevFocus=null;
// 追蹤對話框外最後聚焦的元素，作為關閉後的焦點還原目標
let _lastFocusedOutsideModal=null;
document.addEventListener('focusin', e=>{
  if(!$('modalBg').contains(e.target)) _lastFocusedOutsideModal=e.target;
});
function _focusables(){
  const m=$('modalBg').querySelector('.modal'); if(!m) return [];
  return Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(el=>!el.disabled && el.offsetParent!==null);
}
// 點遮罩空白處＝關閉；但 keepVideo（透明遮罩、要看影片）時不關，避免點左邊影片就誤關（有確認/取消鈕）
$('modalBg').addEventListener('mousedown',e=>{if(e.target===$('modalBg') && !_modalKeepVideo)closeModal();});
$('modalBg').addEventListener('keydown',e=>{
  // X2：Tab 焦點陷阱 — 把焦點循環限制在對話框內，不外漏到被遮罩的背景
  if(e.key==='Tab'){
    const f=_focusables(); if(f.length){
      const first=f[0], last=f[f.length-1];
      if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
    return;
  }
  if(e.key==='Enter' && e.target.tagName!=='TEXTAREA' && !e.target.isContentEditable){
    if(e.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    $('modalFoot')?.querySelector('button.primary')?.click();
  }
},true);

/* 取代 window.prompt：Electron 停用了原生 prompt（呼叫會拋
   "prompt() is and will not be supported."）→ 任何靠 prompt 取名字的功能都會【靜默失敗】
   （v4.32.2 前的「存為常用／改名／自訂字型」正是如此）。此為 modal 版，回傳 Promise<string|null>
   （確定＝去頭尾空白後的字串；取消／空字串＝null）。 */
function promptModal(title, label, defVal = '', { placeholder = '', okLabel = '確定' } = {}){
  return new Promise(resolve => {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    let done = false;
    const finish = v => { if(done) return; done = true; closeModal(); resolve(v); };
    openModal(title,
      `<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">${esc(label)}</div>`+
      `<input type="text" id="__promptInput" value="${esc(defVal)}" placeholder="${esc(placeholder)}" `+
      `style="width:100%;box-sizing:border-box;font-size:14px;padding:7px 9px;background:var(--bg2);`+
      `border:1px solid var(--border2);border-radius:5px;color:var(--text)">`,
      [{ label: okLabel, primary: true, act: () => { const v = ($('__promptInput')?.value || '').trim(); finish(v || null); } },
       { label: '取消', act: () => finish(null) }]);
    setTimeout(() => { const el = $('__promptInput'); if(el){ el.focus(); el.select(); } }, 30);
  });
}

export { setStatus, showToast, showOsd, openModal, closeModal, promptModal };


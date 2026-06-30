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
function openModal(title,html,buttons,opts={}){
  $('modalTitle').textContent=title; $('modalBody').innerHTML=html;
  const foot=$('modalFoot'); foot.innerHTML='';
  (buttons||[{label:'關閉',primary:true,act:closeModal}]).forEach(b=>{
    const btn=document.createElement('button'); btn.textContent=b.label; if(b.primary)btn.className='primary';
    btn.onclick=b.act; foot.appendChild(btn);
  });
  const modalEl=$('modalBg').querySelector('.modal');
  if(modalEl) modalEl.style.width=opts.width||'';
  // X2：記住觸發元素，顯示後把焦點移進對話框（第一個可聚焦元素，通常是輸入框或「取消」）
  // 用 _lastFocusedOutsideModal（focusin 追蹤）而非 document.activeElement，因為觸發點擊
  // 可能在 openModal 執行前就把焦點移走，導致還原目標錯誤。
  _modalPrevFocus = _lastFocusedOutsideModal || document.activeElement;
  $('modalBg').classList.add('show');
  setTimeout(()=>{ _focusables()[0]?.focus(); }, 0);
  // mpv 覆蓋視窗會蓋住置中的對話框，開啟對話框時先隱藏
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(false).catch(()=>{});
}
function closeModal(){
  const prev=_modalPrevFocus; _modalPrevFocus=null;
  $('modalBg').classList.remove('show');
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
$('modalBg').addEventListener('mousedown',e=>{if(e.target===$('modalBg'))closeModal();});
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
    e.preventDefault(); e.stopPropagation();
    $('modalFoot')?.querySelector('button.primary')?.click();
  }
},true);

export { setStatus, showToast, showOsd, openModal, closeModal };

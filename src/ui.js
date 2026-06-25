/* SUB Tool — UI 基本元件：狀態列 / Toast / OSD / 對話框（葉節點，僅依賴 dom + media 執行期狀態） */
import { $ } from './dom.js';
import { Media } from './media.js';

/* 狀態列 / toast / modal */
function setStatus(msg,kind){ $('stMsg').textContent=msg; const d=$('stDot'); d.className='dot'+(kind?(' '+kind):''); }
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
  $('modalBg').classList.add('show');
  // mpv 覆蓋視窗會蓋住置中的對話框，開啟對話框時先隱藏
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(false).catch(()=>{});
}
function closeModal(){
  $('modalBg').classList.remove('show');
  if(Media.mpvMode && window.subtool?.mpv) window.subtool.mpv.show(true).catch(()=>{});
}
$('modalBg').addEventListener('mousedown',e=>{if(e.target===$('modalBg'))closeModal();});
$('modalBg').addEventListener('keydown',e=>{
  if(e.key==='Enter' && e.target.tagName!=='TEXTAREA'){
    e.preventDefault(); e.stopPropagation();
    $('modalFoot')?.querySelector('button.primary')?.click();
  }
},true);

export { setStatus, showToast, showOsd, openModal, closeModal };

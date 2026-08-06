/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/ui.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — UI 基本元件：狀態列 / Toast / OSD / 對話框（葉節點，僅依賴 dom + media 執行期狀態） */
import { $ } from './dom.js';
import { Media } from './media.js';
import { emit } from './events.js';

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
/* opts.onDismiss：對話框在【沒有被確認】的情況下關閉時呼叫（取消鈕、Esc、點遮罩）。
   會即時預覽的對話框需要它才能把值還原——否則使用者調完滑桿按 Esc，
   看起來是取消了，值卻已經被寫進去（v5.7.0 前的「圖片大小與位置」正是如此）。
   確認的那顆按鈕要呼叫 closeModal({committed:true}) 才不會觸發還原。 */
function openModal(title,html,buttons,opts={}){
  _modalDismiss = typeof opts.onDismiss==='function' ? opts.onDismiss : null;
  $('modalTitle').textContent=title; $('modalBody').innerHTML=html;
  const foot=$('modalFoot'); foot.innerHTML='';
  (buttons||[{label:'關閉',primary:true,act:closeModal}]).forEach(b=>{
    const btn=document.createElement('button'); btn.textContent=b.label; if(b.primary)btn.className='primary';
    btn.onclick=b.act; foot.appendChild(btn);
  });
  const bg=$('modalBg');
  const modalEl=bg.querySelector('.modal');
  if(modalEl) {
    modalEl.style.width=opts.width||'';
    modalEl.style.transform = '';
  }
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
  if(!_modalKeepVideo && Media.mpvMode) setMpvWindowVisible(false);
}
/* arg 可能是 MouseEvent（`act: closeModal` 這種直接當 handler 用的呼叫點），
   那時 committed 會是 undefined＝視為取消，正是取消鈕該有的語意。 */
function closeModal(arg){
  const committed = !!(arg && arg.committed === true);
  const dismiss = _modalDismiss; _modalDismiss=null;
  if(!committed && dismiss){ try{ dismiss(); }catch(e){ console.warn('modal onDismiss:',e); } }
  const prev=_modalPrevFocus; _modalPrevFocus=null;
  const bg=$('modalBg');
  bg.classList.remove('show','dock-right','clear-bg');
  _modalKeepVideo=false;
  // X2：把焦點還給開啟前的元素。延到下一個 tick，避免「隱藏對話框→焦點元素被瀏覽器
  // 同步 blur 到 body」覆蓋掉我們的還原。
  if(prev && prev.focus){ setTimeout(()=>{ try{ prev.focus(); }catch(e){} }, 0); }
  if(Media.mpvMode) setMpvWindowVisible(true);
}
// X2：對話框內可聚焦元素（用於初始聚焦與 Tab 焦點陷阱）
let _modalPrevFocus=null;
// 未確認就關閉時要跑的還原邏輯（見 openModal 的 opts.onDismiss）
let _modalDismiss=null;
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

// modal drag
let _mDragging=false, _mStartX=0, _mStartY=0, _mStartTx=0, _mStartTy=0;
$('modalTitle').addEventListener('pointerdown', e=>{
  if(e.button!==0) return;
  _mDragging=true; _mStartX=e.clientX; _mStartY=e.clientY;
  const m = $('modalBg').querySelector('.modal');
  const style = window.getComputedStyle(m);
  const matrix = new DOMMatrixReadOnly(style.transform);
  _mStartTx = matrix.m41; _mStartTy = matrix.m42;
  $('modalTitle').setPointerCapture(e.pointerId);
});
$('modalTitle').addEventListener('pointermove', e=>{
  if(!_mDragging) return;
  const dx = e.clientX - _mStartX, dy = e.clientY - _mStartY;
  $('modalBg').querySelector('.modal').style.transform = `translate(${_mStartTx+dx}px, ${_mStartTy+dy}px)`;
});
$('modalTitle').addEventListener('pointerup', e=>{ _mDragging=false; $('modalTitle').releasePointerCapture(e.pointerId); });

/* ── mpv 的 OS 層視窗要不要顯示 ─────────────────────────────────────────────
   【一律走這支，不要走 getPlayerAdapter().show()】

   mpv 視窗是【主程序擁有的 OS 層子視窗】。「它在不在」跟「renderer 現在用哪個
   adapter 在播」是兩件事，而這兩件事會脫鉤：

     src/media.js 的 _ensureClip 在序列切到原生格式的片段時會
     `setPlayerAdapter(new Html5Adapter(video))`，卻【沒有】把 Media.mpvMode 設回
     false（全專案只有 Media.reset() 會設 false）。於是 mpvMode 仍是 true、
     mpv 視窗仍然開著，但 getPlayerAdapter() 已經是 Html5Adapter——
     它的 show() 是基底類別的 no-op，訊息根本沒送出去，視窗當然不會讓位。

   真實事故（v6.1.10）：工具列選單接上了讓位機制、單元測試全綠、CDP 也證實
   _syncMpvPanel 確實走到了新分支並算出「重疊」，使用者實測卻還是
   「被播放視窗遮住」。差別就在 openModal 從一開始就是【直接送 IPC】
   （所以對話框從來沒出過這個問題），而 _syncMpvPanel 走的是 adapter。 */
function setMpvWindowVisible(v){
  window.subtool?.mpv?.show(!!v)?.catch?.(()=>{});
}

/* ── 工具列的下拉選單（.menu / .menu.open .items）────────────────────────────
   【開合一律走這兩支，不要自己動 classList】

   除了加減 class，它們還要 `emit('mpv:sync')`。mpv 是 OS 層子視窗，HTML 的
   z-index 蓋不過它；展開的選單若伸進影片區就會整個被蓋在下面。訂閱者
   `_syncMpvPanel()`（video-renderer.js）會量 `.menu.open .items` 與 videoWrap
   的矩形，真的重疊才讓 mpv 讓位——不重疊時影片繼續顯示，不會為了一個選單閃黑。

   真實事故（v6.1.9）：「最近開啟」展開後最多 10 筆、每筆兩行，高度遠超過工具列，
   直接伸進影片區，於是選單「打得開但完全看不到」。同一個讓位機制浮動面板、
   搜尋視窗、右鍵選單早就接上了，只有工具列選單漏掉——先前沒被發現，是因為在
   這之前工具列選單都很矮，撐不到影片區。

   放在 ui.js 而不是 app.js：`src/recent-projects.js` 也要關選單，而 §7 的架構規則
   是「沒有任何模組可以 import app.js」。 */
function closeMenus(keepFor){
  let changed=false;
  document.querySelectorAll('.menu.open').forEach(m=>{
    if(keepFor && m.contains(keepFor)) return;
    m.classList.remove('open'); changed=true;
  });
  if(changed) emit('mpv:sync');
  return changed;
}
function openMenu(m){
  if(!m) return;
  closeMenus();
  m.classList.add('open');
  emit('mpv:sync');
}
/* 選單內容是非同步填進去的（最近開啟要等主程序回清單），高度會在打開【之後】才長出來。
   填完要再算一次，否則讓位判斷用的是還沒長高的矩形。 */
function syncMenuOverlay(){ emit('mpv:sync'); }

export { setStatus, showToast, showOsd, openModal, closeModal, promptModal,
  closeMenus, openMenu, syncMenuOverlay, setMpvWindowVisible };


/* ==============================================================================
   SUB Tool — UI 基本元件 (src/ui.js)
   ==============================================================================
   狀態列 / Toast / OSD / 對話框 / 面板開合 / 快取管理對話框
   ============================================================================== */
import { $ } from './dom.js';
import { State } from './state.js';
import { Media } from './media.js';
import { emit } from './events.js';
import { getNativePreviewRuntime } from './media-player-adapter.js';
import { secToEncore } from './time.js';

/* 狀態列 / toast / modal */
export function renderProjectIdentity({name}={}) {
  const label=name||'未命名專案';
  document.title=label+' — SUB TOOL';
}

// 播放讀數與使用者的時碼草稿共用同一位置；背景更新不能移除正在輸入的節點。
export function renderCurrentTimecode(time) {
  const label = $('tcCur');
  if (!label || label.querySelector('input')) return;
  const text = secToEncore(time, State.fps, State.dropFrame);
  if (label.textContent !== text) label.textContent = text;
}

// X6：狀態點除顏色外提供文字等價（aria-label），供報讀器與非顏色辨識
const _DOT_LABEL = { ok: '就緒', err: '錯誤', busy: '處理中', '': '閒置' };
let _statusLocked = false;
let _status = null;
let _mediaIntakeStatus = null;
function setStatus(msg, kind, force = false) {
  if (_statusLocked && !force) return;
  if (force === 'lock') _statusLocked = true;
  else if (force === 'unlock') _statusLocked = false;
  _status = {msg,kind};
  // 背景準備期間仍讓錯誤可見；後續進度恢復時 toast 保留閱讀時間。
  if (_mediaIntakeStatus && kind === 'err') showToast(msg);
  renderStatus(_statusLocked || kind === 'err' || force === true ? _status : _mediaIntakeStatus || _status);
}

// 進度的生命週期由 MediaIntakeJobs 持有；UI 只負責顯示優先序，不鎖住匯出。
export function setMediaIntakeStatus(msg, kind = 'busy', detail = null, parts = null) {
  if (!_status) _status = {msg:$('stMsg')?.textContent || '',kind:''};
  _mediaIntakeStatus = msg == null ? null : {msg,kind,detail,parts};
  renderStatus(_statusLocked ? _status : _mediaIntakeStatus || _status);
}

function renderStatus({msg,kind,detail,parts}) {
  const msgEl = $('stMsg');
  if (msgEl) {
    msgEl.classList.toggle('status-pair',Array.isArray(parts));
    if(Array.isArray(parts)){
      msgEl.replaceChildren(...parts.map((text,index)=>{
        const span=document.createElement('span');span.className=index===1?'status-pair-separator':'status-pair-item';span.textContent=text;return span;
      }));
    }else msgEl.textContent = msg;
    msgEl.title=detail||msg;
    msgEl.setAttribute('aria-label',detail||msg);
  }
  const d = $('stDot');
  if (d) {
    d.className = 'dot' + (kind ? (' ' + kind) : '');
    d.setAttribute('aria-label', _DOT_LABEL[kind || ''] ?? '');
  }
}

let toastT;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3500);
}

let _osdT;
function showOsd(text) {
  const el = $('speedOsd');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(_osdT);
  _osdT = setTimeout(() => el.classList.remove('show'), 1000);
}

let _modalKeepVideo = false;
let _modalPrevFocus = null;
let _modalDismiss = null;
let _modalReplaced = null;
let _modalGeneration = 0;
let _modalCloseOnBackdrop = true;
let _lastFocusedOutsideModal = null;

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', e => {
    const modalBg = $('modalBg');
    if (modalBg && !modalBg.contains(e.target)) _lastFocusedOutsideModal = e.target;
  });
}

function _focusables(modal = $('modalBg')?.querySelector('.modal')) {
  if (!modal) return [];
  return [...modal.querySelectorAll('button, [href], input, select, textarea, summary, [contenteditable="true"], [tabindex]')]
    .filter(el => !el.matches(':disabled, [tabindex="-1"]') && el.offsetParent !== null && getComputedStyle(el).visibility === 'visible');
}

function openModal(title, html, buttons, opts = {}) {
  const replaced = _modalReplaced;
  const generation = ++_modalGeneration;
  const session = {
    isCurrent: () => generation === _modalGeneration,
    close: arg => { if (generation === _modalGeneration) closeModal(arg); },
  };
  _modalDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : null;
  _modalReplaced = typeof opts.onReplaced === 'function' ? opts.onReplaced : null;
  // Replacement is opt-in: routing dialogs intentionally redraw the same draft.
  if (replaced) replaced();
  _modalCloseOnBackdrop = opts.closeOnBackdrop !== false;
  const titleEl = $('modalTitle');
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  const bodyEl = $('modalBody');
  if (bodyEl) bodyEl.innerHTML = html;
  const foot = $('modalFoot');
  if (foot) {
    foot.innerHTML = '';
    (buttons || [{ label: '關閉', primary: true, act: closeModal }]).forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      if (b.id) btn.id = b.id;
      if (b.className) btn.className = (btn.className ? btn.className + ' ' : '') + b.className;
      if (b.hidden) btn.style.display = 'none';
      if (b.style && typeof b.style === 'object') Object.assign(btn.style, b.style);
      btn.onclick = b.act;
      foot.appendChild(btn);
    });
  }
  const bg = $('modalBg');
  if (!bg) return session;
  const modalEl = bg.querySelector('.modal');
  if (modalEl) {
    modalEl.style.width = opts.width || '';
    modalEl.style.transform = '';
  }
  _modalKeepVideo = !!opts.keepVideo;
  bg.classList.toggle('dock-right', _modalKeepVideo || opts.dock === 'right');
  bg.classList.toggle('clear-bg', _modalKeepVideo);
  _modalPrevFocus = _lastFocusedOutsideModal || document.activeElement;
  bg.classList.add('show');
  if (bodyEl) {
    bodyEl.scrollTop = 0;
    bodyEl.scrollLeft = 0;
  }
  setTimeout(() => {
    if (!session.isCurrent()) return;
    const first = _focusables(modalEl).find(el => !el.closest('.mhead'));
    (first || modalEl)?.focus({preventScroll:true});
  }, 0);
  if (Media.mpvMode) emit('mpv:sync');
  return session;
}

function closeModal(arg) {
  const committed = !!(arg && arg.committed === true);
  const dismiss = _modalDismiss;
  const generation = ++_modalGeneration;
  _modalDismiss = null;
  _modalReplaced = null;
  _modalCloseOnBackdrop = true;
  const prev = _modalPrevFocus;
  _modalPrevFocus = null;
  const bg = $('modalBg');
  if (bg) bg.classList.remove('show', 'dock-right', 'clear-bg');
  _modalKeepVideo = false;
  if (prev?.isConnected) {
    setTimeout(() => {
      const focused = document.activeElement;
      if (generation === _modalGeneration && prev.isConnected && (focused === document.body || bg?.contains(focused))) {
        prev.focus({preventScroll:true});
      }
    }, 0);
  }
  if (Media.mpvMode) emit('mpv:sync');
  if (!committed && dismiss) {
    try { dismiss(); } catch (e) { console.warn('modal onDismiss:', e); }
  }
}

const modalBg = $('modalBg');
if (modalBg) {
  modalBg.addEventListener('mousedown', e => {
    if (e.target === $('modalBg') && !_modalKeepVideo && _modalCloseOnBackdrop) closeModal();
  });
  modalBg.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      const f = _focusables();
      if (f.length) {
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
      if (e.isComposing || e.keyCode === 229) return;
      // Enter belongs to the focused native control. In particular, focusing
      // Cancel must never activate a destructive primary button instead.
      if (e.target.closest('button, a[href], select, summary, :disabled, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"], input[type="color"]')) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      $('modalFoot')?.querySelector('button.primary')?.click();
    }
  }, true);
}

function promptModal(title, label, defVal = '', { placeholder = '', okLabel = '確定' } = {}) {
  return new Promise(resolve => {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let done = false;
    const cancel = () => { if (!done) { done = true; resolve(null); } };
    const finish = v => { if (done) return; done = true; closeModal({ committed: true }); resolve(v); };
    openModal(title,
      `<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">${esc(label)}</div>` +
      `<input type="text" id="__promptInput" value="${esc(defVal)}" placeholder="${esc(placeholder)}" ` +
      `style="width:100%;box-sizing:border-box;font-size:14px;padding:7px 9px;background:var(--panel2);` +
      `border:1px solid var(--border2);border-radius:5px;color:var(--text)">`,
      [{ label: okLabel, primary: true, act: () => { const v = ($('__promptInput')?.value || '').trim(); finish(v || null); } },
       { label: '取消', act: () => finish(null) }], { onDismiss: cancel, onReplaced: cancel });
    const input = $('__promptInput');
    setTimeout(() => { if (!done && input?.isConnected) { input.focus(); input.select(); } }, 30);
  });
}

// Keep the whole overlay, including its close control, within reach after dragging or resizing.
function viewportOverlayPosition(rect, left, top) {
  const margin = 12;
  return {
    left: Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin)),
    top: Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin)),
  };
}

export function keepPanelInViewport(panel, left, top) {
  const rect = panel.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const position = viewportOverlayPosition(rect, left ?? rect.left, top ?? rect.top);
  if (position.left === rect.left && position.top === rect.top) return;
  Object.assign(panel.style, { right:'auto', bottom:'auto', left:position.left+'px', top:position.top+'px' });
}

export function bindOverlayDrag(panel, handle, place = keepPanelInViewport) {
  let drag;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button, input, select, textarea, a[href]')) return;
    const { left, top } = panel.getBoundingClientRect();
    drag = { pointerId:event.pointerId, x:event.clientX - left, y:event.clientY - top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.pointerId) return;
    place(panel, event.clientX - drag.x, event.clientY - drag.y);
    emit('mpv:sync');
  });
  handle.addEventListener('lostpointercapture', () => { drag = null; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
    place(panel);
    emit('mpv:sync');
  }).observe(panel);
}

function moveModalInViewport(modal, left, top) {
  const rect = modal.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const position = viewportOverlayPosition(rect, left ?? rect.left, top ?? rect.top);
  if (position.left === rect.left && position.top === rect.top) return;
  modal.style.transform = `translate(${position.left - modal.offsetLeft}px, ${position.top - modal.offsetTop}px)`;
}
const titleBar = $('modalTitle');
const modal = modalBg?.querySelector('.modal');
if (titleBar && modal) {
  bindOverlayDrag(modal, titleBar, moveModalInViewport);
  window.addEventListener('resize', () => {
    if (modal.style.transform && modalBg.classList.contains('show')) moveModalInViewport(modal);
  });
}

function setMpvWindowVisible(v) {
  getNativePreviewRuntime().setNativeVisible(!!v).catch(() => {});
}

function closeMenus(keepFor) {
  let changed = false;
  document.querySelectorAll('.menu.open').forEach(m => {
    if (keepFor && m.contains(keepFor)) return;
    m.classList.remove('open');
    changed = true;
  });
  if (changed) emit('mpv:sync');
  return changed;
}

function openMenu(m) {
  if (!m) return;
  closeMenus();
  m.classList.add('open');
  emit('mpv:sync');
}

function syncMenuOverlay() {
  emit('mpv:sync');
}

function _ensurePanelInRightArea(panel) {
  if (!Media.mpvMode || !getNativePreviewRuntime().isAvailable) return;
  const vr = $('videoWrap')?.getBoundingClientRect();
  if (!vr) return;
  const pr = panel.getBoundingClientRect();
  if (pr.left < vr.right + 4) {
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = (vr.right + 8) + 'px';
    panel.style.top = Math.max(50, Math.min(pr.top, window.innerHeight - 120)) + 'px';
  }
}

const panelOrigins = new WeakMap();
const panelOpenTokens = new WeakMap();
function syncPanelTriggers(panel, open) {
  document.querySelectorAll(`[aria-controls="${panel.id}"]`).forEach(button => button.setAttribute('aria-expanded', String(open)));
  if (panel.id === 'checkPanel') $('checkPanelBtn')?.classList.toggle('sub-active', open);
}

export function closePanel(id, { restoreFocus = true } = {}) {
  const panel = $(id);
  if (!panel) return;
  const hadFocus = panel.contains(document.activeElement);
  panel.classList.remove('show');
  panelOpenTokens.delete(panel);
  syncPanelTriggers(panel, false);
  const origin = panelOrigins.get(panel);
  panelOrigins.delete(panel);
  if (restoreFocus && hadFocus && origin?.isConnected) origin.focus({preventScroll:true});
  emit('mpv:sync');
}

function togglePanel(id) {
  const p = $(id);
  if (!p) return;
  const willShow = !p.classList.contains('show');
  const focused = document.activeElement === document.body ? _lastFocusedOutsideModal : document.activeElement;
  const origin = panelOrigins.get(focused?.closest?.('.float-panel')) || focused;
  document.querySelectorAll('.float-panel.show').forEach(x => closePanel(x.id, {restoreFocus:!willShow}));
  if (willShow) {
    const token = {};
    panelOrigins.set(p, origin);
    panelOpenTokens.set(p, token);
    p.classList.add('show');
    syncPanelTriggers(p, true);
    p.tabIndex = -1;
    emit('mpv:sync');
    setTimeout(() => {
      if (panelOpenTokens.get(p) !== token || !p.classList.contains('show')) return;
      _ensurePanelInRightArea(p);
      keepPanelInViewport(p);
      if (!$('modalBg')?.classList.contains('show') && !$('settingsModal')) {
        // 面板不是表單對話框，不預選歸零、刪除或篩選欄位。
        // 中性容器保留 Esc 關閉及 Tab 導覽，Space 可直接控制播放。
        p.focus({preventScroll:true});
      }
      emit('mpv:sync');
    }, 0);
  } else {
    emit('mpv:sync');
  }
}

function _fmtBytes(n) {
  n = +n || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// A closed dialog relinquishes its UI, not the cleanup already sent to main.
// Reopening the same source observes that work instead of submitting it again.
const cacheClearOperations=new Map();

async function openCacheDialog() {
  const DESK = window.subtool;
  if (!DESK || !DESK.cacheInfo) { showToast('快取管理僅在桌面版可用'); return; }
  const displayedSource=State.mediaPath||null;
  const ownsSource=()=> (State.mediaPath||null)===displayedSource;
  const running=cacheClearOperations.get(displayedSource);
  const loading = openModal('轉檔快取', '<p class="cache-loading" role="status">正在讀取快取保存紀錄…</p>', [{ label: '關閉', primary: true, act: closeModal }]);
  
  let info;
  try {
    info = running ? running.info : displayedSource ? await DESK.cacheInfo(displayedSource) : null;
  } catch (e) {
    info = { unavailable: true };
  }
  
  if (!loading.isCurrent()) return;
  if(!ownsSource()){loading.close();showToast('目前影片已變更，請重新開啟快取管理');return;}
  
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const locations=info?.source?.path===displayedSource?(info.source.locations||[]).filter(location=>location.kind==='sidecar'):[];
  const sourceSummary=!displayedSource?'<section class="cache-source-summary"><h3>目前素材</h3><p class="cache-note">請先開啟素材，再查看或清除同資料夾的波形、Proxy 與聲道快取。</p></section>':`<section class="cache-source-summary"><h3>目前素材</h3><p class="cache-path">${esc(displayedSource)}</p>`+
    (!info?.source||info.source.path!==displayedSource||info.source.unavailable?'<p class="cache-unavailable">無法確認目前素材的快取紀錄，請檢查來源與目錄權限後重新整理。</p>':locations.length?locations.map(location=>{
      const wave=location.waveform||{};
      const progress=Number.isSafeInteger(wave.completedSamples)&&Number.isSafeInteger(wave.totalSamples)
        ?` ${ (wave.completedSamples/4000).toFixed(1)} / ${(wave.totalSamples/4000).toFixed(1)} 秒`:'';
      const waveText=wave.state==='complete'?'紀錄已完成':wave.state==='partial'?'部分保存紀錄'+progress:wave.state==='unknown'?'無法確認':'未找到完成紀錄';
      return '<div class="cache-source-location"><h4>同資料夾快取</h4>'+
        `<p class="cache-path">${esc(location.directory)}</p><dl class="cache-records"><dt>波形</dt><dd>${esc(waveText)}</dd>`+
        (Number.isSafeInteger(wave.bytes)?`<dt>波形檔大小</dt><dd>${_fmtBytes(wave.bytes)}</dd>`:'')+
        `<dt>Proxy</dt><dd>${location.proxy?'已有完整紀錄':'未找到完整紀錄'}</dd><dt>聲道</dt><dd>${Number(location.channels)||0} 條</dd></dl></div>`;
    }).join(''):'<p class="cache-note">尚未找到屬於目前素材的保存紀錄。</p>')+
    '<p class="cache-note">此處只查保存紀錄與檔案大小；使用前重新驗證來源與內容，不代表已完成內容查核。</p></section>';
  const html =
    `<div class="cache-dialog-content">` +
    sourceSummary+
    `<details class="cache-help"><summary>保存位置與清除範圍</summary><p>Proxy、聲道與波形只保存在素材同資料夾的 <code>.subtool_Cache</code>，無法寫入時會提示原因。同一 NAS 來源可在核對後跨電腦沿用；中斷的波形可從有效檢查點續算，快取不因放置天數過期。</p><p>Proxy 使用 480p、1000 kb/s 與速度優先的編碼設定，直接讀取同資料夾快取。</p><p>清除只處理目前素材的 Proxy、聲道與原音波形快取，其他素材不受影響。</p></details>` +
    '<p id="cacheActionStatus" role="status" hidden></p>'+
    '<p id="cacheActionError" class="cache-unavailable" role="alert" hidden></p>'+
    `</div>`;
  const observeClear=async(session,work,buttonId,confirmation=false)=>{
    const button=document.getElementById(buttonId),status=document.getElementById('cacheActionStatus'),error=document.getElementById('cacheActionError');
    button.disabled=true;button.textContent='清除中…';
    status.textContent='清除中…可關閉此視窗，清除工作會繼續。';status.hidden=false;error.hidden=true;
    const outcome=await work.promise;
    if(!session.isCurrent()||!ownsSource())return;
    const r=outcome.result;
    const message=outcome.error?'清除快取失敗：'+(outcome.error.message||String(outcome.error))+'。請重試。'
      :r?.reason==='busy'?'快取仍在處理或使用中，請完成或停止後再清除'
      :r?.incomplete===true?`已處理部分快取，釋放 ${_fmtBytes(r.bytes)}；部分項目仍在使用或無法確認，已保留`
      :r?.incomplete===false?`已清除快取，釋放 ${_fmtBytes(r.bytes)}`
      :`已處理快取，釋放 ${_fmtBytes(r?.bytes)}`;
    const failed=!!outcome.error||r?.reason==='busy';
    status.hidden=failed;error.hidden=!failed;(failed?error:status).textContent=message;
    const complete=!outcome.error&&r?.incomplete===false;
    if(complete&&!confirmation){
      const summary=document.querySelector('.cache-source-summary');
      if(summary)summary.innerHTML=`<h3>目前素材</h3><p class="cache-path">${esc(displayedSource)}</p><p class="cache-note">快取已清除，重新整理可查看最新保存紀錄。</p>`;
    }
    button.disabled=confirmation&&complete;
    button.textContent=confirmation?(complete?'已完成':'確定清除'):'清除快取';
    showToast(message);
  };
  const buttons = [
    { label: '清除快取', id:'cacheClear', className:'del-btn', act: () => {
        if (!session.isCurrent()||!displayedSource||cacheClearOperations.has(displayedSource)) return;
        // 清除資格屬於使用者看到的母素材，不能在確認後才讀取新專案的路徑。
        if(!ownsSource()){session.close();showToast('目前影片已變更，請重新開啟快取管理並確認');return;}
        let clearing = false;
        const sourceLabel = `<p class="cache-path">${esc(displayedSource)}</p>`;
        const confirmation = openModal('清除快取？', '<div class="cache-dialog-content"><p>將刪除目前素材在 .subtool_Cache 內的 Proxy、聲道與原音波形快取；其他素材不受影響。</p>' + sourceLabel + '<p class="cache-note">下次開啟同檔可能需要重新轉檔。</p><p id="cacheActionStatus" role="status" hidden></p><p id="cacheActionError" class="cache-unavailable" role="alert" hidden></p></div>', [
          { label: '確定清除', primary: true, id:'cacheClearConfirm', act: async () => {
            if (!confirmation.isCurrent() || clearing || cacheClearOperations.has(displayedSource)) return;
            if (!ownsSource()) {
              confirmation.close();
              showToast('目前影片已變更，請重新開啟快取管理並確認');
              return;
            }
            clearing = true;
            const work={info};cacheClearOperations.set(displayedSource,work);
            work.promise=(async()=>{
              try{return {result:await DESK.cacheClearAll(displayedSource)};}
              catch(error){return {error};}
              finally{if(cacheClearOperations.get(displayedSource)===work)cacheClearOperations.delete(displayedSource);}
            })();
            try{await observeClear(confirmation,work,'cacheClearConfirm',true);}
            finally{clearing=false;}
            },
          },
          { label: '關閉', act: ()=>confirmation.close() },
        ]);
      },
    },
    { label: '重新整理', id:'cacheRefresh', act: openCacheDialog },
    { label: '關閉', primary: true, act: closeModal },
  ];
  const session = openModal('轉檔快取', html, buttons, {width:'600px'});
  document.getElementById('cacheClear').disabled=!displayedSource;
  if(running)void observeClear(session,running,'cacheClear');
}

export function renderQueueMonitorIndicator(button, snapshot = {}) {
  if (!button?.classList) return false;
  const rawCount = Number(snapshot?.liveCount);
  const liveCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
  const running = liveCount > 0;
  const status = running ? `${liveCount} 份正在轉檔` : '目前沒有正在轉檔';

  button.classList.toggle('queue-running', running);
  button.setAttribute('aria-label', `監控匯出佇列，${status}；快捷鍵 .`);
  button.title = `監控匯出佇列（${status}，快捷鍵 .）`;
  return running;
}

export function renderAsrIndicator(button, session = null) {
  if (!button?.classList) return false;
  const status = session?.progress?.status;
  const running = !!(
    session &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled'
  );
  const reviewable = !!(session && (status === 'completed' || status === 'failed'));
  const visible = running || reviewable;

  button.classList.toggle('asr-running', running);
  button.style.display = visible ? '' : 'none';

  if (!visible) {
    button.removeAttribute('aria-label');
    button.removeAttribute('title');
    return false;
  }

  const rawPercent = session.progress?.percent;
  const isIndeterminate = session.progress?.indeterminate || !Number.isFinite(rawPercent);
  const percentText = isIndeterminate ? '推論中' : `${Math.max(0, Math.min(100, Math.round(rawPercent)))}%`;
  const taskLabel = session.taskMode === 'align' ? '文本匹配' : '語音辨識';

  const labelEl = button.querySelector('#asrMonitorLbl') || button.querySelector('.lbl');
  const stateText = status === 'completed' ? '完成' : (status === 'failed' ? '失敗' : percentText);
  if (labelEl) {
    labelEl.textContent = `🎙 ${taskLabel} ${stateText}`;
  }

  const detail = session.statusText || session.progress?.message || '';
  const tooltip = reviewable
    ? `${taskLabel}${stateText}${detail ? `（${detail}）` : ''}— 點擊查看結果`
    : `${taskLabel}進行中（${percentText}${detail ? ` · ${detail}` : ''}）— 點擊查看進度視窗`;
  button.title = tooltip;
  button.setAttribute('aria-label', tooltip);

  return true;
}

export {
  setStatus,
  showToast,
  showOsd,
  openModal,
  closeModal,
  promptModal,
  closeMenus,
  openMenu,
  syncMenuOverlay,
  setMpvWindowVisible,
  togglePanel,
  _ensurePanelInRightArea,
  openCacheDialog,
};

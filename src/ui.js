/* ==============================================================================
   SUB Tool — UI 基本元件 (src/ui.js)
   ==============================================================================
   狀態列 / Toast / OSD / 對話框 / 面板開合 / 快取管理對話框
   ============================================================================== */
import { $ } from './dom.js';
import { Media } from './media.js';
import { emit } from './events.js';
import { getNativePreviewRuntime } from './media-player-adapter.js';

/* 狀態列 / toast / modal */
// X6：狀態點除顏色外提供文字等價（aria-label），供報讀器與非顏色辨識
const _DOT_LABEL = { ok: '就緒', err: '錯誤', busy: '處理中', '': '閒置' };
let _statusLocked = false;
function setStatus(msg, kind, force = false) {
  if (_statusLocked && !force) return;
  if (force === 'lock') _statusLocked = true;
  else if (force === 'unlock') _statusLocked = false;
  
  const msgEl = $('stMsg');
  if (msgEl) msgEl.textContent = msg;
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
let _lastFocusedOutsideModal = null;

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', e => {
    const modalBg = $('modalBg');
    if (modalBg && !modalBg.contains(e.target)) _lastFocusedOutsideModal = e.target;
  });
}

function _focusables() {
  const m = $('modalBg')?.querySelector('.modal');
  if (!m) return [];
  return Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function openModal(title, html, buttons, opts = {}) {
  _modalDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : null;
  const titleEl = $('modalTitle');
  if (titleEl) titleEl.textContent = title;
  const bodyEl = $('modalBody');
  if (bodyEl) bodyEl.innerHTML = html;
  const foot = $('modalFoot');
  if (foot) {
    foot.innerHTML = '';
    (buttons || [{ label: '關閉', primary: true, act: closeModal }]).forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      btn.onclick = b.act;
      foot.appendChild(btn);
    });
  }
  const bg = $('modalBg');
  if (!bg) return;
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
  setTimeout(() => { _focusables()[0]?.focus(); }, 0);
  if (!_modalKeepVideo && Media.mpvMode) setMpvWindowVisible(false);
}

function closeModal(arg) {
  const committed = !!(arg && arg.committed === true);
  const dismiss = _modalDismiss;
  _modalDismiss = null;
  if (!committed && dismiss) {
    try { dismiss(); } catch (e) { console.warn('modal onDismiss:', e); }
  }
  const prev = _modalPrevFocus;
  _modalPrevFocus = null;
  const bg = $('modalBg');
  if (bg) bg.classList.remove('show', 'dock-right', 'clear-bg');
  _modalKeepVideo = false;
  if (prev && prev.focus) {
    setTimeout(() => { try { prev.focus(); } catch (e) {} }, 0);
  }
  if (Media.mpvMode) setMpvWindowVisible(true);
}

const modalBg = $('modalBg');
if (modalBg) {
  modalBg.addEventListener('mousedown', e => {
    if (e.target === $('modalBg') && !_modalKeepVideo) closeModal();
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
      if (e.isComposing) return;
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
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    openModal(title,
      `<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">${esc(label)}</div>` +
      `<input type="text" id="__promptInput" value="${esc(defVal)}" placeholder="${esc(placeholder)}" ` +
      `style="width:100%;box-sizing:border-box;font-size:14px;padding:7px 9px;background:var(--bg2);` +
      `border:1px solid var(--border2);border-radius:5px;color:var(--text)">`,
      [{ label: okLabel, primary: true, act: () => { const v = ($('__promptInput')?.value || '').trim(); finish(v || null); } },
       { label: '取消', act: () => finish(null) }]);
    setTimeout(() => { const el = $('__promptInput'); if (el) { el.focus(); el.select(); } }, 30);
  });
}

// Modal dragging
let _mDragging = false, _mStartX = 0, _mStartY = 0, _mStartTx = 0, _mStartTy = 0;
const titleBar = $('modalTitle');
if (titleBar) {
  titleBar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    _mDragging = true;
    _mStartX = e.clientX;
    _mStartY = e.clientY;
    const m = $('modalBg')?.querySelector('.modal');
    if (m) {
      const style = window.getComputedStyle(m);
      const matrix = new DOMMatrixReadOnly(style.transform);
      _mStartTx = matrix.m41;
      _mStartTy = matrix.m42;
    }
    titleBar.setPointerCapture(e.pointerId);
  });
  titleBar.addEventListener('pointermove', e => {
    if (!_mDragging) return;
    const dx = e.clientX - _mStartX, dy = e.clientY - _mStartY;
    const m = $('modalBg')?.querySelector('.modal');
    if (m) m.style.transform = `translate(${_mStartTx + dx}px, ${_mStartTy + dy}px)`;
  });
  titleBar.addEventListener('pointerup', e => {
    _mDragging = false;
    titleBar.releasePointerCapture(e.pointerId);
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

function togglePanel(id) {
  const p = $(id);
  if (!p) return;
  const willShow = !p.classList.contains('show');
  document.querySelectorAll('.float-panel.show').forEach(x => x.classList.remove('show'));
  if (willShow) {
    p.classList.add('show');
    setTimeout(() => { _ensurePanelInRightArea(p); emit('mpv:sync'); }, 0);
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

let _cacheDlgGen = 0;

async function openCacheDialog() {
  const DESK = window.subtool;
  if (!DESK || !DESK.cacheInfo) { showToast('快取管理僅在桌面版可用'); return; }
  const myGen = ++_cacheDlgGen;
  openModal('🗂 轉檔快取', '<div style="padding:6px 2px">讀取中…</div>', [{ label: '關閉', primary: true, act: closeModal }]);
  
  let info;
  try {
    info = await DESK.cacheInfo();
  } catch (e) {
    info = { folders: 0, bytes: 0, root: '' };
  }
  
  if (myGen !== _cacheDlgGen || !$('modalBg')?.classList.contains('show')) return;
  
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html =
    `<div style="padding:4px 2px;line-height:1.9">` +
    `<div>中央快取：<b>${info.folders}</b> 個項目，共 <b>${_fmtBytes(info.bytes)}</b></div>` +
    `<div style="font-size:11px;color:var(--muted);word-break:break-all;margin-top:2px">${esc(info.root || '')}</div>` +
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">說明：開啟影片時會把每個聲道與波形轉存到「影片同資料夾的 <code>.subtool_Cache</code>」內，其他電腦讀取同一個檔案時可直接沿用、不必重算。此處管理的是本機的中央快取。</div>` +
    `</div>`;
    
  const buttons = [
    { label: '清理孤兒檔', act: async () => {
        const r = await DESK.cacheCleanOrphans();
        showToast(`已清理 ${r.removed} 個無效項目，釋放 ${_fmtBytes(r.bytes)}`);
        openCacheDialog();
      },
    },
    { label: '全部清除', act: () => {
        openModal('確認清除', '<div style="padding:6px 2px">將刪除所有中央快取，以及目前開啟影片旁的 .subtool_Cache 資料夾。<br>下次開啟同檔需重新轉檔。確定？</div>', [
          { label: '確定清除', primary: true, act: async () => {
              const State = (await import('./state.js')).State;
              const r = await DESK.cacheClearAll(State.mediaPath || null);
              showToast(`已清除快取，釋放 ${_fmtBytes(r.bytes)}`);
              closeModal();
            },
          },
          { label: '取消', act: openCacheDialog },
        ]);
      },
    },
    { label: '關閉', primary: true, act: closeModal },
  ];
  openModal('🗂 轉檔快取', html, buttons);
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

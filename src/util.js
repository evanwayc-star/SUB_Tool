/* ==============================================================================
   SUB Tool — 基礎工具函式庫 (Utility Library)
   ==============================================================================
   【架構與職責】
   純計算與格式編碼輔助函式庫（數值裁切、補零、字元編碼偵測、Base64 轉碼、HTML 跳脫）。
   文字編碼由 shared/text-encoding.cjs 供 renderer 與主程序共用。
   ============================================================================== */
import { decodeText, encodeUTF16LE } from '../shared/text-encoding.cjs';

/**
 * 數值區間裁切。
 * @param {number} v 輸入數值
 * @param {number} a 最小值
 * @param {number} b 最大值
 * @returns {number} 限制在 [a, b] 區間內的數值
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 整數補零格式化。
 * @param {number} n 數值
 * @param {number} [w=2] 字串目標長度
 * @returns {string} 補零後字串
 */
const pad = (n, w = 2) => String(Math.floor(Number(n) || 0)).padStart(w, '0');

/**
 * 在瀏覽器端觸發二進位位元組下載。
 * 
 * @param {Uint8Array|ArrayBuffer|Blob} bytes 位元組資料
 * @param {string} name 下載檔名
 * @param {string} [mime='application/octet-stream'] MIME 類型
 */
function downloadBytes(bytes, name, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const isIOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );

  if (isIOS) {
    const reader = new FileReader();
    reader.onload = e => {
      const a = document.createElement('a');
      a.href = e.target.result;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    reader.readAsDataURL(blob);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 讀取 File 物件為 ArrayBuffer。
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error(`無法讀取檔案 ${file.name} (大小: ${(file.size / 1024 / 1024).toFixed(1)}MB)。可能是檔案過大超過瀏覽器記憶體限制，請改用桌面版。`));
    r.readAsArrayBuffer(file);
  });
}

const pendingFilePickers = new WeakMap();
/**
 * 喚起隱藏之 input[type=file] 元素選擇檔案。
 * @param {HTMLInputElement} inputEl
 * @returns {Promise<File[]>}
 */
function pickFiles(inputEl) {
  return new Promise(res => {
    if (!inputEl) {
      res([]);
      return;
    }
    pendingFilePickers.get(inputEl)?.([]);
    const finish = files => {
      if (pendingFilePickers.get(inputEl) !== finish) return;
      pendingFilePickers.delete(inputEl);
      inputEl.removeEventListener('change', onChange);
      inputEl.removeEventListener('cancel', onCancel);
      res(files);
    };
    const onChange = () => finish(Array.from(inputEl.files || []));
    const onCancel = () => finish([]);
    pendingFilePickers.set(inputEl, finish);
    inputEl.value = '';
    inputEl.addEventListener('change', onChange);
    inputEl.addEventListener('cancel', onCancel);
    try { inputEl.click(); } catch { finish([]); }
  });
}
function pickFile(inputEl) { return pickFiles(inputEl).then(files => files[0] || null); }

/**
 * Base64 字串轉 Uint8Array。
 */
function b64ToBytes(b64) {
  const bin = atob(b64 || '');
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    u[i] = bin.charCodeAt(i);
  }
  return u;
}

/**
 * Uint8Array 轉 Base64 字串。
 */
function bytesToB64(bytes) {
  if (!bytes) return '';
  let bin = '';
  const ch = 0x8000;
  for (let i = 0; i < bytes.length; i += ch) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
  }
  return btoa(bin);
}

/**
 * 萃取路徑字串之檔案基底名稱 (Base Name)。
 * @param {string} p
 * @returns {string}
 */
const baseName = p => (p || '').split(/[\\/]/).pop();

/**
 * HTML 特殊字元跳脫轉義（防禦 XSS）。
 * @param {string} s
 * @returns {string}
 */
function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

/**
 * HTML 特殊字元跳脫，並將半形/全形空白轉為視覺符號。
 * @param {string} s
 * @returns {string}
 */
function escapeHTMLWithSpaces(s) {
  return escapeHTML(s || '')
    .replace(/ /g, '<span class="space-mark space-mark-half">\u2423</span>')
    .replace(/　/g, '<span class="space-mark space-mark-full">\u25A1</span>');
}

/** 時間碼輸入欄位允許之導覽與編輯鍵清單 */
const _TC_NAV = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab', 'Enter', 'Escape'];

/**
 * 時間碼輸入框按鍵白名單過濾：
 * 只允許數字、時碼分隔符 (: ; + -)、導覽鍵與 Ctrl/Cmd 組合鍵。
 * 
 * @param {KeyboardEvent} e
 * @returns {boolean} 是否允許輸入
 */
function tcKeyAllowed(e) {
  if (!e) return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (_TC_NAV.includes(e.key)) return true;
  return !(e.key.length === 1 && !/[0-9:;+\-]/.test(e.key));
}

export {
  clamp,
  pad,
  decodeText,
  encodeUTF16LE,
  downloadBytes,
  readFile,
  pickFile,
  pickFiles,
  b64ToBytes,
  bytesToB64,
  baseName,
  escapeHTML,
  escapeHTMLWithSpaces,
  tcKeyAllowed,
};

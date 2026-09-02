/* ==============================================================================
   SUB Tool — 基礎工具函式庫 (Utility Library)
   ==============================================================================
   【架構與職責】
   純計算與格式編碼輔助函式庫（數值裁切、補零、字元編碼偵測、Base64 轉碼、HTML 跳脫）。
   零外部跨模組相依。
   ============================================================================== */

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
 * 偵測並解碼 ArrayBuffer 為 Unicode 字串（支援 UTF-8, UTF-16LE, UTF-16BE 及啟發式無 BOM 偵測）。
 * 
 * @param {ArrayBuffer} buf 輸入之二進位緩衝區
 * @returns {string} 解碼後之字串
 */
function decodeText(buf) {
  if (!buf) return '';
  const b = new Uint8Array(buf);

  // UTF-8 BOM
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(b.subarray(3));
  }
  // UTF-16LE BOM
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(b.subarray(2));
  }
  // UTF-16BE BOM
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(b.subarray(2));
  }

  // 無 BOM：採樣前 4000 位元組的零位元分布偵測 UTF-16
  let zEven = 0;
  let zOdd = 0;
  const n = Math.min(b.length, 4000);
  for (let i = 0; i < n; i++) {
    if (b[i] === 0) {
      if (i % 2 === 0) zEven++;
      else zOdd++;
    }
  }

  if (zOdd > n * 0.15 && zOdd > zEven * 3) {
    return new TextDecoder('utf-16le').decode(b);
  }
  if (zEven > n * 0.15 && zEven > zOdd * 3) {
    return new TextDecoder('utf-16be').decode(b);
  }
  return new TextDecoder('utf-8').decode(b);
}

/**
 * 將字串編碼為包含 BOM 的 UTF-16LE 二進位位元組陣列。
 * 
 * @param {string} str 輸入字串
 * @returns {Uint8Array} UTF-16LE 位元組陣列
 */
function encodeUTF16LE(str) {
  const s = String(str || '');
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xFF;
  out[1] = 0xFE;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xFF;
    out[3 + i * 2] = (c >> 8) & 0xFF;
  }
  return out;
}

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

/**
 * 喚起隱藏之 input[type=file] 元素選擇檔案。
 * @param {HTMLInputElement} inputEl
 * @returns {Promise<File|null>}
 */
function pickFile(inputEl) {
  return new Promise(res => {
    if (!inputEl) {
      res(null);
      return;
    }
    inputEl.value = '';
    inputEl.onchange = () => res(inputEl.files?.[0] || null);
    inputEl.click();
  });
}

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
  b64ToBytes,
  bytesToB64,
  baseName,
  escapeHTML,
  escapeHTMLWithSpaces,
  tcKeyAllowed,
};

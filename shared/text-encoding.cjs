'use strict';

/**
 * 相容 UTF-8／UTF-16LE／UTF-16BE 的文字檔解碼。
 * view 僅讀其範圍，不包含同一 backing buffer 的其他資料。
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {string}
 */
function decodeText(buf) {
  if (!buf) return '';
  const bytes = ArrayBuffer.isView(buf)
    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    : new Uint8Array(buf);

  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new globalThis.TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new globalThis.TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new globalThis.TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // 沿用舊檔無 BOM 的零位元分布偵測，避免改變既有專案及字幕的准入。
  let zeroEven = 0;
  let zeroOdd = 0;
  const length = Math.min(bytes.length, 4000);
  for (let i = 0; i < length; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zeroEven++;
      else zeroOdd++;
    }
  }
  if (zeroOdd > length * 0.15 && zeroOdd > zeroEven * 3) {
    return new globalThis.TextDecoder('utf-16le').decode(bytes);
  }
  if (zeroEven > length * 0.15 && zeroEven > zeroOdd * 3) {
    return new globalThis.TextDecoder('utf-16be').decode(bytes);
  }
  return new globalThis.TextDecoder('utf-8').decode(bytes);
}

/**
 * UTF-16LE 文字檔固定以 FF FE BOM 開頭；按 UTF-16 code unit 保留代理對。
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeUTF16LE(str) {
  const text = String(str || '');
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xFF;
  bytes[1] = 0xFE;
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    bytes[2 + i * 2] = codeUnit & 0xFF;
    bytes[3 + i * 2] = codeUnit >> 8;
  }
  return bytes;
}

module.exports = { decodeText, encodeUTF16LE };

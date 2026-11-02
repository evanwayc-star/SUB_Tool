'use strict';

// Main process owns the snapshots. Renderer receives only an opaque receipt;
// neither its payload nor its claim about a file can create overwrite consent.
const crypto = require('node:crypto');
const { captureDestinationEvidenceAsync, normalizeOutputPath } = require('./export-lease');

function createDeliveryConsent({ captureOutputAuthority, captureEvidence = captureDestinationEvidenceAsync,
  randomId = () => crypto.randomBytes(24).toString('hex') } = {}) {
  if (typeof captureOutputAuthority !== 'function') throw new TypeError('缺少交付輸出權限檢查');
  const receipts = new Map();
  function remove(id) {
    const receipt = receipts.get(id);
    if (!receipt) return false;
    receipts.delete(id);
    receipt.sender.removeListener?.('destroyed', receipt.destroyed);
    return true;
  }
  async function prepare(sender, paths, { signal } = {}) {
    if (!sender || sender.isDestroyed?.() || !Array.isArray(paths) || !paths.length || paths.length > 1000)
      throw new TypeError('缺少有效交付工作');
    const stopped = new AbortController();
    const cancel = () => stopped.abort(new Error('交付視窗已關閉'));
    const ownsSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
    sender.once?.('destroyed', cancel);
    try {
      const entries = new Map();
      for (const file of paths) {
        ownsSignal.throwIfAborted();
        if (sender.isDestroyed?.()) throw new Error('交付視窗已關閉');
        if (typeof file !== 'string' || !file.trim() || file.length > 32767 || file.includes('\0')) throw new TypeError('缺少有效輸出檔案');
        const key = normalizeOutputPath(file);
        if (entries.has(key)) throw new Error('交付清單包含重複輸出檔案');
        entries.set(key, await captureEvidence(captureOutputAuthority(file), { signal: ownsSignal }));
      }
      ownsSignal.throwIfAborted();
      if (sender.isDestroyed?.()) throw new Error('交付視窗已關閉');
      const id = randomId();
      if (typeof id !== 'string' || !id || receipts.has(id)) throw new Error('無法建立交付確認紀錄');
      const destroyed = () => remove(id);
      receipts.set(id, { sender, entries, destroyed });
      sender.once?.('destroyed', destroyed);
      return { id, existing: [...entries.values()].filter(item => item.destinationEvidence.identity !== null).map(item => item.requestedPath) };
    } finally {
      sender.removeListener?.('destroyed', cancel);
    }
  }
  function take(sender, id, file) {
    const receipt = typeof id === 'string' ? receipts.get(id) : null;
    if (!receipt || receipt.sender !== sender || sender.isDestroyed?.()) throw new Error('交付確認已失效，請重新送出');
    const key = normalizeOutputPath(file), authority = receipt.entries.get(key);
    if (!authority) throw new Error('交付確認與輸出檔案不符，請重新送出');
    receipt.entries.delete(key);
    if (!receipt.entries.size) remove(id);
    return authority;
  }
  function release(sender, id) {
    const receipt = typeof id === 'string' ? receipts.get(id) : null;
    return !!receipt && receipt.sender === sender && remove(id);
  }
  return { prepare, take, release };
}

module.exports = { createDeliveryConsent };

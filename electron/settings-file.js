'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

// settings.json 的 renderer 設定／最近專案／對話框目錄共用同一份讀改寫交易。
// 先寫相鄰暫存檔再 rename；壞 JSON 只在確實要更新時保存原始副本。
function createSettingsFile({ filePath, fsModule = fs } = {}) {
  const location = () => typeof filePath === 'function' ? filePath() : filePath;

  function decode(bytes) {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SyntaxError('設定檔必須是 JSON 物件');
    }
    return value;
  }

  function source(file) {
    try { return fsModule.readFileSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function read() {
    const bytes = source(location());
    return bytes == null ? {} : decode(bytes);
  }

  function update(merge) {
    const file = location();
    const bytes = source(file);
    let current = {};
    let corrupted = false;
    if (bytes != null) {
      try { current = decode(bytes); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; corrupted = true; }
    }
    const next = merge(current);
    const content = `${JSON.stringify(next, null, 2)}\n`;
    // 先驗證候選資料，避免 callback 回傳 undefined／陣列而損壞設定。
    decode(Buffer.from(content));
    if (corrupted) {
      fsModule.writeFileSync(`${file}.corrupt-${crypto.randomUUID()}`, bytes, { flag: 'wx' });
    }
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const descriptor = fsModule.openSync(temporary, 'wx');
    let open = true;
    try {
      fsModule.writeFileSync(descriptor, content, 'utf8');
      fsModule.closeSync(descriptor);
      open = false;
      fsModule.renameSync(temporary, file);
    } finally {
      if (open) { try { fsModule.closeSync(descriptor); } catch (error) {} }
      try { fsModule.unlinkSync(temporary); } catch (error) {}
    }
    return next;
  }

  return Object.freeze({ read, update });
}

module.exports = { createSettingsFile };

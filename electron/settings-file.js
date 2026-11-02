'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { sameSnapshot } = require('./file-content-evidence');

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

  const conflict = () => Object.assign(new Error('設定檔在儲存期間已變更，請重試'), { code:'SETTINGS_FILE_CHANGED' });
  function snapshot(file) {
    let before;
    try { before = fsModule.lstatSync(file, { bigint:true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw conflict();
    const bytes = fsModule.readFileSync(file);
    const after = fsModule.lstatSync(file, { bigint:true });
    if (!sameSnapshot(before, after) || BigInt(bytes.length) !== after.size) throw conflict();
    return { stat:after, bytes };
  }

  function read() {
    const bytes = source(location());
    return bytes == null ? {} : decode(bytes);
  }

  function update(merge) {
    const file = location();
    const original = snapshot(file);
    const bytes = original?.bytes ?? null;
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
    let open = true, published = false, owner = null, evidence = null;
    const expected = Buffer.from(content, 'utf8');
    try {
      owner = fsModule.fstatSync(descriptor, { bigint:true });
      fsModule.writeFileSync(descriptor, content, 'utf8');
      evidence = fsModule.fstatSync(descriptor, { bigint:true });
      fsModule.closeSync(descriptor);
      open = false;
      const staged = snapshot(temporary);
      if (!staged || !sameSnapshot(staged.stat, evidence) || !staged.bytes.equals(expected)) throw conflict();
      const latest = snapshot(file);
      if ((original === null) !== (latest === null) || (original &&
        (!sameSnapshot(original.stat, latest.stat) || !original.bytes.equals(latest.bytes)))) throw conflict();
      // The target check reads the filesystem too; reconfirm the staged bytes
      // immediately before rename. These are still separate OS calls.
      const finalStage = snapshot(temporary);
      if (!finalStage || !sameSnapshot(finalStage.stat, evidence) || !finalStage.bytes.equals(expected)) throw conflict();
      fsModule.renameSync(temporary, file);
      published = true;
    } finally {
      if (open) {
        try { evidence = fsModule.fstatSync(descriptor, { bigint:true }); } catch (error) {}
        try { fsModule.closeSync(descriptor); } catch (error) { evidence = null; }
      }
      if (!published && owner && evidence && owner.dev === evidence.dev && owner.ino === evidence.ino) {
        try {
          const staged = snapshot(temporary);
          if (staged && sameSnapshot(staged.stat, evidence) && staged.bytes.length <= expected.length
            && staged.bytes.equals(expected.subarray(0, staged.bytes.length))) fsModule.unlinkSync(temporary);
        } catch (error) {}
      }
    }
    return next;
  }

  return Object.freeze({ read, update });
}

module.exports = { createSettingsFile };

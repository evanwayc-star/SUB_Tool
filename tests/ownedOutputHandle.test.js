import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-owned-handle-')) {
      throw new Error('拒絕清除未核對的測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function fixture(open) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-owned-handle-'));
  roots.push(root);
  const file = path.join(root, 'stage.mpg');
  fs.writeFileSync(file, 'original bytes');
  const filename = new URL('../electron/owned-output-handle.js', import.meta.url);
  const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
  });
  return { file, ...module.exports };
}

describe('已開啟輸出 handle 的身分與錯誤', () => {
  it('拒絕會在身分核對前截斷檔案的開檔模式', async () => {
    let opened;
    const { file, openOwnedOutput } = fixture(async (...args) => { opened = await fs.promises.open(...args); return opened; });
    try {
      await expect(openOwnedOutput(file, 'w')).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe('original bytes');
    } finally { if (opened?.fd >= 0) await opened.close(); }
  });
  it.each([false, true])('handle stat 失敗時關閉實體檔案並保留錯誤（close 另失敗=%s）', async closeFailure => {
    let opened;
    const { file, openOwnedOutput } = fixture(async (...args) => {
      opened = await fs.promises.open(...args);
      return {
        stat: async () => { throw Object.assign(new Error('stat failed'), { code: 'EIO' }); },
        close: async () => {
          await opened.close();
          if (closeFailure) throw Object.assign(new Error('close failed'), { code: 'EPERM' });
        },
      };
    });
    const error = await openOwnedOutput(file, 'r+').catch(value => value);
    expect(error.code).toBe(closeFailure ? 'OUTPUT_HANDLE_CLOSE_FAILED' : 'EIO');
    if (closeFailure) expect(error.cause).toMatchObject({ code: 'EIO' });
    expect(error.message).toContain('stat failed');
    if (closeFailure) expect(error.message).toContain('close failed');
    expect(opened.fd).toBe(-1);
    expect(fs.readFileSync(file, 'utf8')).toBe('original bytes');
    fs.unlinkSync(file);
  });

  it('開檔後 owner 檢查失敗時關閉 handle，不寫入原始檔', async () => {
    let opened, checks = 0;
    const { file, openOwnedOutput } = fixture(async (...args) => { opened = await fs.promises.open(...args); return opened; });
    const assertOwner = () => { if (++checks === 3) throw new Error('owner changed'); };
    await expect(openOwnedOutput(file, 'r+', assertOwner)).rejects.toThrow('owner changed');
    expect(opened.fd).toBe(-1);
    expect(fs.readFileSync(file, 'utf8')).toBe('original bytes');
    fs.unlinkSync(file);
  });

  it('stat 失敗後 handle 實際未關閉時標示收尾失敗並保留原錯誤', async () => {
    let opened, close;
    const { file, openOwnedOutput } = fixture(async (...args) => {
      opened = await fs.promises.open(...args); close = opened.close.bind(opened);
      return {
        stat: async () => { throw Object.assign(new Error('original stat failure'), { code: 'EIO' }); },
        close: async () => { throw Object.assign(new Error('handle remains open'), { code: 'EBUSY' }); },
      };
    });
    try {
      const error = await openOwnedOutput(file, 'r+').catch(value => value);
      expect(error).toMatchObject({ code: 'OUTPUT_HANDLE_CLOSE_FAILED' });
      expect(error.message).toContain('original stat failure');
      expect(error.message).toContain('handle remains open');
      expect(error.cause).toMatchObject({ code: 'EIO' });
      expect(opened.fd).toBeGreaterThanOrEqual(0);
      expect(fs.readFileSync(file, 'utf8')).toBe('original bytes');
    } finally { await close?.(); }
  });

  it('內容已損毀且 handle 未關閉時保留兩個原因，不用 close 失敗覆蓋原錯誤', async () => {
    let handle, close;
    const { file, withOwnedOutput } = fixture(async (...args) => {
      handle = await fs.promises.open(...args); close = handle.close.bind(handle);
      handle.close = async () => { throw Object.assign(new Error('close still busy'), { code: 'EBUSY' }); };
      return handle;
    });
    const original = Object.assign(new Error('invalid transport'), { code: 'INVALID_TRANSPORT' });
    try {
      const error = await withOwnedOutput(file, 'r+', null, async () => { throw original; }).catch(value => value);
      expect(error).toMatchObject({ code: 'OUTPUT_HANDLE_CLOSE_FAILED', cause: original });
      expect(error.message).toContain('invalid transport');
      expect(error.message).toContain('close still busy');
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect(fs.readFileSync(file, 'utf8')).toBe('original bytes');
    } finally { await close?.(); }
  });
});

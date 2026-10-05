import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createScreenshotOutput } = require('../electron/screenshot-output.js');
const roots = [];

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-screenshot-'));
  roots.push(directory);
  const authority = new FileAuthority();
  authority.grantScreenshotDirectory(directory);
  return { directory, output: createScreenshotOutput({ fileAuthority: authority, ...options }) };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('截圖輸出 reservation', () => {
  it('writeFile 已寫入部分 JPEG 再失敗時，不留下正式損毀檔', async () => {
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { await write(data.subarray(0, 4)); throw new Error('ENOSPC after partial write'); };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, Buffer.from('complete-jpeg-frame').toString('base64'))).rejects.toThrow('ENOSPC');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each(['write', 'reserve'])('close 等待已准入的 %s，重入同一關閉交易並拒絕新工作', async operation => {
    let started, finish, closed = false;
    const began = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const open = async (file, mode) => {
      if (operation === 'reserve') { started(); await pending; }
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { started(); await pending; return write(data); };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = operation === 'write' ? await output.reserve(directory) : null;
    const work = operation === 'write' ? output.write(reserved.path, 'ZGF0YQ==') : output.reserve(directory);
    await began;
    const closing = output.close();
    closing.then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(closed).toBe(false);
      expect(output.close()).toBe(closing);
      expect(await output.reserve(directory)).toBeNull();
      expect(await output.write(reserved?.path || path.join(directory, 'Shot-001.jpg'), 'ZGF0YQ==')).toBeNull();
    } finally { finish(); await Promise.allSettled([work, closing]); }
    expect(closed).toBe(true);
    const files = fs.readdirSync(directory);
    expect(files).toEqual(operation === 'write' ? ['Shot-001.jpg'] : []);
    if (operation === 'write') expect(fs.readFileSync(reserved.path, 'utf8')).toBe('data');
  });

  it('已寫入後的 FileHandle.close 失敗仍收尾，不發布失敗交易的圖片', async () => {
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
      let written = false;
      handle.writeFile = async data => { await write(data); written = true; };
      handle.close = async () => { await close(); if (written) { written = false; throw new Error('close failed'); } };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, 'ZGF0YQ==')).rejects.toThrow('close failed');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('失敗期間正式 reservation 被其他 writer 填入，保留對方完整內容', async () => {
    let reserved;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => {
        await write(data.subarray(0, 4));
        fs.writeFileSync(reserved.path, 'other-complete-image');
        throw new Error('disk full');
      };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, 'ZGF0YQ==')).rejects.toThrow('disk full');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('other-complete-image');
  });

  it('完成寫入前正式路徑被取代，拒絕發布並保留取代檔', async () => {
    let reserved;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => {
        await write(data);
        fs.unlinkSync(reserved.path);
        fs.writeFileSync(reserved.path, 'replacement-image');
      };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBeNull();
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('replacement-image');
  });

  it('正式路徑在發布時被搶先建立，exclusive publication 保留對方檔案', async () => {
    const link = async (source, target) => {
      fs.writeFileSync(target, 'publication-race-image');
      return fs.promises.link(source, target);
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, link } } });
    const reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBeNull();
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('publication-race-image');
  });

  it('close 等待部分寫入後失敗的 writer 並清理所有未完成檔', async () => {
    let started, finish;
    const began = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { await write(data.subarray(0, 2)); started(); await pending; throw new Error('late write failure'); };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = await output.reserve(directory);
    const saved = output.write(reserved.path, 'ZGF0YQ==');
    const settled = Promise.allSettled([saved]);
    await began;
    let closed = false;
    const closing = output.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(closed).toBe(false);
    } finally { finish(); await closing; }
    expect((await settled)[0].status).toBe('rejected');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('reserve 的 handle.close 失敗仍釋放已確認 ownership 的空檔', async () => {
    let failed = false;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (!failed) { failed = true; throw new Error('reserve close failed'); } };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    await expect(output.reserve(directory)).rejects.toThrow('reserve close failed');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('完成圖片的 staging 暫時刪不掉，close 重試清理且保持成功圖片', async () => {
    let reserved, failed = false;
    const unlink = async file => {
      if (file !== reserved.path && !failed) { failed = true; throw new Error('staging locked'); }
      return fs.promises.unlink(file);
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, unlink } } });
    reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBe(reserved.path);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('data');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
  });

  it.each(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])('目錄不支援 link (%s) 時以 exclusive copy 完整發布', async code => {
    const link = async () => { throw Object.assign(new Error('link unsupported'), { code }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, link } } });
    const reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, Buffer.from('complete-jpeg-frame').toString('base64'))).toBe(reserved.path);
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('complete-jpeg-frame');
  });

  it('exclusive copy 的正式路徑被搶先建立時仍保留對方圖片', async () => {
    let reserved;
    const open = async (file, mode) => {
      if (reserved && file === reserved.path && mode === 'wx') fs.writeFileSync(file, 'foreign-complete-image');
      return fs.promises.open(file, mode);
    };
    const link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open, link } } });
    reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBeNull();
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('foreign-complete-image');
  });

  it.each(['owned', 'filled', 'replaced'])('exclusive copy 部分失敗只清本 writer 的 bytes (%s)', async owner => {
    let reserved;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      if (reserved && file === reserved.path && mode === 'wx') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async data => {
          await write(data.subarray(0, 3));
          if (owner === 'replaced') fs.unlinkSync(file);
          if (owner !== 'owned') fs.writeFileSync(file, 'foreign-complete-image');
          throw new Error('copy disk full');
        };
      }
      return handle;
    };
    const link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open, link } } });
    reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, Buffer.from('complete-jpeg-frame').toString('base64'))).rejects.toThrow('copy disk full');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual(owner === 'owned' ? [] : [reserved.name]);
    if (owner !== 'owned') expect(fs.readFileSync(reserved.path, 'utf8')).toBe('foreign-complete-image');
  });

  it('close 清理暫時失敗可重試，關閉後仍拒絕新 capture', async () => {
    let failed = false;
    const unlink = async file => {
      if (!failed) { failed = true; throw new Error('temporarily locked'); }
      return fs.promises.unlink(file);
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, unlink } } });
    await output.reserve(directory);
    const first = output.close();
    await expect(first).rejects.toThrow('temporarily locked');
    expect(await output.reserve(directory)).toBeNull();
    const retried = output.close();
    expect(retried).not.toBe(first);
    await retried;
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each(['reserve', 'stage', 'copy'])('%s 的 FileHandle.stat 暫時失敗仍以原 handle ownership 清理', async phase => {
    let reserved, failed = false;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const stat = handle.stat.bind(handle);
      const selected = phase === 'reserve' ? !reserved : phase === 'stage' ? reserved && file !== reserved.path : reserved && file === reserved.path && mode === 'wx';
      handle.stat = async () => { if (selected && !failed) { failed = true; throw new Error('stat temporarily failed'); } return stat(); };
      return handle;
    };
    const link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open, link } } });
    if (phase === 'reserve') await expect(output.reserve(directory)).rejects.toThrow('stat temporarily failed');
    else {
      reserved = await output.reserve(directory);
      await expect(output.write(reserved.path, 'ZGF0YQ==')).rejects.toThrow('stat temporarily failed');
    }
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each(['filled', 'replaced'])('copy 首次 stat 失敗時仍保留外部內容 (%s)', async owner => {
    let reserved, failed = false;
    const foreignBytes = Buffer.from('foreign');
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      if (reserved && file === reserved.path && mode === 'wx') {
        const stat = handle.stat.bind(handle);
        handle.stat = async () => {
          if (!failed) {
            failed = true;
            if (owner === 'replaced') fs.unlinkSync(file);
            fs.writeFileSync(file, foreignBytes);
            throw new Error('copy stat temporarily failed');
          }
          return stat();
        };
      }
      return handle;
    };
    const link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open, link } } });
    reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, Buffer.from('complete-jpeg-frame').toString('base64'))).rejects.toThrow('copy stat temporarily failed');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
    expect(fs.readFileSync(reserved.path)).toEqual(foreignBytes);
  });

  it('999 以後继续遞增且保留既有圖片內容', async () => {
    const { directory, output } = fixture();
    for (const number of [999, 1000]) fs.writeFileSync(path.join(directory, `Shot-${number}.jpg`), `existing-${number}`);
    const reserved = await output.reserve(directory);
    expect(reserved.name).toBe('Shot-1001.jpg');
    await output.write(reserved.path, Buffer.from('new-jpeg').toString('base64'));
    expect(fs.readFileSync(path.join(directory, 'Shot-1000.jpg'), 'utf8')).toBe('existing-1000');
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('new-jpeg');
  });

  it('並行 capture 各有獨占 output，完成或失敗都不覆蓋另一張', async () => {
    const { directory, output } = fixture();
    const [a, b] = await Promise.all([output.reserve(directory), output.reserve(directory)]);
    expect(a.path).not.toBe(b.path);
    await output.write(a.path, Buffer.from('frame-a').toString('base64'));
    expect(await output.release(b.path)).toBe(true);
    expect(fs.existsSync(b.path)).toBe(false);
    expect(await output.release(a.path)).toBe(false);
    expect(fs.readFileSync(a.path, 'utf8')).toBe('frame-a');
  });

  it('釋放只清除本次空 reservation，不能刪除已產出的圖片或其他檔案', async () => {
    const { directory, output } = fixture();
    const reserved = await output.reserve(directory, '_00:00');
    expect(reserved.name).toBe('Shot-001_0000.jpg');
    fs.writeFileSync(reserved.path, 'mpv-created-jpeg');
    expect(await output.release(reserved.path)).toBe(true);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('mpv-created-jpeg');
    const other = path.join(directory, 'user.jpg');
    fs.writeFileSync(other, 'user-content');
    expect(await output.release(other)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('user-content');
  });

  it('write 失敗或關閉 owner 時清除未完成的空 reservation', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      handle.writeFile = writeFile;
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const failed = await output.reserve(directory);
    await expect(output.write(failed.path, 'ZGF0YQ==')).rejects.toThrow('disk full');
    expect(fs.existsSync(failed.path)).toBe(false);
    const abandoned = await output.reserve(directory);
    await output.close();
    expect(fs.existsSync(abandoned.path)).toBe(false);
  });

  it('同一 reservation 只能保存一次，寫入中不可被重複保存或釋放', async () => {
    let started, finish, reopened;
    let writes = 0;
    const writing = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const duplicateOpen = new Promise(resolve => { reopened = resolve; });
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { if (++writes === 2) reopened('duplicate-open'); started(); await pending; return write(data); };
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = await output.reserve(directory);
    const saved = output.write(reserved.path, Buffer.from('original-frame').toString('base64'));
    await writing;
    // Always release the deferred writer, including when the regression fails.
    const duplicate = output.write(reserved.path, Buffer.from('replacement').toString('base64'));
    try {
      expect(await Promise.race([duplicate, duplicateOpen])).toBeNull();
      expect(await output.release(reserved.path)).toBe(false);
    } finally { finish(); await Promise.allSettled([saved, duplicate]); }
    expect(await saved).toBe(reserved.path);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('original-frame');
  });

  it('即使目錄已授權，也不能覆寫未保留或已被其他工作填入的圖', async () => {
    const { directory, output } = fixture();
    const existing = path.join(directory, 'Shot-001.jpg');
    fs.writeFileSync(existing, 'keep-existing');
    expect(await output.write(existing, 'ZGF0YQ==')).toBeNull();
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep-existing');
    const reserved = await output.reserve(directory);
    fs.writeFileSync(reserved.path, 'other-work');
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBeNull();
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('other-work');
  });

  it('未授權目錄不能取得 output 或藉 release 刪除檔案', async () => {
    const { directory } = fixture();
    const output = createScreenshotOutput({ fileAuthority: new FileAuthority() });
    expect(await output.reserve(directory)).toBeNull();
    const file = path.join(directory, 'other.jpg');
    fs.writeFileSync(file, 'user-content');
    expect(await output.write(file, 'ZGF0YQ==')).toBeNull();
    expect(await output.release(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('user-content');
  });
});

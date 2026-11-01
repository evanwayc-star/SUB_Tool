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
  return { directory, output: createScreenshotOutput({ fileAuthority: authority, tempDir: directory, ...options }) };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('截圖輸出 reservation', () => {
  it('原生截圖使用本工作獨立暫存並回傳內容，不覆寫使用者同名檔', async () => {
    const { directory, output } = fixture();
    const existing = path.join(directory, '.subtool_temp_shot.jpg');
    fs.writeFileSync(existing, 'user-owned bytes');
    let nativePath;
    const result = await output.captureNative({ async screenshot(file) {
      nativePath = file;
      fs.writeFileSync(file, 'native-frame-bytes');
      return { ok: true };
    } });
    expect(result).toEqual({ ok: true, b64: Buffer.from('native-frame-bytes').toString('base64') });
    expect(nativePath).not.toBe(existing);
    expect(fs.readFileSync(existing, 'utf8')).toBe('user-owned bytes');
    expect(fs.existsSync(path.dirname(nativePath))).toBe(false);
  });

  it('原生截圖失敗仍清除本工作暫存並保留使用者同名檔', async () => {
    const { directory, output } = fixture();
    const existing = path.join(directory, '.subtool_temp_shot.jpg');
    fs.writeFileSync(existing, 'user-owned bytes');
    let nativePath;
    await expect(output.captureNative({ async screenshot(file) {
      nativePath = file; fs.writeFileSync(file, 'partial'); throw new Error('mpv failure');
    } })).rejects.toThrow('mpv failure');
    expect(fs.readFileSync(existing, 'utf8')).toBe('user-owned bytes');
    expect(fs.existsSync(path.dirname(nativePath))).toBe(false);
  });

  it('關閉會等待原生截圖的 private 寫入與清理，之後不再准入', async () => {
    const { output } = fixture();
    let started, finish;
    const ready = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    let nativePath, closed = false;
    const capture = output.captureNative({ async screenshot(file) {
      nativePath = file; started(); await gate; fs.writeFileSync(file, 'native'); return { ok: true };
    } });
    await ready;
    const closing = output.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(closed).toBe(false);
    expect(await output.captureNative({ screenshot() {} })).toBeNull();
    finish();
    expect(await capture).toEqual({ ok: true, b64: Buffer.from('native').toString('base64') });
    await closing;
    expect(closed).toBe(true);
    expect(fs.existsSync(path.dirname(nativePath))).toBe(false);
  });

  it('原生截圖等待期間私有根改向時保留原檔，不能讀取或清理替代目錄', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-owner-')); roots.push(root);
    const temp = path.join(root, 'temp'), outside = path.join(root, 'outside');
    fs.mkdirSync(temp); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'foreign.txt'), 'foreign');
    const output = createScreenshotOutput({ fileAuthority: new FileAuthority(), tempDir: temp });
    let nativePath;
    await expect(output.captureNative({ async screenshot(file) {
      nativePath = file; fs.writeFileSync(file, 'native');
      fs.renameSync(temp, path.join(root, 'original'));
      fs.symlinkSync(outside, temp, process.platform === 'win32' ? 'junction' : 'dir');
      return { ok: true };
    } })).rejects.toThrow();
    await expect(output.close()).rejects.toThrow();
    expect(fs.readFileSync(path.join(outside, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(fs.readFileSync(path.join(root, 'original', path.basename(path.dirname(nativePath)), 'frame.jpg'), 'utf8')).toBe('native');
  });

  it('原生截圖私有根在啟動前被改向時，不授權替代目錄', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-owner-')); roots.push(root);
    const temp = path.join(root, 'temp'), outside = path.join(root, 'outside');
    fs.mkdirSync(temp); fs.mkdirSync(outside);
    const output = createScreenshotOutput({ fileAuthority: new FileAuthority(), tempDir: temp });
    fs.renameSync(temp, path.join(root, 'original'));
    fs.symlinkSync(outside, temp, process.platform === 'win32' ? 'junction' : 'dir');
    const host = { screenshot: vi.fn(async file => { fs.writeFileSync(file, 'native'); return { ok: true }; }) };
    await expect(output.captureNative(host)).rejects.toThrow();
    expect(host.screenshot).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('私有目錄建立後身分檢查暫時失敗，使用已記錄證據清除空目錄', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-stat-')); roots.push(root);
    let failed = false;
    const io = { ...fs, lstatSync(file, ...args) {
      if (!failed && path.basename(file).startsWith('native-shot-')) {
        failed = true; throw Object.assign(new Error('temporary metadata failure'), { code: 'EIO' });
      }
      return fs.lstatSync(file, ...args);
    } };
    const output = createScreenshotOutput({ fileAuthority: new FileAuthority(), tempDir: root, fsModule: io });
    await expect(output.captureNative({ screenshot: vi.fn() })).rejects.toThrow('temporary metadata failure');
    await expect(output.close()).resolves.toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('私有目錄身分檢查失敗且目錄已被替換，不刪除外物並讓 close 回報失敗', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-native-shot-stat-')); roots.push(root);
    let replaced, failed = false;
    const io = { ...fs, lstatSync(file, ...args) {
      if (!failed && path.basename(file).startsWith('native-shot-')) {
        failed = true; replaced = file;
        fs.renameSync(file, path.join(root, 'original'));
        fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'foreign.txt'), 'foreign');
        throw Object.assign(new Error('temporary metadata failure'), { code: 'EIO' });
      }
      return fs.lstatSync(file, ...args);
    } };
    const output = createScreenshotOutput({ fileAuthority: new FileAuthority(), tempDir: root, fsModule: io });
    await expect(output.captureNative({ screenshot: vi.fn() })).rejects.toThrow('temporary metadata failure');
    await expect(output.close()).rejects.toThrow();
    expect(fs.readFileSync(path.join(replaced, 'foreign.txt'), 'utf8')).toBe('foreign');
  });

  it('授權目錄被 junction 改向後不能在外部目錄保留或寫入截圖', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-shot-junction-test-')); roots.push(root);
    const selected = path.join(root, 'selected'), outside = path.join(root, 'outside');
    fs.mkdirSync(selected); fs.mkdirSync(outside);
    const authority = new FileAuthority(); authority.grantScreenshotDirectory(selected);
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: root });
    fs.renameSync(selected, path.join(root, 'original'));
    fs.symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await output.reserve(selected)).toBeNull();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('等待目錄列舉時授權目錄改向，不能在新目錄建立 reservation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-shot-junction-test-')); roots.push(root);
    const selected = path.join(root, 'selected'), outside = path.join(root, 'outside');
    fs.mkdirSync(selected); fs.mkdirSync(outside);
    const authority = new FileAuthority(); authority.grantScreenshotDirectory(selected);
    const readdir = async directory => {
      const entries = await fs.promises.readdir(directory);
      fs.renameSync(selected, path.join(root, 'original'));
      fs.symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
      return entries;
    };
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: root,
      fsModule: { promises: { ...fs.promises, readdir } } });
    await expect(output.reserve(selected)).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('reservation 後授權目錄改向，不能覆寫或刪除新目錄檔案', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-shot-junction-test-')); roots.push(root);
    const selected = path.join(root, 'selected'), outside = path.join(root, 'outside');
    fs.mkdirSync(selected); fs.mkdirSync(outside);
    const authority = new FileAuthority(); authority.grantScreenshotDirectory(selected);
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: root });
    const reservation = await output.reserve(selected);
    fs.renameSync(selected, path.join(root, 'original'));
    fs.symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
    const foreign = path.join(outside, reservation.name); fs.writeFileSync(foreign, 'foreign bytes');
    expect(await output.write(reservation.path, Buffer.from('image').toString('base64'))).toBeNull();
    await expect(output.release(reservation.path)).rejects.toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign bytes');
  });

  it('寫入暫存期間資料夾改向，不發布或清除新目錄的檔案', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-shot-junction-test-')); roots.push(root);
    const selected = path.join(root, 'selected'), source = path.join(root, 'source'), outside = path.join(root, 'outside');
    fs.mkdirSync(source); fs.mkdirSync(outside);
    fs.symlinkSync(source, selected, process.platform === 'win32' ? 'junction' : 'dir');
    const authority = new FileAuthority(); authority.grantScreenshotDirectory(selected);
    let started, resume;
    const ready = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      if (file.includes('.screenshot-')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => { started(); await gate; return write(bytes); };
      }
      return handle;
    };
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: root,
      fsModule: { promises: { ...fs.promises, open } } });
    const reservation = await output.reserve(selected);
    const write = output.write(reservation.path, Buffer.from('image').toString('base64'));
    await ready;
    fs.unlinkSync(selected);
    fs.symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
    const foreign = path.join(outside, reservation.name); fs.writeFileSync(foreign, 'foreign bytes');
    resume();
    await expect(write).rejects.toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign bytes');
    expect(fs.readdirSync(outside)).toEqual([reservation.name]);
  });

  it('使用者明確選取的 junction 本身可作為截圖根，但改向後失效', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-shot-junction-test-')); roots.push(root);
    const selected = path.join(root, 'selected'), target = path.join(root, 'target'), other = path.join(root, 'other');
    fs.mkdirSync(target); fs.mkdirSync(other);
    fs.symlinkSync(target, selected, process.platform === 'win32' ? 'junction' : 'dir');
    const authority = new FileAuthority(); expect(authority.grantScreenshotDirectory(selected)).toBe(true);
    const output = createScreenshotOutput({ fileAuthority: authority, tempDir: root });
    const reservation = await output.reserve(selected);
    expect(await output.write(reservation.path, Buffer.from('image').toString('base64'))).toBe(reservation.path);
    expect(fs.readFileSync(path.join(target, reservation.name), 'utf8')).toBe('image');
    fs.unlinkSync(selected);
    fs.symlinkSync(other, selected, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await output.reserve(selected)).toBeNull();
    expect(fs.readdirSync(other)).toEqual([]);
  });
  it.each(['release', 'write'].flatMap(operation => ['filled', 'replaced'].map(change => ({ operation, change }))))
  ('$operation 的非同步空檔核對回覆過期時，不刪除或覆蓋外部新圖片 ($change)', async ({ operation, change }) => {
    let reserved, changed = false;
    const lstat = async (file, options) => {
      const snapshot = await fs.promises.lstat(file, options);
      if (file === reserved?.path && !changed) {
        changed = true;
        if (change === 'replaced') fs.renameSync(file, file + '.original-reservation');
        fs.writeFileSync(file, 'new-external-image');
      }
      return snapshot;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, lstat } } });
    reserved = await output.reserve(directory);
    const result = operation === 'release' ? await output.release(reserved.path)
      : await output.write(reserved.path, Buffer.from('capture-image').toString('base64'));
    expect(changed).toBe(true);
    if (operation === 'write') expect(result).toBeNull();
    await output.close();
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('new-external-image');
  });

  it('staging 關閉後被取代，不得把另一份 bytes 發布成成功截圖', async () => {
    let replaced;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      if (file.includes('.screenshot-')) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          fs.renameSync(file, file + '.original');
          fs.writeFileSync(file, 'foreign-staging-bytes');
          replaced = file;
        };
      }
      return handle;
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open } } });
    const reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, Buffer.from('capture-image').toString('base64')))
      .rejects.toThrow('截圖暫存檔在發布前已變更');
    await output.close();
    expect(fs.existsSync(reserved.path)).toBe(false);
    expect(fs.readFileSync(replaced, 'utf8')).toBe('foreign-staging-bytes');
  });

  it('exclusive copy 關閉後被取代，保留對方圖片並拒絕宣稱本次截圖成功', async () => {
    let reserved, replaced = false;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      if (file === reserved?.path && mode === 'wx') {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          fs.renameSync(file, file + '.original');
          fs.writeFileSync(file, 'foreign-complete-image');
          replaced = true;
        };
      }
      return handle;
    };
    const linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, linkSync } });
    reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, Buffer.from('capture-image').toString('base64'))).toBeNull();
    expect(replaced).toBe(true);
    await output.close();
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('foreign-complete-image');
  });

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
    const linkSync = (source, target) => {
      fs.writeFileSync(target, 'publication-race-image');
      return fs.linkSync(source, target);
    };
    const { directory, output } = fixture({ fsModule: { promises: fs.promises, linkSync } });
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
    const unlinkSync = file => {
      if (file !== reserved.path && !failed) { failed = true; throw new Error('staging locked'); }
      return fs.unlinkSync(file);
    };
    const { directory, output } = fixture({ fsModule: { promises: fs.promises, unlinkSync } });
    reserved = await output.reserve(directory);
    expect(await output.write(reserved.path, 'ZGF0YQ==')).toBe(reserved.path);
    expect(failed).toBe(true);
    expect(fs.readFileSync(reserved.path, 'utf8')).toBe('data');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([reserved.name]);
  });

  it.each(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])('目錄不支援 link (%s) 時以 exclusive copy 完整發布', async code => {
    const linkSync = () => { throw Object.assign(new Error('link unsupported'), { code }); };
    const { directory, output } = fixture({ fsModule: { promises: fs.promises, linkSync } });
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
    const linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, linkSync } });
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
    const linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, linkSync } });
    reserved = await output.reserve(directory);
    await expect(output.write(reserved.path, Buffer.from('complete-jpeg-frame').toString('base64'))).rejects.toThrow('copy disk full');
    await output.close();
    expect(fs.readdirSync(directory)).toEqual(owner === 'owned' ? [] : [reserved.name]);
    if (owner !== 'owned') expect(fs.readFileSync(reserved.path, 'utf8')).toBe('foreign-complete-image');
  });

  it('close 清理暫時失敗可重試，關閉後仍拒絕新 capture', async () => {
    let failed = false;
    const unlinkSync = file => {
      if (!failed) { failed = true; throw new Error('temporarily locked'); }
      return fs.unlinkSync(file);
    };
    const { directory, output } = fixture({ fsModule: { promises: fs.promises, unlinkSync } });
    await output.reserve(directory);
    const first = output.close();
    await expect(first).rejects.toThrow('temporarily locked');
    expect(await output.reserve(directory)).toBeNull();
    const retried = output.close();
    expect(retried).not.toBe(first);
    await retried;
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('取消退出的 resume 等待已准入 writer 收尾，保留清理失敗的reservation以供重試', async () => {
    let finish, started, locked = false;
    const writing = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { finish = resolve; });
    const open = async (file, mode) => {
      if (mode === 'wx') { started(); await waiting; }
      return fs.promises.open(file, mode);
    };
    const unlinkSync = file => {
      if (locked) throw Object.assign(new Error('temporarily locked'), { code: 'EACCES' });
      return fs.unlinkSync(file);
    };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, unlinkSync } });
    const reserved = output.reserve(directory);
    await writing;
    locked = true;
    const closing = output.close();
    const rejection = expect(closing).rejects.toThrow('temporarily locked');
    const resuming = output.resume();
    try {
      expect(await output.reserve(directory)).toBeNull();
      expect(output.close()).toBe(closing);
    } finally { finish(); }
    const original = await reserved;
    await rejection;
    expect(await resuming).toBe(true);
    locked = false;
    const next = await output.reserve(directory);
    expect(next.name).not.toBe(original.name);
    await output.close();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each(['reserve', 'stage', 'copy'])('%s 的 FileHandle.stat 暫時失敗仍以原 handle ownership 清理', async phase => {
    let reserved, failed = false;
    const open = async (file, mode) => {
      const handle = await fs.promises.open(file, mode);
      const stat = handle.stat.bind(handle);
      const selected = phase === 'reserve' ? !reserved : phase === 'stage' ? reserved && file !== reserved.path : reserved && file === reserved.path && mode === 'wx';
      handle.stat = async (...args) => { if (selected && !failed) { failed = true; throw new Error('stat temporarily failed'); } return stat(...args); };
      return handle;
    };
    const linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, linkSync } });
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
        handle.stat = async (...args) => {
          if (!failed) {
            failed = true;
            if (owner === 'replaced') fs.unlinkSync(file);
            fs.writeFileSync(file, foreignBytes);
            throw new Error('copy stat temporarily failed');
          }
          return stat(...args);
        };
      }
      return handle;
    };
    const linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    const { directory, output } = fixture({ fsModule: { promises: { ...fs.promises, open }, linkSync } });
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

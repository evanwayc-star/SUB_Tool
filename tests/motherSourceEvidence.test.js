import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { motherSourceFingerprintSync, motherSourceFingerprint, portableSourceFingerprint } = require('../electron/mother-source-evidence.js');
const { cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint.js');
const directories = [];
const modes = [
  { name: '同步', fingerprint: motherSourceFingerprintSync },
  { name: '非同步', fingerprint: motherSourceFingerprint },
];

function memoryFiles(bytes, { size = bytes.length, maxRead = Infinity, initialStat = {}, afterStat = {}, isFile = true } = {}) {
  const stat = { size, mtimeMs: 1, ctimeMs: 2, dev: 3, ino: 4, ...initialStat, isFile: () => isFile };
  const read = vi.fn((target, offset, length, position) => {
    const count = Math.min(length, maxRead, Math.max(0, bytes.length - position));
    bytes.copy(target, offset, position, position + count);
    return count;
  });
  const close = vi.fn();
  const handle = { stat: async () => stat,
    read: async (...args) => ({ bytesRead: read(...args) }), close: async () => close() };
  const fileSystem = {
    openSync: () => 1, fstatSync: () => stat, readSync: (_file, ...args) => read(...args),
    statSync: () => ({ ...stat, ...afterStat }), closeSync: close,
    open: async () => handle, stat: async () => ({ ...stat, ...afterStat }),
  };
  return { fileSystem, read, close };
}

async function fingerprint(mode, source, options) {
  return mode.fingerprint(source, options);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-mother-evidence-')) {
      throw new Error('拒絕清除未驗證的測試目錄');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('跨電腦可攜式母素材證據', () => {
  it('完整 bytes 的 SHA-256 不受路徑、作業系統檔案身分或時間影響，短讀仍累積完成', async () => {
    const bytes = Buffer.from('portable mother source');
    const first = memoryFiles(bytes, { maxRead: 2 });
    const moved = memoryFiles(bytes, { initialStat: { mtimeMs: 999, ctimeMs: 998, dev: 997, ino: 996 } });
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(await portableSourceFingerprint('old/location/master.mov', { fileSystem: first.fileSystem })).toBe(expected);
    expect(await portableSourceFingerprint('new/location/renamed.mxf', { fileSystem: moved.fileSystem })).toBe(expected);
    expect(first.read.mock.calls.map(call => call[3])).toEqual(Array.from({length: 11}, (_, index) => index * 2));
    expect(first.close).toHaveBeenCalledOnce(); expect(moved.close).toHaveBeenCalledOnce();
  });

  it('未落在既有取樣窗的同大小內容修改也不可沿用舊 Proxy 身分', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7), files = memoryFiles(bytes);
    const options = { fileSystem: files.fileSystem };
    const sampled = await motherSourceFingerprint('master.mov', options);
    const full = await portableSourceFingerprint('master.mov', options);
    bytes[1024 * 1024 + 65536] = 8;
    expect(await motherSourceFingerprint('master.mov', options)).toBe(sampled);
    expect(await portableSourceFingerprint('master.mov', options)).not.toBe(full);
  });

  it('以有界讀取走完整檔案，空檔仍有標準 SHA-256', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 123, 6), files = memoryFiles(bytes);
    expect(await portableSourceFingerprint('master.mov', { fileSystem: files.fileSystem }))
      .toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(files.read.mock.calls.map(call => [call[2], call[3]]))
      .toEqual([[1048576, 0], [1048576, 1048576], [1048576, 2097152], [123, 3145728]]);
    const empty = memoryFiles(Buffer.alloc(0));
    expect(await portableSourceFingerprint('empty.bin', { fileSystem: empty.fileSystem }))
      .toBe(createHash('sha256').digest('hex'));
    expect(empty.read).not.toHaveBeenCalled(); expect(empty.close).toHaveBeenCalledOnce();
  });

  it.each(['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'])('跨機驗證期間路徑 %s 變更會拒絕並關閉 handle', async field => {
    const files = memoryFiles(Buffer.from('source'), { afterStat: { [field]: 99 } });
    await expect(portableSourceFingerprint('master.mov', { fileSystem: files.fileSystem })).rejects.toThrow(/變更/);
    expect(files.close).toHaveBeenCalledOnce();
  });

  it.each(['before-open', 'after-open', 'after-stat', 'after-read', 'after-handle-stat', 'after-path-stat', 'after-close'])
  ('%s 失去工作資格即中止，已開啟的 handle 仍關閉', async stage => {
    const files = memoryFiles(Buffer.alloc(2 * 1024 * 1024, 7));
    let current = stage !== 'before-open';
    if (stage === 'after-close') files.close.mockImplementation(() => { current = false; });
    const open = files.fileSystem.open, stat = files.fileSystem.stat;
    files.fileSystem.open = vi.fn(async (...args) => {
      const handle = await open(...args), handleStat = handle.stat, read = handle.read;
      let stats = 0;
      if (stage === 'after-open') current = false;
      handle.stat = async () => { const value = await handleStat(); stats++; if (stage === (stats === 1 ? 'after-stat' : 'after-handle-stat')) current = false; return value; };
      handle.read = async (...params) => { const value = await read(...params); if (stage === 'after-read') current = false; return value; };
      return handle;
    });
    files.fileSystem.stat = async (...args) => { const value = await stat(...args); if (stage === 'after-path-stat') current = false; return value; };
    await expect(portableSourceFingerprint('master.mov', { fileSystem: files.fileSystem, shouldContinue: () => current }))
      .rejects.toMatchObject({ name: 'AbortError', code: 'INGEST_SUPERSEDED' });
    expect(files.close).toHaveBeenCalledTimes(stage === 'before-open' ? 0 : 1);
    if (stage === 'before-open') expect(files.fileSystem.open).not.toHaveBeenCalled();
    if (stage === 'after-read') expect(files.read).toHaveBeenCalledOnce();
  });

  it('先前開啟 handle 的檔案已改變，即使目前路徑仍回傳原證據也拒絕', async () => {
    const files = memoryFiles(Buffer.from('source'));
    const open = files.fileSystem.open;
    files.fileSystem.open = async (...args) => {
      const handle = await open(...args), stat = await handle.stat();
      handle.stat = vi.fn().mockResolvedValueOnce(stat).mockResolvedValueOnce({ ...stat, mtimeMs: 99 });
      return handle;
    };
    await expect(portableSourceFingerprint('master.mov', { fileSystem: files.fileSystem })).rejects.toThrow(/變更/);
    expect(files.close).toHaveBeenCalledOnce();
  });

  it('提前 EOF、非檔案或讀取失敗都不能得到可攜式證據', async () => {
    const short = memoryFiles(Buffer.from('ab'), { size: 4 });
    await expect(portableSourceFingerprint('short.bin', { fileSystem: short.fileSystem })).rejects.toThrow(/變更/);
    expect(short.close).toHaveBeenCalledOnce();
    const directory = memoryFiles(Buffer.alloc(0), { isFile: false });
    await expect(portableSourceFingerprint('folder', { fileSystem: directory.fileSystem })).rejects.toThrow(/不是檔案/);
    expect(directory.read).not.toHaveBeenCalled(); expect(directory.close).toHaveBeenCalledOnce();
    const failed = memoryFiles(Buffer.from('source'));
    failed.read.mockImplementation(() => { throw new Error('disk failure'); });
    await expect(portableSourceFingerprint('failed.bin', { fileSystem: failed.fileSystem })).rejects.toThrow('disk failure');
    expect(failed.close).toHaveBeenCalledOnce();
  });

  it('真實複製檔與重新命名素材得到相同內容身分，改寫未取樣位置後不同', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-mother-evidence-'));
    directories.push(directory);
    const first = path.join(directory, 'master.mov'), moved = path.join(directory, 'renamed.mxf');
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    fs.writeFileSync(first, bytes); fs.copyFileSync(first, moved);
    fs.utimesSync(moved, new Date('2020-01-01'), new Date('2020-01-01'));
    const hash = await portableSourceFingerprint(first);
    expect(await portableSourceFingerprint(moved)).toBe(hash);
    const handle = fs.openSync(moved, 'r+');
    try { fs.writeSync(handle, Buffer.from([8]), 0, 1, 1024 * 1024 + 65536); } finally { fs.closeSync(handle); }
    expect(await portableSourceFingerprint(moved)).not.toBe(hash);
  });
});

describe.each(modes)('$name母素材證據', mode => {
  it('保持既有 namespace 的固定 digest，短讀會累積到完整 sample 才完成', async () => {
    const files = memoryFiles(Buffer.from('abcd'), { maxRead: 2 });
    const source = process.platform === 'win32' ? 'C:/mother.bin' : '/mother.bin';
    const expected = process.platform === 'win32'
      ? ['a260e6c579333e3d', '267743e184025c642287896efc2c239598b61d65658f24def2499e11dc8db311']
      : ['83e8fc9ca84b7fb5', '8ad8a77a1f3aadaa133d4ff0eab7546810f78a80f3c26bd29388e32b678a2316'];
    const sourceDigest = await fingerprint(mode, source, { fileSystem: files.fileSystem, namespace: 'source-v2', digestLength: 16 });
    expect(sourceDigest).toHaveLength(16);
    expect(sourceDigest).toBe(expected[0]);
    expect(await fingerprint(mode, source, { fileSystem: files.fileSystem, namespace: 'vocal-source-v1' })).toBe(expected[1]);
    expect(files.read.mock.calls.map(call => call[3])).toEqual([0, 2, 0, 2]);
    expect(files.close).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024])
  ('只取前／中／尾 sample：%i bytes，空素材仍有穩定身分', async size => {
    const files = memoryFiles(Buffer.alloc(size, 7));
    const first = await fingerprint(mode, 'mother.bin', { fileSystem: files.fileSystem });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    const positions = files.read.mock.calls.map(call => [call[3], call[2]]);
    const expected = size === 0 ? [] : size <= 1024 * 1024 ? [[0, size]] : size === 1024 * 1024 + 1
      ? [[0, 1024 * 1024], [524288, 1], [1024 * 1024, 1]]
      : [[0, 1024 * 1024], [1540096, 65536], [3080192, 65536]];
    expect(positions).toEqual(expected);
    expect(await fingerprint(mode, 'mother.bin', { fileSystem: files.fileSystem })).toBe(first);
    expect(files.close).toHaveBeenCalledTimes(2);
  });

  it.each(['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'])
  ('讀取期間路徑的 %s 變更會拒絕，開啟的 handle 始終關閉', async field => {
    const files = memoryFiles(Buffer.from('abcd'), { afterStat: { [field]: 99 } });
    await expect(fingerprint(mode, 'mother.bin', { fileSystem: files.fileSystem })).rejects.toThrow(/變更/);
    expect(files.close).toHaveBeenCalledOnce();
  });

  it('相同 stat 證據下，中段或尾段 sample 的 byte 改變仍會產生新身分', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    const files = memoryFiles(bytes);
    const options = { fileSystem: files.fileSystem };
    const first = await fingerprint(mode, 'mother.bin', options);
    bytes[1572864] = 8;
    const middleChanged = await fingerprint(mode, 'mother.bin', options);
    expect(middleChanged).not.toBe(first);
    bytes[bytes.length - 1] = 9;
    expect(await fingerprint(mode, 'mother.bin', options)).not.toBe(middleChanged);
  });

  it('讀到 EOF 卻缺 sample 或來源不是檔案時拒絕，handle 仍關閉', async () => {
    const short = memoryFiles(Buffer.from('ab'), { size: 4 });
    await expect(fingerprint(mode, 'mother.bin', { fileSystem: short.fileSystem })).rejects.toThrow(/變更/);
    expect(short.close).toHaveBeenCalledOnce();
    const directory = memoryFiles(Buffer.alloc(0), { isFile: false });
    await expect(fingerprint(mode, 'mother.bin', { fileSystem: directory.fileSystem })).rejects.toThrow(/不是檔案/);
    expect(directory.read).not.toHaveBeenCalled();
    expect(directory.close).toHaveBeenCalledOnce();
  });

  it('Windows 大小寫共用身分，其餘平台保留路徑大小寫', async () => {
    const files = memoryFiles(Buffer.from('abcd'));
    const options = { fileSystem: files.fileSystem, platform: 'win32' };
    expect(await fingerprint(mode, 'mother.bin', options)).toBe(await fingerprint(mode, 'MOTHER.bin', options));
    options.platform = 'linux';
    expect(await fingerprint(mode, 'mother.bin', options)).not.toBe(await fingerprint(mode, 'MOTHER.bin', options));
  });
});

it('真 filesystem 改寫中／尾內容或保留 mtime 換檔會失效，兩個既有 caller 保留自己的 key 格式', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-mother-evidence-'));
  directories.push(directory);
  const source = path.join(directory, 'mother.bin');
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  const fixedTime = new Date('2026-10-01T00:00:00.000Z');
  const write = () => { fs.writeFileSync(source, bytes); fs.utimesSync(source, fixedTime, fixedTime); };
  write();
  const original = [cacheKeyFor(source), await vocalSourceFingerprint(source)];
  expect(original[0]).toMatch(/^[a-f0-9]{16}$/);
  expect(original[1]).toMatch(/^[a-f0-9]{64}$/);
  expect([cacheKeyFor(source), await vocalSourceFingerprint(source)]).toEqual(original);
  expect(await motherSourceFingerprint(source, { namespace: 'source-v3', digestLength: 16 })).toBe(original[0]);
  bytes[1572864] = 7;
  write();
  const middleChanged = [cacheKeyFor(source), await vocalSourceFingerprint(source)];
  expect(middleChanged[0]).not.toBe(original[0]);
  expect(middleChanged[1]).not.toBe(original[1]);
  bytes[bytes.length - 1] = 8;
  write();
  const tailChanged = [cacheKeyFor(source), await vocalSourceFingerprint(source)];
  expect(tailChanged[0]).not.toBe(middleChanged[0]);
  expect(tailChanged[1]).not.toBe(middleChanged[1]);
  fs.unlinkSync(source);
  write();
  expect(cacheKeyFor(source)).not.toBe(tailChanged[0]);
  expect(await vocalSourceFingerprint(source)).not.toBe(tailChanged[1]);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { motherSourceFingerprintSync, motherSourceFingerprint } = require('../electron/mother-source-evidence.js');
const { cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint.js');
const directories = [];
const modes = [
  { name: '同步', fingerprint: motherSourceFingerprintSync },
  { name: '非同步', fingerprint: motherSourceFingerprint },
];

function memoryFiles(bytes, { size = bytes.length, maxRead = Infinity, afterStat = {}, isFile = true } = {}) {
  const stat = { size, mtimeMs: 1, ctimeMs: 2, dev: 3, ino: 4, isFile: () => isFile };
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

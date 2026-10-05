import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const resolved = await fs.realpath(directory);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-vocal-fingerprint-'))
      throw new Error('拒絕清除未驗證的測試目錄');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

it('同路徑指紋稳定，保留mtime的中間原地改寫與換檔會失效', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subtool-vocal-fingerprint-')); directories.push(directory);
  const source = path.join(directory, 'mother.bin');
  await fs.writeFile(source, Buffer.alloc(3 * 1024 * 1024));
  const first = await vocalSourceFingerprint(source); expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await vocalSourceFingerprint(source)).toBe(first);
  const original = await fs.stat(source), handle = await fs.open(source, 'r+');
  await handle.write(Buffer.from([7]), 0, 1, 1500000); await handle.close();
  await fs.utimes(source, original.atime, original.mtime);
  const changed = await vocalSourceFingerprint(source); expect(changed).not.toBe(first);
  await fs.unlink(source); await fs.writeFile(source, Buffer.alloc(original.size));
  await fs.utimes(source, original.atime, original.mtime);
  expect(await vocalSourceFingerprint(source)).not.toBe(changed);
});

it('读指纹期間path被替換或缩短会拒绝，handle始終关闭', async () => {
  const stat = { size: 1, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1, isFile: () => true };
  const file = { stat: async () => stat, read: async buffer => { buffer[0] = 1; return { bytesRead: 1 }; }, close: vi.fn() };
  await expect(vocalSourceFingerprint('mother.wav', { fileSystem: {
    open: async () => file, stat: async () => ({ ...stat, ino: 2 }),
  } })).rejects.toThrow(/變更/); expect(file.close).toHaveBeenCalledTimes(1);
  file.read = async () => ({ bytesRead: 0 });
  await expect(vocalSourceFingerprint('mother.wav', { fileSystem: { open: async () => file } })).rejects.toThrow(/變更/);
  expect(file.close).toHaveBeenCalledTimes(2);
});

it('preload只能送有效路徑，main指紋IPC只读既有capability而不授權任意路徑', async () => {
  let api; const invoke = vi.fn().mockResolvedValue('a'.repeat(64));
  vm.runInNewContext(await fs.readFile('electron/preload.js', 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } }, ipcRenderer: { invoke }, webUtils: {} }),
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  expect(() => api.vocalWaveFingerprint('../bad\0file')).toThrow(); expect(() => api.vocalWaveFingerprint(null)).toThrow();
  await api.vocalWaveFingerprint('mother.wav'); expect(invoke).toHaveBeenCalledWith('audio:vocal-wave-fingerprint', 'mother.wav');
  const main = await fs.readFile('electron/main.js', 'utf8');
  const ast = parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = ast.body.find(node => node.expression?.callee?.object?.name === 'ipcMain'
    && node.expression.arguments?.[0]?.value === 'audio:vocal-wave-fingerprint');
  const authority = new FileAuthority(), fingerprint = vi.fn().mockResolvedValue('a'.repeat(64));
  let handler;
  vm.runInNewContext(main.slice(registration.start, registration.end), {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    requireReadablePath: createIpcGuards(authority).requireReadablePath, vocalSourceFingerprint: fingerprint,
  });
  const source = path.resolve('unauthorized.wav'), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(() => handler({}, source)).toThrow(/未授權/); expect(fingerprint).not.toHaveBeenCalled();
    authority.grantTrustedFile(source, { read: true, write: false });
    expect(await handler({}, source)).toBe('a'.repeat(64)); expect(fingerprint).toHaveBeenCalledWith(source);
  } finally { warning.mockRestore(); }
});

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');

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

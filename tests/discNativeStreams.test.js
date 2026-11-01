import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const filename = path.resolve('electron/disc-authoring.js');
const require = createRequire(filename);
const fixtures = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('光碟原生程序的輸出管線', () => {
  it.each(['stdout', 'stderr'])('%s 的讀取錯誤終止 writer、等 close 並保留原錯誤', async stream => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-disc-pipe-test-'));
    fixtures.push(root);
    const work = path.join(root, 'subtool-disc-test');
    fs.mkdirSync(work);
    const input = path.join(work, 'internal.ts');
    fs.writeFileSync(input, 'encoded');
    const child = new EventEmitter();
    Object.assign(child, { pid: 123456, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: loaded, exports: loaded.exports, __dirname: path.dirname(filename), process, Buffer,
      require: name => name === 'fs/promises' ? { ...fsp, access: async () => {} }
        : name === 'child_process' ? { spawn(binary) {
          if (binary === 'taskkill.exe') {
            const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 1)); return killer;
          }
          queueMicrotask(() => child.emit('spawn'));
          return child;
        } } : require(name),
    }, { filename });
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    let settled = false;
    const completion = loaded.exports.finalizeDiscOutput('bd-iso', input, path.join(root, 'out.iso'),
      { fps: 24, nativePaths: { tsmuxer: 'mock.exe' }, onProcess: ready })
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await started;
    const failure = Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' });
    expect(() => child[stream].emit('error', failure)).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalled();
    child.exitCode = 1;
    child.emit('close', 1, null);
    expect(await completion).toBe(failure);
  });
});

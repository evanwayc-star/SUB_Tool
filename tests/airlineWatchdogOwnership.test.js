import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { captureOutputDirectory, captureOutputAuthority, listLeases } = require('../electron/export-lease.js');

function muxFixture() {
  const packet = (pid, payload, pcr = false) => {
    const bytes = Buffer.alloc(188, 0xff);
    bytes.set([0x47, (pid >> 8) | 0x40, pid & 255, 0x30]);
    bytes[4] = 183 - payload.length;
    if (bytes[4]) bytes[5] = pcr ? 0x10 : 0;
    if (pcr) bytes.set([0, 0, 0, 0, 0x7e, 0], 6);
    payload.copy(bytes, 188 - payload.length);
    return bytes;
  };
  const psi = (pid, hex) => packet(pid, Buffer.concat([Buffer.from([0]), Buffer.from(hex, 'hex')]));
  const video = [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 5, 0xbf, 0x21];
  const audio = [...video]; audio[3] = 0xc0;
  return Buffer.concat([
    psi(0, '00b00d0001c100000001e03fd69d4f8c'),
    psi(63, '02b0170001c10000e030f0001be030f0000fe031f0004d74b7a8'),
    packet(48, Buffer.from([...video, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x80]), true),
    packet(49, Buffer.from([...audio, 0xff, 0xf1, 0x4c, 0x80, 1, 0x1f, 0xfc, 0])),
  ]);
}

describe('航空 mux 真實檔案與 watchdog 收尾', () => {
  it.each(['replaced', 'close', 'owned-close'])('%s 的收尾失敗保留 lease 與 foreign／未關閉 handle', async mode => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-airline-watchdog-'));
    const output = path.join(root, 'delivery.mpg'), queueDir = path.join(root, 'queue');
    fs.writeFileSync(output, 'previous delivery');
    const source = muxFixture(), events = new EventEmitter(), messages = [];
    let resolveDisconnected, temporary, original, handle, close;
    const disconnected = new Promise(resolve => { resolveDisconnected = resolve; });
    const fakeProcess = {
      pid: process.pid, platform: process.platform, connected: true, stderr: new PassThrough(),
      send(message, callback) { messages.push(message); callback?.(); },
      on: events.on.bind(events), disconnect() { this.connected = false; resolveDisconnected(); },
    };
    const child = new EventEmitter();
    Object.assign(child, { pid: 123456, exitCode: null, signalCode: null, stderr: new PassThrough(), kill() {} });
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const transportRequire = createRequire(filename), promises = require('node:fs/promises'), transport = { exports: {} };
    const open = async (file, flags, ...args) => {
      const result = await promises.open(file, flags, ...args);
      if (mode === 'owned-close' && flags === 'r+' && path.basename(file).includes('.stage')) {
        handle = result; close = result.close.bind(result);
        result.close = async () => { throw Object.assign(new Error('real stage fd remains open'), { code: 'EBUSY' }); };
      }
      if (flags === 'wx' && path.basename(file).startsWith('airline-')) {
        temporary = file; handle = result; close = result.close.bind(result);
        result.close = async () => {
          if (mode === 'close') throw Object.assign(new Error('real fd remains open'), { code: 'EBUSY' });
          await close(); original = file + '.original';
          fs.renameSync(file, original); fs.writeFileSync(file, 'foreign replacement data');
        };
      }
      return result;
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: transport, Buffer, process,
      require: name => name === 'node:fs/promises' ? { ...promises, open } : transportRequire(name),
    });
    const helper = { exports: {} };
    vm.runInNewContext(fs.readFileSync(new URL('../electron/owned-output-handle.js', import.meta.url), 'utf8'), {
      module: helper, require: name => name === 'node:fs/promises' ? { ...promises, open } : transportRequire(name),
    });
    const watchdogFilename = new URL('../electron/export-watchdog.js', import.meta.url);
    const watchdogRequire = createRequire(watchdogFilename), watchdog = { exports: {} };
    const spawn = (binary, args) => {
      fs.writeFileSync(args.at(-1), source);
      setTimeout(() => {
        child.emit('spawn');
        setTimeout(() => { child.exitCode = 0; child.emit('close', 0, null); }, 10);
      }, 0);
      return child;
    };
    vm.runInNewContext(fs.readFileSync(watchdogFilename, 'utf8'), {
      module: watchdog, Buffer, process: fakeProcess, setTimeout, clearTimeout, AbortController,
      __dirname: path.dirname(fileURLToPath(watchdogFilename)),
      require: name => name === 'child_process' ? { spawn } : watchdogRequire(name),
    });
    try {
      watchdog.exports.runStandalone({ artifactAdapters: {
        finalizeAirline: (format, stage, options) => mode === 'owned-close'
          ? helper.exports.withOwnedOutput(stage, 'r+', options.assertOutput, async () => { throw new Error('original invalid transport'); })
          : transport.exports.reshapeAirlineTransport(format, stage, options),
      } });
      events.emit('message', { type: 'start', ffmpegPath: 'fake', args: [output], outPath: output,
        outputFormat: 'airline-dmpes', jobId: 'airline-owner', queueDir,
        outputAuthority: captureOutputAuthority(output, captureOutputDirectory(root)) });
      let timer;
      try { await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watchdog 未結束')), 5000); })]); }
      finally { clearTimeout(timer); }
      const result = messages.find(message => message.type === 'exit');
      expect(result).toMatchObject({ ok: false, cleanup: { retainedLease: true } });
      expect(listLeases(queueDir)).toHaveLength(1);
      expect(fs.readFileSync(output, 'utf8')).toBe('previous delivery');
      if (mode === 'replaced') {
        expect(fs.readFileSync(temporary, 'utf8')).toBe('foreign replacement data');
        expect(fs.statSync(original).size).toBeGreaterThan(0);
      } else if (mode === 'close') {
        expect(handle.fd).toBeGreaterThanOrEqual(0);
        expect(fs.existsSync(temporary)).toBe(true);
        expect(fs.readFileSync(listLeases(queueDir)[0].owner.stagePath)).toEqual(source);
      } else {
        expect(handle.fd).toBeGreaterThanOrEqual(0);
        expect(result.cleanup.stageCleanupError).toMatchObject({ code: 'OUTPUT_HANDLE_CLOSE_FAILED' });
        expect(result.cleanup.stageCleanupError.message).toContain('original invalid transport');
        expect(result.cleanup.stageCleanupError.message).toContain('real stage fd remains open');
        expect(fs.readFileSync(listLeases(queueDir)[0].owner.stagePath)).toEqual(source);
      }
    } finally {
      if (mode !== 'replaced') await close?.();
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-airline-watchdog-')) throw new Error('拒絕清除未核對的測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});

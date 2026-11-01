import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  spawnExportWatchdog,
  recoverExportLeases,
} = require('../electron/export-watchdog');
const {
  acquireLease,
  releaseLease,
  leaseRoot,
  listLeases,
  normalizeOutputPath,
  stageOutputPath,
  captureOutputDirectory,
  captureOutputAuthority,
} = require('../electron/export-lease');
const authorityFor = outPath => captureOutputAuthority(outPath, captureOutputDirectory(path.dirname(outPath)));
const stageIdentityFor = file => {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};

const WAIT_TIMEOUT_MS = 6000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(25);
  }
  throw new Error(message);
}

function waitForExit(child, timeoutMs = WAIT_TIMEOUT_MS) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return Promise.race([
    new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    wait(timeoutMs).then(() => {
      throw new Error('watchdog 子程序沒有在期限內結束');
    }),
  ]);
}

function sendControl(pipeName, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('控制 pipe 回應逾時'));
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'cleanup', token })}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
}

describe('export watchdog', () => {
  let tempDir;
  let queueDir;
  let fakeFfmpeg;
  let markerPath;
  let controllers;
  let nativeRuntimes;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-watchdog-'));
    queueDir = path.join(tempDir, 'queue');
    fakeFfmpeg = path.join(tempDir, 'fake-ffmpeg.cjs');
    markerPath = path.join(tempDir, 'started.log');
    controllers = [];
    nativeRuntimes = [];

    fs.writeFileSync(fakeFfmpeg, `
'use strict';
const fs = require('fs');
const [mode, markerPath, outPath] = process.argv.slice(2);
fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, 'partial', 'utf8');
fs.appendFileSync(markerPath, process.pid + '\\n', 'utf8');
process.stderr.write('fake ffmpeg stderr\\n');
if (mode === 'success') {
  setTimeout(() => {
    fs.writeFileSync(outPath, 'complete', 'utf8');
    process.exit(0);
  }, 80);
} else if (mode === 'fail') {
  setTimeout(() => process.exit(7), 80);
} else if (mode === 'noisy') {
  setInterval(() => process.stderr.write('still exporting\\n'), 10);
} else {
  setInterval(() => {}, 1000);
}
`, 'utf8');
  });

  afterEach(async () => {
    for (const runtime of nativeRuntimes) {
      runtime.child.exitCode = 1;
      runtime.child.emit('close', 1, null);
    }
    await Promise.all(nativeRuntimes.map(runtime => runtime.disconnected));
    for (const controller of controllers) {
      controller.stop('test-cleanup');
    }
    await Promise.all(controllers.map(controller => Promise.race([
      controller.completion.catch(() => null),
      wait(1500),
    ])));
    for (const controller of controllers) {
      if (controller.child.exitCode == null && controller.child.signalCode == null) {
        try {
          controller.child.kill('SIGKILL');
        } catch {}
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function launch(mode, outPath = path.join(tempDir, `${mode}.mp4`), jobId = mode, extra = {}) {
    const stderr = [];
    const controller = spawnExportWatchdog({
      ffmpegPath: process.execPath,
      args: [fakeFfmpeg, mode, markerPath, outPath],
      cwd: tempDir,
      outPath,
      outputAuthority: authorityFor(outPath),
      jobId,
      queueDir,
      ...extra,
    }, {
      onStderr: chunk => stderr.push(Buffer.from(chunk)),
    });
    // Some tests deliberately sever IPC or trigger a startup rejection.
    controller.ready.catch(() => {});
    controller.completion.catch(() => {});
    controllers.push(controller);
    return { controller, outPath, stderr };
  }

  function activeStage() {
    return listLeases(queueDir)[0]?.owner?.stagePath;
  }

  function recoveryWithTransport(outcomes, cleanup) {
    // Keep the public recovery owner, real lease files and real PID guards.
    // Only the named-pipe transport is controlled to hold a close/reconnect race.
    const filename = path.resolve('electron/export-watchdog.js');
    const runtimeRequire = createRequire(filename);
    const connections = [];
    const netAdapter = { createConnection(pipeName) {
      const outcome = outcomes[connections.length];
      const connection = { pipeName, request: null };
      connections.push(connection);
      const socket = new EventEmitter();
      let timeout;
      Object.assign(socket, {
        destroyed: false,
        setEncoding() {},
        setTimeout(ms, callback) { if (outcome === 'timeout') timeout = setTimeout(callback, ms); },
        destroy() { this.destroyed = true; clearTimeout(timeout); },
        end() { clearTimeout(timeout); },
        write(bytes) {
          connection.request = JSON.parse(bytes);
          setTimeout(() => {
            if (outcome === 'close') socket.emit('end');
            else if (outcome === 'invalid') socket.emit('data', 'not JSON\n');
            else if (outcome === 'rejected') socket.emit('data', JSON.stringify({ ok: false, code: 'TOKEN_MISMATCH' })+'\n');
            else if (outcome === 'cleanup') {
              cleanup(connection.request);
              socket.emit('data', JSON.stringify({ ok: true, released: true })+'\n');
            } else if (outcome !== 'timeout') {
              socket.emit('error', Object.assign(new Error('peer disconnected'), { code: outcome }));
            }
          }, 0);
        },
      });
      setTimeout(() => {
        if (outcome === 'ENOENT') socket.emit('error', Object.assign(new Error('peer disappeared'), { code: outcome }));
        else socket.emit('connect');
      }, 0);
      return socket;
    } };
    const resultModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: resultModule, exports: resultModule.exports,
      require: name => name === 'net' ? netAdapter : runtimeRequire(name),
      process, __dirname: path.dirname(filename), __filename: filename,
      Buffer, setTimeout, clearTimeout, AbortController,
    }, { filename });
    return { recover: resultModule.exports.recoverExportLeases, connections };
  }

  function recoveryLease(pids = {}) {
    const outPath = path.join(tempDir, 'recover-transport.mp4');
    const token = 'recovery-transport-token';
    const stagePath = stageOutputPath(outPath, token);
    const pipeName = process.platform === 'win32'
      ? '\\\\.\\pipe\\subtool-recovery-transport'
      : path.join(tempDir, 'recovery-transport.sock');
    fs.writeFileSync(outPath, 'previous completed delivery');
    fs.writeFileSync(stagePath, 'partial');
    const lease = acquireLease({ queueDir, outPath, token, stagePath, pipeName, jobId: 'recover-transport', outputAuthority: authorityFor(outPath) });
    fs.writeFileSync(path.join(lease.lockPath, 'owner.json'), JSON.stringify({ ...lease.owner, stageIdentity: stageIdentityFor(stagePath), ...pids }));
    return { outPath, token, stagePath, pipeName };
  }

  async function launchNativeRuntime({ spawnFailure = false } = {}) {
    // Exercise the public standalone owner with real leases, staging and pipe;
    // only the native process adapter is replaced to hold close after an error.
    const filename = path.resolve('electron/export-watchdog.js');
    const runtimeRequire = createRequire(filename);
    const events = new EventEmitter();
    const messages = [];
    const child = new EventEmitter();
    Object.assign(child, {
      pid: spawnFailure ? undefined : 123456,
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough(),
      kill: () => {
        child.emit('error', Object.assign(new Error('kill EACCES'), { code: 'EACCES' }));
        return false;
      },
    });
    let resolveDisconnected;
    const disconnected = new Promise(resolve => { resolveDisconnected = resolve; });
    const processAdapter = {
      pid: process.pid,
      platform: process.platform,
      connected: true,
      stderr: new PassThrough(),
      send(message, callback) { messages.push(message); callback?.(); },
      on: events.on.bind(events),
      disconnect() { this.connected = false; resolveDisconnected(); },
    };
    const childProcess = { spawn(binary, args) {
      if (binary === 'taskkill') {
        const killer = new EventEmitter();
        setTimeout(() => killer.emit('error', new Error('taskkill failed')), 0);
        return killer;
      }
      if (!spawnFailure) fs.writeFileSync(args.at(-1), 'native writer still owns this');
      setTimeout(() => {
        if (spawnFailure) child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        else child.emit('spawn');
      }, 0);
      return child;
    } };
    const resultModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: resultModule,
      exports: resultModule.exports,
      require: name => name === 'child_process' ? childProcess : runtimeRequire(name),
      process: processAdapter,
      __dirname: path.dirname(filename),
      __filename: filename,
      Buffer, setTimeout, clearTimeout, AbortController,
    }, { filename });
    await resultModule.exports.runStandalone();
    const outPath = path.join(tempDir, 'held-native.mp4');
    fs.writeFileSync(outPath, 'previous completed delivery');
    const runtime = { child, messages, disconnected, outPath, events };
    nativeRuntimes.push(runtime);
    events.emit('message', {
      type: 'start', ffmpegPath: 'fake-native-ffmpeg', args: [outPath],
      outPath, jobId: 'held-native', queueDir, outputAuthority: authorityFor(outPath),
    });
    await waitFor(() => messages.some(message => message.type === (spawnFailure ? 'exit' : 'ready')),
      'standalone native adapter did not start or fail');
    return runtime;
  }

  it.each([
    { stopFirst: false, closeCode: 0 },
    { stopFirst: false, closeCode: 1 },
    { stopFirst: true, closeCode: 1 },
    { stopFirst: false, closeCode: 0, exitBeforeError: true },
  ])('native error waits for close before cleanup ($stopFirst / $closeCode / $exitBeforeError)', async ({ stopFirst, closeCode, exitBeforeError }) => {
    const { child, messages, events, outPath, disconnected } = await launchNativeRuntime();
    const stagePath = activeStage();
    if (stopFirst) events.emit('message', { type: 'stop', reason: 'user-stop' });
    if (exitBeforeError) child.exitCode = closeCode;
    child.emit('error', Object.assign(new Error('native kill failed'), { code: 'EACCES' }));
    // A second failed kill is another ChildProcess error, not a second close.
    child.emit('error', Object.assign(new Error('native kill failed again'), { code: 'EACCES' }));
    await wait(50);
    expect(messages.filter(message => message.type === 'exit')).toEqual([]);
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('native writer still owns this');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('previous completed delivery');
    child.exitCode = closeCode;
    child.emit('close', closeCode, null);
    await disconnected;
    expect(messages.filter(message => message.type === 'exit')).toEqual([
      expect.objectContaining({ ok: false, cleanup: expect.objectContaining({
        reason: stopFirst ? 'user-stop' : 'ffmpeg-error', released: true,
      }) }),
    ]);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'EACCES' }));
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('previous completed delivery');
  });

  it('native spawn failure without a PID cleans up without waiting for close', async () => {
    const { messages, disconnected, outPath } = await launchNativeRuntime({ spawnFailure: true });
    await disconnected;
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'ENOENT' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'exit', ok: false }));
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('previous completed delivery');
  });

  it('ready 前 owner 寫入失敗不能讓 completion 在 native close 前結束', async () => {
    // Keep the public controller and standalone owner, including real leases and
    // IPC. Only the native adapter holds close, and owner persistence fails after spawn.
    const adapterScript = path.join(tempDir, 'held-startup-native.cjs');
    fs.writeFileSync(adapterScript, `
      const fs = require('node:fs');
      const { EventEmitter } = require('node:events');
      const { PassThrough } = require('node:stream');
      const childProcess = require('node:child_process');
      const lease = require(${JSON.stringify(path.resolve('electron/export-lease.js'))});
      const update = lease.updateLease;
      let updates = 0;
      lease.updateLease = options => {
        if (++updates === 2) throw Object.assign(new Error('owner rename failed'), { code: 'EACCES' });
        return update(options);
      };
      const child = new EventEmitter();
      Object.assign(child, { pid: 123456, exitCode: null, signalCode: null,
        stderr: new PassThrough(), kill: () => false });
      childProcess.spawn = (binary, args) => {
        if (binary === 'taskkill') {
          const killer = new EventEmitter();
          setImmediate(() => killer.emit('exit', 0));
          return killer;
        }
        fs.writeFileSync(args.at(-1), 'native still owns stage');
        setImmediate(() => child.emit('spawn'));
        return child;
      };
      process.on('message', message => {
        if (message.type === 'test-close-native') {
          child.exitCode = 1;
          child.emit('close', 1, null);
        }
      });
      require(${JSON.stringify(path.resolve('electron/export-watchdog.js'))}).runStandalone();
    `);
    const outPath = path.join(tempDir, 'held-startup.mp4');
    fs.writeFileSync(outPath, 'previous delivery');
    const controller = spawnExportWatchdog({
      ffmpegPath: 'held-native', args: [outPath], outPath,
      outputAuthority: authorityFor(outPath),
      jobId: 'held-startup', queueDir,
    }, { scriptPath: adapterScript });
    controllers.push(controller);
    let completionSettled = false;
    const completed = controller.completion.then(result => {
      completionSettled = true;
      return result;
    }, error => {
      completionSettled = true;
      throw error;
    });
    completed.catch(() => {});
    try {
      await expect(controller.ready).rejects.toMatchObject({ code: 'EACCES' });
      await wait(50);
      expect(completionSettled).toBe(false);
      expect(controller.child.exitCode).toBe(null);
      expect(listLeases(queueDir)).toHaveLength(1);
      expect(fs.readFileSync(activeStage(), 'utf8')).toBe('native still owns stage');
      expect(fs.readFileSync(outPath, 'utf8')).toBe('previous delivery');
    } finally {
      controller.child.send({ type: 'test-close-native' });
      await completed.catch(() => {});
      await waitForExit(controller.child);
    }
    await expect(completed).resolves.toMatchObject({
      ok: false, cleanup: { reason: 'lease-update-failed', released: true },
    });
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('previous delivery');
  });

  function airlineScript(mode = 'success') {
    const outPath = path.join(tempDir, 'air.mpg');
    const paths = [outPath];
    const packet = (pid, data, pcr = false) => {
      const bytes = Buffer.alloc(188, 0xff);
      bytes.set([0x47, (pid >> 8) | 0x40, pid & 255, 0x30, 183 - data.length, pcr ? 0x10 : 0]);
      if (pcr) bytes.set([0, 0, 0, 0, 0x7e, 0], 6);
      data.copy(bytes, 188 - data.length);
      return bytes;
    };
    const pat = Buffer.from('0000b00d0001c100000001e03fd69d4f8c', 'hex');
    const pmt = Buffer.from('0002b0170001c10000e030f0001be030f0000fe031f0004d74b7a8', 'hex');
    // A complete PES with PTS = 2 s is needed by the transport scheduler;
    // a bare stream ID has never represented decodable timestamped media.
    const pts = Buffer.from([0x21, 0, 0x0b, 0x7e, 0x41]);
    const pes = (streamId, payload) => {
      const bytes = Buffer.concat([Buffer.from([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5]), pts, payload]);
      bytes.writeUInt16BE(bytes.length - 6, 4);
      return bytes;
    };
    const bytes = Buffer.concat([packet(0, pat), packet(63, pmt),
      packet(48, pes(0xe0, Buffer.from([0, 0, 1, 0x65, 0x80])), true),
      packet(49, pes(0xc0, Buffer.from([0xff, 0xf1, 0x4c, 0x80, 1, 0x1f, 0xfc, 0])))]);
    fs.writeFileSync(fakeFfmpeg, `
      const fs = require('fs');
       fs.writeFileSync(process.argv.at(-1), Buffer.from('${bytes.toString('base64')}', 'base64'));
      ${mode === 'wait' ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 80);'}
    `);
    return { paths, outPath };
  }

  it('airline-dmpes 成功前完成 TS 修整，只留下單一 MPG', async () => {
    const format = 'airline-dmpes';
    const { paths, outPath } = airlineScript();
    const { controller } = launch('success', outPath, format, { outputFormat: format });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(true);
    expect(paths).toEqual([outPath]);
    const data = fs.readFileSync(outPath);
    expect(data.length % 188).toBe(0);
    const packets = Array.from({ length: data.length / 188 }, (_, index) => data.subarray(index * 188, (index + 1) * 188));
    const pid = packet => ((packet[1] & 31) << 8) | packet[2];
    for (const packet of packets.filter(packet => [48, 49, 63].includes(pid(packet)))) expect(packet[1] & 32).toBe(32);
    const outputPmt = packets.find(packet => pid(packet) === 63);
    const payloadStart = outputPmt[3] & 32 ? 5 + outputPmt[4] : 4;
    const sectionStart = payloadStart + 1 + outputPmt[payloadStart];
    expect(outputPmt[sectionStart + 12]).toBe(27);
    expect(fs.readdirSync(tempDir).filter(name => /\.(m1v|h264|m1a|aac|cfg)$/.test(name))).toEqual([]);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('exW 缺少完整 AAC 前導影格時拒絕交付並清理半成品', async () => {
    const { paths, outPath } = airlineScript();
    const { controller } = launch('success', outPath, 'air-exw-missing-preroll', { outputFormat: 'airline-exw' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ reason: 'airline-finalize-failed', released: true });
    expect(paths.some(file => fs.existsSync(file))).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空作業停止會刪除 MPG 半成品，然後釋放鎖', async () => {
    const { paths, outPath } = airlineScript('wait');
    const { controller } = launch('wait', outPath, 'air-stop', { outputFormat: 'airline-dmpes' });
    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), '航空 MPG 暫存檔尚未建立');
    expect(listLeases(queueDir)).toHaveLength(1);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ removed: true, released: true, retainedLease: false });
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(paths.some(file => fs.existsSync(file))).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空 MPG 已被佔用時不得啟動 FFmpeg 或刪除已有成品', async () => {
    const { paths, outPath } = airlineScript();
    for (const file of paths) fs.writeFileSync(file, 'original');
    acquireLease({ queueDir, outPath, jobId: 'owner', token: 'owner-token' });
    const { controller } = launch('success', outPath, 'air-conflict', { outputFormat: 'airline-dmpes' });
    await expect(controller.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    await controller.completion.catch(() => {});
    for (const file of paths) expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(listLeases(queueDir)[0].owner.jobId).toBe('owner');
  });

  it('航空 FFmpeg 成功但 TS 無效時清理半成品而不假完成', async () => {
    const outPath = path.join(tempDir, 'invalid.mpg');
    const { controller } = launch('success', outPath, 'air-missing', { outputFormat: 'airline-dmpes' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ reason: 'airline-finalize-failed', released: true });
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('航空 MPG 半成品無法刪除會保留鎖', async () => {
    const { paths, outPath } = airlineScript('wait');
    const { controller } = launch('wait', outPath, 'air-retain', { outputFormat: 'airline-exw' });
    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), '航空 MPG 暫存檔尚未建立');
    fs.unlinkSync(stagePath);
    fs.mkdirSync(stagePath);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ released: false, retainedLease: true });
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(fs.statSync(stagePath).isDirectory()).toBe(true);
  });

  it('MOD-FHD 封裝驗證失敗會刪除半成品且不回報成功', async () => {
    const { controller, outPath } = launch('success', path.join(tempDir, 'invalid.ts'), 'mod-invalid', { outputFormat: 'mod-fhd' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ reason: 'mod-fhd-finalize-failed', removed: true, released: true });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('MOD-FHD 回報完成以前先修正 ADTS MPEG-2 標記並釋放 lease', async () => {
    const packet = Buffer.alloc(188, 0xff);
    const payload = Buffer.from([0, 0, 1, 0xc0, 0, 11, 0x80, 0, 0,
      0xff, 0xf1, 0x4c, 0x80, 1, 0x1f, 0xfc, 0]);
    packet.set([0x47, 0x50, 0x22, 0x30, 183 - payload.length, 0]);
    payload.copy(packet, 188 - payload.length);
    fs.writeFileSync(fakeFfmpeg, `require('fs').writeFileSync(process.argv.at(-1), Buffer.from('${packet.toString('base64')}', 'base64'));`);
    const { controller, outPath } = launch('success', path.join(tempDir, 'valid.ts'), 'mod-valid', { outputFormat: 'mod-fhd' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(true);
    const expected = Buffer.from(packet);
    expected[188 - payload.length + 10] = 0xf9;
    expect(fs.readFileSync(outPath)).toEqual(expected);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('正常結束會保留完整成品並釋放 output lease', async () => {
    const { controller, outPath, stderr } = launch('success');

    await controller.ready;
    const result = await controller.completion;

    expect(result).toMatchObject({ type: 'exit', ok: true, code: 0 });
    expect(fs.readFileSync(outPath, 'utf8')).toBe('complete');
    expect(Buffer.concat(stderr).toString('utf8')).toContain('fake ffmpeg stderr');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['commit', 'cancel'])('輸出父目錄被同名新目錄替換時 %s 不發布或清除外來檔，保留原 lease', async action => {
    const parent = path.join(tempDir, 'output'), moved = path.join(tempDir, 'previous-output');
    fs.mkdirSync(parent);
    const outPath = path.join(parent, 'delivery.mp4');
    fs.writeFileSync(outPath, 'previous completed delivery');
    const gate = path.join(tempDir, 'finish-writer');
    fs.writeFileSync(fakeFfmpeg, `
      const fs=require('fs');
      fs.writeFileSync(process.argv.at(-1),'owned encoded bytes');
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);}},10);
    `);
    const { controller } = launch('wait', outPath, 'parent-replaced');
    await controller.ready;
    const lease = listLeases(queueDir)[0], stage = lease.owner.stagePath;
    await waitFor(() => fs.existsSync(stage) && fs.readFileSync(stage, 'utf8') === 'owned encoded bytes', '本工作 stage 尚未寫入實際內容');
    fs.renameSync(parent, moved); fs.mkdirSync(parent);
    fs.writeFileSync(outPath, 'foreign completed delivery');
    fs.writeFileSync(stage, 'foreign staging bytes');
    if (action === 'commit') fs.writeFileSync(gate, 'finish');
    else controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('foreign completed delivery');
    expect(fs.readFileSync(stage, 'utf8')).toBe('foreign staging bytes');
    expect(fs.readFileSync(path.join(moved, path.basename(stage)), 'utf8')).toBe('owned encoded bytes');
    expect(fs.readFileSync(path.join(moved, 'delivery.mp4'), 'utf8')).toBe('previous completed delivery');
    expect(fs.existsSync(path.join(lease.lockPath, 'owner.json'))).toBe(true);
  });

  it('既有成品在 FFmpeg 無法啟動時仍保持原內容', async () => {
    const outPath = path.join(tempDir, 'existing-spawn.mp4');
    fs.writeFileSync(outPath, 'original');
    const { controller } = launch('success', outPath, 'preserve-spawn', {
      ffmpegPath: path.join(tempDir, 'missing-ffmpeg.exe'),
    });
    await expect(controller.ready).rejects.toBeTruthy();
    await controller.completion.catch(() => {});
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['commit', 'cancel'])('同父目錄的 stage 被換檔時 %s 不搬移或刪除外來內容', async action => {
    const gate = path.join(tempDir, 'stage-gate');
    fs.writeFileSync(fakeFfmpeg, `const fs=require('fs');fs.writeFileSync(process.argv.at(-1),'owned encoded bytes');
      const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t);},10);`);
    const { controller, outPath } = launch('wait');
    fs.writeFileSync(outPath, 'previous final');
    await controller.ready;
    const stage = activeStage();
    await waitFor(() => fs.readFileSync(stage, 'utf8') === 'owned encoded bytes', 'writer 尚未完成 stage');
    fs.renameSync(stage, stage + '.owned'); fs.writeFileSync(stage, 'foreign stage');
    if (action === 'commit') fs.writeFileSync(gate, 'finish'); else controller.stop('user-stop');
    expect(await controller.completion).toMatchObject({ ok: false, cleanup: { retainedLease: true } });
    expect(fs.readFileSync(stage, 'utf8')).toBe('foreign stage');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('previous final');
    expect(fs.readFileSync(stage + '.owned', 'utf8')).toBe('owned encoded bytes');
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it('已選取 junction 根的正式 watchdog 使用原實體目錄成品並正確釋放固定 lease', async () => {
    const target = path.join(tempDir, 'target'), alias = path.join(tempDir, 'selected'); fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const outPath = path.join(alias, 'delivery.mp4');
    const { controller } = launch('success', outPath);
    await controller.ready;
    expect(await controller.completion).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(target, 'delivery.mp4'), 'utf8')).toBe('complete');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('缺少選取證據的 standalone 不自行對當前路徑授權', async () => {
    const { controller, outPath } = launch('success', undefined, 'no-authority', { outputAuthority: undefined });
    await expect(controller.ready).rejects.toMatchObject({ code: 'UNSAFE_DELIVERY_OUTPUT' });
    await controller.completion.catch(() => {});
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('編碼中所選 junction 改向不重算 lease key；保留原 stage 且不碰新目錄，恢復原選擇後可清理', async () => {
    const target = path.join(tempDir, 'target'), outside = path.join(tempDir, 'outside'), alias = path.join(tempDir, 'selected');
    fs.mkdirSync(target); fs.mkdirSync(outside);
    const link = destination => fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
    link(target);
    const outPath = path.join(alias, 'delivery.mp4'), foreignOutput = path.join(outside, 'delivery.mp4');
    fs.writeFileSync(foreignOutput, 'foreign final');
    const gate = path.join(tempDir, 'alias-gate');
    fs.writeFileSync(fakeFfmpeg, `const fs=require('fs');fs.writeFileSync(process.argv.at(-1),'owned bytes');
      const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t);},10);`);
    const { controller } = launch('wait', outPath);
    await controller.ready;
    const lease = listLeases(queueDir)[0], stage = lease.owner.stagePath;
    await waitFor(() => fs.readFileSync(stage, 'utf8') === 'owned bytes', '尚無實際stage');
    fs.unlinkSync(alias); link(outside); fs.writeFileSync(gate, 'finish');
    expect(await controller.completion).toMatchObject({ ok: false, cleanup: { retainedLease: true } });
    expect(listLeases(queueDir)).toEqual([expect.objectContaining({ valid: true, key: lease.key })]);
    expect(fs.readFileSync(stage, 'utf8')).toBe('owned bytes');
    expect(fs.readFileSync(foreignOutput, 'utf8')).toBe('foreign final');
    await waitForExit(controller.child);
    fs.unlinkSync(alias); link(target);
    expect((await recoverExportLeases(queueDir)).warnings).toEqual([]);
    expect(listLeases(queueDir)).toEqual([]); expect(fs.existsSync(stage)).toBe(false);
  });

  it('拒絕最後參數不是輸出路徑的工作，不能錯替其他參數而覆蓋正式檔', () => {
    const outPath = path.join(tempDir, 'invalid-argv.mp4');
    fs.writeFileSync(outPath, 'original');
    expect(() => spawnExportWatchdog({
      ffmpegPath: process.execPath,
      args: [fakeFfmpeg, outPath, 'stray-last-argument'],
      outPath,
      jobId: 'invalid-argv',
      queueDir,
      outputFormat: 'h264-mp4',
    })).toThrow(expect.objectContaining({ code: 'INVALID_WATCHDOG_CONFIG' }));
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('FFmpeg 回傳成功但沒有建立暫存成品時，不得將既有檔誤判為新成品', async () => {
    const outPath = path.join(tempDir, 'missing-stage.mp4');
    fs.writeFileSync(outPath, 'original');
    fs.writeFileSync(fakeFfmpeg, 'process.exit(0);');
    const { controller } = launch('success', outPath, 'missing-stage');
    const result = await controller.completion;
    expect(result).toMatchObject({ ok: false, cleanup: { reason: 'artifact-commit-failed' } });
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('既有成品在編碼失敗或取消時仍保持原內容', async () => {
    for (const mode of ['fail', 'wait']) {
      const outPath = path.join(tempDir, `existing-${mode}.mp4`);
      fs.writeFileSync(outPath, 'original');
      const { controller } = launch(mode, outPath, `preserve-${mode}`);
      await controller.ready;
      const [lease] = listLeases(queueDir);
      expect(lease.owner.stagePath).toBe(stageOutputPath(outPath, lease.owner.token));
      await waitFor(() => fs.existsSync(lease.owner.stagePath), '暫存成品尚未建立');
      expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
      if (mode === 'wait') controller.stop('user-stop');
      const result = await controller.completion;
      expect(result.ok).toBe(false);
      expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
      expect(fs.existsSync(lease.owner.stagePath)).toBe(false);
      expect(listLeases(queueDir)).toEqual([]);
    }
  });

  it('成功時驗證後才以私有暫存成品取代既有成品', async () => {
    const outPath = path.join(tempDir, 'existing-success.mp4');
    fs.writeFileSync(outPath, 'original');
    const { controller } = launch('success', outPath, 'replace-success');
    await controller.ready;
    const [lease] = listLeases(queueDir);
    await waitFor(() => fs.existsSync(lease.owner.stagePath), '暫存成品尚未建立');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    const result = await controller.completion;
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('complete');
    expect(fs.existsSync(lease.owner.stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('stop 會先等 ffmpeg 關閉，再刪半成品與釋放 lease', async () => {
    const { controller, outPath } = launch('wait', undefined, 'stop-job');

    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), 'fake ffmpeg 沒有建立暫存成品');
    expect(controller.stop('user-stop')).toBe(true);
    const result = await controller.completion;

    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({
      reason: 'user-stop',
      released: true,
      retainedLease: false,
    });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('父 IPC disconnect 後仍會自行清掉 ffmpeg、半成品與 lease', async () => {
    const { controller, outPath } = launch('wait', undefined, 'disconnect-job');
    const completion = controller.completion.catch(error => error);

    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), 'fake ffmpeg 沒有建立暫存成品');
    expect(controller.disconnect()).toBe(true);
    await waitForExit(controller.child);
    await completion;

    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });


  it('父程序的 stderr pipe 先斷線時不會讓 watchdog 在清理前崩潰', async () => {
    const { controller, outPath } = launch('noisy', undefined, 'broken-stderr');

    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), 'fake ffmpeg 沒有建立暫存成品');
    controller.child.stderr.destroy();
    await wait(100);
    expect(controller.child.exitCode).toBeNull();

    expect(controller.stop('user-stop')).toBe(true);
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({
      reason: 'user-stop',
      released: true,
      retainedLease: false,
    });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('ffmpeg 非零結束碼會刪半成品並回報失敗', async () => {
    const { controller, outPath } = launch('fail', undefined, 'fail-job');

    await controller.ready;
    const result = await controller.completion;

    expect(result).toMatchObject({
      type: 'exit',
      ok: false,
      code: 7,
      cleanup: {
        reason: 'ffmpeg-nonzero',
        released: true,
      },
    });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('相同輸出路徑同時只能啟動一支 ffmpeg', async () => {
    const outPath = path.join(tempDir, 'same-output.mp4');
    const first = launch('wait', outPath, 'first');
    await first.controller.ready;
    await waitFor(() => fs.existsSync(markerPath), '第一支 ffmpeg 沒有啟動');

    const second = launch('wait', outPath, 'second');
    await expect(second.controller.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });

    const starts = fs.readFileSync(markerPath, 'utf8').trim().split(/\r?\n/);
    expect(starts).toHaveLength(1);
    expect(listLeases(queueDir)).toHaveLength(1);

    first.controller.stop('test-finished');
    await first.controller.completion;
  });

  it('控制 pipe 的錯誤 token 不得停止工作或清理輸出', async () => {
    const { controller, outPath } = launch('wait', undefined, 'wrong-token');
    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), 'fake ffmpeg 沒有建立暫存成品');

    const [lease] = listLeases(queueDir);
    const response = await sendControl(lease.owner.pipeName, 'definitely-wrong-token');

    expect(response).toMatchObject({ ok: false, code: 'TOKEN_MISMATCH' });
    expect(fs.existsSync(stagePath)).toBe(true);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(controller.child.exitCode).toBeNull();

    controller.stop('test-finished');
    await controller.completion;
  });

  it('recover 會先透過 live watchdog 的 token pipe 清理，再等待 lease 消失', async () => {
    const { controller, outPath } = launch('wait', undefined, 'live-recovery');
    await controller.ready;
    const stagePath = activeStage();
    await waitFor(() => fs.existsSync(stagePath), 'fake ffmpeg 沒有建立暫存成品');

    const recovery = await recoverExportLeases(queueDir);

    expect(recovery.warnings).toEqual([]);
    expect(recovery.recovered).toEqual([
      expect.objectContaining({ outPath: normalizeOutputPath(outPath), mode: 'live' }),
    ]);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
    await controller.completion;
  });

  it('recover 找不到 owner pipe 且沒有存活程序時刪除半成品', async () => {
    const outPath = path.join(tempDir, 'stale.mp4');
    fs.writeFileSync(outPath, 'partial', 'utf8');
    acquireLease({
      queueDir,
      outPath,
      jobId: 'stale',
      outputAuthority: authorityFor(outPath),
      token: 'stale-token',
      watchdogPid: null,
      pipeName: process.platform === 'win32'
        ? '\\\\.\\pipe\\subtool-export-does-not-exist'
        : path.join(tempDir, 'does-not-exist.sock'),
    });

    const recovery = await recoverExportLeases(queueDir, {
      pipeAttempts: 2,
      pipeRetryMs: 10,
      pipeTimeoutMs: 100,
    });

    expect(recovery.warnings).toEqual([]);
    expect(recovery.recovered).toEqual([
      expect.objectContaining({ outPath: normalizeOutputPath(outPath), mode: 'stale' }),
    ]);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['EPIPE', 'ECONNRESET', 'close'])('recover 在 %s 後以同一 pipe／token 重試並交由 live owner 清理', async interruption => {
    const fixture = recoveryLease({ watchdogPid: process.pid });
    const fx = recoveryWithTransport([interruption, 'cleanup'], request => {
      expect(request.token).toBe(fixture.token);
      fs.unlinkSync(fixture.stagePath);
      releaseLease({ queueDir, outPath: fixture.outPath, token: fixture.token });
    });
    const result = await fx.recover(queueDir, { pipeAttempts: 2, pipeRetryMs: 0 });
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([expect.objectContaining({ mode: 'live' })]);
    expect(fx.connections).toHaveLength(2);
    expect(fx.connections.every(connection => connection.pipeName === fixture.pipeName
      && connection.request?.token === fixture.token)).toBe(true);
    expect(fs.existsSync(fixture.stagePath)).toBe(false);
    expect(fs.readFileSync(fixture.outPath, 'utf8')).toBe('previous completed delivery');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['EPIPE', 'ECONNRESET', 'close'])('recover 在 %s 後確認 peer 消失及 PID 結束，才清理本次 stage', async interruption => {
    const fixture = recoveryLease();
    const fx = recoveryWithTransport([interruption, 'ENOENT', 'ENOENT']);
    const result = await fx.recover(queueDir, { pipeAttempts: 3, pipeRetryMs: 0 });
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toEqual([expect.objectContaining({ mode: 'stale' })]);
    expect(fx.connections).toHaveLength(3);
    expect(fs.existsSync(fixture.stagePath)).toBe(false);
    expect(fs.readFileSync(fixture.outPath, 'utf8')).toBe('previous completed delivery');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['EPIPE', 'ECONNRESET', 'close'].flatMap(interruption => ['watchdogPid', 'ffmpegPid']
    .map(field => ({ interruption, field }))))('recover 在 $interruption 後仍保留 $field 存活時的 stage／lease', async ({ interruption, field }) => {
    const fixture = recoveryLease({ [field]: process.pid });
    const fx = recoveryWithTransport([interruption, 'ENOENT', 'ENOENT']);
    const result = await fx.recover(queueDir, { pipeAttempts: 3, pipeRetryMs: 0 });
    expect(result.recovered).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'EXPORT_PROCESS_RUNNING' })]);
    expect(fx.connections).toHaveLength(3);
    expect(fs.readFileSync(fixture.stagePath, 'utf8')).toBe('partial');
    expect(fs.readFileSync(fixture.outPath, 'utf8')).toBe('previous completed delivery');
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it.each([
    ['invalid', 'INVALID_CONTROL_RESPONSE'], ['rejected', 'TOKEN_MISMATCH'], ['timeout', 'CONTROL_PIPE_TIMEOUT'],
  ])('recover 重連後遇到 %s 仍停止並保留 stage／lease', async (outcome, code) => {
    const fixture = recoveryLease();
    const fx = recoveryWithTransport(['EPIPE', outcome, 'cleanup'], () => { throw new Error('unsafe cleanup'); });
    const result = await fx.recover(queueDir, { pipeAttempts: 3, pipeRetryMs: 0, pipeTimeoutMs: 50 });
    expect(result.recovered).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code })]);
    expect(fx.connections).toHaveLength(2);
    expect(fs.readFileSync(fixture.stagePath, 'utf8')).toBe('partial');
    expect(fs.readFileSync(fixture.outPath, 'utf8')).toBe('previous completed delivery');
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it('recover 的連續傳輸中斷重試有界，活著的 writer 不能因中斷被清理', async () => {
    const fixture = recoveryLease({ ffmpegPid: process.pid });
    const fx = recoveryWithTransport(['EPIPE', 'ECONNRESET', 'close', 'cleanup'], () => { throw new Error('unbounded cleanup'); });
    const result = await fx.recover(queueDir, { pipeAttempts: 3, pipeRetryMs: 0 });
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'EXPORT_PROCESS_RUNNING' })]);
    expect(fx.connections).toHaveLength(3);
    expect(fs.readFileSync(fixture.stagePath, 'utf8')).toBe('partial');
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it('staging lease 的 crash recovery 只清本次暫存檔，不碰既有成品', async () => {
    const outPath = path.join(tempDir, 'recover-existing.mp4');
    const token = 'recover-stage-token';
    const stagePath = stageOutputPath(outPath, token);
    fs.writeFileSync(outPath, 'original');
    fs.writeFileSync(stagePath, 'partial');
    const lease = acquireLease({ queueDir, outPath, jobId: 'recover-stage', token, stagePath, outputStarted: true, outputAuthority: authorityFor(outPath) });
    fs.writeFileSync(path.join(lease.lockPath, 'owner.json'), JSON.stringify({ ...lease.owner, stageIdentity: stageIdentityFor(stagePath) }));
    const recovery = await recoverExportLeases(queueDir);
    expect(recovery.warnings).toEqual([]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('成品已原子提交但 watchdog 尚未釋放 lease 時，復原不可刪新成品', async () => {
    const outPath = path.join(tempDir, 'committed-existing.mp4');
    const token = 'committed-stage-token';
    const stagePath = stageOutputPath(outPath, token);
    fs.writeFileSync(outPath, 'original');
    fs.writeFileSync(stagePath, 'verified');
    const lease = acquireLease({ queueDir, outPath, jobId: 'committed-stage', token, stagePath, outputStarted: true, outputAuthority: authorityFor(outPath) });
    fs.writeFileSync(path.join(lease.lockPath, 'owner.json'), JSON.stringify({ ...lease.owner, stageIdentity: stageIdentityFor(stagePath) }));
    fs.renameSync(stagePath, outPath);
    const recovery = await recoverExportLeases(queueDir);
    expect(recovery.warnings).toEqual([]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('verified');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['watchdogPid', 'ffmpegPid'])('recover 找不到 pipe 但 %s 仍存在時保留鎖和檔案', async field => {
    const outPath = path.join(tempDir, 'live-orphan.iso');
    fs.writeFileSync(outPath, 'in progress');
    const lease = acquireLease({ queueDir, outPath, jobId: 'live-orphan', token: 'orphan-token' });
    const ownerPath = path.join(lease.lockPath, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ ...lease.owner, [field]: process.pid }));
    const recovery = await recoverExportLeases(queueDir);
    expect(recovery.recovered).toEqual([]);
    expect(recovery.warnings).toEqual([expect.objectContaining({ code: 'EXPORT_PROCESS_RUNNING' })]);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('in progress');
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it('recover 遇到 corrupt lease 必須保留鎖並提出警告', async () => {
    const corruptPath = path.join(leaseRoot(queueDir), `${'a'.repeat(64)}.lock`);
    fs.mkdirSync(corruptPath, { recursive: true });
    fs.writeFileSync(path.join(corruptPath, 'owner.json'), '{not-json', 'utf8');

    const recovery = await recoverExportLeases(queueDir);

    expect(recovery.recovered).toEqual([]);
    expect(recovery.warnings).toEqual([
      expect.objectContaining({ code: 'LEASE_CORRUPT', lockPath: corruptPath }),
    ]);
    expect(fs.existsSync(corruptPath)).toBe(true);
  });

  it('半成品刪除失敗時必須 fail closed 保留 lease', async () => {
    const outPath = path.join(tempDir, 'cannot-unlink-as-file.mp4');
    fs.mkdirSync(outPath);
    acquireLease({
      queueDir,
      outPath,
      jobId: 'delete-failure',
      outputAuthority: authorityFor(outPath),
      token: 'delete-failure-token',
      pipeName: null,
    });

    const recovery = await recoverExportLeases(queueDir, {
      deleteAttempts: 1,
      deleteRetryMs: 0,
    });

    expect(recovery.recovered).toEqual([]);
    expect(recovery.warnings).toEqual([
      expect.objectContaining({
        code: 'PARTIAL_CLEANUP_FAILED',
        outPath: normalizeOutputPath(outPath),
      }),
    ]);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(listLeases(queueDir)).toHaveLength(1);
  });

  it.each(['directory', 'junction', 'stage'])('重啟 recovery 遇 %s 身分替換保留 foreign bytes 與可辨識 lease，原 owner 回來後才清理', async kind => {
    const parent = path.join(tempDir, 'output'), moved = path.join(tempDir, 'moved'), foreign = path.join(tempDir, 'foreign');
    fs.mkdirSync(parent); fs.mkdirSync(foreign);
    const outPath = path.join(parent, 'delivery.mp4'), token = 'identity-recovery';
    const stagePath = stageOutputPath(outPath, token);
    fs.writeFileSync(stagePath, 'owned partial');
    const lease = acquireLease({ queueDir, outPath, token, stagePath, jobId: 'identity-recovery', outputStarted: true,
      outputAuthority: authorityFor(outPath) });
    fs.writeFileSync(path.join(lease.lockPath, 'owner.json'), JSON.stringify({ ...lease.owner, stageIdentity: stageIdentityFor(stagePath) }));
    if (kind === 'stage') fs.renameSync(stagePath, stagePath + '.owned');
    else {
      fs.renameSync(parent, moved);
      if (kind === 'directory') fs.mkdirSync(parent);
      else fs.symlinkSync(foreign, parent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    fs.writeFileSync(stagePath, 'foreign partial');
    const result = await recoverExportLeases(queueDir, { deleteAttempts: 1 });
    expect(result.recovered).toEqual([]); expect(result.warnings[0].code).toBe('PARTIAL_CLEANUP_FAILED');
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('foreign partial');
    expect(listLeases(queueDir)).toEqual([expect.objectContaining({ valid: true, key: lease.key })]);
    if (kind === 'stage') { fs.unlinkSync(stagePath); fs.renameSync(stagePath + '.owned', stagePath); }
    else { if (kind === 'junction') fs.unlinkSync(parent); else fs.renameSync(parent, path.join(tempDir, 'foreign-retained')); fs.renameSync(moved, parent); }
    expect((await recoverExportLeases(queueDir)).warnings).toEqual([]);
    expect(fs.existsSync(stagePath)).toBe(false); expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['started', 'stage', 'reservation'])('舊 lease %s 不把現有檔案當成歷史授權', async kind => {
    const outPath = path.join(tempDir, 'legacy.mp4'), token = 'legacy';
    const stagePath = stageOutputPath(outPath, token);
    fs.writeFileSync(outPath, 'existing final');
    if (kind === 'stage') fs.writeFileSync(stagePath, 'unproven stage');
    acquireLease({ queueDir, outPath, token, jobId: 'legacy',
      ...(kind === 'stage' ? { stagePath } : {}), outputStarted: kind !== 'reservation' });
    const result = await recoverExportLeases(queueDir);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing final');
    if (kind === 'reservation') { expect(result.warnings).toEqual([]); expect(listLeases(queueDir)).toEqual([]); }
    else {
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'OUTPUT_AUTHORITY_MISSING' })]);
      expect(listLeases(queueDir)).toHaveLength(1);
      if (kind === 'stage') expect(fs.readFileSync(stagePath, 'utf8')).toBe('unproven stage');
    }
  });
});

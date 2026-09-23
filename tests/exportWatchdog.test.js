import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  spawnExportWatchdog,
  recoverExportLeases,
} = require('../electron/export-watchdog');
const {
  acquireLease,
  leaseRoot,
  listLeases,
  normalizeOutputPath,
} = require('../electron/export-lease');

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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-watchdog-'));
    queueDir = path.join(tempDir, 'queue');
    fakeFfmpeg = path.join(tempDir, 'fake-ffmpeg.cjs');
    markerPath = path.join(tempDir, 'started.log');
    controllers = [];

    fs.writeFileSync(fakeFfmpeg, `
'use strict';
const fs = require('fs');
const [outPath, mode, markerPath] = process.argv.slice(2);
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
      args: [fakeFfmpeg, outPath, mode, markerPath],
      cwd: tempDir,
      outPath,
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

  function airlineScript(format, mode = 'success') {
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
    const pmt = Buffer.from(format === 'airline-s3k'
      ? '0002b0170001c10000e030f00002e030f00003e031f000947a0d66'
      : '0002b0170001c10000e030f0001be030f0000fe031f0004d74b7a8', 'hex');
    // A complete PES with PTS = 2 s is needed by the transport scheduler;
    // a bare stream ID has never represented decodable timestamped media.
    const pts = Buffer.from([0x21, 0, 0x0b, 0x7e, 0x41]);
    const pes = (streamId, payload) => {
      const bytes = Buffer.concat([Buffer.from([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5]), pts, payload]);
      bytes.writeUInt16BE(bytes.length - 6, 4);
      return bytes;
    };
    const bytes = Buffer.concat([packet(0, pat), packet(63, pmt),
      packet(48, pes(0xe0, Buffer.from([0, 0, 1, format === 'airline-s3k' ? 0 : 0x65, 0x80])), true),
      packet(49, pes(0xc0, Buffer.from([0xff, 0xf1, 0x4c, 0x80, 1, 0x1f, 0xfc, 0])))]);
    fs.writeFileSync(fakeFfmpeg, `
      const fs = require('fs');
      fs.writeFileSync(process.argv[2], Buffer.from('${bytes.toString('base64')}', 'base64'));
      ${mode === 'wait' ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 80);'}
    `);
    return { paths, outPath };
  }

  it('airline-dmpes 成功前完成 TS 修整，只留下單一 MPG', async () => {
    const format = 'airline-dmpes';
    const { paths, outPath } = airlineScript(format);
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

  it('S3K 缺少完整 MP2 前導影格時拒絕交付並清理半成品', async () => {
    const { paths, outPath } = airlineScript('airline-s3k');
    const { controller } = launch('success', outPath, 'air-s3k-missing-preroll', { outputFormat: 'airline-s3k' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ reason: 'airline-finalize-failed', released: true });
    expect(paths.some(file => fs.existsSync(file))).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空作業停止會刪除 MPG 半成品，然後釋放鎖', async () => {
    const { paths, outPath } = airlineScript('airline-dmpes', 'wait');
    const { controller } = launch('wait', outPath, 'air-stop', { outputFormat: 'airline-dmpes' });
    await controller.ready;
    await waitFor(() => paths.every(file => fs.existsSync(file)), '航空 MPG 尚未建立');
    expect(listLeases(queueDir)).toHaveLength(1);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ removed: true, released: true, retainedLease: false });
    expect(paths.some(file => fs.existsSync(file))).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空 MPG 已被佔用時不得啟動 FFmpeg 或刪除已有成品', async () => {
    const { paths, outPath } = airlineScript('airline-dmpes');
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
    const { paths, outPath } = airlineScript('airline-s3k', 'wait');
    const { controller } = launch('wait', outPath, 'air-retain', { outputFormat: 'airline-s3k' });
    await controller.ready;
    await waitFor(() => fs.existsSync(paths[0]), '航空 MPG 尚未建立');
    fs.unlinkSync(paths[0]);
    fs.mkdirSync(paths[0]);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ released: false, retainedLease: true });
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(fs.statSync(paths[0]).isDirectory()).toBe(true);
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
    fs.writeFileSync(fakeFfmpeg, `require('fs').writeFileSync(process.argv[2], Buffer.from('${packet.toString('base64')}', 'base64'));`);
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

  it('stop 會先等 ffmpeg 關閉，再刪半成品與釋放 lease', async () => {
    const { controller, outPath } = launch('wait', undefined, 'stop-job');

    await controller.ready;
    await waitFor(() => fs.existsSync(outPath), 'fake ffmpeg 沒有建立半成品');
    expect(controller.stop('user-stop')).toBe(true);
    const result = await controller.completion;

    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({
      reason: 'user-stop',
      released: true,
      retainedLease: false,
    });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('父 IPC disconnect 後仍會自行清掉 ffmpeg、半成品與 lease', async () => {
    const { controller, outPath } = launch('wait', undefined, 'disconnect-job');
    const completion = controller.completion.catch(error => error);

    await controller.ready;
    await waitFor(() => fs.existsSync(outPath), 'fake ffmpeg 沒有建立半成品');
    expect(controller.disconnect()).toBe(true);
    await waitForExit(controller.child);
    await completion;

    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('父程序的 stderr pipe 先斷線時不會讓 watchdog 在清理前崩潰', async () => {
    const { controller, outPath } = launch('noisy', undefined, 'broken-stderr');

    await controller.ready;
    await waitFor(() => fs.existsSync(outPath), 'fake ffmpeg 沒有建立半成品');
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
    await waitFor(() => fs.existsSync(outPath), 'fake ffmpeg 沒有建立半成品');

    const [lease] = listLeases(queueDir);
    const response = await sendControl(lease.owner.pipeName, 'definitely-wrong-token');

    expect(response).toMatchObject({ ok: false, code: 'TOKEN_MISMATCH' });
    expect(fs.existsSync(outPath)).toBe(true);
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(controller.child.exitCode).toBeNull();

    controller.stop('test-finished');
    await controller.completion;
  });

  it('recover 會先透過 live watchdog 的 token pipe 清理，再等待 lease 消失', async () => {
    const { controller, outPath } = launch('wait', undefined, 'live-recovery');
    await controller.ready;
    await waitFor(() => fs.existsSync(outPath), 'fake ffmpeg 沒有建立半成品');

    const recovery = await recoverExportLeases(queueDir);

    expect(recovery.warnings).toEqual([]);
    expect(recovery.recovered).toEqual([
      expect.objectContaining({ outPath: normalizeOutputPath(outPath), mode: 'live' }),
    ]);
    expect(fs.existsSync(outPath)).toBe(false);
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
});

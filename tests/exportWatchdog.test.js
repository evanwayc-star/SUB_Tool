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
const { deliveryOutputPaths, MANZANITA_CONFIG } = require('../electron/airline-output');

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
    const outPath = path.join(tempDir, format === 'airline-s3k' ? 'air.m1v' : 'air.h264');
    const paths = deliveryOutputPaths(format, outPath);
    fs.writeFileSync(fakeFfmpeg, `
      const fs = require('fs');
      const paths = ${JSON.stringify(paths)};
      fs.writeFileSync(paths[0], 'video-complete');
      fs.writeFileSync(paths[1], 'audio-complete');
      ${mode === 'wait' ? "fs.writeFileSync(paths[2], 'partial-config'); setInterval(() => {}, 1000);" : 'setTimeout(() => process.exit(0), 80);'}
    `);
    return { paths, outPath };
  }

  it.each(['airline-s3k', 'airline-dmpes'])('%s 成功時保留兩個分流並輸出完整 Manzanita 設定', async format => {
    const { paths, outPath } = airlineScript(format);
    const { controller } = launch('success', outPath, format, { outputFormat: format });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(paths[0], 'utf8')).toBe('video-complete');
    expect(fs.readFileSync(paths[1], 'utf8')).toBe('audio-complete');
    expect(fs.readFileSync(paths[2], 'utf8')).toBe(MANZANITA_CONFIG);
    expect(MANZANITA_CONFIG).toContain('PMTPID = 0x3f\r\nPCRPID = 0x30');
    expect(MANZANITA_CONFIG).toContain('Rate = -1.000\r\nPID = 0x30');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空作業停止會刪除全組半成品，然後一起釋放三個鎖', async () => {
    const { paths, outPath } = airlineScript('airline-dmpes', 'wait');
    const { controller } = launch('wait', outPath, 'air-stop', { outputFormat: 'airline-dmpes' });
    await controller.ready;
    await waitFor(() => paths.every(file => fs.existsSync(file)), '航空分流尚未建立');
    expect(listLeases(queueDir)).toHaveLength(3);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ removed: true, released: true, retainedLease: false });
    expect(result.cleanup.files).toHaveLength(3);
    expect(paths.some(file => fs.existsSync(file))).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('航空音訊旁檔已被佔用時不得啟動 FFmpeg 或刪除已有成品', async () => {
    const { paths, outPath } = airlineScript('airline-dmpes');
    for (const file of paths) fs.writeFileSync(file, 'original');
    acquireLease({ queueDir, outPath: paths[1], jobId: 'owner', token: 'owner-token' });
    const { controller } = launch('success', outPath, 'air-conflict', { outputFormat: 'airline-dmpes' });
    await expect(controller.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    await controller.completion.catch(() => {});
    for (const file of paths) expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(listLeases(queueDir)[0].owner.jobId).toBe('owner');
  });

  it('航空 FFmpeg 成功卻缺音訊時不產生設定檔或假完成', async () => {
    const outPath = path.join(tempDir, 'missing-audio.h264');
    const { controller } = launch('success', outPath, 'air-missing', { outputFormat: 'airline-dmpes' });
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ reason: 'airline-finalize-failed', released: true });
    expect(deliveryOutputPaths('airline-dmpes', outPath).some(file => fs.existsSync(file))).toBe(false);
  });

  it('航空任一半成品無法刪除會保留全組鎖', async () => {
    const { paths, outPath } = airlineScript('airline-s3k', 'wait');
    const { controller } = launch('wait', outPath, 'air-retain', { outputFormat: 'airline-s3k' });
    await controller.ready;
    await waitFor(() => fs.existsSync(paths[2]), '航空分流尚未建立');
    fs.unlinkSync(paths[2]);
    fs.mkdirSync(paths[2]);
    controller.stop('user-stop');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ released: false, retainedLease: true });
    expect(listLeases(queueDir)).toHaveLength(3);
    expect(fs.existsSync(paths[0])).toBe(false);
    expect(fs.existsSync(paths[1])).toBe(false);
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

  it('recover 找不到 owner pipe 時只刪半成品，不依 PID 終止任何程序', async () => {
    const outPath = path.join(tempDir, 'stale.mp4');
    fs.writeFileSync(outPath, 'partial', 'utf8');
    acquireLease({
      queueDir,
      outPath,
      jobId: 'stale',
      token: 'stale-token',
      watchdogPid: process.pid,
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

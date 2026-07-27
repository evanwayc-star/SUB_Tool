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

  function launch(mode, outPath = path.join(tempDir, `${mode}.mp4`), jobId = mode) {
    const stderr = [];
    const controller = spawnExportWatchdog({
      ffmpegPath: process.execPath,
      args: [fakeFfmpeg, outPath, mode, markerPath],
      cwd: tempDir,
      outPath,
      jobId,
      queueDir,
    }, {
      onStderr: chunk => stderr.push(Buffer.from(chunk)),
    });
    // Some tests deliberately sever IPC or trigger a startup rejection.
    controller.ready.catch(() => {});
    controller.completion.catch(() => {});
    controllers.push(controller);
    return { controller, outPath, stderr };
  }

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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawnExportWatchdog, recoverExportLeases } = require('../electron/export-watchdog');
const { acquireLease, listLeases } = require('../electron/export-lease');
const helperPath = require.resolve('../electron/disc-authoring');
const watchdogPath = require.resolve('../electron/export-watchdog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const result = check();
    if (result) return result;
    await delay(25);
  }
  throw new Error('光碟 watchdog 沒有到達預期狀態');
}

// The watchdog and encoder/authoring child lifetimes are real processes. Only
// the native authoring adapter is replaced, so these tests run without DVD tools.
describe('光碟 watchdog 暫存、取消與復原', () => {
  let tempDir, queueDir, outPath, encoderPath, bootstrapPath, controllers;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-disc-watchdog-'));
    queueDir = path.join(tempDir, 'queue');
    outPath = path.join(tempDir, 'existing.iso');
    encoderPath = path.join(tempDir, 'encoder.cjs');
    bootstrapPath = path.join(tempDir, 'watchdog-bootstrap.cjs');
    controllers = [];
    fs.writeFileSync(outPath, 'original ISO');
    fs.writeFileSync(encoderPath, `
      const fs = require('fs');
      fs.writeFileSync(process.argv.at(-1), 'encoded media');
      fs.writeFileSync(process.env.DISC_TEST_ENCODER, process.argv.at(-1));
      if (process.env.DISC_TEST_MODE === 'encoding-wait') setInterval(() => {}, 1000);
      else setTimeout(() => process.exit(process.env.DISC_TEST_MODE === 'encoding-fail' ? 7 : 0), 50);
    `);
    fs.writeFileSync(bootstrapPath, `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const helperPath = ${JSON.stringify(helperPath)};
      const actual = require(helperPath);
      const { runStandalone } = require(${JSON.stringify(watchdogPath)});
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const abortError = () => Object.assign(new Error('cancelled'), {code:'ABORT_ERR'});
      const disc = {
        ...actual,
        async prepareDiscOutput(format, options) {
          const stage = await actual.prepareDiscOutput(format, options);
          fs.writeFileSync(process.env.DISC_TEST_PREPARED, JSON.stringify(stage));
          if (process.env.DISC_TEST_MODE === 'prepare-wait') {
            while (!fs.existsSync(process.env.DISC_TEST_GATE)) await delay(10);
          }
          return stage;
        },
        async cleanupDiscOutput(stage, options) {
          if (process.env.DISC_TEST_MODE === 'cleanup-fail') throw Object.assign(new Error('stage busy'), {code:'EBUSY'});
          return actual.cleanupDiscOutput(stage, options);
        },
        async finalizeDiscOutput(format, encoded, target, options) {
          if (!fs.existsSync(encoded)) throw new Error('encoded file missing');
          if (options.signal.aborted) throw abortError();
          if (process.env.DISC_TEST_MODE === 'author-preflight-fail') throw Object.assign(new Error('tool missing'), {code:'DISC_TOOL_MISSING'});
          await options.onOutputStart?.();
          const program = 'const fs=require("fs");fs.writeFileSync(process.argv[1],"partial ISO");fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);';
          const child = spawn(process.execPath, ['-e', program, target, process.env.DISC_TEST_AUTHOR], {windowsHide:true, stdio:'ignore'});
          const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
          const stop = () => { child.kill(); };
          options.signal.addEventListener('abort', stop, {once:true});
          try {
            await options.onProcess?.(child);
            while (!fs.existsSync(process.env.DISC_TEST_AUTHOR) && !options.signal.aborted) await delay(5);
            options.onProgress?.(25);
            if (['author-wait'].includes(process.env.DISC_TEST_MODE)) await closed;
            else { stop(); await closed; }
            if (options.signal.aborted) throw abortError();
            if (process.env.DISC_TEST_MODE === 'author-fail') throw new Error('native authoring failed');
            fs.writeFileSync(target, 'complete ISO');
          } finally {
            options.signal.removeEventListener('abort', stop);
            stop(); await closed;
          }
        },
      };
      void runStandalone({ artifactAdapters: { disc } });
    `);
  });

  afterEach(async () => {
    fs.writeFileSync(path.join(tempDir, 'gate'), 'release');
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(async controller => {
      await Promise.race([controller.completion.catch(() => {}), delay(3000)]);
      await waitFor(() => controller.child.exitCode != null || controller.child.signalCode != null);
    }));
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function launch(mode = 'success', format = 'dvd-iso') {
    const messages = [];
    const controller = spawnExportWatchdog({
      ffmpegPath: process.execPath, args: [encoderPath, outPath], outPath,
      queueDir, jobId: mode, outputFormat: format,
    }, {
      scriptPath: bootstrapPath,
      env: {
        DISC_TEST_MODE: mode,
        DISC_TEST_PREPARED: path.join(tempDir, 'prepared.json'),
        DISC_TEST_ENCODER: path.join(tempDir, 'encoded.log'),
        DISC_TEST_AUTHOR: path.join(tempDir, 'author.log'),
        DISC_TEST_GATE: path.join(tempDir, 'gate'),
      },
      onMessage: message => messages.push(message),
    });
    controller.ready.catch(() => {});
    controller.completion.catch(() => {});
    controllers.push(controller);
    return { controller, messages };
  }

  it.each(['dvd-iso', 'bd-iso'])('%s 在 lease 內編碼，完成原生合成才交付單一 ISO', async format => {
    const { controller, messages } = launch('success', format);
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('complete ISO');
    const stage = JSON.parse(fs.readFileSync(path.join(tempDir, 'prepared.json')));
    expect(stage.encodedPath).not.toBe(outPath);
    expect(path.dirname(path.dirname(stage.workDir))).toBe(path.join(queueDir, 'output-leases'));
    expect(fs.existsSync(stage.workDir)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
    expect(messages.some(message => message.type === 'progress' && message.progress.pct === 96)).toBe(true);
  });

  it.each(['encoding-fail', 'author-preflight-fail'])('%s 不得刪除既有 ISO', async mode => {
    const { controller } = launch(mode);
    await controller.ready;
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup).toMatchObject({ untouched: true, released: true });
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original ISO');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('編碼期間取消保留原 ISO 並清掉私有素材', async () => {
    const { controller } = launch('encoding-wait');
    await controller.ready;
    await waitFor(() => fs.existsSync(path.join(tempDir, 'encoded.log')));
    expect(listLeases(queueDir)[0].owner.outputStarted).toBe(false);
    controller.stop('user-stop');
    expect((await controller.completion).cleanup).toMatchObject({ untouched: true, released: true });
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original ISO');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('準備暫存尚未完成就取消，必須等準備結束才能清理及釋放鎖', async () => {
    const { controller } = launch('prepare-wait');
    await waitFor(() => fs.existsSync(path.join(tempDir, 'prepared.json')));
    controller.stop('user-stop');
    await delay(80);
    expect(listLeases(queueDir)).toHaveLength(1);
    fs.writeFileSync(path.join(tempDir, 'gate'), 'release');
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ reason: 'user-stop', untouched: true, released: true });
    expect(fs.existsSync(path.join(tempDir, 'encoded.log'))).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original ISO');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it.each(['stop', 'recovery'])('合成期間 %s 會先終止 native process，清理後才釋放鎖', async action => {
    const { controller } = launch('author-wait');
    await controller.ready;
    await waitFor(() => fs.existsSync(path.join(tempDir, 'author.log')));
    const authorPid = Number(fs.readFileSync(path.join(tempDir, 'author.log'), 'utf8'));
    expect(listLeases(queueDir)[0].owner).toMatchObject({ ffmpegPid: authorPid, outputStarted: true });
    if (action === 'stop') controller.stop('user-stop');
    else expect((await recoverExportLeases(queueDir)).warnings).toEqual([]);
    const result = await controller.completion;
    expect(result.cleanup).toMatchObject({ removed: true, released: true });
    expect(() => process.kill(authorPid, 0)).toThrow();
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('主程序在準備暫存期間斷線也不得再啟動編碼', async () => {
    const { controller } = launch('prepare-wait');
    await waitFor(() => fs.existsSync(path.join(tempDir, 'prepared.json')));
    controller.disconnect();
    fs.writeFileSync(path.join(tempDir, 'gate'), 'release');
    await waitFor(() => controller.child.exitCode != null);
    expect(fs.existsSync(path.join(tempDir, 'encoded.log'))).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original ISO');
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('native 合成失敗會刪除 ISO 半成品', async () => {
    const { controller } = launch('author-fail');
    await controller.ready;
    expect((await controller.completion).cleanup).toMatchObject({ reason: 'disc-finalize-failed', removed: true, released: true });
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listLeases(queueDir)).toEqual([]);
  });

  it('私有素材清理失敗必須保留可復原的 lease', async () => {
    const { controller } = launch('cleanup-fail');
    await controller.ready;
    expect((await controller.completion).cleanup).toMatchObject({ retainedLease: true, released: false, stageCleanupError: { code: 'EBUSY' } });
    const [lease] = listLeases(queueDir);
    expect(fs.readdirSync(lease.lockPath).some(name => name.startsWith('subtool-disc-'))).toBe(true);
  });

  it('崩潰在編碼階段時復原只刪私有素材，保留原 ISO', async () => {
    const lease = acquireLease({ queueDir, outPath, jobId: 'stale-disc', outputStarted: false });
    fs.mkdirSync(path.join(lease.lockPath, 'subtool-disc-stale'));
    fs.writeFileSync(path.join(lease.lockPath, 'subtool-disc-stale', 'internal.ts'), 'partial encode');
    const result = await recoverExportLeases(queueDir);
    expect(result.warnings).toEqual([]);
    expect(result.recovered[0].cleanup.untouched).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original ISO');
    expect(listLeases(queueDir)).toEqual([]);
  });
});

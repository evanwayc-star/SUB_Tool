import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExportArtifact } = require('../electron/export-artifact');
const nativeDisc = require('../electron/disc-authoring');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('watchdog 私有成品 lifecycle interface', () => {
  let tempDir, outPath, controller, args;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-artifact-'));
    outPath = path.join(tempDir, 'existing.iso');
    fs.writeFileSync(outPath, 'original');
    controller = new AbortController();
    args = ['-i', 'mother.mov', '-y', outPath];
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function create(format, owner = {}, adapters = {}) {
    return createExportArtifact({ outputFormat: format, outPath, args, discAudioPlan: { streams: [{ layout: 'stereo' }] } }, {
      signal: controller.signal, ...owner,
    }, adapters);
  }

  it.each(['mp4', 'prores', 'wav'])('%s 直接編碼須等 owner 允許寫入，重入只執行一次', async format => {
    const gate = deferred();
    const onOutputStart = vi.fn(() => gate.promise);
    const artifact = create(format, { onOutputStart });
    const prepared = artifact.prepare({ tempDir });
    expect(artifact.prepare({ tempDir })).toBe(prepared);
    let ready = false;
    void prepared.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    gate.resolve();
    expect(await prepared).toEqual(args);
    expect(onOutputStart).toHaveBeenCalledTimes(1);
    const settled = artifact.settle({ encoded: true });
    expect(artifact.settle({ encoded: false })).toBe(settled);
    expect(await settled).toEqual({ error: null, reason: null, cleanupError: null });
    await expect(artifact.prepare({ tempDir })).rejects.toThrow('已結束');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
  });

  it.each(['mod-fhd', 'airline-dmpes', 'airline-dmpes-4m', 'airline-s3k'])('%s 等封裝驗證完成才 settle，失敗保留原錯誤', async format => {
    const checked = deferred();
    const gate = deferred();
    const error = Object.assign(new Error('invalid transport'), { code: 'INVALID_TRANSPORT' });
    const finalize = vi.fn(async () => { checked.resolve(); await gate.promise; throw error; });
    const artifact = create(format, {}, { finalizeAirline: finalize, finalizeModFhd: finalize });
    await artifact.prepare({ tempDir });
    const settled = artifact.settle({ encoded: true });
    let finished = false;
    void settled.then(() => { finished = true; });
    await checked.promise;
    expect(finished).toBe(false);
    gate.resolve();
    expect(await settled).toMatchObject({ error, reason: format === 'mod-fhd' ? 'mod-fhd-finalize-failed' : 'airline-finalize-failed' });
    expect(finalize).toHaveBeenCalledTimes(1);
    if (format === 'mod-fhd') expect(finalize).toHaveBeenCalledWith(outPath, { signal: controller.signal });
    else expect(finalize).toHaveBeenCalledWith(format, outPath, { signal: controller.signal, tempDir });
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 封裝與cleanup有序，準備不碰既有ISO，成品驗證以前不清stage', async format => {
    const writing = deferred(), finished = deferred();
    const progress = [], ownerCalls = [];
    let encodedPath;
    const artifact = create(format, {
      onOutputStart: async () => { ownerCalls.push('write'); },
      onProcess: async child => { ownerCalls.push(child.pid); },
      onProgress: event => progress.push(event),
    }, { disc: {
      ...nativeDisc,
      async finalizeDiscOutput(actualFormat, encoded, target, options) {
        expect(actualFormat).toBe(format);
        expect(options.audioPlan.streams).toEqual([{ layout: 'stereo' }]);
        expect(fs.readFileSync(encoded, 'utf8')).toBe('encoded');
        await options.onOutputStart();
        fs.writeFileSync(target, 'partial');
        await options.onProcess({ pid: 123 });
        options.onProgress(25);
        writing.resolve();
        await finished.promise;
        fs.writeFileSync(target, 'verified ISO');
      },
    } });
    encodedPath = (await artifact.prepare({ tempDir })).at(-1);
    expect(encodedPath).not.toBe(outPath);
    expect(args.at(-1)).toBe(outPath);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
    expect(ownerCalls).toEqual([]);
    fs.writeFileSync(encodedPath, 'encoded');
    const settled = artifact.settle({ encoded: true });
    await writing.promise;
    expect(ownerCalls).toEqual(['write', 123]);
    expect(fs.existsSync(encodedPath)).toBe(true);
    expect(progress.map(event => event.pct)).toEqual([95, 96]);
    expect(progress[0].label).toBe(format === 'dvd-iso' ? '製作 DVD ISO' : '製作 BD ISO');
    finished.resolve();
    expect(await settled).toEqual({ error: null, reason: null, cleanupError: null });
    expect(fs.existsSync(path.dirname(encodedPath))).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('verified ISO');
  });

  it('取消準備中的工作時 settle 等 prepare 交回 stage 才清理，且不啟動封裝', async () => {
    const prepared = deferred(), gate = deferred();
    const finalizeDiscOutput = vi.fn();
    let stage;
    const artifact = create('dvd-iso', {}, { disc: {
      ...nativeDisc, finalizeDiscOutput,
      async prepareDiscOutput(format, options) {
        stage = await nativeDisc.prepareDiscOutput(format, options);
        prepared.resolve();
        await gate.promise;
        return stage;
      },
    } });
    const prepareResult = artifact.prepare({ tempDir }).catch(error => error);
    await prepared.promise;
    controller.abort();
    const settled = artifact.settle({ encoded: false });
    let complete = false;
    void settled.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(fs.existsSync(stage.workDir)).toBe(true);
    gate.resolve();
    expect(await prepareResult).toBe(controller.signal.reason);
    await settled;
    expect(finalizeDiscOutput).not.toHaveBeenCalled();
    expect(fs.existsSync(stage.workDir)).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
  });

  it('編碼失敗只清私有stage；cleanup失敗由owner接收後保留lease', async () => {
    const cleanupError = Object.assign(new Error('workspace busy'), { code: 'EBUSY' });
    const finalizeDiscOutput = vi.fn();
    const artifact = create('dvd-iso', {}, { disc: {
      ...nativeDisc, finalizeDiscOutput,
      async cleanupDiscOutput() { throw cleanupError; },
    } });
    const encodedPath = (await artifact.prepare({ tempDir })).at(-1);
    expect(await artifact.settle({ encoded: false })).toEqual({
      error: cleanupError, reason: 'disc-cleanup-failed', cleanupError,
    });
    expect(finalizeDiscOutput).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(encodedPath))).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('original');
  });

  it('原生封裝與cleanup都失敗仍回報兩者，不掩蓋第一個錯誤', async () => {
    const finalizeError = new Error('authoring failed');
    const cleanupError = new Error('cleanup failed');
    const artifact = create('bd-iso', {}, { disc: {
      ...nativeDisc,
      async finalizeDiscOutput() { throw finalizeError; },
      async cleanupDiscOutput() { throw cleanupError; },
    } });
    await artifact.prepare({ tempDir });
    expect(await artifact.settle({ encoded: true })).toEqual({
      error: finalizeError, reason: 'disc-finalize-failed', cleanupError,
    });
  });

  it('沒有準備就取消不建立stage；settle後拒絕重新準備', async () => {
    const artifact = create('dvd-iso');
    await artifact.settle();
    await expect(artifact.prepare({ tempDir })).rejects.toThrow('已結束');
    expect(fs.readdirSync(tempDir)).toEqual(['existing.iso']);
  });
});

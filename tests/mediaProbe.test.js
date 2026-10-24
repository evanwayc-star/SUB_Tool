import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { parse } from 'acorn';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

function removeProbeTempRoot(root) {
  const resolved = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (key(path.dirname(resolved)) !== key(temp) || !path.basename(resolved).startsWith('subtool-probe-')) {
    throw new Error('拒絕清除不屬於 probe 測試的暫存目錄');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function completedProcess({ stdout = '', stderr = '', status = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', status, null);
  });
  return child;
}

describe('媒體探測 interface', () => {
  it('取消與強制終止的連續 error 不會逃出 probe owner，仍等待 native close', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const child = new EventEmitter();
    Object.assign(child, { pid: 123456, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false) });
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });
    const failure = Object.assign(new Error('kill EACCES'), { code: 'EACCES' });
    let settled = false;
    const work = probe.describe('source.mov').catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(child.listenerCount('error')).toBeGreaterThan(0));
    try {
      child.emit('error', failure);
      expect(() => child.emit('error', new Error('second kill failed'))).not.toThrow();
      await Promise.resolve(); expect(settled).toBe(false);
      await expect(probe.cancelAllAndWait({ timeoutMs: 10 })).rejects
        .toMatchObject({ code: 'PROBE_TERMINATION_PENDING' });
      expect(probe.resume()).toBe(false);
    } finally { child.exitCode = 1; child.emit('close', 1); await work; }
    expect(await work).toBe(failure); await probe.cancelAllAndWait();
    expect(probe.resume()).toBe(true);
  });

  it('shutdown 拒絕 queued/shared 工作並等 active child close，重入共用屏障，resume 後可再探測', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const children = [], spawnProcess = vi.fn(() => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      children.push(child); return child;
    });
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', maxConcurrent: 1, spawnProcess });
    const first = probe.describe('first.mov').catch(error => error);
    const shared = probe.describe('first.mov').catch(error => error);
    const queued = probe.describe('queued.mov').catch(error => error);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const closing = probe.cancelAllAndWait();
    expect(probe.cancelAllAndWait()).toBe(closing);
    expect(await queued).toMatchObject({ code: 'PROBE_ABORTED' });
    let closed = false; void closing.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    for (const method of ['describe', 'hasAudio', 'audioVideoStartOffsets', 'audioBitrates']) {
      await expect(probe[method]('blocked.mov')).rejects.toMatchObject({ code: 'PROBE_ABORTED' });
    }
    expect(spawnProcess).toHaveBeenCalledOnce();
    children[0].emit('close', 0);
    expect(await first).toMatchObject({ code: 'PROBE_ABORTED' });
    expect(await shared).toMatchObject({ code: 'PROBE_ABORTED' }); await closing;
    expect(probe.resume()).toBe(true);
    const next = probe.describe('next.mov');
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].stdout.end('{"format":{"duration":"3"},"streams":[]}'); children[1].emit('close', 0);
    await expect(next).resolves.toMatchObject({ duration: 3 });
    await probe.cancelAllAndWait();
  });

  it('開始前即 shutdown 的已准入 request 不會晚到啟動 native process', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const spawnProcess = vi.fn(() => completedProcess());
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess });
    const outcome = probe.describe('admitted.mov').catch(error => error);
    await probe.cancelAllAndWait();
    expect(await outcome).toMatchObject({ code: 'PROBE_ABORTED' });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(probe.resume()).toBe(true);
  });

  it('error 事件不能代替 native close；錯誤工作與 shutdown 都等 owner 確認關閉', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });
    let settled = false;
    const failure = new Error('native runtime error');
    const outcome = probe.describe('error.mov').catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(child.listenerCount('error')).toBe(1));
    child.emit('error', failure);
    const closing = probe.cancelAllAndWait();
    await Promise.resolve(); expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 1);
    expect(await outcome).toBe(failure); await closing;
  });

  it('未確認 close 的 probe 保留 ownership；quit barrier 有界拒絕，late close 後才恢復准入', async () => {
    vi.useFakeTimers();
    const { createMediaProbe } = require('../electron/media-probe');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawnProcess = vi.fn().mockImplementationOnce(() => child)
      .mockImplementation(() => completedProcess({ stdout: '{"streams":[]}' }));
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', terminationGraceMs: 10, spawnProcess });
    const outcome = probe.describe('stuck.mov').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const closing = probe.cancelAllAndWait({ timeoutMs: 40 }).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(40);
      expect(await outcome).toMatchObject({ code: 'PROBE_TERMINATION_TIMEOUT' });
      expect(await closing).toMatchObject({ code: 'PROBE_TERMINATION_PENDING' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(probe.resume()).toBe(false);
      await expect(probe.describe('blocked.mov')).rejects.toMatchObject({ code: 'PROBE_ABORTED' });
      expect(spawnProcess).toHaveBeenCalledOnce();
      child.emit('close', null);
      const next = probe.describe('resumed.mov');
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      await next; await probe.cancelAllAndWait();
    } finally { child.emit('close', null); vi.useRealTimers(); }
  });

  it.each(['hasAudio', 'audioBitrates'])('%s shutdown 終止超過緩衝期限時仍拒絕，不發布保守 fallback', async method => {
    vi.useFakeTimers();
    const { createMediaProbe } = require('../electron/media-probe');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', terminationGraceMs: 10, spawnProcess: () => child });
    const result = probe[method]('stuck.mov').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const closing = probe.cancelAllAndWait();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toMatchObject({ code: 'PROBE_TERMINATION_TIMEOUT', cause: { code: 'PROBE_ABORTED' } });
    } finally { child.emit('close', null); await closing; vi.useRealTimers(); }
  });

  it('實際 ffprobe IPC→before-quit 等真 native child close 才退出；失敗退出會恢復 probe owner', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    let child, invoke, beforeQuit;
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'adapter', spawnProcess: () => {
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return child;
    } });
    const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const registration = (owner, method, key) => ast.body.map(node => node.expression).find(node =>
      node?.callee?.object?.name === owner && node.callee.property?.name === method && node.arguments?.[0]?.value === key);
    const done = vi.fn().mockResolvedValue(), owner = () => ({ cancelAllAndWait: done, resume: vi.fn() });
    const quit = vi.fn(() => { expect(child.exitCode !== null || child.signalCode !== null).toBe(true); });
    const context = { Promise, console: { error: vi.fn() }, mediaProbe: probe, requireReadablePath: vi.fn(),
      ipcMain: { handle: (_, handler) => { invoke = handler; } }, app: { on: (_, handler) => { beforeQuit = handler; }, quit },
      _quitReady: false, _quitSequenceStarted: false, _isAppQuitting: false, audioNormalizationJobs: new Map(),
      ffmpegExecution: owner(), deliveryCapabilities: owner(), speechCompressionRuntime: owner(), vocalWaveformRuntime: owner(), mediaIngestCoordinator: owner(),
      QueueManager: { prepareForShutdown: done, cancelShutdown: done }, clipAudioCache: { waitForIdle: done },
      clipFrameCache: { waitForIdle: done },
      screenshotOutput: { close: done, resume: done }, mediaIntakeRuntime: { close: done }, mainWin: null,
      dialog: { showMessageBox: done },
    };
    vm.createContext(context);
    for (const call of [registration('ipcMain', 'handle', 'ffprobe'), registration('app', 'on', 'before-quit')]) {
      vm.runInContext(source.slice(call.start, call.end), context);
    }
    let outcome;
    try {
      outcome = invoke({}, 'authorized.mov').catch(error => error);
      await vi.waitFor(() => expect(child?.pid).toBeGreaterThan(0));
      beforeQuit({ preventDefault() {} });
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
      expect(await outcome).toMatchObject({ code: 'PROBE_ABORTED' });
      expect(context._quitReady).toBe(true);
    } finally { child?.kill(); await probe.cancelAllAndWait(); await outcome; }

    // A later cleanup failure cancels quit and reopens this same public owner.
    const resume = vi.fn(() => probe.resume());
    context.mediaProbe = { ...probe, resume };
    context._quitReady = false; context._quitSequenceStarted = false;
    context.screenshotOutput.close = vi.fn().mockRejectedValue(new Error('cleanup locked'));
    beforeQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(context._isAppQuitting).toBe(false);
  });
  it('有效素材在 16 秒後完成探測時，仍保留完整音視訊資訊', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const completion = setTimeout(() => {
        child.stdout.end(JSON.stringify({
          format: { duration: '123.5' },
          streams: [
            { codec_type: 'video', codec_name: 'prores', width: 2048, height: 858, avg_frame_rate: '24/1' },
            { codec_type: 'audio', index: 1, codec_name: 'pcm_s24le', channels: 6 },
          ],
        }));
        child.emit('close', 0, null);
      }, 16000);
      child.kill = vi.fn(() => {
        clearTimeout(completion);
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      });
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });
      const result = probe.describe('D:/media/slow-but-valid.mov').catch(error => error);

      await vi.advanceTimersByTimeAsync(16000);

      await expect(result).resolves.toMatchObject({
        duration: 123.5,
        video: { width: 2048, height: 858, fps: 24 },
        audio: [{ streamIndex: 1, channels: 6 }],
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['hasAudio', 'audioVideoStartOffsets', 'audioBitrates'])('%s 取消不被保守 fallback 吞掉，且等待 native close', async method => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const controller = new AbortController();
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });
    let settled = false;
    const result = probe[method]('D:/media/slow.mxf', { signal: controller.signal }).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(child.listenerCount('close')).toBe(1));
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
  });

  it('同時還原多個有效素材時，不會因探測搶讀而誤報超時，排隊也不占執行期限', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const spawnProcess = vi.fn(() => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        active++;
        peak = Math.max(peak, active);
        const completion = setTimeout(() => {
          active--;
          child.stdout.end(JSON.stringify({ format: { duration: '123.5' }, streams: [] }));
          child.emit('close', 0, null);
        }, active * 5000);
        child.kill = vi.fn(() => {
          clearTimeout(completion);
          active--;
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        });
        return child;
      });
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess, timeoutMs: 15000 });
      const results = Promise.all(['a.mov', 'b.mxf', 'c.mp4', 'd.mov'].map(file =>
        probe.describe(`D:/media/${file}`).catch(error => error)));

      await vi.advanceTimersByTimeAsync(20000);

      await expect(results).resolves.toEqual(Array.from({ length: 4 }, () => ({
        duration: 123.5, video: null, audio: [],
      })));
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同母檔的並行探測共用進行中的 native 工作，下一次重新探測可讀到更新內容', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess });
    const first = probe.describe('D:/media/master.mov');
    const second = probe.describe('D:/media/master.mov');
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    children[0].stdout.end(JSON.stringify({ format: { duration: '12' }, streams: [] }));
    children[0].emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ duration: 12 });
    await expect(second).resolves.toMatchObject({ duration: 12 });

    const next = probe.describe('D:/media/master.mov');
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    children[1].stdout.end(JSON.stringify({ format: { duration: '24' }, streams: [] }));
    children[1].emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ duration: 24 });
  });

  it('同路徑母素材被替換後，新探測不共用舊 descriptor，舊工作也不發布過期資訊', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-probe-identity-'));
    const source = path.join(root, 'source.mov');
    fs.writeFileSync(source, 'old SD mother source');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawnProcess = vi.fn().mockReturnValueOnce(child).mockImplementation(() => completedProcess({
      stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video', width: 1280, height: 720 }] }),
    }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });
    const old = probe.describe(source).catch(error => error);
    let next;
    try {
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
      fs.writeFileSync(source, 'replacement HD mother source');
      next = probe.describe(source);
      child.stdout.end(JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video', width: 320, height: 180 }] }));
      child.emit('close', 0);
      await expect(next).resolves.toMatchObject({ video: { width: 1280, height: 720 } });
      expect(await old).toMatchObject({ code: 'PROBE_SOURCE_CHANGED' });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      child.emit('close', 0);
      await Promise.allSettled([old, next]);
      await probe.cancelAllAndWait();
      removeProbeTempRoot(root);
    }
  });

  it.each(['hasAudio', 'audioBitrates'])('%s 來源不存在時不得發布保守 fallback', async method => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-probe-missing-'));
    const spawnProcess = vi.fn();
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });
    try {
      await expect(probe[method](path.join(root, 'missing.mov'))).rejects.toMatchObject({
        code: 'PROBE_SOURCE_UNAVAILABLE', cause: { code: 'ENOENT' },
      });
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally { await probe.cancelAllAndWait(); removeProbeTempRoot(root); }
  });

  it.each(['hasAudio', 'audioBitrates'].flatMap(method => ['replace', 'remove'].map(action => [method, action])))
  ('%s 探測期間來源 %s，不得把舊資訊或 fallback 當成有效結果', async (method, action) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-probe-changed-'));
    const source = path.join(root, 'source.mov');
    fs.writeFileSync(source, 'old mother source');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child);
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess });
    const pending = probe[method](source);
    try {
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
      if (action === 'replace') fs.writeFileSync(source, 'replacement mother source');
      else fs.unlinkSync(source);
      child.stderr.end('old input failed'); child.emit('close', 1);
      await expect(pending).rejects.toMatchObject({ code: action === 'replace' ? 'PROBE_SOURCE_CHANGED' : 'PROBE_SOURCE_UNAVAILABLE' });
    } finally {
      child.emit('close', 1); await pending.catch(() => {}); await probe.cancelAllAndWait();
      removeProbeTempRoot(root);
    }
  });

  it.each(['before', 'after'])('%s native 的母素材取樣也受 shutdown 屏障保護，resume 不會復活舊工作', async phase => {
    let entered, release, reads = 0;
    const sampling = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fingerprintSource = vi.fn(() => {
      reads++;
      if (reads === (phase === 'before' ? 1 : 2)) { entered(); return gate; }
      return 'stable mother source';
    });
    const spawnProcess = vi.fn(() => completedProcess({ stdout: '{"streams":[]}' }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, fingerprintSource });
    const pending = probe.describe('mother.mov').catch(error => error);
    await sampling;
    let closed = false;
    const closing = probe.cancelAllAndWait().then(() => { closed = true; });
    expect(probe.resume()).toBe(false);
    await Promise.resolve(); expect(closed).toBe(false);
    release('stable mother source');
    expect(await pending).toMatchObject({ code: 'PROBE_ABORTED' });
    await closing;
    expect(spawnProcess).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
    expect(probe.resume()).toBe(true);
    await expect(probe.describe('mother.mov')).resolves.toMatchObject({ audio: [] });
    await probe.cancelAllAndWait();
  });

  it('caller 在母素材取樣等待期間取消，不會遲到啟動程序或取消另一個 caller', async () => {
    let entered, release;
    const sampling = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fingerprintSource = vi.fn().mockImplementationOnce(() => { entered(); return gate; })
      .mockReturnValue('stable mother source');
    const spawnProcess = vi.fn(() => completedProcess({ stdout: '{"streams":[]}' }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ executable: 'ffprobe', spawnProcess, fingerprintSource });
    const controller = new AbortController();
    const cancelled = probe.describe('mother.mov', { signal: controller.signal }).catch(error => error);
    await sampling;
    controller.abort();
    await expect(probe.describe('mother.mov')).resolves.toMatchObject({ audio: [] });
    release('stable mother source');
    expect(await cancelled).toMatchObject({ code: 'PROBE_ABORTED' });
    expect(spawnProcess).toHaveBeenCalledOnce();
    await probe.cancelAllAndWait();
  });

  it('排隊期間取消不會啟動 ffprobe，後續素材仍可完成探測', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnProcess = vi.fn().mockReturnValueOnce(child)
      .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ streams: [] }) }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess, maxConcurrent: 1 });
    const first = probe.describe('D:/media/first.mov');
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = probe.describe('D:/media/cancelled.mov', { signal: controller.signal }).catch(error => error);
    const next = probe.describe('D:/media/next.mov');
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.end(JSON.stringify({ streams: [] }));
    child.emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ audio: [] });
    await expect(next).resolves.toMatchObject({ audio: [] });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[1][1].at(-1)).toBe('D:/media/next.mov');
  });

  it('同母檔有取消所有者的工作不會中止其他 caller 的探測', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', null, 'SIGTERM')));
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess });
    const controller = new AbortController();
    const independent = probe.describe('D:/media/master.mov');
    const cancelled = probe.describe('D:/media/master.mov', { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
    expect(children[0].kill).not.toHaveBeenCalled();
    children[0].stdout.end(JSON.stringify({ format: { duration: '12' }, streams: [] }));
    children[0].emit('close', 0, null);
    await expect(independent).resolves.toMatchObject({ duration: 12 });
  });

  it('spawn 失敗後共用工作與佇列會釋放，重試可取得素材資訊', async () => {
    const spawnProcess = vi.fn().mockImplementationOnce(() => { throw new Error('process unavailable'); })
      .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ format: { duration: '12' }, streams: [] }) }));
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess, maxConcurrent: 1 });
    const first = probe.describe('D:/media/master.mov').catch(error => error);
    const shared = probe.describe('D:/media/master.mov').catch(error => error);
    const next = probe.describe('D:/media/next.mov');
    await expect(first).resolves.toMatchObject({ message: 'process unavailable' });
    await expect(shared).resolves.toMatchObject({ message: 'process unavailable' });
    await expect(next).resolves.toMatchObject({ duration: 12 });
    await expect(probe.describe('D:/media/master.mov')).resolves.toMatchObject({ duration: 12 });
    expect(spawnProcess).toHaveBeenCalledTimes(3);
  });

  it('排隊工作等待期間若再有另一個行程取消，會等全部終止屏障關閉才啟動', async () => {
    const children = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess, maxConcurrent: 3 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = probe.describe('D:/media/a.mov', { signal: firstController.signal }).catch(error => error);
    const second = probe.describe('D:/media/b.mov', { signal: secondController.signal }).catch(error => error);
    const third = probe.describe('D:/media/c.mov');
    const next = probe.describe('D:/media/d.mov').catch(error => error);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    firstController.abort();
    children[2].stdout.end(JSON.stringify({ streams: [] }));
    children[2].emit('close', 0, null);
    await third;
    secondController.abort();
    children[0].emit('close', null, 'SIGTERM');
    await first;
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    children[1].emit('close', null, 'SIGTERM');
    await second;
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(4));
    children[3].stdout.end(JSON.stringify({ streams: [] }));
    children[3].emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ audio: [] });
  });

  it('預設上限仍會中止永久卡住的探測，確認 close 後才回報超時', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });
      let settled = false;
      const result = probe.describe('D:/media/stuck.mov').catch(error => { settled = true; return error; });
      await vi.advanceTimersByTimeAsync(16000);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(44000);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      child.emit('close', null, 'SIGTERM');
      await expect(result).resolves.toMatchObject({ code: 'PROBE_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('保留壓縮來源音訊相對影像的起始時間，供航空交付去除前導', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => completedProcess({
      stdout: JSON.stringify({ streams: [
        { codec_type: 'video', start_time: '0', disposition: { attached_pic: 1 } },
        { codec_type: 'video', start_time: '2.033367' },
        { codec_type: 'audio', start_time: '2.023344' },
        { codec_type: 'audio', start_time: '2.033367' },
      ] }),
    }) });
    await expect(probe.audioVideoStartOffsets('D:/media/encoded.mpg'))
      .resolves.toEqual([expect.closeTo(-0.010023, 6), 0]);
  });

  it('把 ffprobe 輸出正規化成 renderer 使用的 descriptor', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const spawnProcess = vi.fn(() => completedProcess({
      stdout: JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 }, width: 800, height: 800 },
          { codec_type: 'video', codec_name: 'prores', avg_frame_rate: '30000/1001', width: 1920, height: 1080 },
          { codec_type: 'audio', index: 2, codec_name: 'pcm_s24le', channels: 2, tags: { LANGUAGE: 'zho', TITLE: '20FM' } },
        ],
      }),
    }));
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess });

    await expect(probe.describe('D:/media/master.mov')).resolves.toEqual({
      duration: 12.5,
      video: { codec: 'prores', width: 1920, height: 1080, fps: 30000 / 1001, timestampOffset: 0, presentationTimestampOffset: 0 },
      audio: [{ index: 0, streamIndex: 2, codec: 'pcm_s24le', channels: 2, lang: 'zho', title: '20FM', timestampOffset: 0, presentationTimestampOffset: 0 }],
    });
    expect(spawnProcess).toHaveBeenCalledWith('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', 'D:/media/master.mov',
    ], expect.objectContaining({ windowsHide: true }));
  });

  it('保留來源的 SAR、像素格式、色彩矩陣、primaries、transfer 與 range，不能在 Proxy 縮放後重新猜測', () => {
    const { descriptorOf } = require('../electron/media-probe');
    const result = descriptorOf({ streams: [{ codec_type: 'video', width: 720, height: 576, sample_aspect_ratio: '1:2', pix_fmt: 'yuv420p',
      color_space: 'bt470bg', color_primaries: 'bt470bg', color_transfer: 'bt709', color_range: 'tv' }] });
    expect(result.video).toMatchObject({ width: 720, height: 576, sampleAspectRatio: '1:2', pixelFormat: 'yuv420p',
      colorSpace: 'bt470bg', colorPrimaries: 'bt470bg', colorTransfer: 'bt709', colorRange: 'tv' });
  });

  it('stalled ffprobe 到期後先終止並等 close，下一次探測才可啟動', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnProcess = vi.fn()
        .mockReturnValueOnce(child)
        .mockImplementation(() => completedProcess({ stdout: JSON.stringify({ streams: [] }) }));
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess, timeoutMs: 25 });

      let firstSettled = false;
      const result = probe.describe('//server/slow/master.mxf').catch(error => {
        firstSettled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(firstSettled).toBe(false);

      const nextResult = probe.describe('D:/media/next.mov');
      await Promise.resolve();
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      child.emit('close', null, 'SIGKILL');
      await expect(result).resolves.toMatchObject({ code: 'PROBE_TIMEOUT' });
      await expect(nextResult).resolves.toMatchObject({ audio: [] });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('音訊存在探測失敗時採保守策略，不會讓 legacy export 靜默漏音訊', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source',
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({ status: 1, stderr: 'network input failed' }),
    });

    await expect(probe.hasAudio('Z:/offline/master.mxf')).resolves.toBe(true);
  });

  it('交付完成後回報檔案實際寫入的聲道數與 bitrate', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source',
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({
        stdout: JSON.stringify({ streams: [
          { channels: 2, bit_rate: '320000' },
          { channels: 6, bit_rate: '639500' },
        ] }),
      }),
    });

    await expect(probe.audioBitrates('D:/delivery/program.mp4')).resolves.toEqual([
      { channels: 2, kbps: 320 },
      { channels: 6, kbps: 640 },
    ]);
  });

  it('caller 取消探測時會終止 native process', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => queueMicrotask(() => child.emit('close', null, 'SIGTERM')));
    const controller = new AbortController();
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source', executable: 'ffprobe', spawnProcess: () => child });

    const result = probe.describe('D:/media/slow.mxf', { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(child.listenerCount('close')).toBe(1));
    controller.abort();

    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatchObject({ code: 'PROBE_ABORTED' });
  });

  it('終止後未收到 close 會安全收斂，且阻擋新的 ffprobe 重疊啟動', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => { throw new Error('kill refused'); });
    const spawnProcess = vi.fn(() => child);
    try {
      const controller = new AbortController();
      const { createMediaProbe } = require('../electron/media-probe');
      const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source',
        executable: 'ffprobe',
        spawnProcess,
        terminationGraceMs: 50,
      });
      let outcome = null;
      const result = probe.describe('D:/media/stuck.mov', { signal: controller.signal })
        .catch(error => { outcome = error; return error; });

      await vi.advanceTimersByTimeAsync(0);
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(50);

      expect(outcome).toMatchObject({
        code: 'PROBE_TERMINATION_TIMEOUT',
        cause: { code: 'PROBE_ABORTED' },
      });
      await expect(result).resolves.toBe(outcome);
      await expect(probe.describe('D:/media/must-not-overlap.mov'))
        .rejects.toMatchObject({ code: 'PROBE_TERMINATION_PENDING' });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      child.emit('close', null, 'SIGKILL');
      vi.useRealTimers();
    }
  });

  it('malformed ffprobe JSON 以穩定錯誤碼拒絕', async () => {
    const { createMediaProbe } = require('../electron/media-probe');
    const probe = createMediaProbe({ fingerprintSource: () => 'stable-test-source',
      executable: 'ffprobe',
      spawnProcess: () => completedProcess({ stdout: '{broken' }),
    });

    await expect(probe.describe('D:/media/broken.mov')).rejects.toMatchObject({ code: 'PROBE_PARSE' });
  });
});

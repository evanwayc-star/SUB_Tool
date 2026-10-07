import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createMediaIntakeRuntime, createMediaIngestCoordinator, cacheKeyFor } = require('../electron/media-intake-runtime.js');

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-media-intake-'));
  tempRoots.push(root);
  return root;
}

function repairFixture(execute, overrides = {}) {
  const root = makeTempRoot();
  const source = path.join(root, 'source.bin');
  const cacheRoot = path.join(root, 'cache');
  fs.writeFileSync(source, 'unchanged mother source');
  const calls = [];
  const options = {
    cacheRoot, tempRoot: root, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
    createStreamId: prefix => `${prefix}fixed`, delay: async () => {},
    ffmpegExecution: { execute(args) {
      calls.push(args);
      return execute(args, calls.length);
    } },
    ...overrides,
  };
  return { source, calls, runtime: createMediaIntakeRuntime(options), createRuntime: () => createMediaIntakeRuntime(options) };
}

function writeIntakeOutputs(args) {
  for (const output of args.filter(value => /\.(?:m4a|wav|mp4)$/.test(value))) {
    fs.writeFileSync(output, /proxy\.mp4$/.test(output) ? Buffer.alloc(131072, 7) : Buffer.from('complete audio'));
  }
}

function cacheDirectory(file) {
  const parent = path.dirname(file);
  return path.basename(parent).startsWith('generation-') ? path.dirname(parent) : parent;
}

function successfulProcess(onStart) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    onStart();
    child.stderr.emit('data', Buffer.from('frame=1 time=00:00:01.00 speed=1.0x\n'));
    child.emit('close', 0);
  });
  return child;
}

function getRange(url, range) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: range ? { Range: range } : {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('stream response aborted')));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks),
        contentRange: response.headers['content-range'],
      }));
    });
    request.on('error', reject);
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native media intake runtime', () => {
  it.each(['ingest', 'stream'].flatMap(mode => ['wave', 'channel', 'proxy'].map(missing => [mode, missing])))
  ('%s 只補缺少的 %s，重開與孤兒清理保留其他已完成檔案', async (mode, missing) => {
    const fixture = repairFixture(async args => writeIntakeOutputs(args));
    const request = { src: fixture.source, duration: 1, needsProxy: true, audio: [{ channels: 2 }] };
    const first = await fixture.runtime.ingest(request);
    await fixture.runtime.close();
    const lost = missing === 'wave' ? first.wave : missing === 'proxy' ? first.proxy : first.channels[0].file;
    const kept = [first.proxy, first.wave, ...first.channels.map(channel => channel.file)].filter(file => file !== lost);
    const bytes = kept.map(file => fs.readFileSync(file));
    fs.unlinkSync(lost);
    const reopened = fixture.createRuntime();
    try {
      expect(reopened.cleanOrphans()).toEqual({ removed: 0, bytes: 0 });
      const work = await reopened[mode](request);
      const repaired = mode === 'stream' ? work.response : work;
      await work.completion;
      expect(repaired.cached).toBe(false);
      expect(fixture.calls).toHaveLength(2);
      const outputs = fixture.calls[1].filter(value => /\.(?:m4a|wav|mp4)$/.test(value));
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatch(missing === 'wave' ? /wave\.wav$/ : missing === 'proxy' ? /proxy\.mp4$/ : /ch_01\.m4a$/);
      expect(kept.map(file => fs.readFileSync(file))).toEqual(bytes);
      for (const file of kept) expect([repaired.proxy, repaired.wave, ...repaired.channels.map(channel => channel.file)]).toContain(file);
      const persisted = await fixture.createRuntime().ingest(request);
      expect(persisted).toEqual({ cached: true, proxy: repaired.proxy, wave: repaired.wave, channels: repaired.channels });
      expect(fixture.calls).toHaveLength(2);
    } finally { await reopened.close(); }
  });

  it.each(['ingest', 'stream'].flatMap(mode => ['write', 'rename'].map(failure => [mode, failure])))
  ('%s 索引 %s 失敗必須回報失敗，保留舊索引與 Proxy 並清除未提交檔案', async (mode, failure) => {
    const progress = [];
    const fixture = repairFixture(async args => writeIntakeOutputs(args), { sendProgress: (_, payload) => progress.push(payload) });
    const first = await fixture.runtime.ingest({ src: fixture.source, duration: 1, needsProxy: true, audio: [] });
    const cacheDir = cacheDirectory(first.proxy);
    const metaPath = path.join(cacheDir, 'meta.json');
    const before = fs.readFileSync(metaPath);
    const method = failure === 'write' ? 'writeFileSync' : 'renameSync';
    const original = fs[method];
    const fault = vi.spyOn(fs, method).mockImplementation((file, ...args) => {
      if (String(file).startsWith(metaPath + '.tmp')) throw new Error('metadata disk failure');
      return original(file, ...args);
    });
    progress.length = 0;
    try {
      const request = { src: fixture.source, duration: 1, needsProxy: true, audio: [{ channels: 2 }] };
      if (mode === 'ingest') await expect(fixture.runtime.ingest(request, { progressTarget: {} })).rejects.toThrow('metadata disk failure');
      else {
        const work = await fixture.runtime.stream(request, { progressTarget: {} }).catch(error => error);
        if (work instanceof Error) expect(work.message).toContain('metadata disk failure');
        else {
          await work.completion;
          expect((await getRange(work.response.streamUrl, 'bytes=0-1')).status).toBe(500);
        }
      }
      expect(fs.readFileSync(metaPath)).toEqual(before);
      expect(fs.readdirSync(cacheDir).sort()).toEqual([path.basename(path.dirname(first.proxy)), 'meta.json'].sort());
      expect(progress.filter(payload => payload.done)).toEqual([expect.objectContaining({ outcome: 'failed', errorMsg: expect.stringContaining('metadata disk failure') })]);
    } finally { fault.mockRestore(); await fixture.runtime.close(); }
    expect(await fixture.createRuntime().ingest({ src: fixture.source, duration: 1, needsProxy: true, audio: [] })).toEqual({ ...first, cached: true });
    expect(fixture.calls).toHaveLength(2);
  });

  it.each([false, true])('原生編碼成功後，索引提交結果才發布唯一終態（索引失敗=%s）', async failCommit => {
    const root = makeTempRoot();
    const source = path.join(root, 'source.bin');
    const cacheRoot = path.join(root, 'cache');
    fs.writeFileSync(source, 'source');
    const metaPath = path.join(cacheRoot, cacheKeyFor(source), 'meta.json');
    const events = [];
    const record = (_target, payload) => events.push({ payload, persisted: fs.existsSync(metaPath) });
    const runtime = createMediaIntakeRuntime({
      cacheRoot, allowSidecarCache: false, delay: async () => {},
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
      sendProgress: record,
      ffmpegExecution: createFFmpegExecution({
        getFFmpegPath: () => 'ffmpeg-test', getUserDataDir: () => root,
        send: (target, _channel, payload) => record(target, payload),
        spawnDirect: (_exe, args) => successfulProcess(() => writeIntakeOutputs(args)),
      }),
    });
    const original = fs.renameSync;
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((file, ...args) => {
      if (failCommit && args[0] === metaPath) throw new Error('index publication failed');
      return original(file, ...args);
    });
    try {
      const work = runtime.ingest({ src: source, duration: 1, needsProxy: true, audio: [] }, { progressTarget: {} });
      if (failCommit) await expect(work).rejects.toThrow('index publication failed');
      else await expect(work).resolves.toMatchObject({ cached: false });
      expect(events.some(({ payload }) => !payload.done && payload.pct > 0)).toBe(true);
      expect(events.filter(({ payload }) => payload.done)).toEqual([{
        persisted: !failCommit,
        payload: expect.objectContaining({ done: true, outcome: failCommit ? 'failed' : 'success' }),
      }]);
    } finally { fault.mockRestore(); await runtime.close(); }
  });

  it('素材旁缺件時優先使用中央完整快取，不啟動補建', async () => {
    const fixture = repairFixture(async args => writeIntakeOutputs(args));
    const request = { src: fixture.source, duration: 1, needsProxy: true, audio: [{ channels: 2 }] };
    const complete = await fixture.runtime.ingest(request);
    await fixture.runtime.close();
    const sidecar = path.join(path.dirname(fixture.source), '.subtool_Cache', cacheKeyFor(fixture.source));
    fs.mkdirSync(sidecar, { recursive: true });
    fs.writeFileSync(path.join(sidecar, 'proxy.mp4'), 'keep sidecar proxy');
    fs.writeFileSync(path.join(sidecar, 'meta.json'), JSON.stringify({ proxy: 'proxy.mp4', channels: [], wave: 'missing.wav' }));
    const reopened = createMediaIntakeRuntime({
      cacheRoot: fixture.runtime.cacheInfo().root, allowSidecarCache: true,
      fileAuthority: new FileAuthority({ internalDirectories: [fixture.runtime.cacheInfo().root] }),
      ffmpegExecution: { execute: () => { throw new Error('unnecessary rebuild'); } },
    });
    try {
      expect(await reopened.ingest(request)).toEqual({ ...complete, cached: true });
      expect(fs.readFileSync(path.join(sidecar, 'proxy.mp4'), 'utf8')).toBe('keep sidecar proxy');
    } finally { await reopened.close(); }
  });

  it.each(['ingest', 'stream'])('%s proxy-only cache 必須補齊新請求的全部聲道，保留既有proxy並可跨runtime讀回', async mode => {
    const fixture = repairFixture(async args => writeIntakeOutputs(args));
    const { runtime, source, calls } = fixture;
    try {
      const first = await runtime.ingest({ src: source, duration: 1, needsProxy: true, audio: [] });
      const proxyBytes = fs.readFileSync(first.proxy);
      const request = { src: source, duration: 1, needsProxy: true, audio: [{ channels: 2 }] };
      const work = await runtime[mode](request);
      const second = mode === 'stream' ? work.response : work;
      await work.completion;
      expect(second.cached).toBe(false);
      expect(second.channels.map(({ sourceStream, sourceChannel }) => [sourceStream, sourceChannel])).toEqual([[0, 0], [0, 1]]);
      expect(second.wave).toBeTruthy();
      expect(second.proxy).toBe(first.proxy);
      expect(fs.readFileSync(first.proxy)).toEqual(proxyBytes);
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toContain(first.proxy);
      const persisted = await fixture.createRuntime().ingest(request);
      expect(persisted).toEqual({ cached: true, proxy: second.proxy, channels: second.channels, wave: second.wave });
      expect(calls).toHaveLength(2);
    } finally { await runtime.close(); }
  });

  it('相同總聲道數但不同來源stream座標不可命中舊cache，補建成功仍保留旧完整音訊', async () => {
    const { runtime, source, calls } = repairFixture(async args => writeIntakeOutputs(args));
    const first = await runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 2 }] });
    const before = first.channels.map(channel => fs.readFileSync(channel.file));
    const second = await runtime.ingest({ src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }, { channels: 1 }] });
    expect(second.cached).toBe(false);
    expect(second.channels.map(({ sourceStream, sourceChannel }) => [sourceStream, sourceChannel])).toEqual([[0, 0], [1, 0]]);
    expect(calls).toHaveLength(2);
    expect(first.channels.map(channel => fs.readFileSync(channel.file))).toEqual(before);
    expect(second.channels[0].file).not.toBe(first.channels[0].file);
  });

  it('stream只補proxy，失败時不覆寫已完成audio/meta，且收掉未交付URL與新generation', async () => {
    const { runtime, source, calls } = repairFixture(async (args, count) => {
      if (count === 1) writeIntakeOutputs(args);
      else { fs.writeFileSync(args.at(-1), ''); throw new Error('proxy repair failed'); }
    });
    try {
      const request = { src: source, duration: 1, needsProxy: false, audio: [{ channels: 2 }] };
      const first = await runtime.ingest(request);
      const metaPath = path.join(cacheDirectory(first.wave), 'meta.json');
      const metadata = fs.readFileSync(metaPath);
      const bytes = [...first.channels.map(channel => channel.file), first.wave].map(file => fs.readFileSync(file));
      await expect(runtime.stream(request)).rejects.toThrow('proxy repair failed');
      expect(calls[1].filter(value => /\.(?:m4a|wav)$/.test(value))).toEqual([]);
      expect([...first.channels.map(channel => channel.file), first.wave].map(file => fs.readFileSync(file))).toEqual(bytes);
      expect(fs.readFileSync(metaPath)).toEqual(metadata);
      expect(fs.existsSync(path.dirname(calls[1].at(-1)))).toBe(false);
      expect(runtime.releaseStream('l-fixed')).toBe(false);
      expect(await runtime.ingest(request)).toEqual({ ...first, cached: true });
      expect(calls).toHaveLength(2);
    } finally { await runtime.close(); }
  });

  it.each(['ingest', 'stream'])('%s audio routing補建失敗不讓原cache指向半成品', async mode => {
    const { runtime, source } = repairFixture(async (args, count) => {
      writeIntakeOutputs(args);
      if (count === 2) {
        for (const file of args.filter(value => /\.m4a$/.test(value))) fs.writeFileSync(file, '');
        throw new Error('audio repair failed');
      }
    });
    try {
      const firstRequest = { src: source, duration: 1, needsProxy: true, audio: [{ channels: 1 }] };
      const first = await runtime.ingest(firstRequest);
      const before = fs.readFileSync(first.channels[0].file);
      const work = runtime[mode]({ ...firstRequest, audio: [{ channels: 2 }] });
      if (mode === 'ingest') await expect(work).rejects.toThrow('audio repair failed');
      else {
        // Existing proxy may already be playable; whichever side of the threshold fails owns cleanup.
        const response = await work.catch(error => error);
        if (!(response instanceof Error)) await response.completion;
        else expect(response.message).toContain('audio repair failed');
      }
      expect(fs.readFileSync(first.channels[0].file)).toEqual(before);
      expect(await runtime.ingest(firstRequest)).toEqual({ ...first, cached: true });
    } finally { await runtime.close(); }
  });

  it('合法快取命中傳送明確 success 終態給原 sender', async () => {
    const sendProgress = vi.fn();
    const { runtime, source, calls } = repairFixture(async args => writeIntakeOutputs(args), { sendProgress });
    const request = { src: source, duration: 1, needsProxy: true, audio: [] };
    const progressTarget = { id: 17 };
    try {
      await runtime.ingest(request, { progressTarget });
      sendProgress.mockClear();
      await expect(runtime.ingest(request, { progressTarget })).resolves.toMatchObject({ cached: true });
      expect(calls).toHaveLength(1);
      expect(sendProgress).toHaveBeenCalledExactlyOnceWith(progressTarget, {
        jobId: 'ingest', label: '使用既有快取', pct: 100, done: true, outcome: 'success',
      });
    } finally { await runtime.close(); }
  });

  it('已撤銷的 batch 請求不能命中快取或發布成功', async () => {
    const sendProgress = vi.fn();
    const { runtime, source, calls } = repairFixture(async args => writeIntakeOutputs(args), { sendProgress });
    const request = { src: source, duration: 1, needsProxy: true, audio: [] };
    try {
      await runtime.ingest(request);
      sendProgress.mockClear();
      await expect(runtime.ingest(request, { isCancelled: () => true, progressTarget: {} })).rejects.toThrow('較新的載入取代');
      expect(sendProgress).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    } finally { await runtime.close(); }
  });

  it.each(['sync', 'async'])('stream %s execute failure 在可播回應前釋放URL lease', async failure => {
    const { runtime, source } = repairFixture(() => {
      if (failure === 'sync') throw new Error('encoder missing');
      return Promise.reject(new Error('encoder missing'));
    });
    try {
      await expect(runtime.stream({ src: source, duration: 1, audio: [] })).rejects.toThrow('encoder missing');
      expect(runtime.releaseStream('l-fixed')).toBe(false);
    } finally { await runtime.close(); }
  });

  it('可播輪詢exception仍保留coordinator writer ownership到completion，之後才准入下一工作', async () => {
    let finish;
    let polled;
    const writing = new Promise(resolve => { finish = resolve; });
    const polling = new Promise(resolve => { polled = resolve; });
    const { runtime, source, calls } = repairFixture(async args => {
      fs.writeFileSync(args.at(-1), 'small proxy');
      await writing;
    }, { delay: async milliseconds => { if (milliseconds === 300) { polled(); throw new Error('poll failed'); } } });
    const coordinator = createMediaIngestCoordinator();
    const request = { src: source, duration: 1, audio: [] };
    const failed = coordinator.replace(session => runtime.stream(request, session)).catch(error => error);
    try {
      await polling;
      expect(calls).toHaveLength(1);
      const next = vi.fn(() => runtime.ingest({ ...request, needsProxy: true }));
      const queued = coordinator.enqueue(next);
      await Promise.resolve();
      expect(next).not.toHaveBeenCalled();
      finish();
      await expect(failed).resolves.toMatchObject({ message: 'poll failed' });
      await expect(queued).resolves.toMatchObject({ cached: true });
      expect(next).toHaveBeenCalledOnce();
      expect(runtime.releaseStream('l-fixed')).toBe(false);
    } finally { finish(); await coordinator.cancelAllAndWait(); await runtime.close(); }
  });

  it('0-byte cached channel 不可被視為完整快取', async () => {
    const { runtime, source, calls } = repairFixture(async args => writeIntakeOutputs(args));
    const request = { src: source, duration: 1, needsProxy: false, audio: [{ channels: 2 }] };
    const first = await runtime.ingest(request);
    fs.writeFileSync(first.channels[0].file, '');
    const second = await runtime.ingest(request);
    expect(second.cached).toBe(false);
    expect(second.channels.map(channel => fs.statSync(channel.file).size)).toEqual([14, 14]);
    expect(calls).toHaveLength(2);
  });

  it('HTTP 拒絕損毀 URL/range，來源消失的 reader error 不會成為 uncaught error', async () => {
    const root = makeTempRoot();
    const source = path.join(root, 'source.mov');
    const cacheRoot = path.join(root, 'cache');
    fs.writeFileSync(source, 'source');
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache: false,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
      ffmpegExecution: { async execute(args) { fs.writeFileSync(args.at(-1), 'proxy bytes'); } },
    });
    try {
      await runtime.ingest({ src: source, duration: 1, needsProxy: true, audio: [] });
      const stream = await runtime.stream({ src: source, duration: 1, audio: [] });
      expect(path.basename(cacheDirectory(stream.proxy))).toBe(cacheKeyFor(source));
      expect((await getRange(new URL('/%', stream.streamUrl).href, 'bytes=0-1')).status).toBe(400);
      expect((await getRange(stream.streamUrl, 'bytes=5-2')).status).toBe(416);
      expect((await getRange(stream.streamUrl, 'bytes=0-1,3-4')).status).toBe(400);
      fs.unlinkSync(stream.proxy);
      await expect(getRange(stream.streamUrl)).rejects.toBeInstanceOf(Error);
    } finally { await runtime.close(); }
  });

  it.each(['disconnect', 'release', 'close'])('%s 終止尚未取得足夠 bytes 的 Range，不再輪詢也不阻擋 server close', async action => {
    const root = makeTempRoot();
    const source = path.join(root, 'source.mov');
    const cacheRoot = path.join(root, 'cache');
    fs.writeFileSync(source, 'source');
    let finish;
    const writing = new Promise(resolve => { finish = resolve; });
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache: false,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
      ffmpegExecution: { async execute(args) {
        fs.writeFileSync(args.at(-1), Buffer.alloc(131072));
        await writing;
      } },
    });
    const work = await runtime.stream({ src: source, duration: 1, audio: [] });
    const fsp = require('node:fs/promises');
    const originalStat = fsp.stat;
    let polls = 0;
    const stat = vi.spyOn(fsp, 'stat').mockImplementation((file, ...args) => {
      if (file === work.response.proxy) polls++;
      return originalStat(file, ...args);
    });
    let request;
    const ended = new Promise(resolve => {
      request = http.get(work.response.streamUrl, { headers: { Range: 'bytes=200000-200010' } });
      request.on('error', resolve);
    });
    try {
      await vi.waitFor(() => expect(polls).toBe(1));
      if (action === 'disconnect') request.destroy(new Error('client gone'));
      else if (action === 'release') runtime.releaseStream(work.response.streamLeaseId);
      else await runtime.close();
      await ended;
      await runtime.close();
      const before = polls;
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(polls).toBe(before);
    } finally {
      stat.mockRestore(); request.destroy(); finish(); await work.completion; await runtime.close();
    }
  });

  it.each([false, true])('clearAll 保留 writer 與播放 reader（sidecar=%s），都釋放後才可清除且 bytes 只計成功刪除', async allowSidecarCache => {
    const root = makeTempRoot();
    const source = path.join(root, 'source.mov');
    const cacheRoot = path.join(root, 'cache');
    fs.writeFileSync(source, 'source');
    const old = path.join(cacheRoot, 'old');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'proxy.mp4'), 'delete');
    const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    let finish;
    const writing = new Promise(resolve => { finish = resolve; });
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache, fileAuthority: authority,
      ffmpegExecution: { async execute(args) {
        fs.writeFileSync(args.at(-1), Buffer.alloc(131072));
        await writing;
      } },
    });
    const work = await runtime.stream({ src: source, duration: 1, audio: [] });
    try {
      expect(runtime.clearAll(source)).toEqual({ bytes: 6 });
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(work.response.proxy)).toBe(true);
      finish(); await work.completion;
      expect(runtime.clearAll(source)).toEqual({ bytes: 0 });
      expect((await getRange(work.response.streamUrl, 'bytes=0-4')).status).toBe(206);
      expect(runtime.releaseStream(work.response.streamLeaseId)).toBe(true);
      expect(runtime.clearAll(source).bytes).toBeGreaterThanOrEqual(131072);
      expect(fs.existsSync(work.response.proxy)).toBe(false);
    } finally { finish(); await work.completion; await runtime.close(); }
  });

  it('cache-hit 多個 reader 皆釋放前清除不能破壞有效 Range URL，close 也釋放 retention', async () => {
    const { runtime, source } = repairFixture(async args => writeIntakeOutputs(args), {
      createStreamId: (() => { let id = 0; return prefix => prefix + ++id; })(),
    });
    try {
      await runtime.ingest({ src: source, duration: 1, needsProxy: true, audio: [] });
      const first = await runtime.stream({ src: source, duration: 1, audio: [] });
      const second = await runtime.stream({ src: source, duration: 1, audio: [] });
      expect(first.cached).toBe(true);
      expect(runtime.clearAll(source)).toEqual({ bytes: 0 });
      expect((await getRange(first.streamUrl, 'bytes=0-4')).status).toBe(206);
      expect(runtime.releaseStream(first.streamLeaseId)).toBe(true);
      expect(runtime.clearAll(source)).toEqual({ bytes: 0 });
      expect((await getRange(second.streamUrl, 'bytes=0-4')).status).toBe(206);
      await runtime.close();
      expect(runtime.clearAll(source).bytes).toBeGreaterThanOrEqual(131072);
      expect(fs.existsSync(second.proxy)).toBe(false);
    } finally { await runtime.close(); }
  });

  it('音軌先完成後才補做 Proxy 時沿用音軌與波形，不重抽完整母素材音訊', async () => {
    const root = makeTempRoot();
    const source = path.join(root, 'large-canopus.avi');
    const cacheRoot = path.join(root, 'cache');
    fs.writeFileSync(source, 'source');
    const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    const calls = [];
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, fileAuthority: authority, allowSidecarCache: false,
      getEncoder: () => 'libx264', delay: async () => {},
      ffmpegExecution: { async execute(args) {
        calls.push(args);
        for (const output of args.filter(value => /\.(?:m4a|wav|mp4)$/.test(value))) {
          fs.writeFileSync(output, 'cache');
        }
      } },
    });
    const request = { src: source, duration: 7448.441, audio: [{channels:2,codec:'pcm_s16le'}] };
    const first = await runtime.ingest({ ...request, needsProxy:false });
    const second = await runtime.ingest({ ...request, needsProxy:true });
    const third = await runtime.ingest({ ...request, needsProxy:true });

    expect(calls).toHaveLength(2);
    expect(first.proxy).toBeNull();
    expect(first.channels).toHaveLength(2);
    expect(second.channels).toEqual(first.channels);
    expect(second.wave).toBe(first.wave);
    expect(second.proxy).toMatch(/proxy\.mp4$/);
    expect(calls[1]).not.toContain('-filter_complex');
    expect(calls[1].filter(value => /\.(?:m4a|wav)$/.test(value))).toEqual([]);
    expect(third.cached).toBe(true);
  });

  it('batch ingest 完成後，新 runtime 從持久 cache 回傳相同素材 outcome 而不重跑 ffmpeg', async () => {
    const root = makeTempRoot();
    const userDataDir = path.join(root, 'user-data');
    const cacheRoot = path.join(userDataDir, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));

    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    let spawnCount = 0;
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args) {
        spawnCount++;
        const proxyPath = args.at(-1);
        return successfulProcess(() => fs.writeFileSync(proxyPath, Buffer.from('proxy-bytes')));
      },
    });
    const createRuntime = () => createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async () => {},
    });
    const session = { isCancelled: () => false, ownProcess() {} };

    const first = await createRuntime().ingest({
      src: source,
      duration: 10,
      needsProxy: true,
      audio: [],
    }, session);
    const second = await createRuntime().ingest({
      src: source,
      duration: 10,
      needsProxy: true,
      audio: [],
    }, session);

    expect(first).toMatchObject({ cached: false, channels: [], wave: null });
    expect(first.proxy).toMatch(/[\\/]\.subtool_Cache[\\/][a-f0-9]{16}[\\/]generation-[a-f0-9]{24}[\\/]proxy\.mp4$/);
    expect(JSON.parse(fs.readFileSync(path.join(cacheDirectory(first.proxy), 'meta.json'), 'utf8')))
      .toEqual({ proxy: path.relative(cacheDirectory(first.proxy), first.proxy).split(path.sep).join('/'), wave: null, channels: [] });
    expect(second).toEqual({ ...first, cached: true });
    expect(spawnCount).toBe(1);
    expect(authority.canRead(first.proxy)).toBe(true);
  });

  it('同名素材與同大小原地改寫後段都不能沿用舊 Proxy', async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'cache');
    const firstDir = path.join(root, 'first');
    const secondDir = path.join(root, 'second');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const firstSource = path.join(firstDir, 'program.avi');
    const secondSource = path.join(secondDir, 'program.avi');
    const sourceBytes = Buffer.alloc(1024 * 1024 + 1, 65);
    sourceBytes[sourceBytes.length - 1] = 66;
    fs.writeFileSync(firstSource, sourceBytes);
    sourceBytes[sourceBytes.length - 1] = 67;
    fs.writeFileSync(secondSource, sourceBytes);
    const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
    let encodes = 0;
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache: false, fileAuthority: authority,
      delay: async () => {}, getEncoder: () => 'libx264',
      ffmpegExecution: { async execute(args) {
        encodes++;
        const source = args[args.indexOf('-i') + 1];
        fs.writeFileSync(args.at(-1), `proxy-${fs.readFileSync(source).at(-1)}`);
      } },
    });
    const request = src => ({ src, duration: 10, needsProxy: true, audio: [] });
    const first = await runtime.ingest(request(firstSource));
    const other = await runtime.ingest(request(secondSource));
    sourceBytes[sourceBytes.length - 1] = 68;
    fs.writeFileSync(firstSource, sourceBytes);
    const replaced = await runtime.ingest(request(firstSource));
    const repeat = await runtime.ingest(request(firstSource));

    expect(encodes).toBe(3);
    expect([first.cached, other.cached, replaced.cached, repeat.cached]).toEqual([false, false, false, true]);
    expect(new Set([first.proxy, other.proxy, replaced.proxy]).size).toBe(3);
    expect(fs.readFileSync(first.proxy, 'utf8')).toBe('proxy-66');
    expect(fs.readFileSync(other.proxy, 'utf8')).toBe('proxy-67');
    expect(fs.readFileSync(replaced.proxy, 'utf8')).toBe('proxy-68');
  });

  it('驗收模式可強制使用隔離中央 cache，不在母素材旁建立 sidecar', async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'user-data', 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const sourceDir = path.join(root, 'source');
    const source = path.join(sourceDir, 'master.mov');
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));

    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => path.join(root, 'user-data'),
      spawnDirect(executable, args) {
        return successfulProcess(() => fs.writeFileSync(args.at(-1), Buffer.from('proxy-bytes')));
      },
    });
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async () => {},
      allowSidecarCache: false,
    });

    const result = await runtime.ingest({
      src: source,
      duration: 10,
      needsProxy: true,
      audio: [],
    }, { isCancelled: () => false, ownProcess() {} });

    expect(path.dirname(cacheDirectory(result.proxy))).toBe(cacheRoot);
    expect(fs.existsSync(path.join(sourceDir, '.subtool_Cache'))).toBe(false);
  });

  it('stream cache hit 建立不可猜測的 loopback URL，並以 HTTP Range 供應 proxy bytes', async () => {
    const root = makeTempRoot();
    const userDataDir = path.join(root, 'user-data');
    const cacheRoot = path.join(userDataDir, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));

    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args) {
        return successfulProcess(() => fs.writeFileSync(args.at(-1), Buffer.from('proxy-bytes')));
      },
    });
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async () => {},
    });
    const session = { isCancelled: () => false, ownProcess() {} };
    await runtime.ingest({ src: source, duration: 10, needsProxy: true, audio: [] }, session);

    const streamed = await runtime.stream({ src: source, duration: 10, audio: [] }, session);
    const response = await getRange(streamed.streamUrl, 'bytes=0-4');
    expect(runtime.releaseStream(streamed.streamLeaseId)).toBe(true);
    const released = await getRange(streamed.streamUrl, 'bytes=0-4');
    await runtime.close();

    expect(streamed).toMatchObject({ cached: true, proxy: expect.stringMatching(/proxy\.mp4$/) });
    expect(streamed.streamLeaseId).toMatch(/^c-[a-f0-9]{24}$/);
    expect(streamed.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c-[a-f0-9]{24}$/);
    expect(response).toEqual({
      status: 206,
      body: Buffer.from('proxy'),
      contentRange: 'bytes 0-4/11',
    });
    expect(released.status).toBe(404);
  });

  it('cancelled stream 在未交付 URL 前立即釋放 registry lease', async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
      createStreamId: prefix => `${prefix}fixed`,
    });

    await expect(runtime.stream({ src: source, duration: 10, audio: [] }, {
      isCancelled: () => true,
    })).resolves.toEqual({ response: null, completion: null });
    expect(runtime.releaseStream('l-fixed')).toBe(false);
    await runtime.close();
  });

  it('uncached stream 先回可播放 response，直到 ffmpeg completion 才 commit 持久 cache', async () => {
    const root = makeTempRoot();
    const userDataDir = path.join(root, 'user-data');
    const cacheRoot = path.join(userDataDir, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));

    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    let finishFFmpeg;
    let spawnCount = 0;
    const delayCalls = [];
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args) {
        spawnCount++;
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        const proxyPath = args.find(value => /proxy\.mp4$/.test(value));
        fs.writeFileSync(proxyPath, Buffer.alloc(131072, 7));
        finishFFmpeg = () => child.emit('close', 0);
        return child;
      },
    });
    const createRuntime = () => createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async milliseconds => { delayCalls.push(milliseconds); },
    });
    const runtime = createRuntime();
    const session = { isCancelled: () => false, ownProcess() {} };

    const work = await runtime.stream({ src: source, duration: 10, audio: [] }, session);
    expect(work.response).toMatchObject({
      cached: false,
      proxy: expect.stringMatching(/proxy\.mp4$/),
      streamUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/l-[a-f0-9]{24}$/),
    });
    expect(spawnCount).toBe(1);
    expect(delayCalls).toEqual([]);

    finishFFmpeg();
    await work.completion;
    await runtime.close();
    const cached = await createRuntime().ingest({
      src: source, duration: 10, needsProxy: true, audio: [],
    }, session);

    expect(cached).toMatchObject({ cached: true, proxy: work.response.proxy });
    expect(spawnCount).toBe(1);
  });

  it('清理孤兒檔不刪仍在串流轉檔中的中央 Proxy', async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const source = path.join(root, 'program.avi');
    fs.writeFileSync(source, 'source');
    let finish;
    const finishing = new Promise(resolve => { finish = resolve; });
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache: false,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
      delay: async () => {}, getEncoder: () => 'libx264',
      ffmpegExecution: { async execute(args) {
        fs.writeFileSync(args.find(value => /proxy\.mp4$/.test(value)), Buffer.alloc(131072, 7));
        await finishing;
      } },
    });
    const work = await runtime.stream({ src: source, duration: 10, audio: [] });
    const proxy = work.response.proxy;
    expect(runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(proxy)).toBe(true);
    finish();
    await work.completion;
    expect(fs.existsSync(path.join(cacheDirectory(proxy), 'meta.json'))).toBe(true);
    await runtime.close();
  });

  it('cleanOrphans 只刪確定無效的 cache，損毀 meta 必須 fail-safe 保留', () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const orphan = path.join(cacheRoot, 'orphan');
    const corrupt = path.join(cacheRoot, 'corrupt');
    fs.mkdirSync(orphan, { recursive: true });
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'partial.bin'), Buffer.from('1234'));
    fs.writeFileSync(path.join(corrupt, 'meta.json'), '{broken');
    fs.writeFileSync(path.join(corrupt, 'proxy.mp4'), Buffer.from('keep'));
    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
    });

    expect(runtime.cacheInfo()).toEqual({ root: cacheRoot, folders: 2, bytes: 15 });
    expect(runtime.cleanOrphans()).toEqual({ removed: 1, bytes: 4 });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(corrupt)).toBe(true);
    expect(runtime.cacheInfo()).toEqual({ root: cacheRoot, folders: 1, bytes: 11 });
  });

  it('清理孤兒檔時保留正在寫入的中央快取，完成後才可讀取', async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const source = path.join(root, 'program.avi');
    fs.writeFileSync(source, 'source');
    const orphan = path.join(cacheRoot, 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'partial.bin'), 'orphan');
    let started;
    let finish;
    const writing = new Promise(resolve => { started = resolve; });
    const finishing = new Promise(resolve => { finish = resolve; });
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: root, allowSidecarCache: false,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
      delay: async () => {}, getEncoder: () => 'libx264',
      ffmpegExecution: { async execute(args) {
        const output = args.at(-1);
        fs.writeFileSync(output, 'partial proxy');
        started(output);
        await finishing;
      } },
    });
    const work = runtime.ingest({ src: source, duration: 10, needsProxy: true, audio: [] });
    const activeProxy = await writing;
    expect(runtime.cleanOrphans()).toEqual({ removed: 1, bytes: 6 });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(activeProxy)).toBe(true);
    finish();
    const result = await work;
    expect(fs.existsSync(path.join(cacheDirectory(result.proxy), 'meta.json'))).toBe(true);
  });

  it('clearAll 只有在 FileAuthority 已授權母素材時才刪除素材旁 cache', async () => {
    const root = makeTempRoot();
    const userDataDir = path.join(root, 'user-data');
    const cacheRoot = path.join(userDataDir, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));

    const trustedAuthority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    trustedAuthority.grantTrustedFile(source, { read: true, write: false });
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args) {
        return successfulProcess(() => fs.writeFileSync(args.at(-1), Buffer.from('proxy-bytes')));
      },
    });
    const trustedRuntime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: trustedAuthority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async () => {},
    });
    const session = { isCancelled: () => false, ownProcess() {} };
    const ingested = await trustedRuntime.ingest({
      src: source, duration: 10, needsProxy: true, audio: [],
    }, session);
    expect(fs.existsSync(ingested.proxy)).toBe(true);

    const untrustedRuntime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    });
    untrustedRuntime.clearAll(source);
    expect(fs.existsSync(ingested.proxy)).toBe(true);

    const cleared = trustedRuntime.clearAll(source);
    expect(cleared.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(ingested.proxy)).toBe(false);
  });

  it('generated-file cleanup 只刪除 FileAuthority 管理的 cache/temp 檔案', () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const generated = path.join(tempRoot, 'wave.wav');
    const outside = path.join(root, 'mother.wav');
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(generated, Buffer.from('generated'));
    fs.writeFileSync(outside, Buffer.from('mother'));
    const forgotten = [];
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
      forgetTemporaryFile: file => forgotten.push(file),
    });

    expect(runtime.cleanupGeneratedFile(outside)).toBe(false);
    expect(runtime.cleanupGeneratedFile(generated)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(generated)).toBe(false);
    expect(forgotten).toEqual([generated]);
  });

  it('preview cache predicate 不會把 cache 外同名的母素材誤判成 Proxy', () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const runtime = createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    });

    expect(runtime.isPreviewCacheMedia(path.join(cacheRoot, 'abc', 'proxy.mp4'))).toBe(true);
    expect(runtime.isPreviewCacheMedia(path.join(tempRoot, 'ch2.m4a'))).toBe(true);
    expect(runtime.isPreviewCacheMedia(path.join(root, '.subtool_Cache', 'abc', 'ch0.m4a'))).toBe(true);
    expect(runtime.isPreviewCacheMedia(path.join(root, 'camera', 'proxy.mp4'))).toBe(false);
    expect(runtime.isPreviewCacheMedia(path.join(cacheRoot, 'abc', 'master.mxf'))).toBe(false);
  });

  it('stream response 發出後若 session 被取消，不得 commit 舊工作的 cache meta', async () => {
    const root = makeTempRoot();
    const userDataDir = path.join(root, 'user-data');
    const cacheRoot = path.join(userDataDir, 'mediacache');
    const tempRoot = path.join(root, 'temp');
    const source = path.join(root, 'master.mxf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(source, Buffer.from('mother-source-content'));
    const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });

    let spawnCount = 0;
    let finishFirst;
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'ffmpeg-test',
      getUserDataDir: () => userDataDir,
      spawnDirect(executable, args) {
        spawnCount++;
        const proxyPath = args.find(value => /proxy\.mp4$/.test(value));
        if (spawnCount > 1) {
          return successfulProcess(() => fs.writeFileSync(proxyPath, Buffer.from('replacement')));
        }
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => fs.writeFileSync(proxyPath, Buffer.alloc(131072, 7)));
        finishFirst = () => child.emit('close', 0);
        return child;
      },
    });
    const createRuntime = () => createMediaIntakeRuntime({
      cacheRoot,
      tempRoot,
      fileAuthority: authority,
      ffmpegExecution: execution,
      getEncoder: () => 'libx264',
      delay: async () => {},
    });
    let cancelled = false;
    const runtime = createRuntime();
    const work = await runtime.stream({ src: source, duration: 10, audio: [] }, {
      isCancelled: () => cancelled,
      ownProcess() {},
    });
    expect(work.response.cached).toBe(false);

    cancelled = true;
    finishFirst();
    await work.completion;
    await runtime.close();
    const replacement = await createRuntime().ingest({
      src: source, duration: 10, needsProxy: true, audio: [],
    }, { isCancelled: () => false, ownProcess() {} });

    expect(replacement.cached).toBe(false);
    expect(spawnCount).toBe(2);
  });
});

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-media-intake-'));
  tempRoots.push(root);
  return root;
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
    const request = http.get(url, { headers: { Range: range } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
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
    expect(first.proxy).toMatch(/[\\/]\.subtool_Cache[\\/][a-f0-9]{16}[\\/]proxy\.mp4$/);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(first.proxy), 'meta.json'), 'utf8')))
      .toEqual({ proxy: 'proxy.mp4', wave: null, channels: [] });
    expect(second).toEqual({ ...first, cached: true });
    expect(spawnCount).toBe(1);
    expect(authority.canRead(first.proxy)).toBe(true);
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

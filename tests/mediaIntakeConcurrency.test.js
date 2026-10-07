import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { createExportAdmission } = require('../electron/export-queue.js');
const { expectedExportExtension } = require('../electron/ipc-guards.js');
const { mergeSourcePaths } = require('../electron/queue-store.js');

const roots = [];
const runtimes = [];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-intake-concurrency-'));
  roots.push(root);
  const source = path.join(root, 'mother.mov');
  fs.writeFileSync(source, 'unchanged mother source');
  return { root, source };
}

function runtimeFor(root, profile, execute, allowSidecarCache = true) {
  const cacheRoot = path.join(root, profile, 'mediacache');
  const runtime = createMediaIntakeRuntime({
    cacheRoot,
    tempRoot: root,
    allowSidecarCache,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot] }),
    delay: async () => {},
    ffmpegExecution: { execute },
  });
  runtimes.push(runtime);
  return runtime;
}

function outputsOf(args) {
  return args.filter(value => /\.(?:mp4|m4a|wav)$/.test(value));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('media intake shared cache publication', () => {
  it.each([false, true])('實際 ingest 衍生檔不可從外部音訊路由進入交付，同名母素材仍可讀取（sidecar=%s）', async allowSidecarCache => {
    const { root, source } = fixture();
    const cacheRoot = path.join(root, 'profile', 'mediacache');
    const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
    authority.grantTrustedFile(source, { read: true, write: false });
    const outPath = path.join(root, 'delivery.wav');
    authority.grantDeliveryFile(outPath);
    const runtime = createMediaIntakeRuntime({
      cacheRoot, tempRoot: path.join(root, 'temp'), allowSidecarCache,
      fileAuthority: authority, delay: async () => {},
      ffmpegExecution: { async execute(args) {
        for (const output of outputsOf(args)) fs.writeFileSync(output, Buffer.alloc(131072, 7));
      } },
    });
    runtimes.push(runtime);
    const derived = await runtime.ingest({
      src: source, duration: 1, needsProxy: true, audio: [{ channels: 2 }],
    });
    const admission = createExportAdmission({
      expectedExtensionFor: expectedExportExtension,
      outputKeyFor: file => path.resolve(file).toLowerCase(),
      mergeSourcePaths,
      currentJobs: () => [],
      canReadSource: file => authority.canRead(file),
      canWriteDelivery: file => authority.canWriteDelivery(file),
      isPreviewCacheMedia: file => runtime.isPreviewCacheMedia(file),
    });
    const jobFor = file => ({
      id: 'preview-cache-admission',
      sourcePaths: [source],
      payload: {
        format: 'wav', outPath, clips: [{ path: source }],
        audioPlan: { buses: [{ inputs: [{ file }] }] },
      },
    });
    const legacy = path.join(path.dirname(derived.channels[0].file), 'ch1.m4a');
    fs.writeFileSync(legacy, 'legacy preview channel');
    for (const file of [derived.proxy, derived.wave, ...derived.channels.map(channel => channel.file), legacy]) {
      const job = jobFor(file);
      expect(authority.canRead(file)).toBe(true);
      expect(admission.sourcePathsOf(job)).toEqual([source, file]);
      expect(() => admission.assertJobAdmissible(job)).toThrow(expect.objectContaining({ code: 'PREVIEW_CACHE_MEDIA' }));
    }

    const motherDir = path.join(root, 'camera');
    fs.mkdirSync(motherDir);
    for (const name of ['proxy.mp4', 'ch_01.m4a', 'ch1.m4a', 'wave.wav']) {
      const mother = path.join(motherDir, name);
      fs.writeFileSync(mother, 'user supplied mother media');
      authority.grantTrustedFile(mother, { read: true, write: false });
      expect(runtime.isPreviewCacheMedia(mother)).toBe(false);
      expect(admission.assertJobAdmissible(jobFor(mother))).toEqual([source, mother]);
    }
  });

  it.each(['ingest', 'stream'])('%s 失敗 writer 不得覆寫另一 profile 已提交的同來源 sidecar Proxy', async mode => {
    const { root, source } = fixture();
    const started = deferred();
    const finish = deferred();
    const partialBytes = Buffer.alloc(131072, 65);
    const winningBytes = Buffer.alloc(131072, 66);
    const failedBytes = Buffer.alloc(131072, 67);
    const first = runtimeFor(root, 'profile-A', async args => {
      const proxy = outputsOf(args).find(file => path.basename(file) === 'proxy.mp4');
      fs.writeFileSync(proxy, partialBytes);
      started.resolve(proxy);
      await finish.promise;
      fs.writeFileSync(proxy, failedBytes);
      throw new Error('first writer interrupted after the second writer committed');
    });
    const secondExecution = vi.fn(async args => {
      for (const output of outputsOf(args)) fs.writeFileSync(output, winningBytes);
    });
    const second = runtimeFor(root, 'profile-B', secondExecution);
    const request = { src: source, duration: 1, needsProxy: true, audio: [] };
    const firstWork = first[mode](request).catch(error => error);
    let firstResult;
    try {
      await started.promise;
      const successful = await second.ingest(request);
      expect(successful.cached).toBe(false);
      expect(fs.readFileSync(successful.proxy).equals(winningBytes)).toBe(true);
      const dir = path.join(root, '.subtool_Cache', cacheKeyFor(source));
      const published = fs.readFileSync(path.join(dir, 'meta.json'));
      const metadata = JSON.parse(published);
      expect(path.resolve(dir, metadata.proxy)).toBe(successful.proxy);

      if (mode === 'stream') firstResult = await firstWork;
      finish.resolve();
      if (mode === 'stream') {
        expect(firstResult).not.toBeInstanceOf(Error);
        await firstResult.completion;
      } else {
        firstResult = await firstWork;
        expect(firstResult).toBeInstanceOf(Error);
        expect(firstResult.message).toContain('first writer interrupted');
      }

      const reopened = await second.ingest(request);
      expect(reopened.cached).toBe(true);
      expect(reopened.proxy).toBe(successful.proxy);
      expect(fs.readFileSync(reopened.proxy).equals(winningBytes)).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'meta.json'))).toEqual(published);
      expect(secondExecution).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      const settled = firstResult || await firstWork;
      if (mode === 'stream' && !(settled instanceof Error)) await settled.completion;
    }
  });

  it('cleanOrphans 無法確認全部快取檔案的 stat 狀態時仍保留 metadata 與素材', async () => {
    const { root, source } = fixture();
    const bytes = Buffer.alloc(131072, 68);
    const runtime = runtimeFor(root, 'profile', async args => {
      for (const output of outputsOf(args)) fs.writeFileSync(output, bytes);
    }, false);
    const complete = await runtime.ingest({
      src: source, duration: 1, needsProxy: true, audio: [{ channels: 1 }],
    });
    const dir = path.join(root, 'profile', 'mediacache', cacheKeyFor(source));
    const metaPath = path.join(dir, 'meta.json');
    const metadata = fs.readFileSync(metaPath);
    const artifacts = [complete.proxy, complete.wave, ...complete.channels.map(channel => channel.file)];
    const uncertain = new Set(artifacts);
    const originalStat = fs.statSync;
    const stat = vi.spyOn(fs, 'statSync').mockImplementation((file, ...args) => {
      if (uncertain.has(file)) {
        const error = new Error('temporary cache metadata access denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalStat(file, ...args);
    });
    let cleaned;
    try { cleaned = runtime.cleanOrphans(); }
    finally { stat.mockRestore(); }
    expect(cleaned).toEqual({ removed: 0, bytes: 0 });
    expect(fs.readFileSync(metaPath)).toEqual(metadata);
    for (const artifact of artifacts) expect(fs.readFileSync(artifact).equals(bytes)).toBe(true);
  });
});

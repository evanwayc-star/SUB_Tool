import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime.js');
const { sharedSourceFingerprintSync } = require('../electron/mother-source-evidence.js');
const roots = [], runtimes = [];
const sourceBytes = Buffer.alloc(4 * 1024 * 1024, 27);
const proxyBytes = Buffer.alloc(131072, 37);
const outputsOf = args => args.filter(value => /\.(?:mp4|m4a|wav)$/.test(value));
const outputBytes = file => file.endsWith('proxy.mp4') ? proxyBytes : Buffer.from('complete ' + path.basename(file));
const cacheDirectory = file => path.basename(path.dirname(file)).startsWith('generation-')
  ? path.dirname(path.dirname(file)) : path.dirname(file);
const metadata = file => JSON.parse(fs.readFileSync(path.join(cacheDirectory(file), 'meta.json'), 'utf8'));
const request = (src, audio = []) => ({ src, duration: 1, needsProxy: true, audio });

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-shared-evidence-'));
  roots.push(root);
  const media = path.join(root, 'mount-A', 'media');
  fs.mkdirSync(media, { recursive: true });
  const source = path.join(media, 'mother.mxf');
  fs.writeFileSync(source, sourceBytes);
  return { root, media, source };
}

function runtimeFor(root, profile, execute) {
  const cacheRoot = path.join(root, profile, 'mediacache');
  const tempRoot = path.join(root, profile, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const run = vi.fn(async (args, options) => {
    for (const output of outputsOf(args)) fs.writeFileSync(output, outputBytes(output));
    await execute?.(args, options);
  });
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: true,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    delay: async () => {}, ffmpegExecution: { execute: run } });
  runtimes.push(runtime);
  return { runtime, run };
}

function sourceReadMeter(...sources) {
  const paths = new Set(sources.map(source => path.resolve(source)));
  const open = fsp.open;
  const reads = { opens: 0, calls: 0, bytes: 0 };
  vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && paths.has(path.resolve(file))) {
      reads.opens++;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        reads.calls++;
        reads.bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  });
  return { reads, add: source => paths.add(path.resolve(source)),
    reset: () => { reads.opens = 0; reads.calls = 0; reads.bytes = 0; } };
}

function sharedContent(source) {
  return { format: 'source-v4-shared-file', size: sourceBytes.length,
    sharedSourceKey: sharedSourceFingerprintSync(source) };
}

function overrideSharedSourceStat(source, fields) {
  const tracked = new Set(), open = fs.openSync, close = fs.closeSync;
  const statSync = fs.statSync, fstatSync = fs.fstatSync;
  const replace = (stat, options) => options?.bigint
    ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, fields(stat)) : stat;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    const descriptor = open(file, ...args);
    if (typeof file === 'string' && path.resolve(file) === source) tracked.add(descriptor);
    return descriptor;
  });
  vi.spyOn(fs, 'closeSync').mockImplementation(descriptor => { tracked.delete(descriptor); return close(descriptor); });
  vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, options) => {
    const stat = fstatSync(descriptor, options);
    return tracked.has(descriptor) ? replace(stat, options) : stat;
  });
  vi.spyOn(fs, 'statSync').mockImplementation((file, options) => {
    const stat = statSync(file, options);
    return typeof file === 'string' && path.resolve(file) === source ? replace(stat, options) : stat;
  });
}

function transfer(original) {
  const media = path.join(original.root, 'mount-B', 'media');
  fs.cpSync(original.media, media, { recursive: true });
  const source = path.join(media, 'mother.mxf');
  expect(fs.statSync(source, { bigint: true }).ino).not.toBe(fs.statSync(original.source, { bigint: true }).ino);
  return { media, source };
}

function rewriteSourceContent(directory, content) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rewriteSourceContent(file, content);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.sourceContent) fs.writeFileSync(file, JSON.stringify({ ...raw, sourceContent: content }));
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-shared-evidence-'))
      throw new Error('拒絕清除未核對的共享身分快取測試路徑');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('同一共享母素材的快速身分證據與完整內容證據分離', () => {
  it('冷建 sidecar 只發布共享檔案證據，實際來源全文讀取為零', async () => {
    const original = fixture(), meter = sourceReadMeter(original.source);
    const writer = runtimeFor(original.root, 'cold-writer');
    const result = await writer.runtime.ingest(request(original.source));
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(writer.run).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual(sharedContent(original.source));
    expect(metadata(result.proxy).sourceContent).not.toHaveProperty('sha256');
    const publication = JSON.parse(fs.readFileSync(path.join(path.dirname(result.proxy), 'cache-meta.json'), 'utf8'));
    expect(publication.sourceContent).toEqual(sharedContent(original.source));
  });

  it('僅重新命名母素材父目錄並更換 profile，沿用相鄰 sidecar 的同一 Proxy bytes 且不讀全文', async () => {
    const original = fixture(), writer = runtimeFor(original.root, 'rename-writer');
    const saved = await writer.runtime.ingest(request(original.source));
    const oldKey = cacheKeyFor(original.source), witness = sharedSourceFingerprintSync(original.source);
    await writer.runtime.close();
    const media = path.join(original.root, 'renamed-mount');
    fs.renameSync(original.media, media);
    const source = path.join(media, 'mother.mxf');
    expect(cacheKeyFor(source)).not.toBe(oldKey);
    expect(sharedSourceFingerprintSync(source)).toBe(witness);
    const meter = sourceReadMeter(source), reader = runtimeFor(original.root, 'rename-reader');
    const result = await reader.runtime.ingest(request(source));
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(reader.run).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.proxy).toBe(path.join(media, path.relative(original.media, saved.proxy)));
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual(sharedContent(source));
  });

  it('writer 完成後取消不能發布產物，重開重試仍不全文讀取來源', async () => {
    const original = fixture(), meter = sourceReadMeter(original.source);
    let cancelled = false;
    const writer = runtimeFor(original.root, 'cancelled-writer', async () => { cancelled = true; });
    await expect(writer.runtime.ingest(request(original.source), { isCancelled: () => cancelled })).rejects.toThrow(/取代|取消/);
    expect(writer.runtime.inspectCache(original.source).every(hit => !hit.meta?.proxy)).toBe(true);
    await writer.runtime.close();
    const reader = runtimeFor(original.root, 'retry-reader');
    const result = await reader.runtime.ingest(request(original.source));
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(reader.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual(sharedContent(original.source));
  });

  it('串流 writer 完成後取消不發布 Proxy，重開串流重試仍無全文讀取', async () => {
    const original = fixture(), meter = sourceReadMeter(original.source);
    let cancelled = false;
    const writer = runtimeFor(original.root, 'cancelled-stream-writer', async () => { cancelled = true; });
    const interrupted = await writer.runtime.stream(request(original.source), { isCancelled: () => cancelled });
    await interrupted.completion;
    expect(interrupted.response).toBeNull();
    expect(writer.runtime.inspectCache(original.source).every(hit => !hit.meta?.proxy)).toBe(true);
    await writer.runtime.close();
    const reader = runtimeFor(original.root, 'retry-stream-reader');
    const work = await reader.runtime.stream(request(original.source));
    await work.completion;
    const result = work.response || work;
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(reader.run).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual(sharedContent(original.source));
    reader.runtime.releaseStream(result.streamLeaseId);
  });

  it.each(['execute', 'publication-write'])('%s 後僅 birthtimeNs 改變，strict key 不變也不得發布舊來源產物', async point => {
    const original = fixture(), meter = sourceReadMeter(original.source);
    const key = cacheKeyFor(original.source), witness = sharedSourceFingerprintSync(original.source);
    let changed = false;
    overrideSharedSourceStat(original.source, stat => changed ? { birthtimeNs: stat.birthtimeNs + 1n } : {});
    const write = fs.writeFileSync, rename = fs.renameSync, publications = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      const result = write(file, ...args);
      if (point === 'publication-write' && typeof file === 'string'
        && path.basename(file).startsWith('cache-meta.json.tmp-')) changed = true;
      return result;
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target, ...args) => {
      const result = rename(source, target, ...args);
      if (['meta.json', 'cache-meta.json'].includes(path.basename(target))) publications.push(target);
      return result;
    });
    const writer = runtimeFor(original.root, 'changed-' + point, async () => { if (point === 'execute') changed = true; });
    await expect(writer.runtime.ingest(request(original.source))).rejects.toThrow(/母素材.*變更/);
    expect(changed).toBe(true);
    expect(cacheKeyFor(original.source)).toBe(key);
    expect(sharedSourceFingerprintSync(original.source)).not.toBe(witness);
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(writer.run).toHaveBeenCalledOnce();
    expect(publications).toEqual([]);
    const directory = path.join(original.media, '.subtool_Cache', key);
    expect(fs.existsSync(path.join(directory, 'meta.json'))).toBe(false);
    expect(fs.readdirSync(directory).filter(name => name.startsWith('generation-'))).toEqual([]);
    expect(fs.readFileSync(original.source)).toEqual(sourceBytes);
  });

  it('來源沒有可靠檔案 ID 時冷建退回完整 SHA，不發布 shared-file 猜測證據', async () => {
    const original = fixture(), meter = sourceReadMeter(original.source);
    overrideSharedSourceStat(original.source, () => ({ ino: 0n }));
    expect(sharedSourceFingerprintSync(original.source)).toBeNull();
    const writer = runtimeFor(original.root, 'missing-file-id');
    const result = await writer.runtime.ingest(request(original.source));
    expect(meter.reads.opens).toBe(1);
    expect(meter.reads.bytes).toBe(sourceBytes.length);
    expect(writer.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual({ format: 'source-v3-sha256', size: sourceBytes.length,
      sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex') });
    expect(metadata(result.proxy).sourceContent).not.toHaveProperty('sharedSourceKey');
  });

  it('母素材與 shared-only sidecar 複製到不同 inode，即使 bytes 相同也全文驗證一次並重建 Proxy', async () => {
    const original = fixture(), writer = runtimeFor(original.root, 'copy-writer');
    const saved = await writer.runtime.ingest(request(original.source));
    const moved = transfer(original), meter = sourceReadMeter(moved.source);
    expect(sharedSourceFingerprintSync(moved.source)).not.toBe(sharedSourceFingerprintSync(original.source));
    const oldProxy = path.join(moved.media, path.relative(original.media, saved.proxy));
    const reader = runtimeFor(original.root, 'copy-reader');
    const result = await reader.runtime.ingest(request(moved.source));
    expect(meter.reads.opens).toBe(1);
    expect(meter.reads.bytes).toBe(sourceBytes.length);
    expect(reader.run).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(result.proxy).not.toBe(oldProxy);
    expect(fs.readFileSync(oldProxy)).toEqual(proxyBytes);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(metadata(result.proxy).sourceContent).toEqual({ format: 'source-v3-sha256', size: sourceBytes.length,
      sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex') });
  });

  it('共享身分格式混入 sha256 欄位，也不能替另一個 inode 的舊 Proxy 假造全文資格', async () => {
    const original = fixture(), writer = runtimeFor(original.root, 'polluted-writer');
    const saved = await writer.runtime.ingest(request(original.source));
    // Even the correct digest is untrusted when its record declares shared-file evidence.
    rewriteSourceContent(cacheDirectory(saved.proxy), { ...sharedContent(original.source),
      sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex') });
    const moved = transfer(original), meter = sourceReadMeter(moved.source);
    const oldProxy = path.join(moved.media, path.relative(original.media, saved.proxy));
    const reader = runtimeFor(original.root, 'polluted-reader');
    const result = await reader.runtime.ingest(request(moved.source));
    expect(meter.reads.opens).toBe(1);
    expect(meter.reads.bytes).toBe(sourceBytes.length);
    expect(reader.run).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(result.proxy).not.toBe(oldProxy);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
  });

  it.each(['proxy', 'wave', 'channel'])('同一共享檔案的 %s 截短，只補損壞元件並保留其餘 bytes，無全文讀取', async component => {
    const original = fixture(), writer = runtimeFor(original.root, 'partial-writer');
    const audio = [{ channels: 2 }], saved = await writer.runtime.ingest(request(original.source, audio));
    const target = component === 'channel' ? saved.channels[0].file : saved[component];
    const kept = [saved.proxy, saved.wave, ...saved.channels.map(channel => channel.file)].filter(file => file !== target);
    const before = kept.map(file => fs.readFileSync(file));
    fs.truncateSync(target, 2);
    await writer.runtime.close();
    const meter = sourceReadMeter(original.source), reader = runtimeFor(original.root, 'partial-reader');
    const result = await reader.runtime.ingest(request(original.source, audio));
    expect(meter.reads).toEqual({ opens: 0, calls: 0, bytes: 0 });
    expect(reader.run).toHaveBeenCalledOnce();
    expect(outputsOf(reader.run.mock.calls[0][0]).map(file => path.basename(file))).toEqual([path.basename(target)]);
    expect(kept.map(file => fs.readFileSync(file))).toEqual(before);
    for (const file of kept) expect([result.proxy, result.wave, ...result.channels.map(channel => channel.file)]).toContain(file);
    const repaired = component === 'channel' ? result.channels[0].file : result[component];
    expect(fs.readFileSync(repaired)).toEqual(outputBytes(repaired));
    expect(metadata(result.proxy).sourceContent).toEqual(sharedContent(original.source));
  });
});

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime.js');
const roots = [], runtimes = [];
const proxyBytes = Buffer.alloc(131072, 37);
const outputsOf = args => args.filter(value => /\.(?:mp4|m4a|wav)$/.test(value));
const cacheDir = file => path.basename(path.dirname(file)).startsWith('generation-')
  ? path.dirname(path.dirname(file)) : path.dirname(file);
const metadata = file => path.join(cacheDir(file), 'meta.json');

function fixture(bytes = Buffer.from('unchanged original mother source')) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-portable-intake-'));
  roots.push(root);
  const media = path.join(root, 'computer-A', 'media');
  fs.mkdirSync(media, { recursive: true });
  const source = path.join(media, 'mother.mxf');
  fs.writeFileSync(source, bytes);
  return { root, media, source };
}

function runtimeFor(root, profile, { execute, allowSidecarCache = true } = {}) {
  const cacheRoot = path.join(root, profile, 'mediacache');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot] });
  const run = vi.fn(execute || (async args => {
    for (const output of outputsOf(args)) fs.writeFileSync(output,
      output.endsWith('proxy.mp4') ? proxyBytes : Buffer.from('complete source channel'));
  }));
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot: path.join(root, profile, 'tmp'),
    fileAuthority: authority, allowSidecarCache, delay: async () => {}, ffmpegExecution: { execute: run } });
  runtimes.push(runtime);
  return { runtime, run, authority, cacheRoot };
}

function transfer(fixture) {
  const media = path.join(fixture.root, 'computer-B', 'renamed-media-folder');
  fs.cpSync(fixture.media, media, { recursive: true });
  const source = path.join(media, 'mother.mxf');
  const time = new Date('2026-01-03T01:02:03Z');
  fs.utimesSync(source, time, time);
  return { media, source };
}

async function replacePreviouslyVerifiedCache(mode, { defer = false, direct = false } = {}) {
  const original = fixture(), producer = runtimeFor(original.root, 'profile-A');
  const saved = await producer.runtime.ingest(request(original.source, [{ channels: 1 }]));
  const moved = direct ? { media: original.media, source: original.source } : transfer(original);
  const reader = runtimeFor(original.root, 'profile-B');
  const verified = await reader.runtime[mode](request(moved.source, [{ channels: 1 }]));
  expect(verified.cached).toBe(true);
  if (mode === 'stream') reader.runtime.releaseStream(verified.streamLeaseId);

  // A shared folder can be replaced by another synchronization/copy operation
  // while the source and this runtime stay alive. Its old pathname is not proof.
  const other = fixture(Buffer.alloc(fs.statSync(original.source).size, 93));
  const wrongBytes = Buffer.alloc(131072, 99);
  const unrelated = runtimeFor(other.root, 'profile-unrelated', { execute: async args => {
    for (const output of outputsOf(args)) fs.writeFileSync(output, wrongBytes);
  } });
  const wrong = await unrelated.runtime.ingest(request(other.source, [{ channels: 1 }]));
  const directory = cacheDir(verified.proxy);
  expect(path.dirname(directory)).toBe(path.join(moved.media, '.subtool_Cache'));
  expect(path.basename(directory)).toMatch(/^[a-f0-9]{16}$/);
  const wrongProxy = path.join(directory, path.relative(cacheDir(wrong.proxy), wrong.proxy));
  const wrongMetadata = fs.readFileSync(metadata(wrong.proxy));
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(directory, directory + '-previous');
    fs.cpSync(cacheDir(wrong.proxy), directory, { recursive: true });
  };
  if (!defer) replace();
  return { original, saved, moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replace,
    replacementDirectory: cacheDir(wrong.proxy) };
}

function request(src, audio = []) { return { src, duration: 1, needsProxy: true, audio }; }
function siblingIntake(root, src, audio = [{ channels: 2 }]) {
  const configuration = { src, root, audio, runtime: require.resolve('../electron/media-intake-runtime.js'),
    authority: require.resolve('../electron/file-authority.js') };
  const writer = `
    const fs = require('fs'), path = require('path'), config = JSON.parse(process.argv[1]);
    const cacheRoot = path.join(config.root, 'profile-worker', 'mediacache'), encodingOutputs = [];
    const runtime = require(config.runtime).createMediaIntakeRuntime({ cacheRoot, tempRoot: config.root,
      fileAuthority: new (require(config.authority).FileAuthority)({ internalDirectories: [cacheRoot] }),
      delay: async () => {}, ffmpegExecution: { async execute(args) {
        for (const output of args.filter(value => /\\.(?:mp4|m4a|wav)$/.test(value))) {
          encodingOutputs.push(output); fs.writeFileSync(output, Buffer.alloc(131072, 49));
        }
      } } });
    runtime.ingest({ src: config.src, duration: 1, needsProxy: true, audio: config.audio })
      .then(async result => { await runtime.close(); process.stdout.write(JSON.stringify({ ...result, encodingOutputs })); })
      .catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', writer, JSON.stringify(configuration)], { encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function range(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Range: 'bytes=0-31' } }, response => {
      const chunks = [];
      response.on('data', bytes => chunks.push(bytes));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-portable-intake-')) {
      throw new Error('拒絕清除未核對的可攜快取測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function denyWriteHandles(directory) {
  const open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
    if (typeof file === 'string' && file.startsWith(directory + path.sep)
      && path.basename(file).startsWith('.wtest_') && flags === 'wx') {
      throw Object.assign(new Error('shared cache read-only'), { code: 'EACCES' });
    }
    return open(file, flags, ...args);
  });
}

describe('母素材與 Proxy 同處的跨電腦快取', () => {
  it.each(['ingest', 'stream'].flatMap(mode => ['writable', 'staging', 'commit', 'content'].map(point => ({ mode, point }))))
  ('$mode 缺件補建在 $point 被換入另一母素材時，不得發布或清除新內容', async ({ mode, point }) => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replace, replacementDirectory } =
      await replacePreviouslyVerifiedCache(mode, { defer: true });
    const accepted = reader.runtime.inspectCache(moved.source).find(hit => hit.dir === directory && !hit.error);
    for (const { file } of accepted.files) fs.unlinkSync(file);
    const originalEntries = fs.readdirSync(replacementDirectory).sort();
    let swapped = false, replacementOutput;
    if (point === 'writable') {
      const unlink = fs.unlinkSync;
      vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...args) => {
        const result = unlink(file, ...args);
        if (!swapped && path.dirname(file) === directory && path.basename(file).startsWith('.wtest_')) {
          swapped = true; replace();
        }
        return result;
      });
    } else if (point === 'staging') {
      const mkdir = fs.mkdirSync;
      vi.spyOn(fs, 'mkdirSync').mockImplementation((file, ...args) => {
        const result = mkdir(file, ...args);
        if (!swapped && path.dirname(file) === directory && /^generation-[a-f0-9]{24}$/.test(path.basename(file))) {
          swapped = true; replace();
        }
        return result;
      });
    } else {
      reader.run.mockImplementation(async args => {
        for (const output of outputsOf(args)) fs.writeFileSync(output, proxyBytes);
        swapped = true;
        if (point === 'content') fs.cpSync(replacementDirectory, directory, { recursive: true });
        else {
          replace();
          replacementOutput = outputsOf(args)[0];
          fs.mkdirSync(path.dirname(replacementOutput), { recursive: true });
          fs.writeFileSync(replacementOutput, wrongBytes);
        }
      });
    }
    const settled = await reader.runtime[mode](request(moved.source))
      .then(async result => { await result.completion; return { result }; }, error => ({ error }));
    expect(swapped).toBe(true);
    expect(settled.error).toBeInstanceOf(Error);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    if (replacementOutput) expect(fs.readFileSync(replacementOutput)).toEqual(wrongBytes);
    if (['writable', 'staging'].includes(point)) {
      expect(reader.run).not.toHaveBeenCalled();
      expect(fs.readdirSync(directory).sort()).toEqual(originalEntries);
    }
  });

  it.each(['ingest', 'stream'])('%s 失敗 writer 的 generation 已被同名新目錄取代，dispose 必須保留新 bytes', async mode => {
    const original = fixture();
    let replacement;
    const writer = runtimeFor(original.root, 'profile-A', { execute: async args => {
      const output = outputsOf(args)[0], generation = path.dirname(output);
      fs.writeFileSync(output, proxyBytes);
      fs.renameSync(generation, generation + '-previous');
      fs.mkdirSync(generation);
      replacement = path.join(generation, 'another-writer.bin');
      fs.writeFileSync(replacement, 'new writer owns this directory');
      throw new Error('original writer failed');
    } });
    await expect(writer.runtime[mode](request(original.source))).rejects.toThrow(/original writer failed/);
    expect(fs.readFileSync(replacement, 'utf8')).toBe('new writer owns this directory');
  });

  it.each(['ingest', 'stream'])('%s 唯讀補建開始實際複製前換入同大小他素材，不得認證錯誤 Proxy bytes', async mode => {
    const { moved, reader, directory, wrongBytes, wrongMetadata, replace } =
      await replacePreviouslyVerifiedCache(mode, { defer: true });
    const accepted = reader.runtime.inspectCache(moved.source).find(hit => hit.dir === directory && !hit.error);
    const write = fs.writeFileSync, open = fsp.open;
    denyWriteHandles(directory);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (typeof file === 'string' && file.startsWith(directory + path.sep)) {
        throw Object.assign(new Error('shared cache read-only'), { code: 'EACCES' });
      }
      return write(file, ...args);
    });
    let swapped = false;
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      if (!swapped && file === accepted.meta.proxy) {
        swapped = true; replace();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write(file, wrongBytes);
      }
      return open(file, ...args);
    });
    const settled = await reader.runtime[mode](request(moved.source, [{ channels: 2 }]))
      .then(async result => { await result.completion; return { result }; }, error => ({ error }));
    expect(swapped).toBe(true);
    expect(settled.error).toBeInstanceOf(Error);
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
    expect(fs.readFileSync(accepted.meta.proxy)).toEqual(wrongBytes);
  });

  it.each(['ingest', 'stream'])('%s 唯讀複製期間原目錄物件的來源證據被換成他素材，仍須拒絕發布', async mode => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replacementDirectory } =
      await replacePreviouslyVerifiedCache(mode, { defer: true });
    const write = fs.writeFileSync, createWriteStream = fs.createWriteStream;
    denyWriteHandles(directory);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (typeof file === 'string' && file.startsWith(directory + path.sep)) {
        throw Object.assign(new Error('shared cache read-only'), { code: 'EACCES' });
      }
      return write(file, ...args);
    });
    let swapped = false;
    vi.spyOn(fs, 'createWriteStream').mockImplementation((file, ...args) => {
      if (!swapped && file.endsWith('proxy.mp4')) {
        swapped = true;
        const before = fs.statSync(directory, { bigint: true });
        fs.cpSync(replacementDirectory, directory, { recursive: true });
        const after = fs.statSync(directory, { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      }
      return createWriteStream(file, ...args);
    });
    const settled = await reader.runtime[mode](request(moved.source, [{ channels: 2 }]))
      .then(async result => { await result.completion; return { result }; }, error => ({ error }));
    expect(swapped).toBe(true);
    expect(settled.error).toBeInstanceOf(Error);
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
  });

  it.each(['ingest', 'stream'])('%s 本機 key 目錄被換成他素材快取，也必須驗證來源而非只信目錄名稱', async mode => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata } =
      await replacePreviouslyVerifiedCache(mode, { direct: true });
    const work = await reader.runtime[mode](request(moved.source, [{ channels: 1 }]));
    await work.completion;
    const result = work.response || work;
    expect(result.cached).toBe(false);
    expect(reader.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(JSON.parse(fs.readFileSync(metadata(result.proxy), 'utf8')).sourceContent.sha256)
      .toBe(crypto.createHash('sha256').update(fs.readFileSync(moved.source)).digest('hex'));
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
  });

  it.each(['ingest', 'stream'].flatMap(mode => [1, 3].map(boundary => ({ mode, boundary }))))
  ('$mode 候選讀取第$boundary個時點後才換內容，實際准入與新完成紀錄仍屬目前母素材', async ({ mode, boundary }) => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replace } =
      await replacePreviouslyVerifiedCache(mode, { defer: true });
    const metaPath = path.join(directory, 'meta.json'), read = fs.readFileSync;
    let reads = 0, swapped = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const result = read(file, ...args);
      if (file === metaPath && ++reads === boundary) { replace(); swapped = true; }
      return result;
    });
    const work = await reader.runtime[mode](request(moved.source, [{ channels: 1 }]));
    await work.completion;
    const result = work.response || work;
    expect(swapped).toBe(true);
    expect(result.cached).toBe(false);
    expect(reader.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(JSON.parse(fs.readFileSync(metadata(result.proxy), 'utf8')).sourceContent.sha256)
      .toBe(crypto.createHash('sha256').update(fs.readFileSync(moved.source)).digest('hex'));
    if (mode === 'stream') expect((await range(result.streamUrl)).bytes).toEqual(proxyBytes.subarray(0, 32));
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
  });

  it('候選讀取後才換內容，clearAll 不刪被換入的其他母素材', async () => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replace } =
      await replacePreviouslyVerifiedCache('ingest', { defer: true });
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const metaPath = path.join(directory, 'meta.json'), read = fs.readFileSync;
    let swapped = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const result = read(file, ...args);
      if (!swapped && file === metaPath) { replace(); swapped = true; }
      return result;
    });
    reader.runtime.clearAll(moved.source);
    expect(swapped).toBe(true);
    expect(fs.existsSync(wrongProxy)).toBe(true);
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
  });

  it.each([false, true])('clearAll 原子取得目錄時才換內容，新原路徑已建立=%s，不刪也不覆蓋其他 writer', async recreated => {
    const { saved, moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replace } =
      await replacePreviouslyVerifiedCache('ingest', { defer: true });
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const rename = fs.renameSync;
    let claimed;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to, ...args) => {
      if (!claimed && from === directory && path.basename(to).startsWith('.subtool-clear-')) {
        replace();
        claimed = to;
        const result = rename(from, to, ...args);
        if (recreated) fs.cpSync(directory + '-previous', directory, { recursive: true });
        return result;
      }
      return rename(from, to, ...args);
    });
    expect(reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0 });
    expect(claimed).toBeTruthy();
    const retained = recreated ? claimed : directory;
    expect(fs.readFileSync(path.join(retained, path.relative(directory, wrongProxy)))).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(retained, 'meta.json'))).toEqual(wrongMetadata);
    if (recreated) {
      const originalProxy = path.join(directory, path.relative(cacheDir(saved.proxy), saved.proxy));
      expect(fs.readFileSync(originalProxy)).toEqual(proxyBytes);
    } else expect(fs.existsSync(claimed)).toBe(false);
  });

  it('clearAll 取得正確目錄後刪除失敗，還原原位置而非遺留失效的快取路徑', async () => {
    const { saved, moved, reader, directory } = await replacePreviouslyVerifiedCache('ingest', { defer: true });
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const remove = fs.rmSync;
    let attempted = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((file, ...args) => {
      if (path.basename(file).startsWith('.subtool-clear-')) {
        attempted = true;
        throw Object.assign(new Error('temporary cache removal failure'), { code: 'EACCES' });
      }
      return remove(file, ...args);
    });
    expect(reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0 });
    expect(attempted).toBe(true);
    expect(fs.readFileSync(path.join(directory, path.relative(cacheDir(saved.proxy), saved.proxy)))).toEqual(proxyBytes);
    expect(fs.readdirSync(path.dirname(directory)).filter(name => name.startsWith('.subtool-clear-'))).toEqual([]);
  });

  it('clearAll 已准入舊格式後，同目錄物件換成有來源證據的新內容，仍須保留新內容', async () => {
    const { saved, moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replacementDirectory } =
      await replacePreviouslyVerifiedCache('ingest', { direct: true, defer: true });
    const legacy = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'));
    for (const field of ['sourceContent', 'sourceKeys', 'publicationVersion', 'artifactSizes']) delete legacy[field];
    fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify(legacy));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    expect(reader.runtime.inspectCache(moved.source).find(hit => !hit.error).sourceContent).toBeNull();
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const rename = fs.renameSync;
    let replaced = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to, ...args) => {
      const result = rename(from, to, ...args);
      if (!replaced && from === directory && path.basename(to).startsWith('.subtool-clear-')) {
        replaced = true;
        const before = fs.statSync(to, { bigint: true });
        fs.cpSync(replacementDirectory, to, { recursive: true });
        const after = fs.statSync(to, { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      }
      return result;
    });
    expect(reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0 });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
  });

  it.each(['ingest', 'stream'])('%s 同母素材完整快取被改放本機 key 目錄時，全文驗證後仍重用原 bytes', async mode => {
    const original = fixture(), producer = runtimeFor(original.root, 'profile-A');
    const saved = await producer.runtime.ingest(request(original.source, [{ channels: 1 }]));
    const moved = transfer(original), previous = path.join(moved.media, '.subtool_Cache', path.basename(cacheDir(saved.proxy)));
    const renamed = path.join(moved.media, '.subtool_Cache', cacheKeyFor(moved.source));
    fs.renameSync(previous, renamed);
    const reader = runtimeFor(original.root, 'profile-B');
    const work = await reader.runtime[mode](request(moved.source, [{ channels: 1 }]));
    expect(work.cached).toBe(true);
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(work.proxy)).toEqual(proxyBytes);
    expect(reader.runtime.inspectCache(moved.source).find(hit => !hit.error).sourceKeys).toContain(cacheKeyFor(moved.source));
  });

  it.each(['ingest', 'stream'])('%s 已驗證的共用目錄遭換成另一母素材快取時，不能沿用舊路徑資格', async mode => {
    const { original, saved, moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata } =
      await replacePreviouslyVerifiedCache(mode);
    const work = await reader.runtime[mode](request(moved.source, [{ channels: 1 }]));
    await work.completion;
    const result = work.response || work;
    expect(result.cached).toBe(false);
    expect(reader.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(result.channels.map(channel => fs.readFileSync(channel.file)))
      .toEqual(saved.channels.map(channel => fs.readFileSync(channel.file)));
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
    expect(cacheKeyFor(moved.source)).not.toBe(cacheKeyFor(original.source));
  });

  it.each(['ingest', 'stream'])('%s 共用目錄換成另一母素材後，清目前素材不刪除舊映射的新內容', async mode => {
    const { moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata } = await replacePreviouslyVerifiedCache(mode);
    reader.authority.grantTrustedFile(moved.source, { read: true });
    reader.runtime.clearAll(moved.source);
    expect(fs.existsSync(wrongProxy)).toBe(true);
    expect(fs.readFileSync(wrongProxy)).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(directory, 'meta.json'))).toEqual(wrongMetadata);
  });

  it('共用 metadata 暫時讀不到時清理不刪內容，恢復後仍使用本工作階段已驗證的映射', async () => {
    const original = fixture(), producer = runtimeFor(original.root, 'profile-A');
    const saved = await producer.runtime.ingest(request(original.source));
    const moved = transfer(original), reader = runtimeFor(original.root, 'profile-B');
    const directory = path.join(moved.media, '.subtool_Cache', path.basename(cacheDir(saved.proxy)));
    const write = fs.writeFileSync;
    const bindingFailure = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (typeof file === 'string' && file.startsWith(directory + path.sep)
        && path.basename(file).startsWith('source-')) throw Object.assign(new Error('read-only binding'), { code: 'EACCES' });
      return write(file, ...args);
    });
    const warm = await reader.runtime.ingest(request(moved.source));
    bindingFailure.mockRestore();
    expect(warm.cached).toBe(true);
    expect(fs.existsSync(path.join(directory, 'source-' + cacheKeyFor(moved.source) + '.json'))).toBe(false);
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const readdir = fs.readdirSync;
    const temporaryFailure = vi.spyOn(fs, 'readdirSync').mockImplementation((file, ...args) => {
      if (file === directory) throw Object.assign(new Error('temporary metadata read failure'), { code: 'EIO' });
      return readdir(file, ...args);
    });
    reader.runtime.clearAll(moved.source);
    temporaryFailure.mockRestore();
    expect(fs.readFileSync(warm.proxy)).toEqual(proxyBytes);
    const open = fsp.open;
    const reopen = vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      if (file === moved.source) throw new Error('the verified source must not be rehashed');
      return open(file, ...args);
    });
    expect(await reader.runtime.ingest(request(moved.source))).toEqual({ ...warm, cached: true });
    expect(reopen.mock.calls.filter(([file]) => file === moved.source)).toHaveLength(0);
    expect(reader.run).not.toHaveBeenCalled();
  });

  it.each(['ingest', 'stream'])('%s 另一台電腦清除目前素材快取時仍辨識原 key，播放 lease 結束才可移除', async mode => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const second = runtimeFor(original.root, 'profile-B');
    second.authority.grantTrustedFile(moved.source, { read: true });
    const reused = await second.runtime[mode](request(moved.source));
    expect(reused.cached).toBe(true);
    if (mode === 'stream') {
      second.runtime.clearAll(moved.source);
      expect(fs.readFileSync(reused.proxy)).toEqual(proxyBytes);
      expect(second.runtime.releaseStream(reused.streamLeaseId)).toBe(true);
    }
    second.runtime.clearAll(moved.source);
    expect(fs.existsSync(reused.proxy)).toBe(false);
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
  });
  it.each(['ingest', 'stream'])('%s 換路徑、檔案身分及 profile 後仍直接使用同一份完整快取', async mode => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source, [{ channels: 1 }]));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    expect(stored.sourceContent).toEqual({ format: 'source-v3-sha256', size: fs.statSync(original.source).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(original.source)).digest('hex') });
    expect(stored.sourceKeys).toContain(cacheKeyFor(original.source));
    const moved = transfer(original);
    expect(cacheKeyFor(moved.source)).not.toBe(cacheKeyFor(original.source));
    const second = runtimeFor(original.root, 'profile-B');
    const result = await second.runtime[mode](request(moved.source, [{ channels: 1 }]));
    const expectedProxy = path.join(moved.media, path.relative(original.media, saved.proxy));
    expect(result.cached).toBe(true);
    expect(result.proxy).toBe(expectedProxy);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(result.channels).toHaveLength(1);
    expect(second.run).not.toHaveBeenCalled();
    expect(second.authority.canRead(result.proxy)).toBe(true);
    expect(fs.existsSync(path.join(moved.media, '.subtool_Cache', cacheKeyFor(moved.source)))).toBe(false);
    if (mode === 'stream') {
      expect(await range(result.streamUrl)).toEqual({ status: 206, bytes: proxyBytes.subarray(0, 32) });
      expect(second.runtime.releaseStream(result.streamLeaseId)).toBe(true);
    }
  });

  it('同一共享資料夾的另一個路徑別名不另建 Proxy 或搬動已完成產物', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const alias = path.join(original.media, 'same-content-another-name.mxf');
    fs.copyFileSync(original.source, alias);
    const second = runtimeFor(original.root, 'profile-B');
    const reused = await second.runtime.ingest(request(alias));
    expect(reused).toEqual({ ...saved, cached: true });
    expect(second.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
  });

  it('既有本機 v3 快取補入跨機識別，不重新轉檔或改寫 Proxy bytes', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    delete stored.sourceContent; delete stored.sourceKeys;
    fs.writeFileSync(metadata(saved.proxy), JSON.stringify(stored));
    const reopened = runtimeFor(original.root, 'profile-A-reopened');
    expect(await reopened.runtime.ingest(request(original.source))).toEqual({ ...saved, cached: true });
    expect(reopened.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
    expect(reopened.runtime.inspectCache(original.source).find(hit => !hit.error).sourceContent)
      .toMatchObject({ format: 'source-v3-sha256' });
    const moved = transfer(original);
    const other = runtimeFor(original.root, 'profile-B');
    expect(await other.runtime.ingest(request(moved.source))).toMatchObject({ cached: true });
    expect(other.run).not.toHaveBeenCalled();
  });

  it('跨機舊快取沒有可驗證的母素材證據時，不按同檔名或大小猜用', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    delete stored.sourceContent; delete stored.sourceKeys;
    fs.writeFileSync(metadata(saved.proxy), JSON.stringify(stored));
    const moved = transfer(original);
    const second = runtimeFor(original.root, 'profile-B');
    expect(await second.runtime.ingest(request(moved.source))).toMatchObject({ cached: false });
    expect(second.run).toHaveBeenCalledOnce();
  });

  it('只修改前中尾取樣以外的同大小內容，也不能重用另一份母素材 Proxy', async () => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 17));
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const handle = fs.openSync(moved.source, 'r+');
    try { fs.writeSync(handle, Buffer.from([18]), 0, 1, 1280 * 1024); } finally { fs.closeSync(handle); }
    expect(fs.statSync(moved.source).size).toBe(fs.statSync(original.source).size);
    const second = runtimeFor(original.root, 'profile-B');
    const rebuilt = await second.runtime.ingest(request(moved.source));
    expect(rebuilt.cached).toBe(false);
    expect(second.run).toHaveBeenCalledOnce();
    expect(rebuilt.proxy).not.toBe(path.join(moved.media, path.relative(original.media, saved.proxy)));
  });

  it('共用 metadata 無法寫入仍沿用已驗證 Proxy，不為記錄本機身分重新轉檔', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const expectedProxy = path.join(moved.media, path.relative(original.media, saved.proxy));
    const sharedDir = cacheDir(expectedProxy);
    denyWriteHandles(sharedDir);
    const originalWrite = fs.writeFileSync, originalAsyncWrite = fsp.writeFile;
    const deny = file => typeof file === 'string' && path.resolve(file).startsWith(sharedDir + path.sep);
    const denied = () => Object.assign(new Error('shared cache is read-only'), { code: 'EACCES' });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (deny(file)) throw denied(); return originalWrite(file, ...args);
    });
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...args) => {
      if (deny(file)) throw denied(); return originalAsyncWrite(file, ...args);
    });
    const second = runtimeFor(original.root, 'profile-B');
    expect(await second.runtime.ingest(request(moved.source))).toMatchObject({ cached: true, proxy: expectedProxy });
    expect(second.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(expectedProxy)).toEqual(proxyBytes);
  });

  it('跨機缺少音訊時只補聲道及波形，保留原 Proxy 與其內容', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const second = runtimeFor(original.root, 'profile-B');
    const repaired = await second.runtime.ingest(request(moved.source, [{ channels: 2 }]));
    expect(repaired.cached).toBe(false);
    expect(second.run).toHaveBeenCalledOnce();
    expect(outputsOf(second.run.mock.calls[0][0]).some(output => output.endsWith('proxy.mp4'))).toBe(false);
    expect(repaired.proxy).toBe(path.join(moved.media, path.relative(original.media, saved.proxy)));
    expect(fs.readFileSync(repaired.proxy)).toEqual(proxyBytes);
    expect(repaired.channels).toHaveLength(2);
    expect(await second.runtime.ingest(request(moved.source, [{ channels: 2 }]))).toEqual({ ...repaired, cached: true });
    expect(second.run).toHaveBeenCalledOnce();
  });

  it.each(['proxy', 'wave', 'channel'].flatMap(component => [false, true].map(legacy => [component, legacy])))
  ('跨機 %s 只複製到部分非空 bytes 時，只重建該損缺元件（混用弱索引=%s）', async (component, legacy) => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source, [{ channels: 2 }]));
    const moved = transfer(original);
    const mapped = file => path.join(moved.media, path.relative(original.media, file));
    const target = mapped(component === 'channel' ? saved.channels[0].file : saved[component]);
    const kept = [saved.proxy, saved.wave, ...saved.channels.map(channel => channel.file)].map(mapped)
      .filter(file => file !== target);
    const keptBytes = kept.map(file => fs.readFileSync(file));
    fs.truncateSync(target, 2);
    if (legacy) {
      const metaPath = metadata(mapped(saved.proxy)), raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      delete raw.artifactSizes;
      fs.writeFileSync(metaPath, JSON.stringify(raw));
      const weakGeneration = path.join(cacheDir(mapped(saved.proxy)), 'generation-' + crypto.randomBytes(12).toString('hex'));
      fs.mkdirSync(weakGeneration);
      fs.writeFileSync(path.join(weakGeneration, 'cache-meta.json'), JSON.stringify(raw));
    }
    const second = runtimeFor(original.root, 'profile-B');
    const repaired = await second.runtime.ingest(request(moved.source, [{ channels: 2 }]));
    expect(repaired.cached).toBe(false);
    expect(second.run).toHaveBeenCalledOnce();
    expect(outputsOf(second.run.mock.calls[0][0]).map(file => path.basename(file))).toEqual([path.basename(target)]);
    expect(kept.map(file => fs.readFileSync(file))).toEqual(keptBytes);
    for (const file of kept) expect([repaired.proxy, repaired.wave, ...repaired.channels.map(channel => channel.file)]).toContain(file);
    expect(fs.readFileSync(component === 'channel' ? repaired.channels[0].file : repaired[component]))
      .toEqual(component === 'proxy' ? proxyBytes : Buffer.from('complete source channel'));
  });

  it.each(['ingest', 'stream'])('%s 較晚完成的 Proxy writer 不得遺失另一 profile 已提交的完整音訊', async mode => {
    const original = fixture();
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const completionGate = new Promise(resolve => { finish = resolve; });
    const first = runtimeFor(original.root, 'profile-A', { execute: async args => {
      for (const output of outputsOf(args)) fs.writeFileSync(output, proxyBytes);
      entered();
      await completionGate;
    } });
    const fullRequest = request(original.source, [{ channels: 2 }]);
    const firstWork = first.runtime[mode](request(original.source));
    try {
      await started;
      const second = runtimeFor(original.root, 'profile-B');
      const complete = await second.runtime.ingest(fullRequest);
      expect(complete.channels).toHaveLength(2);
      const audioBytes = complete.channels.map(channel => fs.readFileSync(channel.file));
      const waveBytes = fs.readFileSync(complete.wave);
      finish();
      const settled = await firstWork;
      await settled.completion;
      const reopened = runtimeFor(original.root, 'profile-C');
      const reused = await reopened.runtime.ingest(fullRequest);
      expect(reused.cached).toBe(true);
      expect(reopened.run).not.toHaveBeenCalled();
      expect(fs.readFileSync(reused.proxy)).toEqual(proxyBytes);
      expect(reused.channels.map(channel => fs.readFileSync(channel.file))).toEqual(audioBytes);
      expect(fs.readFileSync(reused.wave)).toEqual(waveBytes);
    } finally {
      finish();
      const settled = await firstWork;
      await settled.completion;
    }
  });

  it('跨行程補記可攜身分時，不得覆寫另一行程剛補齊的音訊 metadata', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const alias = path.join(original.media, 'shared-alias.mxf');
    fs.copyFileSync(original.source, alias);
    const aliasKey = cacheKeyFor(alias), metaPath = metadata(saved.proxy);
    const write = fs.writeFileSync;
    let interleaved = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, ...args) => {
      if (!interleaved && typeof file === 'string'
        && ((file.startsWith(metaPath + '.tmp-') && JSON.parse(bytes).sourceKeys?.includes(aliasKey))
          || (file.startsWith(path.join(cacheDir(saved.proxy), 'source-' + aliasKey + '.json.tmp-'))
            && JSON.parse(bytes).sourceKey === aliasKey))) {
        interleaved = true;
        expect(siblingIntake(original.root, original.source).channels).toHaveLength(2);
      }
      return write(file, bytes, ...args);
    });
    const second = runtimeFor(original.root, 'profile-B');
    expect(await second.runtime.ingest(request(alias))).toMatchObject({ cached: true, proxy: saved.proxy });
    expect(interleaved).toBe(true);
    const reopened = runtimeFor(original.root, 'profile-C');
    const reused = await reopened.runtime.ingest(request(original.source, [{ channels: 2 }]));
    expect(reused.cached).toBe(true);
    expect(reopened.run).not.toHaveBeenCalled();
    expect(reused.channels.map(channel => fs.readFileSync(channel.file))).toEqual([
      Buffer.alloc(131072, 49), Buffer.alloc(131072, 49),
    ]);
    expect(fs.readFileSync(reused.wave)).toEqual(Buffer.alloc(131072, 49));
    expect(reopened.runtime.inspectCache(original.source).find(hit => !hit.error).sourceKeys).toContain(aliasKey);
  });

  it.each(['publication', 'index'])('跨行程在 %s 暫存與 rename 之間提交音訊，舊索引仍不能遮住完成紀錄', async point => {
    const original = fixture();
    const metaPath = path.join(original.media, '.subtool_Cache', cacheKeyFor(original.source), 'meta.json');
    const rename = fs.renameSync;
    let interleaved = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((file, destination, ...args) => {
      if (!interleaved && (point === 'index' ? destination === metaPath : path.basename(destination) === 'cache-meta.json')) {
        interleaved = true;
        const completed = siblingIntake(original.root, original.source);
        expect(completed.encodingOutputs).toHaveLength(point === 'index' ? 3 : 4);
        expect(completed.encodingOutputs.some(output => output.endsWith('proxy.mp4'))).toBe(point === 'publication');
      }
      return rename(file, destination, ...args);
    });
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    expect(interleaved).toBe(true);
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).channels).toEqual([]);
    const reopened = runtimeFor(original.root, 'profile-B');
    const reused = await reopened.runtime.ingest(request(original.source, [{ channels: 2 }]));
    expect(reused.cached).toBe(true);
    expect(reopened.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(reused.proxy)).toEqual(fs.readFileSync(saved.proxy));
    expect(reused.channels.map(channel => fs.readFileSync(channel.file))).toEqual([
      Buffer.alloc(131072, 49), Buffer.alloc(131072, 49),
    ]);
    expect(fs.readFileSync(reused.wave)).toEqual(Buffer.alloc(131072, 49));
  });

  it.each(['write', 'rename'])('相容索引 %s 失敗仍保留真正完成紀錄、bytes 與孤兒清理資格', async failure => {
    const original = fixture();
    const metaPath = path.join(original.media, '.subtool_Cache', cacheKeyFor(original.source), 'meta.json');
    const method = failure === 'write' ? 'writeFileSync' : 'renameSync', native = fs[method];
    vi.spyOn(fs, method).mockImplementation((file, ...args) => {
      if (String(file).startsWith(metaPath + '.tmp-')) throw new Error('compatibility index unavailable');
      return native(file, ...args);
    });
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source, [{ channels: 2 }]));
    expect(fs.existsSync(metaPath)).toBe(false);
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
    expect(fs.existsSync(path.join(path.dirname(saved.channels[0].file), 'cache-meta.json'))).toBe(true);
    const moved = transfer(original);
    const second = runtimeFor(original.root, 'profile-B');
    const reused = await second.runtime.ingest(request(moved.source, [{ channels: 2 }]));
    expect(reused.cached).toBe(true);
    expect(second.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(reused.proxy)).toEqual(proxyBytes);
    const local = runtimeFor(original.root, 'profile-C', { allowSidecarCache: false });
    const localCopy = path.join(local.cacheRoot, cacheKeyFor(original.source));
    fs.mkdirSync(path.dirname(localCopy), { recursive: true });
    fs.cpSync(cacheDir(saved.proxy), localCopy, { recursive: true });
    expect(local.runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0 });
    const restored = await local.runtime.ingest(request(original.source, [{ channels: 2 }]));
    expect(restored.cached).toBe(true);
    expect(local.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(restored.proxy)).toEqual(proxyBytes);
  });

  it.each(['ingest', 'stream'])('%s runtime 已關閉後 writer 才完成，不得發布 generation 或相容索引', async mode => {
    const original = fixture();
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const first = runtimeFor(original.root, 'profile-A', { execute: async args => {
      for (const output of outputsOf(args)) fs.writeFileSync(output, proxyBytes);
      entered(); await gate;
    } });
    const work = first.runtime[mode](request(original.source)).then(result => ({ result }), error => ({ error }));
    try {
      await started;
      await first.runtime.close();
      finish();
      const settled = await work;
      await settled.result?.completion;
      if (mode === 'ingest') expect(settled.error?.code).toBe('INGEST_SUPERSEDED');
      const dir = path.join(original.media, '.subtool_Cache', cacheKeyFor(original.source));
      expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(false);
      expect(fs.readdirSync(dir).filter(name => name.startsWith('generation-'))).toEqual([]);
    } finally { finish(); await work; }
  });

  it.each(['ingest', 'stream'])('%s 共享快取唯讀且只有 Proxy 時，只在可寫本機位置補缺音訊，不重新編碼影片', async mode => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const sharedRoot = path.join(moved.media, '.subtool_Cache');
    const sharedProxy = path.join(moved.media, path.relative(original.media, saved.proxy));
    denyWriteHandles(sharedRoot);
    const sharedMeta = fs.readFileSync(metadata(sharedProxy));
    const originalWrite = fs.writeFileSync, originalAsyncWrite = fsp.writeFile;
    const deny = file => typeof file === 'string' && path.resolve(file).startsWith(sharedRoot + path.sep);
    const denied = () => Object.assign(new Error('shared cache is read-only'), { code: 'EACCES' });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (deny(file)) throw denied(); return originalWrite(file, ...args);
    });
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...args) => {
      if (deny(file)) throw denied(); return originalAsyncWrite(file, ...args);
    });
    const second = runtimeFor(original.root, 'profile-B');
    const work = await second.runtime[mode](request(moved.source, [{ channels: 2 }]));
    await work.completion;
    const repaired = work.response || work;
    expect(second.run).toHaveBeenCalledOnce();
    expect(outputsOf(second.run.mock.calls[0][0]).some(output => output.endsWith('proxy.mp4'))).toBe(false);
    expect(fs.readFileSync(sharedProxy)).toEqual(proxyBytes);
    expect(fs.readFileSync(metadata(sharedProxy))).toEqual(sharedMeta);
    expect(fs.readFileSync(repaired.proxy)).toEqual(proxyBytes);
    expect(repaired.channels).toHaveLength(2);
    for (const channel of repaired.channels) {
      expect(fs.readFileSync(channel.file).length).toBeGreaterThan(0);
      expect(path.relative(second.cacheRoot, channel.file)).not.toMatch(/^\.\./);
    }
    const reopened = runtimeFor(original.root, 'profile-B');
    expect(await reopened.runtime.ingest(request(moved.source, [{ channels: 2 }]))).toMatchObject({
      cached: true, proxy: repaired.proxy, channels: repaired.channels, wave: repaired.wave,
    });
    expect(reopened.run).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'changed'])('跨機內容驗證期間 %s 不得啟動轉檔、發布舊快取或留下新 metadata', async action => {
    const original = fixture(Buffer.alloc(2 * 1024 * 1024, 21));
    const first = runtimeFor(original.root, 'profile-A');
    await first.runtime.ingest(request(original.source));
    const moved = transfer(original);
    const second = runtimeFor(original.root, 'profile-B');
    let release, entered = false, revoked = false;
    const gate = new Promise(resolve => { release = resolve; });
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.resolve(file) === moved.source) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          if (!entered) { entered = true; await gate; }
          return read(...readArgs);
        };
      }
      return handle;
    });
    const outcome = second.runtime.ingest(request(moved.source), { isCancelled: () => revoked })
      .then(result => ({ result }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1000 });
      if (action === 'cancel') revoked = true;
      else fs.writeFileSync(moved.source, Buffer.alloc(2 * 1024 * 1024, 22));
      release();
      const settled = await outcome;
      expect(settled.error).toBeInstanceOf(Error);
      expect(settled.error.message).toMatch(action === 'cancel' ? /取代|取消/ : /變更/);
      expect(second.run).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(moved.media, '.subtool_Cache', cacheKeyFor(moved.source), 'meta.json'))).toBe(false);
    } finally { release(); await outcome; }
  });
});

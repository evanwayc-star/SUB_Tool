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
function removeSourceReceipts(directory) {
  for (const name of fs.readdirSync(directory)) if (/^source-[a-f0-9]{16}\.json$/.test(name))
    fs.unlinkSync(path.join(directory, name));
}

function fixture(bytes = Buffer.from('unchanged original mother source')) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-portable-intake-'));
  roots.push(root);
  const media = path.join(root, 'computer-A', 'media');
  fs.mkdirSync(media, { recursive: true });
  const source = path.join(media, 'mother.mxf');
  fs.writeFileSync(source, bytes);
  return { root, media, source };
}

function runtimeFor(root, profile, { execute, allowSidecarCache = true, sendProgress, describeAudio, describeVideo } = {}) {
  const cacheRoot = path.join(root, profile, 'mediacache');
  const tempRoot = path.join(root, profile, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  const run = vi.fn(execute || (async args => {
    for (const output of outputsOf(args)) fs.writeFileSync(output,
      output.endsWith('proxy.mp4') ? proxyBytes : Buffer.from('complete source channel'));
  }));
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot,
    fileAuthority: authority, allowSidecarCache, sendProgress, describeAudio, describeVideo, delay: async () => {}, ffmpegExecution: { execute: run } });
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
  it.each(['missing-stream', 'missing-channel', 'empty', 'duplicate', 'stream-gap'].flatMap(layout =>
    [false, true].map(versioned => ({ layout, versioned }))))
  ('未知或不完整 layout=$layout、已有版本=$versioned 的波形不隨 Proxy-only 補建取得新規格', async ({ layout, versioned }) => {
    const original = fixture(), audio = [{ channels: 2 }, { channels: 1 }];
    const producer = runtimeFor(original.root, 'ambiguous-wave-producer');
    const saved = await producer.runtime.ingest(request(original.source, audio));
    const oldWave = fs.readFileSync(saved.wave), oldProxy = fs.readFileSync(saved.proxy);
    const oldChannels = saved.channels.map(channel => fs.readFileSync(channel.file));
    for (const file of [metadata(saved.wave), path.join(path.dirname(saved.wave), 'cache-meta.json')]) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!versioned) delete raw.waveMixVersion;
      if (layout === 'missing-stream') raw.channels.forEach(channel => { delete channel.sourceStream; });
      if (layout === 'missing-channel') raw.channels.forEach(channel => { delete channel.sourceChannel; });
      if (layout === 'empty') raw.channels = [];
      if (layout === 'duplicate') raw.channels[1].sourceChannel = 0;
      if (layout === 'stream-gap') raw.channels[2].sourceStream = 2;
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    const reader = runtimeFor(original.root, 'ambiguous-wave-reader', {
      describeVideo: async () => ({ width: 320, height: 180 }),
    });
    // Old proxy has no color version, forcing the real proxy-only publication.
    const proxyOnly = await reader.runtime.ingest(request(original.source));
    expect(proxyOnly.cached).toBe(false);
    expect(proxyOnly.wave).toBeNull();
    expect(proxyOnly.proxy).not.toBe(saved.proxy);
    const publication = JSON.parse(fs.readFileSync(metadata(proxyOnly.proxy), 'utf8'));
    expect(publication.wave).toBeNull();
    expect(publication).not.toHaveProperty('waveMixVersion');
    expect(fs.readFileSync(saved.wave)).toEqual(oldWave);
    expect(fs.readFileSync(saved.proxy)).toEqual(oldProxy);
    expect(saved.channels.map(channel => fs.readFileSync(channel.file))).toEqual(oldChannels);
    const normal = await reader.runtime.ingest(request(original.source, audio));
    expect(normal.wave).not.toBe(saved.wave);
    expect(JSON.parse(fs.readFileSync(metadata(normal.wave), 'utf8')).waveMixVersion).toBe(1);
  });
  it('不完整的舊 index 不會污染另一份具完整 layout 的新波形 publication', async () => {
    const original = fixture(), audio = [{ channels: 2 }, { channels: 1 }];
    const producer = runtimeFor(original.root, 'mixed-publication-producer');
    const saved = await producer.runtime.ingest(request(original.source, audio));
    const index = metadata(saved.wave), raw = JSON.parse(fs.readFileSync(index, 'utf8'));
    delete raw.waveMixVersion;
    raw.channels.forEach(channel => { delete channel.sourceStream; });
    fs.writeFileSync(index, JSON.stringify(raw));
    const reader = runtimeFor(original.root, 'mixed-publication-reader');
    const wave = await reader.runtime.waveform({ src: original.source, duration: 1, audio });
    expect(wave).toMatchObject({ cached: true, temporary: false, wave: saved.wave });
    expect(reader.run).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(index, 'utf8'))).toEqual(raw);
  });
  it('多 stream 舊波形規格不再沿用；保留 Proxy 與逐聲道並只補建波形', async () => {
    const original = fixture(), audio = [{ channels: 2 }, { channels: 1 }];
    const producer = runtimeFor(original.root, 'legacy-mix-producer');
    const saved = await producer.runtime.ingest(request(original.source, audio));
    const oldWave = fs.readFileSync(saved.wave), oldProxy = fs.readFileSync(saved.proxy);
    const oldChannels = saved.channels.map(channel => fs.readFileSync(channel.file));
    for (const file of [metadata(saved.wave), path.join(path.dirname(saved.wave), 'cache-meta.json')]) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.waveMixVersion;
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    const reader = runtimeFor(original.root, 'legacy-mix-reader', { execute: async (args, options = {}) => {
      if (typeof options.outputDescriptor === 'number') fs.writeSync(options.outputDescriptor, Buffer.from('correct provisional mix'));
      else for (const output of outputsOf(args)) fs.writeFileSync(output, Buffer.from('correct permanent mix'));
    } });
    const provisional = await reader.runtime.waveform({ src: original.source, duration: 1, audio });
    expect(provisional).toMatchObject({ cached: false, temporary: true });
    expect(fs.readFileSync(provisional.wave, 'utf8')).toBe('correct provisional mix');
    reader.run.mockClear();
    const refreshed = await reader.runtime.ingest(request(original.source, audio));
    expect(refreshed.cached).toBe(false);
    expect(refreshed.proxy).toBe(saved.proxy);
    expect(refreshed.channels.map(channel => channel.file)).toEqual(saved.channels.map(channel => channel.file));
    expect(refreshed.wave).not.toBe(saved.wave);
    expect(outputsOf(reader.run.mock.calls[0][0])).toEqual([refreshed.wave]);
    expect(fs.readFileSync(saved.proxy)).toEqual(oldProxy);
    expect(saved.channels.map(channel => fs.readFileSync(channel.file))).toEqual(oldChannels);
    expect(fs.readFileSync(saved.wave)).toEqual(oldWave);
    expect(JSON.parse(fs.readFileSync(metadata(refreshed.wave), 'utf8')).waveMixVersion).toBe(1);
    const repeat = await reader.runtime.ingest(request(original.source, audio));
    expect(repeat.cached).toBe(true);
    expect(repeat.wave).toBe(refreshed.wave);
  });
  it('獨立波形直接沿用嚴格本機舊 wave，不等待缺少的 Proxy、聲道或 portable SHA', async () => {
    const original = fixture(), producer = runtimeFor(original.root, 'wave-producer');
    const saved = await producer.runtime.ingest(request(original.source, [{ channels: 2 }]));
    fs.unlinkSync(saved.proxy);
    for (const channel of saved.channels) fs.unlinkSync(channel.file);
    fs.unlinkSync(path.join(path.dirname(saved.wave), 'cache-meta.json'));
    const raw = JSON.parse(fs.readFileSync(metadata(saved.wave), 'utf8'));
    delete raw.sourceContent; delete raw.sourceKeys; delete raw.waveMixVersion;
    removeSourceReceipts(cacheDir(saved.wave));
    const originalMetadata = JSON.stringify(raw);
    fs.writeFileSync(metadata(saved.wave), originalMetadata);
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (file === original.source) throw new Error('波形不得等待母素材全文 SHA');
      return open(file, ...args);
    });
    const reader = runtimeFor(original.root, 'wave-reader');
    await expect(reader.runtime.waveform(request(original.source, [{ channels: 2 }]))).resolves.toMatchObject({
      wave: saved.wave, cached: true, temporary: false, channels: [],
    });
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(metadata(saved.wave), 'utf8')).toBe(originalMetadata);
  });

  it('跨機未驗證的 wave 不可猜用；獨立波形直接解母素材而不讀全文 SHA 或修改 portable 證據', async () => {
    const original = fixture(), producer = runtimeFor(original.root, 'wave-producer');
    const saved = await producer.runtime.ingest(request(original.source, [{ channels: 2 }, { channels: 1 }]));
    const moved = transfer(original);
    const movedMetadata = path.join(moved.media, path.relative(original.media, metadata(saved.wave)));
    const before = fs.readFileSync(movedMetadata);
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (file === moved.source) throw new Error('波形不得等待跨機全文 SHA');
      return open(file, ...args);
    });
    const progress = [];
    const reader = runtimeFor(original.root, 'wave-reader', { sendProgress: (_target, payload) => progress.push(payload),
      execute: async (args, options) => {
        options.onProgress({ pct: 25 });
        fs.writeSync(options.outputDescriptor, Buffer.from('fresh source wave'));
      } });
    const result = await reader.runtime.waveform(request(moved.source, [{ channels: 2 }, { channels: 1 }]), {
      owner: { sender: {}, sessionId: 'wave-session', requestId: 'wave-request' },
    });
    expect(result).toMatchObject({ cached: false, temporary: true, channels: [] });
    expect(fs.readFileSync(result.wave, 'utf8')).toBe('fresh source wave');
    expect(result.wave).toContain(path.join('wave-reader', 'tmp'));
    expect(reader.runtime.isPreviewCacheMedia(result.wave)).toBe(true);
    expect(reader.run).toHaveBeenCalledOnce();
    const args = reader.run.mock.calls[0][0], filters = args[args.indexOf('-filter_complex') + 1];
    expect(args[args.indexOf('-i') + 1]).toBe(moved.source);
    expect(args).not.toContain('-c:v'); expect(args).not.toContain('aac');
    expect(filters).toContain('amix=inputs=2:normalize=0');
    expect(filters).not.toContain('asplit'); expect(filters).not.toContain('[co');
    expect(args.slice(-3)).toEqual(['-f', 'wav', 'fd:']);
    expect(reader.run.mock.calls[0][1].outputDescriptor).toEqual(expect.any(Number));
    expect(fs.readFileSync(movedMetadata)).toEqual(before);
    expect(progress).toContainEqual(expect.objectContaining({ stage: 'source-waveform', pct: 25,
      sessionId: 'wave-session', requestId: 'wave-request', label: '優先產生波形' }));
    expect(progress.at(-1)).toMatchObject({ stage: 'source-waveform', pct: 100, done: true, outcome: 'success' });
  });

  it.each(['cancel', 'source-change', 'empty', 'foreign-output'])('獨立波形 %s 不可交付完成內容，僅清理本工作暫存', async action => {
    const original = fixture();
    let output, revoked = false, moved;
    const reader = runtimeFor(original.root, 'wave-reader', { execute: async (_args, options) => {
      const temp = path.join(original.root, 'wave-reader', 'tmp');
      output = path.join(temp, fs.readdirSync(temp)[0]);
      if (action !== 'empty') fs.writeSync(options.outputDescriptor, Buffer.from('owned wave'));
      if (action === 'cancel') revoked = true;
      if (action === 'source-change') fs.writeFileSync(original.source, 'different source bytes');
      if (action === 'foreign-output') {
        moved = output + '.owned'; fs.renameSync(output, moved); fs.writeFileSync(output, 'foreign wave');
      }
    } });
    await expect(reader.runtime.waveform(request(original.source, [{ channels: 2 }]), { isCancelled: () => revoked })).rejects.toThrow();
    if (action === 'foreign-output') {
      expect(fs.readFileSync(output, 'utf8')).toBe('foreign wave');
      expect(fs.readFileSync(moved, 'utf8')).toBe('owned wave');
    } else expect(fs.existsSync(output)).toBe(false);
  });

  it('分段波形依目前母素材 probe 的來源時鐘定位，百分比對齊全來源並帶來源證據', async () => {
    const original = fixture(), progress = [];
    const reader = runtimeFor(original.root, 'wave-segment', {
      describeAudio: async () => [{ channels: 1, timestampOffset: -5 }],
      sendProgress: (_target, payload) => progress.push(payload),
      execute: async (_args, options) => { options.onProgress({ pct: 50 }); fs.writeSync(options.outputDescriptor, Buffer.from('segment wave')); },
    });
    const result = await reader.runtime.waveform({ src: original.source, duration: 120, start: 60, length: 60,
      audio: [{ channels: 2, timestampOffset: 0 }] });
    expect(result).toMatchObject({ start: 60, duration: 60, complete: false, temporary: true, sourceKey: cacheKeyFor(original.source) });
    const args = reader.run.mock.calls[0][0];
    expect(args[args.indexOf('-ss') + 1]).toBe('65');
    expect(args).not.toContain('-t');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'aresample=4000,apad=whole_len=240000,atrim=end_sample=240000,asetpts=N/SR/TB',
    );
    expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('pan=');
    expect(progress.filter(event => !event.done).map(event => event.pct)).toEqual([50, 75]);
    expect(progress.at(-1)).toMatchObject({ pct: 100, done: true, label: '波形片段已備妥' });
  });

  it('波形 probe 期間母素材改變，不能把舊描述套到新檔並啟動 writer', async () => {
    const original = fixture();
    const reader = runtimeFor(original.root, 'wave-probe', { describeAudio: async () => {
      fs.writeFileSync(original.source, 'changed during probe'); return [{ channels: 1 }];
    } });
    await expect(reader.runtime.waveform({ src: original.source, duration: 120, start: 0, length: 60,
      audio: [{ channels: 2 }] })).rejects.toThrow(/變更/);
    expect(reader.run).not.toHaveBeenCalled();
  });

  it.each([
    { duration: NaN }, { duration: 0 }, { start: -1 }, { start: Infinity }, { start: 120 },
    { length: 0 }, { length: NaN }, { length: 61 }, { audio: [{ channels: 65 }] },
  ])('獨立波形拒絕無界或無效輸入 %j，不啟動 writer', async override => {
    const original = fixture(), reader = runtimeFor(original.root, 'wave-invalid');
    await expect(reader.runtime.waveform({ src: original.source, duration: 120, start: 0, length: 60,
      audio: [{ channels: 2 }], ...override })).rejects.toThrow();
    expect(reader.run).not.toHaveBeenCalled();
  });

  it.each(['ingest', 'stream'])('%s 完整的嚴格本機舊快取可立即交付波形，不等待整份母素材升級驗證', async mode => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 19));
    const producer = runtimeFor(original.root, 'legacy-producer');
    const saved = await producer.runtime.ingest(request(original.source, [{ channels: 2 }]));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    delete stored.sourceContent; delete stored.sourceKeys;
    removeSourceReceipts(cacheDir(saved.proxy));
    fs.writeFileSync(metadata(saved.proxy), JSON.stringify(stored));
    const open = fsp.open;
    const fullReads = vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (file === original.source) throw new Error('不應在本機快取命中時讀完整母素材');
      return open(file, ...args);
    });
    const reader = runtimeFor(original.root, 'legacy-reader');
    const result = await reader.runtime[mode](request(original.source, [{ channels: 2 }]));
    expect(result).toMatchObject({ cached: true, proxy: saved.proxy, wave: saved.wave, channels: saved.channels });
    expect(fullReads.mock.calls.filter(([file]) => file === original.source)).toHaveLength(0);
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(result.wave)).toEqual(fs.readFileSync(saved.wave));
    if (mode === 'stream') reader.runtime.releaseStream(result.streamLeaseId);
  });

  it('已綁本機來源身分的跨機快取缺少波形時只補缺件，不重新全文驗證', async () => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 21));
    const producer = runtimeFor(original.root, 'partial-producer');
    await producer.runtime.ingest(request(original.source, [{ channels: 2 }]));
    const moved = transfer(original), first = runtimeFor(original.root, 'partial-first');
    const saved = await first.runtime.ingest(request(moved.source, [{ channels: 2 }]));
    fs.unlinkSync(saved.wave);
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (file === moved.source) throw new Error('已綁本機來源不應再次全文驗證');
      return open(file, ...args);
    });
    const reopened = runtimeFor(original.root, 'partial-reopened');
    const result = await reopened.runtime.ingest(request(moved.source, [{ channels: 2 }]));
    expect(result.cached).toBe(false);
    expect(result.proxy).toBe(saved.proxy);
    expect(result.channels).toEqual(saved.channels);
    expect(fs.readFileSync(result.wave)).toEqual(Buffer.from('complete source channel'));
    expect(reopened.run).toHaveBeenCalledOnce();
    expect(reopened.run.mock.calls[0][0]).not.toContain('-c:v');
  });

  it.each(['ingest', 'stream'].flatMap(mode => [true, false].map(allowSidecarCache => ({ mode, allowSidecarCache }))))
  ('$mode 已完成來源驗證後轉檔失敗，重開 sidecar=$allowSidecarCache 不重讀整份母素材', async ({ mode, allowSidecarCache }) => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 27));
    const open = fsp.open;
    let readBytes = 0;
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.resolve(file) === original.source) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs); readBytes += result.bytesRead; return result;
        };
      }
      return handle;
    });
    const producer = runtimeFor(original.root, 'interrupted', { allowSidecarCache,
      execute: async () => { throw new Error('轉檔中斷'); } });
    await expect(producer.runtime[mode](request(original.source))).rejects.toThrow('轉檔中斷');
    expect(readBytes).toBe(4 * 1024 * 1024);
    await producer.runtime.close();
    const reopened = runtimeFor(original.root, 'interrupted', { allowSidecarCache });
    await reopened.runtime.cleanOrphans();
    const work = await reopened.runtime[mode](request(original.source));
    if (work.completion) await work.completion;
    const result = work.response || work;
    expect(readBytes).toBe(4 * 1024 * 1024);
    expect(reopened.run).toHaveBeenCalledOnce();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    if (mode === 'stream') reopened.runtime.releaseStream(result.streamLeaseId);
  });

  it.each(['ingest', 'stream'].flatMap(mode => [false, true].map(interrupted => ({ mode, interrupted }))))
  ('$mode 同一共享檔案換路徑及 profile，已有驗證 interrupted=$interrupted 不讀全文也不重轉已完成 Proxy', async ({ mode, interrupted }) => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 29));
    const producer = runtimeFor(original.root, 'shared-producer', interrupted
      ? { execute: async () => { throw new Error('轉檔中斷'); } } : {});
    if (interrupted) await expect(producer.runtime.ingest(request(original.source))).rejects.toThrow('轉檔中斷');
    else await producer.runtime.ingest(request(original.source));
    const oldKey = cacheKeyFor(original.source);
    await producer.runtime.close();
    // Rename the parent only: the same source inode and timestamps survive,
    // while the client-visible path and strict key change.
    const movedDirectory = path.join(original.root, 'another-mount');
    fs.renameSync(original.media, movedDirectory);
    const source = path.join(movedDirectory, 'mother.mxf');
    expect(cacheKeyFor(source)).not.toBe(oldKey);
    const open = fsp.open, sourceReads = [];
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      if (path.resolve(file) === source) sourceReads.push(file);
      return open(file, ...args);
    });
    const reader = runtimeFor(original.root, 'shared-reader');
    const work = await reader.runtime[mode](request(source));
    if (work.completion) await work.completion;
    const result = work.response || work;
    expect(sourceReads).toEqual([]);
    expect(reader.run).toHaveBeenCalledTimes(interrupted ? 1 : 0);
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
    expect(cacheDir(result.proxy)).toBe(path.join(movedDirectory, '.subtool_Cache', oldKey));
    if (mode === 'stream') reader.runtime.releaseStream(result.streamLeaseId);
  });

  it.each([false, true])('既有共享證據失配但 strict key 相同，changedBytes=%s 仍重新驗證且不認領舊內容', async changedBytes => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 30));
    const producer = runtimeFor(original.root, 'old-witness');
    const saved = await producer.runtime.ingest(request(original.source, [{ channels: 1 }]));
    const key = cacheKeyFor(original.source), originalStat = fs.statSync(original.source);
    const receiptPath = path.join(cacheDir(saved.proxy), 'source-' + key + '.json');
    const previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    await producer.runtime.close();
    if (changedBytes) {
      const fd = fs.openSync(original.source, 'r+');
      try { fs.writeSync(fd, Buffer.from([99]), 0, 1, 1280 * 1024); } finally { fs.closeSync(fd); }
    }
    const tracked = new Set(), openSync = fs.openSync, closeSync = fs.closeSync;
    const statSync = fs.statSync, fstatSync = fs.fstatSync;
    const changedStat = (stat, options) => options?.bigint
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { birthtimeNs: stat.birthtimeNs + 1n })
      : originalStat;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = openSync(file, ...args);
      if (typeof file === 'string' && path.resolve(file) === original.source) tracked.add(fd);
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { tracked.delete(fd); return closeSync(fd); });
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
      const stat = fstatSync(fd, options); return tracked.has(fd) ? changedStat(stat, options) : stat;
    });
    vi.spyOn(fs, 'statSync').mockImplementation((file, options) => {
      const stat = statSync(file, options);
      return typeof file === 'string' && path.resolve(file) === original.source ? changedStat(stat, options) : stat;
    });
    expect(cacheKeyFor(original.source)).toBe(key);
    const open = fsp.open, sourceReads = [];
    vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (path.resolve(file) === original.source) sourceReads.push(file);
      return open(file, ...args);
    });
    const waveReader = runtimeFor(original.root, 'changed-witness-wave', {
      execute: async () => { throw new Error('must decode fresh waveform'); },
    });
    await expect(waveReader.runtime.waveform({ src: original.source, duration: 1, audio: [{ channels: 1 }] }))
      .rejects.toThrow('must decode fresh waveform');
    expect(waveReader.run).toHaveBeenCalledOnce();
    const reader = runtimeFor(original.root, 'changed-witness');
    expect(reader.runtime.inspectCache(original.source).some(hit => !hit.error)).toBe(false);
    const result = await reader.runtime.ingest(request(original.source, [{ channels: 1 }]));
    expect(sourceReads).toEqual([original.source]);
    expect(result.cached).toBe(!changedBytes);
    expect(reader.run).toHaveBeenCalledTimes(changedBytes ? 1 : 0);
    if (changedBytes) {
      expect(result.proxy).not.toBe(saved.proxy);
      expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toEqual(previous);
    }
  });

  it('共享 witness 屬於另一份內容收據時不能跳過全文驗證', async () => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 31));
    const producer = runtimeFor(original.root, 'mismatched-witness-producer');
    const saved = await producer.runtime.ingest(request(original.source));
    const receipt = path.join(cacheDir(saved.proxy), 'source-' + cacheKeyFor(original.source) + '.json');
    const raw = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    expect(raw.sharedSourceKey).toMatch(/^[a-f0-9]{64}$/);
    raw.sourceContent.sha256 = 'f'.repeat(64);
    fs.writeFileSync(receipt, JSON.stringify(raw));
    await producer.runtime.close();
    const moved = path.join(original.root, 'renamed-share'); fs.renameSync(original.media, moved);
    const source = path.join(moved, 'mother.mxf'), open = fsp.open, reads = [];
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      if (path.resolve(file) === source) reads.push(file);
      return open(file, ...args);
    });
    const reader = runtimeFor(original.root, 'mismatched-witness-reader');
    const result = await reader.runtime.ingest(request(source));
    expect(reads).toEqual([source]);
    expect(result.cached).toBe(true);
    expect(reader.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(result.proxy)).toEqual(proxyBytes);
  });

  it('全文讀取後共享身分改變，不得被最佳努力收據寫入吞掉而繼續轉檔', async () => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 33));
    const sourceFds = new Set(), openSync = fs.openSync, closeSync = fs.closeSync;
    const statSync = fs.statSync, fstatSync = fs.fstatSync, open = fsp.open;
    let changed = false;
    const alter = stat => changed ? { ...stat, birthtimeNs: stat.birthtimeNs + 1n, isFile: () => true } : stat;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = openSync(file, ...args);
      if (typeof file === 'string' && path.resolve(file) === original.source) sourceFds.add(fd);
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { sourceFds.delete(fd); return closeSync(fd); });
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
      const stat = fstatSync(fd, options); return sourceFds.has(fd) && options?.bigint ? alter(stat) : stat;
    });
    vi.spyOn(fs, 'statSync').mockImplementation((file, options) => {
      const stat = statSync(file, options);
      return typeof file === 'string' && path.resolve(file) === original.source && options?.bigint ? alter(stat) : stat;
    });
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.resolve(file) === original.source) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); changed = true; };
      }
      return handle;
    });
    const producer = runtimeFor(original.root, 'witness-changed');
    await expect(producer.runtime.ingest(request(original.source))).rejects.toThrow(/母素材.*變更/);
    expect(producer.run).not.toHaveBeenCalled();
    const directory = path.join(original.media, '.subtool_Cache', cacheKeyFor(original.source));
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([]);
  });

  it('必須讀全文驗證的跨機母素材持續回報實際 bytes 百分比', async () => {
    const original = fixture(Buffer.alloc(4 * 1024 * 1024, 23));
    const producer = runtimeFor(original.root, 'progress-producer');
    await producer.runtime.ingest(request(original.source));
    const moved = transfer(original), progress = [];
    const reader = runtimeFor(original.root, 'progress-reader', { sendProgress: (_target, payload) => progress.push(payload) });
    const result = await reader.runtime.ingest(request(moved.source));
    expect(result.cached).toBe(true);
    const verifying = progress.filter(event => event.stage === 'source-verification');
    expect(verifying.some(event => event.pct > 0 && event.pct < 100)).toBe(true);
    expect(verifying.at(-1)).toMatchObject({ pct: 100, processedBytes: 4 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 });
    expect(reader.run).not.toHaveBeenCalled();
  });
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
    await reader.runtime.clearAll(moved.source);
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
    expect(await reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0, incomplete: true });
    expect(claimed).toBeTruthy();
    expect(fs.readFileSync(path.join(claimed, path.relative(directory, wrongProxy)))).toEqual(wrongBytes);
    expect(fs.readFileSync(path.join(claimed, 'meta.json'))).toEqual(wrongMetadata);
    if (recreated) {
      const originalProxy = path.join(directory, path.relative(cacheDir(saved.proxy), saved.proxy));
      expect(fs.readFileSync(originalProxy)).toEqual(proxyBytes);
    } else expect(fs.existsSync(directory)).toBe(false);
  });

  it('clearAll 取得正確目錄後刪除失敗，還原原位置而非遺留失效的快取路徑', async () => {
    const { saved, moved, reader, directory } = await replacePreviouslyVerifiedCache('ingest', { defer: true });
    reader.authority.grantTrustedFile(moved.source, { read: true });
    const remove = fs.unlinkSync;
    let attempted = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...args) => {
      if (String(file).includes('.subtool-clear-')) {
        attempted = true;
        throw Object.assign(new Error('temporary cache removal failure'), { code: 'EACCES' });
      }
      return remove(file, ...args);
    });
    expect(await reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0, incomplete: true });
    expect(attempted).toBe(true);
    expect(fs.readFileSync(path.join(directory, path.relative(cacheDir(saved.proxy), saved.proxy)))).toEqual(proxyBytes);
    expect(fs.readdirSync(path.dirname(directory)).filter(name => name.startsWith('.subtool-clear-'))).toEqual([]);
  });

  it('clearAll 已准入舊格式後，同目錄物件換成有來源證據的新內容，仍須保留新內容', async () => {
    const { saved, moved, reader, directory, wrongProxy, wrongBytes, wrongMetadata, replacementDirectory } =
      await replacePreviouslyVerifiedCache('ingest', { direct: true, defer: true });
    const legacy = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'));
    for (const field of ['sourceContent', 'sourceKeys', 'publicationVersion', 'artifactSizes']) delete legacy[field];
    removeSourceReceipts(directory);
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
    expect(await reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0, incomplete: true });
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
    await reader.runtime.clearAll(moved.source);
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
    const opendir = fs.opendirSync;
    const temporaryFailure = vi.spyOn(fs, 'opendirSync').mockImplementation((file, ...args) => {
      if (file === directory) throw Object.assign(new Error('temporary metadata read failure'), { code: 'EIO' });
      return opendir(file, ...args);
    });
    expect(await reader.runtime.clearAll(moved.source)).toEqual({ bytes: 0, incomplete: true });
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
      await second.runtime.clearAll(moved.source);
      expect(fs.readFileSync(reused.proxy)).toEqual(proxyBytes);
      expect(second.runtime.releaseStream(reused.streamLeaseId)).toBe(true);
    }
    await second.runtime.clearAll(moved.source);
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

  it('既有本機 v3 完整快取不強迫升級跨機識別，搬移後仍不得猜用無證據快取', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    delete stored.sourceContent; delete stored.sourceKeys;
    removeSourceReceipts(cacheDir(saved.proxy));
    fs.writeFileSync(metadata(saved.proxy), JSON.stringify(stored));
    const reopened = runtimeFor(original.root, 'profile-A-reopened');
    expect(await reopened.runtime.ingest(request(original.source))).toEqual({ ...saved, cached: true });
    expect(reopened.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(saved.proxy)).toEqual(proxyBytes);
    expect(reopened.runtime.inspectCache(original.source).find(hit => !hit.error).sourceContent).toBeNull();
    const moved = transfer(original);
    const other = runtimeFor(original.root, 'profile-B');
    expect(await other.runtime.ingest(request(moved.source))).toMatchObject({ cached: false });
    expect(other.run).toHaveBeenCalledOnce();
  });

  it('跨機舊快取沒有可驗證的母素材證據時，不按同檔名或大小猜用', async () => {
    const original = fixture();
    const first = runtimeFor(original.root, 'profile-A');
    const saved = await first.runtime.ingest(request(original.source));
    fs.unlinkSync(path.join(path.dirname(saved.proxy), 'cache-meta.json'));
    const stored = JSON.parse(fs.readFileSync(metadata(saved.proxy), 'utf8'));
    delete stored.sourceContent; delete stored.sourceKeys;
    removeSourceReceipts(cacheDir(saved.proxy));
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
    expect(await local.runtime.cleanOrphans()).toEqual({ removed: 0, bytes: 0, incomplete: true });
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

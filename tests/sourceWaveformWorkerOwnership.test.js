import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime');
const { FileAuthority } = require('../electron/file-authority');
const { saveSourceWaveformChunk } = require('../electron/source-waveform-cache');
const roots = [], runtimes = [];

function pcm() {
  const bytes = Buffer.alloc(8044);
  bytes.write('RIFF'); bytes.writeUInt32LE(8036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(4000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(8000, 40);
  for (let index = 0; index < 4000; index++) bytes.writeInt16LE(index % 2 ? 8192 : -8192, 44 + index * 2);
  return bytes;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-wave-handover-'))
      throw new Error('拒絕清除未核對的 worker 波形測試目錄');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('waveform 與清理在同一個 turn 啟動，清理須等先開始的 worker 完成交接', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-handover-')); roots.push(root);
  const source = path.join(root, 'mother.mov'), cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot); fs.writeFileSync(source, Buffer.alloc(1024, 37));
  const orphan = path.join(cacheRoot, 'unused.wav'); fs.writeFileSync(orphan, Buffer.alloc(1024, 19));
  let writerEntered, releaseWriter;
  const entered = new Promise(resolve => { writerEntered = resolve; });
  const gate = new Promise(resolve => { releaseWriter = resolve; });
  const open = fsp.open;
  const cleanupRead = vi.fn();
  vi.spyOn(fsp, 'open').mockImplementation(async (file, ...args) => {
    if (file === orphan) cleanupRead();
    return open(file, ...args);
  });
  const audio = [{ channels: 1, timestampOffset: 0 }];
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, backgroundWaveforms: true, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    describeAudio: async () => audio,
    ffmpegExecution: { execute: async (_args, options) => {
      writerEntered(); await gate; fs.writeFileSync(options.outputDescriptor, pcm());
    } },
  });
  runtimes.push(runtime);
  const work = runtime.waveform({ src: source, duration: 1, length: 1, audio });
  const settled = work.then(value => ({ value }), error => ({ error }));
  let cleanupCompleted = false;
  const cleanup = runtime.clearAll().then(result => { cleanupCompleted = true; return result; });
  try {
    await entered;
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupRead).not.toHaveBeenCalled();
    expect(cleanupCompleted).toBe(false);
  } finally { releaseWriter(); await cleanup; await settled; }
  const result = await settled;
  expect(result.error).toBeUndefined();
  expect(fs.readFileSync(result.value.wave)).toEqual(pcm());
  expect(cleanupRead).toHaveBeenCalled();
  expect(fs.existsSync(orphan)).toBe(false);
});

it.each(['replacement', 'same-inode'])('背景波形 done observer %s 改變主程序私有副本，不交付或刪除外來內容', async kind => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-handover-')); roots.push(root);
  const source = path.join(root, 'mother.mov'), cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot); fs.writeFileSync(source, Buffer.alloc(1024, 37));
  const bytes = pcm(), audio = [{ channels: 1, timestampOffset: 0 }], key = cacheKeyFor(source);
  const directory = path.join(cacheRoot, key); fs.mkdirSync(directory);
  expect(saveSourceWaveformChunk(directory, { version: 1,
    sharedSourceKey: createHash('sha256').update('strict-source-wave-v1\0' + key).digest('hex'),
    start: 0, length: 1, samples: 4000, audio }, bytes)).toBe(true);
  const output = path.join(tempRoot, 'handover.source-wave.wav'), foreign = Buffer.from(bytes);
  foreign.writeInt16LE(17, 44);
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, backgroundWaveforms: true, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    createTempPath: () => output, describeAudio: async () => audio,
    ffmpegExecution: { execute: () => { throw new Error('快取命中不應解碼'); } },
    sendProgress: (_target, payload) => {
      if (!payload.done) return;
      if (kind === 'replacement') fs.renameSync(output, output + '.previous');
      fs.writeFileSync(output, foreign);
    },
  });
  runtimes.push(runtime);
  await expect(runtime.waveform({ src: source, duration: 1, start: 0, length: 1, audio })).rejects.toThrow();
  expect(fs.readFileSync(output)).toEqual(foreign);
  expect(runtime.cleanupGeneratedFile(output)).toBe(false);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { createMediaIntakeRuntime, cacheKeyFor } = require('../electron/media-intake-runtime');
const { FileAuthority } = require('../electron/file-authority');
const { saveSourceWaveformChunk } = require('../electron/source-waveform-cache');
const { ownWaveformProcess } = require('../electron/source-waveform-worker');
const roots = [], runtimes = [];
function wav() {
  const bytes = Buffer.alloc(8044);
  bytes.write('RIFF'); bytes.writeUInt32LE(8036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(4000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(8000, 40);
  for (let n = 0; n < 4000; n++) bytes.writeInt16LE(n % 2 ? 8192 : -8192, 44 + n * 2);
  return bytes;
}
function setup({ cached = true, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-wave-worker-test-')); roots.push(root);
  const src = path.join(root, 'source.mov'), cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot); fs.writeFileSync(src, Buffer.alloc(1024, 37));
  const bytes = wav(), audio = [{ channels: 1, timestampOffset: 0 }];
  if (cached) {
    const key = cacheKeyFor(src), dir = path.join(cacheRoot, key); fs.mkdirSync(dir);
    saveSourceWaveformChunk(dir, { version: 1, sharedSourceKey: createHash('sha256').update('strict-source-wave-v1\0' + key).digest('hex'),
      start: 0, length: 1, samples: 4000, audio }, bytes);
  }
  const fileAuthority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  fileAuthority.grantTrustedFile(src);
  const execute = vi.fn(() => { throw new Error('cache hit must not decode'); });
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, fileAuthority, backgroundWaveforms: true,
    allowSidecarCache: false, describeAudio: async () => audio, ffmpegExecution: { execute }, ...options });
  runtimes.push(runtime);
  return { root, src, bytes, runtime, execute, request: { src, duration: 1, length: 1, audio } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('subtool-wave-worker-test-')) throw new Error('unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('cached waveform keeps synchronous source I/O off the caller and retains exact PCM / cleanup ownership', async () => {
  const f = setup(), read = fs.readSync, open = fs.openSync, sourceDescriptors = new Set(); let sourceReads = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    const fd = open(file, ...args); if (file === f.src) sourceDescriptors.add(fd); else sourceDescriptors.delete(fd); return fd;
  });
  vi.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => { if (sourceDescriptors.has(fd)) sourceReads++; return read(fd, ...args); });
  const result = await f.runtime.waveform(f.request);
  expect(sourceReads).toBe(0);
  expect(f.execute).not.toHaveBeenCalled();
  expect(result).toMatchObject({ cached: true, temporary: true, duration: 1, complete: true });
  expect(fs.readFileSync(result.wave)).toEqual(f.bytes);
  expect(f.runtime.cleanupGeneratedFile(result.wave)).toBe(true);
  expect(f.runtime.cleanupGeneratedFile(result.wave)).toBe(false);
});

it('cancellation waits for the native writer and never publishes a late temporary file', async () => {
  let start, finish, controller;
  const started = new Promise(resolve => { start = resolve; }), closed = new Promise(resolve => { finish = resolve; });
  const kill = vi.fn();
  const f = setup({ cached: false, ffmpegExecution: { execute: async (_args, options) => {
    options.onProcess({ kill }); start(); await closed;
    fs.writeFileSync(options.outputDescriptor, wav());
  } } });
  let settled = false;
  const work = f.runtime.waveform(f.request, { ownProcess: value => { controller = value; } }).finally(() => { settled = true; });
  const rejected = expect(work).rejects.toMatchObject({ code: 'INGEST_SUPERSEDED' });
  await started; controller.kill();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(settled).toBe(false); expect(kill).toHaveBeenCalled();
  finish(); await rejected;
  expect(fs.readdirSync(path.join(f.root, 'temp'))).toEqual([]);
});

it('cache cleanup waits for an offloaded writer through publication', async () => {
  let start, finish;
  const started = new Promise(resolve => { start = resolve; }), closed = new Promise(resolve => { finish = resolve; });
  const f = setup({ cached: false, ffmpegExecution: { execute: async (_args, options) => {
    start(); await closed; fs.writeFileSync(options.outputDescriptor, wav());
  } } });
  const work = f.runtime.waveform(f.request);
  await started;
  let cleaned = false;
  const cleanup = f.runtime.clearAll().then(result => { cleaned = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(cleaned).toBe(false);
  finish(); const result = await work; await cleanup;
  expect(fs.readFileSync(result.wave)).toEqual(wav());
  expect(f.runtime.cleanupGeneratedFile(result.wave)).toBe(true);
});

it('waveform decoding limits decoder and complex-filter parallelism without changing PCM', async () => {
  let argv;
  const f = setup({ cached: false, ffmpegExecution: { execute: async (args, options) => {
    argv = args; fs.writeFileSync(options.outputDescriptor, wav());
  } } });
  const result = await f.runtime.waveform(f.request);
  expect(argv.indexOf('-threads')).toBeGreaterThan(-1);
  expect(argv.indexOf('-threads')).toBeLessThan(argv.indexOf('-i'));
  expect(argv[argv.indexOf('-threads') + 1]).toBe('1');
  expect(argv[argv.indexOf('-filter_complex_threads') + 1]).toBe('1');
  expect(fs.readFileSync(result.wave)).toEqual(wav());
});

it('source changes from the completion observer reject the handover and reclaim its private copy', async () => {
  const f = setup({ sendProgress: (_target, payload) => {
    if (payload.done) fs.writeFileSync(f.src, Buffer.alloc(1024, 91));
  } });
  await expect(f.runtime.waveform(f.request)).rejects.toThrow('母素材');
  expect(fs.readdirSync(path.join(f.root, 'temp'))).toEqual([]);
});

it('priority failures and missing child PIDs never change the main process or lose cancellation ownership', () => {
  const priority = vi.spyOn(os, 'setPriority').mockImplementation(() => { throw new Error('access denied'); });
  const own = vi.fn(), child = { pid: 7654321 };
  ownWaveformProcess({ pid: 0 }, own);
  ownWaveformProcess({}, own);
  expect(priority).not.toHaveBeenCalled();
  ownWaveformProcess(child, own);
  expect(priority).toHaveBeenCalledExactlyOnceWith(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  expect(own).toHaveBeenCalledTimes(3);
  expect(own).toHaveBeenLastCalledWith(child);
});

it('failed background preparation emits one failed terminal outcome', async () => {
  const progress = vi.fn();
  const f = setup({ cached: false, sendProgress: progress });
  await expect(f.runtime.waveform(f.request)).rejects.toThrow('cache hit must not decode');
  const terminal = progress.mock.calls.map(([, payload]) => payload).filter(payload => payload.done);
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ outcome: 'failed', stage: 'source-waveform' });
});

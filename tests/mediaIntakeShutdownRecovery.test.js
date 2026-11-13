import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { parse } = require('acorn');
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
let root;
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-intake-shutdown-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it.each(['close', 'closeAllConnections'])('真 before-quit 的 HTTP %s 拋錯取消退出後，新匯入可用且舊 URL 不復活', async method => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-intake-shutdown-'));
  const source = path.join(root, 'mother.bin'), cache = path.join(root, 'cache');
  fs.writeFileSync(source, 'mother data');
  const originalCreate = http.createServer;
  let firstServer, faulted = false;
  let releaseWave, startWave;
  const waveGate = new Promise(resolve => { releaseWave = resolve; });
  const waveStarted = new Promise(resolve => { startWave = resolve; });
  vi.spyOn(http, 'createServer').mockImplementation((...args) => {
    const server = originalCreate(...args);
    if (!firstServer) {
      firstServer = server;
      const original = server[method].bind(server);
      server[method] = (...parameters) => {
        if (!faulted) { faulted = true; throw new Error('simulated shutdown error'); }
        return original(...parameters);
      };
    }
    return server;
  });
  const runtime = createMediaIntakeRuntime({ tempRoot: root, cacheRoot: cache, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cache, root] }),
    ffmpegExecution: { async execute(args, options) {
      if (options.jobId === 'source-wave') {
        startWave(); await waveGate; fs.writeSync(options.outputDescriptor, Buffer.alloc(8000, 1)); return;
      }
      for (const file of args.filter(value => /\.(?:wav|m4a|mp4)$/.test(value))) {
        fs.writeFileSync(file, /proxy\.mp4$/.test(file) ? Buffer.alloc(131072, 7) : 'complete audio');
      }
    } },
  });
  const request = { src: source, duration: 1, audio: [] };
  const work = await runtime.stream(request); await work.completion;
  const oldUrl = work.response.streamUrl;
  const status = url => new Promise(resolve => {
    http.get(url, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); })
      .on('error', () => resolve('closed'));
  });
  expect(await status(oldUrl)).toBe(200);
  const oldWave = runtime.waveform({ src: source, duration: 1, audio: [{ channels: 1 }], ignoreCached: true });
  oldWave.catch(() => {});
  await waveStarted;
  const sourceCode = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const tree = parse(sourceCode, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = tree.body.find(node => node.expression?.callee?.object?.name === 'app'
    && node.expression?.callee?.property?.name === 'on' && node.expression?.arguments?.[0]?.value === 'before-quit');
  let beforeQuit;
  const owner = () => ({ cancelAllAndWait: async () => {}, resume: () => {} });
  const context = {
    app: { on: (_event, fn) => { beforeQuit = fn; }, quit() {} }, _quitReady: false, _quitSequenceStarted: false, _isAppQuitting: false,
    audioNormalizationJobs: new Map(), mediaProbe: null, ffmpegExecution: owner(), deliveryCapabilities: owner(),
    speechCompressionRuntime: owner(), vocalWaveformRuntime: owner(), mediaIngestCoordinator: owner(), mediaWaveformCoordinator: owner(),
    nativeAudioMeter: { stop: vi.fn().mockResolvedValue() },
    QueueManager: { prepareForShutdown: async () => {}, cancelShutdown: async () => {} },
    clipAudioCache: { waitForIdle: async () => {} }, clipFrameCache: { waitForIdle: async () => {} },
    screenshotOutput: { close: async () => {}, resume: async () => {} }, directoryOutput: { close: async () => {}, resume: async () => {} }, fileCommitCoordinator: { close: async () => {}, resume: async () => {} }, mpvHost: { disposeAndWait: async () => true, resume() {} },
    mediaIntakeRuntime: runtime, mainWin: null, dialog: { showMessageBox: async () => {} }, console: { error() {} }, Promise,
  };
  vm.runInNewContext(sourceCode.slice(registration.start, registration.end), context);
  try {
    beforeQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(context._quitSequenceStarted).toBe(false));
    expect(faulted).toBe(true); expect(context._quitReady).toBe(false);
    expect(context.nativeAudioMeter.stop).toHaveBeenCalledOnce();
    const next = await runtime.stream(request);
    if (next.completion) await next.completion;
    expect(await status((next.response || next).streamUrl)).toBe(200);
    expect(await status(oldUrl)).not.toBe(200);
    releaseWave();
    await expect(oldWave).rejects.toThrow();
  } finally {
    releaseWave(); await oldWave.catch(() => {});
    if (firstServer?.listening) await new Promise(resolve => firstServer.close(resolve));
    await runtime.close();
  }
});

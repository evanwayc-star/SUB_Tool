import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const { createSpeechAudioReader, validateSpeechAudioRequest } = require('../electron/speech-audio-reader.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const directories = [];
const request = extra => ({ path: 'C:/media/source.wav', start: 0, duration: .001, requestId: 'asr-test', ...extra });
function bridge(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync('electron/preload.js', 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on() {}, send() {} }, webUtils: {} }),
    ArrayBuffer, Uint8Array, Promise, TypeError, RangeError,
  });
  return api;
}
function handlers(runtime, authority) {
  const source = fs.readFileSync('electron/main.js', 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registrations = ast.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.callee?.object?.name === 'ipcMain' && node.expression.callee?.property?.name === 'handle'
    && ['speech:audioRead', 'speech:audioCancel'].includes(node.expression.arguments[0]?.value));
  expect(registrations).toHaveLength(2);
  const mapped = new Map();
  const context = { speechAudioReader: runtime, validateSpeechAudioRequest,
    requireReadablePath: createIpcGuards(authority).requireReadablePath,
    _isAppQuitting: false, ipcMain: { handle: (name, fn) => mapped.set(name, fn) } };
  vm.runInNewContext(registrations.map(node => source.slice(node.start, node.end)).join('\n'), context);
  return { mapped, context };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const real = fs.realpathSync(directory);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-asr-ipc-')) throw Error('fixture cleanup boundary');
    fs.rmSync(real, { recursive: true, force: true });
  }
});

it('preload先拒絕非法/超量讀取，白名單隔離任意filter/輸出路徑', async () => {
  const invoke = vi.fn(async () => ({})), api = bridge(invoke);
  for (const invalid of [{ path: '' }, { start: -1 }, { duration: 601 }, { duration: NaN },
    { duration: 1e-9 }, { sourceStream: 256 }, { sourceChannel: 128 }, { processed: 'true' }, { requestId: '../bad' }]) {
    expect(() => api.speechAudioRead(request(invalid))).toThrow();
  }
  expect(invoke).not.toHaveBeenCalled();
  await api.speechAudioRead(request({ outputPath: 'C:/foreign.wav', filter: 'volume=20', gain: 99 }));
  await api.speechAudioCancel('asr-test');
  expect(invoke).toHaveBeenNthCalledWith(1, 'speech:audioRead', {
    ...request(), sourceStream: 0, sourceChannel: null, processed: false,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, 'speech:audioCancel', { requestId: 'asr-test' });
});

it('真preload→main先核read capability，合法source回傳實際PCM並保持sender cancel隔離', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-asr-ipc-')); directories.push(directory);
  const source = path.join(directory, 'source.wav'); fs.writeFileSync(source, 'fixture');
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  const children = [], spawn = vi.fn(() => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; });
    children.push(child); return child;
  });
  const probe = vi.fn(async () => ({ duration: 1, audio: [{ channels: 1 }] }));
  const runtime = createSpeechAudioReader({ getFFmpegPath: () => 'ffmpeg', probe, spawn });
  const authority = new FileAuthority(), { mapped, context } = handlers(runtime, authority);
  const api = bridge((channel, value) => Promise.resolve().then(() => mapped.get(channel)({ sender }, value)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(api.speechAudioRead(request({ path: source }))).rejects.toThrow(/未授權/);
  expect(probe).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  authority.grantTrustedFile(source, { read: true, write: false });
  const pending = api.speechAudioRead(request({ path: source }));
  for (let index = 0; index < 8 && !children.length; index++) await Promise.resolve();
  children[0].stdout.emit('data', Buffer.from(new Float32Array(16).fill(.25).buffer)); children[0].emit('close', 0);
  const result = await pending;
  expect(result).toMatchObject({ frames: 16, sampleRate: 16000, numberOfChannels: 1 });
  expect([...new Float32Array(result.pcm)]).toEqual(Array(16).fill(.25));
  context._isAppQuitting = true;
  await expect(api.speechAudioRead(request({ path: source }))).rejects.toThrow(/結束/);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('main取消只傳本sender與requestId，不接受renderer指定另一個owner', () => {
  const runtime = { read: vi.fn(), cancel: vi.fn(() => true) };
  const { mapped } = handlers(runtime, new FileAuthority()), sender = {};
  expect(mapped.get('speech:audioCancel')({ sender }, { requestId: 'asr-test', sender: {} })).toBe(true);
  expect(runtime.cancel).toHaveBeenCalledWith(sender, 'asr-test');
});

it('真before-quit handler包含辨識讀取屏障，未收尾時不能宣告退出', async () => {
  const source = fs.readFileSync('electron/main.js', 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.callee?.object?.name === 'app' && node.expression.callee?.property?.name === 'on'
    && node.expression.arguments[0]?.value === 'before-quit');
  const nativeOwner = () => ({ cancelAllAndWait: vi.fn(async () => {}), resume: vi.fn() });
  let finish, handler;
  const speechAudioReader = { cancelAllAndWait: vi.fn(() => new Promise(resolve => { finish = resolve; })), resume: vi.fn() };
  const context = {
    app: { on: (_channel, fn) => { handler = fn; }, quit: vi.fn() },
    _quitReady: false, _quitSequenceStarted: false, _isAppQuitting: false,
    audioNormalizationJobs: new Map(), mediaProbe: nativeOwner(), ffmpegExecution: nativeOwner(),
    deliveryCapabilities: nativeOwner(), speechCompressionRuntime: nativeOwner(), speechAudioReader,
    vocalWaveformRuntime: nativeOwner(), nativeAudioMeter: { stop: vi.fn(async () => {}) },
    mediaIngestCoordinator: nativeOwner(), mediaWaveformCoordinator: nativeOwner(),
    directoryOutput: { close: vi.fn(async () => {}) }, QueueManager: { prepareForShutdown: vi.fn(async () => {}) },
    clipAudioCache: { waitForIdle: vi.fn(async () => {}) }, clipFrameCache: { waitForIdle: vi.fn(async () => {}) },
    screenshotOutput: { close: vi.fn(async () => {}) }, fileCommitCoordinator: { close: vi.fn(async () => {}) },
    mpvHost: { disposeAndWait: vi.fn(async () => {}) }, mediaIntakeRuntime: { close: vi.fn(async () => {}) },
    Promise, console,
  };
  vm.runInNewContext(source.slice(registration.start, registration.end), context);
  handler({ preventDefault: vi.fn() }); await Promise.resolve(); await Promise.resolve();
  expect(speechAudioReader.cancelAllAndWait).toHaveBeenCalledTimes(1);
  expect(context.app.quit).not.toHaveBeenCalled(); expect(context._quitReady).toBe(false);
  finish(); await vi.waitFor(() => expect(context.app.quit).toHaveBeenCalledTimes(1));
  expect(context._quitReady).toBe(true);
});

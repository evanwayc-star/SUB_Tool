import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

const { parse } = createRequire(import.meta.url)('acorn');

it.each(['screenshot', 'queue', 'both'])('真 before-quit 的 %s 恢復失敗仍須解除退出鎖並通知使用者', async failed => {
  const source = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const node = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }).body.find(entry =>
    entry.expression?.callee?.object?.name === 'app' && entry.expression?.callee?.property?.name === 'on'
      && entry.expression.arguments?.[0]?.value === 'before-quit');
  let beforeQuit, recovery;
  // Capture the actual callback's detached recovery promise so rejection is
  // observable without generating an unhandled-rejection test side effect.
  const CapturedPromise = {
    all: Promise.all.bind(Promise),
    resolve(value) {
      let current = Promise.resolve(value);
      const chain = {
        then(callback) { current = current.then(callback); return chain; },
        catch(callback) { recovery = current.catch(callback); recovery.catch(() => {}); return recovery; },
      };
      return chain;
    },
  };
  const owner = () => ({ cancelAllAndWait: vi.fn().mockResolvedValue(), resume: vi.fn() });
  const screenshot = { close: vi.fn(), resume: vi.fn(async () => { if (failed !== 'queue') throw new Error('resume failed'); }) };
  const queue = { prepareForShutdown: vi.fn().mockRejectedValue(new Error('shutdown failed')),
    cancelShutdown: vi.fn(async () => { if (failed !== 'screenshot') throw new Error('queue resume failed'); }) };
  const showMessageBox = vi.fn().mockResolvedValue();
  const context = {
    app: { on: (_event, fn) => { beforeQuit = fn; }, quit: vi.fn() },
    _quitReady: false, _quitSequenceStarted: false, _isAppQuitting: false, audioNormalizationJobs: new Map(),
    mediaProbe: null, ffmpegExecution: owner(), deliveryCapabilities: owner(), speechCompressionRuntime: owner(), speechAudioReader: owner(),
    vocalWaveformRuntime: owner(), mediaIngestCoordinator: owner(), mediaWaveformCoordinator: owner(), QueueManager: queue,
    nativeAudioMeter: { stop: vi.fn().mockResolvedValue() },
    clipAudioCache: { waitForIdle: vi.fn() }, clipFrameCache: { waitForIdle: vi.fn() },
    screenshotOutput: screenshot, directoryOutput: { close: vi.fn(), resume: vi.fn() }, fileCommitCoordinator: { close: vi.fn(), resume: vi.fn() }, mpvHost: { resume: vi.fn() }, mediaIntakeRuntime: { resume: vi.fn() },
    mainWin: null, dialog: { showMessageBox }, console: { error() {} }, Promise: CapturedPromise,
  };
  vm.runInNewContext(source.slice(node.start, node.end), context);
  beforeQuit({ preventDefault() {} });
  await recovery.catch(() => {});
  expect(context._quitSequenceStarted).toBe(false);
  expect(context._isAppQuitting).toBe(false);
  expect(showMessageBox).toHaveBeenCalledOnce();
  expect(context.ffmpegExecution.resume).toHaveBeenCalledOnce();
  expect(context.nativeAudioMeter.stop).toHaveBeenCalledOnce();
  expect(queue.cancelShutdown).toHaveBeenCalledOnce();
  const detail = showMessageBox.mock.calls[0].at(-1).detail;
  expect(detail).toContain('shutdown failed');
  if (failed !== 'queue') expect(detail).toContain('resume failed');
  if (failed !== 'screenshot') expect(detail).toContain('queue resume failed');
  beforeQuit({ preventDefault() {} });
  await recovery.catch(() => {});
  expect(queue.prepareForShutdown).toHaveBeenCalledTimes(2);
  expect(context.nativeAudioMeter.stop).toHaveBeenCalledTimes(2);
  expect(context._quitSequenceStarted).toBe(false);
  expect(showMessageBox).toHaveBeenCalledTimes(2);
});

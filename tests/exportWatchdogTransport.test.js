import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

function controlledWatchdog() {
  const filename = path.resolve('electron/export-watchdog.js'), require = createRequire(filename);
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, connected: true, stderr: new EventEmitter(), send() {},
  });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, __filename: filename, __dirname: path.dirname(filename),
    Buffer, setTimeout, clearTimeout, AbortController,
    require: name => name === 'child_process' ? { spawn: () => child } : require(name),
  }, { filename });
  const outPath = path.resolve('unused-transport-output.iso');
  const controller = module.exports.spawnExportWatchdog({
    ffmpegPath: 'unused-ffmpeg', args: [outPath], outPath, jobId: 'transport', queueDir: path.dirname(outPath),
    sharedQueueDir: path.dirname(outPath), sharedAuthority: {},
  });
  controller.ready.catch(() => {});
  const outcome = controller.completion.then(value => ({ value }), error => ({ error }));
  return { child, controller, outcome };
}

it.each(['message-first', 'exit-first'])('watchdog %s keeps the complete retained-lease result while IPC drains', async order => {
  const { child, outcome } = controlledWatchdog();
  const result = { type: 'exit', ok: false, code: null, cleanup: {
    retainedLease: true, releaseError: { code: 'EPERM', message: 'lease release failed' },
  } };
  child.emit('message', { type: 'error', code: 'EIO', message: 'owner update failed' });
  if (order === 'exit-first') child.emit('exit', 0, null);
  child.emit('message', result);
  if (order === 'message-first') child.emit('exit', 0, null);
  child.emit('close', 0, null);
  expect(await outcome).toEqual({ value: result });
});

it('watchdog without an IPC result rejects after transport close, retaining the startup cause', async () => {
  const { child, outcome } = controlledWatchdog();
  let settled = false; outcome.then(() => { settled = true; });
  child.emit('message', { type: 'error', code: 'EIO', message: 'owner update failed' });
  child.emit('exit', 0, null);
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close', 0, null);
  expect((await outcome).error).toMatchObject({ code: 'EIO', message: 'owner update failed' });
});

it('watchdog that closes before any IPC readiness still rejects with its exit cause', async () => {
  const { child, controller, outcome } = controlledWatchdog();
  child.emit('exit', 1, null); child.emit('close', 1, null);
  expect((await outcome).error).toMatchObject({ code: 'WATCHDOG_EXITED' });
  await expect(controller.ready).rejects.toMatchObject({ code: 'WATCHDOG_EXITED' });
});

it('watchdog spawn failure without a process id settles immediately without waiting for close', async () => {
  const { child, outcome } = controlledWatchdog(); child.pid = undefined;
  child.emit('error', Object.assign(new Error('missing watchdog'), { code: 'ENOENT' }));
  expect((await outcome).error).toMatchObject({ code: 'ENOENT', message: 'missing watchdog' });
  child.emit('close', -1, null);
});

it.each(['disconnect-first', 'exit-first'])('watchdog explicit %s finishes after both exit and drained IPC without a close event', async order => {
  const { child, outcome } = controlledWatchdog();
  child.emit('message', { type: 'ready' });
  let settled = false; outcome.then(() => { settled = true; });
  if (order === 'disconnect-first') child.emit('disconnect'); else child.emit('exit', 0, null);
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  if (order === 'disconnect-first') child.emit('exit', 0, null); else child.emit('disconnect');
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(true);
  expect((await outcome).error).toMatchObject({ code: 'WATCHDOG_EXITED' });
});

it.each(['disconnect', 'close'])('watchdog %s allows queued IPC results to drain before the no-result fallback', async event => {
  const { child, outcome } = controlledWatchdog();
  const result = { type: 'exit', ok: false, cleanup: { retainedLease: true } };
  child.emit('message', { type: 'error', code: 'EIO', message: 'owner update failed' });
  child.emit('exit', 0, null); child.emit(event, 0, null);
  process.nextTick(() => child.emit('message', result));
  expect(await outcome).toEqual({ value: result });
});

it('watchdog with a complete exit result but no readiness still settles both promises', async () => {
  const { child, controller, outcome } = controlledWatchdog();
  let readiness;
  controller.ready.then(value => { readiness = { value }; }, error => { readiness = { error }; });
  const result = { type: 'exit', ok: false, cleanup: { retainedLease: true } };
  child.emit('message', result); child.emit('exit', 0, null); child.emit('close', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  expect(await outcome).toEqual({ value: result });
  expect(readiness?.error).toMatchObject({ code: 'WATCHDOG_EXITED' });
});

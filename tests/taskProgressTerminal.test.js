// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { parse } from 'acorn';

// Execute the actual registered IPC consumer without booting the app ticker/native UI.
const source = fs.readFileSync(path.resolve('src/app.js'), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
function findProgressRegistration(node) {
  if (node?.type === 'CallExpression' && node.callee?.object?.name === 'DESK' && node.callee?.property?.name === 'onProgress') return node;
  if (!node || typeof node !== 'object') return null;
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const found = findProgressRegistration(child);
      if (found) return found;
    }
  }
  return null;
}
const registration = findProgressRegistration(tree);
const require = createRequire(import.meta.url);
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
let consume, setStatus, completed, listener;
beforeEach(() => {
  if (listener) window.removeEventListener('desk:ingest-done', listener);
  document.body.innerHTML = '<span id="stMedia">master.mxf</span>';
  setStatus = vi.fn(); completed = [];
  listener = event => completed.push(event.detail);
  window.addEventListener('desk:ingest-done', listener);
  vm.runInNewContext(source.slice(registration.start, registration.end), {
    DESK: { onProgress: callback => { consume = callback; } },
    _taskStarts: {}, setStatus, window, CustomEvent: window.CustomEvent,
    $: id => document.getElementById(id),
  });
});

describe('registered native task-progress terminal consumer', () => {
  it('failed terminal unlocks and restores the media label without announcing successful ingest', () => {
    consume({ jobId: 'stream-1', label: '轉檔', pct: 10 });
    expect(document.getElementById('stMedia').style.display).toBe('none');
    consume({ jobId: 'stream-1', label: '轉檔', done: true, outcome: 'failed', errorMsg: 'codec unsupported' });
    expect(setStatus).toHaveBeenLastCalledWith('轉檔失敗', 'err', 'unlock');
    expect(document.getElementById('stMedia').style.display).toBe('');
    expect(completed).toEqual([]);
  });

  it('a failed attempt does not consume the same-job successful retry completion', () => {
    let rebuilt = 0;
    const rebuild = event => {
      if (event.detail.jobId !== 'stream-1') return;
      rebuilt++; window.removeEventListener('desk:ingest-done', rebuild);
    };
    window.addEventListener('desk:ingest-done', rebuild);
    consume({ jobId: 'stream-1', done: true, outcome: 'failed' });
    expect(rebuilt).toBe(0);
    consume({ jobId: 'stream-1', done: true, outcome: 'success', pct: 100 });
    expect(rebuilt).toBe(1);
    expect(completed).toEqual([expect.objectContaining({ jobId: 'stream-1', outcome: 'success' })]);
    expect(setStatus).toHaveBeenLastCalledWith('轉檔完成', 'ok', 'unlock');
  });

  it('a terminal lacking a success outcome cannot announce successful ingest', () => {
    consume({ jobId: 'ingest', done: true, pct: 100 });
    expect(completed).toEqual([]);
    expect(setStatus.mock.calls.at(-1)[2]).toBe('unlock');
  });

  it('actual extractAudio IPC copy/AAC fallback dispatches completion only for the successful attempt', async () => {
    const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
    const mainTree = parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script' });
    const call = mainTree.body.map(node => node.expression).find(node =>
      node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle'
      && node.arguments?.[0]?.value === 'ffmpeg:extractAudio');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-audio-fallback-'));
    roots.push(root);
    const out = path.join(root, 'audio.m4a');
    const stages = [], sent = [];
    const execution = createFFmpegExecution({
      getFFmpegPath: () => 'fake-ffmpeg', getUserDataDir: () => root,
      send(sender, event, data) { sent.push(data); consume(data); },
      spawnDirect(executable, args) {
        const codec = args[args.indexOf('-c:a') + 1];
        stages.push(codec);
        const child = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', codec === 'copy' ? 1 : 0));
        return child;
      },
    });
    let extractAudio;
    vm.runInNewContext(mainSource.slice(call.start, call.end), {
      ipcMain: { handle: (name, handler) => { extractAudio = handler; } },
      requireReadablePath() {}, tmpPath: () => out,
      runFF: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
    });
    await expect(extractAudio({ sender: {} }, { path: 'mother.flac', idx: 0, duration: 1, codec: 'flac' })).resolves.toBe(out);
    expect(stages).toEqual(['copy', 'aac']);
    expect(sent.filter(data => data.done).map(data => [data.jobId, data.outcome])).toEqual([['a0', 'failed'], ['a0', 'success']]);
    expect(completed).toEqual([expect.objectContaining({ jobId: 'a0', outcome: 'success' })]);
    expect(setStatus).toHaveBeenLastCalledWith('抽取音軌 1完成', 'ok', 'unlock');
  });
});

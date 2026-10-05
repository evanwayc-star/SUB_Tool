import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup(kind, { chunks = [], code = 0, stage, signal = null, shouldSend } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-ffmpeg-stream-'));
  roots.push(root);
  const queueDir = path.join(root, 'queue');
  const sent = [], progress = [], stderr = [];
  let nativeChild;
  const failure = Object.assign(new Error('native startup failed'), { code: 'ENOENT' });
  const execution = createFFmpegExecution({
    getFFmpegPath: () => stage === 'missing' ? null : 'fake-ffmpeg',
    getUserDataDir: () => root,
    getQueueDir: () => queueDir,
    ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
    send: (sender, event, data) => sent.push({ sender, event, data }),
    spawnDirect() {
      if (stage === 'throw') throw failure;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      nativeChild = child;
      if (stage === 'hold') return child;
      queueMicrotask(() => {
        for (const chunk of chunks) child.stderr.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (stage === 'error') child.emit('error', failure);
        child.emit('close', code, signal);
        child.emit('close', code, signal); // duplicate native notification must remain idempotent
      });
      return child;
    },
    spawnWatchdog(config, handlers) {
      if (stage === 'throw') throw failure;
      return {
        ready: Promise.resolve(),
        completion: new Promise((resolve, reject) => queueMicrotask(() => {
          for (const chunk of chunks) handlers.onStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (stage === 'error') reject(failure);
          else resolve({ ok: code === 0, code });
        })),
      };
    },
  });
  return { root, sent, progress, stderr, failure, execution, get child() { return nativeChild; },
    run: () => execution.execute(['-i', 'mother.mxf', path.join(root, 'out.mp4')], {
      executionKind: kind, duration: 10, jobId: 'ingest', label: '轉檔預覽影片',
      outPath: path.join(root, 'out.mp4'), sender: { id: 7 }, shouldSend,
      onProgress: value => progress.push(value), onStderr: value => stderr.push(value),
    }),
  };
}

describe('public FFmpeg execution terminal and pipe records', () => {
  it.each(['direct', 'queued-delivery'])('%s nonzero close emits one failed terminal, never success', async kind => {
    const fixture = setup(kind, { code: 1, chunks: ['Output container does not support this codec\n'] });
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_EXIT' });
    expect(fixture.sent.filter(item => item.data.done)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ done: true, outcome: 'failed', errorCode: 'FFMPEG_EXIT' }) }),
    ]);
    expect(fixture.sent.some(item => item.data.done && item.data.outcome === 'success')).toBe(false);
  });

  it.each(['missing', 'throw', 'error'])('direct %s failure also emits one failed terminal', async stage => {
    const fixture = setup('direct', { stage });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.filter(item => item.data.done)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ done: true, outcome: 'failed' }) }),
    ]);
    expect(fixture.progress.filter(item => item.done)).toHaveLength(1);
  });

  it.each(['throw', 'error'])('watchdog %s failure emits a terminal but no fake artifact completion callback', async stage => {
    const fixture = setup('queued-delivery', { stage });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.filter(item => item.data.done)).toHaveLength(1);
    expect(fixture.sent.at(-1).data.outcome).toBe('failed');
    expect(fixture.progress.some(item => item.done)).toBe(false);
  });

  it('signal termination cannot report success even with code zero', async () => {
    const fixture = setup('direct', { signal: 'SIGTERM' });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.at(-1).data).toMatchObject({ done: true, outcome: 'failed' });
  });

  it('shutdown cancellation and admission rejection both report failed once, even after code-zero close', async () => {
    const fixture = setup('direct', { stage: 'hold' });
    const work = fixture.run().catch(error => error);
    const closing = fixture.execution.cancelAllAndWait();
    fixture.child.emit('close', 0);
    await expect(work).resolves.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    await closing;
    expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['failed']);
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_SHUTTING_DOWN' });
    expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['failed', 'failed']);
  });

  it('successful direct child emits one shared success terminal after EOF progress', async () => {
    const fixture = setup('direct', { chunks: ['frame=25 time=00:00:05.00 speed=1.0x'] });
    await fixture.run();
    expect(fixture.sent.filter(item => item.data.done)).toHaveLength(1);
    expect(fixture.progress.at(-2)).toMatchObject({ pct: 50 });
    expect(fixture.progress.at(-1)).toMatchObject({ done: true, outcome: 'success', pct: 100 });
  });

  it('queued callbacks remain encode progress until the artifact owner publishes', async () => {
    const fixture = setup('queued-delivery', { chunks: ['frame=25 time=00:00:05.00 speed=1.0x\r'] });
    await fixture.run();
    expect(fixture.progress).toEqual([expect.objectContaining({ pct: 50 })]);
    expect(fixture.progress.some(item => item.done || item.pct === 100)).toBe(false);
  });

  it('stale sender suppression also applies to failed terminal notifications', async () => {
    const fixture = setup('direct', { code: 1, shouldSend: () => false });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent).toEqual([]);
    expect(fixture.progress.at(-1)).toMatchObject({ done: true, outcome: 'failed' });
  });

  it.each(['direct', 'queued-delivery'])('%s retains stream maps and progress across arbitrary pipe chunks', async kind => {
    const fixture = setup(kind, { chunks: [
      'Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_',
      'nvenc))\nframe= 150 ti',
      'me=00:00:05.00 speed=2.0x\r',
    ] });
    const result = await fixture.run();
    expect.soft(result.maps).toEqual(['h264 (native) -> h264 (h264_nvenc)']);
    expect(fixture.progress).toContainEqual(expect.objectContaining({ pct: 50, etaS: 2.5 }));
  });

  it.each(['direct', 'queued-delivery'])('%s reports latest complete progress when one chunk has multiple CR records', async kind => {
    const fixture = setup(kind, { chunks: ['frame=30 time=00:00:01.00 speed=1.0x\rframe=240 time=00:00:08.00 speed=2.0x\r'] });
    await fixture.run();
    expect(fixture.progress.filter(item => !item.done).at(-1)).toMatchObject({ pct: 80, etaS: 2 / 1.5 });
  });

  it.each(['direct', 'queued-delivery'])('%s preserves split UTF8 diagnostics and parses last record without newline', async kind => {
    const bytes = Buffer.from('來源字幕測試\nStream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))\r\nframe=150 time=00:00:05.00 speed=2.0x');
    const fixture = setup(kind, { chunks: [...bytes].map(value => Buffer.from([value])) });
    const result = await fixture.run();
    expect(result.maps).toEqual(['h264 (native) -> h264 (libx264)']);
    expect(result.tail).toBe(bytes.toString());
    expect(fixture.stderr.join('')).toBe(bytes.toString());
    expect(fixture.progress).toContainEqual(expect.objectContaining({ pct: 50, etaS: 2.5 }));
  });

  it.each(['direct', 'queued-delivery'])('%s flushes complete EOF map but rejects a truncated map ending at an inner parenthesis', async kind => {
    const partial = setup(kind, { chunks: ['Stream #0:0 -> #0:0 (h264 (native)'] });
    expect((await partial.run()).maps).toEqual([]);
    const complete = setup(kind, { chunks: ['Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))'] });
    expect((await complete.run()).maps).toEqual(['h264 (native) -> h264 (libx264)']);
  });

  it.each(['direct', 'queued-delivery'])('%s discards an oversized incomplete record and recovers at the next delimiter', async kind => {
    const fixture = setup(kind, { chunks: [
      'noise'.repeat(20000), 'time=00:00:09.00 speed=1.0x\r',
      'frame=150 time=00:00:05.00 speed=2.0x\n',
    ] });
    await fixture.run();
    expect(fixture.progress.filter(item => !item.done).map(item => item.pct)).toEqual([50]);
  });

  it('failure log retains original UTF8 bytes after parser framing', async () => {
    const bytes = Buffer.from('來源字幕測試\r\nUnknown encoder\n');
    const fixture = setup('direct', { code: 1, chunks: [...bytes].map(value => Buffer.from([value])) });
    const failure = await fixture.run().catch(error => error);
    const logPath = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(failure.message)[1];
    expect(fs.readFileSync(logPath).subarray(-bytes.length)).toEqual(bytes);
  });
});

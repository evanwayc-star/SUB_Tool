// @subtool-ci windows
import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { nativeTestTools } from './fixtures/native-tools.cjs';
const require = createRequire(import.meta.url);
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { captureOutputDirectory, captureOutputAuthority, captureDestinationEvidence } = require('../electron/export-lease.js');
const { assertDeliveryInputEvidence } = require('../electron/delivery-temporary-input.js');
const { ffmpeg, ffprobe } = nativeTestTools();

it.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('real runner writes optional Unicode MP4/MOV chapters at delivery times and cleans its metadata', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-chapters-native-'));
  const tempDir = path.join(root, 'temp');
  const probe = createMediaProbe({ executable: ffprobe });
  const run = args => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2', '-filter_complex_threads', '2', ...args],
      { cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
  };
  try {
    const source = path.join(root, 'source.mov');
    run(['-y', '-f', 'lavfi', '-i', 'color=blue:s=64x48:r=25:d=2', '-c:v', 'libx264', '-threads', '2', source]);
    for (const format of ['h264', 'prores']) {
      let sourceWithChapters = null;
      for (const enabled of [true, false]) {
        const outPath = path.join(root, `${format}-${enabled}.${format === 'h264' ? 'mp4' : 'mov'}`);
        const progress = [];
        const runner = createDeliveryRunner({
          queue: { assertJobCapabilities() {}, registerActiveJob() {}, clearActiveJob() {}, reportProgress(_id, event) { progress.push(event); } },
          queueDir: () => root, tempDir, mediaProbe: () => probe,
          nativeCapabilities: { assertReady: async () => {} },
          encoder: { hwdecArgs: () => [], name: () => 'libx264',
            bitrateArgs: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2'],
            proresArgs: () => ['-c:v', 'prores_ks', '-threads', '2', '-c:a', 'pcm_s16le'] },
          runFfmpeg: async (args, options) => {
            assertDeliveryInputEvidence(options.inputEvidence);
            expect(options.inputEvidence.filter(item => item.path.endsWith('.ffmetadata'))).toHaveLength(enabled ? 1 : 0);
            const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '2', ...args],
              { cwd: options.cwd, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
            if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
            return { maps: [] };
          },
        });
        await runner.run({ id: `${format}-${enabled}`, outputAuthority: captureDestinationEvidence(captureOutputAuthority(outPath, captureOutputDirectory(root))),
          payload: { clips: [{ path: enabled ? source : sourceWithChapters, in: 0, out: 2, offset: 0, vtrack: 0, natW: 64, natH: 48 }],
            videoTracks: [{ vt: 0 }], width: 64, height: 48, fps: 25, duration: 2, format, outPath, videoKbps: 1000,
            chapters: enabled ? [{ start: .4, title: '備註：海 #1;=\\', kind: 'note' },
              { start: .8, title: '自訂字幕：舊佇列已移除' }, { start: 1.2, title: '備註：原文 ／ 自訂字幕：你好', kind: 'note' }] : [] } });
        expect(progress.at(-1)).toMatchObject({ done: true });
        expect(fs.readdirSync(tempDir)).toEqual([]);
        const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_chapters', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', outPath], { windowsHide: true });
        expect(inspected.status).toBe(0);
        const media = JSON.parse(inspected.stdout);
        expect(media.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ width: 64, height: 48 });
        expect(media.chapters.map(chapter => [Number(chapter.start_time), chapter.tags.title.trimEnd()])).toEqual(enabled
          ? [[0, '影片開始'], [.4, '備註：海 #1;=\\'], [1.2, '備註：原文 ／ 自訂字幕：你好']] : []);
        if (enabled) sourceWithChapters = outPath;
      }
    }
  } finally {
    await probe.cancelAllAndWait();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-chapters-native-')) throw new Error('不安全的測試清理目錄');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}, 30000);

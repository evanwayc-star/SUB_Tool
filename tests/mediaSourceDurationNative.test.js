// @subtool-ci windows
// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const dom = vi.hoisted(() => {
  const elements = new Map();
  return { video: { style: {}, pause: vi.fn(), src: '', currentTime: 0, readyState: 0 },
    $(id) { if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() }, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) }); return elements.get(id); } };
});
vi.mock('../src/dom.js', () => dom);
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn(), showToast: vi.fn(), showOsd: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn(), updateNoteActive: vi.fn() }));
vi.mock('../src/subtitles.js', () => ({ selectCueSingle: vi.fn(), commitCueTimeEdit: vi.fn() }));
vi.mock('../src/subtitle-model.js', () => ({ addCue: vi.fn(), cueTrackLocked: vi.fn(), snapAllCuesToFrames: vi.fn() }));
const require = createRequire(import.meta.url);
const { createMediaProbe } = require('../electron/media-probe.js');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
let Media, State, Seq, probe;
const roots = [];
beforeAll(async () => {
  probe = createMediaProbe({ executable: FFPROBE });
  Object.defineProperty(window, 'subtool', { configurable: true, value: { isDesktop: true,
    probe: file => probe.describe(file), fileURL: async file => `file:///${file}` } });
  ({ Media } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
  ({ Seq } = await import('../src/sequence.js'));
});
beforeEach(() => {
  Media.reset(); State.clips = []; State.videoTracks = []; State.duration = 0;
  vi.spyOn(Media, 'ensureClipRuntime').mockResolvedValue();
  vi.spyOn(Media, 'ensurePrimaryPreviewProxy').mockResolvedValue();
});
afterEach(async () => {
  vi.restoreAllMocks(); Media.reset(); await probe.cancelAllAndWait(); probe.resume();
  for (const directory of roots.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-source-duration-')) throw new Error('拒絕清除未核對的來源時長測試目錄');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('非零來源 PTS 的公開媒體匯入時長', () => {
  it.each(['mkv', 'mov'].flatMap(extension => [2, 4].map(audioLength => ({ extension, audioLength }))))('$extension：非零 PTS 依來源時長匯入，保留長 $audioLength 秒的音訊尾端', async ({ extension, audioLength }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-source-duration-')); roots.push(directory);
    const source = path.join(directory, `mother.${extension}`);
    const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-itsoffset', '5', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', '6', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${audioLength}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source],
    { windowsHide: true, timeout: 20000 });
    expect(result.error || result.status, result.stderr?.toString()).toBe(0);
    const clip = await Media.addClipDesktop(source);
    const duration = Math.max(3, audioLength + 1);
    expect(clip.dur).toBeCloseTo(duration, 5);
    expect(Seq.clipEnd(clip)).toBeCloseTo(duration, 5);
    expect(State.duration).toBeCloseTo(duration, 5);
  }, 30000);
});

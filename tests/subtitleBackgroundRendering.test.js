import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderASS } from '../src/ass-render.js';
import { STYLE_DEFAULTS } from '../src/substyle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
const WIDTH = 960;
const HEIGHT = 540;

function renderSubtitleFrame(assText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-bgbox-'));
  try {
    writeFileSync(path.join(dir, 'sample.ass'), assText, 'utf8');
    const result = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=white:s=${WIDTH}x${HEIGHT}:d=1`,
      '-vf', 'ass=sample.ass', '-frames:v', '1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { cwd: dir, encoding: null, maxBuffer: WIDTH * HEIGHT * 4 });
    if (result.status !== 0) {
      throw new Error(Buffer.from(result.stderr || '').toString('utf8'));
    }
    expect(result.stdout).toHaveLength(WIDTH * HEIGHT * 3);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rowBackgroundLevels(rgb) {
  const rows = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    const samples = [];
    for (let x = 120; x < WIDTH - 120; x += 1) {
      const i = (y * WIDTH + x) * 3;
      const value = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
      if (value < 240) samples.push(value);
    }
    if (samples.length < 100) continue;
    samples.sort((a, b) => a - b);
    rows.push({
      y,
      width: samples.length,
      median: samples[Math.floor(samples.length / 2)],
      darkWidth: samples.filter(value => value < 100).length,
    });
  }
  return rows;
}

function measureBackground(ass) {
  const rows = rowBackgroundLevels(renderSubtitleFrame(ass));
  const counts = new Map();
  rows.forEach(row => counts.set(row.median, (counts.get(row.median) || 0) + 1));
  const singleBackground = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const wideBands = rows
      .filter(row => row.darkWidth >= 100)
      .map(row => row.median);
  const darkestWideBand = wideBands.length ? Math.min(...wideBands) : singleBackground;
  return { singleBackground, darkestWideBand, rows };
}

const describeWithBundledFfmpeg = process.platform === 'win32' && existsSync(FFMPEG)
  ? describe : describe.skip;

describeWithBundledFfmpeg('ASS 多行字幕底色', () => {
  it.each([
    { label: '一般外擴', outline: 2, shadow: 0 },
    { label: '使用者把外擴設為 0', outline: 0, shadow: 0 },
    { label: '明確啟用陰影', outline: 2, shadow: 4 },
  ])('$label：相鄰兩行不會重疊成較深色的橫帶', ({ outline, shadow }) => {
    const track = {
      ...STYLE_DEFAULTS,
      font: 'Arial',
      fontSize: 80,
      posX: 50,
      posY: 50,
      align: 'center',
      valign: 'middle',
      lineSpacing: 1,
      outline,
      shadow,
      bgBox: true,
      bgColor: '#000000',
      bgAlpha: 0.5,
    };
    const ass = renderASS([
      { id: 'two-lines', track: 0, start: 0, end: 1, text: 'MMMMMMMMMMMM\nMMMMMMMMMMMMMMMM' },
    ], { fps: 30, tracks: [track] })
      // 只隱藏主色文字，保留正式輸出的 BorderStyle=3 背景幾何，讓像素判讀不受字形影響。
      .replace(/(Dialogue:.*?\\pos\([^)]*\))/, '$1{\\1a&HFF&}');

    const { singleBackground, darkestWideBand, rows } = measureBackground(ass);
    expect(rows.length).toBeGreaterThan(20);
    expect(singleBackground).toBeTypeOf('number');
    expect(darkestWideBand).toBeGreaterThanOrEqual(singleBackground - 20);
    if (shadow === 0) {
      // 50% 黑底疊在白畫面上應約為 128；若偷偷強制 Shadow=1，整塊會再合成一次而落到約 64。
      expect(singleBackground).toBeGreaterThanOrEqual(110);
      expect(singleBackground).toBeLessThanOrEqual(145);
    }
  });
});

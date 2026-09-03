import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderASS } from '../src/formats.js';
import { STYLE_DEFAULTS } from '../src/substyle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
const SARASA_FONT = path.join(ROOT, 'font', '更紗黑體', 'sarasa-mono-tc-nerd-regular.ttf');
const WIDTH = 960;
const HEIGHT = 540;
const LONG_SINGLE_LINE = '（ALMA鳥類學家認為牠「體型頗大、但稱不上巨大」） （ALMA銀行）。 （肥後通知） （ALMA假期：探索自由） （ALMA愛你） （全新升級、幸福加量）';

function renderSubtitleFrame(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-subtitle-lines-'));
  try {
    const track = {
      ...STYLE_DEFAULTS,
      font: 'Sarasa Mono TC',
      fontSize: 70,
      posX: 50,
      posY: 50,
      align: 'center',
      valign: 'middle',
      outline: 0,
      shadow: 0,
      bgBox: false,
    };
    const ass = renderASS([
      { id: 'line-break-contract', track: 0, start: 0, end: 1, text },
    ], { fps: 30, tracks: [track] });
    writeFileSync(path.join(dir, 'sample.ass'), ass, 'utf8');
    mkdirSync(path.join(dir, 'fonts'));
    copyFileSync(SARASA_FONT, path.join(dir, 'fonts', path.basename(SARASA_FONT)));
    const result = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:d=1`,
      '-vf', 'ass=sample.ass:fontsdir=fonts', '-frames:v', '1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { cwd: dir, encoding: null, maxBuffer: WIDTH * HEIGHT * 4 });
    if (result.status !== 0) {
      throw new Error(Buffer.from(result.stderr || '').toString('utf8'));
    }
    return { ass, rgb: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inkBounds(rgb) {
  const bounds = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 3;
      if (Math.max(rgb[index], rgb[index + 1], rgb[index + 2]) < 24) continue;
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  }
  return {
    ...bounds,
    width: bounds.right - bounds.left + 1,
    height: bounds.bottom - bounds.top + 1,
  };
}

const describeWithBundledFfmpeg = process.platform === 'win32' && existsSync(FFMPEG)
  ? describe : describe.skip;

describeWithBundledFfmpeg('字幕手動換行契約', () => {
  it('來源沒有換行字元時，libass 不得自行折成多個視覺行', () => {
    const short = renderSubtitleFrame('沒有手動換行');
    const long = renderSubtitleFrame(LONG_SINGLE_LINE);
    const shortBounds = inkBounds(short.rgb);
    const longBounds = inkBounds(long.rgb);

    expect(shortBounds.height).toBeGreaterThan(0);
    expect(long.ass).toContain('WrapStyle: 2');
    expect(long.ass).not.toContain('ALMA銀行）\\N');
    expect(longBounds.height, JSON.stringify({ shortBounds, longBounds }))
      .toBeLessThanOrEqual(shortBounds.height + 4);
  });

  it('來源有手動換行時，libass 保留兩個視覺行', () => {
    const short = renderSubtitleFrame('沒有手動換行');
    const manual = renderSubtitleFrame('第一行字幕\n第二行字幕');
    const shortBounds = inkBounds(short.rgb);
    const manualBounds = inkBounds(manual.rgb);

    expect(manual.ass).toContain('第一行字幕\\N第二行字幕');
    expect(manualBounds.height).toBeGreaterThan(shortBounds.height * 1.5);
  });
});

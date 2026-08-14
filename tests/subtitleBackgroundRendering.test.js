import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderASS } from '../src/ass-render.js';
import { planSubtitleBackgroundLayouts } from '../src/subtitle-background-layout.js';
import { STYLE_DEFAULTS, styleToCss, subtitleBackgroundCssMetrics } from '../src/substyle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MEASURE_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'subtitle-background-measure.cjs');
const SARASA_FONT = path.join(ROOT, 'font', '更紗黑體', 'sarasa-mono-tc-nerd-regular.ttf');
const WIDTH = 960;
const HEIGHT = 540;

function renderSubtitleFrame(assText, { sourceColor = 'white', fontPath = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-bgbox-'));
  try {
    writeFileSync(path.join(dir, 'sample.ass'), assText, 'utf8');
    let assFilter = 'ass=sample.ass';
    if (fontPath) {
      mkdirSync(path.join(dir, 'fonts'));
      copyFileSync(fontPath, path.join(dir, 'fonts', path.basename(fontPath)));
      assFilter += ':fontsdir=fonts';
    }
    const result = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${sourceColor}:s=${WIDTH}x${HEIGHT}:d=1`,
      '-vf', assFilter, '-frames:v', '1',
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

function measureChromiumLines(lines, track) {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-chromium-measure-'));
  try {
    const metrics = subtitleBackgroundCssMetrics(track, 1);
    const configPath = path.join(dir, 'measure.json');
    writeFileSync(configPath, JSON.stringify({
      lines,
      css: styleToCss({ ...track, bgBox: false, outline: 0, shadow: 0, angle: 0 }, 1),
      family: track.font,
      fontPath: SARASA_FONT,
      fontSpec: `${track.bold ? '700 ' : '400 '}${metrics.fontSize}px "${track.font}"`,
    }), 'utf8');
    const result = spawnSync(ELECTRON, [MEASURE_FIXTURE, configPath, '--no-sandbox'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    });
    if (result.status !== 0) throw new Error(result.stderr || `Electron 量測失敗：${result.status}`);
    const marker = String(result.stdout).split(/\r?\n/).find(line => line.startsWith('SUBTITLE_MEASURE:'));
    if (!marker) throw new Error(`Electron 未回傳量測結果：${result.stdout}\n${result.stderr}`);
    return JSON.parse(marker.slice('SUBTITLE_MEASURE:'.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function measureRenderedBounds(rgb) {
  const bounds = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
  const source = [rgb[0], rgb[1], rgb[2]];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 3;
      const changed = Math.max(
        Math.abs(rgb[i] - source[0]),
        Math.abs(rgb[i + 1] - source[1]),
        Math.abs(rgb[i + 2] - source[2]),
      ) >= 12;
      if (!changed) continue;
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  }
  return bounds;
}

function renderedMask(rgb, threshold) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const source = [rgb[0], rgb[1], rgb[2]];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 3;
      if (Math.max(
        Math.abs(rgb[i] - source[0]),
        Math.abs(rgb[i + 1] - source[1]),
        Math.abs(rgb[i + 2] - source[2]),
      ) >= threshold) mask[y * WIDTH + x] = 1;
    }
  }
  return mask;
}

function expectTextMaskInsideBackground(backgroundRgb, textRgb, label) {
  const background = renderedMask(backgroundRgb, 4);
  const text = renderedMask(textRgb, 12);
  let textPixels = 0;
  const misses = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (!text[y * WIDTH + x]) continue;
      textPixels += 1;
      let covered = false;
      for (let dy = -1; dy <= 1 && !covered; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx, py = y + dy;
          if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT && background[py * WIDTH + px]) {
            covered = true;
            break;
          }
        }
      }
      if (!covered && misses.length < 12) misses.push([x, y]);
    }
  }
  expect(textPixels, label).toBeGreaterThan(0);
  expect(misses, `${label} 未被底色遮罩包住的文字像素`).toEqual([]);
}

function dialogueLayer(ass, kind) {
  return ass.split(/\r?\n/).filter(line => {
    if (!line.startsWith('Dialogue:')) return true;
    const background = !line.includes('_Text,');
    return kind === 'background' ? background : !background;
  }).join('\n');
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
  it('多行中英混排在九種錨點都先取整段文字邊界再向外擴張', () => {
    const lines = [
      '《Synners》',
      '(1992年亞瑟·克拉克獎)',
      '',
      '《The Girl-Thing Who Went Out for Sushi》',
      '(2013年雨果獎)',
    ];
    const baseTrack = {
      ...STYLE_DEFAULTS,
      font: 'Sarasa Mono TC',
      fontSize: 60,
      outline: 2,
      shadow: 0,
      bgBox: true,
      bgColor: '#808080',
      bgAlpha: 1,
    };
    const measured = measureChromiumLines(lines, baseTrack);
    expect(measured.fontLoaded).toBe(true);

    const placements = ['left', 'center', 'right'].flatMap(align =>
      ['top', 'middle', 'bottom'].map(valign => ({
        align,
        valign,
        posX: { left: 5, center: 50, right: 95 }[align],
        posY: { top: 10, middle: 50, bottom: 90 }[valign],
      })));

    const observations = [];

    for (const placement of placements) {
      const track = { ...baseTrack, ...placement };
      const cues = [{ id: 'awards', track: 0, start: 0, end: 1, text: lines.join('\n') }];
      let measuredLine = 0;
      const backgroundLayouts = planSubtitleBackgroundLayouts(cues, [track], {
        measureLineWidth: () => measured.widths[measuredLine++],
      });
      const ass = renderASS(cues, { fps: 30, tracks: [track], backgroundLayouts });
      // 文字反鋸齒會產生灰階；同一張畫面量測會誤把它算成底色。
      // 分別燒錄底色與文字，才是兩個真實的 ink bounding box。
      const backgroundPixels = renderSubtitleFrame(dialogueLayer(ass, 'background'), {
        sourceColor: '0x00FF00', fontPath: SARASA_FONT,
      });
      const textPixels = renderSubtitleFrame(dialogueLayer(ass, 'text'), {
        sourceColor: '0x00FF00', fontPath: SARASA_FONT,
      });
      const background = measureRenderedBounds(backgroundPixels);
      const text = measureRenderedBounds(textPixels);
      const containment = {
        leftInset: text.left - background.left,
        rightInset: background.right - text.right,
        topInset: text.top - background.top,
        bottomInset: background.bottom - text.bottom,
      };
      observations.push({ placement, background, text, containment });

      expect(background.right, JSON.stringify(placement)).toBeGreaterThan(background.left);
      expect(text.right, JSON.stringify(placement)).toBeGreaterThan(text.left);
      expect(Math.min(...Object.values(containment)), JSON.stringify({ placement, background, text, containment }))
        .toBeGreaterThanOrEqual(3);
      expect(Math.abs(containment.topInset - containment.bottomInset), JSON.stringify({ placement, containment }))
        .toBeLessThanOrEqual(2);
      expect(background.right - background.left, JSON.stringify({ placement, background, text }))
        .toBeLessThan((text.right - text.left) + 90);
      expect(background.bottom - background.top, JSON.stringify({ placement, background, text }))
        .toBeLessThan((text.bottom - text.top) + 90);
    }

    const baselineWidth = observations[0].background.right - observations[0].background.left;
    const baselineHeight = observations[0].background.bottom - observations[0].background.top;
    for (const observation of observations) {
      const width = observation.background.right - observation.background.left;
      const height = observation.background.bottom - observation.background.top;
      expect(Math.abs(width - baselineWidth), JSON.stringify(observation)).toBeLessThanOrEqual(2);
      expect(Math.abs(height - baselineHeight), JSON.stringify(observation)).toBeLessThanOrEqual(2);
    }
  }, 30000);

  it('長句與旋轉時，libass 單一底色仍包住每一行文字', () => {
    const lines = [
      '作為非歐盟公民，出入境系統（EES）將以數位方式查驗您的身分，',
      '並記錄您進出歐盟的相關紀錄。',
    ];
    const baseTrack = {
      ...STYLE_DEFAULTS,
      font: 'Sarasa Mono TC',
      fontSize: 60,
      posX: 50,
      posY: 50,
      align: 'center',
      valign: 'middle',
      outline: 2,
      shadow: 0,
      bgBox: true,
      bgColor: '#808080',
      bgAlpha: 1,
    };
    const measured = measureChromiumLines(lines, baseTrack);
    expect(measured.fontLoaded).toBe(true);
    for (const placement of [
      { align: 'left', valign: 'top', posX: 10, posY: 20, angle: 0 },
      { align: 'center', valign: 'middle', posX: 50, posY: 50, angle: 0 },
      { align: 'center', valign: 'bottom', posX: 50, posY: 80, angle: 0 },
      { align: 'right', valign: 'bottom', posX: 90, posY: 80, angle: 20 },
    ]) {
      const track = { ...baseTrack, ...placement };
      const cues = [{ id: 'ees', track: 0, start: 0, end: 1, text: lines.join('\n') }];
      let measuredLine = 0;
      const backgroundLayouts = planSubtitleBackgroundLayouts(cues, [track], {
        measureLineWidth: () => measured.widths[measuredLine++],
      });
      const ass = renderASS(cues, { fps: 30, tracks: [track], backgroundLayouts });
      const backgroundPixels = renderSubtitleFrame(dialogueLayer(ass, 'background'), {
        sourceColor: '0x00FF00', fontPath: SARASA_FONT,
      });
      const textPixels = renderSubtitleFrame(dialogueLayer(ass, 'text'), {
        sourceColor: '0x00FF00', fontPath: SARASA_FONT,
      });
      const background = measureRenderedBounds(backgroundPixels);
      const text = measureRenderedBounds(textPixels);
      expectTextMaskInsideBackground(backgroundPixels, textPixels, JSON.stringify(placement));

      expect(background.right, JSON.stringify(placement)).toBeGreaterThan(background.left);
      expect(text.right, JSON.stringify(placement)).toBeGreaterThan(text.left);
      const containment = {
        leftInset: text.left - background.left,
        rightInset: background.right - text.right,
        topInset: text.top - background.top,
        bottomInset: background.bottom - text.bottom,
      };
      expect(Math.min(...Object.values(containment)), JSON.stringify({ placement, background, text, containment }))
        .toBeGreaterThanOrEqual(0);
      expect(background.right - background.left).toBeLessThan((text.right - text.left) + 90);
      expect(background.bottom - background.top).toBeLessThan((text.bottom - text.top) + 90);
    }
  }, 20000);

  it('不同長度的兩行與軟體預覽相同，共用最寬行的矩形底色', () => {
    const track = {
      ...STYLE_DEFAULTS,
      font: 'Arial',
      fontSize: 80,
      posX: 50,
      posY: 50,
      align: 'center',
      valign: 'middle',
      lineSpacing: 1,
      outline: 2,
      shadow: 0,
      bgBox: true,
      bgColor: '#000000',
      bgAlpha: 0.5,
    };
    const cues = [
      { id: 'uneven-lines', track: 0, start: 0, end: 1, text: 'MMMMMMMM\nMMMMMMMMMMMMMMMM' },
    ];
    const backgroundLayouts = planSubtitleBackgroundLayouts(cues, [track], {
      measureLineWidth: line => line.length * 50,
    });
    const ass = renderASS(cues, { fps: 30, tracks: [track], backgroundLayouts })
      .replace(/(Dialogue:[^\r\n]*?,Track0_Text,[^\r\n]*?\\pos\([^)]*\))/g, '$1{\\1a&HFF&}');

    const { rows, singleBackground } = measureBackground(ass);
    expect(rows.length).toBeGreaterThan(20);
    const firstY = rows[0].y;
    const lastY = rows.at(-1).y;
    const middleY = (firstY + lastY) / 2;
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const upperWidth = median(rows.filter(row => row.y < middleY - 2).map(row => row.width));
    const lowerWidth = median(rows.filter(row => row.y > middleY + 2).map(row => row.width));
    expect(Math.abs(upperWidth - lowerWidth)).toBeLessThanOrEqual(4);
    expect(upperWidth).toBeGreaterThanOrEqual(300);
    expect(singleBackground).toBeGreaterThanOrEqual(110);
    expect(singleBackground).toBeLessThanOrEqual(145);
    // 背景是單一 native Dialogue，不會由逐行 Box 疊出較深色橫帶。
  });

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
      .replace(/(Dialogue:.*?\\pos\([^)]*\))/g, '$1{\\1a&HFF&}');

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

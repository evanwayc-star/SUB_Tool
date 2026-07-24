/* 匯出計畫（electron/export-plan.js）。

   這些邏輯決定交付成品長什麼樣，而在抽出成獨立模組之前【一行測試都沒有】——
   它們長在 ipcMain.handle 裡，與 dialog 和 ffprobe spawn 糾纏，vitest 起不了 Electron。
   抽出接縫的整個目的就是讓這裡可以被測。

   對應 docs/技術架構說明.md §0.4（filtergraph 跳脫）與 §0.6（有產出不等於對）。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(ROOT, 'electron/export-plan.js'));

describe('模組本身保持純淨', () => {
  /* 這條是這個接縫的立身之本：一旦有人在裡面 require('electron') 或 require('fs')，
     它就再也不能在 vitest 裡跑，測試會整批消失而沒有人發現。 */
  it('原始碼裡沒有任何 require（副作用一律由呼叫端傳入）', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'electron/export-plan.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\brequire\s*\(/);
  });
});

describe('AAC 交付 bitrate 依聲道數給足', () => {
  /* 曾經的缺陷是匯出時取到播放快取 chN.m4a 的 128k。這裡鎖住交付值。 */
  it.each([
    [1, '192k'],
    [2, '320k'],
    [6, '640k'],
  ])('%i 聲道 → %s', (channels, expected) => {
    expect(P.aacBitrateForChannels(channels)).toBe(expected);
  });

  it('未知聲道數不會回 undefined（會變成 ffmpeg 的 -b:a undefined）', () => {
    for (const n of [0, 3, 7, 16, null, undefined, NaN]) {
      expect(String(P.aacBitrateForChannels(n))).toMatch(/^\d+k$/);
    }
  });
});

/* §0.4：filtergraph 會先拆選項、選項值再拆一次，所以磁碟機冒號必須跳兩層。
   只跳一層 → ffmpeg 把 ':' 當選項分隔符 → 整條 filterchain 解析失敗 → 匯出直接掛掉。 */
describe('drawtext 值的跳脫（§0.4）', () => {
  it('冒號、分號、反斜線、引號、方括號都被跳脫', () => {
    expect(P._drawtextValue('C:\\Users\\a')).toBe('C\\:/Users/a');
    expect(P._drawtextValue('a;b')).toBe('a\\;b');
    expect(P._drawtextValue("it's")).toBe("it\\'s");
    expect(P._drawtextValue('[x]')).toBe('\\[x\\]');
  });

  it('反斜線一律先轉成正斜線（Windows 路徑進 filtergraph 的前提）', () => {
    expect(P._drawtextValue('C:\\a\\b\\c')).not.toContain('\\\\');
  });
});

describe('時間碼浮水印濾鏡', () => {
  const tc = { start: '01:00:00:00', rate: 25 };

  it('沒有字型就明確報錯，不會默默產出沒有時間碼的成品', () => {
    expect(() => P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', null))
      .toThrow(/更紗黑體/);
  });

  it('字型路徑與時間碼都經過跳脫後才進 filtergraph', () => {
    const out = P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', 'C:\\font\\a.ttf');
    expect(out).toContain("fontfile='C\\:/font/a.ttf'");
    expect(out).toContain("timecode='01\\:00\\:00\\:00'");
    expect(out.startsWith('[v]')).toBe(true);
    expect(out.endsWith('[o]')).toBe(true);
  });

  /* 使用者已明確表示之後會有 4K 專案。字級是畫面短邊的 3.2%，
     所以解析度變大時時間碼會等比變大，不會在 4K 上變成一顆小點。
     容差 ±1 是四捨五入：1080×0.032=34.56→35、2160×0.032=69.12→69。 */
  it('字級隨畫面尺寸等比縮放（4K ≈ FHD 的兩倍）', () => {
    const size = (w, h) =>
      +/fontsize=(\d+)/.exec(P._buildExportTimecodeFilter('[v]', tc, w, h, '[o]', 'f.ttf'))[1];
    expect(size(3840, 2160)).toBeCloseTo(size(1920, 1080) * 2, -0.5);
    expect(Math.abs(size(3840, 2160) - size(1920, 1080) * 2)).toBeLessThanOrEqual(1);
  });

  it('tc24hmax=0：跨過 24 小時不會回捲', () => {
    expect(P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', 'f.ttf'))
      .toContain('tc24hmax=0');
  });
});

/* 這裡的設計刻意分成兩種結果，不要把它們統一：
     沒有要求浮水印（null）→ 回 null，安靜略過；
     有要求但設定壞掉      → 大聲 throw。
   若壞掉的設定也回 null，使用者會拿到一支「勾了卻沒有時間碼」的成品而不知情——
   正是 §0.6「有產出不等於對」。 */
describe('時間碼浮水印的正規化', () => {
  it('接受 HH:MM:SS:FF 並帶出速率', () => {
    const w = P._normaliseExportTimecodeWatermark({ start: '01:00:00:00' }, 25);
    expect(w).toMatchObject({ start: '01:00:00:00' });
    expect(Number(w.rate)).toBeGreaterThan(0);
  });

  it('沒有要求浮水印時回 null（安靜略過）', () => {
    expect(P._normaliseExportTimecodeWatermark(null, 25)).toBeNull();
    expect(P._normaliseExportTimecodeWatermark(undefined, 25)).toBeNull();
  });

  it('有要求但設定無效時丟出例外，不會默默匯出沒有時間碼的成品', () => {
    expect(() => P._normaliseExportTimecodeWatermark({}, 25)).toThrow(/無效/);
    expect(() => P._normaliseExportTimecodeWatermark({ start: '亂寫' }, 25)).toThrow(/無效/);
    expect(() => P._normaliseExportTimecodeWatermark({ start: '1:2' }, 25)).toThrow(/無效/);
  });
});

describe('數值進 filtergraph 前一律定點化', () => {
  /* 直接把 JS 數字塞進 filtergraph 會出現 1e-7 這種科學記號，ffmpeg 解析不了。 */
  /* 實務值域：時間（秒）、音量倍率、0..1 的位置比例。
     toFixed 在 1e21 以上才會退回科學記號，那不是這裡會出現的數字。 */
  it('_filterNumber 在實務值域內永遠是定點小數', () => {
    for (const v of [0, 1, -3.5, 0.0000001, 86400, 1e-9, 99999.999]) {
      expect(P._filterNumber(v)).not.toMatch(/e/i);
    }
  });

  it('非數值退回 fallback，不會產出 NaN', () => {
    expect(P._filterNumber('abc', 1)).toBe('1.000000');
    expect(P._filterNumber(undefined, 0)).toBe('0.000000');
    expect(P._finiteNumber(NaN, 7)).toBe(7);
  });
});

describe('WAV 交付的聲道組裝', () => {
  const plan = {
    buses: [
      { id: 'a1', name: 'A1', inputs: [{ file: 'x.mxf', stream: 0, channel: 0 }] },
      { id: 'a2', name: 'A2', inputs: [{ file: 'x.mxf', stream: 0, channel: 1 }] },
    ],
    streams: [],
  };

  it('bus 數量決定輸出聲道數，順序即 bus 順序', () => {
    const fc = [];
    const norm = P._normalizeAudioPlan(plan, { requireStreams: false });
    const planned = P._buildPlannedAudio(norm, [], fc, 0, 5);
    const wav = P._buildWavOutput(planned.busLabels, norm, fc);
    expect(wav.channels).toBe(2);
    expect(typeof wav.label).toBe('string');
  });
});

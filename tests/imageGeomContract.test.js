/* 圖片幾何的【跨行程契約】。

   同一條公式必須存在於兩個地方，因為它們跑在不同的行程與模組系統：
     src/imagegeom.js       imageBox()          → renderer（ES module，Vite 打包）
     electron/export-plan.js imageBoxForExport() → 主程序（CommonJS）

   為什麼不合併成一份：圖片是先疊進【軌影格】、軌影格再帶著自己的透明度與疊層
   順序疊到畫布。renderer 直接送畫布座標會繞過那一層，PiP 圖片軌就會壞掉。
   所以正確的接縫是「共用公式、各自套用在自己的那一層」。

   既然無法合併，就必須有機制阻止它們漂掉——就是這支測試。
   它以矩陣窮舉比對兩份實作，任何一邊被改動而另一邊沒跟上就會紅。
   對應 docs/技術架構說明.md §0.1（三路一致）。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageBox } from '../src/imagegeom.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { imageBoxForExport } = require(path.join(ROOT, 'electron/export-plan.js'));

/* 涵蓋真實會遇到的情況：不同交付比例（FHD／4K／DCI／2.35:1／直式）、
   方形與極端長寬比的素材、縮放邊界、九宮格位置。 */
const FRAMES = [
  [1920, 1080], [3840, 2160], [4096, 2160], [2048, 872], [1080, 1920], [640, 480],
];
const NATIVES = [
  [1920, 1080], [500, 500], [3000, 400], [400, 3000], [1, 1], [1234, 567],
];
const SCALES = [0.01, 0.25, 0.5, 1, 1.5, 3];
const POSITIONS = [0, 0.25, 0.5, 0.75, 1];

describe('imagegeom.imageBox ≡ export-plan.imageBoxForExport', () => {
  it('矩陣窮舉下兩份實作完全一致', () => {
    let checked = 0;
    const mismatches = [];

    for (const [fw, fh] of FRAMES) {
      for (const [nw, nh] of NATIVES) {
        for (const scale of SCALES) {
          for (const posX of POSITIONS) {
            for (const posY of POSITIONS) {
              const a = imageBox({ stageW: fw, stageH: fh, natW: nw, natH: nh, scale, posX, posY });
              const b = imageBoxForExport({ frameW: fw, frameH: fh, natW: nw, natH: nh, scale, posX, posY });
              checked++;
              for (const k of ['x', 'y', 'w', 'h']) {
                if (Math.abs(a[k] - b[k]) > 1e-9) {
                  mismatches.push(`frame ${fw}x${fh} nat ${nw}x${nh} s=${scale} p=(${posX},${posY}) ${k}: ${a[k]} vs ${b[k]}`);
                }
              }
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(4000);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  /* 這些是邊界輸入，兩邊的防禦性處理也必須一致——否則會出現
     「預覽好好的、匯出是 NaN」這種只在特定素材上發作的問題。 */
  it.each([
    ['缺原生尺寸', { natW: 0, natH: 0 }],
    ['原生尺寸為負', { natW: -100, natH: -100 }],
    ['scale 為 0', { scale: 0 }],
    ['scale 為負', { scale: -5 }],
    ['pos 超出 0..1', { posX: -1, posY: 2 }],
    ['pos 非數值', { posX: 'abc', posY: null }],
    ['scale 非數值', { scale: undefined }],
    ['畫框為 0', { frameW: 0, frameH: 0 }],
  ])('邊界情況一致：%s', (_label, over) => {
    const base = { natW: 800, natH: 600, scale: 1, posX: 0.5, posY: 0.5 };
    const args = { ...base, ...over };
    const a = imageBox({ stageW: over.frameW ?? 1920, stageH: over.frameH ?? 1080, ...args });
    const b = imageBoxForExport({ frameW: over.frameW ?? 1920, frameH: over.frameH ?? 1080, ...args });

    for (const k of ['x', 'y', 'w', 'h']) {
      expect(Number.isFinite(a[k]), `imagegeom.${k} 不是有限數：${a[k]}`).toBe(true);
      expect(b[k]).toBeCloseTo(a[k], 9);
    }
  });
});

describe('公式本身的性質（兩邊都要成立）', () => {
  const both = args => [
    imageBox({ stageW: args.frameW, stageH: args.frameH, ...args }),
    imageBoxForExport(args),
  ];

  it('contain：縮放後不超出方框，且至少一邊貼齊', () => {
    for (const r of both({ frameW: 1920, frameH: 1080, natW: 3000, natH: 400, scale: 1, posX: 0.5, posY: 0.5 })) {
      expect(r.w).toBeLessThanOrEqual(1920 + 1e-9);
      expect(r.h).toBeLessThanOrEqual(1080 + 1e-9);
      expect(Math.abs(r.w - 1920) < 1e-6 || Math.abs(r.h - 1080) < 1e-6).toBe(true);
    }
  });

  it('保持原生長寬比（contain 不可變形）', () => {
    for (const r of both({ frameW: 1920, frameH: 1080, natW: 1234, natH: 567, scale: 0.7, posX: 0.3, posY: 0.8 })) {
      expect(r.w / r.h).toBeCloseTo(1234 / 567, 6);
    }
  });

  it('posX/posY 是【中心】位置，不是左上角', () => {
    for (const r of both({ frameW: 1000, frameH: 1000, natW: 100, natH: 100, scale: 0.2, posX: 0.5, posY: 0.5 })) {
      expect(r.x + r.w / 2).toBeCloseTo(500, 6);
      expect(r.y + r.h / 2).toBeCloseTo(500, 6);
    }
  });

  it('解析度加倍時矩形等比加倍（4K 專案）', () => {
    const a = imageBoxForExport({ frameW: 1920, frameH: 1080, natW: 800, natH: 600, scale: 0.5, posX: 0.3, posY: 0.7 });
    const b = imageBoxForExport({ frameW: 3840, frameH: 2160, natW: 800, natH: 600, scale: 0.5, posX: 0.3, posY: 0.7 });
    for (const k of ['x', 'y', 'w', 'h']) expect(b[k]).toBeCloseTo(a[k] * 2, 6);
  });
});

/* 圖片疊層幾何：預覽／mpv 命中區／匯出 必須是同一組數字。
   這裡守的是 v4.7 修掉的兩個真實災情：
     A) .img-wrap 用「scale×畫框」當互動框 → 方形／直式素材的四角把手離圖片上百 px、
        下緣兩顆掉到播放列底下 → 使用者回報「圖片無法調整大小和位置」。
     B) 匯出用 pad 定位 → 非同比例素材貼齊左上（實測偏 420px），且 scale>1 讓 pad
        位移變負 → ffmpeg -22，整支匯出失敗。
   幾何公式一改就會同時破壞預覽與匯出，故一併鎖住。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageBox, trackFrame, imageBoxOnStage } from '../src/imagegeom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('imageBox：contain 之後的實際矩形', () => {
  it('方形素材放進 16:9 畫框（scale=1）→ 高度受限並置中，不是整個畫框', () => {
    const b = imageBox({ stageW: 1920, stageH: 1080, natW: 500, natH: 500, scale: 1 });
    expect(b).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
    // 舊行為（把方框當互動框）會是 x:0,w:1920 —— 把手因此離圖片 420px
    expect(b.w).not.toBe(1920);
  });

  it('同比例素材＝方框本身（16:9 圖片不受影響，向下相容）', () => {
    expect(imageBox({ stageW: 1920, stageH: 1080, natW: 1920, natH: 1080, scale: 1 }))
      .toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('直式素材同樣以高度為限', () => {
    const b = imageBox({ stageW: 1920, stageH: 1080, natW: 600, natH: 1200, scale: 1 });
    expect(b.w).toBe(540); expect(b.h).toBe(1080);
    expect(b.x).toBe(690); expect(b.y).toBe(0);
  });

  it('posX/posY 定的是圖片【中心】', () => {
    const b = imageBox({ stageW: 1000, stageH: 1000, natW: 100, natH: 100, scale: 0.2, posX: 0.25, posY: 0.75 });
    expect(b.x + b.w / 2).toBeCloseTo(250);
    expect(b.y + b.h / 2).toBeCloseTo(750);
  });

  it('scale>1 允許出血（負座標），不再是錯誤狀態', () => {
    const b = imageBox({ stageW: 1920, stageH: 1080, natW: 500, natH: 500, scale: 2, posX: 0.25 });
    expect(b.w).toBe(2160);
    expect(b.x).toBe(1920 * 0.25 - 1080); // -600：匯出端交給 overlay 自動裁切
  });

  it('natW/natH 未知時退回方框＝舊行為，不破圖', () => {
    expect(imageBox({ stageW: 1920, stageH: 1080, scale: 0.5 }))
      .toEqual({ x: 480, y: 270, w: 960, h: 540 });
  });
});

describe('trackFrame / imageBoxOnStage：視訊軌 PiP 也要跟匯出一致', () => {
  it('軌 scale/posX/posY 先框出 PiP 影格，圖片再放進去', () => {
    const f = trackFrame({ stageW: 1920, stageH: 1080, scale: 0.5, posX: 1, posY: 0 });
    expect(f).toEqual({ x: 960, y: 0, w: 960, h: 540 });

    const b = imageBoxOnStage({
      stageW: 1920, stageH: 1080, track: { scale: 0.5, posX: 1, posY: 0 },
      natW: 500, natH: 500, scale: 1, posX: 0.5, posY: 0.5,
    });
    // 圖片 contain 進 960×540 → 540×540，置中於該影格
    expect(b).toEqual({ x: 960 + 210, y: 0, w: 540, h: 540 });
  });

  it('預設軌（scale=1）＝恆等，圖片直接對到畫框', () => {
    const a = imageBoxOnStage({ stageW: 1920, stageH: 1080, track: {}, natW: 500, natH: 500, scale: 1 });
    const b = imageBox({ stageW: 1920, stageH: 1080, natW: 500, natH: 500, scale: 1 });
    expect(a).toEqual(b);
  });
});

/* 匯出端在主程序（CommonJS），這裡只守【無法用其他方式驗證】的不變量。

   幾何本身不在這裡驗——它已經由 tests/imageGeomContract.test.js 以矩陣窮舉
   直接比對兩份實作（imagegeom.imageBox ≡ export-plan.imageBoxForExport），
   那是真的執行程式碼，比在這裡比對原始碼字面可靠得多。

   這個區塊原本用 regex 鎖死 overlay 的字面寫法。批次5 把圖片幾何改成共用公式後，
   那些斷言全部變成「鎖住舊寫法、擋住正確的改動」——正是架構審查點名的
   「接縫不存在時，測試只能鎖字面」。已改為只保留下面兩條真正的不變量。 */
describe('electron/main.js 圖片分支：以原始碼守住的兩條不變量', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const branch = src.slice(src.indexOf("if (c.type === 'image') {"), src.indexOf("} else {", src.indexOf("if (c.type === 'image') {")));

  it('抓得到圖片分支', () => {
    expect(branch.length).toBeGreaterThan(200);
  });

  /* pad 不接受負位移（scale>1 直接 -22，整支匯出失敗，不只圖片壞掉），
     且它的位移必須用縮放【後】的真實尺寸算——這正是 v4.6 的兩個 bug。 */
  it('不使用 pad 定位圖片', () => {
    expect(branch).not.toMatch(/pad=/);
  });

  it('走共用公式，並保留舊專案（無 natW/natH）的退路', () => {
    expect(branch).toMatch(/imageBoxForExport\(/);
    expect(branch).toMatch(/force_original_aspect_ratio=decrease/); // fallback 仍在
  });

  /* 這條沒有別的驗法：少了 -loop 1，ffmpeg 只讀 PNG 第一格，
     整段圖片時間軸會變成黑畫面，而且不會有任何錯誤訊息。 */
  it('靜態圖片輸入帶 -loop 1 與 -framerate', () => {
    expect(src).toMatch(/inputs\.push\('-loop', '1', '-framerate', String\(R\), '-i', p\)/);
  });
});

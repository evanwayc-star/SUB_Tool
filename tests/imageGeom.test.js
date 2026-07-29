/* 圖片疊層幾何：預覽／mpv 命中區／匯出 必須是同一組數字。
   這裡守的是 v4.7 修掉的兩個真實災情：
     A) .img-wrap 用「scale×畫框」當互動框 → 方形／直式素材的四角把手離圖片上百 px、
        下緣兩顆掉到播放列底下 → 使用者回報「圖片無法調整大小和位置」。
     B) 匯出用 pad 定位 → 非同比例素材貼齊左上（實測偏 420px），且 scale>1 讓 pad
        位移變負 → ffmpeg -22，整支匯出失敗。
   幾何公式一改就會同時破壞預覽與匯出，故一併鎖住。 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
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

/* 匯出端的圖片分支。

   【以前只能鎖原始碼字面】這一段本來是 `readFileSync('electron/main.js')` 再用
   regex 找 `pad=` 與 `-loop 1`——因為那段程式長在 ipcMain.handle 裡，vitest 起不了
   Electron，只能退而求其次去比對字串。那種測試會鎖住舊寫法、擋住正確的改動。

   argv 組建搬進 export-plan.js（零 require）之後，這裡改成【真的產生 argv 再斷言】。 */
describe('匯出圖片片段：直接檢查產生的 ffmpeg 參數', () => {
  const require_ = createRequire(import.meta.url);
  const { buildDeliveryArgv } = require_(path.join(ROOT, 'electron/export-plan.js'));

  const argvFor = clip => buildDeliveryArgv({
    format: 'mp4', width: 1920, height: 1080, fps: 25, duration: 10,
    videoKbps: 8000, audioPlan: null, timecodeWatermark: null,
    assFileName: null, outPath: 'C:/out/deliverable.mp4',
    videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
    clips: [clip],
  }, { hasAudioStream: () => false });

  const image = {
    type: 'image', path: 'C:/source/card.png', vtrack: 0,
    in: 0, out: 8, offset: 0, fadeIn: 0, fadeOut: 0,
    scale: 1, posX: 0.5, posY: 0.5, natW: 500, natH: 500,
  };
  const filtergraph = argv => argv[argv.indexOf('-filter_complex') + 1];

  /* 這條沒有別的驗法：少了 -loop 1，ffmpeg 只讀 PNG 第一格，
     整段圖片時間軸會變成黑畫面，而且不會有任何錯誤訊息。 */
  it('靜態圖片輸入帶 -loop 1 與 -framerate（否則整段變黑畫面且不報錯）', () => {
    const { args } = argvFor(image);
    expect(args.join(' ')).toContain("-loop 1 -framerate 25 -i C:/source/card.png");
  });

  /* pad 不接受負位移（scale>1 直接 -22，整支匯出失敗，不只圖片壞掉），
     且它的位移必須用縮放【後】的真實尺寸算——這正是 v4.6 的兩個 bug。 */
  it('不使用 pad 定位圖片', () => {
    const fc = filtergraph(argvFor(image).args);
    const imageChains = fc.split(';').filter(chain => /overlay=x=\d|scale=\d+:\d+,/.test(chain));
    expect(imageChains.join(';')).not.toMatch(/pad=/);
  });

  /* 三路一致：匯出的 overlay 座標必須等於預覽用的 imageBox()，不是「差不多」。
     以前這裡只能斷言原始碼裡出現 `imageBoxForExport(`——那證明不了數字相同。 */
  it('overlay 座標＝預覽 imageBox() 的同一組數字', () => {
    const fc = filtergraph(argvFor(image).args);
    const box = imageBox({ stageW: 1920, stageH: 1080, natW: 500, natH: 500, scale: 1, posX: 0.5, posY: 0.5 });

    expect(fc).toContain(`scale=${Math.round(box.w)}:${Math.round(box.h)}`);
    expect(fc).toContain(`overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}`);
  });

  it('scale>1 的出血用負座標表達，不會變成 pad 的負位移', () => {
    const fc = filtergraph(argvFor({ ...image, scale: 2, posX: 0.25 }).args);
    const box = imageBox({ stageW: 1920, stageH: 1080, natW: 500, natH: 500, scale: 2, posX: 0.25, posY: 0.5 });

    expect(box.x).toBeLessThan(0);
    expect(fc).toContain(`overlay=x=${Math.round(box.x)}:`);
  });

  it('舊專案沒有 natW/natH 時退回 force_original_aspect_ratio=decrease，不破圖', () => {
    const { natW, natH, ...legacy } = image;
    expect(filtergraph(argvFor(legacy).args)).toContain('force_original_aspect_ratio=decrease');
  });
});

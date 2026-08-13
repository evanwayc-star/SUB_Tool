/* 圖片疊層幾何：預覽／mpv guide／匯出 必須是同一組數字。
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
import { imageBox, trackFrame, imageBoxOnStage, fitScale } from '../src/image-geometry.js';

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

/* 「符合視窗」＝維持目前中心位置，等比例縮放到最先碰到的邊界為止。
   位置會影響答案：中心偏右時右側可用空間變小，倍率就得跟著變小。
   這幾個數字都在網頁版真機驗證過（0.711 = 768/1080）。 */
describe('fitScale：符合視窗的倍率', () => {
  const square = { stageW: 1920, stageH: 1080, natW: 500, natH: 500 };

  it('方形素材置中於 16:9 → 高度先碰到，倍率為 1（框滿畫面）', () => {
    expect(fitScale({ ...square })).toEqual({ scale: 1, recentred: false });
  });

  it('中心偏右時倍率變小（右側可用空間先用完）', () => {
    // 中心 x=1536，右側只剩 384 → 可用寬 768；素材在 scale=1 時是 1080 寬
    const { scale, recentred } = fitScale({ ...square, posX: 0.8 });
    expect(scale).toBeCloseTo(768 / 1080, 3);
    expect(recentred).toBe(false);
  });

  it('偏左與偏右對稱', () => {
    expect(fitScale({ ...square, posX: 0.2 }).scale)
      .toBeCloseTo(fitScale({ ...square, posX: 0.8 }).scale, 6);
  });

  /* 貼齊邊緣時可用空間為 0，倍率會趨近 0——那個結果沒有意義，
     所以改為置中重算並回報 recentred，讓呼叫端把位置一起改回置中。 */
  it('貼齊邊緣時改為置中重算，並回報 recentred', () => {
    expect(fitScale({ ...square, posX: 0 })).toEqual({ scale: 1, recentred: true });
    expect(fitScale({ ...square, posY: 1 })).toEqual({ scale: 1, recentred: true });
  });

  it('直式素材以寬度為限', () => {
    // 600x1200 放進 1920x1080：contain 後是 540x1080，可用寬 1920 → 1920/540
    const { scale } = fitScale({ stageW: 1920, stageH: 1080, natW: 600, natH: 1200 });
    expect(scale).toBeCloseTo(Math.min(1920 / 540, 1080 / 1080), 3);
  });

  it('沒有原始尺寸時退回「框＝畫面」，置中倍率為 1', () => {
    expect(fitScale({ stageW: 1920, stageH: 1080 }).scale).toBeCloseTo(1, 6);
  });

  it('倍率夾在 min/max 之間，不會回傳 0 或爆量', () => {
    const r = fitScale({ stageW: 1920, stageH: 1080, natW: 1, natH: 100000 });
    expect(r.scale).toBeGreaterThanOrEqual(0.02);
    expect(r.scale).toBeLessThanOrEqual(8);
  });

  it('畫面尺寸為 0 時不丟例外', () => {
    expect(() => fitScale({ stageW: 0, stageH: 0, natW: 10, natH: 10 })).not.toThrow();
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

/* 逐片段影片幾何（v5.7.0）。

   在此之前影片段沒有自己的 scale／posX／posY：匯出是
   `scale=SW:SH:force_original_aspect_ratio=decrease` + pad 置中，把素材釘死在軌影格
   正中央；預覽端則是「素材直接 contain 進畫布再乘軌 scale」——少了「軌影格」那一層。

   兩者在素材比例＝專案比例時剛好一致，所以一直沒被發現；素材比例不同且該軌是 PiP
   或非置中時，實測差到 120px（4:3 素材、軌 scale=0.5、posX=1）。

   現在影片與圖片走同一條路，且都以 image-geometry 的公式為準。下面這些數字全部
   以真實 ffmpeg 匯出＋逐像素量測驗證過（見開發與驗證.md §4.16）。 */
describe('影片段幾何：與圖片共用同一條公式', () => {
  const require_ = createRequire(import.meta.url);
  const { buildDeliveryArgv } = require_(path.join(ROOT, 'electron/export-plan.js'));
  const W = 1920, H = 1080, NATW = 640, NATH = 480;   // 4:3 素材放進 16:9 專案

  const fcFor = (clip, track) => {
    const { args } = buildDeliveryArgv({
      format: 'mp4', width: W, height: H, fps: 25, duration: 3, videoKbps: 6000,
      audioPlan: null, timecodeWatermark: null, assFileName: null, outPath: 'C:/o.mp4',
      videoTracks: [track],
      clips: [{ path: 'C:/a.mov', type: 'video', vtrack: 0, in: 0, out: 3, offset: 0,
                natW: NATW, natH: NATH, ...clip }],
    }, { hasAudioStream: () => false });
    return args[args.indexOf('-filter_complex') + 1];
  };

  /* 舊專案（沒設過逐片段幾何）的輸出不可以變。真機比對已確認新舊畫面矩形
     都是 {x:240,y:0,w:1440,h:1080}；這裡鎖住產生那個結果的參數。 */
  it('預設幾何＝素材 contain 進整個軌影格並置中', () => {
    const fc = fcFor({}, { vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 });
    const box = imageBoxOnStage({ stageW: W, stageH: H, track: { scale: 1, posX: 0.5, posY: 0.5 },
      natW: NATW, natH: NATH, scale: 1, posX: 0.5, posY: 0.5 });
    expect(box).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    expect(fc).toContain(`scale=${Math.round(box.w)}:${Math.round(box.h)}`);
    expect(fc).toContain(`overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}`);
  });

  it('影片段可以有自己的縮放與位置（以前完全沒有這個能力）', () => {
    const fc = fcFor({ scale: 0.4, posX: 0.85, posY: 0.15 }, { vt: 0 });
    const box = imageBoxOnStage({ stageW: W, stageH: H, track: {},
      natW: NATW, natH: NATH, scale: 0.4, posX: 0.85, posY: 0.15 });
    expect(fc).toContain(`scale=${Math.round(box.w)}:${Math.round(box.h)}`);
    expect(fc).toContain(`overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}`);
  });

  /* 軌影格與片段方框是兩層，順序不能顛倒：先用軌 scale/pos 框出影格
     （available-space 定位），片段再在影格內以【中心】定位。 */
  it('軌 PiP 與片段幾何疊加時，兩層順序正確', () => {
    const track = { vt: 0, scale: 0.5, posX: 1, posY: 0 };
    const fc = fcFor({ scale: 0.6, posX: 0.2, posY: 0.8 }, track);
    const box = imageBoxOnStage({ stageW: W, stageH: H, track,
      natW: NATW, natH: NATH, scale: 0.6, posX: 0.2, posY: 0.8 });
    // 軌影格 960×540 位於 (960,0)；片段方框在影格內以中心定位
    expect(fc).toContain(`scale=${Math.round(box.w)}:${Math.round(box.h)}`);
  });

  /* 影片不再走 pad：pad 的位移不接受負值，片段放大／偏移出界時會讓
     整支匯出失敗（-22），這正是 v4.6 圖片踩過的坑。 */
  it('影片段不使用 pad 定位', () => {
    const fc = fcFor({ scale: 1.6, posX: 0.1 }, { vt: 0 });
    expect(fc).not.toMatch(/pad=/);
  });

  it('舊專案沒有 natW/natH 時退回 ffmpeg 自算，仍套用片段位置', () => {
    const { args } = buildDeliveryArgv({
      format: 'mp4', width: W, height: H, fps: 25, duration: 3, videoKbps: 6000,
      audioPlan: null, timecodeWatermark: null, assFileName: null, outPath: 'C:/o.mp4',
      videoTracks: [{ vt: 0 }],
      clips: [{ path: 'C:/a.mov', type: 'video', vtrack: 0, in: 0, out: 3, offset: 0, scale: 0.5, posX: 0.25 }],
    }, { hasAudioStream: () => false });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('force_original_aspect_ratio=decrease');
    expect(fc).toContain('overlay=x=(W*0.2500)-(w/2)');
  });
});

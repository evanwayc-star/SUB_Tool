/* 片段淡入淡出的【跨行程契約】。

   ⚠ v6.1.2 起【視窗規則】只有一份：`shared/clip-fade.cjs`（clipLength／fadeWindow）。
     以前這裡說「主程序不能 import renderer 的 ES module」——那個障礙用一支
     CommonJS 純模組就解決了（見 shared/README.md）。`electron/export-plan.js`
     原本把長度下限 `Math.max(0.001, out-in)` 內聯了三處，現在都改吃 clipLength()。

   真正無法合併的是【表達】：匯出側要的不是「某一刻的 alpha」，
   而是要餵給 ffmpeg 的 `st=` 與 `d=` 參數。
   接縫是「共用同一份規格、各自表達成自己那一路的東西」——
   共用的部分現在真的共用了，各自表達的部分仍由本檔守著。
   對照 tests/imageGeomContract.test.js（幾何側）與
   tests/subtitleStyleContract.test.js（樣式側），這是第三道同型的守衛。

   壞掉的樣子：預覽裡圖片已經淡完，匯出的影片卻還亮著（或反過來）。
   不會報錯，只有把兩邊的畫面並排比對才看得出來。 */
import { describe, expect, it } from 'vitest';
import { clipLength, fadeAlphaAt, fadeAlphaAtTimeline, fadeWindow } from '../src/clip-fade.js';
import { buildDeliveryArgv } from '../electron/export-plan.js';

const clip = (o = {}) => ({
  name: 'a.mov', path: 'C:/a.mov', type: 'video',
  in: o.in ?? 0, out: o.out ?? 10, offset: o.offset ?? 0, vtrack: 0,
  audio: [], fadeIn: o.fadeIn ?? 0, fadeOut: o.fadeOut ?? 0,
});

/* 從 argv 撈出影像／音訊 fade 的 st 與 d。 */
function fadeParamsFrom(argv) {
  const fc = argv.join(' ');
  const grab = re => [...fc.matchAll(re)].map(m => m.groups);
  return {
    vIn: grab(/fade=t=in:st=(?<st>[\d.]+):d=(?<d>[\d.]+):alpha=1/g),
    vOut: grab(/fade=t=out:st=(?<st>[\d.]+):d=(?<d>[\d.]+):alpha=1/g),
    aIn: grab(/afade=t=in:st=(?<st>[\d.]+):d=(?<d>[\d.]+)/g),
    aOut: grab(/afade=t=out:st=(?<st>[\d.]+):d=(?<d>[\d.]+)/g),
  };
}

function argvFor(c) {
  const { args } = buildDeliveryArgv({
    clips: [c],
    videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
    width: 1920, height: 1080, fps: 25,
    duration: clipLength(c),
    format: 'h264', videoKbps: 8000,
    outPath: 'C:\\out\\a.mp4',
  }, { ffmpeg: 'ffmpeg' });
  return args;
}

const MATRIX = [
  { label: '只有淡入', c: { out: 10, fadeIn: 2 } },
  { label: '只有淡出', c: { out: 10, fadeOut: 3 } },
  { label: '淡入淡出都有', c: { out: 12, fadeIn: 1.5, fadeOut: 2.5 } },
  { label: '修剪過的片段（in 不為 0）', c: { in: 4, out: 14, fadeIn: 2, fadeOut: 2 } },
  { label: '淡入長度超過片段長度', c: { out: 3, fadeIn: 9 } },
  { label: '淡出長度超過片段長度', c: { out: 3, fadeOut: 9 } },
  { label: '極短片段', c: { in: 0, out: 0.05, fadeIn: 0.02, fadeOut: 0.02 } },
];

describe('片段淡入淡出跨行程契約：預覽規格 ↔ 匯出 filtergraph', () => {
  for (const { label, c: over } of MATRIX) {
    describe(label, () => {
      const c = clip(over);
      const win = fadeWindow(c);
      const argv = argvFor(c);
      const got = fadeParamsFrom(argv);

      it('片段長度兩邊一致', () => {
        // 匯出側以 clen = max(0.001, out - in) 當基準；沒有淡出時看淡入的 d 上限
        expect(win.length).toBeCloseTo(Math.max(0.001, c.out - c.in), 6);
      });

      it('淡入：st 一律為 0，d 等於夾過長度後的淡入秒數', () => {
        if (win.fadeIn <= 0) { expect(got.vIn).toHaveLength(0); return; }
        expect(got.vIn.length).toBeGreaterThan(0);
        expect(Number(got.vIn[0].st)).toBe(0);
        expect(Number(got.vIn[0].d)).toBeCloseTo(win.fadeIn, 3);
      });

      it('淡出：st 等於 length − fadeOut，d 等於夾過長度後的淡出秒數', () => {
        if (win.fadeOut <= 0) { expect(got.vOut).toHaveLength(0); return; }
        expect(got.vOut.length).toBeGreaterThan(0);
        expect(Number(got.vOut[0].st)).toBeCloseTo(win.fadeOutStart, 3);
        expect(Number(got.vOut[0].d)).toBeCloseTo(win.fadeOut, 3);
      });

      /* 預覽的斜坡必須落在匯出宣告的同一個視窗內：
         淡入結束那一刻要滿版、淡出開始那一刻也要滿版。 */
      it('預覽的 alpha 斜坡與匯出宣告的視窗對得上', () => {
        expect(fadeAlphaAt(c, 0)).toBe(win.fadeIn > 0 ? 0 : 1);
        expect(fadeAlphaAt(c, win.fadeIn)).toBeCloseTo(win.fadeOut > 0 && win.fadeIn >= win.fadeOutStart
          ? fadeAlphaAt(c, win.fadeIn) : 1, 6);
        expect(fadeAlphaAt(c, win.length)).toBe(win.fadeOut > 0 ? 0 : 1);
      });
    });
  }

  it('沒有淡入淡出時，filtergraph 不含任何 fade（不可硬塞 d=0）', () => {
    const got = fadeParamsFrom(argvFor(clip({ out: 10 })));
    expect(got.vIn).toHaveLength(0);
    expect(got.vOut).toHaveLength(0);
  });

  it('長度為 0 的片段兩邊都夾到 0.001，不會除以零也不會出現 d=0', () => {
    const c = clip({ in: 5, out: 5, fadeIn: 1 });
    expect(clipLength(c)).toBe(0.001);
    expect(Number.isFinite(fadeAlphaAt(c, 0))).toBe(true);
    expect(fadeWindow(c).fadeIn).toBe(0.001);
  });

  it('負數的淡入淡出視為 0', () => {
    const w = fadeWindow(clip({ out: 10, fadeIn: -3, fadeOut: -1 }));
    expect(w.fadeIn).toBe(0);
    expect(w.fadeOut).toBe(0);
  });

  it('斜坡是線性的：淡入一半時剛好 0.5', () => {
    const c = clip({ out: 10, fadeIn: 4 });
    expect(fadeAlphaAt(c, 2)).toBeCloseTo(0.5, 6);
  });

  /* 範圍外要回 0，而且**沒有設淡入淡出的片段也一樣**。
     有淡變時斜坡本身算出來就是負數、被夾成 0，看起來像有守住——
     真正需要那道範圍檢查的是沒有淡變的片段：少了它會回 1，
     已經結束的疊層就繼續亮在畫面上。 */
  it('片段範圍外一律 0（不可讓已結束的疊層繼續亮著）', () => {
    const withFade = clip({ out: 10, fadeIn: 1, fadeOut: 1 });
    expect(fadeAlphaAt(withFade, -0.5)).toBe(0);
    expect(fadeAlphaAt(withFade, 10.5)).toBe(0);

    const noFade = clip({ out: 10 });
    expect(fadeAlphaAt(noFade, -0.5)).toBe(0);
    expect(fadeAlphaAt(noFade, 10.5)).toBe(0);
    expect(fadeAlphaAt(noFade, 5)).toBe(1);      // 範圍內仍是滿版

    const onlyIn = clip({ out: 10, fadeIn: 2 });
    expect(fadeAlphaAt(onlyIn, 10.5)).toBe(0);   // 淡出側沒有斜坡可以擋
  });
});

/* 預覽的三個呼叫端（app.js 圖片疊層、decode/player.js 合成、media.js 淡出入黑）
   拿到的都是時間軸時間。轉換原本各自寫在呼叫端、而且寫法不一致（見 clip-fade.js
   fadeAlphaAtTimeline 的檔頭）——鐵律 §0.5：時間域轉換不該散在呼叫端。 */
describe('時間軸時間入口', () => {
  it('等同於自己先減掉 offset', () => {
    const c = clip({ out: 10, offset: 30, fadeIn: 2, fadeOut: 2 });
    for (const local of [0, 0.5, 1, 2, 5, 8, 9.5, 10]) {
      expect(fadeAlphaAtTimeline(c, 30 + local), String(local))
        .toBeCloseTo(fadeAlphaAt(c, local), 12);
    }
  });

  it('片段還沒到或已經過去都是 0', () => {
    const c = clip({ out: 10, offset: 30, fadeIn: 1, fadeOut: 1 });
    expect(fadeAlphaAtTimeline(c, 29.5)).toBe(0);
    expect(fadeAlphaAtTimeline(c, 40.5)).toBe(0);
    expect(fadeAlphaAtTimeline(c, 35)).toBe(1);
  });

  /* 舊寫法中 app.js 用的是 `t - c.offset`（沒有 || 0）。片段少了 offset 欄位時
     那會算出 NaN → fadeAlphaAt 的 `+localTime || 0` 把它吃成 0 → 若有淡入，
     整段變全透明。另外兩處寫 `c.offset || 0` 則正常。這條守住那個縫。 */
  it('片段沒有 offset 欄位時視為 0，不會整段變透明', () => {
    const c = clip({ out: 10, fadeIn: 2 });
    delete c.offset;
    expect(fadeAlphaAtTimeline(c, 5)).toBe(1);
    expect(fadeAlphaAtTimeline(c, 1)).toBeCloseTo(0.5, 6);
  });

  it('沒有片段時回 0（不炸）', () => {
    expect(fadeAlphaAtTimeline(null, 5)).toBe(0);
    expect(fadeAlphaAtTimeline(undefined, 5)).toBe(0);
  });
});

/* 預覽合成的版面決策。

   這兩個決策以前住在 decode/player.js（412 行、與 VideoDecoder 焊在一起），
   **沒有任何測試 import 過那支檔案**——而它是三條渲染路徑的其中一條（鐵律 §0.1）。
   v5.8.0 的兩個真實 bug 都住在那裡（預覽與匯出差 120px、疊層溢出軌影格 24×54px），
   兩個都是靠臨時搭的比對工具抓到的，不是測試。 */
import { describe, expect, it } from 'vitest';
import { needsComposite, stageBox } from '../src/image-compositor-engine.js';

const clip = (o = {}) => ({ vtrack: 0, ...o });

describe('needsComposite：要不要從 mpv 接管', () => {
  it('沒有作用中的片段 → 不必接管', () => {
    expect(needsComposite([], [{}])).toBe(false);
  });

  it('單一、滿版、無效果的片段 → 讓 mpv 繼續播（切換時字幕才不會在兩個渲染器之間跳大小）', () => {
    expect(needsComposite([clip()], [{}])).toBe(false);
  });

  it('多層一定要合成', () => {
    expect(needsComposite([clip({ vtrack: 0 }), clip({ vtrack: 1 })], [{}, {}])).toBe(true);
  });

  it('淡入或淡出 → 要接管（mpv 表達不了溶接）', () => {
    expect(needsComposite([clip({ fadeIn: 0.5 })], [{}])).toBe(true);
    expect(needsComposite([clip({ fadeOut: 0.5 })], [{}])).toBe(true);
  });

  it('軌道縮放（PiP）或透明度 → 要接管', () => {
    expect(needsComposite([clip()], [{ scale: 0.5 }])).toBe(true);
    expect(needsComposite([clip()], [{ opacity: 0.5 }])).toBe(true);
  });

  /* v5.7.0 的實例：逐片段幾何漏了這三條判斷，設了幾何的影片段在 mpv 模式下
     完全看不出變化，匯出卻套用了——預覽與成品不一致且無錯誤訊息。 */
  it('逐片段幾何（scale／posX／posY）→ 要接管', () => {
    expect(needsComposite([clip({ scale: 0.5 })], [{}])).toBe(true);
    expect(needsComposite([clip({ posX: 0.2 })], [{}])).toBe(true);
    expect(needsComposite([clip({ posY: 0.8 })], [{}])).toBe(true);
  });

  it('等同預設值的幾何不算效果（不可為了保險就一律接管）', () => {
    expect(needsComposite([clip({ scale: 1, posX: 0.5, posY: 0.5 })], [{ scale: 1, opacity: 1 }])).toBe(false);
  });

  it('浮點誤差範圍內視為預設值', () => {
    expect(needsComposite([clip({ scale: 1.0000001, posX: 0.5000001 })], [{}])).toBe(false);
  });

  it('片段落在哪一條軌，就看哪一條軌的設定', () => {
    const tracks = [{ scale: 1 }, { scale: 0.5 }];
    expect(needsComposite([clip({ vtrack: 0 })], tracks)).toBe(false);
    expect(needsComposite([clip({ vtrack: 1 })], tracks)).toBe(true);
  });

  it('缺少軌道資料時不炸開', () => {
    expect(needsComposite([clip({ vtrack: 9 })], [])).toBe(false);
    expect(needsComposite([clip()], undefined)).toBe(false);
    expect(needsComposite(undefined, undefined)).toBe(false);
  });
});

describe('stageBox：畫布上的專案畫面區', () => {
  it('同比例時填滿整張畫布', () => {
    expect(stageBox({ canvasW: 1280, canvasH: 720, projectW: 1920, projectH: 1080 }))
      .toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it('畫布較寬 → 左右留黑邊並置中', () => {
    const b = stageBox({ canvasW: 1600, canvasH: 720, projectW: 1920, projectH: 1080 });
    expect({ w: b.w, h: b.h }).toEqual({ w: 1280, h: 720 });
    expect(b.x).toBe(160);
    expect(b.y).toBe(0);
  });

  it('畫布較高 → 上下留黑邊並置中', () => {
    const b = stageBox({ canvasW: 1280, canvasH: 900, projectW: 1920, projectH: 1080 });
    expect({ w: b.w, h: b.h }).toEqual({ w: 1280, h: 720 });
    expect(b.y).toBe(90);
  });

  /* 基準是【專案畫布】而不是素材解析度——否則換到不同比例的片段時整個畫面區跟著變，
     字幕大小也跟著跳（v4.25.3 的「字幕在各個影片上大小不同」）。 */
  it('2.35:1 的專案畫布同樣依自己的比例決定畫面區', () => {
    const b = stageBox({ canvasW: 1280, canvasH: 720, projectW: 2048, projectH: 872 });
    expect(b.w).toBe(1280);
    expect(b.h).toBe(545);
    expect(b.y).toBe(87);
  });

  it('沒給專案尺寸時退回 1920×1080', () => {
    expect(stageBox({ canvasW: 1280, canvasH: 720 })).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
});

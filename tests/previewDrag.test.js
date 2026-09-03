// @vitest-environment jsdom
/* 預覽窗的拖曳（圖片疊層與字幕）。

   這些規則之前完全沒有測試，而它們**壞掉的樣子都不會報錯**：
     - 角落縮放的方向係數（sx/sy）寫反 → 往外拉圖片反而縮小；
     - 縮放或位置的夾限沒了 → 圖片被拖到畫面外，或縮到肉眼看不見卻仍佔著資源；
     - 旋轉的 15° 吸附或角度正規化壞掉 → 角度變成 350°，匯出時 ASS 的 \frz 也跟著錯。

   createPreviewDrag(deps) 是工廠（見 pointer-interaction.js 檔頭），
   依賴走建構參數、拖曳狀態是實例欄位——所以這裡可以建立互不干擾的實例直接測。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/media.js', () => ({ Media: { mpvPresenting: () => false } }));

import { State } from '../src/state.js';
import { createPreviewDrag } from '../src/timeline-interaction-engine.js';

const RECT = { w: 1000, h: 500 };

/* 預設 imageBoxOf 回一個 200×100 的實際圖框（＝角落縮放的基準）。 */
function makeDrag(over = {}) {
  return createPreviewDrag({
    getStageRect: () => RECT,
    imageBoxOf: () => ({ x: 0, y: 0, w: 200, h: 100 }),
    ...over,
  });
}

function image(over = {}) {
  return {
    id: 'i1', name: 'logo.png', type: 'image', path: 'C:/logo.png',
    in: 0, out: 5, offset: 0, dur: 5, vtrack: 0,
    scale: 1, posX: 0.5, posY: 0.5, natW: 800, natH: 600, ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="imageLayer"></div>';
  State.clips = [image()];
  State.videoTracks = [{ name: '視訊軌 1', visible: true, locked: false }];
  State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
  State.cues = [];
});

describe('圖片疊層：開始拖曳的守門', () => {
  it('正常情況開得起來', () => {
    expect(makeDrag().startImageDrag({ id: 'i1', x: 0, y: 0 })).toBe(true);
  });

  it('找不到片段 → false', () => {
    expect(makeDrag().startImageDrag({ id: '不存在', x: 0, y: 0 })).toBe(false);
  });

  it('不是圖片的片段 → false（影片幾何走另一條路）', () => {
    State.clips = [image({ type: 'video' })];
    expect(makeDrag().startImageDrag({ id: 'i1', x: 0, y: 0 })).toBe(false);
  });

  /* 鎖定視訊軌就是不能動——這條若失守，鎖定在預覽窗形同虛設。 */
  it('所在視訊軌鎖定 → false', () => {
    State.videoTracks[0].locked = true;
    expect(makeDrag().startImageDrag({ id: 'i1', x: 0, y: 0 })).toBe(false);
  });

  it('拿不到畫框尺寸 → false（不可用 0 當分母）', () => {
    expect(makeDrag({ getStageRect: () => null }).startImageDrag({ id: 'i1', x: 0, y: 0 })).toBe(false);
    expect(makeDrag({ getStageRect: () => ({ w: 0, h: 0 }) }).startImageDrag({ id: 'i1', x: 0, y: 0 })).toBe(false);
  });

  it('沒開始拖曳時 move 不會動到片段', () => {
    const d = makeDrag();
    d.moveImageDrag(500, 500);
    expect(State.clips[0].posX).toBe(0.5);
  });
});

describe('圖片疊層：移動位置', () => {
  it('位移是畫框寬高的比例', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', x: 100, y: 100 });
    d.moveImageDrag(200, 150);            // +100px / 1000 = +0.1；+50px / 500 = +0.1
    expect(State.clips[0].posX).toBeCloseTo(0.6, 6);
    expect(State.clips[0].posY).toBeCloseTo(0.6, 6);
  });

  it('往回拖會變小', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', x: 100, y: 100 });
    d.moveImageDrag(0, 50);
    expect(State.clips[0].posX).toBeCloseTo(0.4, 6);
    expect(State.clips[0].posY).toBeCloseTo(0.4, 6);
  });

  it('位置夾在 0–1（拖出畫面外不可讓圖片消失）', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', x: 0, y: 0 });
    d.moveImageDrag(99999, 99999);
    expect(State.clips[0].posX).toBe(1);
    expect(State.clips[0].posY).toBe(1);
    d.moveImageDrag(-99999, -99999);
    expect(State.clips[0].posX).toBe(0);
    expect(State.clips[0].posY).toBe(0);
  });

  it('移動時不動到縮放', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', x: 0, y: 0 });
    d.moveImageDrag(300, 200);
    expect(State.clips[0].scale).toBe(1);
  });
});

/* 四個角的方向係數。圖框 200×100，所以往外 100px 就是 100×2/200 = +1.0 倍。
   寫反的話「往外拉反而縮小」——肉眼一試就知道，但沒有測試就會在改版時再壞一次。 */
describe('圖片疊層：角落縮放的方向', () => {
  const OUTWARD = {
    se: [100, 50], ne: [100, -50], sw: [-100, 50], nw: [-100, -50],
  };

  for (const [corner, [dx, dy]] of Object.entries(OUTWARD)) {
    it(`${corner} 角往外拉會變大`, () => {
      const d = makeDrag();
      d.startImageDrag({ id: 'i1', corner, x: 0, y: 0 });
      d.moveImageDrag(dx, dy);
      expect(State.clips[0].scale).toBeGreaterThan(1);
    });

    it(`${corner} 角往內拉會變小`, () => {
      const d = makeDrag();
      d.startImageDrag({ id: 'i1', corner, x: 0, y: 0 });
      d.moveImageDrag(-dx, -dy);
      expect(State.clips[0].scale).toBeLessThan(1);
    });
  }

  it('四個角往外拉同樣距離，得到同一個倍率', () => {
    const scales = Object.entries(OUTWARD).map(([corner, [dx, dy]]) => {
      State.clips = [image()];
      const d = makeDrag();
      d.startImageDrag({ id: 'i1', corner, x: 0, y: 0 });
      d.moveImageDrag(dx, dy);
      return +State.clips[0].scale.toFixed(9);
    });
    expect(new Set(scales).size).toBe(1);
  });

  /* 上面那組 dx 與 dy 換算後大小相同，delta 一律取 dx——所以 sy 寫死成 1 也測不出來。
     兩軸各自單獨拉一次，才會分別踩到 sx 與 sy。 */
  const H_OUT = { se: 100, ne: 100, sw: -100, nw: -100 };
  const V_OUT = { se: 50, ne: -50, sw: 50, nw: -50 };

  for (const corner of ['se', 'ne', 'sw', 'nw']) {
    it(`${corner} 角只往水平方向外拉也會變大（x 方向係數）`, () => {
      const d = makeDrag();
      d.startImageDrag({ id: 'i1', corner, x: 0, y: 0 });
      d.moveImageDrag(H_OUT[corner], 0);
      expect(State.clips[0].scale).toBeCloseTo(2, 6);
    });

    it(`${corner} 角只往垂直方向外拉也會變大（y 方向係數）`, () => {
      const d = makeDrag();
      d.startImageDrag({ id: 'i1', corner, x: 0, y: 0 });
      d.moveImageDrag(0, V_OUT[corner]);
      expect(State.clips[0].scale).toBeCloseTo(2, 6);
    });
  }

  it('取 x/y 位移較大的那一軸（斜拉時以主導方向為準）', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    // dx = 100*2/200 = 1.0；dy = 10*2/100 = 0.2 → 取 1.0
    d.moveImageDrag(100, 10);
    expect(State.clips[0].scale).toBeCloseTo(2, 6);
  });

  it('縮放以拖曳起點的倍率為基準，不是累加', () => {
    State.clips = [image({ scale: 3 })];
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    d.moveImageDrag(100, 50);   // delta = +1 → 3 × 2
    expect(State.clips[0].scale).toBeCloseTo(6, 6);
    d.moveImageDrag(0, 0);      // 回到起點 → 回到原倍率
    expect(State.clips[0].scale).toBeCloseTo(3, 6);
  });

  it('倍率夾在 0.02–8', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    d.moveImageDrag(99999, 99999);
    expect(State.clips[0].scale).toBe(8);
    d.moveImageDrag(-99999, -99999);
    expect(State.clips[0].scale).toBe(0.02);
  });

  /* 圖框還沒量到（w/h ≤ 1）時退回用整個畫框當基準。門檻是「≤ 1」而不是「為 0」：
     0.5px 那種殘值當分母會讓滑鼠動一格就把圖片放大到上限。 */
  it.each([[0, 0], [0.5, 0.5], [1, 1]])('量不到圖框（%s×%s）時以畫框尺寸為基準', (w, h) => {
    const d = makeDrag({ imageBoxOf: () => ({ x: 0, y: 0, w, h }) });
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    d.moveImageDrag(500, 0);    // 500*2/1000（畫框寬）= +1.0
    expect(State.clips[0].scale).toBeCloseTo(2, 6);
  });

  it('縮放時不動到位置', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    d.moveImageDrag(100, 50);
    expect(State.clips[0].posX).toBe(0.5);
    expect(State.clips[0].posY).toBe(0.5);
  });
});

describe('圖片疊層：結束拖曳', () => {
  it('依是否為角落拖曳記下不同的歷史標籤', () => {
    const labels = [];
    const d = makeDrag({ recordHistory: m => labels.push(m) });
    d.startImageDrag({ id: 'i1', x: 0, y: 0 });
    d.finishImageDrag();
    d.startImageDrag({ id: 'i1', corner: 'se', x: 0, y: 0 });
    d.finishImageDrag();
    expect(labels).toEqual(['移動圖片位置', '調整圖片大小']);
  });

  it('結束後 move 不再生效', () => {
    const d = makeDrag();
    d.startImageDrag({ id: 'i1', x: 0, y: 0 });
    d.finishImageDrag();
    d.moveImageDrag(500, 250);
    expect(State.clips[0].posX).toBe(0.5);
    expect(d.imageDrag()).toBe(null);
  });

  it('兩個實例互不干擾（工廠化的重點）', () => {
    const a = makeDrag(), b = makeDrag();
    a.startImageDrag({ id: 'i1', x: 0, y: 0 });
    expect(b.imageDrag()).toBe(null);
    b.finishImageDrag();
    expect(a.imageDrag()).not.toBe(null);
  });
});

/* ---- 字幕拖曳：只走 DOM 事件那條路 ---- */

function mountSubtitle({ alt = false } = {}) {
  document.body.innerHTML = `
    <div id="imageLayer"></div>
    <div id="videoWrap"><div id="videoSub">
      <div class="vsub-track drag" data-cue="c1" data-tk="0"></div>
    </div></div>`;
  State.cues = [{ id: 'c1', start: 0, end: 2, text: '測試', track: 0 }];
  const videoSub = document.getElementById('videoSub');
  const el = videoSub.querySelector('.vsub-track');
  const drag = makeDrag();
  drag.bind({ imageLayer: document.getElementById('imageLayer'), videoSub, videoWrap: document.getElementById('videoWrap') });
  return { drag, videoSub, el, alt };
}

const pointer = (type, x, y, opts = {}) =>
  new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...opts });

describe('字幕拖曳：移動位置', () => {
  it('位移換算成百分比並夾在 0–100', () => {
    const { videoSub, el } = mountSubtitle();
    el.dispatchEvent(pointer('pointerdown', 100, 100));
    videoSub.dispatchEvent(pointer('pointermove', 200, 100));   // +100/1000*100 = +10
    expect(State.cues[0].style.posX).toBeCloseTo(60, 6);        // 預設 posX = 50
    videoSub.dispatchEvent(pointer('pointermove', 99999, 99999));
    expect(State.cues[0].style.posX).toBe(100);
    expect(State.cues[0].style.posY).toBe(100);
    videoSub.dispatchEvent(pointer('pointermove', -99999, -99999));
    expect(State.cues[0].style.posX).toBe(0);
    expect(State.cues[0].style.posY).toBe(0);
  });

  it('鎖定字幕軌不可拖', () => {
    const { videoSub, el } = mountSubtitle();
    State.tracks[0].locked = true;
    el.dispatchEvent(pointer('pointerdown', 100, 100));
    videoSub.dispatchEvent(pointer('pointermove', 500, 300));
    expect(State.cues[0].style).toBeUndefined();
  });

  it('放開後再移動不生效，並記下歷史', () => {
    const labels = [];
    document.body.innerHTML = `
      <div id="imageLayer"></div>
      <div id="videoWrap"><div id="videoSub">
        <div class="vsub-track drag" data-cue="c1" data-tk="0"></div>
      </div></div>`;
    State.cues = [{ id: 'c1', start: 0, end: 2, text: '測試', track: 0 }];
    const videoSub = document.getElementById('videoSub');
    const el = videoSub.querySelector('.vsub-track');
    makeDrag({ recordHistory: m => labels.push(m) })
      .bind({ imageLayer: document.getElementById('imageLayer'), videoSub, videoWrap: document.getElementById('videoWrap') });

    el.dispatchEvent(pointer('pointerdown', 100, 100));
    videoSub.dispatchEvent(pointer('pointermove', 200, 100));
    videoSub.dispatchEvent(pointer('pointerup', 200, 100));
    const after = State.cues[0].style.posX;
    videoSub.dispatchEvent(pointer('pointermove', 900, 100));
    expect(State.cues[0].style.posX).toBe(after);
    expect(labels[0]).toMatch(/^移動字幕位置/);
  });
});

describe('字幕拖曳：旋轉', () => {
  /* 按住 Alt 開始拖＝旋轉。角度正規化到 [−180, 180)——
     若讓它累加成 350°，ASS 的 \frz 取負後也會跟著錯。 */
  it('Alt 開始＝旋轉；角度正規化在 −180…180 之間', () => {
    const { videoSub, el } = mountSubtitle();
    el.dispatchEvent(pointer('pointerdown', 100, 0, { altKey: true }));
    for (let i = 1; i <= 24; i++) {
      const a = i / 24 * Math.PI * 2;
      videoSub.dispatchEvent(pointer('pointermove', 100 * Math.cos(a), 100 * Math.sin(a)));
      const ang = State.cues[0].style.angle;
      expect(ang, String(i)).toBeGreaterThanOrEqual(-180);
      expect(ang, String(i)).toBeLessThan(180);
    }
  });

  it('按住 Shift 吸附到 15 度的倍數', () => {
    const { videoSub, el } = mountSubtitle();
    el.dispatchEvent(pointer('pointerdown', 100, 0, { altKey: true }));
    for (const [x, y] of [[70, 70], [0, 100], [-70, 70], [-100, 0], [50, 87], [93, 37]]) {
      videoSub.dispatchEvent(pointer('pointermove', x, y, { shiftKey: true }));
      const ang = State.cues[0].style.angle;
      expect(Math.abs(ang % 15), `${x},${y} → ${ang}`).toBe(0);
    }
  });

  it('沒按 Shift 時不吸附（能轉到非 15 的倍數）', () => {
    const { videoSub, el } = mountSubtitle();
    el.dispatchEvent(pointer('pointerdown', 100, 0, { altKey: true }));
    const seen = new Set();
    for (let i = 1; i <= 40; i++) {
      videoSub.dispatchEvent(pointer('pointermove', 100 * Math.cos(i / 7), 100 * Math.sin(i / 7)));
      seen.add(State.cues[0].style.angle % 15);
    }
    expect([...seen].some(r => r !== 0)).toBe(true);
  });

  it('旋轉時不動到位置', () => {
    const { videoSub, el } = mountSubtitle();
    el.dispatchEvent(pointer('pointerdown', 100, 0, { altKey: true }));
    videoSub.dispatchEvent(pointer('pointermove', 0, 100));
    expect(State.cues[0].style.posX).toBeUndefined();
    expect(State.cues[0].style.posY).toBeUndefined();
  });

  it('旋轉記下的歷史標籤與移動不同', () => {
    const labels = [];
    document.body.innerHTML = `
      <div id="imageLayer"></div>
      <div id="videoWrap"><div id="videoSub">
        <div class="vsub-track drag" data-cue="c1" data-tk="0"></div>
      </div></div>`;
    State.cues = [{ id: 'c1', start: 0, end: 2, text: '測試', track: 0 }];
    const videoSub = document.getElementById('videoSub');
    const el = videoSub.querySelector('.vsub-track');
    makeDrag({ recordHistory: m => labels.push(m) })
      .bind({ imageLayer: document.getElementById('imageLayer'), videoSub, videoWrap: document.getElementById('videoWrap') });

    el.dispatchEvent(pointer('pointerdown', 100, 0, { altKey: true }));
    videoSub.dispatchEvent(pointer('pointermove', 0, 100));
    videoSub.dispatchEvent(pointer('pointerup', 0, 100));
    expect(labels[0]).toMatch(/^旋轉字幕/);
  });
});

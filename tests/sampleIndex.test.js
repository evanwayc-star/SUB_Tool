/* 樣本索引上的定位與位元組視窗。

   全部餵**合成的索引陣列**——不需要真的 mp4 樣本檔。這是刻意的：
   把幾 MB 的媒體檔放進版控，換來的只是「跑得比較慢的同一批斷言」，
   而真檔案還會讓失敗訊息變成「解碼器吐不出畫面」這種查不動的形式。
   索引本身就是純資料，直接造。

   壞掉的樣子：二分搜尋差一格 → seek 到下一個 GOP、播放點整段跳掉；
   位移算錯 → 餵給 decoder 的是別顆樣本的位元組，只會得到花畫面。
   兩者都不報錯。 */
import { describe, expect, it } from 'vitest';
import {
  WIN_BYTES, WIN_KEEP, WIN_SAMPLES,
  evictWindows, gridStart, keyIndexBefore, planWindow, sliceBounds, touchWindow,
  windowByteRange, windowEnd,
} from '../src/decode/sample-index.js';

/**
 * 造一份索引：n 顆樣本、每顆 durUs、每 gop 顆一個關鍵幀、每顆 size 位元組，
 * 在檔案裡從 offset0 起**連續**排列。
 */
function makeIndex({ n = 100, durUs = 40000, gop = 12, size = 1000, offset0 = 5000 } = {}) {
  const index = [];
  const keyIdx = [];
  let offset = offset0;
  for (let i = 0; i < n; i++) {
    if (i % gop === 0) keyIdx.push(i);
    index.push({
      type: i % gop === 0 ? 'key' : 'delta',
      timestamp: i * durUs, duration: durUs, offset, size,
    });
    offset += size;
  }
  return { index, keyIdx, maxEnd: offset };
}

describe('關鍵幀定位', () => {
  const { index, keyIdx } = makeIndex({ n: 120, durUs: 40000, gop: 12 });

  it('落在關鍵幀正上方 → 就是那一顆', () => {
    for (const k of keyIdx) {
      expect(keyIndexBefore(index, keyIdx, index[k].timestamp), String(k)).toBe(k);
    }
  });

  /* 「≤ tUs 的最後一個關鍵幀」——差一格就會 seek 到下一個 GOP，
     使用者看到的是「拖到這裡畫面卻跳到後面」。 */
  it('落在 GOP 中間 → 回該 GOP 的關鍵幀，不是下一個', () => {
    expect(keyIndexBefore(index, keyIdx, index[5].timestamp)).toBe(0);
    expect(keyIndexBefore(index, keyIdx, index[13].timestamp)).toBe(12);
    expect(keyIndexBefore(index, keyIdx, index[23].timestamp)).toBe(12);
    expect(keyIndexBefore(index, keyIdx, index[24].timestamp)).toBe(24);
  });

  it('關鍵幀時間戳的前一微秒 → 前一個 GOP', () => {
    expect(keyIndexBefore(index, keyIdx, index[12].timestamp - 1)).toBe(0);
    expect(keyIndexBefore(index, keyIdx, index[24].timestamp - 1)).toBe(12);
  });

  /* 首幀 cts > 0 的情況真的存在（nvenc 的 B-frame reorder）。
     回 −1 會讓 fedIdx 變負數，之後一路壞下去。 */
  it('目標早於第一個關鍵幀 → 回第一個關鍵幀，不是 −1', () => {
    expect(keyIndexBefore(index, keyIdx, -1)).toBe(keyIdx[0]);
    expect(keyIndexBefore(index, keyIdx, -1e9)).toBe(keyIdx[0]);
  });

  it('目標超過檔尾 → 回最後一個關鍵幀', () => {
    expect(keyIndexBefore(index, keyIdx, 1e12)).toBe(keyIdx[keyIdx.length - 1]);
  });

  it('只有一個關鍵幀（無 stss 的檔）時永遠回它', () => {
    const one = makeIndex({ n: 50, gop: 1000 });
    expect(one.keyIdx).toEqual([0]);
    expect(keyIndexBefore(one.index, one.keyIdx, 0)).toBe(0);
    expect(keyIndexBefore(one.index, one.keyIdx, 1e9)).toBe(0);
  });

  it('全部都是關鍵幀時，逐顆都定位得到自己', () => {
    const all = makeIndex({ n: 40, gop: 1 });
    for (let i = 0; i < 40; i++) {
      expect(keyIndexBefore(all.index, all.keyIdx, all.index[i].timestamp), String(i)).toBe(i);
    }
  });

  /* 二分搜尋要對「任意時間點」都成立，不能只在我挑的幾個點上對。
     這裡用線性掃描當參考實作，逐微秒級地比對整段。 */
  it('與線性掃描的結果完全相同（窮舉整段時間軸）', () => {
    const linear = (t) => {
      let k = keyIdx[0];
      for (const j of keyIdx) { if (index[j].timestamp <= t) k = j; else break; }
      return k;
    };
    const diffs = [];
    for (let t = -50000; t <= 120 * 40000 + 50000; t += 3571) {
      if (keyIndexBefore(index, keyIdx, t) !== linear(t)) diffs.push(t);
    }
    expect(diffs).toEqual([]);
  });
});

describe('格線起點', () => {
  it('對齊到固定格線（不是以 i 為首）', () => {
    expect(gridStart(0)).toBe(0);
    expect(gridStart(1)).toBe(0);
    expect(gridStart(WIN_SAMPLES - 1)).toBe(0);
    expect(gridStart(WIN_SAMPLES)).toBe(WIN_SAMPLES);
    expect(gridStart(WIN_SAMPLES + 5)).toBe(WIN_SAMPLES);
  });

  /* 對齊的理由：兩層的解碼游標差一顆樣本時，仍要落在同一個視窗、共用同一次抓取。
     若改成「以 i 為首」，兩層就會各抓一份幾乎相同的位元組。 */
  it('相鄰的游標落在同一個格子', () => {
    expect(gridStart(10)).toBe(gridStart(11));
  });
});

describe('視窗規劃', () => {
  it('位元組寬鬆時就是整個格子，且相鄰游標共用同一個視窗', () => {
    const { index } = makeIndex({ n: 500, size: 1000 });
    expect(planWindow(index, 0)).toEqual({ from: 0, to: WIN_SAMPLES });
    expect(planWindow(index, 10)).toEqual(planWindow(index, 11));
    expect(planWindow(index, WIN_SAMPLES)).toEqual({ from: WIN_SAMPLES, to: WIN_SAMPLES * 2 });
  });

  /* 這條是 v5.11.0 修掉的**預覽永久卡住**：每顆 1MB 的高位元率原生檔，
     一個格子 48 顆卻只裝得下 4 顆。舊寫法拿格線起點當視窗的鍵，
     樣本 4…47 全部指向鍵 0，而鍵 0 的視窗只涵蓋 [0,4)——
     ensure() 查到鍵 0 已存在就返回，那些樣本的位元組永遠不會被抓，
     該層預覽就停在那一格畫面上。 */
  it('格子被位元組上限切斷時，每顆樣本都落在真正涵蓋它的視窗裡', () => {
    const { index } = makeIndex({ n: 200, size: WIN_BYTES / 4 });
    const bad = [];
    for (let i = 0; i < index.length; i++) {
      const { from, to } = planWindow(index, i);
      if (!(i >= from && i < to)) bad.push(`${i} 不在 [${from},${to})`);
      if (from < gridStart(i) || to > Math.min(gridStart(i) + WIN_SAMPLES, index.length)) {
        bad.push(`${i} 的視窗 [${from},${to}) 越過了格子邊界`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('被切斷的後續視窗從切斷處接續，不重疊也不留空隙', () => {
    const { index } = makeIndex({ n: 100, size: WIN_BYTES / 4 });
    const segs = [];
    for (let i = 0; i < WIN_SAMPLES; i++) {
      const w = planWindow(index, i);
      if (!segs.length || segs[segs.length - 1].from !== w.from) segs.push(w);
    }
    expect(segs[0].from).toBe(0);
    for (let k = 1; k < segs.length; k++) expect(segs[k].from).toBe(segs[k - 1].to);
    expect(segs[segs.length - 1].to).toBe(WIN_SAMPLES);
  });

  it('單顆樣本就超過上限時，每顆自成一個視窗', () => {
    const { index } = makeIndex({ n: 10, size: WIN_BYTES * 3 });
    for (let i = 0; i < 10; i++) expect(planWindow(index, i)).toEqual({ from: i, to: i + 1 });
  });

  it('最後一個不滿的格子收在索引長度', () => {
    const { index } = makeIndex({ n: WIN_SAMPLES + 5, size: 1000 });
    expect(planWindow(index, WIN_SAMPLES + 2)).toEqual({ from: WIN_SAMPLES, to: WIN_SAMPLES + 5 });
  });
});

describe('視窗終點', () => {
  it('位元組很小時吃滿樣本數上限', () => {
    const { index } = makeIndex({ n: 500, size: 1000 });
    expect(windowEnd(index, 0)).toBe(WIN_SAMPLES);
    expect(windowEnd(index, WIN_SAMPLES)).toBe(WIN_SAMPLES * 2);
  });

  it('檔尾不會超出索引長度', () => {
    const { index } = makeIndex({ n: 20, size: 1000 });
    expect(windowEnd(index, 0)).toBe(20);
    expect(windowEnd(index, 10)).toBe(20);
  });

  /* 長 GOP／高位元率的原生檔，48 顆樣本可能是好幾十 MB——只看樣本數會爆記憶體。 */
  it('位元組上限先到時提早收手', () => {
    const big = Math.floor(WIN_BYTES / 4);           // 每顆 1MB → 第 5 顆就超過 4MB
    const { index } = makeIndex({ n: 100, size: big });
    expect(windowEnd(index, 0)).toBe(4);
  });

  it('剛好等於上限不算超過（邊界含）', () => {
    const { index } = makeIndex({ n: 10, size: WIN_BYTES / 2 });
    expect(windowEnd(index, 0)).toBe(2);             // 2 顆 = 剛好 WIN_BYTES
  });

  /* 單顆樣本自己就超過上限時仍須抓得動，否則那顆永遠讀不到、播放停在該處。 */
  it('單顆樣本超過位元組上限時仍至少收一顆', () => {
    const { index } = makeIndex({ n: 10, size: WIN_BYTES * 3 });
    expect(windowEnd(index, 0)).toBe(1);
    expect(windowEnd(index, 9)).toBe(10);
  });

  it('自訂上限也照算（讓呼叫端可調）', () => {
    const { index } = makeIndex({ n: 100, size: 1000 });
    expect(windowEnd(index, 0, { winSamples: 5, winBytes: 1e9 })).toBe(5);
    expect(windowEnd(index, 0, { winSamples: 100, winBytes: 3000 })).toBe(3);
  });

  /* 永遠不回空視窗——planWindow 的迴圈靠這條收斂。
     若哪天有人把「至少收一顆」拿掉，這裡會紅，而不是讓分頁在使用者手上當掉。 */
  it('任何參數下都不會回空視窗（planWindow 的收斂前提）', () => {
    const { index } = makeIndex({ n: 30, size: 1000 });
    for (const opts of [{}, { winSamples: 0 }, { winBytes: 0 }, { winSamples: 0, winBytes: 0 },
      { winSamples: 1 }, { winSamples: 1e9, winBytes: 1e9 }]) {
      for (const from of [0, 1, 29]) {
        expect(windowEnd(index, from, opts), `${from} / ${JSON.stringify(opts)}`)
          .toBeGreaterThan(from);
      }
    }
  });
});

describe('視窗的位元組區間', () => {
  it('從第一顆的 offset 到最後一顆的結尾', () => {
    const { index, maxEnd } = makeIndex({ n: 100, size: 1000, offset0: 5000 });
    expect(windowByteRange(index, 0, 10, maxEnd)).toEqual({ base: 5000, end: 15000 });
    expect(windowByteRange(index, 10, 20, maxEnd)).toEqual({ base: 15000, end: 25000 });
  });

  /* mdat 之後可能還有 moov／free，多抓沒意義；有些來源對超出檔尾的 Range 直接回 416。 */
  it('末端夾到 maxEnd', () => {
    const { index } = makeIndex({ n: 10, size: 1000, offset0: 0 });
    expect(windowByteRange(index, 0, 10, 9500).end).toBe(9500);
  });

  it('樣本在檔案裡不連續時，區間仍是從首到尾（含中間的空隙）', () => {
    // 交錯的音訊樣本會夾在視訊樣本之間 → 視訊樣本的 offset 不連續
    const index = [
      { offset: 100, size: 50 },
      { offset: 400, size: 50 },
      { offset: 900, size: 50 },
    ];
    expect(windowByteRange(index, 0, 3, 1e9)).toEqual({ base: 100, end: 950 });
  });
});

describe('樣本在視窗內的位移', () => {
  const win = { from: 10, to: 20, base: 15000 };

  it('位移是 offset − base', () => {
    const { index } = makeIndex({ n: 100, size: 1000, offset0: 5000 });
    expect(sliceBounds(index, 10, win)).toEqual({ off: 0, end: 1000 });
    expect(sliceBounds(index, 11, win)).toEqual({ off: 1000, end: 2000 });
    expect(sliceBounds(index, 19, win)).toEqual({ off: 9000, end: 10000 });
  });

  /* 不可以把樣本大小累加起來當位移——交錯的音訊樣本夾在中間時整段會偏掉。 */
  it('樣本不連續時位移仍正確（不是累加大小）', () => {
    const index = [{ offset: 100, size: 50 }, { offset: 400, size: 50 }, { offset: 900, size: 50 }];
    const w = { from: 0, to: 3, base: 100 };
    expect(sliceBounds(index, 1, w)).toEqual({ off: 300, end: 350 });
    expect(sliceBounds(index, 2, w)).toEqual({ off: 800, end: 850 });
  });

  it('不在這個視窗裡回 null（呼叫端應先 ensure）', () => {
    const { index } = makeIndex({ n: 100 });
    expect(sliceBounds(index, 9, win)).toBe(null);
    expect(sliceBounds(index, 20, win)).toBe(null);
    expect(sliceBounds(index, 0, null)).toBe(null);
  });
});

describe('視窗的 LRU', () => {
  it('touch 把指定視窗移到最新', () => {
    expect(touchWindow([0, 48, 96], 0)).toEqual([48, 96, 0]);
    expect(touchWindow([0, 48, 96], 96)).toEqual([0, 48, 96]);
  });

  it('touch 不動原陣列', () => {
    const order = [0, 48, 96];
    touchWindow(order, 0);
    expect(order).toEqual([0, 48, 96]);
  });

  it('touch 不存在的視窗＝原樣', () => {
    expect(touchWindow([0, 48], 999)).toEqual([0, 48]);
  });

  it('未超過常駐上限時不丟任何東西', () => {
    const order = Array.from({ length: WIN_KEEP }, (_, i) => i * WIN_SAMPLES);
    expect(evictWindows(order)).toEqual({ keep: order, drop: [] });
  });

  /* 上限的邊界：剛好第 KEEP+1 個時就要開始丟。差一格的話常駐視窗多一個，
     記憶體上限（≈16MB）就跟著失守——而且不會有任何徵兆。 */
  it('剛好超過一個時丟掉最舊的那一個', () => {
    const order = Array.from({ length: WIN_KEEP + 1 }, (_, i) => i * WIN_SAMPLES);
    const { keep, drop } = evictWindows(order);
    expect(drop).toEqual([order[0]]);
    expect(keep).toHaveLength(WIN_KEEP);
  });

  it('超過上限時丟最舊的', () => {
    const order = [0, 48, 96, 144, 192, 240];   // 6 個，上限 4
    const { keep, drop } = evictWindows(order);
    expect(drop).toEqual([0, 48]);
    expect(keep).toEqual([96, 144, 192, 240]);
    expect(keep).toHaveLength(WIN_KEEP);
  });

  it('自訂常駐數也照算', () => {
    expect(evictWindows([1, 2, 3], 1)).toEqual({ keep: [3], drop: [1, 2] });
  });

  it('丟掉的與留下的加起來就是原本那些（不會漏掉也不會重複）', () => {
    const order = [0, 48, 96, 144, 192, 240, 288];
    const { keep, drop } = evictWindows(order);
    expect([...drop, ...keep]).toEqual(order);
  });
});

/* 端到端：把三支函式串起來走一遍，確認「視窗切法 → 位元組區間 → 樣本位移」
   湊得回每一顆樣本自己的位元組。單獨測每一支都對、串起來卻對不上，
   正是這條路最容易出的錯。 */
describe('串起來：規劃視窗 → 算區間 → 取位移', () => {
  /** SampleReader 對樣本 i 實際會做的事，用純函式重演一次。 */
  function walk(index, maxEnd) {
    const bad = [];
    for (let i = 0; i < index.length; i++) {
      const { from, to } = planWindow(index, i);
      const { base, end } = windowByteRange(index, from, to, maxEnd);
      const b = sliceBounds(index, i, { from, to, base });
      if (!b) { bad.push(`${i}: 不在自己的視窗裡（＝位元組永遠抓不到）`); continue; }
      if (base + b.off !== index[i].offset) bad.push(`${i}: 起點對不上`);
      if (b.end - b.off !== index[i].size) bad.push(`${i}: 長度對不上`);
      if (base + b.end > end) bad.push(`${i}: 超出抓下來的位元組範圍`);
    }
    return bad;
  }

  it('低位元率（視窗吃滿樣本數）：每顆樣本都取得到且正確', () => {
    const { index, maxEnd } = makeIndex({ n: 200, size: 3000, offset0: 777 });
    expect(walk(index, maxEnd)).toEqual([]);
  });

  it('高位元率（視窗被位元組上限切斷）：每顆樣本仍取得到且正確', () => {
    const { index, maxEnd } = makeIndex({ n: 200, size: Math.floor(WIN_BYTES / 3) });
    expect(walk(index, maxEnd)).toEqual([]);
  });

  it('單顆就超過上限的極端檔：每顆樣本仍取得到且正確', () => {
    const { index, maxEnd } = makeIndex({ n: 30, size: WIN_BYTES * 2 });
    expect(walk(index, maxEnd)).toEqual([]);
  });

  it('樣本在檔案裡不連續（交錯音訊）時也成立', () => {
    let offset = 1000;
    const index = Array.from({ length: 150 }, () => {
      const s = { offset, size: 20000 };
      offset += 20000 + 7000;   // 中間夾著音訊樣本
      return s;
    });
    expect(walk(index, offset)).toEqual([]);
  });
});

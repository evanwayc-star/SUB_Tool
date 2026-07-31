/* 同軌鄰居：一份事實，三個問題。

   v5.9.0 之前 Seq 只有 neighborBounds()，而且它把「移動語義」烤進回傳值
   （hi 已經減掉自身長度）。於是 v5.8.0 要做「修改持續時間」時問不出
   「可以多長」，只好在 timeline-renderer 裡再手寫一份同軌掃描——同一件事
   在專案裡出現第三份實作。

   這支測試釘住的是：neighborsOnTrack() 回傳鄰居本身的座標，
   moveRange 與 maxLength 都由它導出，彼此不會漂掉。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { State } from '../src/state.js';
import { Seq } from '../src/sequence.js';

const clip = (o) => ({ id: o.id, in: o.in ?? 0, out: o.out ?? 10, offset: o.offset ?? 0, vtrack: o.vtrack ?? 0, type: o.type });

beforeEach(() => {
  State.clips = [];
  State.videoTracks = [{ name: 'V1' }, { name: 'V2' }];
  State.duration = 0;
  State.externalAudioEnd = 0;
});

describe('neighborsOnTrack', () => {
  it('沒有鄰居時右側是無限、左側是 0', () => {
    const c = clip({ id: 'a', out: 5, offset: 10 });
    State.clips = [c];
    expect(Seq.neighborsOnTrack(c)).toEqual({ prevEnd: 0, nextStart: Infinity });
  });

  it('回傳左鄰的右緣與右鄰的左緣（不預先扣掉自身長度）', () => {
    const a = clip({ id: 'a', out: 4, offset: 0 });     // 0–4
    const b = clip({ id: 'b', out: 3, offset: 10 });    // 10–13
    const c = clip({ id: 'c', out: 2, offset: 20 });    // 20–22
    State.clips = [a, b, c];
    expect(Seq.neighborsOnTrack(b)).toEqual({ prevEnd: 4, nextStart: 20 });
  });

  /* 別軌的段落必須擺在「若不過濾軌道就會被算成鄰居」的位置，
     否則這條測了等於沒測——完全罩住 b 的段落兩個分支都不會命中。 */
  it('只看同一視訊軌——不同軌重疊＝疊層，是正常用法', () => {
    const b = clip({ id: 'b', out: 3, offset: 10, vtrack: 0 });   // 10–13
    State.clips = [
      clip({ id: 'leftOnV2', out: 5, offset: 0, vtrack: 1 }),     // 0–5：若不過濾會成為 prevEnd
      b,
      clip({ id: 'rightOnV2', out: 2, offset: 20, vtrack: 1 }),   // 20–22：若不過濾會成為 nextStart
    ];
    expect(Seq.neighborsOnTrack(b)).toEqual({ prevEnd: 0, nextStart: Infinity });
  });

  it('多個左鄰取最靠近的那個右緣', () => {
    const target = clip({ id: 't', out: 2, offset: 20 });
    State.clips = [
      clip({ id: 'far', out: 2, offset: 0 }),    // 0–2
      clip({ id: 'near', out: 3, offset: 10 }),  // 10–13
      target,
    ];
    expect(Seq.neighborsOnTrack(target).prevEnd).toBe(13);
  });

  it('多個右鄰取最靠近的那個左緣', () => {
    const target = clip({ id: 't', out: 2, offset: 0 });
    State.clips = [
      target,
      clip({ id: 'near', out: 2, offset: 5 }),
      clip({ id: 'far', out: 2, offset: 40 }),
    ];
    expect(Seq.neighborsOnTrack(target).nextStart).toBe(5);
  });
});

describe('neighborBounds（可移動範圍）由鄰居事實導出', () => {
  it('右界＝右鄰左緣 − 自身長度', () => {
    const b = clip({ id: 'b', out: 3, offset: 10 });   // 長度 3
    State.clips = [clip({ id: 'a', out: 4, offset: 0 }), b, clip({ id: 'c', out: 2, offset: 20 })];
    expect(Seq.neighborBounds(b)).toEqual({ lo: 4, hi: 17 });   // 20 − 3
  });

  it('沒有右鄰時右界是無限', () => {
    const b = clip({ id: 'b', out: 3, offset: 10 });
    State.clips = [b];
    expect(Seq.neighborBounds(b).hi).toBe(Infinity);
  });

  it('空間不足時右界不會小於左界', () => {
    const b = clip({ id: 'b', out: 9, offset: 4 });    // 長度 9
    State.clips = [clip({ id: 'a', out: 4, offset: 0 }), b, clip({ id: 'c', out: 2, offset: 6 })];
    const r = Seq.neighborBounds(b);
    expect(r.hi).toBeGreaterThanOrEqual(r.lo);
  });
});

describe('maxLengthOnTrack（可以多長）由同一份事實導出', () => {
  it('上限＝下一段起點 − 自己的起點（不扣自身長度）', () => {
    const b = clip({ id: 'b', out: 3, offset: 10 });
    State.clips = [b, clip({ id: 'c', out: 2, offset: 25 })];
    expect(Seq.maxLengthOnTrack(b)).toBe(15);
  });

  it('沒有下一段時不設限——圖片可以自由延長', () => {
    const b = clip({ id: 'img', out: 3, offset: 10, type: 'image' });
    State.clips = [b];
    expect(Seq.maxLengthOnTrack(b)).toBe(Infinity);
  });

  it('別軌的段落不構成上限（位置刻意擺在會被誤算的地方）', () => {
    const b = clip({ id: 'b', out: 3, offset: 10, vtrack: 0 });   // 10–13
    State.clips = [b, clip({ id: 'other', out: 2, offset: 20, vtrack: 1 })];
    expect(Seq.maxLengthOnTrack(b)).toBe(Infinity);
  });

  it('緊貼著下一段時仍回傳正數，不會變成 0 或負數', () => {
    const b = clip({ id: 'b', out: 5, offset: 10 });
    State.clips = [b, clip({ id: 'c', out: 2, offset: 10 })];
    expect(Seq.maxLengthOnTrack(b)).toBeGreaterThan(0);
  });

  /* 這一條是整組的重點：兩個上限必須來自同一次掃描。
     過去它們是兩份獨立實作，改動其中一份不會讓另一份紅。 */
  it('移動上限與長度上限在數值上相互一致', () => {
    const b = clip({ id: 'b', out: 3, offset: 10 });   // 長度 3
    State.clips = [b, clip({ id: 'c', out: 2, offset: 25 })];
    const move = Seq.neighborBounds(b);
    const maxLen = Seq.maxLengthOnTrack(b);
    // 移動上限 + 自身長度 === 起點 + 長度上限 === 下一段起點
    expect(move.hi + Seq.len(b)).toBe(b.offset + maxLen);
    expect(move.hi + Seq.len(b)).toBe(25);
  });
});

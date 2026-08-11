import { describe, expect, it } from 'vitest';
import { TimelineTransport } from '../src/timeline-transport.js';

function createClock(){
  let now = 0;
  return {
    now: () => now,
    advance: milliseconds => { now += milliseconds; },
  };
}

function createTransport(clock){
  return new TimelineTransport({
    now: clock.now,
    toTimeline: (sourceTime, clip) => sourceTime - clip.in + clip.offset,
    toSource: (timelineTime, clip) => timelineTime - clip.offset + clip.in,
  });
}

describe('TimelineTransport', () => {
  /* 迴歸（v5.9.0 引入、v5.11.0 修）：空專案（還沒載入任何媒體）時
     `Media.pause()` 傳進來的 clip 是 null，而 sourceTime() 少了 timelineTime()
     那道守衛 → `Seq.toSource(t, null)` 讀 null.offset 丟 TypeError，
     pause() 在那一行中斷，後面的 video.pause()／playing=false／按鈕改回 ▶ 全部沒跑。
     使用者看到的是「按空白鍵停不下來」，而且畫面上沒有任何錯誤。 */
  it('沒有 clip 時兩個方向都是恆等映射，不可丟例外', () => {
    const transport = createTransport(createClock());
    for (const clip of [null, undefined]) {
      expect(() => transport.sourceTime(12.5, clip)).not.toThrow();
      expect(transport.sourceTime(12.5, clip)).toBe(12.5);
      expect(transport.timelineTime({ sourceTime: 12.5, clip })).toBe(12.5);
    }
    // 沒有 clip 也照樣夾成非負
    expect(transport.sourceTime(-3, null)).toBe(0);
  });

  it('空專案：開始虛擬時鐘後暫停不會丟例外，並回到時間軸時間', () => {
    const clock = createClock();
    const transport = createTransport(clock);
    transport.startVirtual(0);
    clock.advance(2000);
    let paused;
    expect(() => {
      paused = transport.pause({ sourceTime: 0, clip: null, virtual: true, useGap: false });
    }).not.toThrow();
    expect(paused).toBeCloseTo(2, 6);
    expect(transport.displayTime({ playing: false, virtual: true, clip: null })).toBeCloseTo(2, 6);
  });

  it('keeps source-driver time and public timeline time in separate domains', () => {
    const clock = createClock();
    const transport = createTransport(clock);
    const clip = { in: 10, offset: 100 };

    expect(transport.timelineTime({ sourceTime: 15, clip })).toBe(105);
    expect(transport.sourceTime(105, clip)).toBe(15);

    const seeked = transport.seek(105.017, {
      duration: 200,
      fps: 29.97,
      dropFrame: false,
    });
    const exactFps = 30000 / 1001;
    expect(seeked).toBeCloseTo(Math.round(105.017 * exactFps) / exactFps, 12);
    expect(transport.displayTime({ playing: false, sourceTime: 15, clip })).toBe(seeked);
  });

  it('owns virtual and gap clocks in timeline time without reading a stale media source', () => {
    const clock = createClock();
    const transport = createTransport(clock);

    transport.startVirtual(40);
    clock.advance(1250);
    expect(transport.timelineTime({ virtual: true, playbackRate: 1 })).toBeCloseTo(41.25, 10);
    expect(transport.timelineTime({
      virtual: true, playbackRate: 1, clip: { in: 10, offset: 100 },
    })).toBeCloseTo(131.25, 10);

    const paused = transport.pause({
      virtual: true,
      playbackRate: 1,
      fps: 25,
      dropFrame: false,
    });
    expect(paused).toBe(41.24);
    expect(transport.displayTime({ playing: false, virtual: true })).toBe(41.24);

    transport.enterGap(100, { running: true });
    clock.advance(500);
    expect(transport.timelineTime({ sourceTime: 4, playbackRate: 2 })).toBe(101);
    transport.freezeGap({ playbackRate: 2 });
    clock.advance(500);
    expect(transport.timelineTime({ sourceTime: 999, playbackRate: 2 })).toBe(101);
  });

  it('does not let the visual black-screen flag freeze an audio-only virtual clock', () => {
    const clock = createClock();
    const transport = createTransport(clock);

    transport.enterGap(10, { running: false });
    transport.startVirtual(40);
    clock.advance(500);

    expect(transport.timelineTime({
      virtual: true, playbackRate: 1, useGap: false,
    })).toBeCloseTo(40.5, 10);
  });

  it('stores a paused virtual clock back in source time before mapping it to a clip again', () => {
    const clock = createClock();
    const transport = createTransport(clock);
    const clip = { in: 10, offset: 100 };

    transport.startVirtual(15);
    expect(transport.pause({ virtual: true, clip, fps: 25, dropFrame: false })).toBe(105);
    expect(transport.virtualTime).toBe(15);
    expect(transport.displayTime({ playing: false, virtual: true, clip })).toBe(105);
  });

  it('keeps a paused frame target through small native/mpv settling jitter', () => {
    const clock = createClock();
    const transport = createTransport(clock);
    const clip = { in: 10, offset: 100 };
    const target = transport.seek(105, { duration: 200, fps: 25, dropFrame: false });

    expect(transport.observeSourceTime(15.05, {
      clip,
      playing: false,
      fps: 25,
      dropFrame: false,
    })).toBe(target);

    expect(transport.observeSourceTime(17, {
      clip,
      playing: false,
      fps: 25,
      dropFrame: false,
    })).toBe(107);
  });

  it('only treats sub-4-frame paused drift as mpv settling', () => {
    const clock = createClock();
    const transport = createTransport(clock);
    const clip = { in: 10, offset: 100 };
    const target = transport.seek(105, { duration: 200, fps: 25, dropFrame: false });

    expect(transport.observeSourceTime(15.15, {
      clip, playing: false, fps: 25, dropFrame: false,
    })).toBe(target);
    expect(transport.observeSourceTime(15.20, {
      clip, playing: false, fps: 25, dropFrame: false,
    })).toBe(105.20);
  });
});

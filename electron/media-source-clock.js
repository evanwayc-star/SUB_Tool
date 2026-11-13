/* FFmpeg 容器秒數與影片來源第零秒的 native 邊界；純函式，不做 I/O。 */
'use strict';

const { timestampOffset } = require('../shared/media-source-clock.cjs');

function sourceClockSeek(start, clock, digits = 6) {
  const offset = timestampOffset(clock);
  const seek = Number(Math.max(0, start - offset).toFixed(digits));
  return { seek, sourceStart: seek + offset, timestampOffset: offset + seek - start };
}

function sourceVideoClockSeek(start, clock) {
  const { seek } = sourceClockSeek(start, clock);
  // -ss 的重基準會先在來源 timebase 捨入，之後轉 AVTB 已無法找回
  // 被捨掉的精度。保留容器的原 PTS，僅扣容器原點，來源零點因此
  // 不隨 seek 改變；GOP pre-roll 仍可有界地 seek 到目標附近。
  return { seek, sourceStart: timestampOffset(clock),
    inputArgs: ['-copyts', '-start_at_zero', '-ss', seek.toFixed(6), '-noaccurate_seek'] };
}

function sourceAudioClockFilter(clock, sampleRate = 48000) {
  const offset = timestampOffset(clock);
  const shift = offset !== 0 ? `asetpts=PTS${offset > 0 ? '+' : ''}${offset.toFixed(6)}/TB,` : '';
  return `${shift}aresample=${sampleRate}:async=1:first_pts=0`;
}

function sourceVideoTimestampFilter(clock) {
  const ratio = value => {
    if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return NaN;
    const [n, d] = value.split('/').map(Number);
    return Number.isSafeInteger(n) && Number.isSafeInteger(d) && n > 0 && d > 0 ? n / d : NaN;
  };
  const tick = ratio(clock?.timeBase), rate = ratio(clock?.nominalFrameRate);
  // A millisecond container cannot represent NTSC frame boundaries exactly.
  // This is a HALF SOURCE TICK quantization policy, not proof of CFR: only
  // timestamps already within that bound of a nominal source grid point move.
  // Never synthesize N/rate timestamps, collapse VFR gaps or use overlay nearest.
  // Fine clocks, frame-sized ticks and grids exactly representable by the
  // source timebase need no compensation. The maximum correction is 0.5 ms.
  if (!(tick > 0.000001 && tick <= 0.001 && rate > 0 && rate <= 240)
    || Math.abs(1 / (tick * rate) - Math.round(1 / (tick * rate))) < 1e-7) return '';
  const offset = timestampOffset(clock);
  const position = `(PTS*TB+${offset})*${rate}`;
  const restored = `(round(${position})/${rate}-${offset})/TB`;
  const near = `lte(abs(${position}-round(${position})),${tick * rate / 2 + 1e-9})`;
  // The first decoded frame may still be the true source start, even after a
  // seek into a leading gap. Preserve it and never pull later frames before it.
  // Delivery's existing input pre-roll keeps this boundary before normal trims.
  return `settb=AVTB,setpts='if(eq(N,0),PTS,if(${near},max(STARTPTS,${restored}),PTS))',`;
}

function sourceFrameSelectionFilter(time, sourceStart = 0) {
  const targetTick = Math.round((Number(time) - Number(sourceStart)) * 1e6);
  // 保留 seek GOP 的原 PTS，目標以前的畫格壓到零點，遇到第一個
  // 未來畫格就結束。fps 因此取最後一個已抵達的畫格，也適用長 VFR
  // 格；來源首格之前的空白不准用未來首格填補零點。
  // 目標與 PTS 使用相同 AVTB tick 捨入；n/30 與 NTSC 的有理數
  // 格界不可因 PTS 捨入成 1/3 微秒後方，而被誤判為下一秒的格。
  // 尾端 PTS/duration 各自量化後，EOF 可能比探測時長早一 tick；只
  // 延長最後已解出的畫格供零點取樣，不能讓 fps 靜默輸出零張圖片。
  return `settb=AVTB,setpts='max(PTS-${targetTick},0)',trim=end=0.000001,tpad=stop_mode=clone:stop_duration=1,fps=1:round=up:start_time=0,trim=end_frame=1,setpts=PTS-STARTPTS`;
}

module.exports = { sourceClockSeek, sourceVideoClockSeek, sourceAudioClockFilter, sourceVideoTimestampFilter, sourceFrameSelectionFilter, timestampOffset };

import { describe, expect, it } from 'vitest';
import { buildExportSnapshot } from '../src/delivery-job.js';
import { getRecognitionClipRange, resolveRecognitionRange, sliceRecognitionClip } from '../src/recognition-range.js';
import { timelineTime } from '../src/sequence-time.js';

const clip = { id:'video', path:'episode.mp4', in:50, out:70, offset:8, speed:2 };
const state = { clips:[clip], duration:600, cues:[{ start:500, end:600 }], inPoint:4, outPoint:5 };

describe('辨識使用實際影片輸出範圍', () => {
  it.each([
    [null, null, 0, 18],
    [10, null, 10, 18],
    [null, 15, 0, 15],
    [12, 30, 12, 30],
  ])('輸出 In %s / Out %s 與交付的半開區間一致', (exportIn, exportOut, start, end) => {
    const input = { ...state, exportIn, exportOut };
    const delivery = buildExportSnapshot({ state:input, sequenceEnd:18 });
    expect(resolveRecognitionRange('export', input)).toEqual({ start, end, error:'' });
    expect(delivery.timelineStart).toBe(start);
    expect(delivery.duration).toBe(end - start);
    expect(resolveRecognitionRange('all', input)).toEqual({ start:0, end:18, error:'' });
  });

  it('包含待復原和靜音素材的結尾，已重連的外音以 live placement 為準', () => {
    const external = { audioSourceId:'audio', offset:40, in:4, out:12, speed:2, enabled:false };
    const input = { ...state, externalAudioState:[external] };
    const extra = {
      pendingClips:[{ path:'offline.mp4', offset:21, in:40, out:48, speed:2 }],
      liveExternalSources:[{ ...external, offset:20 }],
    };
    const delivery = buildExportSnapshot({ state:input, sequenceEnd:18, ...extra });
    expect(resolveRecognitionRange('all', input).end).toBe(44);
    expect(resolveRecognitionRange('export', input, extra)).toEqual({ start:0, end:25, error:'' });
    expect(delivery.duration).toBe(25);
  });

  it('無影音範圍、倒置、同一點或無限值都回報原因', () => {
    expect(resolveRecognitionRange('all', { duration:100 }).error).toBeTruthy();
    for (const [exportIn, exportOut] of [[3,2], [2,2], [-1,2], [2,Infinity], [20,null]]) {
      const range = resolveRecognitionRange('export', { ...state, exportIn, exportOut });
      expect(range.error).toBeTruthy();
      expect(sliceRecognitionClip(clip, range)).toBeNull();
    }
  });

  it('有效輸出區間位於空檔時，影片和外音皆沒有辨識工作', () => {
    const audio = { trimStart:1, trimEnd:2, offset:1, duration:90 };
    const empty = resolveRecognitionRange('export', { ...state, exportIn:3, exportOut:6 });
    expect(empty.error).toBe('');
    expect([clip,audio].map(item => sliceRecognitionClip(item, empty)).filter(Boolean)).toEqual([]);
  });
});

describe('辨識來源裁切保留字幕的絕對時間', () => {
  it.each([
    [false, 54, 64],
    [true, 56, 66],
  ])('變速來源 reverse=%s，來源與交付同區間，字幕仍在專案 10–15 秒', (reverse, sourceIn, sourceOut) => {
    const source = Object.freeze({ ...clip, reverse, recognitionTracks:[{ sourceStream:0 }] });
    const input = { ...state, clips:[source], exportIn:10, exportOut:15 };
    const [delivered] = buildExportSnapshot({ state:input, sequenceEnd:18 }).clips;
    const range = resolveRecognitionRange('export', input);
    const part = sliceRecognitionClip(source, range);
    expect(part).toMatchObject({ id:clip.id, path:clip.path, in:sourceIn, out:sourceOut,
      trimStart:sourceIn, trimEnd:sourceOut, offset:10, speed:2, reverse });
    expect(part.recognitionTracks).toBe(source.recognitionTracks);
    expect([part.in,part.out]).toEqual([delivered.in,delivered.out]);
    expect(part.offset).toBe(delivered.offset + range.start);
    expect(timelineTime(reverse ? part.out : part.in, part)).toBe(10);
    expect(timelineTime(reverse ? part.in : part.out, part)).toBe(15);
    expect(source.offset).toBe(8);
  });

  it('舊音訊的 start、trimStart／trimEnd 和 dur 也保留正確位置', () => {
    const source = { id:'old', start:12, trimStart:4, dur:20, speed:0.5, reverse:true };
    expect(getRecognitionClipRange(source)).toEqual({ start:12, end:44 });
    expect(getRecognitionClipRange({ ...source, trimEnd:4 })).toBeNull();
    expect(sliceRecognitionClip(source, { start:15, end:17 }))
      .toMatchObject({ in:17.5, out:18.5, offset:15, trimStart:17.5, trimEnd:18.5 });
    expect(sliceRecognitionClip({ ...source, trimEnd:6 }, { start:12, end:16 }))
      .toMatchObject({ in:4, out:6, offset:12 });
  });

  it('無交集及浮點表示的相鄰剪點不產生空工作；標準 NTSC 單格維持原精度', () => {
    expect(sliceRecognitionClip(clip, { start:18, end:20 })).toBeNull();
    expect(sliceRecognitionClip(clip, { start:5, end:8 })).toBeNull();
    expect(sliceRecognitionClip({ offset:0.1, in:0, out:0.2 }, { start:0.3, end:1 })).toBeNull();
    const fps = 30000/1001;
    const start = 600001 / fps, end = 600002 / fps;
    const span = resolveRecognitionRange('export', { clips:[{ in:100, out:120, offset:start }], exportIn:start, exportOut:end });
    expect(span).toEqual({ start, end, error:'' });
    const part = sliceRecognitionClip({ in:100, out:120, offset:start, speed:2, reverse:true }, span);
    expect(part.out).toBe(120);
    expect(part.offset).toBe(start);
    expect(timelineTime(part.in, part)).toBeCloseTo(end, 11);
  });
});

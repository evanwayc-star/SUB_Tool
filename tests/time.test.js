import { describe, it, expect } from 'vitest';
import { secToEncore, encoreToSec, snapTimeToFrame } from '../src/time.js';

// frame number n (at 30000/1001) -> 對應秒數，用來建構 DF 測試向量
const dfSec = (n) => (n * 1001) / 30000;

describe('secToEncore 非 Drop-frame', () => {
  it('整數 fps 逐位進位正確', () => {
    expect(secToEncore(0, 24)).toBe('00:00:00:00');
    expect(secToEncore(1, 24)).toBe('00:00:01:00');
    expect(secToEncore(14 / 24, 24)).toBe('00:00:00:14');
    expect(secToEncore(3661, 24)).toBe('01:01:01:00'); // 1h1m1s
    expect(secToEncore(1, 25)).toBe('00:00:01:00');
    expect(secToEncore(24 / 25, 25)).toBe('00:00:00:24');
  });
});

describe('secToEncore 29.97 Drop-frame（SMPTE 丟格/補格邊界）', () => {
  it('每分鐘邊界丟掉 ;00 ;01', () => {
    expect(secToEncore(dfSec(1799), 29.97, true)).toBe('00:00:59;29');
    expect(secToEncore(dfSec(1800), 29.97, true)).toBe('00:01:00;02'); // 跳過 ;00 ;01
  });
  it('每 10 分鐘那一刻不丟格', () => {
    expect(secToEncore(dfSec(17981), 29.97, true)).toBe('00:09:59;29');
    expect(secToEncore(dfSec(17982), 29.97, true)).toBe('00:10:00;00'); // 不丟
  });
  it('使用分號分隔符', () => {
    expect(secToEncore(0, 29.97, true)).toBe('00:00:00;00');
  });
});

describe('snapTimeToFrame 影格格網', () => {
  it('對齊到最近整格（整數 fps）', () => {
    expect(snapTimeToFrame(0.04, 24)).toBeCloseTo(1 / 24, 9);   // 0.96 格 -> 1 格
    expect(snapTimeToFrame(0.01, 24)).toBeCloseTo(0, 9);         // 0.24 格 -> 0 格
    expect(snapTimeToFrame(1.0, 25)).toBeCloseTo(1.0, 9);
  });
  it('無 fps 時原值返回', () => {
    expect(snapTimeToFrame(1.234, 0)).toBe(1.234);
  });
});

describe('round-trip：secToEncore <-> encoreToSec（整數 fps 應精確）', () => {
  for (const fps of [24, 25, 30]) {
    it(`fps=${fps} 對齊影格後來回一致`, () => {
      for (const raw of [0, 0.5, 1.0, 12.3456, 59.9, 3661.7, 7199.2]) {
        const snapped = snapTimeToFrame(raw, fps);
        const tc = secToEncore(snapped, fps);
        const back = encoreToSec(tc, fps);
        expect(back).toBeCloseTo(snapped, 6);
      }
    });
  }
  it('29.97 DF 來回一致（影格容差）', () => {
    for (const n of [0, 1800, 3600, 17982, 53946]) {
      const s = dfSec(n);
      const tc = secToEncore(s, 29.97, true);
      const back = encoreToSec(tc, 29.97, true);
      expect(back).toBeCloseTo(s, 3);
    }
  });
});

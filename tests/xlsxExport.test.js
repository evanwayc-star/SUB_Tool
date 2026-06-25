import { describe, it, expect } from 'vitest';
import { buildXLSX } from '../src/xlsxExport.js';

// 讀小端 uint16 / uint32
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

describe('buildXLSX 產生合法的 Store-mode ZIP/XLSX', () => {
  const out = buildXLSX(
    [{ name: '軌道1', cues: [{ start: 0, end: 1, text: 'hi' }, { start: 1, end: 2, text: 'yo' }] }],
    24,
    false
  );

  it('回傳非空 Uint8Array', () => {
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(100);
  });

  it('開頭為 ZIP local file header magic (PK\\x03\\x04)', () => {
    expect([out[0], out[1], out[2], out[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('結尾 22 bytes 為 EOCD，且檔案數 = 5 基底 + 軌道數', () => {
    const eocd = out.subarray(out.length - 22);
    expect(u32(eocd, 0)).toBe(0x06054b50); // EOCD signature
    expect(u16(eocd, 8)).toBe(6);  // 本磁碟項目數
    expect(u16(eocd, 10)).toBe(6); // 總項目數 = 5 base + 1 sheet
  });

  it('多軌 -> 每軌一個 sheet（檔案數隨之增加）', () => {
    const out2 = buildXLSX(
      [
        { name: 'A', cues: [{ start: 0, end: 1, text: 'a' }] },
        { name: 'B', cues: [{ start: 0, end: 1, text: 'b' }] },
      ],
      25,
      false
    );
    const eocd = out2.subarray(out2.length - 22);
    expect(u16(eocd, 10)).toBe(7); // 5 base + 2 sheets
  });
});

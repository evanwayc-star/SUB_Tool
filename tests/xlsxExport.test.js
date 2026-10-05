import { describe, it, expect } from 'vitest';
import { buildXLSX } from '../src/xlsx-export.js';
import { JSDOM } from 'jsdom';

// 讀小端 uint16 / uint32
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function zipTexts(bytes) {
  const entries = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (u32(bytes, offset) === 0x04034b50) {
    expect(u16(bytes, offset + 8)).toBe(0);
    const size = u32(bytes, offset + 18);
    const nameLength = u16(bytes, offset + 26);
    const dataStart = offset + 30 + nameLength + u16(bytes, offset + 28);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

function parseXml(text) {
  return new JSDOM(text, { contentType: 'application/xml' }).window.document;
}

// OOXML reader decodes once: an escaped underscore must leave following literal text intact.
function readXstring(text) {
  return text.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

describe('XLSX 成品內容與 Excel 文字規格', () => {
  it('工作表名稱合法、忽略大小寫去重，且截斷後不留下首尾引號', () => {
    const names = [" '字幕' ", 'History', 'history', 'A', 'a', "123456789012345678901234567890'尾", '', '特殊&<>"頁', ...Array(105).fill('很長的名稱'.repeat(8))];
    const entries = zipTexts(buildXLSX(names.map(name => ({ name, cues: [] })), 24, false));
    const document = parseXml(entries.get('xl/workbook.xml'));
    const sheets = [...document.querySelectorAll('sheet')].map(sheet => readXstring(sheet.getAttribute('name')));
    expect(sheets).toHaveLength(names.length);
    expect(new Set(sheets.map(name => name.toLowerCase())).size).toBe(names.length);
    for (const name of sheets) {
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/^[\s']|[\s']$|[\\/?*:\[\]\u0000-\u001f]/);
      expect(name.toLowerCase()).not.toBe('history');
    }
    expect(sheets[0]).toBe('字幕');
    expect(sheets[7]).toBe('特殊&<>"頁');
  });

  it('控制字元、literal escape 和 Unicode 以合法 XML 無損往返', () => {
    const text = '\u0001\u000b\u000d\u0000\ufffe _x0041_ _x005F_ _x000B_ \t &<>"\' 中文😀';
    const entries = zipTexts(buildXLSX([{ name: '_x0041_', cues: [{ start: 0, end: 1, text }] }], 24, false));
    // Validate every XML entry, not just ZIP magic or the worksheet containing the example.
    for (const xml of entries.values()) expect(() => parseXml(xml)).not.toThrow();
    const sheet = parseXml(entries.get('xl/worksheets/sheet1.xml'));
    expect(readXstring(sheet.querySelector('c[r="B2"] t').textContent)).toBe(text);
    const workbook = parseXml(entries.get('xl/workbook.xml'));
    expect(readXstring(workbook.querySelector('sheet').getAttribute('name'))).toBe('_x0041_');
  });
});

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

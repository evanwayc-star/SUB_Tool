import { describe, it, expect } from 'vitest';
import { clamp, pad, decodeText, encodeUTF16LE, b64ToBytes, bytesToB64, baseName, escapeHTML, tcKeyAllowed } from '../src/util.js';

describe('clamp / pad', () => {
  it('clamp 夾在範圍內', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it('pad 補零並向下取整', () => {
    expect(pad(5)).toBe('05');
    expect(pad(5, 3)).toBe('005');
    expect(pad(123)).toBe('123');
    expect(pad(1.9)).toBe('01');
  });
});

describe('escapeHTML / baseName', () => {
  it('跳脫 5 個 HTML 實體', () => {
    expect(escapeHTML(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('baseName 處理 Windows 與 POSIX 路徑', () => {
    expect(baseName('C:\\a\\b\\c.srt')).toBe('c.srt');
    expect(baseName('/a/b.txt')).toBe('b.txt');
    expect(baseName('plain.ass')).toBe('plain.ass');
  });
});

describe('decodeText 編碼偵測', () => {
  const u8 = (...bytes) => new Uint8Array(bytes).buffer;
  it('UTF-8 BOM', () => {
    const body = new TextEncoder().encode('café字幕');
    expect(decodeText(u8(0xEF, 0xBB, 0xBF, ...body))).toBe('café字幕');
  });
  it('UTF-16LE BOM', () => {
    expect(decodeText(encodeUTF16LE('hello 字幕').buffer)).toBe('hello 字幕');
  });
  it('UTF-16BE BOM', () => {
    // 'Hi' big-endian: 00 48 00 69
    expect(decodeText(u8(0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69))).toBe('Hi');
  });
  it('無 BOM 純 ASCII 視為 UTF-8', () => {
    const body = new TextEncoder().encode('plain ascii');
    expect(decodeText(body.buffer)).toBe('plain ascii');
  });
});

describe('encodeUTF16LE <-> decodeText round-trip', () => {
  it('含中文與一般字元', () => {
    for (const s of ['hello', '字幕測試', 'Mixed 混合 123']) {
      expect(decodeText(encodeUTF16LE(s).buffer)).toBe(s);
    }
  });
});

describe('tcKeyAllowed（時間碼輸入過濾）', () => {
  const k = (key, mods = {}) => tcKeyAllowed({ key, ...mods });
  it('允許數字與 : ; + -', () => {
    for (const c of ['0', '5', '9', ':', ';', '+', '-']) expect(k(c)).toBe(true);
  });
  it('擋掉字母（含 i / o）', () => {
    for (const c of ['i', 'o', 'a', 'Z', '.', '/', ' ']) expect(k(c)).toBe(false);
  });
  it('允許編輯/導覽鍵與 Enter/Esc', () => {
    for (const c of ['Backspace', 'Delete', 'ArrowLeft', 'Home', 'Tab', 'Enter', 'Escape']) expect(k(c)).toBe(true);
  });
  it('允許 Ctrl/Cmd 組合（複製貼上/全選）', () => {
    expect(k('a', { ctrlKey: true })).toBe(true);
    expect(k('v', { metaKey: true })).toBe(true);
  });
});

describe('base64', () => {
  it('bytesToB64 <-> b64ToBytes round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128]);
    expect(Array.from(b64ToBytes(bytesToB64(bytes)))).toEqual(Array.from(bytes));
  });
});

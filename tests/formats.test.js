import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SubFormats, splitN, decodeLegacyLineBreaks } from '../src/formats.js';

describe('SRT round-trip', () => {
  it('cues -> toSRT -> parseSRT 還原 start/end/text', () => {
    const cues = [
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4, text: 'Line1\nLine2' },
    ];
    const parsed = SubFormats.parseSRT(SubFormats.toSRT(cues));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].start).toBeCloseTo(1, 3);
    expect(parsed[0].end).toBeCloseTo(2.5, 3);
    expect(parsed[0].text).toBe('Hello');
    expect(parsed[1].text).toBe('Line1\nLine2');
  });

  it('保留 URL 內的雙斜線，只轉換 URL 外的舊式換行', () => {
    const input = `1
00:00:01,000 --> 00:00:02,000
網址 https://example.com/a//b//c 舊換行//下一行
`;
    expect(SubFormats.parseSRT(input)[0].text).toBe(
      '網址 https://example.com/a//b//c 舊換行\n下一行',
    );
  });
});

describe('ASS round-trip', () => {
  it('還原時間、文字（\\N 換行）與軌道（name=atgN）', () => {
    const cues = [
      { start: 1, end: 2, text: 'Hi', track: 0 },
      { start: 5, end: 6.5, text: 'A\nB', track: 1 },
    ];
    const ass = SubFormats.toASS(cues, 24, []);
    const parsed = SubFormats.parseASS(ass);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].start).toBeCloseTo(0.97, 2);
    expect(parsed[0].end).toBeCloseTo(1.97, 2);
    expect(parsed[0].text).toBe('Hi');
    expect(parsed[0].track).toBe(0);
    expect(parsed[1].text).toBe('A\nB');
    expect(parsed[1].track).toBe(1);
  });
  it('剝除 {} 樣式標籤', () => {
    const line = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,atg1,0,0,0,,{\\b1}粗體{\\b0}文字';
    const parsed = SubFormats.parseASS(line);
    expect(parsed[0].text).toBe('粗體文字');
  });

  it('round-trip 保留 URL、字面大括號與字面 ASS 控制序列', () => {
    const text = '網址 https://example.com/a//b\n字面{註}\\N\\h';
    const parsed = SubFormats.parseASS(SubFormats.toASS([
      { start: 1, end: 2, text, track: 0 },
    ], 25));

    expect(parsed[0].text).toBe(text);
  });

  it('只移除未跳脫 override tag，保留跳脫的大括號', () => {
    const line = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,atg1,0,0,0,,{\\b1}前\\{註\\}後{\\b0}';
    expect(SubFormats.parseASS(line)[0].text).toBe('前{註}後');
  });
});

describe('Encore round-trip', () => {
  it('已定時 cue 還原 start/end/text', () => {
    const cues = [{ start: 1, end: 2, text: 'Hello' }];
    const parsed = SubFormats.parseEncore(SubFormats.toEncore(cues, 24), 24);
    expect(parsed[0].start).toBeCloseTo(1, 3);
    expect(parsed[0].end).toBeCloseTo(2, 3);
    expect(parsed[0].text).toBe('Hello');
  });
  it('未定時列以 --:--:--:-- 表示並還原 timed:false', () => {
    const cues = [{ timed: false, text: 'untimed' }];
    const txt = SubFormats.toEncore(cues, 24);
    expect(txt).toContain('--:--:--:-- --:--:--:--');
    const parsed = SubFormats.parseEncore(txt, 24);
    expect(parsed[0].timed).toBe(false);
    expect(parsed[0].text).toBe('untimed');
  });

  it('Encore 與 TXT 都保留 URL 內雙斜線並支援舊式換行', () => {
    const encore = '00:00:01:00 00:00:02:00 https://example.com/a//b 舊//換行';
    expect(SubFormats.parseEncore(encore, 24)[0].text).toBe(
      'https://example.com/a//b 舊\n換行',
    );
    expect(SubFormats.parseTXT('https://example.com/a//b 舊//換行')[0].text).toBe(
      'https://example.com/a//b 舊\n換行',
    );
  });
});

describe('splitN', () => {
  it('切成 n 段，最後一段含其餘逗號', () => {
    expect(splitN('a,b,c,d', 2)).toEqual(['a', 'b', 'c,d']);
    expect(splitN('a,b', 5)).toEqual(['a', 'b']);
  });
});

describe('legacy line-break compatibility', () => {
  it('保留完整 URI token，並在 URI 外還原兩種舊式換行', () => {
    expect(decodeLegacyLineBreaks(
      'https://example.com/a//b file:///C:/media//clip 左\\\\右//下',
    )).toBe(
      'https://example.com/a//b file:///C:/media//clip 左\n右\n下',
    );
  });

  it('subio 不可在格式解析後再做第二次裸雙斜線轉換', () => {
    const source = readFileSync(new URL('../src/subio.js', import.meta.url), 'utf8');
    expect(source).not.toContain('convertLineBreaks');
  });
});

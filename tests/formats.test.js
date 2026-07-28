import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SubFormats, splitN, decodeLegacyLineBreaks } from '../src/formats.js';
import { uiFontNameFromAss } from '../src/substyle.js';

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
    expect(parsed.subtool).toBeUndefined(); // 即時 mpv／燒錄用 ASS 預設不夾帶完整專案 metadata
    expect(parsed[0].start).toBeCloseTo(1, 2);
    expect(parsed[0].end).toBeCloseTo(2, 2);
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

  it('外部 ASS 會把 Style 與文字前 override 轉成依 PlayResY 縮放的完整逐句樣式', () => {
    const text = `[Script Info]
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Imported,Safe; Font,60,&H0000FFFF,&H00000000,&H00112233,&H800000FF,0,0,0,0,100,100,2,-12,3,4,2,8,100,100,72,1
Style: Margins,Safe; Font,60,&H0000FFFF,&H00000000,&H00112233,&H800000FF,1,-1,0,0,100,100,2,-12,3,4,2,7,128,0,72,1
Style: OverrideMargin,Safe; Font,60,&H0000FFFF,&H00000000,&H00112233,&H800000FF,0,0,0,0,100,100,2,0,1,2,0,2,100,100,100,1
Style: Middle,Safe; Font,60,&H0000FFFF,&H00000000,&H00112233,&H800000FF,0,0,0,0,100,100,2,0,1,2,0,5,100,100,100,1
Style: LeftToCenter,Safe; Font,60,&H0000FFFF,&H00000000,&H00112233,&H800000FF,0,0,0,0,100,100,2,0,1,2,0,7,100,100,100,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Imported,,0,0,0,,{\\fs90\\pos(640,360)\\c&HFF0000&\\3c&H0000FF00&\\bord2\\shad4\\fsp3\\frz-15\\an7\\b700\\i1}前\\{註\\}後
Dialogue: 0,0:00:02.00,0:00:03.00,Margins,,0,0,0,,樣式邊界
Dialogue: 0,0:00:03.00,0:00:04.00,OverrideMargin,,100,0,50,,{\\an7\\b700}覆寫對齊與邊界
Dialogue: 0,0:00:04.00,0:00:05.00,Middle,,0,0,0,,中間對齊
Dialogue: 0,0:00:05.00,0:00:06.00,LeftToCenter,,0,0,0,,{\\an2}左轉中下
Dialogue: 0,0:00:06.00,0:00:07.00,Imported,,0,0,0,,前{\\b700}後
Dialogue: 0,0:00:07.00,0:00:08.00,Imported,,0,0,0,,{\\t(0,100,\\fs100)}不套動畫`;

    const parsed = SubFormats.parseASS(text);

    expect(parsed[0]).toMatchObject({ start: 1, end: 2, text: '前{註}後', track: 0 });
    expect(parsed[0].style).toMatchObject({
      font: 'Safe; Font', fontSize: 135, color: '#0000ff', bold: true, italic: true,
      letterSpacing: 4.5, outline: 3, outlineColor: '#00ff00', shadow: 6,
      bgBox: true, bgColor: '#ff0000', bgAlpha: 1 - 128 / 255,
      posX: 50, posY: 50, align: 'left', valign: 'top', angle: 15,
    });
    expect(parsed[1].style).toMatchObject({ posX: 10, posY: 10, align: 'left', valign: 'top' });
    expect(parsed[2].style).toMatchObject({ bold: true, posX: 100 / 1280 * 100, posY: 50 / 720 * 100, align: 'left', valign: 'top' });
    expect(parsed[3].style).toMatchObject({ posX: 50, posY: 50, align: 'center', valign: 'middle' });
    expect(parsed[4].style).toMatchObject({ posX: 50, posY: 100 - 100 / 720 * 100, align: 'center', valign: 'bottom' });
    expect(parsed[5].style).toMatchObject({ bold: false });
    expect(parsed[6].style).toMatchObject({ fontSize: 90, bold: false });
  });

  it('ASS 內部 family 可反查回 DOM 註冊的 UI 字型名，未知系統字型保持原名', () => {
    const fonts = [{ name: '台北黑體', family: 'Taipei Sans TC Beta' }];

    expect(uiFontNameFromAss('Taipei Sans TC Beta', fonts)).toBe('台北黑體');
    expect(uiFontNameFromAss('Arial', fonts)).toBe('Arial');
  });

  it('SUB Tool metadata 無損保留軌道與逐句樣式，以及 29.97 fps 的原始影格', () => {
    const fps = 29.97;
    const exactFps = 30000 / 1001;
    const tracks = [
      {
        name: '主字幕', visible: true, locked: false,
        font: '測試,字型;A', bold: true, italic: true, fontSize: 80, color: '#ffcc00',
        letterSpacing: 2, lineSpacing: 1.4, outline: 3, outlineColor: '#112233', shadow: 2,
        vertical: false, bgBox: true, bgColor: '#001122', bgAlpha: 0.6,
        posX: 47, posY: 82, align: 'left', valign: 'middle', angle: 12,
      },
      {
        name: '直書軌', visible: true, locked: true,
        font: '另一字型', bold: false, italic: false, fontSize: 60, color: '#ffffff',
        letterSpacing: 4, lineSpacing: 1.2, outline: 2, outlineColor: '#000000', shadow: 0,
        vertical: true, bgBox: false, bgColor: '#000000', bgAlpha: 0.5,
        posX: 62, posY: 75, align: 'right', valign: 'bottom', angle: -8,
      },
    ];
    const cues = [
      {
        id: 'cue-main', start: 100 / exactFps, end: 136 / exactFps, text: '第一行\n第二行', track: 0,
        style: { fontSize: 96, color: '#33ccff', posX: 41, posY: 77, angle: 15, bgBox: false },
      },
      {
        id: 'cue-note', start: 0, end: 0, text: '未定時備註', track: 1, timed: false,
        style: { vertical: true, letterSpacing: 6, lineSpacing: 1.8, align: 'center', valign: 'top' },
      },
    ];

    const ass = SubFormats.toASS(
      cues, fps, tracks, 1920, 1080, 1920, 1920, 1080,
      { includeMetadata: true, dropFrame: true },
    );
    const parsed = SubFormats.parseASS(ass);

    expect(ass).toMatch(/^; SUBTOOL-META:1:1\/\d+:/m);
    expect(ass).toContain('Dialogue:');
    expect(parsed.subtool).toMatchObject({
      version: 1,
      fps,
      dropFrame: true,
      tracks,
      cues: [
        {
          id: 'cue-main', startFrame: 100, endFrame: 136, start: cues[0].start, end: cues[0].end,
          text: cues[0].text, track: 0, timed: true, style: cues[0].style,
        },
        {
          id: 'cue-note', startFrame: 0, endFrame: 0, start: 0, end: 0,
          text: cues[1].text, track: 1, timed: false, style: cues[1].style,
        },
      ],
    });
  });

  it('外部 ASS 或毀損 metadata 仍走標準 Dialogue 解析', () => {
    const text = `[Script Info]
; SUBTOOL-META:1:1/2:broken
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,外部字幕`;
    const parsed = SubFormats.parseASS(text);

    expect(parsed.subtool).toBeUndefined();
    expect(parsed).toEqual([{ start: 1, end: 2, text: '外部字幕', track: 0 }]);
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

  it('中文標點會結束 URI，後方舊式換行仍要解碼', () => {
    expect(decodeLegacyLineBreaks(
      '網址https://example.com，舊換行//下一行',
    )).toBe(
      '網址https://example.com，舊換行\n下一行',
    );
    expect(decodeLegacyLineBreaks(
      '（https://example.com）//下一行',
    )).toBe(
      '（https://example.com）\n下一行',
    );
  });

  it('subio 不可在格式解析後再做第二次裸雙斜線轉換', () => {
    const source = readFileSync(new URL('../src/subio.js', import.meta.url), 'utf8');
    expect(source).not.toContain('convertLineBreaks');
  });
});

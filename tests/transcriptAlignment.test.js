import { describe, expect, it } from 'vitest';
import { alignTranscriptToEvidence, parseTranscriptLines } from '../src/transcript-alignment.js';

describe('逐行文字稿時間匹配', () => {
  it('正規化換行、忽略全空白行，並裁掉每行首尾空白', () => {
    expect(parseTranscriptLines('  第一句。第二句！  \r\n\r\n  Third. Fourth!  ')).toEqual([
      '第一句。第二句！',
      'Third. Fourth!'
    ]);
  });

  it('完全保留使用者逐行內容，不因同一行包含多個句子而再次拆分', () => {
    const transcript = [
      '你好，世界。這仍是同一行！',
      'SUB Tool is ready. Keep this line.'
    ].join('\n');
    const evidenceSegments = [
      {
        start: 0.1,
        end: 1.8,
        text: '你好世界這仍是同一行',
        words: [
          { text: '你好', start: 0.1, end: 0.45 },
          { text: '世界', start: 0.55, end: 0.9 },
          { text: '這仍是', start: 1, end: 1.35 },
          { text: '同一行', start: 1.4, end: 1.8 }
        ]
      },
      {
        start: 2.2,
        end: 4.1,
        text: 'sub tool is ready keep this line',
        words: [
          { text: 'SUB', start: 2.2, end: 2.45 },
          { text: 'Tool', start: 2.5, end: 2.8 },
          { text: 'is', start: 2.9, end: 3.05 },
          { text: 'ready', start: 3.1, end: 3.35 },
          { text: 'keep', start: 3.5, end: 3.7 },
          { text: 'this', start: 3.75, end: 3.9 },
          { text: 'line', start: 3.95, end: 4.1 }
        ]
      }
    ];

    const result = alignTranscriptToEvidence({ transcript, evidenceSegments, language: 'zh' });

    expect(result.status).toBe('aligned');
    expect(result.segments).toEqual([
      expect.objectContaining({ start: 0.1, end: 1.8, text: '你好，世界。這仍是同一行！' }),
      expect.objectContaining({ start: 2.2, end: 4.1, text: 'SUB Tool is ready. Keep this line.' })
    ]);
    expect(result.segments).toHaveLength(2);
  });

  it('辨識稿漏字時仍維持單調對齊，不會拿下一行的同字補前一行', () => {
    const result = alignTranscriptToEvidence({
      transcript: '今天下雨。\n下次見。',
      evidenceSegments: [
        {
          start: 0,
          end: 1,
          text: '今天雨',
          words: [
            { text: '今天', start: 0, end: 0.5 },
            { text: '雨', start: 0.7, end: 1 }
          ]
        },
        {
          start: 1.5,
          end: 2.2,
          text: '下次見',
          words: [
            { text: '下', start: 1.5, end: 1.7 },
            { text: '次見', start: 1.8, end: 2.2 }
          ]
        }
      ],
      language: 'zh'
    });

    expect(result.status).toBe('aligned');
    expect(result.segments.map(segment => ({ text: segment.text, start: segment.start, end: segment.end })))
      .toEqual([
        { text: '今天下雨。', start: 0, end: 1 },
        { text: '下次見。', start: 1.5, end: 2.2 }
      ]);
  });

  it('只有句級時間證據時仍保留每一行，並標示為需要抽查的估算時間', () => {
    const result = alignTranscriptToEvidence({
      transcript: '第一行保持完整。\nSecond line stays whole.',
      evidenceSegments: [{
        start: 5,
        end: 9,
        text: '第一行保持完整 second line stays whole'
      }],
      language: 'auto'
    });

    expect(result.status).toBe('aligned');
    expect(result.segments.map(segment => segment.text)).toEqual([
      '第一行保持完整。',
      'Second line stays whole.'
    ]);
    expect(result.segments.every(segment => segment.alignment.status === 'review')).toBe(true);
    expect(result.summary).toMatchObject({ timingEvidence: 'segment', reviewCount: 2 });
    expect(result.segments[0].end).toBeLessThanOrEqual(result.segments[1].start);
  });

  it('兩行落在同一個逐字時間範圍時拒絕偽造不重疊時間碼', () => {
    const result = alignTranscriptToEvidence({
      transcript: '紐約\n大學',
      evidenceSegments: [{
        start: 1,
        end: 2,
        text: '紐約大學',
        words: [{ text: '紐約大學', start: 1, end: 2 }]
      }],
      language: 'zh'
    });

    expect(result.status).toBe('failed');
    expect(result.summary.ambiguousLines).toEqual([0, 1]);
  });
});

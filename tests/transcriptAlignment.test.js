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

  it('整體精確詞覆蓋不足時列出低覆蓋行，即使每行仍勉強有時間錨點', () => {
    const result = alignTranscriptToEvidence({
      transcript: 'alpha beta\ngamma delta',
      evidenceSegments: [{
        start: 0,
        end: 4,
        text: 'alpha wrong gamma other',
        words: [
          { text: 'alpha', start: 0, end: 0.8 },
          { text: 'wrong', start: 1, end: 1.8 },
          { text: 'gamma', start: 2, end: 2.8 },
          { text: 'other', start: 3, end: 3.8 }
        ]
      }]
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toMatchObject({
      coverage: 0.5,
      unmatchedLines: [],
      ambiguousLines: [],
      lowCoverageLines: [0, 1]
    });
  });

  it('高覆蓋稿件只有零星漏句時保留可靠錨點並產生需校對的完整初稿', () => {
    const transcriptLines = Array.from({ length: 20 }, (_, index) => (
      index === 10 ? 'missing phrase' : `anchor${index} a b c d e f g h i`
    ));
    const evidenceSegments = transcriptLines.flatMap((text, index) => (
      index === 10 ? [] : [{ start: index * 2, end: (index * 2) + 1, text }]
    ));
    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary).toMatchObject({
      unmatchedLines: [],
      ambiguousLines: [],
      estimatedLines: [10]
    });
    expect(result.segments[9]).toMatchObject({ start: 18, end: 19 });
    expect(result.segments[11]).toMatchObject({ start: 22, end: 23 });
    expect(result.segments[10]).toMatchObject({
      text: 'missing phrase',
      timed: true,
      alignment: {
        status: 'review',
        timingEvidence: 'interpolated'
      }
    });
    expect(result.segments[10].start).toBeGreaterThanOrEqual(19);
    expect(result.segments[10].end).toBeLessThanOrEqual(22);
    expect(result.segments[10].end).toBeGreaterThan(result.segments[10].start);
  });

  it('漏句仍有部分逐字證據時優先使用真正的 word timestamps', () => {
    const transcriptLines = Array.from({ length: 20 }, (_, index) => (
      index === 10
        ? 'in this forest summer winter'
        : `anchor${index} one two three four five six seven eight nine ten eleven twelve thirteen`
    ));
    const evidenceSegments = transcriptLines.flatMap((text, index) => {
      if (index !== 10) return [{ start: index * 3, end: (index * 3) + 1, text }];
      return [{
        start: 30,
        end: 31,
        text: 'summer winter',
        words: [
          { text: 'summer', start: 30, end: 30.4 },
          { text: 'winter', start: 30.5, end: 31 }
        ]
      }];
    });
    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary).toMatchObject({
      unmatchedLines: [],
      estimatedLines: [],
      partialEvidenceLines: [10]
    });
    expect(result.segments[10]).toMatchObject({
      timed: true,
      start: 30,
      end: 31,
      alignment: {
        status: 'review',
        timingEvidence: 'word',
        tokenCoverage: 0.4
      }
    });
  });

  it('只有 segment 句級證據時不得假標為逐字 partial evidence', () => {
    const transcriptLines = Array.from({ length: 20 }, (_, index) => (
      index === 10
        ? 'in this forest summer winter'
        : `anchor${index} one two three four five six seven eight nine ten eleven twelve thirteen`
    ));
    const evidenceSegments = transcriptLines.flatMap((text, index) => (
      index === 10
        ? [{ start: 30, end: 31, text: 'summer winter' }]
        : [{ start: index * 3, end: (index * 3) + 1, text }]
    ));

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.partialEvidenceLines).toEqual([]);
    expect(result.summary.estimatedLines).toEqual([10]);
    expect(result.segments[10].alignment).toMatchObject({
      status: 'review',
      timingEvidence: 'interpolated'
    });
  });

  it('低信心行相隔過遠的精確詞不得重新合成跨群 partial cue', () => {
    const prefix = Array.from({ length: 10 }, (_, index) => `prefix${index} a b c d e f g h i`);
    const suffix = Array.from({ length: 9 }, (_, index) => `suffix${index} a b c d e f g h i`);
    const transcriptLines = [...prefix, 'good x y z morning', ...suffix];
    const evidenceSegments = [
      ...prefix.map((text, index) => ({ start: index, end: index + 0.5, text })),
      {
        start: 20,
        end: 30.4,
        text: 'good morning',
        words: [
          { text: 'good', start: 20, end: 20.4 },
          { text: 'morning', start: 30, end: 30.4 }
        ]
      },
      ...suffix.map((text, index) => ({ start: 40 + index, end: 40.5 + index, text }))
    ];

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.discontinuousEvidenceLines).toEqual([10]);
    expect(result.summary.partialEvidenceLines).toEqual([]);
    expect(result.summary.estimatedLines).toEqual([10]);
    expect(result.segments[10].end - result.segments[10].start).toBeLessThan(8);
  });

  it('segment exact token 不得替遠距 word partial 證據充當橋樑', () => {
    const transcriptLines = Array.from({ length: 20 }, (_, index) => (
      index === 10
        ? 'good a b c d e middle sir winner'
        : `anchor${index} one two three four five six seven eight nine`
    ));
    const evidenceSegments = transcriptLines.flatMap((text, index) => {
      if (index < 10) return [{ start: index, end: index + 0.5, text }];
      if (index > 10) return [{ start: 40 + index - 11, end: 40.5 + index - 11, text }];
      return [
        {
          start: 20,
          end: 20.4,
          text: 'good',
          words: [{ text: 'good', start: 20, end: 20.4 }]
        },
        { start: 27, end: 27.4, text: 'middle' },
        {
          start: 34,
          end: 35.4,
          text: 'sir winner',
          words: [
            { text: 'sir', start: 34, end: 34.4 },
            { text: 'winner', start: 35, end: 35.4 }
          ]
        }
      ];
    });

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.partialEvidenceLines).toEqual([]);
    expect(result.summary.estimatedLines).toEqual([10]);
    expect(result.segments[10].alignment.timingEvidence).toBe('interpolated');
    expect(result.segments[10].end - result.segments[10].start).toBeLessThan(8);
  });

  it('漏句比例過高時不會用推估時間掩蓋稿件版本錯誤', () => {
    const lines = Array.from({ length: 10 }, (_, index) => (
      index === 4 ? 'missing' : (index === 5 ? 'absent' : `anchor${index} a b c d e f g h i`)
    ));
    const evidenceSegments = lines.flatMap((text, index) => (
      index === 4 || index === 5
        ? []
        : [{ start: index * 2, end: (index * 2) + 1, text }]
    ));

    const result = alignTranscriptToEvidence({
      transcript: lines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('failed');
    expect(result.summary.unmatchedLines).toEqual([4, 5]);
    expect(result.summary.estimatedLines).toEqual([]);
  });

  it('短稿只要一行漏句超過百分之五就必須失敗', () => {
    const result = alignTranscriptToEvidence({
      transcript: [
        'alpha a b c d e f g h i',
        'missing phrase',
        'omega a b c d e f g h i'
      ].join('\n'),
      evidenceSegments: [
        { start: 0, end: 2, text: 'alpha a b c d e f g h i' },
        { start: 5, end: 7, text: 'omega a b c d e f g h i' }
      ]
    });

    expect(result.status).toBe('failed');
    expect(result.summary.unmatchedLines).toEqual([1]);
    expect(result.summary.estimatedLines).toEqual([]);
  });

  it('不會把相隔很遠的替代詞納入字幕時間邊界', () => {
    const result = alignTranscriptToEvidence({
      transcript: [
        'The best name in the world.',
        'Are there perhaps any other girls in the house?',
        'Other girls, you ask?'
      ].join('\n'),
      evidenceSegments: [
        { start: 0, end: 1, text: 'The best name in the world.' },
        { start: 2, end: 2.2, text: 'Oh.' },
        { start: 5, end: 5.2, text: 'Oh.' },
        { start: 10, end: 11, text: 'Any other girls in the house?' },
        { start: 12, end: 13, text: 'Other girls, you ask?' }
      ]
    });

    expect(result.status).toBe('aligned');
    expect(result.segments[1]).toMatchObject({ start: 10, end: 11 });
  });

  it('低覆蓋行的精確詞相隔過遠時只採連續錨點並標示需校對', () => {
    const anchor = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    const result = alignTranscriptToEvidence({
      transcript: [anchor, 'good morning sir', anchor].join('\n'),
      evidenceSegments: [
        { start: 0, end: 2, text: anchor },
        {
          start: 3,
          end: 20.4,
          text: 'good morning',
          words: [
            { text: 'good', start: 3, end: 3.4 },
            { text: 'morning', start: 20, end: 20.4 }
          ]
        },
        { start: 21, end: 23, text: anchor }
      ]
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.discontinuousEvidenceLines).toEqual([1]);
    expect(result.segments[1]).toMatchObject({
      start: 20,
      end: 20.4,
      alignment: { status: 'review', timingEvidence: 'word' }
    });
  });

  it('不連續行捨棄的精確詞會優先回填緊鄰的漏句', () => {
    const prefix = Array.from({ length: 30 }, (_, index) => `prefix${index}`);
    const suffix = Array.from({ length: 30 }, (_, index) => `suffix${index}`);
    const transcriptLines = [
      ...prefix,
      'good morning',
      'precious nuts',
      'good morning sir',
      ...suffix
    ];
    const evidenceSegments = [
      ...prefix.map((text, index) => ({ start: index, end: index + 0.5, text })),
      {
        start: 40,
        end: 60.4,
        text: 'good morning',
        words: [
          { text: 'good', start: 40, end: 40.4 },
          { text: 'morning', start: 60, end: 60.4 }
        ]
      },
      ...suffix.map((text, index) => ({ start: 61 + index, end: 61.5 + index, text }))
    ];

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.partialEvidenceLines).toContain(30);
    expect(result.summary.estimatedLines).toContain(31);
    expect(result.summary.discontinuousEvidenceLines).toContain(32);
    expect(result.segments[30]).toMatchObject({
      start: 40,
      end: 40.4,
      alignment: { status: 'review', timingEvidence: 'word' }
    });
    expect(result.segments[32]).toMatchObject({ start: 60, end: 60.4 });
  });

  it('回填漏句時也不得把多個遠距 discarded word 群重新跨接', () => {
    const prefix = Array.from({ length: 30 }, (_, index) => `prefix${index}`);
    const suffix = Array.from({ length: 30 }, (_, index) => `suffix${index}`);
    const transcriptLines = [
      ...prefix,
      'good morning',
      'precious nuts',
      'good morning sir x y',
      ...suffix
    ];
    const evidenceSegments = [
      ...prefix.map((text, index) => ({ start: index, end: index + 0.5, text })),
      {
        start: 40,
        end: 80.4,
        text: 'good morning sir',
        words: [
          { text: 'good', start: 40, end: 40.4 },
          { text: 'morning', start: 60, end: 60.4 },
          { text: 'sir', start: 80, end: 80.4 }
        ]
      },
      ...suffix.map((text, index) => ({ start: 81 + index, end: 81.5 + index, text }))
    ];

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.partialEvidenceLines).toContain(30);
    expect(result.summary.estimatedLines).toContain(31);
    expect(result.summary.discontinuousEvidenceLines).toContain(32);
    expect(result.segments[30]).toMatchObject({
      start: 60,
      end: 60.4,
      alignment: { status: 'review', timingEvidence: 'word' }
    });
    expect(result.segments[30].end - result.segments[30].start).toBeLessThan(8);
    expect(result.segments[32]).toMatchObject({ start: 80, end: 80.4 });
  });

  it('回填句未匹配的中間 word 不得替兩個遠距 exact 詞充當橋樑', () => {
    const prefix = Array.from({ length: 30 }, (_, index) => `prefix${index}`);
    const suffix = Array.from({ length: 30 }, (_, index) => `suffix${index}`);
    const transcriptLines = [
      ...prefix,
      'good sir',
      'precious nuts',
      'good middle sir owner later x y z q',
      ...suffix
    ];
    const evidenceSegments = [
      ...prefix.map((text, index) => ({ start: index, end: index + 0.5, text })),
      {
        start: 40,
        end: 81.9,
        text: 'good middle sir owner later x y',
        words: [
          { text: 'good', start: 40, end: 40.4 },
          { text: 'middle', start: 47, end: 47.4 },
          { text: 'sir', start: 54, end: 54.4 },
          { text: 'owner', start: 80, end: 80.4 },
          { text: 'later', start: 80.5, end: 80.9 },
          { text: 'x', start: 81, end: 81.4 },
          { text: 'y', start: 81.5, end: 81.9 }
        ]
      },
      ...suffix.map((text, index) => ({ start: 83 + index, end: 83.5 + index, text }))
    ];

    const result = alignTranscriptToEvidence({
      transcript: transcriptLines.join('\n'),
      evidenceSegments
    });

    expect(result.status).toBe('recovered');
    expect(result.summary.partialEvidenceLines).toContain(30);
    expect(result.summary.estimatedLines).toContain(31);
    expect(result.summary.discontinuousEvidenceLines).toContain(32);
    expect(result.segments[30]).toMatchObject({ start: 54, end: 54.4 });
    expect(result.segments[30].end - result.segments[30].start).toBeLessThan(8);
    expect(result.segments[32]).toMatchObject({ start: 80, end: 81.9 });

    const reversedTranscriptLines = [...transcriptLines];
    reversedTranscriptLines[30] = 'sir good';
    const reversed = alignTranscriptToEvidence({
      transcript: reversedTranscriptLines.join('\n'),
      evidenceSegments
    });
    expect(reversed.status).toBe('recovered');
    expect(reversed.summary.partialEvidenceLines).toContain(30);
    expect(reversed.segments[30]).toMatchObject({ start: 54, end: 54.4 });
  });
});

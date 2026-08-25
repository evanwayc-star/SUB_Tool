import { describe, expect, it } from 'vitest';
import { buildTranscriptAlignmentDiagnostic } from '../src/transcript-alignment-diagnostic.js';

describe('文本匹配安全診斷資料', () => {
  it('只匯出解析後的文字與時間，並以一基行號列出不可靠行', () => {
    const diagnostic = buildTranscriptAlignmentDiagnostic({
      generatedAt: '2026-08-25T12:34:56.000Z',
      provider: 'azure',
      language: 'en',
      audioSelection: {
        mode: 'source-channels',
        channels: [
          { sourceStream: 1, sourceChannel: 6, trackName: 'private-name' },
          { sourceStream: 1, sourceChannel: 7, path: 'C:\\private\\audio.wav' }
        ],
        url: 'subtool-local://resource/private-token'
      },
      sourceName: 'C:\\private\\Cinderella.mxf?token=path-secret',
      transcript: ' First line. \nSecond line.',
      evidenceSegments: [{
        start: 1,
        end: 3,
        text: 'first different line',
        words: [{ text: 'first', start: 1, end: 1.4, confidence: 0.91, apiKey: 'word-secret' }],
        locale: 'en-US',
        speaker: 2,
        channel: 0,
        confidence: 0.72,
        apiKey: 'segment-secret',
        headers: { 'Ocp-Apim-Subscription-Key': 'header-secret' },
        audioBlob: new Blob(['not-audio'], { type: 'audio/wav' })
      }],
      alignmentResult: {
        status: 'failed',
        segments: [
          {
            text: 'First line.',
            timed: true,
            start: 1,
            end: 2,
            alignment: { status: 'matched', score: 0.9, tokenCoverage: 0.8, timingEvidence: 'word' }
          },
          {
            text: 'Second line.',
            timed: false,
            alignment: { status: 'unmatched', score: 0.2, tokenCoverage: 0, timingEvidence: 'word' }
          }
        ],
        summary: {
          coverage: 0.5,
          timingEvidence: 'word',
          reviewCount: 0,
          unmatchedLines: [1],
          ambiguousLines: [0],
          lowCoverageLines: [0]
        }
      },
      apiKey: 'top-level-secret',
      headers: { Authorization: 'Bearer top-secret' }
    });

    expect(diagnostic).toEqual({
      schema: 'subtool-transcript-alignment-diagnostic-v1',
      generatedAt: '2026-08-25T12:34:56.000Z',
      timeDomain: 'source-relative-seconds',
      provider: 'azure',
      language: 'en',
      audioSelection: {
        mode: 'source-channels',
        channels: [
          { sourceStream: 1, sourceChannel: 6 },
          { sourceStream: 1, sourceChannel: 7 }
        ]
      },
      transcriptLineCount: 2,
      transcriptLines: ['First line.', 'Second line.'],
      alignmentStatus: 'failed',
      summary: {
        coverage: 0.5,
        timingEvidence: 'word',
        reviewCount: 0,
        unreliableLineCount: 2
      },
      unreliableLines: [
        {
          lineNumber: 1,
          text: 'First line.',
          reasons: ['ambiguous', 'low-coverage'],
          timed: true,
          start: 1,
          end: 2,
          alignment: { status: 'matched', score: 0.9, tokenCoverage: 0.8, timingEvidence: 'word' }
        },
        {
          lineNumber: 2,
          text: 'Second line.',
          reasons: ['unmatched'],
          timed: false,
          alignment: { status: 'unmatched', score: 0.2, tokenCoverage: 0, timingEvidence: 'word' }
        }
      ],
      evidenceSegments: [{
        start: 1,
        end: 3,
        text: 'first different line',
        words: [{ text: 'first', start: 1, end: 1.4, confidence: 0.91 }],
        locale: 'en-US',
        speaker: 2,
        channel: 0,
        confidence: 0.72
      }]
    });

    const serialized = JSON.stringify(diagnostic);
    for (const forbidden of [
      'top-level-secret', 'segment-secret', 'word-secret', 'header-secret',
      'Bearer top-secret', 'Ocp-Apim-Subscription-Key', 'audio/wav', 'C:\\private', 'path-secret',
      'private-name', 'private-token'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('provider 與 language 只接受既知值，但核准的稿件文字仍完整保留', () => {
    const diagnostic = buildTranscriptAlignmentDiagnostic({
      generatedAt: 'C:\\Private\\generated-at-secret',
      provider: 'C:\\Private\\provider-secret',
      language: 'https://private.invalid/language',
      transcript: '台詞本身提到 C:\\劇情內路徑',
      evidenceSegments: [{
        start: 0,
        end: 1,
        text: '辨識文字',
        locale: 'C:\\Private\\locale-secret'
      }],
      alignmentResult: {
        status: 'https://private.invalid/status-secret',
        segments: [{
          timed: false,
          alignment: {
            status: 'C:\\Private\\alignment-status-secret',
            timingEvidence: 'https://private.invalid/timing-secret'
          }
        }],
        summary: {
          unmatchedLines: [0],
          timingEvidence: 'https://private.invalid/summary-timing-secret'
        }
      }
    });

    expect(diagnostic.generatedAt).toBe('unknown');
    expect(diagnostic.provider).toBe('unknown');
    expect(diagnostic.language).toBe('auto');
    expect(diagnostic.alignmentStatus).toBe('failed');
    expect(diagnostic.summary.timingEvidence).toBe('none');
    expect(diagnostic.unreliableLines[0].alignment).toMatchObject({
      status: 'unmatched',
      timingEvidence: 'none'
    });
    expect(diagnostic.evidenceSegments[0]).not.toHaveProperty('locale');
    expect(diagnostic.transcriptLines).toEqual(['台詞本身提到 C:\\劇情內路徑']);
    const serialized = JSON.stringify(diagnostic);
    for (const forbidden of [
      'generated-at-secret', 'provider-secret', 'private.invalid', 'locale-secret',
      'alignment-status-secret', 'timing-secret', 'summary-timing-secret'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('保留 UI 正式支援的日文與韓文語言代碼', () => {
    expect(buildTranscriptAlignmentDiagnostic({ language: 'ja' }).language).toBe('ja');
    expect(buildTranscriptAlignmentDiagnostic({ language: 'ko' }).language).toBe('ko');
  });
});

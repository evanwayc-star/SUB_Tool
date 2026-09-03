import { describe, expect, it, vi } from 'vitest';
import { resolveRecognitionAlignment } from '../src/transcript-alignment.js';

describe('recognition alignment result', () => {
  it('轉錄模式保留原始時間證據而不呼叫對齊器', () => {
    const align = vi.fn(); const evidenceSegments = [{ start: 0, end: 1, text: 'hi' }];
    expect(resolveRecognitionAlignment({ taskMode: 'transcribe', transcript: '', evidenceSegments, alignTranscriptToEvidence: align }))
      .toEqual({ segments: evidenceSegments, alignment: null });
    expect(align).not.toHaveBeenCalled();
  });
  it('匹配模式優先採用完整原稿 segments', () => {
    const completeSegments = [{ text: '固定文字', start: 1, end: 2 }];
    const result = resolveRecognitionAlignment({ taskMode: 'align', transcript: '固定文字', evidenceSegments: [], alignTranscriptToEvidence: () => ({ status: 'recovered', completeSegments }) });
    expect(result.segments).toBe(completeSegments);
    expect(result.alignment.status).toBe('recovered');
  });
});

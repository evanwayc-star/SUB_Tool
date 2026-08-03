import { describe, it, expect, vi } from 'vitest';
import { validateSubtitlesBeforeExport } from '../src/subtitle-validator.js';
import * as stateModule from '../src/state.js';

// Mock State
vi.mock('../src/state.js', () => ({
  State: {
    cues: []
  }
}));

describe('validateSubtitlesBeforeExport', () => {
  it('should return empty array if no cues', () => {
    stateModule.State.cues = [];
    expect(validateSubtitlesBeforeExport()).toEqual([]);
  });

  it('should detect missing timecodes', () => {
    stateModule.State.cues = [
      { id: '1', start: 0, end: 1, text: 'Hello', track: 0 },
      { id: '2', start: 1, text: 'No end', track: 0 }, // Missing end
      { id: '3', end: 3, text: 'No start', track: 0 }, // Missing start
      { id: '4', start: 4, end: 3, text: 'Invalid', track: 0 } // end <= start
    ];
    
    const errors = validateSubtitlesBeforeExport(30);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/無效的時間碼/);
  });

  it('should detect overlapping timecodes', () => {
    stateModule.State.cues = [
      { id: '1', start: 0, end: 2.5, text: 'First', track: 0 },
      { id: '2', start: 2.4, end: 4, text: 'Overlap', track: 0 },
      { id: '3', start: 4.1, end: 5, text: 'Valid', track: 0 }
    ];
    
    const errors = validateSubtitlesBeforeExport(30);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/時間碼與前一句重疊/);
  });

  it('should detect multi-line (>2 lines) text', () => {
    stateModule.State.cues = [
      { id: '1', start: 0, end: 1, text: 'Line 1\\NLine 2', track: 0 }, // 2 lines
      { id: '2', start: 1, end: 2, text: 'Line 1\\NLine 2\\NLine 3', track: 0 }, // 3 lines
      { id: '3', start: 2, end: 3, text: 'Line 1\nLine 2\nLine 3', track: 0 } // 3 lines (raw \n)
    ];
    
    const errors = validateSubtitlesBeforeExport(30);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/字幕超過 3 行/);
  });

  it('should detect exceeding word limit', () => {
    stateModule.State.cues = [
      { id: '1', start: 0, end: 1, text: '這是一句非常長的字幕超過了三十個字數限制請注意這是一句非常長的字幕', track: 0 }, // 33 chars
      { id: '2', start: 1, end: 2, text: 'Hello World', track: 0 } // 10 chars (spaces removed)
    ];
    
    const errors = validateSubtitlesBeforeExport(30);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/字數過多/);
  });
});

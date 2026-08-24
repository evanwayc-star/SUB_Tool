import { describe, it, expect } from 'vitest';
import {
  splitCueAtTime,
  mergeTwoCues,
  swapCueTexts,
} from '../src/subtitle-edit-pipeline.js';

describe('subtitle-edit-pipeline', () => {
  it('在指定時間點精準分割字幕', () => {
    const cue = { id: 'c1', start: 1.0, end: 4.0, text: '前半段後半段' };
    const res = splitCueAtTime(cue, 2.5, 'c2', '前半段', '後半段');

    expect(res).not.toBeNull();
    expect(res.first.end).toBe(2.5);
    expect(res.first.text).toBe('前半段');
    expect(res.second.id).toBe('c2');
    expect(res.second.start).toBe(2.5);
    expect(res.second.end).toBe(4.0);
    expect(res.second.text).toBe('後半段');
  });

  it('分割時間在範圍外時回傳 null 防呆', () => {
    const cue = { id: 'c1', start: 1.0, end: 4.0, text: '測試' };
    expect(splitCueAtTime(cue, 0.5, 'c2')).toBeNull();
    expect(splitCueAtTime(cue, 5.0, 'c2')).toBeNull();
  });

  it('相鄰字幕合併', () => {
    const c1 = { id: 'c1', start: 1.0, end: 2.0, text: '第一句' };
    const c2 = { id: 'c2', start: 2.0, end: 3.5, text: '第二句' };

    const merged = mergeTwoCues(c1, c2, ' ');
    expect(merged.start).toBe(1.0);
    expect(merged.end).toBe(3.5);
    expect(merged.text).toBe('第一句 第二句');
  });

  it('交換兩句字幕文字', () => {
    const c1 = { id: 'c1', text: '文字A' };
    const c2 = { id: 'c2', text: '文字B' };

    const swapped = swapCueTexts(c1, c2);
    expect(swapped.cue1.text).toBe('文字B');
    expect(swapped.cue2.text).toBe('文字A');
  });
});

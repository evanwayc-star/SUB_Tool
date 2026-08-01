// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderSeekBar } from '../src/seekbar.js';

describe('播放器進度條端點', () => {
  function bar(value = '0') {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '10000';
    input.value = value;
    return input;
  }

  it.each([
    [0, '0%'],
    [5, '50%'],
    [10, '100%'],
  ])('時間軸 %s 秒對應正確填色端點', (seconds, expected) => {
    const input = bar();
    renderSeekBar(input, seconds);
    expect(input.style.getPropertyValue('--seek-progress')).toBe(expected);
  });

  it('無有效範圍時把填色限制在 0%', () => {
    const input = bar('10000');
    input.max = '0';
    expect(renderSeekBar(input)).toBe(0);
    expect(input.style.getPropertyValue('--seek-progress')).toBe('0%');
  });
});

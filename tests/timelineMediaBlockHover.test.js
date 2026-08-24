// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { paintClipBlocks } from '../src/painters/clip-painter.js';

describe('時間軸素材區塊的懸停行為', () => {
  it('音訊素材區塊本身不設定原生 title，滑鼠停留時不會跳出多行資訊框', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/timeline-renderer.js'),
      'utf8'
    );
    const start = source.indexOf('function renderAudioTrackRows(){');
    const end = source.indexOf('function renderAtrackGutter(){', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toMatch(/block\.title\s*=/u);
  });

  it('影片片段本身不設定原生 title，滑鼠停留時不會跳出片段資訊框', () => {
    const container = document.createElement('div');
    paintClipBlocks(container, {
      rows: [{ vtrack: 0, visible: true, top: 0, height: 42 }],
      clips: [{
        id: 'video-hover',
        vtrack: 0,
        x: 0,
        w: 320,
        name: 'Movie.mov',
        escapedName: 'Movie.mov',
        trackName: '視訊軌 1',
        timeRangeStr: '00:00:00:00 → 00:00:05:00',
        inStr: '0.000',
        outStr: '5.000',
        durStr: '5.000',
        isImg: false,
        trimmed: false,
        hasFade: false,
        active: false,
        selected: false,
        locked: false,
      }],
    });

    const block = container.querySelector('.clip-block');
    expect(block).not.toBeNull();
    expect(block.getAttribute('title')).toBeNull();
    expect(block.querySelector('.clip-label')?.textContent).toContain('Movie.mov');
  });
});

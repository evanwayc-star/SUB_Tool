import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULER_H } from '../src/timeline-interaction-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const renderer = read('src/timeline-renderer.js');
const css = read('src/styles.css');

describe('時間軸刻度操作帶', () => {
  it('使用 36px 實際命中高度，並同步左側軌道標頭', () => {
    expect(RULER_H).toBe(36);
    expect(renderer).toContain("style.setProperty('--timeline-ruler-height',RULER_H+'px')");
    expect(css).toMatch(/\.tl-gutter-head\{height:var\(--timeline-ruler-height,36px\)/);
  });

  it('刻度尺使用 RGB 65 灰底、近白文字與高對比兩級刻度', () => {
    expect(renderer).toContain("ctx.fillStyle='rgb(65,65,65)'");
    expect(renderer).toContain("ctx.fillStyle='#f2f4f7'");
    expect(renderer).toContain("ctx.strokeStyle='#d8dde5'");
    expect(renderer).toContain("ctx.strokeStyle='#9299a3'");
    expect(css).toMatch(/#rulerCanvas\{[^}]*background:rgb\(65,65,65\)[^}]*cursor:pointer/);
  });
});

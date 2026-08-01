/* 播放器 transport 的 Mac 窄欄版面安全網。

   Apple Silicon 實機在預設分割比例下，播放器欄只有約 783px。過去 seekBar 的
   100px inline 最小寬，加上 transport 的 10px gap，會迫使 `.tc` 縮到 129px；
   兩個完整時碼因此換成上下兩列。jsdom 不做 layout，這裡直接守住造成修復的
   CSS／HTML 不變量，實際幾何另由安裝版 CDP 驗收。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const css = read('src/styles.css');
const html = read('index.html');

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `找不到 ${selector} CSS 規則`).not.toBeNull();
  return match[1].replace(/\s+/g, '');
}

describe('播放器時間在 Mac 窄欄仍保持單行', () => {
  it('時碼不可 shrink 或換行', () => {
    const rule = declarations('.tc');
    expect(rule).toContain('white-space:nowrap');
    expect(rule).toContain('flex:00auto');
  });

  it('transport 與 seek bar 保留 783px 欄位所需空間', () => {
    expect(declarations('.transport')).toContain('gap:6px');
    const range = declarations('.transport input[type=range]');
    expect(range).toContain('min-width:60px');
    expect(range).toContain('margin:0');
  });

  it('窄欄把交付工具整組換列，極窄欄再拆 TC 與 seek', () => {
    expect(declarations('.left')).toContain('container-type:inline-size');
    expect(html).toMatch(/class="transport-tools"[\s\S]*data-act="exp-in"[\s\S]*data-act="mixer"/);
    expect(css).toContain('@container (max-width:779px)');
    expect(css).toContain('@container (max-width:600px)');
    expect(css).toContain('.transport-tools{grid-column:1/-1;justify-self:end}');
  });

  it('seekBar 不可用 inline style 蓋回較大的最小寬', () => {
    const tag = html.match(/<input\b[^>]*\bid="seekBar"[^>]*>/)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).not.toMatch(/\bstyle=/);
  });

  it('依使用者決定移除不重要的前後 5 秒按鈕', () => {
    expect(html).not.toContain('data-act="back5"');
    expect(html).not.toContain('data-act="fwd5"');
  });
});

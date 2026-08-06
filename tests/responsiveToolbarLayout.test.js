/* Mac 1470px 寬實機曾出現三種同源問題：頂列最後兩顆掉行、時間軸按鈕被壓成
   逐字換行、字幕樣式面板多出橫向捲軸。jsdom 不做排版，這裡守住已經用安裝版
   CDP 量過的 responsive CSS／HTML 結構。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `找不到 ${selector} CSS 規則`).not.toBeNull();
  return match[1].replace(/\s+/g, '');
}

describe('Mac 工具列 responsive 版面', () => {
  it('頂部工具列維持單列，窄視窗只隱藏按鈕文字', () => {
    const menu = declarations('.menubar');
    expect(menu).toContain('flex-wrap:nowrap');
    /* 水平方向仍然要裁——這一條守的是「窄視窗時工具列不可以撐爆版面」。
       但【不可以是 overflow:hidden】：hidden 會連帶把垂直軸變成 auto，
       把工具列裡的下拉選單一起裁掉（v6.1.12 的真實事故，見
       tests/menubarClipping.test.js）。clip 不會，所以垂直軸留得住 visible。 */
    expect(menu).toContain('overflow-x:clip');
    expect(menu).not.toContain('overflow:hidden');
    expect(css).toContain('@media(max-width:1250px){.menubar button.icon .lbl{display:none}}');
    expect(html).toMatch(/id="stMonitorBtn"[\s\S]*class="lbl">監控序列/);
    expect(html).toMatch(/data-act="exp-video"[\s\S]*class="lbl">匯出影片/);
  });

  it('時間軸工具列不縮字、不折字，窄視窗改用既有圖示', () => {
    const toolbar = declarations('.tl-toolbar');
    expect(toolbar).toContain('gap:4px');
    expect(toolbar).toContain('white-space:nowrap');
    expect(declarations('.tl-toolbar>*')).toContain('flex-shrink:0');
    expect(css).toContain('.tl-toolbar .compact-icon{display:inline}');
    expect(html).toMatch(/data-act="zoom-fit"[\s\S]*class="compact-icon"/);
  });

  it('字幕樣式只讓控制群整組換行，不產生第二條橫向捲軸', () => {
    const line = declarations('.ts-line');
    expect(line).toContain('flex-wrap:wrap');
    expect(line).toContain('overflow-x:hidden');
    expect(declarations('.ts-group')).toContain('flex:00auto');
    expect(html.match(/class="ts-group"/g)?.length).toBeGreaterThanOrEqual(10);
  });
});

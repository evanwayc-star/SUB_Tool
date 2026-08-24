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
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const subtitleModel = fs.readFileSync(path.join(ROOT, 'src/subtitle-model.js'), 'utf8');

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `找不到 ${selector} CSS 規則`).not.toBeNull();
  return match[1].replace(/\s+/g, '');
}

function standaloneDeclarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `找不到獨立的 ${selector} CSS 規則`).not.toBeNull();
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

  it('監控序列左側使用佇列狀態圓環，並尊重減少動態效果設定', () => {
    expect(html).toMatch(/id="stMonitorBtn"[^>]*>\s*<span class="queue-monitor-ring" aria-hidden="true"><\/span>\s*<span class="lbl">監控序列<\/span>/);
    expect(declarations('.queue-monitor-ring')).toContain('border-radius:50%');
    expect(declarations('#stMonitorBtn.queue-running .queue-monitor-ring')).toContain('animation:queue-monitor-spin');
    expect(css).toContain('@keyframes queue-monitor-spin');
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)[\s\S]*#stMonitorBtn\.queue-running \.queue-monitor-ring\s*\{[^}]*animation:none/);
  });

  it('時間軸工具列不縮字、不折字，窄視窗改用既有圖示', () => {
    const toolbar = declarations('.tl-toolbar');
    expect(toolbar).toContain('gap:4px');
    expect(toolbar).toContain('white-space:nowrap');
    expect(declarations('.tl-toolbar>*')).toContain('flex-shrink:0');
    expect(css).toContain('.tl-toolbar .compact-icon{display:inline}');
    expect(html).toMatch(/data-act="zoom-fit"[\s\S]*class="compact-icon"/);
  });

  it('滑鼠跳轉狀態位於裁切與設定之間，並保留兩個可讀狀態', () => {
    expect(html).toMatch(/data-act="toggle-ow-keep"[\s\S]*data-act="toggle-pointer-seek"[\s\S]*data-act="settings"/);
    expect(html).toMatch(/data-act="toggle-ow-keep"[^>]*>[^<]*<\/button>\s*<div class="sep"><\/div>\s*<button[^>]*data-act="toggle-pointer-seek"/);
    expect(html).toMatch(/class="pointer-seek-btn"[^>]*>跳轉繼續<\/button>/);
    expect(css).toContain('.pointer-seek-btn.pause');
  });

  it('頂部狀態按鈕統一使用純文字與無外框色塊', () => {
    expect(html).toMatch(/class="ow-toggle-btn"[^>]*>不覆蓋<\/button>/);
    expect(html).toMatch(/class="ow-keep-btn[^"]*"[^>]*>保留<\/button>/);
    for (const source of [app, subtitleModel]) {
      expect(source).toContain("State.overwriteMode ? '可覆蓋' : '不覆蓋'");
      expect(source).toContain("State.overwriteKeep ? '保留' : '裁切'");
    }
    for (const selector of [
      '.ow-keep-btn',
      '.ow-keep-btn.del',
      '.ow-keep-btn.inactive-mode',
      '.pointer-seek-btn',
      '.pointer-seek-btn.pause',
    ]) {
      expect(standaloneDeclarations(selector)).not.toContain('border');
    }
    expect(standaloneDeclarations('.ow-keep-btn.del')).toContain('background:rgba(239,68,68,.08)');
    expect(standaloneDeclarations('.ow-keep-btn.inactive-mode')).toContain('background:rgba(150,150,150,.08)');
    expect(standaloneDeclarations('.pointer-seek-btn')).toContain('background:rgba(59,130,246,.08)');
    expect(standaloneDeclarations('.pointer-seek-btn.pause')).toContain('background:rgba(245,158,11,.08)');
  });

  it('時間軸標題後保留收合把手，已選取狀態與縮放控制項獨立於收合群組外保持常駐', () => {
    expect(html).toMatch(/tl-toolbar-title[\s\S]*id="tlToolbarToggle"[\s\S]*id="tlToolbarOptions"[\s\S]*project-audio-count[\s\S]*data-act="zoom-fit"/);
    expect(html).toMatch(/id="tlToolbarOptions"[\s\S]*project-audio-count[\s\S]*<\/div>\s*<div class="spacer"><\/div>\s*<span id="tlSel">[\s\S]*class="zoom"/);
    expect(declarations('.tl-toolbar-options')).toContain('display:flex');
    expect(declarations('.tl-toolbar-options[hidden]')).toContain('display:none');
    expect(declarations('.tl-toolbar #tlSel')).toContain('flex-shrink:0');
    expect(declarations('.tl-toolbar .zoom')).toContain('flex-shrink:0');
  });

  it('字幕樣式只讓控制群整組換行，不產生第二條橫向捲軸', () => {
    const line = declarations('.ts-line');
    expect(line).toContain('flex-wrap:wrap');
    expect(line).toContain('overflow-x:hidden');
    expect(declarations('.ts-group')).toContain('flex:00auto');
    expect(html.match(/class="ts-group"/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it('全軌套用與保留座標使用兩種可區分的功能圖示', () => {
    expect(html).toMatch(/id="tsUnify"[^>]*>[\s\S]*class="ts-unify-icon ts-unify-icon--all"[^>]*aria-hidden="true"[\s\S]*<span>全軌套用<\/span>/);
    expect(html).toMatch(/id="tsUnifyExclude"[^>]*>[\s\S]*class="ts-unify-icon ts-unify-icon--preserve-position"[^>]*aria-hidden="true"[\s\S]*<span>全軌套用-排除座標<\/span>/);
    expect(declarations('.ts-unify-action')).toContain('display:inline-flex');
    expect(declarations('.ts-unify-icon')).toContain('stroke:currentColor');
    expect(html).not.toMatch(/id="tsUnify(?:Exclude)?"[^>]*>\s*⇩/);
  });
});

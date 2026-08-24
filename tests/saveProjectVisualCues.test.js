// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
const rootDeclarations = css.match(/:root\s*\{([^}]+)\}/)?.[1] || '';
const rootVariables = new Map(
  [...rootDeclarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()])
);
// jsdom 尚不會解析 var() 的 computed style；測試時展開 :root 色票後再檢查實際套用結果。
const resolvedCss = css.replace(/var\((--[\w-]+)\)/g, (source, name) => rootVariables.get(name) || source);

describe('儲存專案視覺提示', () => {
  beforeAll(() => {
    const style = document.createElement('style');
    style.textContent = resolvedCss;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="menubar">
        <button class="icon" data-act="save-project">💾 <span class="lbl">儲存專案</span></button>
        <button class="icon" data-act="exp-dialog">💬 <span class="lbl">匯出字幕</span></button>
      </div>
      <div class="toast show">已儲存專案</div>
    `;
  });

  it('頂部儲存專案與匯出字幕使用完全相同的樣式', () => {
    const saveStyle = getComputedStyle(document.querySelector('[data-act="save-project"]'));
    const exportStyle = getComputedStyle(document.querySelector('[data-act="exp-dialog"]'));
    expect(saveStyle.backgroundColor).toBe(exportStyle.backgroundColor);
    expect(saveStyle.borderColor).toBe(exportStyle.borderColor);
    expect(saveStyle.color).toBe(exportStyle.color);
    expect(saveStyle.fontWeight).toBe(exportStyle.fontWeight);
    expect(css).toMatch(/button\[data-act="save-project"\]:hover,\s*button\[data-act="exp-dialog"\]:hover\s*\{/);
  });

  it('toast 在原框外增加淺紅色外框', () => {
    const style = getComputedStyle(document.querySelector('.toast'));
    expect(style.outlineColor).toBe('rgb(252, 165, 165)');
    expect(style.outlineStyle).toBe('solid');
    expect(style.outlineWidth).toBe('2px');
    expect(style.outlineOffset).toBe('2px');
  });
});

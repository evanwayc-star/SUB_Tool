// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

describe('字幕列表目前播放與選取提示', () => {
  beforeAll(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = '<div class="sublist"><div class="sub-row sel active"><span class="idx">1</span></div></div>';
  });

  it('黃色選取條保留 5px 固定槽位，切換時文字不位移', () => {
    const row = document.querySelector('.sub-row');
    const selected = getComputedStyle(row);
    expect(selected.borderLeftWidth).toBe('5px');
    const selectedPadding = selected.paddingLeft;

    row.classList.remove('sel');
    const unselected = getComputedStyle(row);
    expect(unselected.borderLeftWidth).toBe('5px');
    expect(unselected.borderLeftColor).toBe('rgba(0, 0, 0, 0)');
    expect(unselected.paddingLeft).toBe(selectedPadding);
  });

  it('藍色目前播放條是 5px，與黃色選取條並排時都清楚可見', () => {
    const row = document.querySelector('.sub-row');
    row.classList.add('sel', 'active');
    expect(getComputedStyle(row).boxShadow).toMatch(/inset\s+5px\s+0\s+0/);
  });

  it('黃色選取條不做漸變等待，狀態改變同一幀就顯示', () => {
    const rowRules = [...css.matchAll(/\.sub-row\s*\{([^}]+)\}/g)].map(match => match[1]);
    const transitions = rowRules.flatMap(rule => (
      [...rule.matchAll(/transition\s*:\s*([^;]+)/g)].map(match => match[1])
    ));
    expect(transitions.length).toBeGreaterThan(0);
    for(const transition of transitions){
      expect(transition).not.toMatch(/(^|,)\s*all(?:\s|,|$)/);
      expect(transition).not.toContain('border-color');
    }
  });

  it('各種字幕警示底色不會覆蓋黃色選取條', () => {
    const row = document.querySelector('.sub-row');
    const variants = ['blank', 'two-line', 'no-time', 'multi-line', 'overlap', 'search-hit', 'contains-match', 'swap-src'];
    row.className = 'sub-row sel';
    const selectedColor = getComputedStyle(row).borderLeftColor;

    for(const variant of variants){
      row.className = `sub-row sel ${variant}`;
      expect(getComputedStyle(row).borderLeftColor, variant).toBe(selectedColor);
    }
  });

  it('上字幕模式沿用既有規則：隱藏藍色目前播放條但保留黃色選取條', () => {
    const row = document.querySelector('.sub-row');
    row.className = 'sub-row sel active';
    const selectedColor = getComputedStyle(row).borderLeftColor;

    document.body.classList.add('sub-mode-on');
    const subMode = getComputedStyle(row);
    expect(subMode.boxShadow).toBe('none');
    expect(subMode.borderLeftColor).toBe(selectedColor);
    document.body.classList.remove('sub-mode-on');
  });
});

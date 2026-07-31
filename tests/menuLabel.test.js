/* 右鍵選單標籤的圖示／文字拆分。

   壞掉的樣子完全是無聲的：圖示沒被拆出來就會留在文字欄，
   那一列的文字比別列往右縮排一個 emoji 的寬度。畫面照樣能用、
   主控台零錯誤，只有把選單截圖下來逐列對齊才看得出來。

   v5.10.0 之前是寫死的字元清單，十四種圖示沒被涵蓋。
   這支測試把「涵蓋範圍」釘住：任何一個實際用在選單上的圖示都必須拆得出來。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitMenuLabel } from '../src/menu-label.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 圖示清單是**從原始碼掃出來的**，不是手寫的。

   手寫清單有一個致命弱點：它只涵蓋「寫清單的人當時知道的圖示」。
   新增一個用了新圖示的選單項目時，沒有人會想到回來加一筆——
   而那正是這支測試要防的那個 bug 的成因（舊實作寫死十種字元，
   後來陸續加了十四種都沒人回來補）。
   改成掃原始碼之後，新圖示會自動進入涵蓋範圍；漏拆就會當場紅。 */
const ICONS = (() => {
  const src = ['src/timeline-renderer.js', 'src/menus.js', 'src/app.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const found = new Set();
  for (const m of src.matchAll(/label:\s*[`'"]([^`'"]{1,40})/g)) {
    const first = [...m[1]][0];
    if (first && /[\p{Extended_Pictographic}\p{So}\p{Sm}]/u.test(first)) found.add(first);
  }
  return [...found];
})();

describe('圖示拆分', () => {
  /* 掃描本身要能證明自己有作用——掃不到東西時上面那圈迴圈會一筆都不跑，
     整組測試「全綠」卻什麼都沒測。 */
  it('掃得到選單實際用到的圖示（掃描沒有失效）', () => {
    expect(ICONS.length).toBeGreaterThanOrEqual(20);
  });

  for (const icon of ICONS) {
    it(`「${icon}」拆得出來`, () => {
      expect(splitMenuLabel(`${icon} 測試文字`)).toEqual({ icon, text: '測試文字' });
    });
  }

  it('圖示與文字之間沒有空格也拆得出來', () => {
    expect(splitMenuLabel('⏱播放頭移到此段開頭')).toEqual({ icon: '⏱', text: '播放頭移到此段開頭' });
  });

  it('連續兩個圖示視為同一個圖示欄（例：🔗✂ 解除影音連結）', () => {
    const r = splitMenuLabel('🔗✂ 解除影音連結');
    expect(r.text).toBe('解除影音連結');
    expect(r.icon).toBe('🔗✂');
  });

  it('純文字項目不會被誤拆，圖示欄留空', () => {
    for (const plain of ['在播放點切割 (Ctrl+K)', '從序列移除', '重設修剪（還原完整長度）']) {
      expect(splitMenuLabel(plain)).toEqual({ icon: '', text: plain });
    }
  });

  it('括號開頭的項目不會被當成圖示', () => {
    expect(splitMenuLabel('（無）').icon).toBe('');
  });

  it('空字串與 null 安全', () => {
    expect(splitMenuLabel('')).toEqual({ icon: '', text: '' });
    expect(splitMenuLabel(null)).toEqual({ icon: '', text: '' });
    expect(splitMenuLabel(undefined)).toEqual({ icon: '', text: '' });
  });

  /* 這一條是整組的重點：拆完之後，所有項目的文字欄都不該還留著圖示。
     舊實作在這裡會紅——它只認得十種字元。 */
  it('沒有任何一種圖示會殘留在文字欄裡', () => {
    const leftovers = ICONS
      .map(i => ({ i, text: splitMenuLabel(`${i} 項目`).text }))
      .filter(r => r.text !== '項目');
    expect(leftovers).toEqual([]);
  });
});

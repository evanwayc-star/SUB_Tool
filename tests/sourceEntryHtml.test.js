/* 根目錄的 index.html 必須是【Vite 原始碼入口】，不可以是建置產物。
   ================================================================================

   真實事故（發生過兩次，第二次就在 v6.1.9）：
   打包後為了驗證 asar 內容跑了

       npx asar extract-file release/win-unpacked/resources/app.asar dist/index.html

   **在專案根目錄**。`asar extract-file` 是依 **basename** 把檔案寫到 cwd 的——
   於是它把 796 KB 的建置產物寫成了 `./index.html`，把 32 KB 的原始碼入口整個蓋掉。
   第一次（v6.1.7，commit dbc047b）後面還跟了 `rm -f index.html`，直接把檔案刪了；
   第二次（v6.1.9，commit 9544570）沒有刪，但被 `git add -A` 掃進了版本庫。

   兩次都是【靜默】的：
   - `npm run lint`、`npm test`、`npm run build` 全綠——vite 會把「建置產物」當成
     一份合法的 HTML 入口再 bundle 一次，照樣 exit 0 並吐出一個看起來正常的 dist。
   - `git status` 看起來也只是一個檔案被改了，混在其他正常改動裡不顯眼。
   真正會炸的時機在很久以後：某次有人改了 index.html 的版面，卻發現改了沒有效果，
   或是整份工具列的原始標記已經找不回來了。

   所以這裡用【建置期才會出現的標記】把兩者區分開，當成一道機械式的絆索：

   | 標記 | 原始碼 | 建置產物 |
   |------|--------|---------|
   | `<script type="module" src="/src/main.js">` | 有 | 無（已內嵌） |
   | `Content-Security-Policy` meta | 無 | 有（vite.config.js 的 injectCSP，`apply: 'build'`） |
   | 檔案大小 | ~32 KB | ~800 KB |

   要改這支測試前先想清楚：如果 index.html 真的多了一個 CSP meta，那多半代表
   有人又把產物蓋上去了，而不是這支測試過時了。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

describe('根目錄 index.html 是原始碼入口', () => {
  it('保有 Vite 的模組入口 script', () => {
    /* 建置產物裡這一行會被換成內嵌的 <script>…整包 bundle…</script>。 */
    expect(html).toMatch(/<script\s+type="module"\s+src="\/src\/main\.js"><\/script>/);
  });

  it('沒有建置期才注入的 CSP meta', () => {
    /* vite.config.js 的 injectCSP() 是 `apply: 'build'`——原始碼裡出現它，
       就代表這份檔案是被建置產物蓋掉的。 */
    expect(html).not.toContain('Content-Security-Policy');
  });

  it('沒有內嵌整包 bundle（大小應該是原始碼的量級）', () => {
    /* 原始碼約 32 KB，單檔建置產物約 800 KB。200 KB 的門檻留了很大的成長空間，
       同時仍能在產物被寫進來的當下就攔住。 */
    expect(html.length).toBeLessThan(200 * 1024);
  });

  it('工具列的關鍵標記還在（產物覆蓋會連同這些一起換掉）', () => {
    for (const id of ['recentMenu', 'recentBtn', 'recentItems', 'listTrackSel', 'subCount']) {
      expect(html, `index.html 少了 #${id}`).toContain(`id="${id}"`);
    }
  });
});

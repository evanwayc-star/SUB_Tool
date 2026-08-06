/* 工具列不可以把下拉選單裁掉（src/styles.css 的 .menubar）。
   ================================================================================

   真實事故（v6.1.7 加入「最近開啟」之後一直到 v6.1.11）：
   選單展開後高 397px，使用者【只看得到最上面約 5px】——選單 top=41、
   .menubar 底緣=46，剛好就是那條縫。

   下拉選單是 position:absolute，住在 .menubar 裡，而 .menubar 上有【兩個各自
   獨立的裁切來源】：

     1. `overflow:hidden` —— 一般認知中的裁切
     2. `backdrop-filter:blur(12px)` —— 它會建立 containing block 並把子孫裁到
        自己的邊框盒。這一個特別容易漏，因為名字聽起來只跟視覺效果有關。

   實測（在真的 Electron 視窗裡用 document.elementFromPoint 取三個高度）：

     | .menubar 的設定                          | 使用者實際看得到 |
     |------------------------------------------|------------------|
     | overflow:hidden + backdrop-filter        | 1/3              |
     | 只改 overflow:visible                     | 1/3              |
     | 只拿掉 backdrop-filter                    | 1/3              |
     | 兩個都處理                                | 3/3              |

   **拿掉任一個都沒用，必須兩個一起。**

   > 為什麼這個 bug 這麼難抓：`getBoundingClientRect()` 【看不到裁切】——被
   > overflow 裁掉的元素照樣回報完整的 397px 高度，computed style 也是
   > `display:block`、`opacity:1`。鐵律 §0.7 說「可見性只看 computed style」
   > 在這裡會給出錯誤答案。當時因此誤判成「被 mpv 的 OS 層視窗蓋住」，連查三輪。
   > 能如實反映裁切的是 `document.elementFromPoint()`——它回答的是
   > 「這個座標上使用者實際點得到誰」。

   這支測試看的是 CSS 原始碼而不是渲染結果（jsdom 不做版面計算，更不做裁切），
   所以它守的是【那兩個屬性不可以回到 .menubar 上】這個不變量。
   要改這一段前先讀 styles.css 裡 .menubar 上方的註解。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'), 'utf8');

/** 取出某個選擇器的宣告區塊（只取第一個，且跳過註解）。 */
function ruleBody(selector) {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = stripped.indexOf(selector + '{');
  if (i < 0) throw new Error(`styles.css 裡找不到規則：${selector}{`);
  const start = i + selector.length + 1;
  const end = stripped.indexOf('}', start);
  return stripped.slice(start, end);
}

describe('.menubar 不可以裁掉下拉選單', () => {
  const bar = ruleBody('.menubar');

  it('垂直方向必須是 visible', () => {
    expect(bar).toMatch(/overflow-y\s*:\s*visible/);
  });

  it('不可以用 overflow 或 overflow-y 的 hidden／auto／scroll', () => {
    /* hidden 會強制另一軸變成 auto——就算寫了 overflow-y:visible 也會失效。 */
    expect(bar).not.toMatch(/(^|;)\s*overflow\s*:\s*(hidden|auto|scroll)/);
    expect(bar).not.toMatch(/overflow-y\s*:\s*(hidden|auto|scroll)/);
  });

  it('水平方向仍要裁，而且要用 clip 不能用 hidden', () => {
    /* 視窗變窄時工具列不可以撐爆版面，所以水平方向還是要裁；
       但 hidden 會連帶把垂直軸變成 auto，只有 clip 不會。 */
    expect(bar).toMatch(/overflow-x\s*:\s*clip/);
  });

  it('backdrop-filter 不可以留在 .menubar 上（它也會裁子孫）', () => {
    expect(bar).not.toMatch(/backdrop-filter/);
  });

  it('磨砂質感搬到 ::before，外觀不因此消失', () => {
    const before = ruleBody('.menubar::before');
    expect(before).toMatch(/backdrop-filter\s*:\s*blur/);
    expect(before).toMatch(/position\s*:\s*absolute/);
    /* ::before 要墊在按鈕底下，否則會蓋住工具列的內容。 */
    expect(before).toMatch(/z-index\s*:\s*-1/);
  });

  it('.menubar 要是 positioned，::before 的 inset:0 才貼得住', () => {
    expect(bar).toMatch(/position\s*:\s*relative/);
  });
});

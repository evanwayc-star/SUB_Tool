/* 選單標籤 → { 圖示, 文字 }。

   圖示要放進固定寬度的 `.c-icon`，文字才會左對齊；沒有前導圖示的項目
   留一個空的圖示欄，一樣對齊。

   **不可以列舉字元。** v5.9.1 之前寫死 `[⬆⬇⇄⇅→⏱🗑✂↓↑]` 十種，於是
   📐 ⏳ 🔗 🎧 🎞 🔀 ↺ 🔒 🔇 ◀ ▶ ↔ ↕ ＋ 這十四種通通沒被拆出來——
   emoji 留在文字欄裡，同一份選單內的文字起點就參差不齊。
   每新增一個帶新圖示的項目就多歪一列，而且**不會有任何錯誤訊息**。

   單獨成一支模組是為了可測：`menus.js` 在 import 時就會抓 DOM 元素、
   並拉進 `media.js` 的模組層副作用，為了測一個純函式而啟整個世界不划算。 */
export function splitMenuLabel(label) {
  const raw = String(label == null ? '' : label);
  const m = raw.match(/^([\p{Extended_Pictographic}\p{So}\p{Sm}️]+)\s*(.*)$/u);
  return m ? { icon: m[1], text: m[2] } : { icon: '', text: raw };
}

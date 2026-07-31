/* ==============================================================================
   SUB Tool — 截圖的存放位置與檔名（Screenshot Target）
   ==============================================================================

   「這張截圖要存到哪、叫什麼名字」的規則。純函式，不碰 DOM、不碰檔案系統。

   【為什麼獨立成一支】
   這些規則原本寫在 app.js 的 takeScreenshot() 裡。app.js 是組裝根——
   它是全專案唯一不可被其他模組 import 的檔案（見 AGENTS.md §7 的架構規則），
   所以住在裡面的規則**結構上就無法被測試**。
   規則本身與 mpv／canvas／檔案 I/O 無關，沒有理由被關在那裡。

   實際的存檔（mpv 截圖、canvas 合成、寫檔）留在 app.js——那是編排，不是規則。
============================================================================== */

/* 時間碼會進檔名，而 `:` 與 `;`（drop-frame 分隔）在 Windows 檔名裡是非法字元。
   換成 `-`：`01:23:45;06` → `_01-23-45-06`。沒有要求時間碼時回空字串。 */
export function timecodeSuffix(timecode) {
  if (!timecode) return '';
  return '_' + String(timecode).replace(/[:;]/g, '-');
}

/* 截圖要存到哪：優先用專案檔所在目錄，其次退回母素材所在目錄。
   兩者都沒有（未存檔的空白專案、網頁版）時回 null，由呼叫端走瀏覽器下載。
   結尾的分隔符一律去掉，避免後面接檔名時變成 `dir\\\\name`。 */
export function screenshotDir({ projectDir, mediaPath }) {
  let dir = projectDir || '';
  if (!dir && mediaPath) {
    const norm = String(mediaPath).replace(/\\/g, '/');
    const sep = norm.lastIndexOf('/');
    if (sep > 0) dir = String(mediaPath).substring(0, sep);
  }
  return dir ? dir.replace(/[\\/]+$/, '') : null;
}

/* 沒有目錄可用時（網頁版）的下載檔名。以播放點的整秒數命名，
   同一秒重複截圖會同名——瀏覽器會自己加 (1)，不需要在這裡處理。 */
export function fallbackScreenshotName(displaySeconds, suffix = '') {
  return `Shot-${Math.floor(Math.max(0, +displaySeconds || 0))}${suffix}.jpg`;
}

/* ==============================================================================
   SUB Tool — 匯出檔名淨化（renderer 側，第一道防線）
   ==============================================================================

   常用樣式匯出時的檔名有一段來自【使用者匯入的 .json 內容】（preset.group）。
   那段字串一路傳到主程序做 `path.join(選定資料夾, name)`——`path.join` 會把
   `"../"` 正規化掉，所以未淨化的 group 可以讓檔案落在使用者選定資料夾之外，
   不需要任何 XSS，只要「匯入別人給的樣式包 → 之後按一次匯出樣式」就會發生，
   而且 UI 仍顯示匯出成功。

   【跨行程的接縫】
   主程序（`electron/export-name-safety.js`，CommonJS）在收到路徑後會再驗證一次
   最終路徑沒有越界——那是第二道防線，不能只靠這一側。兩邊各自維護一份規則，
   由 `tests/exportNameSafetyContract.test.js` 矩陣窮舉比對，任一邊漂掉就紅。
============================================================================== */

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;

/* 資料夾名淨化：拿掉 Windows 禁用字元，並把「只有點」的字串（`.`、`..`、`....`）
   換成底線——那個模式本身就是路徑穿越的building block，資料夾這一段必須擋死。 */
export function sanitizeFolderSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_').replace(/^\.+$/, '_');
}

/* 檔名淨化：只拿掉禁用字元，**刻意不**擋「只有點」的模式——因為呼叫端一律會
   在後面接上 `.json`，「只有點」的字串接上副檔名後必然變成類似 `...json` 這種
   合法檔名，不可能單獨成立為 `..` 本身，也就構不成路徑穿越。
   與 sanitizeFolderSegment 分成兩支，而不是共用一支，就是為了讓這個前提可讀。 */
export function sanitizeFileNameSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_');
}

/** preset → 匯出用的相對路徑（`分組/檔名.json`）。淨化後才組字串，不可先組字串再淨化。 */
export function presetExportRelativePath(preset) {
  const safeGroup = sanitizeFolderSegment(preset?.group || '');
  const folder = safeGroup ? `${safeGroup}/` : '';
  const safeName = sanitizeFileNameSegment(preset?.name || '');
  return `${folder}${safeName}.json`;
}

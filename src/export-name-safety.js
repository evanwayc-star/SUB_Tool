/* ==============================================================================
   SUB Tool — 匯出樣式檔名與路徑淨化 (Export Name Safety - Renderer First Line)
   ==============================================================================
   【架構與職責】
   渲染端第一道防線：處理樣式分組名稱與檔名淨化，防止路徑穿越（Path Traversal）。
   
   【安全鐵律】
   1. 樣式匯出時的路徑包含來自使用者自訂的 `preset.group` 與 `preset.name`。
   2. 資料夾名稱淨化：去除 Windows 禁用字元，並將純點字串（如 `..`）替換為底線 `_`。
   3. 檔名淨化：去除禁用字元，後續接續 `.json` 副檔名。
   4. 必須先對各段字串分別淨化後才進行 `join` 拼接，嚴禁拼接後整體淨化。
   ============================================================================== */

/** Windows 檔案與資料夾名稱禁用字元正規表達式 */
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;

/**
 * 淨化資料夾/分組名稱段落（去除禁用字元，將純點 `.` 或 `..` 替換為底線）。
 * 
 * @param {string} name 原始資料夾/分組名稱
 * @returns {string} 淨化後安全資料夾名稱
 */
export function sanitizeFolderSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_').replace(/^\.+$/, '_');
}

/**
 * 淨化檔案名稱段落（去除禁用字元）。
 * 
 * @param {string} name 原始檔案名稱（不含副檔名）
 * @returns {string} 淨化後安全檔案名稱
 */
export function sanitizeFileNameSegment(name) {
  return String(name || '').replace(FORBIDDEN_CHARS, '_');
}

/**
 * 產生樣式匯出時的相對路徑字串 (`分組/樣式名稱.json`)。
 * 
 * @param {object} preset 樣式設定物件
 * @param {string} [preset.group] 樣式所屬分組名稱
 * @param {string} [preset.name] 樣式名稱
 * @returns {string} 相對檔案路徑
 */
export function presetExportRelativePath(preset) {
  const safeGroup = sanitizeFolderSegment(preset?.group || '');
  const folder = safeGroup ? `${safeGroup}/` : '';
  const safeName = sanitizeFileNameSegment(preset?.name || '');
  return `${folder}${safeName}.json`;
}

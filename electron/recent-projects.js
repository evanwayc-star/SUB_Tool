/* ==============================================================================
   SUB Tool — 最近開啟專案的清單規則（"electron/recent-projects.js"）
   ==============================================================================

   只有「清單怎麼變」這件事：去重、排序、上限。讀寫磁碟留在 main.js。

   清單本身由【主程序】持有——renderer 只拿得到顯示字串與索引，開啟時送索引。
   `fileAuthority` 的授權是每次工作階段的，重開程式後舊路徑不再被授權；
   讓 renderer 記住路徑再送回去開，等於給了它一條「叫主程序讀任意檔案」的路。

   規則本身很短，但它壞掉的樣子都是安靜的：同一支檔案出現兩列、清單無限長大、
   或最近開的那筆沒有排到最前面。所以留一份測試（tests/recentProjects.test.js）。
============================================================================== */
const path = require('path');

const MAX_ENTRIES = 10;

/** 只留下形狀正確的項目——設定檔是使用者可改的，不可信任它的內容。 */
function sanitize(list, max = MAX_ENTRIES) {
  return (Array.isArray(list) ? list : [])
    .filter(item => item && typeof item.path === 'string' && item.path.trim())
    .slice(0, max);
}

/**
 * 把一個路徑推到清單最前面。
 * @returns {Array} 新的清單（不會就地修改傳進來的那個）
 */
function addRecent(list, filePath, { max = MAX_ENTRIES, now = 0 } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return sanitize(list, max);
  let resolved;
  try { resolved = path.resolve(filePath); } catch (e) { return sanitize(list, max); }

  /* Windows 的路徑比對不分大小寫；不這樣做的話 D:\A.subtool 與 d:\a.subtool
     會變成兩列，看起來像開了兩個不同的專案。 */
  const key = resolved.toLowerCase();
  const next = [{ path: resolved, name: path.basename(resolved), at: now }];
  for (const item of sanitize(list, Infinity)) {
    if (String(item.path).toLowerCase() === key) continue;
    next.push(item);
    if (next.length >= max) break;
  }
  return next;
}

/** 從清單移除一筆（檔案已不存在時用）。 */
function removeRecent(list, filePath) {
  const key = String(filePath || '').toLowerCase();
  return sanitize(list, Infinity).filter(item => String(item.path).toLowerCase() !== key);
}

module.exports = { MAX_ENTRIES, sanitize, addRecent, removeRecent };

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

/**
 * 造一支「這個路徑還在不在」的探測器。
 *
 * 為什麼要注入 `stat` 而不是直接 require('fs')：這條規則有兩個容易寫錯、而且錯了
 * 會很難察覺的判斷（逾時算不算不見、哪些錯誤碼算不見），值得測；而測它不應該
 * 需要一台真的會逾時的 NAS。
 *
 * 【為什麼非同步、而且要限時】
 * 呼叫端（main.js 的 project:recentList）跑在主行程的 UI 執行緒上，原生檔案對話框
 * 的訊息迴圈也在那條執行緒。最近開啟的清單裡很可能有 SMB 路徑；NAS 休眠或網路不通
 * 時一次 stat 可能要數十秒——同步版本會讓整個 app 連同開著的對話框一起凍住。
 * 改非同步之後 UI 執行緒不再被擋，但 libuv 的執行緒池預設只有 4 條，
 * 一整串斷線的網路路徑會把它占滿，所以還要限時。
 *
 * 【逾時不算「不見」】
 * 逾時只代表「這次沒問到」，不代表檔案不在。把它當成不見會讓一台只是慢的 NAS 上
 * 的專案全部被標灰——標錯灰比不標更難解釋。不確定就照常顯示，真的點下去時
 * project:openRecent 會給出明確的錯誤並把那一筆移除。
 *
 * @param {{stat: (p:string)=>Promise<any>, timeoutMs?: number}} deps
 * @returns {(p: string) => Promise<boolean>} true＝【確定】不在
 */
function createMissingProbe({ stat, timeoutMs = 400 }) {
  return async function missing(p) {
    let timer;
    try {
      const st = await Promise.race([
        stat(p),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('__timeout__')), timeoutMs);
        }),
      ]);
      /* 路徑存在但不是檔案（例如變成了資料夾）也算不見——點下去一樣讀不到。 */
      return !st.isFile();
    } catch (e) {
      /* 只有檔案系統【明確說沒有】才算不見。逾時、權限不足、網路錯誤都算不確定。 */
      return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { MAX_ENTRIES, sanitize, addRecent, removeRecent, createMissingProbe };

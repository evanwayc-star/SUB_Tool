/* ==============================================================================
   SUB Tool — 最近開啟的專案（"src/recent-projects.js"）
   ==============================================================================

   工具列上「開啟專案」右邊那個選單。

   【清單不在這裡】
   路徑由【主程序】持有並持久化（`electron/main.js` 的 project:recentList /
   project:openRecent）。這一支只負責顯示，開啟時送出去的是**索引**，不是路徑。

   為什麼這樣分：`fileAuthority` 的授權是每次工作階段的，重開程式後舊路徑本來
   就不再被授權。若讓 renderer 記住路徑再送回去開，等於給了它一條「叫主程序讀
   任意檔案」的路——那正是路徑白名單要擋的事。主程序自己記得使用者確實開過哪些
   檔，並且只在從那份清單開啟時才重新授予那一個檔案。

   網頁版沒有這個功能（沒有可持久化的檔案路徑），按鈕整個隱藏。
============================================================================== */
import { $ } from './dom.js';
import { IS_DESKTOP, DESK } from './state.js';
import { showToast } from './ui.js';
import { Project, confirmDiscardUnsaved } from './project.js';

/* 8月6日 · 11:05 am —— 與匯出佇列監控的「加入時間」同一種寫法。 */
function fmtWhen(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const pad2 = n => String(n).padStart(2, '0');
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${pad2(h12)}:${pad2(d.getMinutes())} ${h24 < 12 ? 'am' : 'pm'}`;
}

async function openByIndex(index) {
  /* 與工具列的「開啟專案」同一道守衛：沒存檔就先問，不可以直接蓋掉。 */
  if (!await confirmDiscardUnsaved()) return;
  try {
    const r = await DESK.openRecentProject(index);
    if (r) Project.loadDesktop(r);
  } catch (err) {
    /* 檔案被移走或改名時主程序會把它從清單移除並丟錯，這裡如實告訴使用者，
       並重畫選單——否則那一列會一直留著讓人一再踩空。 */
    showToast(String(err?.message || err).replace(/^Error:\s*/, ''));
    await renderRecentMenu();
  }
}

export async function renderRecentMenu() {
  const box = $('recentItems');
  if (!box) return;
  let list = [];
  try { list = await DESK.recentProjects(); } catch (e) { list = []; }

  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'lbl';
    empty.textContent = '還沒有開啟過專案';
    box.appendChild(empty);
    return;
  }

  for (const item of list) {
    const b = document.createElement('button');
    b.type = 'button';
    /* 檔案已不在時標灰但仍可點——點了會得到明確的錯誤並自動從清單移除，
       比直接不顯示更好解釋「我的專案去哪了」。 */
    b.style.cssText = 'display:block;text-align:left;line-height:1.3;'
      + (item.missing ? 'opacity:.45;' : '');
    b.title = item.missing ? `找不到檔案：${item.path}` : item.path;
    const name = document.createElement('div');
    name.textContent = (item.missing ? '⚠ ' : '') + item.name;
    const when = document.createElement('div');
    when.style.cssText = 'font-size:10px;color:var(--text-faint);';
    when.textContent = fmtWhen(item.at);
    b.append(name, when);
    b.addEventListener('click', () => {
      $('recentMenu')?.classList.remove('open');
      void openByIndex(item.index);
    });
    box.appendChild(b);
  }

  const sep = document.createElement('div');
  sep.className = 'msep';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '清除清單';
  clear.addEventListener('click', async () => {
    $('recentMenu')?.classList.remove('open');
    try { await DESK.clearRecentProjects(); } catch (e) {}
    await renderRecentMenu();
  });
  box.append(sep, clear);
}

export function initRecentProjects() {
  const menu = $('recentMenu');
  if (!menu) return;
  /* 網頁版沒有可持久化的檔案路徑——整個藏掉，不要留一個按了沒反應的按鈕。 */
  if (!IS_DESKTOP || typeof DESK?.recentProjects !== 'function') {
    menu.hidden = true;
    return;
  }
  /* 每次點都重畫：別的視窗或另存新檔都可能改動清單，開機時抓一次會過期。

     【不要改成「只在即將打開時才畫」】——那需要知道這一次點擊是開還是關，而
     `.open` 這個 class 是由 `app.js` 頂層的通用選單處理器（`.menu>button`）加上去的。
     那個處理器在【模組載入時】就註冊了，比 initRecentProjects()（由 initAll 呼叫）
     還早，兩個監聽器又都掛在同一顆 recentBtn 上，所以依註冊順序：通用處理器先把
     class 翻好，才輪到這裡。

     真實事故（v6.1.8）：這裡原本寫 `if (menu.classList.contains('open')) return;`，
     用意是「這一次是要關閉就不用畫」。實際跑起來第一次點擊時 class 早就被加上了，
     於是每次「要打開」都被誤判成「要關閉」而直接 return——選單打得開，但**永遠是空的**。
     反而是第二次點擊（關閉）才會畫，所以第三次點才看得到東西。

     多畫一次的成本只是一次 IPC，不值得為它賭監聽器的註冊順序。 */
  $('recentBtn')?.addEventListener('click', () => { void renderRecentMenu(); });
  /* 先畫一次，第一次打開就有內容，而不是先閃一格空白再填。 */
  void renderRecentMenu();
}

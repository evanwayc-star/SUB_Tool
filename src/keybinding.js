/* ==============================================================================
   SUB Tool — 快捷鍵綁定的規則（唯一定義）
   ==============================================================================

   一個**綁定**是 `{ key?, code?, ctrl?, shift?, alt? }`。整份 keymap 是
   `{ 動作名: 綁定[] }`（每個動作最多三組，見設定視窗）。

   關於這個資料結構有五件事要做，v5.11.0 之前分散在兩支檔案裡：

     settings.js   從鍵盤事件「錄」出一個綁定、判斷是否與別人重複、顯示成文字、
                   匯入時與預設合併
     keyboard.js   拿一個真實事件去比對整份 keymap

   **錄製端與比對端各有一套「數字鍵盤怎麼算」的理論，而且不一樣**——
   這正是下面那個 bug 的來源。理論只寫一次，兩邊都用這裡的函式。

   【數字鍵盤的約定（v4.4.2 起）】
   NumLock 開時，數字鍵盤的字元鍵 `key` 值與主鍵盤完全相同（Numpad2 → `'2'`），
   只有 `code` 分得出來。所以：

     - 數字鍵盤一律以 **code**（`NumpadX`）綁定，主鍵盤以 **key** 綁定。
     - 數字鍵盤產生的**字元**事件不得命中 key 綁定
       （否則按數字鍵盤 2 會觸發主鍵盤 2 的 zoom_in）。

   【為什麼比對要分兩輪（code 先、key 後）】
   舊寫法是單輪掃描，「code 綁定贏過 key 綁定」只在**該動作剛好排在 keymap 物件
   前面**時才成立。預設表裡 `next_cue_5f {code:'Numpad2'}`（第 500 行）排在
   `step_boundary_next {key:'arrowdown'}`（第 522 行）之前，所以 NumLock 關著按
   Numpad2 是對的——**靠的是物件鍵的順序**。

   而 `NumpadEnter` 就沒這麼幸運：它的 `key` 是 `'enter'`（長度 > 1，不受
   「字元鍵」那條保護），而 `toggle_play_pause {key:'enter'}` 是預設表的**第一項**。
   於是使用者把 NumpadEnter 指派給任何動作，按下去都只會播放/暫停，
   而且設定視窗的重複檢查也不會提醒（它們一個比 code、一個比 key，不算重複）。
   NumLock 關著的 `NumpadDecimal`（key = `'delete'`）同理。

   分兩輪之後，「明確指定 code 的綁定優先」變成規則本身，不再依賴物件順序。
   對整份預設表逐鍵驗算過：**沒有任何一組現行行為改變**（見
   tests/keybinding.test.js「兩輪比對不改變預設表的任何現行行為」）。
============================================================================== */

/** 數字鍵盤的 code？（`NumpadAdd`、`Numpad2`、`NumpadEnter`…） */
export function isNumpadCode(code) {
  return typeof code === 'string' && code.startsWith('Numpad');
}

/* 按下這些鍵不算一個綁定——使用者只是還按著修飾鍵。 */
const STANDALONE_MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'];

/**
 * 從一個 keydown 事件錄出綁定；單獨的修飾鍵回 null。
 * 數字鍵盤只留 code（見檔頭：留著 key 會與主鍵盤撞名）。
 */
export function bindFromEvent(e) {
  if (!e || typeof e.key !== 'string') return null;
  if (STANDALONE_MODIFIERS.includes(e.key)) return null;
  const bind = isNumpadCode(e.code) ? { code: e.code } : { key: e.key.toLowerCase() };
  if (e.ctrlKey || e.metaKey) bind.ctrl = true;
  if (e.shiftKey) bind.shift = true;
  if (e.altKey) bind.alt = true;
  return bind;
}

/** 兩個綁定是同一個按鍵組合嗎？（沒寫的修飾鍵 ≡ false） */
export function sameBind(a, b) {
  if (!a || !b) return false;
  return !!a.ctrl === !!b.ctrl
    && !!a.shift === !!b.shift
    && !!a.alt === !!b.alt
    && (a.key || null) === (b.key || null)
    && (a.code || null) === (b.code || null);
}

/**
 * 這個綁定已經被指派給誰了？回 `{ action, index }`，沒有則 null。
 * 設定視窗用它擋下重複指派並把畫面捲到既有的那一列。
 */
export function findConflict(keymap, bind) {
  if (!keymap || !bind) return null;
  for (const [action, binds] of Object.entries(keymap)) {
    if (!Array.isArray(binds)) continue;
    for (let i = 0; i < binds.length; i++) {
      if (sameBind(binds[i], bind)) return { action, index: i };
    }
  }
  return null;
}

const NUMPAD_LABELS = {
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadEnter: 'Num Enter',
  NumpadDecimal: 'Num .',
};

const KEY_LABELS = {
  ' ': 'Space',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** 顯示成 `Ctrl + Shift + ↑` 這種字串；空綁定回空字串。 */
export function formatBind(bind) {
  if (!bind) return '';
  const parts = [];
  if (bind.ctrl) parts.push('Ctrl');
  if (bind.shift) parts.push('Shift');
  if (bind.alt) parts.push('Alt');
  if (isNumpadCode(bind.code)) {
    parts.push(NUMPAD_LABELS[bind.code] || bind.code.replace('Numpad', 'Num '));
  } else if (bind.key) {
    parts.push(KEY_LABELS[bind.key] || (bind.key.charAt(0).toUpperCase() + bind.key.slice(1)));
  }
  return parts.join(' + ');
}

/* 事件的修飾鍵狀態（Meta 併入 ctrl：macOS 的 ⌘ 與 Windows 的 Ctrl 同義）。 */
function modifiersOf(ev) {
  return { ctrl: !!(ev.ctrlKey || ev.metaKey), shift: !!ev.shiftKey, alt: !!ev.altKey };
}

function modifiersMatch(bind, mods) {
  return !!bind.ctrl === mods.ctrl && !!bind.shift === mods.shift && !!bind.alt === mods.alt;
}

/**
 * 這個事件命中哪個動作？沒有則 null。
 *
 * 兩輪：先比對**指定了 code 的綁定**，再比對 key 綁定。理由見檔頭——
 * 單輪會讓勝負取決於 keymap 物件的鍵順序。
 */
export function matchAction(keymap, ev) {
  if (!keymap || !ev || typeof ev.key !== 'string') return null;
  const key = ev.key.toLowerCase();
  const code = ev.code;
  const mods = modifiersOf(ev);

  for (const [action, binds] of Object.entries(keymap)) {
    if (!Array.isArray(binds)) continue;
    for (const bind of binds) {
      if (!bind || !bind.code) continue;
      if (modifiersMatch(bind, mods) && bind.code === code) return action;
    }
  }

  /* 數字鍵盤的字元鍵（NumLock 開時 Numpad2 → '2'）不得掉進 key 綁定，
     否則會撞上主鍵盤同字元的動作。上面那一輪沒中就是真的沒綁。 */
  if (isNumpadCode(code) && key.length === 1) return null;

  for (const [action, binds] of Object.entries(keymap)) {
    if (!Array.isArray(binds)) continue;
    for (const bind of binds) {
      if (!bind || bind.code || !bind.key) continue;
      if (modifiersMatch(bind, mods) && bind.key === key) return action;
    }
  }
  return null;
}

/**
 * 匯入的 keymap 併到預設上：只採用本版本認得的動作，其餘一律以預設補齊。
 * 回 `{ keymap, applied }`；`applied` 是實際採用的動作數（0 代表這檔案沒東西可用）。
 *
 * 「以預設補齊」而不是「照單全收」，是為了讓舊設定檔在新版新增動作後仍然可用——
 * 缺的那些會拿到新版預設，而不是變成沒有快捷鍵。
 */
export function mergeImportedKeymap(defaults, imported) {
  const source = (imported && imported.keymap) ? imported.keymap : imported;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('格式不符（不是快捷鍵設定檔）');
  }
  const merged = JSON.parse(JSON.stringify(defaults));
  let applied = 0;
  for (const action of Object.keys(merged)) {
    if (Array.isArray(source[action])) {
      merged[action] = source[action].filter(b => b && typeof b === 'object');
      applied++;
    }
  }
  if (!applied) throw new Error('檔案裡沒有可用的快捷鍵綁定');
  return { keymap: merged, applied };
}

/** 存檔前清掉被刪成 null 的空位。原地修改並回傳同一個物件。 */
export function stripEmptyBinds(keymap) {
  for (const action of Object.keys(keymap)) {
    if (Array.isArray(keymap[action])) keymap[action] = keymap[action].filter(Boolean);
  }
  return keymap;
}

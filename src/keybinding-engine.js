/* ==============================================================================
   SUB Tool — Keybinding & Navigation Engine ("src/keybinding-engine.js")
   ==============================================================================
   深層鍵盤快捷鍵調度與互動引擎 (Keybinding & Navigation Engine)。
   負責鍵盤事件匹配、修飾鍵正規化、數字鍵盤分離與數值滾輪步進：
   1. 數字鍵盤判定與事件錄製 (isNumpadCode / bindFromEvent / sameBind / findConflict / formatBind)
   2. 兩輪優先權動作比對 (matchAction - code 優先，防範 key 覆蓋)
   3. 快捷鍵設定檔合併與清理 (mergeImportedKeymap / stripEmptyBinds)
   4. 數值輸入框滾輪步進運算與監聽綁定 (nextWheelNumberValue / bindNumberInputWheel)
   ============================================================================== */

/** 數字鍵盤的 code？（`NumpadAdd`、`Numpad2`、`NumpadEnter`…） */
export function isNumpadCode(code) {
  return typeof code === 'string' && code.startsWith('Numpad');
}

const STANDALONE_MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'];

/**
 * 從一個 keydown 事件錄出綁定；單獨的修飾鍵回 null。
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

function modifiersOf(ev) {
  return { ctrl: !!(ev.ctrlKey || ev.metaKey), shift: !!ev.shiftKey, alt: !!ev.altKey };
}

function modifiersMatch(bind, mods) {
  return !!bind.ctrl === mods.ctrl && !!bind.shift === mods.shift && !!bind.alt === mods.alt;
}

/**
 * 這個事件命中哪個動作？兩輪：先比對指定 code 的綁定，再比對 key 綁定。
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

function decimalPlaces(value) {
  const text = String(value);
  if (/[eE]/.test(text)) {
    const [, fraction = '', exponent = '0'] = text.match(/^\d*\.?([0-9]*)[eE]([+-]?\d+)$/) || [];
    return Math.max(0, fraction.length - Number(exponent || 0));
  }
  return (text.split('.')[1] || '').length;
}

export function nextWheelNumberValue(input, { deltaY, shiftKey = false } = {}) {
  if (!input || !Number.isFinite(Number(deltaY)) || Number(deltaY) === 0) return null;
  const declaredStep = Number(input.step);
  const baseStep = Number.isFinite(declaredStep) && declaredStep > 0 ? declaredStep : 1;
  const step = baseStep * (shiftKey ? 10 : 1);
  const min = input.min !== '' && Number.isFinite(Number(input.min)) ? Number(input.min) : -Infinity;
  const max = input.max !== '' && Number.isFinite(Number(input.max)) ? Number(input.max) : Infinity;
  const current = Number.isFinite(Number(input.value)) ? Number(input.value) : 0;
  const direction = Number(deltaY) < 0 ? 1 : -1;
  const precision = Math.min(10, decimalPlaces(input.step || baseStep));
  const next = Math.max(min, Math.min(max, current + direction * step));
  return Number(next.toFixed(precision));
}

export function bindNumberInputWheel(root = (typeof document !== 'undefined' ? document : null)) {
  if (!root?.addEventListener) return () => {};
  const onWheel = e => {
    const input = e.target;
    if (!input || input.tagName !== 'INPUT' || (input.type !== 'number' && !input.classList?.contains?.('num-scrubber'))) return;
    const next = nextWheelNumberValue(input, e);
    if (next == null) return;
    e.preventDefault();
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  root.addEventListener('wheel', onWheel, { passive: false });
  return () => root.removeEventListener('wheel', onWheel);
}

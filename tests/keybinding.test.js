/* 快捷鍵綁定規則。重點在**錄製端與比對端用的是同一套理論**——
   v5.11.0 之前 settings.js 與 keyboard.js 各寫一份，NumpadEnter 因此永遠被
   {key:'enter'} 蓋掉（見 src/keybinding.js 檔頭）。 */
import { describe, expect, it } from 'vitest';
import {
  bindFromEvent, findConflict, formatBind, isNumpadCode,
  matchAction, mergeImportedKeymap, sameBind, stripEmptyBinds,
} from '../src/keybinding-engine.js';
import { State } from '../src/state.js';

/** 造一個 keydown 事件的替身。 */
const ev = (key, opts = {}) => ({
  key,
  code: opts.code,
  ctrlKey: !!opts.ctrl, metaKey: !!opts.meta, shiftKey: !!opts.shift, altKey: !!opts.alt,
});

describe('從事件錄出綁定', () => {
  it('一般按鍵存小寫 key', () => {
    expect(bindFromEvent(ev('A'))).toEqual({ key: 'a' });
    expect(bindFromEvent(ev('ArrowUp'))).toEqual({ key: 'arrowup' });
  });

  it('修飾鍵：Meta 併入 ctrl（macOS ⌘ ≡ Windows Ctrl）', () => {
    expect(bindFromEvent(ev('s', { ctrl: true }))).toEqual({ key: 's', ctrl: true });
    expect(bindFromEvent(ev('s', { meta: true }))).toEqual({ key: 's', ctrl: true });
    expect(bindFromEvent(ev('z', { ctrl: true, shift: true })))
      .toEqual({ key: 'z', ctrl: true, shift: true });
  });

  it('沒按的修飾鍵不寫進綁定（不是 false，是不存在）', () => {
    expect(Object.keys(bindFromEvent(ev('j')))).toEqual(['key']);
  });

  /* NumLock 開時 Numpad2 的 key 就是 '2'，與主鍵盤無從分辨——只能存 code。 */
  it('數字鍵盤只存 code，不留 key', () => {
    expect(bindFromEvent(ev('2', { code: 'Numpad2' }))).toEqual({ code: 'Numpad2' });
    expect(bindFromEvent(ev('Enter', { code: 'NumpadEnter' }))).toEqual({ code: 'NumpadEnter' });
    // NumLock 關著錄製，之後 NumLock 開著也要能用——所以存的是 code 不是 key
    expect(bindFromEvent(ev('ArrowDown', { code: 'Numpad2' }))).toEqual({ code: 'Numpad2' });
  });

  it('單獨按修飾鍵不算一個綁定', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta']) {
      expect(bindFromEvent(ev(k)), k).toBe(null);
    }
  });

  it('isNumpadCode 只認 Numpad 前綴', () => {
    expect(isNumpadCode('Numpad2')).toBe(true);
    expect(isNumpadCode('KeyN')).toBe(false);
    expect(isNumpadCode(undefined)).toBe(false);
  });
});

describe('重複判斷', () => {
  it('沒寫的修飾鍵等同 false', () => {
    expect(sameBind({ key: 'a' }, { key: 'a', ctrl: false })).toBe(true);
    expect(sameBind({ key: 'a' }, { key: 'a', alt: false, shift: false })).toBe(true);
  });

  it('三個修飾鍵各自都要比對到（少比一個就會放行真正的衝突）', () => {
    for (const mod of ['ctrl', 'shift', 'alt']) {
      expect(sameBind({ key: 'a' }, { key: 'a', [mod]: true }), mod).toBe(false);
      expect(sameBind({ key: 'a', [mod]: true }, { key: 'a', [mod]: true }), mod).toBe(true);
    }
  });

  it('key 綁定與 code 綁定不算同一個', () => {
    expect(sameBind({ key: '2' }, { code: 'Numpad2' })).toBe(false);
  });

  it('不同的 code 不算同一個（只比 key 會讓整個數字鍵盤互相衝突）', () => {
    expect(sameBind({ code: 'Numpad2' }, { code: 'Numpad5' })).toBe(false);
    expect(sameBind({ code: 'Numpad2' }, { code: 'Numpad2' })).toBe(true);
  });

  it('findConflict 回報是哪個動作的第幾組', () => {
    const km = { play: [{ key: ' ' }, { key: 'enter' }], stop: [{ key: 'k' }] };
    expect(findConflict(km, { key: 'enter' })).toEqual({ action: 'play', index: 1 });
    expect(findConflict(km, { key: 'k' })).toEqual({ action: 'stop', index: 0 });
    expect(findConflict(km, { key: 'q' })).toBe(null);
  });

  it('陣列裡的空位不會被誤判成衝突', () => {
    expect(findConflict({ play: [null, undefined] }, { key: 'a' })).toBe(null);
  });
});

describe('顯示', () => {
  it('修飾鍵依 Ctrl → Shift → Alt 排列', () => {
    expect(formatBind({ key: 'z', ctrl: true, shift: true })).toBe('Ctrl + Shift + Z');
    expect(formatBind({ key: 's', alt: true, ctrl: true })).toBe('Ctrl + Alt + S');
  });

  it('特殊鍵有可讀名稱', () => {
    expect(formatBind({ key: ' ' })).toBe('Space');
    expect(formatBind({ key: 'escape' })).toBe('Esc');
    expect(formatBind({ key: 'arrowup' })).toBe('↑');
    expect(formatBind({ key: 'arrowright' })).toBe('→');
  });

  it('數字鍵盤顯示成 Num X', () => {
    expect(formatBind({ code: 'NumpadAdd' })).toBe('Num +');
    expect(formatBind({ code: 'NumpadEnter' })).toBe('Num Enter');
    expect(formatBind({ code: 'Numpad2' })).toBe('Num 2');
  });

  it('空綁定顯示成空字串（設定表格的空欄位）', () => {
    expect(formatBind(null)).toBe('');
    expect(formatBind(undefined)).toBe('');
  });
});

describe('比對事件', () => {
  const km = {
    play: [{ key: ' ' }, { key: 'enter' }],
    zoom_in: [{ key: '2' }, { code: 'NumpadAdd' }],
    next_5f: [{ code: 'Numpad2' }],
    undo: [{ key: 'z', ctrl: true }],
    redo: [{ key: 'z', ctrl: true, shift: true }],
  };

  it('一般比對', () => {
    expect(matchAction(km, ev(' '))).toBe('play');
    expect(matchAction(km, ev('2', { code: 'Digit2' }))).toBe('zoom_in');
    expect(matchAction(km, ev('q'))).toBe(null);
  });

  it('修飾鍵必須完全相符（多按一個 Shift 就是另一個動作）', () => {
    expect(matchAction(km, ev('z', { ctrl: true }))).toBe('undo');
    expect(matchAction(km, ev('z', { ctrl: true, shift: true }))).toBe('redo');
    expect(matchAction(km, ev('z'))).toBe(null);
  });

  /* 這條是數字鍵盤約定的核心：NumLock 開著按數字鍵盤 2，不可以觸發主鍵盤 2 的 zoom_in。 */
  it('數字鍵盤的字元鍵不會掉進主鍵盤的 key 綁定', () => {
    expect(matchAction(km, ev('2', { code: 'Numpad2' }))).toBe('next_5f');
    // 沒有對應 code 綁定的數字鍵盤字元鍵：寧可不觸發，也不要誤觸主鍵盤動作
    expect(matchAction(km, ev('3', { code: 'Numpad3' }))).toBe(null);
  });

  /* v5.11.0 修的 bug。舊寫法單輪掃描，key 綁定排在前面就會贏。 */
  it('NumpadEnter 不會被 {key:\'enter\'} 蓋掉——即使 play 排在最前面', () => {
    const withEnter = { ...km, my_action: [{ code: 'NumpadEnter' }] };
    expect(matchAction(withEnter, ev('Enter', { code: 'NumpadEnter' }))).toBe('my_action');
    // 主鍵盤 Enter 不受影響
    expect(matchAction(withEnter, ev('Enter', { code: 'Enter' }))).toBe('play');
  });

  it('NumLock 關著的 NumpadDecimal（key 為 delete）同樣不會被 {key:\'delete\'} 蓋掉', () => {
    const m = { del: [{ key: 'delete' }], mine: [{ code: 'NumpadDecimal' }] };
    expect(matchAction(m, ev('Delete', { code: 'NumpadDecimal' }))).toBe('mine');
    expect(matchAction(m, ev('Delete', { code: 'Delete' }))).toBe('del');
  });

  it('code 綁定只比對 code，不會被同名 key 誤中', () => {
    const m = { a: [{ code: 'NumpadAdd' }] };
    expect(matchAction(m, ev('+', { code: 'Equal', shift: true }))).toBe(null);
    expect(matchAction(m, ev('+', { code: 'NumpadAdd' }))).toBe('a');
  });

  /* 匯入的設定檔（或 v4.4.2 遷移前的舊存檔）可能有 key 與 code 都寫的綁定。
     只要有 code，就是數字鍵盤專屬——主鍵盤按同一個字元不該觸發。 */
  it('key 與 code 都有的綁定，主鍵盤按同字元不會命中', () => {
    const m = { a: [{ key: '5', code: 'Numpad5' }] };
    expect(matchAction(m, ev('5', { code: 'Digit5' }))).toBe(null);
    expect(matchAction(m, ev('5', { code: 'Numpad5' }))).toBe('a');
  });

  it('壞資料不會炸（匯入來的 keymap 可能什麼都有）', () => {
    expect(matchAction({ a: null, b: 'nope', c: [null, {}] }, ev('x'))).toBe(null);
    expect(matchAction(null, ev('x'))).toBe(null);
  });
});

/* 這一段是整個改動的安全網：兩輪比對必須對**真的預設表**維持原樣。
   舊實作是單輪 + `numpadChar = code.startsWith('Numpad') && key.length === 1`，
   在這裡原樣重現，逐一比對兩者對每個實體按鍵（NumLock 開與關）的判定。 */
describe('兩輪比對不改變預設表的任何現行行為', () => {
  function legacyMatch(keymap, e) {
    const key = e.key.toLowerCase();
    const code = e.code;
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
    const numpadChar = code && code.startsWith('Numpad') && key.length === 1;
    for (const [action, binds] of Object.entries(keymap)) {
      if (!binds) continue;
      for (const bind of binds) {
        if (!!bind.ctrl !== ctrl) continue;
        if (!!bind.shift !== shift) continue;
        if (!!bind.alt !== alt) continue;
        if (bind.code) { if (bind.code === code) return action; continue; }
        if (numpadChar) continue;
        if (bind.key && bind.key === key) return action;
      }
    }
    return null;
  }

  /* 數字鍵盤每個實體鍵在 NumLock 開／關兩種狀態下送出的 key 值。 */
  const NUMPAD_KEYS = [
    ['Numpad0', '0', 'Insert'], ['Numpad1', '1', 'End'], ['Numpad2', '2', 'ArrowDown'],
    ['Numpad3', '3', 'PageDown'], ['Numpad4', '4', 'ArrowLeft'], ['Numpad5', '5', 'Clear'],
    ['Numpad6', '6', 'ArrowRight'], ['Numpad7', '7', 'Home'], ['Numpad8', '8', 'ArrowUp'],
    ['Numpad9', '9', 'PageUp'], ['NumpadDecimal', '.', 'Delete'],
    ['NumpadAdd', '+', '+'], ['NumpadSubtract', '-', '-'],
    ['NumpadMultiply', '*', '*'], ['NumpadDivide', '/', '/'], ['NumpadEnter', 'Enter', 'Enter'],
  ];

  /* 主鍵盤：預設表裡出現過的每一個 key，乘上四種修飾鍵組合。 */
  const MAIN_KEYS = [...new Set(
    Object.values(State.defaultKeymap).flat().filter(b => b && b.key).map(b => b.key),
  )];
  const MODS = [{}, { ctrl: true }, { shift: true }, { ctrl: true, shift: true }, { alt: true }];

  it('數字鍵盤 16 鍵 × NumLock 開關 × 5 種修飾鍵：判定完全相同', () => {
    const diffs = [];
    for (const [code, onKey, offKey] of NUMPAD_KEYS) {
      for (const key of [onKey, offKey]) {
        for (const mods of MODS) {
          const e = ev(key, { code, ...mods });
          const now = matchAction(State.defaultKeymap, e);
          const before = legacyMatch(State.defaultKeymap, e);
          if (now !== before) diffs.push(`${code}/${key}/${JSON.stringify(mods)}: ${before} → ${now}`);
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it('主鍵盤所有已綁定的鍵 × 5 種修飾鍵：判定完全相同', () => {
    const diffs = [];
    for (const key of MAIN_KEYS) {
      for (const mods of MODS) {
        const e = ev(key, { code: 'Key' + key.toUpperCase(), ...mods });
        const now = matchAction(State.defaultKeymap, e);
        const before = legacyMatch(State.defaultKeymap, e);
        if (now !== before) diffs.push(`${key}/${JSON.stringify(mods)}: ${before} → ${now}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('預設表裡的每一組綁定，按下去都真的會回到自己的動作', () => {
    const unreachable = [];
    for (const [action, binds] of Object.entries(State.defaultKeymap)) {
      for (const bind of binds) {
        const e = bind.code
          ? ev('Unidentified', { code: bind.code, ctrl: bind.ctrl, shift: bind.shift, alt: bind.alt })
          : ev(bind.key, { code: 'Key?', ctrl: bind.ctrl, shift: bind.shift, alt: bind.alt });
        const hit = matchAction(State.defaultKeymap, e);
        /* 預設表本身就有共用同一組鍵的動作（enter 同時是 toggle_play_pause 與
           confirm），所以只要求「有命中某個動作」，不要求命中自己。 */
        if (hit === null) unreachable.push(`${action}: ${formatBind(bind)}`);
      }
    }
    expect(unreachable).toEqual([]);
  });
});

describe('匯入合併', () => {
  const defaults = { play: [{ key: ' ' }], stop: [{ key: 'k' }], newAction: [{ key: 'n' }] };

  it('認得的動作照收，不認得的忽略', () => {
    const { keymap, applied } = mergeImportedKeymap(defaults, {
      keymap: { play: [{ key: 'p' }], obsolete_action: [{ key: 'o' }] },
    });
    expect(applied).toBe(1);
    expect(keymap.play).toEqual([{ key: 'p' }]);
    expect(keymap.obsolete_action).toBeUndefined();
  });

  /* 舊設定檔遇上新版新增的動作時，缺項要拿到新版預設而不是變成沒有快捷鍵。 */
  it('舊檔案缺的動作用預設補齊', () => {
    const { keymap } = mergeImportedKeymap(defaults, { keymap: { play: [{ key: 'p' }] } });
    expect(keymap.newAction).toEqual([{ key: 'n' }]);
  });

  it('不改動預設物件本身', () => {
    mergeImportedKeymap(defaults, { keymap: { play: [{ key: 'p' }] } });
    expect(defaults.play).toEqual([{ key: ' ' }]);
  });

  it('相容：檔案直接就是 keymap 物件（沒有外層 wrapper）', () => {
    expect(mergeImportedKeymap(defaults, { play: [{ key: 'p' }] }).applied).toBe(1);
  });

  it('綁定陣列裡的非物件會被濾掉', () => {
    const { keymap } = mergeImportedKeymap(defaults, { keymap: { play: [{ key: 'p' }, null, 'x', 3] } });
    expect(keymap.play).toEqual([{ key: 'p' }]);
  });

  it('格式不符或沒有可用綁定時丟例外（由呼叫端轉成錯誤訊息）', () => {
    expect(() => mergeImportedKeymap(defaults, null)).toThrow(/格式不符/);
    expect(() => mergeImportedKeymap(defaults, [1, 2])).toThrow(/格式不符/);
    expect(() => mergeImportedKeymap(defaults, { keymap: { nothing_known: [] } })).toThrow(/沒有可用/);
  });
});

describe('存檔前清空位', () => {
  it('濾掉 null 但保留其餘順序', () => {
    const km = { a: [{ key: 'x' }, null, { key: 'y' }], b: [null] };
    expect(stripEmptyBinds(km)).toEqual({ a: [{ key: 'x' }, { key: 'y' }], b: [] });
  });

  it('非陣列的值原樣留著（不炸）', () => {
    expect(stripEmptyBinds({ a: null })).toEqual({ a: null });
  });
});

/* ==============================================================================
   SUB Tool — 時間碼文字輸入解析與按鍵微調 (Timecode Input Parser & Stepper)
   ==============================================================================
   【架構與職責】
   1. `parseTimecodeInput`：解析使用者輸入的字串（支援緊湊純數字如 `1234`、冒號分段 `01:02:03:04`）為浮點秒數。
   2. `handleTimecodeArrowKeys`：在輸入欄位中按上下方向鍵（ArrowUp / ArrowDown）時，針對當前游標所在分量（時/分/秒/格）進行智慧進位微調。
   3. `setupTimecodeInput`：為輸入欄位掛載上下鍵微調與右鍵選單（複製/貼上）。
   ============================================================================== */
import { State } from './state.js';
import { pad } from './util.js';
import { encoreToSec } from './time.js';
import { showCtx } from './menus.js';

/**
 * 將使用者輸入的時間碼字串解析為精確秒數。
 * 
 * 支援格式：
 * - 冒號/分號分隔：`01:02:03:04` 或 `01:02:03;04`
 * - 緊湊數字：`1020304` (自動兩兩分段為 時/分/秒/格)
 * 
 * @param {string|number} str 時間碼字串
 * @returns {number|null} 解析出的時間（秒），若無法解析則回傳 null
 */
function parseTimecodeInput(str) {
  const s = String(str || '').trim();
  if (!s) return null;

  let h = 0;
  let m = 0;
  let sec = 0;
  let f = 0;
  const fpsR = Math.round(State?.fps) || 24;

  if (s.includes(':') || s.includes(';')) {
    const p = s.split(/[:;]/).map(x => parseInt(x, 10) || 0);
    // 由右至左：格, 秒, 分, 時
    f = p[p.length - 1] || 0;
    sec = p[p.length - 2] || 0;
    m = p[p.length - 3] || 0;
    h = p[p.length - 4] || 0;
  } else {
    if (!/^\d+$/.test(s)) return null;
    const g = [];
    let r = s;
    while (r.length > 2) {
      g.unshift(r.slice(-2));
      r = r.slice(0, -2);
    }
    g.unshift(r);
    // g = [..., mm, ss, ff]（由右至左對應 格/秒/分/時）
    f = +(g[g.length - 1] || 0);
    sec = +(g[g.length - 2] || 0);
    m = +(g[g.length - 3] || 0);
    h = +(g[g.length - 4] || 0);
  }

  f = Math.min(f, fpsR - 1);
  return encoreToSec(`${pad(h)}:${pad(m)}:${pad(sec)}${State?.dropFrame ? ';' : ':'}${pad(f)}`, State?.fps, State?.dropFrame);
}

/**
 * 處理時間碼輸入框中的上下方向鍵微調（時/分/秒/格進位）。
 * @param {KeyboardEvent} e
 */
function handleTimecodeArrowKeys(e) {
  if (!e || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const input = e.target;
  const val = input?.value || '';
  const match = val.match(/^([+-]?)(\d{2}):(\d{2}):(\d{2})([:.;])(\d{2,3})$/);
  if (!match) return;
  e.preventDefault();

  const [_, sign, h, m, s, sep, f] = match;
  let hh = parseInt(h, 10);
  let mm = parseInt(m, 10);
  let ss = parseInt(s, 10);
  let ff = parseInt(f, 10);

  const pos = input.selectionStart ?? 0;
  let part = -1; // 0=hh, 1=mm, 2=ss, 3=ff
  if (pos <= sign.length + 2) part = 0;
  else if (pos <= sign.length + 5) part = 1;
  else if (pos <= sign.length + 8) part = 2;
  else part = 3;

  const dir = e.key === 'ArrowUp' ? 1 : -1;

  if (part === 0) {
    hh = Math.max(0, hh + dir);
  } else if (part === 1) {
    mm += dir;
    if (mm < 0) {
      if (hh > 0) { mm = 59; hh--; } else { mm = 0; }
    } else if (mm > 59) {
      mm = 0;
      hh++;
    }
  } else if (part === 2) {
    ss += dir;
    if (ss < 0) {
      if (mm > 0 || hh > 0) {
        ss = 59;
        mm--;
        if (mm < 0) { mm = 59; hh--; }
      } else {
        ss = 0;
      }
    } else if (ss > 59) {
      ss = 0;
      mm++;
      if (mm > 59) { mm = 0; hh++; }
    }
  } else if (part === 3) {
    const fpsR = Math.round(State?.fps) || 24;
    const maxF = fpsR - 1;
    ff += dir;
    if (ff < 0) {
      if (ss > 0 || mm > 0 || hh > 0) {
        ff = maxF;
        ss--;
        if (ss < 0) {
          ss = 59;
          mm--;
          if (mm < 0) { mm = 59; hh--; }
        }
      } else {
        ff = 0;
      }
    } else if (ff > maxF) {
      ff = 0;
      ss++;
      if (ss > 59) {
        ss = 0;
        mm++;
        if (mm > 59) { mm = 0; hh++; }
      }
    }
  }

  const frameStr = pad(ff, f.length);
  input.value = sign + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + sep + frameStr;
  input.setSelectionRange(pos, pos);
}

/**
 * 為時間碼輸入 DOM 元素初始化事件綁定。
 * @param {HTMLInputElement} inp
 */
function setupTimecodeInput(inp) {
  if (!inp) return;
  inp.addEventListener('keydown', handleTimecodeArrowKeys);
  inp.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showCtx(e.clientX, e.clientY, [
      {
        label: '複製',
        act: async () => {
          try {
            const sel = inp.value.substring(inp.selectionStart, inp.selectionEnd);
            await navigator.clipboard.writeText(sel || inp.value);
          } catch (err) {}
        },
      },
      {
        label: '貼上',
        act: async () => {
          try {
            const txt = await navigator.clipboard.readText();
            if (txt) {
              const s = inp.selectionStart;
              const end = inp.selectionEnd;
              inp.value = inp.value.substring(0, s) + txt + inp.value.substring(end);
              inp.setSelectionRange(s + txt.length, s + txt.length);
            }
          } catch (err) {}
        },
      },
    ]);
  });
}

export { parseTimecodeInput, setupTimecodeInput };

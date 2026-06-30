/* SUB Tool — 時間碼輸入解析（葉模組：字串 → 秒，支援絕對/緊湊/Drop-frame） */
import { State } from './state.js';
import { pad } from './util.js';
import { encoreToSec } from './time.js';
import { showCtx } from './menus.js';

function parseTimecodeInput(str){
  str=String(str).trim(); if(!str)return null;
  let h=0,m=0,s=0,f=0;
  const fpsR=Math.round(State.fps)||24;
  if(str.includes(':')||str.includes(';')){
    const p=str.split(/[:;]/).map(x=>parseInt(x,10)||0);
    // 由右至左：格, 秒, 分, 時
    f=p[p.length-1]||0; s=p[p.length-2]||0; m=p[p.length-3]||0; h=p[p.length-4]||0;
  }else{
    if(!/^\d+$/.test(str))return null;
    const g=[]; let r=str; while(r.length>2){ g.unshift(r.slice(-2)); r=r.slice(0,-2); } g.unshift(r);
    // g = [..., mm, ss, ff]  （由右至左對應 格/秒/分/時）
    f=+(g[g.length-1]||0); s=+(g[g.length-2]||0); m=+(g[g.length-3]||0); h=+(g[g.length-4]||0);
  }
  f = Math.min(f, fpsR-1);
  return encoreToSec(`${pad(h)}:${pad(m)}:${pad(s)}${State.dropFrame?';':':'}${pad(f)}`, State.fps, State.dropFrame);
}

function handleTimecodeArrowKeys(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const input = e.target;
  const val = input.value;
  let match = val.match(/^([+-]?)(\d{2}):(\d{2}):(\d{2})([:.;])(\d{2,3})$/);
  if (!match) return; // Only process formatted timecodes
  e.preventDefault();
  
  let [_, sign, h, m, s, sep, f] = match;
  let hh = parseInt(h, 10);
  let mm = parseInt(m, 10);
  let ss = parseInt(s, 10);
  let ff = parseInt(f, 10);
  
  const pos = input.selectionStart;
  let part = -1; // 0=hh, 1=mm, 2=ss, 3=ff
  if (pos <= sign.length + 2) part = 0;
  else if (pos <= sign.length + 5) part = 1;
  else if (pos <= sign.length + 8) part = 2;
  else part = 3;
  
  const dir = e.key === 'ArrowUp' ? 1 : -1;
  
  if (part === 0) hh = Math.max(0, hh + dir);
  else if (part === 1) { 
    mm += dir; 
    if(mm < 0) { if(hh > 0){ mm = 59; hh--; } else { mm = 0; } } 
    else if(mm > 59) { mm = 0; hh++; } 
  }
  else if (part === 2) { 
    ss += dir; 
    if(ss < 0) { 
      if(mm > 0 || hh > 0){ ss = 59; mm--; if(mm < 0){ mm = 59; hh--; } } else { ss = 0; }
    } else if(ss > 59) { 
      ss = 0; mm++; 
      if(mm > 59){ mm = 0; hh++; } 
    } 
  }
  else if (part === 3) { 
    const fpsR = Math.round(State.fps) || 24;
    const maxF = fpsR - 1;
    ff += dir; 
    if(ff < 0) { 
      if(ss > 0 || mm > 0 || hh > 0){ 
        ff = maxF; ss--; 
        if(ss < 0){ ss = 59; mm--; if(mm < 0){ mm = 59; hh--; } } 
      } else { ff = 0; }
    } else if(ff > maxF) { 
      ff = 0; ss++; 
      if(ss > 59){ ss = 0; mm++; if(mm > 59){ mm = 0; hh++; } } 
    }
  }
  
  const frameStr = pad(ff, f.length);
  input.value = sign + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + sep + frameStr;
  input.setSelectionRange(pos, pos);
}

function setupTimecodeInput(inp) {
  inp.addEventListener('keydown', handleTimecodeArrowKeys);
  inp.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showCtx(e.clientX, e.clientY, [
      { label: '複製', act: async () => {
          try {
            const sel = inp.value.substring(inp.selectionStart, inp.selectionEnd);
            await navigator.clipboard.writeText(sel || inp.value);
          } catch(err) {}
      }},
      { label: '貼上', act: async () => {
          try {
            const txt = await navigator.clipboard.readText();
            if(txt) {
                const s = inp.selectionStart, e = inp.selectionEnd;
                inp.value = inp.value.substring(0, s) + txt + inp.value.substring(e);
                inp.setSelectionRange(s + txt.length, s + txt.length);
            }
          } catch(err) {}
      }}
    ]);
  });
}

export { parseTimecodeInput, setupTimecodeInput };

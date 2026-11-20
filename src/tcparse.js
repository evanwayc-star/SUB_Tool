/* ==============================================================================
   SUB Tool — 時間碼文字輸入解析與按鍵微調 (Timecode Input Parser & Stepper)
   ==============================================================================
   【架構與職責】
   1. `parseTimecodeInput`：解析使用者輸入的字串（支援緊湊純數字如 `1234`、冒號分段 `01:02:03:04`）為浮點秒數。
   2. `handleTimecodeArrowKeys`：在輸入欄位中按上下方向鍵（ArrowUp / ArrowDown）時，針對當前游標所在分量（時/分/秒/格）進行智慧進位微調。
   3. `setupTimecodeInput`：數字草稿、自動分隔、組字／貼上與上下鍵微調；不改變時碼的解析及提交規則。
   ============================================================================== */
import { State } from './state.js';
import { pad } from './util.js';
import { encoreToSec, encoreParts, getExactFps } from './time.js';
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
    const tokens = s.split(/[:;]/);
    if (tokens.length > 4 || tokens.some(token => !/^\d+$/.test(token))) return null;
    const p = tokens.map(Number);
    if (p.some(value => !Number.isSafeInteger(value))) return null;
    // 由右至左：格, 秒, 分, 時
    f = p[p.length - 1] || 0;
    sec = p[p.length - 2] || 0;
    m = p[p.length - 3] || 0;
    h = p[p.length - 4] || 0;
  } else {
    if (!/^\d+$/.test(s)) return null;
    if (s.length > 8) return null;
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
  const fps = State.fps || 24;
  const exactFps = getExactFps(fps);
  const dropFrame = State.dropFrame;

  if (part === 3) {
    // FPS-SYNC: 上下鍵加減實際影格，而非進位不存在的 DF 標籤。
    const seconds = encoreToSec(`${h}:${m}:${s}:${f}`, fps, dropFrame);
    const frame = Math.max(0, Math.round(seconds * exactFps) + dir);
    const next = encoreParts(frame / exactFps, fps, dropFrame);
    input.value = sign + pad(next.hh) + ':' + pad(next.mm) + ':' + pad(next.ss) + sep + pad(next.ff, f.length);
    input.setSelectionRange(pos, pos);
    return;
  }

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
  }

  // 時／分／秒維持文字分量意圖；遇跳號則前進至該秒第一個有效標籤。
  if (dropFrame) {
    let seconds = encoreToSec(`${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`, fps, dropFrame);
    let next = encoreParts(seconds, fps, dropFrame);
    const targetClock = hh * 3600 + mm * 60 + ss;
    while (next.hh * 3600 + next.mm * 60 + next.ss < targetClock) {
      seconds += 1 / exactFps;
      next = encoreParts(seconds, fps, dropFrame);
    }
    hh = next.hh; mm = next.mm; ss = next.ss; ff = next.ff;
  }

  const frameStr = pad(ff, f.length);
  input.value = sign + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + sep + frameStr;
  input.setSelectionRange(pos, pos);
}

const timecodeInputs=new WeakSet();
const asciiTimecode=text=>String(text).replace(/[０-９：；．＋－]/g,char=>String.fromCharCode(char.charCodeAt(0)-0xfee0));
const digitCount=text=>(text.match(/\d/g)||[]).length;

// Draft formatting only. Do not clamp frame/minute fields or snap time here:
// callers retain their existing parse/commit authority, including empty values.
function timecodeDraft(text,{allowSign,allowSeconds,maxDigits=8,structured=false,decimalInput=false}){
  let body=asciiTimecode(text),sign='';
  if(/^[+-]/.test(body)){
    if(!allowSign)return null;
    sign=body[0];body=body.slice(1);
  }
  if(allowSeconds&&body.includes('.')){
    // Only an explicitly typed decimal point can switch an auto-grouped digit
    // draft (123 → 1:23) to seconds. Pasted clock+decimal text is ambiguous.
    if(decimalInput)body=body.replace(/[:;]/g,'');
    return /^\d*\.\d*$/.test(body)&&digitCount(body)<=Math.max(16,maxDigits)?sign+body:null;
  }
  if(!/^[\d:;]*$/.test(body))return null;
  if(structured&&/[:;]/.test(body)){
    const parts=body.split(/[:;]/);
    if(parts.length>4||parts.some(part=>!/^\d+$/.test(part)))return null;
    if(parts.slice(1).some(part=>part.length>2))return null;
    body=parts.map(part=>part.padStart(2,'0')).join('');
  }else body=body.replace(/[:;]/g,'');
  if(body.length>maxDigits)return null;
  const groups=[];
  while(body.length>2&&groups.length<3){groups.unshift(body.slice(-2));body=body.slice(0,-2);}
  if(body)groups.unshift(body);
  const df=encoreParts(0,State.fps,State.dropFrame).df;
  return sign+groups.map((part,index)=>index?`${index===groups.length-1&&df?';':':'}${part}`:part).join('');
}

function draftCursor(before,after,position){
  const editable=/[\d.+-]/;
  let remaining=[...asciiTimecode(before.slice(0,position))].filter(char=>editable.test(char)).length;
  if(!remaining)return 0;
  for(let i=0;i<after.length;i++){
    if(editable.test(after[i])&&!--remaining){
      const end=i+1;
      return /[:;]/.test(before[position-1]||'')&&/[:;]/.test(after[end]||'')?end+1:end;
    }
  }
  return after.length;
}

/** Bind once. Signs and decimal seconds are enabled only for existing callers. */
function setupTimecodeInput(inp,{allowSign=false,allowSeconds=false}={}) {
  if (!inp||timecodeInputs.has(inp)) return;
  timecodeInputs.add(inp);
  inp.inputMode=allowSeconds?'decimal':'numeric';inp.spellcheck=false;
  let composing=false,decimalInput=false;
  const snapshot=()=>({value:inp.value,start:inp.selectionStart,end:inp.selectionEnd});
  let previous=snapshot();
  const options=()=>({allowSign,allowSeconds,maxDigits:Math.max(8,digitCount(previous.value))});
  const writable=()=>!inp.disabled&&!inp.readOnly;
  const normalize=()=>{
    if(!writable())return;
    const raw=inp.value,start=inp.selectionStart,end=inp.selectionEnd;
    const next=timecodeDraft(raw,{...options(),decimalInput});decimalInput=false;
    if(next===null){inp.value=previous.value;inp.setSelectionRange(previous.start,previous.end);}
    else if(next!==raw){inp.value=next;inp.setSelectionRange(draftCursor(raw,next,start),draftCursor(raw,next,end));}
    previous=snapshot();
  };
  const paste=text=>{
    if(!writable())return;
    previous=snapshot();
    const folded=asciiTimecode(text.trim());
    if(!folded)return;
    // A formatted long-hour timecode is already supported by the parser. Do
    // not silently truncate it to the compact-input eight-digit limit.
    const maxDigits=/[:;]/.test(folded)?Math.max(8,digitCount(folded),digitCount(previous.value)):options().maxDigits;
    const next=timecodeDraft(folded,{...options(),maxDigits,structured:true});
    if(next===null)return;
    const raw=previous.value.slice(0,previous.start)+next+previous.value.slice(previous.end);
    if(timecodeDraft(raw,{...options(),maxDigits})===null)return;
    inp.setRangeText(next,previous.start,previous.end,'end');
    previous={...previous,value:raw};
    inp.dispatchEvent(new Event('input',{bubbles:true}));
  };
  let pasteGeneration=0;
  const cancelPaste=()=>{pasteGeneration++;};
  inp.addEventListener('beforeinput',e=>{
    cancelPaste();if(composing||e.isComposing||!writable())return;
    decimalInput=false;
    previous=snapshot();
    if(e.inputType==='insertText'||e.inputType==='insertReplacementText'){
      const text=asciiTimecode(e.data||'');
      const allowed=/^\d+$/.test(text)||(allowSign&&/^[+-]$/.test(text))||(allowSeconds&&text==='.');
      const raw=inp.value.slice(0,inp.selectionStart)+text+inp.value.slice(inp.selectionEnd);
      const decimal=allowSeconds&&text==='.';
      if(!allowed||timecodeDraft(raw,{...options(),decimalInput:decimal})===null)e.preventDefault();
      else decimalInput=decimal;
    }else if(inp.selectionStart===inp.selectionEnd){
      const pos=inp.selectionStart;
      // Deleting a generated separator would otherwise appear to do nothing.
      // Include the adjacent digit, preserving the usual text-edit direction.
      if(e.inputType==='deleteContentBackward'&&/[:;]/.test(inp.value[pos-1]||''))inp.setSelectionRange(Math.max(0,pos-2),pos);
      if(e.inputType==='deleteContentForward'&&/[:;]/.test(inp.value[pos]||''))inp.setSelectionRange(pos,Math.min(inp.value.length,pos+2));
    }
  });
  inp.addEventListener('input',e=>{cancelPaste();if(!composing&&!e.isComposing)normalize();},true);
  inp.addEventListener('compositionstart',()=>{cancelPaste();previous=snapshot();composing=true;});
  inp.addEventListener('compositionend',()=>{composing=false;normalize();});
  inp.addEventListener('paste',e=>{if(!writable()||!e.clipboardData)return;e.preventDefault();cancelPaste();paste(e.clipboardData.getData('text/plain'));});
  inp.addEventListener('blur',()=>{
    cancelPaste();
    // Blur can precede the final composition event. Normalize before callers'
    // blur-to-commit listeners see the text; never submit an IME draft as zero.
    if(composing){composing=false;normalize();}
  },true);
  inp.addEventListener('keydown', e=>{
    cancelPaste();
    // 組字的 Enter／方向鍵屬於輸入法；先於各 caller 的確認 handler 攔下，保留原生預設動作。
    if(composing||e.isComposing||e.keyCode===229){ e.stopImmediatePropagation();return; }
    if(!writable())return;
    if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.length===1){
      const key=asciiTimecode(e.key);
      if(!/^\d$/.test(key)&&!(allowSign&&/^[+-]$/.test(key))&&!(allowSeconds&&key==='.'))e.preventDefault();
    }
    handleTimecodeArrowKeys(e);
    previous=snapshot();
  },true);
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
          const generation=++pasteGeneration;
          const value=inp.value, start=inp.selectionStart, end=inp.selectionEnd;
          if(!inp.isConnected || inp.disabled || inp.readOnly) return;
          try {
            const txt = await navigator.clipboard.readText();
            if (txt && generation===pasteGeneration && inp.isConnected && !inp.disabled && !inp.readOnly
              && inp.value===value && inp.selectionStart===start && inp.selectionEnd===end) {
              paste(txt);
            }
          } catch (err) {}
        },
      },
    ],{preserveFocus:true});
  });
}

export { parseTimecodeInput, setupTimecodeInput };

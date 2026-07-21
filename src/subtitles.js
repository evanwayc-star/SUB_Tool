/* SUB Tool — 字幕列表：渲染、選取（多選）、新增/刪除、軌道切換/樣式 */
import { $, sublist, video } from './dom.js';
import { State, isSel, newId, trackVisible, cueSuffix, ensureTrackCount } from './state.js';
import { escapeHTML, tcKeyAllowed } from './util.js';
import { fmtClock, secToEncore, snapTimeToFrame } from './time.js';
import { Media } from './media.js';
import { renderCueBlocks, drawTimeline, updatePlayhead, refreshTrackGutterActive } from './timeline.js';
import { emit } from './events.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { ensureProjectSaved } from './project.js';
import { showToast, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { effStyle, getAllPresets, STYLE_DEFAULTS, colorName, posToPx } from './substyle.js'; // colorName 只用在色點的 title

/* 該句的「常用樣式名稱」：軌樣式完全吻合某個已存的常用樣式 → 顯示其名；有逐句覆蓋 → 「自訂」；
   皆非 → 留白。以軌為單位比對並快取（字幕上千條時避免逐句重算）；renderSubList 每次重繪前清空。 */
const _presetNameCache = new Map();
const _customCodeMap = new Map();
let _customCodeCounter = 1;

export function clearPresetNameCache(){ 
  _presetNameCache.clear(); 
  
  // 掃描並找出目前真正有使用的自訂樣式 key
  const activeKeys = new Set();
  const keys = Object.keys(STYLE_DEFAULTS);
  const presets = getAllPresets();
  for (const c of State.cues) {
    if (c.style && Object.keys(c.style).length > 0) {
      const st = effStyle(c, State.tracks[c.track || 0] || null);
      let name = '';
      for (const p of presets) {
        const ps = p.style || {};
        if (keys.every(k => (ps[k] != null ? ps[k] : STYLE_DEFAULTS[k]) === st[k])) { name = p.name; break; }
      }
      if (!name) {
        let key = '';
        for (const k of keys) key += st[k] + '|';
        activeKeys.add(key);
      }
    }
  }

  // 刪除不再使用的舊 key (Garbage Collection)
  for (const oldKey of _customCodeMap.keys()) {
    if (!activeKeys.has(oldKey)) {
      _customCodeMap.delete(oldKey);
    }
  }

  // 找出目前已被佔用的號碼
  const usedNumbers = new Set();
  for (const code of _customCodeMap.values()) {
    const m = code.match(/自訂-(\d+)/);
    if (m) usedNumbers.add(parseInt(m[1], 10));
  }

  // 幫新的 key 分配最小的可用號碼
  for (const key of activeKeys) {
    if (!_customCodeMap.has(key)) {
      let num = 1;
      while (usedNumbers.has(num)) num++;
      _customCodeMap.set(key, '自訂-' + String(num).padStart(2, '0'));
      usedNumbers.add(num);
    }
  }
}

function _getCustomCodeForStyle(st){
  let key = '';
  const keys = Object.keys(STYLE_DEFAULTS);
  for(const k of keys) key += st[k] + '|';
  
  if(_customCodeMap.has(key)) return _customCodeMap.get(key);
  
  const code = '自訂-' + String(_customCodeCounter).padStart(2, '0');
  _customCodeCounter++;
  _customCodeMap.set(key, code);
  return code;
}

function _getPresetNameForStyle(st){
  // 建立序列化字串作為快取 key (確保屬性順序一致)
  let key = '';
  const keys = Object.keys(STYLE_DEFAULTS);
  for(const k of keys) key += st[k] + '|';
  
  if(_presetNameCache.has(key)) return _presetNameCache.get(key);
  
  let name = '';
  for(const p of getAllPresets()){
    const ps = p.style || {};
    if(keys.every(k => (ps[k] != null ? ps[k] : STYLE_DEFAULTS[k]) === st[k])){ name = p.name; break; }
  }
  _presetNameCache.set(key, name);
  return name;
}

function styleNameHtml(c){
  const isOv = c.style && Object.keys(c.style).length > 0;
  const st = effStyle(c, State.tracks[c.track || 0] || null);
  const n = _getPresetNameForStyle(st);
  
  if (n) {
    const isCustom = n !== '預設';
    const cls = isCustom ? 'nm custom' : 'nm';
    if (isOv) {
      // 雖然有覆蓋，但最終樣式吻合某個常用樣式
      return `<span class="${cls}" title="此句有逐句樣式覆蓋，等同常用樣式：${escapeHTML(n)}">✱ ${escapeHTML(n)}</span>`;
    } else {
      return `<span class="${cls}" title="常用樣式：${escapeHTML(n)}">${escapeHTML(n)}</span>`;
    }
  } else {
    // 找不到符合的常用樣式
    if (isOv) {
      const code = _getCustomCodeForStyle(st);
      return `<span class="nm ov-custom" title="此句有逐句樣式覆蓋">✱ ${code}</span>`;
    }
    return '';
  }
}

/* 色票膠囊上的文字色：依背景亮度選深或淺——白底白字、黑底黑字都會整個消失。 */
function inkOn(hex){
  const h=String(hex||'').replace('#','');
  const r=parseInt(h.slice(0,2),16)||0, g=parseInt(h.slice(2,4),16)||0, b=parseInt(h.slice(4,6),16)||0;
  return (0.299*r + 0.587*g + 0.114*b) > 140 ? '#111' : '#fff';
}

/* 樣式摘要（兩行，以 | 分隔，欄位順序依規格）：
   行1：字 字級 | 上下對齊 | 左右對齊 | 字型 | [色] | [框] 粗細 | B | I
   行2：座標(X,Y 像素) | 角度 N° | 直式/橫式 | [底] 不透明度% | 距 字距 / 行距
   [色][框][底]＝【填該顏色的膠囊】，標籤與色票合一（比「標籤＋色點」省一半寬度）；
   色名留在 title。B/I 與「底」亮＝開、暗＝關。有逐句覆蓋另由 styleNameHtml 標 ✱。 */
function styleSummaryHtml(c){
  const st=effStyle(c, State.tracks[c.track||0]||null);
  const tSt=effStyle({style:{}}, State.tracks[c.track||0]||null);
  const cp=(label,hex,t,on)=>`<b class="cp${on===false?' off':''}" style="background:${hex};color:${inkOn(hex)}"`+
    ` title="${t}：${colorName(hex)||hex}${on===false?'（未啟用）':''}">${label}</b>`;
  const tg=(label,on,t,cls)=>`<b class="tg${on?' on':''}${cls?' '+cls:''}" title="${t}：${on?'開':'關'}">${label}</b>`;
  const n=(v,t)=>`<b class="n" title="${t}">${v}</b>`;
  const lbl=t=>`<span class="lbl">${t}</span>`;
  const sep=`<span class="sp">|</span>`;
  const va={top:'上對齊',middle:'中對齊',bottom:'下對齊'}[st.valign||'bottom'];
  const al={left:'左對齊',center:'中對齊',right:'右對齊'}[st.align||'center'];
  const p=posToPx(st);
  const isPosChanged = st.posX !== tSt.posX || st.posY !== tSt.posY;
  const pCls = isPosChanged ? 'g hl warn' : 'g hl';
  const fsCls = st.fontSize !== tSt.fontSize ? 'g hl warn' : 'g hl';
  const vaCls = st.valign !== tSt.valign ? 'hl warn' : 'hl';
  const alCls = st.align !== tSt.align ? 'hl warn' : 'hl';
  return `<span class="r1">`+
      `<span class="${fsCls}" title="字級">${lbl('字')}${n(st.fontSize,'字級')}</span>`+sep+
      tg('B',st.bold,'粗體')+' '+tg('I',st.italic,'斜體','it')+sep+
      `<span class="${vaCls}" title="多行／多句的垂直對齊">${va}</span>`+sep+
      `<span class="${alCls}" title="多行／多句的水平對齊">${al}</span>`+sep+
      (st.vertical ? `<span title="排版方向" class="tg on">直</span>`+sep : '')+
      cp('色',st.color,'文字顏色')+sep+
      `<span class="fn" title="字型：${escapeHTML(st.font)}">${escapeHTML(st.font)}</span>`+
    `</span>`+
    `<span class="r2">`+
      `<span class="${pCls}" title="座標（像素，文字塊${al==='中對齊'&&va==='中對齊'?'中心':'錨點'}）">座標(${p.x},${p.y})</span>`+sep+
      `<span class="g" title="旋轉角度">${lbl('角度')}${n(st.angle,'角度')}</span>`+sep+
      `<span class="g" title="字距／行距">${lbl('距')}${n(st.letterSpacing,'字距')}<span class="sp2">/</span>${n(st.lineSpacing,'行距')}</span>`+sep+
      `<span class="g" title="框線粗細 ${st.outline}">${cp('框',st.outlineColor,'框線顏色')}${n(st.outline,'框線粗細')}</span>`+sep+
      `<span class="g" title="陰影 ${st.shadow}">${lbl('影')}${n(st.shadow,'陰影')}</span>`+sep+
      `<span class="g" title="底色／不透明度">${cp('底',st.bgColor,'背景色塊',!!st.bgBox)}${n(Math.round(st.bgAlpha*100),'不透明度')}${lbl('%')}</span>`+
    `</span>`;
}
import { showCueMenu, showCtx } from './menus.js';

/* ===== 字幕對調模式 ================================================= */
let _swapSource = null;
let _checkLenLimit = 0; // 0=不檢查；> 0 = 每行超過此字數以紅粗體標示
let _checkContains = []; // 空陣列=不篩選；字串陣列=OR 條件關鍵字

function enterSwapMode(id){
  _swapSource = id;
  sublist.querySelectorAll('.sub-row').forEach(r=>r.classList.remove('swap-src'));
  const srcRow=sublist.querySelector(`.sub-row[data-id="${id}"]`);
  if(srcRow)srcRow.classList.add('swap-src');
  sublist.classList.add('swap-mode');
  showToast('文字交換模式：點選目標字幕（Esc 取消）');
}
function cancelSwapMode(){
  _swapSource=null;
  sublist.querySelectorAll('.sub-row').forEach(r=>r.classList.remove('swap-src'));
  sublist.classList.remove('swap-mode');
}

export function snapAllCuesToFrames() {
  if (!State.fps) return false;
  let changed = false;
  for (const c of State.cues) {
    if (c.timed === false) continue;
    const ns = snapTimeToFrame(c.start, State.fps, State.dropFrame);
    const ne = snapTimeToFrame(c.end, State.fps, State.dropFrame);
    if (Math.abs(ns - c.start) > 1e-6 || Math.abs(ne - c.end) > 1e-6) {
      c.start = ns; c.end = ne;
      changed = true;
    }
  }
  return changed;
}

function swapAdjacentCues(id, dir){
  const cue = State.cues.find(c => c.id === id);
  if (!cue) return;
  const tk = cue.track || 0;
  const list = State.cues.filter(c => (c.track || 0) === tk);
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return;
  
  let targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= list.length) return;
  
  const targetCue = list[targetIdx];
  if (cue.timed === false || targetCue.timed === false) {
    const tmp = cue.text; cue.text = targetCue.text; targetCue.text = tmp;
    emit('render:all'); recordHistory('相鄰換位');
    return;
  }
  
  const cue1 = dir === -1 ? targetCue : cue;
  const cue2 = dir === -1 ? cue : targetCue;
  
  const dur1 = cue1.end - cue1.start;
  const dur2 = cue2.end - cue2.start;
  const gap = cue2.start - cue1.end;
  
  const newStart2 = cue1.start;
  const newEnd2 = newStart2 + dur2;
  const newStart1 = newEnd2 + gap;
  const newEnd1 = newStart1 + dur1;
  
  cue2.start = newStart2;
  cue2.end = newEnd2;
  
  cue1.start = newStart1;
  cue1.end = newEnd1;
  
  sortCues();
  emit('render:all');
  recordHistory('相鄰換位');
}

function mergeAdjacentCues(id, dir){
  const cue = State.cues.find(c => c.id === id);
  if (!cue) return;
  const tk = cue.track || 0;
  const list = State.cues.filter(c => (c.track || 0) === tk);
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return;
  
  let targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= list.length) return;
  
  const targetCue = list[targetIdx];
  const cue1 = dir === -1 ? targetCue : cue;
  const cue2 = dir === -1 ? cue : targetCue;
  
  const t1 = (cue1.text || '').trim();
  const t2 = (cue2.text || '').trim();
  const newText = t1 && t2 ? `${t1} ${t2}` : `${t1}${t2}`;

  cue1.text = newText;
  
  if (cue1.timed !== false && cue2.timed !== false) {
    cue1.end = cue2.end;
  }
  
  const idx2 = State.cues.findIndex(c => c.id === cue2.id);
  if (idx2 >= 0) State.cues.splice(idx2, 1);
  
  if (State.selectedId === cue2.id) {
    State.selectedId = cue1.id;
    State.selectedIds = [cue1.id];
  } else if (State.selectedIds.includes(cue2.id)) {
    State.selectedIds = State.selectedIds.filter(x => x !== cue2.id);
    if (!State.selectedIds.includes(cue1.id)) State.selectedIds.push(cue1.id);
  }

  sortCues();
  emit('render:all');
  recordHistory('合併字幕');
}

/* ===== 搜尋狀態 ===================================================== */
let _searchTerms = [];
let _searchMatches = []; // cue ids of matches in list order
let _searchIdx = -1;

function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function txtHTML(text){
  const raw = text||'';
  if(!_searchTerms.length) return escapeHTML(raw);
  // 兩階段：先在「純文字」上收集所有命中區間並合併，再一次性包標記。
  // （逐詞對已含 <span> 標記的結果字串再跑 regex，會命中標記本身——例如詞含 s/a/n——拆壞 HTML）
  const ranges=[];
  for(const term of _searchTerms){
    if(!term) continue;
    const re = new RegExp(escRe(term),'gi');
    let m; while((m=re.exec(raw))){ if(!m[0].length){ re.lastIndex++; continue; } ranges.push([m.index, m.index+m[0].length]); }
  }
  if(!ranges.length) return escapeHTML(raw);
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged=[ranges[0].slice()];
  for(let i=1;i<ranges.length;i++){
    const last=merged[merged.length-1];
    if(ranges[i][0]<=last[1]) last[1]=Math.max(last[1],ranges[i][1]);
    else merged.push(ranges[i].slice());
  }
  let out='', pos=0;
  for(const [s,e] of merged){
    out+=escapeHTML(raw.slice(pos,s))+`<span class="search-match">${escapeHTML(raw.slice(s,e))}</span>`;
    pos=e;
  }
  return out+escapeHTML(raw.slice(pos));
}

/* ===== 時間點內嵌編輯 =============================================== */
function openInlineTimeEdit(el, curSec, onCommit){
  if(el.querySelector('input')) return;
  const origText = el.textContent;
  const inp = document.createElement('input');
  inp.className = 'tc-edit'; inp.style.width = '80px'; inp.value = origText;
  setupTimecodeInput(inp);
  el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const fin = (commit) => {
    if(done) return; done = true;
    if(commit){
      const raw = inp.value.trim();
      if(raw === origText || raw === '--:--:--:--' || raw === ''){
        inp.remove(); el.textContent = origText; return;
      }
      let t = null;
      if(raw.startsWith('+') || raw.startsWith('-')){
        const sign = raw.startsWith('-') ? -1 : 1;
        const delta = parseTimecodeInput(raw.slice(1));
        if(delta !== null){
          t = curSec + sign * delta;
          if(t < 0){ showToast('時間不能早於 00:00:00:00'); inp.remove(); el.textContent = origText; return; }
        }
      } else {
        t = parseTimecodeInput(raw);
      }
      if(t !== null){ onCommit(t); return; } // onCommit → renderAll rebuilds DOM
    }
    inp.remove(); el.textContent = origText;
  };
  inp.addEventListener('keydown', e=>{ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); fin(true); }
    else if(e.key==='Escape'){ e.preventDefault(); fin(false); }
    else if(!tcKeyAllowed(e)) e.preventDefault(); // 只允許數字與 : ; + -（i/o 等其他鍵忽略）
  });
  inp.addEventListener('blur', ()=>fin(true));
  inp.addEventListener('mousedown', e=>e.stopPropagation());
}

/* ===== 6. 字幕列表 ==================================================== */
function updateTlSel(){
  // Synchronized via MutationObserver in app.js
}

/* Fix #1：雙層掃描正確偵測所有重疊（含「長字幕包住多短字幕」的情況）。
   對每條 sorted[i]，向後掃到 sorted[j].start >= sorted[i].end 為止，
   期間所有 j 均與 i 重疊。O(N + K) 其中 K 為重疊對數，對一般字幕數量很快。 */
function _detectOverlaps(cues, eps=0.001){
  const set=new Set();
  const sorted=cues.filter(c=>c.timed!==false).slice().sort((a,b)=>a.start-b.start);
  for(let i=0;i<sorted.length;i++){
    for(let j=i+1;j<sorted.length;j++){
      if(sorted[j].start >= sorted[i].end - eps) break; // 已排序，後面不可能再重疊
      set.add(sorted[i].id); set.add(sorted[j].id);
    }
  }
  return set;
}

function renderCheckPanel(){
  const panel=$('checkPanel'); if(!panel||!panel.classList.contains('show'))return;
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  // 時間碼重疊
  const overlapSet=_detectOverlaps(list);
  const overlapNums=list.map((c,i)=>overlapSet.has(c.id)?i+1:null).filter(n=>n!==null);
  // 多行（排除空白字幕，避免純換行符被誤計）
  const multiNums=list.map((c,i)=>{const t=c.text||'';return t.trim()&&(t.match(/\n/g)||[]).length>=2?i+1:null;}).filter(n=>n!==null);
  const twoNums  =list.map((c,i)=>{const t=c.text||'';return t.trim()&&(t.match(/\n/g)||[]).length===1?i+1:null;}).filter(n=>n!==null);
  // 空白字幕
  const blankNums=list.map((c,i)=>!(c.text||'').trim()?i+1:null).filter(n=>n!==null);
  
  // 連續相同
  const consecutiveIdenticalSet = new Set();
  for(let i=1; i<list.length; i++){
    const t1 = (list[i-1].text||'').trim();
    const t2 = (list[i].text||'').trim();
    if(t1 && t1 === t2){
      consecutiveIdenticalSet.add(i);
      consecutiveIdenticalSet.add(i+1);
    }
  }
  const consecutiveIdenticalNums = Array.from(consecutiveIdenticalSet).sort((a,b)=>a-b);
  
  // SRT標籤
  const bNums=list.map((c,i)=>/<\/?b>/i.test(c.text||'')?i+1:null).filter(n=>n!==null);
  const iNums=list.map((c,i)=>/<\/?i>/i.test(c.text||'')?i+1:null).filter(n=>n!==null);
  const uNums=list.map((c,i)=>/<\/?u>/i.test(c.text||'')?i+1:null).filter(n=>n!==null);
  const fontNums=list.map((c,i)=>/<\/?font/i.test(c.text||'')?i+1:null).filter(n=>n!==null);
  const posNums=list.map((c,i)=>/\{\\an\d\}/i.test(c.text||'')?i+1:null).filter(n=>n!==null);
  
  // 頭尾空白
  const trimNums=list.map((c,i)=>{
    const t=c.text||'';
    if(t.match(/^[ 　]+|[ 　]+$/m)) return i+1;
    return null;
  }).filter(n=>n!==null);
  // 超過字數
  const lenEl=$('cpLenInput');
  _checkLenLimit = lenEl ? (parseInt(lenEl.value)||0) : 0;
  const overLenNums = _checkLenLimit
    ? list.map((c,i)=>{ const t=c.text||''; return t.trim()&&t.split(/\n/).some(ln=>ln.length>_checkLenLimit)?i+1:null; }).filter(n=>n!==null)
    : [];
  // 包含文字（|| 為 OR）
  const containsRaw=($('cpContainsInput')||{}).value||'';
  // 純空白詞（用來搜尋空格）保留原樣；有文字的詞才去掉裝飾性 ASCII 空格
  _checkContains=containsRaw.split('||').map(s=>s.trim()===''?s:s.replace(/^[ ]+|[ ]+$/g,'')).filter(s=>s.length>0);
  const containsNums=_checkContains.length
    ? list.map((c,i)=>{ const t=(c.text||'').toLowerCase(); return _checkContains.some(kw=>t.includes(kw.toLowerCase()))?i+1:null; }).filter(n=>n!==null)
    : [];
  // 無時間碼
  const noTimeNums=list.map((c,i)=>c.timed===false?i+1:null).filter(n=>n!==null);
  
  const mkNums=nums=>nums.length?nums.map(n=>`<span class="cp-num" data-idx="${n}">${n}</span>`).join(', '):'無';
  const ro=$('cpOverlap'),rm=$('cpMulti'),r2=$('cpTwo'),rb=$('cpBlank'),rl=$('cpOverLen'),rc=$('cpContains'),rt=$('cpTrim'),rn=$('cpNoTime'),rci=$('cpConsecutiveIdentical');
  const sb=$('cpSrtB'),si=$('cpSrtI'),su=$('cpSrtU'),sf=$('cpSrtFont'),sp=$('cpSrtPos');
  if(rn)rn.querySelector('.cp-nums').innerHTML=mkNums(noTimeNums);
  if(ro)ro.querySelector('.cp-nums').innerHTML=mkNums(overlapNums);
  if(rm)rm.querySelector('.cp-nums').innerHTML=mkNums(multiNums);
  if(rt)rt.querySelector('.cp-nums').innerHTML=mkNums(trimNums);
  if(r2)r2.querySelector('.cp-nums').innerHTML=mkNums(twoNums);
  if(rb)rb.querySelector('.cp-nums').innerHTML=mkNums(blankNums);
  if(rci)rci.querySelector('.cp-nums').innerHTML=mkNums(consecutiveIdenticalNums);
  if(sb)sb.querySelector('.cp-nums').innerHTML=mkNums(bNums);
  if(si)si.querySelector('.cp-nums').innerHTML=mkNums(iNums);
  if(su)su.querySelector('.cp-nums').innerHTML=mkNums(uNums);
  if(sf)sf.querySelector('.cp-nums').innerHTML=mkNums(fontNums);
  if(sp)sp.querySelector('.cp-nums').innerHTML=mkNums(posNums);
  if(rl)rl.querySelector('.cp-nums').innerHTML=_checkLenLimit?mkNums(overLenNums):'—';
  if(rc)rc.querySelector('.cp-nums').innerHTML=_checkContains.length?mkNums(containsNums):'—';
  panel.querySelectorAll('.cp-num').forEach(el=>{
    el.onclick=()=>{
      const idx=parseInt(el.dataset.idx)-1; const c=list[idx]; if(!c)return;
      selectCue(c.id,{seek:true});
      const row=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);
      if(row)row.scrollIntoView({block:'center'});
    };
  });
}

/* 軌道／逐句樣式改動後，就地重寫各列的樣式摘要與樣式名。
   ── 不走 renderSubList()：它會 innerHTML='' 重建整份，捲動位置跳回頂端；而樣式面板是
      邊拖數字邊看列表的，每個 input 事件跳一次根本沒法用。這裡只換 .sub-sty/.sub-styname
      兩個節點的內容，其餘 DOM（含捲動位置、選取狀態）原封不動。 */
let _styleSumT = null;
export function refreshStyleSummaries(){
  clearTimeout(_styleSumT);
  _styleSumT = setTimeout(() => {
    const rows=sublist.querySelectorAll('.sub-row'); if(!rows.length)return;
    clearPresetNameCache(); // 重新掃描並穩定自訂編號
    const byId=new Map(State.cues.map(c=>[c.id,c]));
    for(const row of rows){
      const c=byId.get(row.dataset.id); if(!c)continue;
      const sty=row.querySelector('.sub-sty'); if(sty)sty.innerHTML=styleSummaryHtml(c);
      const nm=row.querySelector('.sub-styname'); if(nm)nm.innerHTML=styleNameHtml(c);
    }
  }, 200);
}

function renderSubList(){
  sublist.innerHTML='';
  clearPresetNameCache(); // 軌樣式／常用樣式庫可能已變 → 重新比對名稱及自訂代號
  const list = State.cues.filter(c=>(c.track||0)===State.listTrack);
  if(list.length===0){
    sublist.innerHTML='<div class="empty">'+(State.cues.length?'此軌道沒有字幕':'尚無字幕<br><br>· 匯入字幕檔，或<br>· 選一條字幕後按 <b>I</b>/<b>O</b> 設定起訖<br>· 或點 <b>⬆＋ / ⬇＋</b> 新增')+'</div>';
    $('subCount').textContent=list.length+' 條'; return;
  }
  $('subCount').textContent=list.length+' 條';
  // 偵測同軌道時間重疊（O(N log N)）
  const timed=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
  const overlaps=_detectOverlaps(timed, 0.001);
  // perf：一次組好整份 HTML 字串再單次 innerHTML（取代每列 createElement+innerHTML）。
  // 列互動全為 sublist 層級事件委派，批次 innerHTML 不影響任何事件；1500 列由 ~167ms 大幅下降。
  let html='';
  for(let i=0;i<list.length;i++) html+=_subRowHTML(list[i],i,overlaps);
  sublist.innerHTML=html;
  renderCheckPanel();
}

function lineCountClass(text){
  const n=((text||'').match(/\n|\/\//g)||[]).length;
  return n>=2?' multi-line':n===1?' two-line':'';
}
function _rowClass(c){
  const classes = [];
  if(c.timed===false) classes.push('no-time');
  if(!(c.text||'').trim()) classes.push('blank');
  else {
    const lc = lineCountClass(c.text).trim();
    if(lc) classes.push(lc);
  }
  return classes.join(' ');
}
function _lineLenHTML(line){
  if(!_checkLenLimit||line.length<=_checkLenLimit) return escapeHTML(line);
  return escapeHTML(line.slice(0,_checkLenLimit))+`<span class="over-len">${escapeHTML(line.slice(_checkLenLimit))}</span>`;
}
function _txtInner(text){
  if(!(text||'').trim()) return '<span class="blank-label">(空白字幕)</span>';
  if(!_checkLenLimit) return txtHTML(text||'').replace(/\n/g, '<br>');
  // 有字數限制：逐行套用，不套用搜尋高亮（兩者同時存在時以字數優先）
  return (text||'').split(/\n/).map(_lineLenHTML).join('<br>');
}
function _subRowHTML(c,i,overlaps){
  const rc=_rowClass(c);
  const containsHit=_checkContains.length&&_checkContains.some(kw=>(c.text||'').toLowerCase().includes(kw.toLowerCase()));
  const cls='sub-row'+(rc?' '+rc:'')+(_searchMatches.includes(c.id)?' search-hit':'')+(isSel(c.id)?' sel':'')+(c.id===State.selectedId?' primary':'')+(c.id===State.activeId?' active':'')+(overlaps?.has(c.id)?' overlap':'')+(containsHit?' contains-match':'');
  const timed=c.timed!==false;
  return `<div class="${cls}" data-id="${c.id}">`+
    `<div class="idx">${i+1}</div>`+
    `<div class="body">`+
      `<div class="times">`+
         (timed?`<span class="tin">${secToEncore(c.start,State.fps,State.dropFrame)}</span> → <span class="tout">${secToEncore(c.end,State.fps,State.dropFrame)}</span>`
               :`<span class="tin untimed">--:--:--:--</span> → <span class="tout untimed">--:--:--:--</span>`)+
        (timed?`<span class="dur">${(c.end-c.start).toFixed(2)}s</span>`:``)+
      `</div>`+
      `<div class="txt" contenteditable="false" spellcheck="false">${_txtInner(c.text)}</div>`+
    `</div>`+
    `<div class="sub-sty">${styleSummaryHtml(c)}</div>`+
    `<div class="sub-styname">${styleNameHtml(c)}</div>`+
    (State.trackCount>1?`<div class="tk">軌${(c.track||0)+1}</div>`:``)+
  `</div>`;
}

function renderSubRow(id){
  const row=sublist.querySelector(`.sub-row[data-id="${id}"]`); if(!row)return;
  const c=State.cues.find(x=>x.id===id); if(!c)return;
  const timed=c.timed!==false;
  const times=row.querySelector('.times');
   if(timed)times.innerHTML=`<span class="tin">${secToEncore(c.start,State.fps,State.dropFrame)}</span> → <span class="tout">${secToEncore(c.end,State.fps,State.dropFrame)}</span><span class="dur">${(c.end-c.start).toFixed(2)}s</span>`;
   else times.innerHTML=`<span class="tin untimed">--:--:--:--</span> → <span class="tout untimed">--:--:--:--</span>`;
  const txt=row.querySelector('.txt');
  if(txt&&txt.contentEditable!=='true') txt.innerHTML=_txtInner(c.text);
}

function selectCue(id,opts){
  opts=opts||{};
  State.selectedClipId=null;
  State.selectedAudioClipId=null; // 選字幕即取消影片／音訊素材選取，避免 Delete 目標混淆
  // 清理可能殘留的超長預設字幕
  let changed = false;
  State.cues.forEach(cue => {
    if (cue._tempEnd && cue.id !== id) {
      cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
      delete cue._tempEnd;
      changed = true;
    }
  });
  if (changed) {
    emit('render:videoSub'); emit('mpv:refreshSubs');
    emit('render:all');
  }

  if(opts.additive){
    const i=State.selectedIds.indexOf(id);
    if(i>=0)State.selectedIds.splice(i,1); else State.selectedIds.push(id);
    State.selectedId=State.selectedIds[State.selectedIds.length-1]||null;
  }else if(opts.range && State.selectedId){
    const ids=State.cues.map(c=>c.id);
    const a=ids.indexOf(State.selectedId), b=ids.indexOf(id);
    if(a>=0&&b>=0){ const lo=Math.min(a,b),hi=Math.max(a,b); State.selectedIds=ids.slice(lo,hi+1); }
  }else{ State.selectedIds=[id]; State.selectedId=id; }
  State.activeEdge='start';
  const c=State.cues.find(x=>x.id===id);
  if(c && !opts.additive && !opts.range){
    const tk=c.track||0;
    if(tk!==State.listTrack){ State.listTrack=tk; emit('render:listTrackSel'); renderSubList(); refreshTrackGutterActive(); }
  }
  refreshSelectionUI(opts);
  if(opts.seek&&c){
    if(c.timed!==false){
      const t = Media.displayTime();
      // 字幕作用區間為 [start, end)：播放點正好落在 end 時字幕已不在播放中，
      // 視為「範圍外」→ 回到 in 點（否則選無時間碼字幕先把播放點移到前一句 end，
      // 再選該前一句時會卡在 end、不回 in 點）。
      if(t < c.start || t >= c.end){
        Media.seek(snapTimeToFrame(c.start, State.fps, State.dropFrame)); emit('playhead:ensure'); emit('render:videoSub');
      }
    }else{
      const tkCues = State.cues.filter(x=>(x.track||0)===(c.track||0));
      const idx = tkCues.findIndex(x=>x.id===c.id);
      if(idx>0){
        let prev = tkCues[idx-1];
        if(prev.timed!==false){
          Media.seek(snapTimeToFrame(prev.end, State.fps, State.dropFrame)); emit('playhead:ensure'); emit('render:videoSub');
        }
      }
    }
  }
  const pc=State.cues.find(x=>x.id===State.selectedId);
  $('stSel').textContent=State.selectedIds.length?('已選 '+State.selectedIds.length+' 條'+(pc?(' · #'+(State.cues.indexOf(pc)+1)):'')):'';
  updatePlayhead();
}
function selectCueSingle(id,seek){ selectCue(id,{seek}); }
// I/O 提交：只動了一條 cue 的起訖。排序後若「該軌顯示順序不變」，用局部更新（更新該列時碼 +
// 重算重疊 class，不重建整列 DOM），把上字幕在大量字幕下每次 I/O 的全列重建（~150ms@1500）省掉；
// 順序變了（start 跨過鄰居）才退回全列重建以保持正確。
export function sweepContainedCues(changedCues) {
  if (!State.overwriteMode || State.overwriteKeep) return false;
  let changed = false;
  const snapF = (t) => snapTimeToFrame(t, State.fps, State.dropFrame);
  for (const c of changedCues) {
    if (!c || c.timed === false) continue;
    const tk = c.track || 0;
    for (let i = State.cues.length - 1; i >= 0; i--) {
      const b = State.cues[i];
      if (b.id === c.id || (b.track || 0) !== tk || b.timed === false) continue;
      
      // 檢查是否重疊
      if (b.end > c.start + 0.001 && b.start < c.end - 0.001) {
        if (b.start >= c.start - 0.001 && b.end <= c.end + 0.001) {
          // 完全被包含 -> 刪除
          State.cues.splice(i, 1);
          changed = true;
        } else if (b.start < c.start - 0.001 && b.end > c.end + 0.001) {
          // c 完全包含在 b 裡面 -> b 被一分為二
          const newB = JSON.parse(JSON.stringify(b));
          newB.id = newId();
          newB.start = snapF(c.end);
          b.end = snapF(c.start);
          State.cues.splice(i + 1, 0, newB);
          changed = true;
        } else if (b.end > c.start + 0.001 && b.start <= c.start + 0.001) {
          // 覆蓋到 b 的後半部 -> 裁切 b 的 end
          b.end = snapF(c.start);
          changed = true;
        } else if (b.start < c.end - 0.001 && b.end >= c.end - 0.001) {
          // 覆蓋到 b 的前半部 -> 裁切 b 的 start
          b.start = snapF(c.end);
          changed = true;
        }
      }
    }
  }
  if (changed) {
    State.selectedIds = State.selectedIds.filter(id => State.cues.find(cue => cue.id === id));
    if (!State.cues.find(cue => cue.id === State.selectedId)) State.selectedId = State.selectedIds[0] || null;
    return true;
  }
  return false;
}

function commitCueTimeEdit(c, edge){
  const tk=c.track||0;
  sweepContainedCues([c]);

  if (edge === 'start' || edge === 'both' || !edge) {
    const idx = State.cues.indexOf(c);
    if (idx !== -1) {
      let nextIdx = idx + 1;
      let offset = 0.001;
      while (nextIdx < State.cues.length) {
        const nextC = State.cues[nextIdx];
        if ((nextC.track || 0) !== tk) { nextIdx++; continue; }
        if (nextC.timed !== false) break;
        nextC.start = c.start + offset;
        nextC.end = nextC.start;
        offset += 0.001;
        nextIdx++;
      }
    }
  }

  const order=()=>State.cues.filter(x=>(x.track||0)===tk).map(x=>x.id).join(',');
  const before=order();
  sortCues();
  if(tk===State.listTrack && before===order()){
    renderSubRow(c.id);
    const ov=_detectOverlaps(State.cues.filter(x=>x.timed!==false&&(x.track||0)===tk), 0.001);
    for(const row of sublist.children){ const id=row.dataset?.id; if(id) row.classList.toggle('overlap', ov.has(id)); }
    renderCheckPanel();
    emit('render:videoSub'); emit('mpv:refreshSubs');
  } else {
    emit('render:all');
  }
  selectCue(c.id, { preventScroll: edge === 'start' });            // 內含 refreshSelectionUI → renderCueBlocks + updateTlSel
  State.activeEdge=edge;
}
function refreshSelectionUI(opts={}){
  sublist.querySelectorAll('.sub-row').forEach(r=>{
    r.classList.toggle('sel',isSel(r.dataset.id));
    r.classList.toggle('primary',r.dataset.id===State.selectedId);
  });
  const row=State.selectedId&&sublist.querySelector(`.sub-row[data-id="${State.selectedId}"]`);
  if(row && !opts.preventScroll){
    if(State.subMode){
      const allRows = Array.from(sublist.querySelectorAll('.sub-row'));
      const idx = allRows.indexOf(row);
      if (idx !== -1) {
        const targetRow = allRows[Math.max(0, idx - 4)];
        sublist.scrollTop = targetRow.offsetTop;
      }
    } else {
      row.scrollIntoView({block:'nearest'});
    }
  }
  renderCueBlocks();
  updateTlSel();
  emit('render:trackStyle'); // v4.31：面板改的是「選取中的那一句」→ 換選取就得換面板顯示的對象
}
function addCue(start,end,text,track){
  const added = ensureTrackCount((track||0)+1);
  if(added){ drawTimeline(); emit('render:listTrackSel'); }
  const c={id:newId(),start:start||0,end:end!=null?end:(start||0),text:text||'',track:track||0,timed:(start!=null&&end!=null)};
  State.cues.push(c); sortCues(); emit('render:all'); selectCue(c.id); return c;
}
function addCueRelative(dir){
  const sel=State.cues.find(c=>c.id===State.selectedId);
  if(sel && sel.timed===false){
    const c={id:newId(),start:sel.start,end:sel.end,text:'',track:sel.track||0,timed:false};
    State.cues.splice(State.cues.indexOf(sel)+(dir>0?1:0),0,c);
    emit('render:all'); selectCue(c.id); recordHistory('新增空白字幕');
    requestAnimationFrame(()=>{const r=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));});
    return c;
  }
  const tk=sel?(sel.track||0):0;
  let start,end;
  if(sel){ if(dir>0){ start=sel.end; end=snapTimeToFrame(sel.end+2, State.fps, State.dropFrame); } else { end=sel.start; start=Math.max(0,snapTimeToFrame(sel.start-2, State.fps, State.dropFrame)); } }
  else { start=snapTimeToFrame(Media.displayTime(), State.fps, State.dropFrame); end=snapTimeToFrame(start+2, State.fps, State.dropFrame); }
  const c=addCue(start,end,'',tk); recordHistory(dir>0?'下方新增字幕':'上方新增字幕');
  requestAnimationFrame(()=>{const r=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);if(r)r.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));});
  return c;
}
function _doDeleteCues(ids){
  const idxs=ids.map(id=>State.cues.findIndex(c=>c.id===id)).filter(i=>i>=0);
  const firstIdx=idxs.length?Math.min(...idxs):0;
  State.cues=State.cues.filter(c=>!ids.includes(c.id));
  State.selectedId=State.cues[Math.min(firstIdx,State.cues.length-1)]?.id||null;
  State.selectedIds=State.selectedId?[State.selectedId]:[]; State.activeEdge='start';
  emit('render:all'); updateTlSel(); recordHistory('刪除字幕');
}
function deleteSelected(){
  const ids=State.selectedIds.length?State.selectedIds.slice():[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  // 比照備註多選刪除（notes.js）：>1 條先 openModal 確認，避免 Ctrl+A 後誤觸 Del 清空整軌
  if(ids.length>1){
    openModal(`刪除 ${ids.length} 條字幕`,
      `<p>確定要刪除選取的 <b>${ids.length}</b> 條字幕嗎？</p>`,
      [{label:'取消',act:closeModal},
       {label:'確定刪除',primary:true,act:()=>{ closeModal(); _doDeleteCues(ids); }}]);
    return;
  }
  _doDeleteCues(ids);
}
function deleteCue(id){ if(id){State.selectedIds=[id];State.selectedId=id;} deleteSelected(); }

function clearSelectedCuesTime() {
  const ids=State.selectedIds.length?State.selectedIds.slice():[State.selectedId].filter(Boolean);
  if(!ids.length)return;
  let changed = false;
  ids.forEach(id => {
    const c = State.cues.find(x => x.id === id);
    if (c && c.timed !== false) {
      c.timed = false;
      changed = true;
    }
  });
  if (changed) {
    emit('render:all');
    recordHistory('清除字幕時間點');
  }
}

function shiftTextsDown(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i<=0||!(list[i-1].text||'').trim())return;
  let start=i-1;
  while(start>0&&(list[start-1].text||'').trim())start--;
  for(let j=i;j>start;j--)list[j].text=list[j-1].text;
  list[start].text='';
  emit('render:all'); recordHistory('上方字幕文字往下移動');
}

function shiftTextsUp(id){
  const c=State.cues.find(x=>x.id===id); if(!c||(c.text||'').trim())return;
  const tk=c.track||0;
  const list=State.cues.filter(x=>(x.track||0)===tk);
  const i=list.findIndex(x=>x.id===id); if(i>=list.length-1||!(list[i+1].text||'').trim())return;
  let end=i+1;
  while(end<list.length-1&&(list[end+1].text||'').trim())end++;
  for(let j=i;j<end;j++)list[j].text=list[j+1].text;
  list[end].text='';
  emit('render:all'); recordHistory('下方字幕文字往上移動');
}

function sortCues() {
  if (State.subMode) return;

  const trackTime = {};
  const anchorIdx = {};

  const mapped = State.cues.map((c, i) => {
    const tk = c.track || 0;
    if (c.timed !== false) {
      trackTime[tk] = c.start;
      anchorIdx[tk] = i; // Group anchored by this timed cue
    }
    const effectiveTime = trackTime[tk] !== undefined ? trackTime[tk] : -Infinity;
    const anchor = anchorIdx[tk] !== undefined ? anchorIdx[tk] : -1;
    return { c, i, effectiveTime, anchor };
  });

  mapped.sort((a, b) => {
    if (a.effectiveTime !== b.effectiveTime) {
      return a.effectiveTime - b.effectiveTime;
    }
    // Same effective time.
    // If they belong to different anchors (e.g. two timed cues with same start time)
    if (a.anchor !== b.anchor) {
      const anchorCueA = a.anchor === -1 ? null : State.cues[a.anchor];
      const anchorCueB = b.anchor === -1 ? null : State.cues[b.anchor];
      if (anchorCueA && anchorCueB && anchorCueA.start === anchorCueB.start) {
          return anchorCueA.id < anchorCueB.id ? -1 : 1;
      }
      return a.anchor - b.anchor;
    }
    // Same anchor group (e.g. a timed cue and its following untimed cues)
    // Preserve their original relative order
    return a.i - b.i;
  });

  for (let i = 0; i < mapped.length; i++) {
    State.cues[i] = mapped[i].c;
  }
}

/* ===== 複製 / 貼上 ===================================================== */
function copyCues(){
  const ids=State.selectedIds.length?State.selectedIds:[State.selectedId].filter(Boolean);
  if(!ids.length){ showToast('沒有選取的字幕'); return; }
  State.clipboard=State.cues.filter(c=>ids.includes(c.id)).map(c=>({...c}));
  showToast(`已複製 ${State.clipboard.length} 條字幕`);
}
function pasteCues(){
  if(!State.clipboard?.length){ showToast('剪貼簿是空的'); return; }
  const timedClip=State.clipboard.filter(c=>c.timed!==false);
  const minStart=timedClip.length ? Math.min(...timedClip.map(c=>c.start)) : 0;
  const delta=Media.displayTime()-minStart;
  const newCues=State.clipboard.map(c=>{
    if(c.timed===false) return {...c, id:newId(), track:State.listTrack};
    const s=Math.max(0, c.start+delta);
    return {...c, id:newId(), track:State.listTrack, start:s, end:Math.max(s+0.001, c.end+delta)};
  });
  State.cues.push(...newCues);
  sortCues();
  State.selectedIds=newCues.map(c=>c.id);
  State.selectedId=newCues[0].id;
  emit('render:all'); refreshSelectionUI(); recordHistory('貼上字幕');
  showToast(`已貼上 ${newCues.length} 條字幕`);
}

/* ===== 搜尋 / 取代 ===================================================== */
function searchUpdate(){
  const inp=$('searchInput');
  const raw=inp?inp.value:'';
  if(!raw){ _searchTerms=[]; _searchMatches=[]; _searchIdx=-1; updateSearchCount(); renderSubList(); return; }
  _searchTerms=raw.split('||').filter(s=>s.length>0);
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  _searchMatches=list.filter(c=>{
    const text=(c.text||'').toLowerCase();
    return _searchTerms.some(t=>text.includes(t.toLowerCase()));
  }).map(c=>c.id);
  _searchIdx=_searchMatches.length?0:-1;
  renderSubList();
  if(_searchIdx>=0) selectCue(_searchMatches[_searchIdx],{seek:false});
  updateSearchCount();
}

function searchNav(dir){
  if(!_searchMatches.length) return;
  _searchIdx=(_searchIdx+dir+_searchMatches.length)%_searchMatches.length;
  selectCue(_searchMatches[_searchIdx],{seek:true});
  updateSearchCount();
}

function searchReplace(all){
  const ri=$('replaceInput'); const repText=ri?ri.value:'';
  if(!_searchTerms.length) return;
  const cues=all
    ? State.cues.filter(c=>(c.track||0)===State.listTrack)
    : (_searchIdx>=0?[State.cues.find(c=>c.id===_searchMatches[_searchIdx])].filter(Boolean):[]);
  let count=0;
  for(const c of cues){
    if(!c) continue;
    const orig=c.text||'';
    let text=orig;
    for(const term of _searchTerms){
      const re=new RegExp(escRe(term),'gi');
      text=text.replace(re,repText);
    }
    if(text!==orig){ c.text=text; count++; }
  }
  if(count){ recordHistory(all?'全部取代':'取代字幕'); searchUpdate(); emit('render:all'); }
}

function updateSearchCount(){
  const el=$('searchCount'); if(!el) return;
  if(!_searchTerms.length){ el.textContent=''; return; }
  el.textContent=_searchMatches.length?`${_searchIdx+1}/${_searchMatches.length}`:'無結果';
}
function searchSelectAll(){
  if(!_searchMatches.length) return;
  State.selectedIds=_searchMatches.slice();
  State.selectedId=_searchMatches[_searchMatches.length-1];
  State.activeEdge='start';
  refreshSelectionUI();
  const el=$('stSel'); if(el) el.textContent='已選 '+State.selectedIds.length+' 條';
}

/* ===== 拆分字幕（Ctrl+Enter） ==================================================
   在 contenteditable txt 的游標處拆成兩句：
   上句 in=原in / out=當下播放點；下句 in=當下播放點 / out=原out */
function splitCueAtCursor(c, txtEl){
  const sel=window.getSelection();
  if(!sel.rangeCount)return;

  // 用插入標記字元的方式取得游標在 innerText 中的位置（正確處理 <br>/<div> 換行）
  const range=sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const MARK='\x01';
  const markerNode=document.createTextNode(MARK);
  range.insertNode(markerNode);

  let raw=txtEl.innerText;
  markerNode.parentNode.removeChild(markerNode);

  let markerPos=raw.indexOf(MARK);
  if(markerPos<0) markerPos=raw.length;

  // 去掉 contenteditable 常附加的尾部 \n
  let full=raw.replace(MARK,'');
  if(full.endsWith('\n')&&!(c.text||'').endsWith('\n')){
    full=full.slice(0,-1);
    if(markerPos>full.length) markerPos=full.length;
  }

  const textBefore=full.slice(0,markerPos);
  const textAfter=full.slice(markerPos);
  if (!textBefore.trim() || !textAfter.trim()) {
    showToast('不能在句首或句尾切分，以免產生空白字幕');
    return;
  }

  const origEnd=c.end;
  const isTimed=c.timed!==false;
  if(isTimed){
    const pt=Media.displayTime();
    if(pt < c.start + 0.05 || pt > c.end - 0.05){
      // 清理 DOM 標記後顯示提示，不執行拆分
      showToast('切分點距離起訖太近，或是超出了字幕範圍');
      return;
    }
  }
  let splitTime=0;
  if(isTimed) splitTime=Media.displayTime();

  // 先關閉編輯模式（blur 事件觸發時 contentEditable 已為 false，守衛返回）
  c.text=textBefore;
  txtEl.contentEditable='false';

  if(isTimed) c.end=splitTime;

  const newCue={id:newId(),start:isTimed?splitTime:0,end:isTimed?origEnd:0,
    text:textAfter,track:c.track||0,timed:isTimed};

  const idx=State.cues.indexOf(c);
  if(idx>=0) State.cues.splice(idx+1,0,newCue);
  else State.cues.push(newCue);

  sortCues(); emit('render:all'); recordHistory('拆分字幕');
  selectCue(newCue.id,{seek:false});

  // 自動進入下句的內嵌編輯，游標置於開頭（Fix #16：RAF 取代 30ms 魔術數字）
  requestAnimationFrame(()=>{
    const nr=sublist.querySelector(`.sub-row[data-id="${newCue.id}"]`);
    if(!nr)return;
    const nt=nr.querySelector('.txt');
    if(!nt)return;
    nt.innerText=textAfter;
    nt.contentEditable='true';
    nt.focus();
    try{
      const r=document.createRange(),s=window.getSelection();
      r.setStart(nt,0); r.collapse(true);
      s.removeAllRanges(); s.addRange(r);
    }catch(_){}
  },30);
}

/* ===== 統一的事件代理 (Event Delegation) ================================= */
sublist.addEventListener('click', async e => {
  // Only handle clicks not related to tin/tout which are now dblclick
});

sublist.addEventListener('mousedown', e => {
  if (e.button === 2) return;
  const row = e.target.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;

  if (_swapSource !== null) {
    e.preventDefault();
    if (c.id !== _swapSource) {
      const src = State.cues.find(x => x.id === _swapSource);
      if (src) { const tmp = src.text || ''; src.text = c.text || ''; c.text = tmp; emit('render:all'); recordHistory('文字交換'); }
    }
    cancelSwapMode(); return;
  }
  const txtEl = row.querySelector('.txt');
  if (txtEl && txtEl.contentEditable === 'true' && (e.target === txtEl || txtEl.contains(e.target))) return;
  if (document.activeElement === txtEl) txtEl.blur();
  const _noMod = !(e.ctrlKey || e.metaKey || e.shiftKey);
  const _alreadySel = _noMod && State.selectedId === c.id && State.selectedIds.length === 1;
  const _pt = Media.displayTime();
  const _ptInside = _alreadySel && c.timed !== false && _pt >= c.start && _pt <= c.end;
  selectCue(c.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey, seek: _noMod && !_ptInside });
});

sublist.addEventListener('dblclick', async e => {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  const tin = e.target.closest('.tin');
  const tout = e.target.closest('.tout');
  if (tin || tout) {
    e.stopPropagation();
    const row = e.target.closest('.sub-row');
    if (!row) return;
    const c = State.cues.find(x => x.id === row.dataset.id);
    if (!c) return;
    await ensureProjectSaved();
    if (tin) {
      openInlineTimeEdit(tin, c.start || 0, t => {
        c.start = Math.max(0, t);
        if (c.timed === false) {
          c.end = c.start + 1.0;
          c.timed = true;
        } else {
          c.start = Math.min(c.start, c.end - 0.001);
        }
        commitCueTimeEdit(c, 'start'); recordHistory('修改起點' + cueSuffix(c));
      });
    } else {
      openInlineTimeEdit(tout, c.end || 0, t => {
        c.end = Math.max((c.start || 0) + 0.001, t);
        let edge = 'end';
        if (c.timed === false) {
          c.start = Math.max(0, c.end - 1.0);
          c.timed = true;
          edge = 'both';
        }
        commitCueTimeEdit(c, edge); recordHistory('修改終點' + cueSuffix(c));
      });
    }
    return;
  }
  const row = e.target.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;
  e.preventDefault();
  await ensureProjectSaved();
  const t = row.querySelector('.txt');
  t.dataset.orig = c.text || '';
  t.innerHTML = escapeHTML(c.text || '').replace(/\n/g, '<br>');
  t.contentEditable = 'true'; t.focus();
  try { const r = document.createRange(), s = window.getSelection(); r.selectNodeContents(t); r.collapse(false); s.removeAllRanges(); s.addRange(r); } catch (_) {}
});

sublist.addEventListener('contextmenu', e => {
  const row = e.target.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;

  const txtEl = e.target.closest('.txt');
  if (txtEl && txtEl.contentEditable === 'true') {
    e.stopPropagation();
    return;
  }

  e.preventDefault();
  if (!isSel(c.id)) selectCue(c.id);
  else { State.selectedId = c.id; refreshSelectionUI(); }
  showCueMenu(e.clientX, e.clientY);
});

// P6：打字時把「重算類」工作（時間軸區塊全軌 filter+sort+重疊重算、檢查面板 7 趟全軌掃描）
// 防抖合併，避免每個字元都全軌重算；該列文字回顯與影片字幕維持即時。
let _heavyEditT = null;
function _debouncedHeavyEdit() {
  clearTimeout(_heavyEditT);
  _heavyEditT = setTimeout(() => { renderCueBlocks(); renderCheckPanel(); }, 120);
}
sublist.addEventListener('input', e => {
  const txt = e.target.closest('.txt');
  if (!txt) return;

  const row = txt.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;

  let val = txt.innerText;
  if(val.endsWith('\n') && !(txt.dataset.orig||'').endsWith('\n')) val = val.slice(0, -1);
  c.text = val;
  const rc2 = _rowClass(c);
  row.classList.remove('no-time', 'blank', 'two-line', 'multi-line'); 
  if (rc2) rc2.split(' ').filter(Boolean).forEach(cls => row.classList.add(cls));
  emit('render:videoSub'); emit('mpv:refreshSubs'); // 即時
  _debouncedHeavyEdit();                            // 防抖：時間軸區塊 + 檢查面板
});

sublist.addEventListener('focusout', e => {
  const txt = e.target.closest('.txt');
  if (!txt || txt.contentEditable !== 'true') return;
  const row = txt.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;
  // 與 input 事件相同的守衛：contenteditable 尾端 <br> 會讓 innerText 多出結尾 \n
  let val = txt.innerText;
  if(val.endsWith('\n') && !(txt.dataset.orig||'').endsWith('\n')) val = val.slice(0, -1);
  c.text = val;
  txt.contentEditable = 'false';
  txt.innerHTML = _txtInner(c.text);
  const rc2 = _rowClass(c);
  row.classList.remove('no-time', 'blank', 'two-line', 'multi-line'); 
  if (rc2) rc2.split(' ').filter(Boolean).forEach(cls => row.classList.add(cls));
  const orig = txt.dataset.orig || '';
  if ((c.text || '') !== orig) recordHistory('編輯字幕文字' + cueSuffix(c));
  renderCheckPanel();
});

function trimTrackSpaces() {
  let changed = 0;
  State.cues.forEach(c => {
    if ((c.track || 0) === State.listTrack) {
      const orig = c.text || '';
      const trimmed = orig.replace(/^[ 　]+|[ 　]+$/gm, '');
      if (orig !== trimmed) {
        c.text = trimmed;
        changed++;
      }
    }
  });
  if (changed) {
    emit('render:all');
    emit('render:videoSub');
    recordHistory(`Trim頭尾空白 (${changed}條)`);
    if ($('checkPanel') && $('checkPanel').classList.contains('show')) renderCheckPanel();
  } else {
    showToast('目前軌道沒有需要 Trim 的空白');
  }
}

sublist.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); return; }
  const txt = e.target.closest('.txt');
  if (!txt || txt.contentEditable !== 'true') return;
  const row = txt.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;

  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); splitCueAtCursor(c, txt); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); txt.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); txt.innerText = txt.dataset.orig || ''; txt.blur(); }
  e.stopPropagation();
});

export { renderSubList, renderCheckPanel, renderSubRow, selectCue, selectCueSingle, commitCueTimeEdit, refreshSelectionUI, updateTlSel,
  addCue, addCueRelative, deleteSelected, deleteCue, clearSelectedCuesTime, sortCues, shiftTextsDown, shiftTextsUp,
  enterSwapMode, cancelSwapMode, swapAdjacentCues, mergeAdjacentCues, trimTrackSpaces,
  searchUpdate, searchNav, searchReplace, searchSelectAll, openInlineTimeEdit,
  copyCues, pasteCues };

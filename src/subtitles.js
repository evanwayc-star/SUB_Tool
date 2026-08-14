import { $, sublist } from './dom.js';
import { State, isSel, newId, trackVisible, cueSuffix, setSelection, deselect, pruneSelection } from './state.js';
import { escapeHTML, tcKeyAllowed, escapeHTMLWithSpaces } from './util.js';
import { inspectSubtitleCharacters } from './subtitle-text-check.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { Media } from './media.js';
import { renderCueBlocks, drawTimeline, updatePlayhead, refreshTrackGutterActive } from './timeline.js';
import { emit } from './events.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { ensureProjectSaved } from './project.js';
import { showToast, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { effStyle, getAllPresets, STYLE_DEFAULTS, colorName, posToPx, styleMatchesPreset } from './substyle.js';
import { showCueMenu } from './menus.js';
import { deleteSelectedWithPrompt } from './subtitle-view.js';
import { analyzeSubtitles } from './subtitle-analyzer.js';

// Domain imports
import { 
  snapAllCuesToFrames, swapAdjacentCues, mergeAdjacentCues, detectOverlaps, sweepContainedCues,
  addCue as _addCue, addCueRelative as _addCueRelative, deleteSelectedCues, deleteCue, clearSelectedCuesTime, 
  shiftTextsDown, shiftTextsUp, sortCues, copyCues, pasteCues as _pasteCues, trimTrackSpaces,
  trackLocked, cueTrackLocked 
} from './subtitle-model.js';

// Search imports
import { searchSelectAll, txtHTML, isSearchHit, getSearchCountText, searchUpdate as _searchUpdate, searchNav as _searchNav, searchReplace as _searchReplace } from './subtitle-search.js';

const _presetNameCache = new Map();
const _customCodeMap = new Map();
let _customCodeCounter = 1;
let _selectionRevealSeq = 0;

function clearPresetNameCache(){ 
  _presetNameCache.clear(); 
  const activeKeys = new Set();
  const keys = Object.keys(STYLE_DEFAULTS);
  const presets = getAllPresets();
  for (const c of State.cues) {
    if (c.style && Object.keys(c.style).length > 0) {
      const st = effStyle(c, State.tracks[c.track || 0] || null);
      let name = '';
      for (const p of presets) {
        if (styleMatchesPreset(st, p)) { name = p.name; break; }
      }
      if (!name) {
        let key = '';
        for (const k of keys) key += st[k] + '|';
        activeKeys.add(key);
      }
    }
  }
  for (const oldKey of _customCodeMap.keys()) {
    if (!activeKeys.has(oldKey)) _customCodeMap.delete(oldKey);
  }
  const usedNumbers = new Set();
  for (const code of _customCodeMap.values()) {
    const m = code.match(/自訂-(\d+)/);
    if (m) usedNumbers.add(parseInt(m[1], 10));
  }
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
  let key = '';
  const keys = Object.keys(STYLE_DEFAULTS);
  for(const k of keys) key += st[k] + '|';
  if(_presetNameCache.has(key)) return _presetNameCache.get(key);
  let name = '';
  for(const p of getAllPresets()){
    if(styleMatchesPreset(st, p)){ name = p.name; break; }
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
    if (isOv) return `<span class="${cls}" title="此句有逐句樣式覆蓋，等同常用樣式：${escapeHTML(n)}">✱ ${escapeHTML(n)}</span>`;
    return `<span class="${cls}" title="常用樣式：${escapeHTML(n)}">${escapeHTML(n)}</span>`;
  } else {
    if (isOv) {
      const code = _getCustomCodeForStyle(st);
      return `<span class="nm ov-custom" title="此句有逐句樣式覆蓋">✱ ${code}</span>`;
    }
    return '';
  }
}

function inkOn(hex){
  const h=String(hex||'').replace('#','');
  const r=parseInt(h.slice(0,2),16)||0, g=parseInt(h.slice(2,4),16)||0, b=parseInt(h.slice(4,6),16)||0;
  return (0.299*r + 0.587*g + 0.114*b) > 140 ? '#111' : '#fff';
}

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

let _swapSource = null;
let _checkLenLimit = 0;
let _checkContains = [];

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
      if(raw === origText){
        inp.remove(); el.textContent = origText; return;
      }
      if(raw === '--:--:--:--' || raw === ''){
        inp.remove(); onCommit(null); return;
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
      if(t !== null){ onCommit(t); return; }
    }
    inp.remove(); el.textContent = origText;
  };
  inp.addEventListener('keydown', e=>{ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); fin(true); }
    else if(e.key==='Escape'){ e.preventDefault(); fin(false); }
    else if(!tcKeyAllowed(e)) e.preventDefault();
  });
  inp.addEventListener('blur', ()=>fin(true));
  inp.addEventListener('mousedown', e=>e.stopPropagation());
}

function updateTlSel(){
  // Synchronized via MutationObserver in app.js
}

function renderCheckPanel(){
  const panel=$('checkPanel'); if(!panel||!panel.classList.contains('show'))return;
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  const lenEl=$('cpLenInput');
  _checkLenLimit = lenEl ? (parseInt(lenEl.value)||0) : 0;
  const containsRaw=($('cpContainsInput')||{}).value||'';
  _checkContains=containsRaw.split('||').map(s=>s.trim()===''?s:s.replace(/^[ ]+|[ ]+$/g,'')).filter(s=>s.length>0);

  const report = analyzeSubtitles(list, { checkLenLimit: _checkLenLimit, checkContains: _checkContains, fps: State.fps });
  const { overlapNums, multiNums, twoNums, blankNums, bNums, iNums, uNums, fontNums, posNums, trimNums, overLenNums, containsNums, nonTraditionalIssues, noTimeNums, consecutiveIdenticalNums, consecutiveIdenticalJoinedNums=[] } = report;
  
  const mkNums=nums=>nums.length?nums.map(n=>`<span class="cp-num" data-idx="${n}">${n}</span>`).join(', '):'N/A';
  const joinedIdenticalSet=new Set(consecutiveIdenticalJoinedNums);
  const mkConsecutiveIdenticalNums=nums=>nums.length?nums.map(n=>`<span class="cp-num${joinedIdenticalSet.has(n)?' cp-joined-identical':''}" data-idx="${n}">${n}</span>`).join(', '):'N/A';
  const mkCharacterIssueNums=issues=>issues.length?issues.map(({num,simplified,unsupported})=>{
    const detail=[];
    if(simplified.length) detail.push('常見簡體：'+simplified.join('、'));
    if(unsupported.length) detail.push('非允許字元：'+unsupported.map(ch=>/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u.test(ch)?`U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}`:ch).join('、'));
    return `<span class="cp-num" data-idx="${num}" title="${escapeHTML(detail.join('；'))}">${num}</span>`;
  }).join(', '):'N/A';
  const ro=$('cpOverlap'),rm=$('cpMulti'),r2=$('cpTwo'),rb=$('cpBlank'),rl=$('cpOverLen'),rc=$('cpContains'),rnt=$('cpNonTraditional'),rt=$('cpTrim'),rn=$('cpNoTime'),rci=$('cpConsecutiveIdentical');
  const sb=$('cpSrtB'),si=$('cpSrtI'),su=$('cpSrtU'),sf=$('cpSrtFont'),sp=$('cpSrtPos');
  if(rn)rn.querySelector('.cp-nums').innerHTML=mkNums(noTimeNums);
  if(ro)ro.querySelector('.cp-nums').innerHTML=mkNums(overlapNums);
  if(rm)rm.querySelector('.cp-nums').innerHTML=mkNums(multiNums);
  if(rt)rt.querySelector('.cp-nums').innerHTML=mkNums(trimNums);
  if(r2)r2.querySelector('.cp-nums').innerHTML=mkNums(twoNums);
  if(rb)rb.querySelector('.cp-nums').innerHTML=mkNums(blankNums);
  if(rci)rci.querySelector('.cp-nums').innerHTML=mkConsecutiveIdenticalNums(consecutiveIdenticalNums);
  if(sb)sb.querySelector('.cp-nums').innerHTML=mkNums(bNums);
  if(si)si.querySelector('.cp-nums').innerHTML=mkNums(iNums);
  if(su)su.querySelector('.cp-nums').innerHTML=mkNums(uNums);
  if(sf)sf.querySelector('.cp-nums').innerHTML=mkNums(fontNums);
  if(sp)sp.querySelector('.cp-nums').innerHTML=mkNums(posNums);
  if(rl)rl.querySelector('.cp-nums').innerHTML=_checkLenLimit?mkNums(overLenNums):'—';
  if(rc)rc.querySelector('.cp-nums').innerHTML=_checkContains.length?mkNums(containsNums):'—';
  if(rnt)rnt.querySelector('.cp-nums').innerHTML=mkCharacterIssueNums(nonTraditionalIssues);
  panel.querySelectorAll('.cp-num').forEach(el=>{
    el.onclick=()=>{
      const idx=parseInt(el.dataset.idx)-1; const c=list[idx]; if(!c)return;
      selectCue(c.id,{seek:true});
      const row=sublist.querySelector(`.sub-row[data-id="${c.id}"]`);
      if(row)row.scrollIntoView({block:'center'});
    };
  });
}

let _styleSumT = null;
function refreshStyleSummaries(){
  clearTimeout(_styleSumT);
  _styleSumT = setTimeout(() => {
    clearPresetNameCache();

    const filterEl = $('subStyleFilter');
    if (filterEl) {
      const allList = State.cues.filter(c=>(c.track||0)===State.listTrack);
      const oldVal = filterEl.value;
      const newVal = updateStyleFilterOptions(allList);
      if (oldVal !== newVal) {
        renderSubList();
        return;
      }
    }

    const rows=sublist.querySelectorAll('.sub-row'); if(!rows.length)return;
    const byId=new Map(State.cues.map(c=>[c.id,c]));
    for(const row of rows){
      const c=byId.get(row.dataset.id); if(!c)continue;
      const sty=row.querySelector('.sub-sty'); if(sty)sty.innerHTML=styleSummaryHtml(c);
      const nm=row.querySelector('.sub-styname'); if(nm)nm.innerHTML=styleNameHtml(c);
    }
  }, 200);
}

function updateStyleFilterOptions(allList) {
  const filterEl = $('subStyleFilter');
  if (!filterEl) return '';
  
  const usedStyles = new Set();
  for (const c of allList) {
    const isOv = c.style && Object.keys(c.style).length > 0;
    const st = effStyle(c, State.tracks[c.track || 0] || null);
    const n = _getPresetNameForStyle(st);
    if (n) {
      usedStyles.add(isOv ? `✱ ${n}` : n);
    } else if (isOv) {
      usedStyles.add(`✱ 自訂`);
    }
  }
  
  const curVal = filterEl.value;
  let html = `<option value="">所有樣式</option><option value="__non_default">非預設樣式</option>`;
  const sorted = Array.from(usedStyles).sort();
  for (const s of sorted) {
    html += `<option value="${escapeHTML(s)}">${escapeHTML(s)}</option>`;
  }
  filterEl.innerHTML = html;
  filterEl.style.display = 'inline-block';
  
  if (curVal === '__non_default' || usedStyles.has(curVal)) {
    filterEl.value = curVal;
  } else {
    filterEl.value = '';
  }
  return filterEl.value;
}

function renderSubList(){
  sublist.innerHTML='';
  clearPresetNameCache();
  
  const filterEl = $('subStyleFilter');
  const allList = State.cues.filter(c=>(c.track||0)===State.listTrack);
  
  if (filterEl) {
    updateStyleFilterOptions(allList);
  }

  const activeFilter = filterEl ? filterEl.value : '';
  let list = allList;
  if (activeFilter) {
    list = allList.filter(c => {
      const isOv = c.style && Object.keys(c.style).length > 0;
      const st = effStyle(c, State.tracks[c.track || 0] || null);
      const n = _getPresetNameForStyle(st);
      
      if (activeFilter === '__non_default') {
        return n !== '預設' || isOv;
      }
      
      const label = n ? (isOv ? `✱ ${n}` : n) : `✱ 自訂`;
      return label === activeFilter;
    });
  }

  if(list.length===0){
    sublist.innerHTML='<div class="empty">'+(State.cues.length?'此軌道沒有符合篩選條件的字幕':'尚無字幕<br><br>· 匯入字幕檔，或<br>· 選一條字幕後按 <b>I</b>/<b>O</b> 設定起訖<br>· 或點 <b>⬆＋ / ⬇＋</b> 新增')+'</div>';
    $('subCount').textContent=list.length+' 句' + (allList.length !== list.length ? ` / ${allList.length} 句` : '');
    return;
  }
  $('subCount').textContent=list.length+' 句' + (allList.length !== list.length ? ` / ${allList.length} 句` : '');
  const timed=State.cues.filter(c=>c.timed!==false&&(c.track||0)===State.listTrack);
  const overlaps=detectOverlaps(timed, 0.001);
  let html='';
  for(let i=0;i<list.length;i++) html+=_subRowHTML(list[i],allList.indexOf(list[i]),overlaps);
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
  if(!_checkLenLimit||line.length<=_checkLenLimit) return escapeHTMLWithSpaces(line);
  return escapeHTMLWithSpaces(line.slice(0,_checkLenLimit))+`<span class="over-len">${escapeHTMLWithSpaces(line.slice(_checkLenLimit))}</span>`;
}

function _txtInner(text){
  if(!(text||'').trim()) return '<span class="blank-label">(空白字幕)</span>';
  if(!_checkLenLimit) return txtHTML(text||'').replace(/\n/g, '<br>');
  return (text||'').split(/\n/).map(_lineLenHTML).join('<br>');
}

function _subRowHTML(c,i,overlaps){
  const rc=_rowClass(c);
  const containsHit=_checkContains.length&&_checkContains.some(kw=>(c.text||'').toLowerCase().includes(kw.toLowerCase()));
  const cls='sub-row'+(rc?' '+rc:'')+(isSearchHit(c.id)?' search-hit':'')+(isSel(c.id)?' sel':'')+(c.id===State.selectedId?' primary':'')+(c.id===State.activeId?' active':'')+(overlaps?.has(c.id)?' overlap':'')+(containsHit?' contains-match':'');
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

  let picked, primary;
  if(opts.additive){
    picked=[...State.selectedIds];
    const i=picked.indexOf(id);
    if(i>=0)picked.splice(i,1); else picked.push(id);
    primary=picked[picked.length-1]??null;
  }else if(opts.range && State.selectedId){
    const ids=State.cues.map(c=>c.id);
    const a=ids.indexOf(State.selectedId), b=ids.indexOf(id);
    picked = (a>=0&&b>=0) ? ids.slice(Math.min(a,b),Math.max(a,b)+1) : [...State.selectedIds];
    primary=State.selectedId; 
  }else{ picked=[id]; primary=id; }
  
  setSelection({ kind:'sub', ids:picked, primary });
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
  $('stSel').textContent=State.selectedIds.length?('已選 '+State.selectedIds.length+' 句'+(pc?(' · #'+(State.cues.indexOf(pc)+1)):'')):'';
  updatePlayhead();
}

function selectCueSingle(id,seek){ selectCue(id,{seek}); }

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
    const ov=detectOverlaps(State.cues.filter(x=>x.timed!==false&&(x.track||0)===tk), 0.001);
    for(const row of sublist.children){ const id=row.dataset?.id; if(id) row.classList.toggle('overlap', ov.has(id)); }
    renderCheckPanel();
    emit('render:videoSub'); emit('mpv:refreshSubs');
  } else {
    emit('render:all');
  }
  selectCue(c.id, { preventScroll: edge === 'start' });
  State.activeEdge=edge;
}

function refreshSelectionUI(opts={}){
  const revealSeq=++_selectionRevealSeq;
  sublist.querySelectorAll('.sub-row').forEach(r=>{
    r.classList.toggle('sel',isSel(r.dataset.id));
    r.classList.toggle('primary',r.dataset.id===State.selectedId);
  });
  const row=State.selectedId&&sublist.querySelector(`.sub-row[data-id="${State.selectedId}"]`);
  if(row && !opts.preventScroll){
    const selectedId=State.selectedId;
    const reveal=()=>{
      if(_selectionRevealSeq!==revealSeq||State.selectedId!==selectedId)return;
      const currentRow=sublist.querySelector(`.sub-row[data-id="${selectedId}"]`);
      if(!currentRow)return;
      if(State.subMode){
        const allRows = Array.from(sublist.querySelectorAll('.sub-row'));
        const idx = allRows.indexOf(currentRow);
        if (idx !== -1) {
          const targetRow = allRows[Math.max(0, idx - 4)];
          sublist.scrollTop = targetRow.offsetTop;
        }
      } else {
        currentRow.scrollIntoView({block:'nearest'});
      }
    };
    reveal();
    // 列表使用 content-visibility:auto；剛跨軌重建時，離屏列的第一輪
    // scrollIntoView 可能只依 contain-intrinsic-size 估算。下一幀實際列高完成後
    // 再揭示一次，否則大型列表會先短暫捲到目標，隨即讓該列掉出 viewport。
    requestAnimationFrame(reveal);
  }
  renderCueBlocks();
  updateTlSel();
  emit('render:trackStyle'); 
}

function splitCueAtCursor(c, txtEl){
  const sel=window.getSelection();
  if(!sel.rangeCount)return;

  const range=sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const MARK='\x01';
  const markerNode=document.createTextNode(MARK);
  range.insertNode(markerNode);

  let raw=txtEl.innerText;
  markerNode.parentNode.removeChild(markerNode);

  let markerPos=raw.indexOf(MARK);
  if(markerPos<0) markerPos=raw.length;

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
      showToast('切分點距離起訖太近，或是超出了字幕範圍');
      return;
    }
  }
  let splitTime=0;
  if(isTimed) splitTime=Media.displayTime();

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

sublist.addEventListener('click', async e => {
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
        if(t === null) {
          c.timed = false;
          commitCueTimeEdit(c, 'both'); recordHistory('清除時間碼' + cueSuffix(c));
          return;
        }
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
        if(t === null) {
          c.timed = false;
          commitCueTimeEdit(c, 'both'); recordHistory('清除時間碼' + cueSuffix(c));
          return;
        }
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
  else { setSelection({ kind:'sub', ids:State.selectedIds, primary:c.id }); refreshSelectionUI(); }
  showCueMenu(e.clientX, e.clientY);
});

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
  emit('render:videoSub'); emit('mpv:refreshSubs');
  _debouncedHeavyEdit();
});

sublist.addEventListener('focusout', e => {
  const txt = e.target.closest('.txt');
  if (!txt || txt.contentEditable !== 'true') return;
  const row = txt.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;
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

sublist.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); return; }
  const txt = e.target.closest('.txt');
  if (!txt || txt.contentEditable !== 'true') return;
  const row = txt.closest('.sub-row');
  if (!row) return;
  const c = State.cues.find(x => x.id === row.dataset.id);
  if (!c) return;

  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); splitCueAtCursor(c, txt); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); txt.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); txt.innerText = txt.dataset.orig || ''; txt.blur(); }
  e.stopPropagation();
});

function searchUpdate(raw) {
  _searchUpdate(raw, selectCue);
}
function searchNav(dir) {
  _searchNav(dir, selectCue);
}
function searchReplace(all) {
  const ri=$('replaceInput'); const repText=ri?ri.value:'';
  _searchReplace(all, repText);
}
function updateSearchCount() {
  const el=$('searchCount'); if(!el) return;
  el.textContent = getSearchCountText();
}
function addCue(start, end, text, track) {
  return _addCue(start, end, text, track, selectCue);
}
function addCueRelative(dir) {
  return _addCueRelative(dir, selectCue);
}
function pasteCues() {
  _pasteCues(selectCue);
}

export { 
  renderSubList, renderCheckPanel, renderSubRow, selectCue, selectCueSingle, commitCueTimeEdit, refreshSelectionUI, updateTlSel,
  addCue, addCueRelative, deleteSelectedWithPrompt as deleteSelected, deleteCue, clearSelectedCuesTime, sortCues, shiftTextsDown, shiftTextsUp,
  enterSwapMode, cancelSwapMode, swapAdjacentCues, mergeAdjacentCues, trimTrackSpaces,
  searchUpdate, searchNav, searchReplace, updateSearchCount, searchSelectAll, openInlineTimeEdit, refreshStyleSummaries,
  copyCues, pasteCues, trackLocked, cueTrackLocked, snapAllCuesToFrames, sweepContainedCues
};

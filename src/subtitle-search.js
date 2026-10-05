import { State, setSelection } from './state.js';
import { emit, on } from './events.js';
import { recordHistory } from './history.js';
import { escapeHTML, escapeHTMLWithSpaces } from './util.js';
import { trackLocked } from './subtitle-model.js';

let _searchTerms = [];
let _searchMatches = [];
let _searchIdx = -1;
let _selectCueHandler = null;
let searchDirty = true;
let searchCues = null, searchTrack = null, searchTrackIndex = null;
// Render events are the editor mutation seam. Rebuild once per invalidation,
// never once per rendered row, and never change selection during a rebuild.
for(const event of ['render:all','render:subList','render:subRow']) on(event,()=>{searchDirty=true;if(_searchTerms.length)emit('render:searchCount');});
function refreshSearch(force=false){
  if(!force && !searchDirty && searchCues===State.cues && searchTrack===State.tracks[State.listTrack] && searchTrackIndex===State.listTrack) return;
  const previous=_searchMatches[_searchIdx];
  _searchMatches=_searchTerms.length ? State.cues.filter(c=>(c.track||0)===State.listTrack && _searchTerms.some(t=>String(c.text||'').toLowerCase().includes(t.toLowerCase()))).map(c=>c.id) : [];
  const selected=_searchMatches.indexOf(State.selectedId);
  const retained=_searchMatches.indexOf(previous);
  _searchIdx=selected>=0 ? selected : retained>=0 ? retained : _searchMatches.length ? 0 : -1;
  searchCues=State.cues;searchTrack=State.tracks[State.listTrack];searchTrackIndex=State.listTrack;searchDirty=false;
}

export function setSelectCueHandler(fn) {
  _selectCueHandler = typeof fn === 'function' ? fn : null;
}

export function getSelectCueHandler() {
  return _selectCueHandler;
}

export function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

export function txtHTML(text){
  const raw = text||'';
  if(!_searchTerms.length) return escapeHTMLWithSpaces(raw);
  const ranges=[];
  for(const term of _searchTerms){
    if(!term) continue;
    const re = new RegExp(escRe(term),'gi');
    let m; while((m=re.exec(raw))){ if(!m[0].length){ re.lastIndex++; continue; } ranges.push([m.index, m.index+m[0].length]); }
  }
  if(!ranges.length) return escapeHTMLWithSpaces(raw);
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged=[ranges[0].slice()];
  for(let i=1;i<ranges.length;i++){
    const last=merged[merged.length-1];
    if(ranges[i][0]<=last[1]) last[1]=Math.max(last[1],ranges[i][1]);
    else merged.push(ranges[i].slice());
  }
  let out='', pos=0;
  for(const [s,e] of merged){
    out+=escapeHTMLWithSpaces(raw.slice(pos,s))+`<span class="search-match">${escapeHTMLWithSpaces(raw.slice(s,e))}</span>`;
    pos=e;
  }
  return out+escapeHTMLWithSpaces(raw.slice(pos));
}

export function isSearchHit(id) {
  refreshSearch();
  return _searchMatches.includes(id);
}

export function searchUpdate(raw, selectCueCb){
  if(raw == null) raw = typeof document === 'undefined' ? '' : (document.getElementById('searchInput')?.value ?? '');
  if(!raw){ _searchTerms=[]; _searchMatches=[]; _searchIdx=-1; emit('render:searchCount'); emit('render:subList'); return; }
  _searchTerms=raw.split('||').filter(s=>s.length>0);
  refreshSearch(true);
  if(_searchMatches.length){
    if(State.selectedId && _searchMatches.includes(State.selectedId)){
      _searchIdx = _searchMatches.indexOf(State.selectedId);
    } else {
      _searchIdx = 0;
    }
  } else {
    _searchIdx = -1;
  }
  emit('render:subList');
  const cb = (typeof selectCueCb === 'function' ? selectCueCb : _selectCueHandler);
  if(_searchIdx>=0 && cb && !State.tracks[State.listTrack]?.locked) cb(_searchMatches[_searchIdx],{seek:false});
  emit('render:searchCount');
}

export function searchNav(dir, selectCueCb){
  refreshSearch(true);
  if(!_searchMatches.length) return;
  if(State.selectedId && _searchMatches.includes(State.selectedId)){
    const curIdx = _searchMatches.indexOf(State.selectedId);
    if(curIdx !== -1) {
      _searchIdx = curIdx;
    }
  }
  _searchIdx=(_searchIdx+dir+_searchMatches.length)%_searchMatches.length;
  const cb = (typeof selectCueCb === 'function' ? selectCueCb : _selectCueHandler);
  if(cb && !State.tracks[State.listTrack]?.locked) cb(_searchMatches[_searchIdx],{seek:true});
  emit('render:searchCount');
}

export function searchReplace(all, repText){
  if(!_searchTerms.length) return;
  refreshSearch(true);
  if(trackLocked(State.listTrack, '取代字幕內容')) return;
  const pattern = new RegExp(_searchTerms.map(escRe).join('|'), 'gi');
  const cues=all
    ? State.cues.filter(c=>(c.track||0)===State.listTrack)
    : (_searchIdx>=0?[State.cues.find(c=>c.id===_searchMatches[_searchIdx])].filter(Boolean):[]);
  let count=0;
  for(const c of cues){
    if(!c || (c.track||0)!==State.listTrack || trackLocked(c.track||0, '取代字幕內容')) continue;
    const orig=c.text||'';
    const text=orig.replace(pattern, () => repText);
    if(text!==orig){ c.text=text; count++; }
  }
  if(count){ 
    recordHistory(all?'全部取代':'取代字幕'); 
    searchUpdate(_searchTerms.join('||')); // This triggers emit('render:all') basically
    emit('render:all'); 
  }
}

export function getSearchCountText(){
  refreshSearch();
  if(!_searchTerms.length) return '';
  return _searchMatches.length?`${_searchIdx+1}/${_searchMatches.length}`:'無結果';
}

export function searchSelectAll(){
  refreshSearch(true);
  if(!_searchMatches.length || State.tracks[State.listTrack]?.locked) return;
  setSelection({ kind:'sub', ids:_searchMatches.slice() });
  State.activeEdge='start';
  emit('render:selection');
}

export function searchNext(selectCueCb) {
  searchNav(1, selectCueCb);
}

export function searchPrev(selectCueCb) {
  searchNav(-1, selectCueCb);
}

export function searchClear() {
  const si = (typeof document !== 'undefined') ? document.getElementById('searchInput') : null;
  if (si) si.value = '';
  searchUpdate('');
}

export function doSearchSelectAll() {
  searchSelectAll();
}

export function replaceOne() {
  const ri = (typeof document !== 'undefined') ? document.getElementById('replaceInput') : null;
  const repText = ri ? ri.value : '';
  searchReplace(false, repText);
}

export function replaceAll() {
  const ri = (typeof document !== 'undefined') ? document.getElementById('replaceInput') : null;
  const repText = ri ? ri.value : '';
  searchReplace(true, repText);
}

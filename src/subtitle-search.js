import { State, setSelection } from './state.js';
import { emit } from './events.js';
import { recordHistory } from './history.js';
import { escapeHTML, escapeHTMLWithSpaces } from './util.js';

let _searchTerms = [];
let _searchMatches = [];
let _searchIdx = -1;
let _selectCueHandler = null;

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
  return _searchMatches.includes(id);
}

export function searchUpdate(raw, selectCueCb){
  if(!raw){ _searchTerms=[]; _searchMatches=[]; _searchIdx=-1; emit('render:searchCount'); emit('render:subList'); return; }
  _searchTerms=raw.split('||').filter(s=>s.length>0);
  const list=State.cues.filter(c=>(c.track||0)===State.listTrack);
  _searchMatches=list.filter(c=>{
    const text=(c.text||'').toLowerCase();
    return _searchTerms.some(t=>text.includes(t.toLowerCase()));
  }).map(c=>c.id);
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
  if(_searchIdx>=0 && cb) cb(_searchMatches[_searchIdx],{seek:false});
  emit('render:searchCount');
}

export function searchNav(dir, selectCueCb){
  if(!_searchMatches.length) return;
  if(State.selectedId && _searchMatches.includes(State.selectedId)){
    const curIdx = _searchMatches.indexOf(State.selectedId);
    if(curIdx !== -1) {
      _searchIdx = curIdx;
    }
  }
  _searchIdx=(_searchIdx+dir+_searchMatches.length)%_searchMatches.length;
  const cb = (typeof selectCueCb === 'function' ? selectCueCb : _selectCueHandler);
  if(cb) cb(_searchMatches[_searchIdx],{seek:true});
  emit('render:searchCount');
}

export function searchReplace(all, repText){
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
  if(count){ 
    recordHistory(all?'全部取代':'取代字幕'); 
    searchUpdate(_searchTerms.join('||')); // This triggers emit('render:all') basically
    emit('render:all'); 
  }
}

export function getSearchCountText(){
  if(!_searchTerms.length) return '';
  return _searchMatches.length?`${_searchIdx+1}/${_searchMatches.length}`:'無結果';
}

export function searchSelectAll(){
  if(!_searchMatches.length) return;
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


// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,it,expect,vi} from 'vitest';
import fs from 'node:fs';
let State,Subtitles,Styles,UI;
const shown=()=>[...document.querySelectorAll('#sublist .sub-row')].map(row=>row.dataset.id);
beforeAll(async()=>{
 vi.useFakeTimers();
 const parsed=new DOMParser().parseFromString(fs.readFileSync('index.html','utf8'),'text/html');
 document.body.innerHTML=parsed.body.innerHTML;HTMLElement.prototype.scrollIntoView=vi.fn();
 HTMLMediaElement.prototype.pause=vi.fn();
 HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
 ({State}=await import('../src/state.js'));
 Subtitles=await import('../src/subtitles.js');
 Styles=await import('../src/substyle.js');
 UI=await import('../src/ui.js');
});
beforeEach(()=>{
 UI.closeModal();Styles.savePresets([]);
 Object.assign(State,{tracks:[{name:'Dialogue',visible:true,locked:false}],cues:[{id:'a',text:'A',track:0,start:0,end:1},{id:'b',text:'B',track:0,start:1,end:2}],listTrack:0,selectedId:null,selectedIds:[],presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{visible:true}],notes:[]});
 document.getElementById('subStyleFilter').value='';Subtitles.renderSubList();
});
afterAll(()=>{vi.clearAllTimers();vi.useRealTimers();});
it('全軌套用非預設樣式後，沒有逐句覆蓋也完整歸入自訂樣式',()=>{
 Subtitles.applyTrackStylePlan(State.tracks[0],State.cues,{...Styles.STYLE_DEFAULTS,fontSize:99});Subtitles.renderSubList();
 expect(State.cues.every(cue=>cue.style===undefined)).toBe(true);
 const filter=document.getElementById('subStyleFilter');
 const custom=[...filter.options].find(option=>option.textContent.includes('自訂'));
 expect(custom).toBeDefined();filter.value=custom.value;Subtitles.renderSubList();
 expect(shown()).toEqual(['a','b']);
 expect([...document.querySelectorAll('.sub-styname')].every(node=>node.textContent.includes('自訂'))).toBe(true);
});
it('生效樣式等於預設時，冗餘的逐句覆蓋不會被歸入自訂',()=>{
 State.cues[0].style={...Styles.STYLE_DEFAULTS};State.cues[1].style={fontSize:99};Subtitles.renderSubList();
 document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();expect(shown()).toEqual(['b']);
});
it('使用已命名常用樣式的整軌也屬於自訂分類',()=>{
 const desired={...Styles.STYLE_DEFAULTS,fontSize:99};Styles.savePresets([{name:'全軌自訂',style:desired}]);
 Subtitles.applyTrackStylePlan(State.tracks[0],State.cues,desired);Subtitles.renderSubList();
 document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();expect(shown()).toEqual(['a','b']);
 expect([...document.querySelectorAll('.sub-styname .custom')]).toHaveLength(2);
});
it('樣式套用保留已啟用背景的 30% 透明度，不誤當未啟用的舊預設',()=>{
 State.tracks[0].bgBox=true;State.tracks[0].bgAlpha=.5;
 Subtitles.applyCueStylePatch(State.cues[0],{bgAlpha:.3});
 expect(Styles.effStyle(State.cues[0],State.tracks[0]).bgAlpha).toBe(.3);
});
it('refreshing styles updates all membership of the currently active filter',()=>{
 State.cues[0].style={fontSize:99};Subtitles.renderSubList();
 const filter=document.getElementById('subStyleFilter');filter.value=[...filter.options].find(option=>option.textContent.includes('自訂')).value;Subtitles.renderSubList();
 expect(shown()).toEqual(['a']);State.cues[1].style={fontSize:100};
 Subtitles.refreshStyleSummaries();vi.advanceTimersByTime(201);
 expect(shown()).toEqual(['a','b']);
});
it('moving a cue out of an active custom style filter removes its stale row',()=>{
 State.cues[0].style={fontSize:99};State.cues[1].style={fontSize:100};Subtitles.renderSubList();
 const filter=document.getElementById('subStyleFilter');filter.value=[...filter.options].find(option=>option.textContent.includes('自訂')).value;Subtitles.renderSubList();
 expect(shown()).toEqual(['a','b']);delete State.cues[1].style;
 Subtitles.refreshStyleSummaries();vi.advanceTimersByTime(201);expect(shown()).toEqual(['a']);
});

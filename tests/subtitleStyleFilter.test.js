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
it('新專案的空列表引導匯入或新增，不要求先選取不存在的字幕',()=>{
 State.cues=[];State.tracks=[];Subtitles.renderSubList();
 const empty=document.querySelector('#sublist .empty').textContent;
 expect(empty).toContain('尚無字幕');expect(empty).toContain('匯入字幕檔');
 expect(empty).toContain('在播放點新增字幕');expect(empty).not.toContain('選一條字幕');
});
it('其他軌有字幕時，空軌仍顯示新增引導而非篩選無結果',()=>{
 State.tracks.push({name:'Empty',visible:true,locked:false});State.listTrack=1;Subtitles.renderSubList();
 const empty=document.querySelector('#sublist .empty').textContent;
 expect(empty).toContain('此字幕軌尚無字幕');expect(empty).toContain('在播放點新增字幕');
 expect(empty).not.toContain('符合');expect(document.getElementById('subCount').textContent).toBe('0 句');
});
it('鎖定的空軌先引導解鎖，不直接要求新增',()=>{
 State.cues=[];State.tracks[0].locked=true;Subtitles.renderSubList();
 const empty=document.querySelector('#sublist .empty').textContent;
 expect(empty).toContain('此字幕軌已鎖定');expect(empty).toContain('先在時間軸解鎖');
 expect(empty).not.toContain('⬇＋');
});
it('樣式篩選無結果時說明如何恢復此軌字幕，清除篩選後恢復列表',()=>{
 document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();
 const empty=document.querySelector('#sublist .empty').textContent;
 expect(empty).toContain('沒有符合樣式的字幕');expect(empty).toContain('所有樣式');
 expect(empty).toContain('2 句字幕');expect(document.getElementById('subCount').textContent).toBe('0 句 / 2 句');
 document.getElementById('subStyleFilter').value='';Subtitles.renderSubList();
 expect(shown()).toEqual(['a','b']);expect(document.querySelector('#sublist .empty')).toBeNull();
});
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

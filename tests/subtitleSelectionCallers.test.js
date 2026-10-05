// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd().replace(/\\/g,'/');
let State,History,Model,Subtitles,Menus,UI,Media,Project,ProjectModule,Style,Styles;
const click=label=>[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent===label).click();
const clip=(id,values={})=>({id,name:id,path:'C:/'+id+'.mp4',in:0,out:4,dur:4,offset:0,vtrack:0,...values});
async function timeline(){
  const Timeline=await import('../src/timeline-renderer.js');
  const layer=document.getElementById('tlLayer'),scroll=document.getElementById('tlScroll');
  for(const element of [layer,scroll]){
    element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
    Object.defineProperty(element,'clientWidth',{configurable:true,value:640});Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
  }
  State.pxPerSec=80;State.viewStart=0;State.vtracksCollapsed=false;Timeline.drawTimeline();
  return Timeline;
}
const mouse=(target,type,x=80,y=100,modifiers={})=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y,...modifiers}));

beforeAll(async()=>{
  vi.useFakeTimers();
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();
  HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import('../src/state.js'));
  ({History}=await import('../src/history.js'));
  Model=await import('../src/subtitle-model.js');
  Subtitles=await import('../src/subtitles.js');
  Menus=await import('../src/menus.js');
  UI=await import('../src/ui.js');
  ({Media}=await import('../src/media.js'));
  ProjectModule=await import('../src/project.js');({Project}=ProjectModule);
  Styles=await import('../src/substyle.js');
  ({StylePanelController:Style}=await import('../src/style-panel-controller.js'));
  const noop=()=>{};
  Style.bindStylePanelEvents({renderAll:noop,renderVideoSub:noop,refreshMpvSubs:noop,drawTimeline:noop,refreshStyleSummaries:noop,initPresetLibrary:noop,styleChanged:noop});
  const {initPresetLibrary}=await import('../src/preset-library.js');initPresetLibrary({styleChanged:noop});
  vi.spyOn(Media,'seek').mockResolvedValue(true);
});
beforeEach(async()=>{
  window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(501);UI.closeModal();Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'original',fontSize:80,visible:true,locked:false},{name:'second',fontSize:60,visible:true,locked:false}],cues:[{id:'a',start:1,end:2,text:'original',track:0},{id:'b',start:3,end:4,text:'second',track:0}],notes:[],listTrack:0,selectedId:'a',selectedIds:['a','b'],presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{name:'v1',visible:true,locked:false},{name:'v2',visible:true,locked:false}],fps:25,dropFrame:false,clipboard:[],duration:10});
  State.trackCount=2;document.getElementById("subStyleFilter").value="";
  History.reset();
  Styles.savePresets([]);Style.renderTrackStyle();
  const saving=ProjectModule.ensureProjectSaved();
  if(document.getElementById('modalTitle').textContent==='開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show'))click('稍後再說');
  await saving;
});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});

const picked=()=>({primary:State.selectedId,ids:[...State.selectedIds],video:State.selectedClipId,kind:State.activeTrackKind});
const ctrlA=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}));
const menuClick=label=>{const entry=[...document.querySelectorAll('#ctxmenu .ci')].find(e=>e.textContent.includes(label));expect(entry).toBeTruthy();entry.click();};
const filterScenario=()=>{
 State.cues=[{id:'a',text:'A custom',start:1,end:2,track:0,style:{fontSize:120}},{id:'hidden',text:'hidden default',start:2,end:3,track:0},{id:'c',text:'C custom',start:3,end:4,track:0,style:{fontSize:120}},{id:'d',text:'D custom',start:4,end:5,track:0,style:{fontSize:120}}];
 Subtitles.renderSubList();document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();
 expect([...document.querySelectorAll('.sub-row')].map(r=>r.dataset.id)).toEqual(['a','c','d']);
};
it('keyboard Ctrl+A on locked subtitle track preserves original video selection',async()=>{
 const {setSelection}=await import('../src/state.js');State.tracks[0].locked=true;setSelection({kind:'video',ids:'kept-video'});const before=picked();
 ctrlA();expect(picked()).toEqual(before);
});
it('keyboard Ctrl+A selects only the currently filtered subtitle list',()=>{
 filterScenario();ctrlA();expect(State.selectedIds).toEqual(['a','c','d']);
});
it.each([{label:'將以上字幕選取',id:'c',expected:['a','c']},{label:'將以下字幕選取',id:'a',expected:['a','c','d']}])('cue-menu $label selects only currently filtered rows',async({label,id,expected})=>{
 filterScenario();const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:[id],primary:id});Menus.showCueMenu(10,10);menuClick(label);expect(State.selectedIds).toEqual(expected);
});
it('cue-menu selection opened before a late track lock cannot clear a newer video selection',async()=>{
 const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['b'],primary:'b'});Menus.showCueMenu(10,10);
 State.tracks[0].locked=true;setSelection({kind:'video',ids:'kept-video'});const before=picked();menuClick('將以上字幕選取');expect(picked()).toEqual(before);
});
it('cue-menu selection opened before Undo cannot select removed cue IDs',async()=>{
 const {setSelection}=await import('../src/state.js');State.cues=[{id:'a',text:'A',start:1,end:2,track:0},{id:'c',text:'C',start:3,end:4,track:0}];History.reset();
 State.cues.splice(1,0,{id:'removed-by-undo',text:'B',start:2,end:3,track:0});History.record('insert');setSelection({kind:'sub',ids:['c'],primary:'c'});Menus.showCueMenu(10,10);History.undo();
 expect(State.cues.map(c=>c.id)).toEqual(['a','c']);menuClick('將以上字幕選取');expect(State.selectedIds.every(id=>State.cues.some(c=>c.id===id))).toBe(true);
});
it('list right-click on already-selected locked cue preserves original primary',async()=>{
 const {setSelection}=await import('../src/state.js');State.cues[1].track=1;setSelection({kind:'sub',ids:['a','b'],primary:'a'});State.listTrack=1;State.tracks[1].locked=true;Subtitles.renderSubList();const before=picked();
 document.querySelector('.sub-row[data-id="b"] .txt').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:10,clientY:10}));expect(picked()).toEqual(before);
 expect(document.querySelectorAll('#ctxmenu .ci')).toHaveLength(0);expect(document.getElementById('ctxmenu').textContent).toContain('此字幕軌已鎖定');
});
it('timeline right-click on already-selected locked cue preserves original primary',async()=>{
 const {setSelection}=await import('../src/state.js');State.cues[1].track=1;setSelection({kind:'sub',ids:['a','b'],primary:'a'});State.tracks[1].locked=true;await timeline();const before=picked();
 document.querySelector('.cue-block[data-id="b"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:240,clientY:100}));expect(picked()).toEqual(before);
 expect(document.querySelectorAll('#ctxmenu .ci')).toHaveLength(0);expect(document.getElementById('ctxmenu').textContent).toContain('此字幕軌已鎖定');
});
it('unlocked list right-click keeps the group while making the clicked cue primary',async()=>{
 const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['a','b'],primary:'a'});Subtitles.renderSubList();
 document.querySelector('.sub-row[data-id="b"] .txt').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));expect(picked()).toMatchObject({primary:'b',ids:['a','b']});
});it('locked gutter header explicitly switches focus but never selects its cue contents',async()=>{
 const {setSelection}=await import('../src/state.js');State.tracks[1].locked=true;setSelection({kind:'video',ids:'kept-video'});await timeline();
 document.querySelector('#tlGutterTracks .tl-gtrack[data-track="1"] .gname').click();
 expect(picked()).toEqual({primary:null,ids:[],video:null,kind:'sub'});expect(State.listTrack).toBe(1);
});
it('gutter lock button keeps unrelated video selection and does not trigger focus switching',async()=>{
 const {setSelection}=await import('../src/state.js');setSelection({kind:'video',ids:'kept-video'});await timeline();const before=picked();
 document.querySelector('#tlGutterTracks .tl-gtrack[data-track="1"] .glock').click();expect(State.tracks[1].locked).toBe(true);expect(picked()).toEqual(before);expect(State.listTrack).toBe(0);
});
it('public filtered query applies the current list filter only to its own track',()=>{
 filterScenario();State.cues.push({id:'foreign-default',text:'foreign',start:5,end:6,track:1});
 expect(Subtitles.filteredSubtitleCues().map(c=>c.id)).toEqual(['a','c','d']);
 expect(Subtitles.filteredSubtitleCues(1).map(c=>c.id)).toEqual(['foreign-default']);
});
it('Ctrl+A with no filtered rows keeps another selection intact',async()=>{
 const {setSelection}=await import('../src/state.js');Subtitles.renderSubList();document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();
 expect(document.querySelectorAll('.sub-row')).toHaveLength(0);setSelection({kind:'video',ids:'kept-video'});const before=picked();ctrlA();expect(picked()).toEqual(before);
});
it('cue-menu range re-reads a filter changed after the menu opened',async()=>{
 filterScenario();document.getElementById('subStyleFilter').value='';Subtitles.renderSubList();const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['c'],primary:'c'});Menus.showCueMenu(10,10);
 document.getElementById('subStyleFilter').value='__non_default';Subtitles.renderSubList();menuClick('將以上字幕選取');expect(State.selectedIds).toEqual(['a','c']);
});
it('cue-menu range includes a new live cue inserted before confirmation',async()=>{
 const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['b'],primary:'b'});Menus.showCueMenu(10,10);
 State.cues.splice(1,0,{id:'live-new',text:'new',start:2,end:3,track:0});menuClick('將以上字幕選取');expect(State.selectedIds).toEqual(['a','live-new','b']);
});
it('cue-menu range rejects a replacement source track',async()=>{
 const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['b'],primary:'b'});Menus.showCueMenu(10,10);
 State.tracks[0]={...State.tracks[0]};setSelection({kind:'video',ids:'kept-video'});const before=picked();menuClick('將以上字幕選取');expect(picked()).toEqual(before);
});
it('cue-menu on another track does not borrow the active list filter',async()=>{
 filterScenario();State.cues.push({id:'foreign-first',text:'F1',start:5,end:6,track:1},{id:'foreign-last',text:'F2',start:6,end:7,track:1});
 const {setSelection}=await import('../src/state.js');setSelection({kind:'sub',ids:['foreign-last'],primary:'foreign-last'});Menus.showCueMenu(10,10);menuClick('將以上字幕選取');expect(State.selectedIds).toEqual(['foreign-first','foreign-last']);
});
it('locked subtitle row cannot enter text editing on double-click',async()=>{
 State.tracks[0].locked=true;Subtitles.renderSubList();const txt=document.querySelector('.sub-row[data-id="a"] .txt');
 txt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();
 expect(txt.contentEditable).not.toBe('true');expect(State.cues[0].text).toBe('original');
});
it('subtitle row locked during the save guard cannot enter text editing',async()=>{
 Subtitles.renderSubList();const txt=document.querySelector('.sub-row[data-id="a"] .txt');
 txt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));State.tracks[0].locked=true;await Promise.resolve();
 expect(txt.contentEditable).not.toBe('true');expect(State.cues[0].text).toBe('original');
});
it('an existing text editor cannot write through actual editCue after a late lock',async()=>{
 Subtitles.renderSubList();const txt=document.querySelector('.sub-row[data-id="a"] .txt');
 txt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();expect(txt.contentEditable).toBe('true');
 State.tracks[0].locked=true;txt.innerText='blocked input';txt.dispatchEvent(new Event('input',{bubbles:true}));
 expect(State.cues[0].text).toBe('original');expect(txt.innerText).toBe('original');expect(History.stack).toHaveLength(1);
});

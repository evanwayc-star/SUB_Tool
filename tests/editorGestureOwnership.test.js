// @vitest-environment jsdom
import {afterAll,afterEach,beforeAll,beforeEach,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd().replace(/\\/g,'/');
let State,History,Model,Subtitles,Menus,UI,Media,Project,ProjectModule,Style,Styles,StateModule;
const click=label=>[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent===label).click();

beforeAll(async()=>{
  vi.useFakeTimers();
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  // jsdom lacks Chromium's editable text seam; all application modules stay real.
  Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
  Object.defineProperty(HTMLElement.prototype,'isContentEditable',{configurable:true,get(){return this.getAttribute('contenteditable')==='true';}});
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();
  HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  StateModule=await import('../src/state.js');({State}=StateModule);
  ({History}=await import('../src/history.js'));
  const {on}=await import('../src/events.js');
  on('history:record',label=>History.record(label)); // Real bootstrap subscriber at the production seam.
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
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:project-save')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
});
beforeEach(async()=>{
  vi.useFakeTimers();
  window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(501);UI.closeModal();Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'original',fontSize:80,visible:true,locked:false},{name:'second',fontSize:60,visible:true,locked:false}],cues:[{id:'a',start:1,end:2,text:'original',track:0},{id:'b',start:3,end:4,text:'second',track:0}],notes:[],listTrack:0,presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{name:'v1',visible:true,locked:false},{name:'v2',visible:true,locked:false}],fps:25,dropFrame:false,clipboard:[],duration:10,subMode:false});
  StateModule.setSelection({kind:'sub',ids:['a','b'],primary:'a'});
  State.trackCount=2;document.getElementById("subStyleFilter").value="";
  Subtitles.cancelSwapMode();
  History.reset();
  Styles.savePresets([]);Style.renderTrackStyle();
  const saving=ProjectModule.ensureProjectSaved();
  if(document.getElementById('modalTitle').textContent==='開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show'))click('稍後再說');
  await saving;
});
afterEach(()=>{if(vi.isMockFunction(Media.displayTime)) Media.displayTime.mockRestore();});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});


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
const mouse=(target,type,y=100)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:10,clientY:y}));
let clickClock=1000;
async function heightDrag(){
  vi.spyOn(performance,'now').mockReturnValue(clickClock+=1000);
  State.tracks[0].height=40;History.reset();await timeline();
  const handle=document.querySelector('#tlGutterTracks .tl-resize-handle');expect(handle).toBeTruthy();
  mouse(handle,'mousedown',100);mouse(document,'mousemove',120);
  expect(State.tracks[0].height).toBe(60);
}
it('gutter resize cancel preserves a newer height edit in live and committed data',async()=>{
  await heightDrag();State.tracks[0].height=99;History.record('background height');
  expect(History.committedSnapshot().tracks[0].height).toBe(99);
  window.dispatchEvent(new Event('blur'));
  expect(State.tracks[0].height).toBe(99);expect(History.stack.at(-1).snap.tracks[0].height).toBe(99);
});
it('gutter next preview refuses to overwrite a newer height edit',async()=>{
  await heightDrag();State.tracks[0].height=99;History.record('background height');
  mouse(document,'mousemove',140);expect(State.tracks[0].height).toBe(99);
  mouse(document,'mouseup',140);expect(History.stack.at(-1).snap.tracks[0].height).toBe(99);
});
it('gutter blur cancellation preserves newer height even without a History projection check',async()=>{
  await heightDrag();State.tracks[0].height=99;History.record('background height');
  window.dispatchEvent(new Event('blur'));expect(State.tracks[0].height).toBe(99);
});
it('normal gutter resize still records one undoable commit',async()=>{
  await heightDrag();mouse(document,'mouseup',120);
  expect(State.tracks[0].height).toBe(60);expect(History.stack).toHaveLength(2);History.undo();expect(State.tracks[0].height).toBe(40);History.redo();expect(State.tracks[0].height).toBe(60);
});
it.each([23.976,29.97])('copy at %s FPS then paste at 25 FPS creates legal frame spans',sourceFps=>{
  StateModule.setFps(sourceFps);const exact=sourceFps===23.976?24000/1001:30000/1001;
  State.cues=[{id:'a',start:24/exact,end:48/exact,text:'first',track:0},{id:'b',start:60/exact,end:72/exact,text:'second',track:0}];
  StateModule.setSelection({kind:'sub',ids:['a','b'],primary:'a'});Model.copyCues();StateModule.setFps(25);
  vi.spyOn(Media,'displayTime').mockReturnValue(5);Model.pasteCues();
  for(const id of State.selectedIds){const cue=State.cues.find(c=>c.id===id);expect(cue.start*25).toBeCloseTo(Math.round(cue.start*25),8);expect(cue.end*25).toBeCloseTo(Math.round(cue.end*25),8);expect(cue.end-cue.start).toBeGreaterThanOrEqual(1/25-1e-9);}
});
it('leaving subtitle mode after public In keeps provisional end on a legal frame before off-grid duration',async()=>{
  const Transport=await import('../src/transport-controller.js');StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  State.duration=2.019;Model.toggleSubMode();vi.spyOn(Media,'displayTime').mockReturnValue(1.13);
  vi.spyOn(Media,'pause').mockImplementation(()=>{});await Transport.setIn();expect(State.cues[0].end).toBe(2);
  Model.toggleSubMode();
  expect(State.cues[0].end).toBe(2);expect(State.cues[0].end*25).toBeCloseTo(Math.round(State.cues[0].end*25),8);
});
it('selecting another cue after public In uses the same legal provisional end as mode exit',async()=>{
  const Transport=await import('../src/transport-controller.js');StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  State.duration=2.019;Model.toggleSubMode();vi.spyOn(Media,'displayTime').mockReturnValue(1.13);
  await Transport.setIn();expect(State.cues[0].end).toBe(2);Subtitles.selectCue('b');
  expect(State.cues.find(c=>c.id==='a').end).toBe(2);
});
async function subtitleDrag(){
  const Renderer=await import('../src/video-renderer.js');
  const wrap=document.getElementById('videoWrap');
  Object.defineProperty(wrap,'clientWidth',{configurable:true,value:1000});Object.defineProperty(wrap,'clientHeight',{configurable:true,value:500});
  State.videoWidth=1000;State.videoHeight=500;State.cues=[{id:'a',start:0,end:4,text:'drag subtitle',track:0,style:{color:'#ff0000'}}];History.reset();
  vi.spyOn(Media,'displayTime').mockReturnValue(1);Renderer.renderVideoSub();
  const parent=document.getElementById('videoSub'),el=parent.querySelector('.vsub-track.drag[data-cue="a"]');expect(el).toBeTruthy();
  el.getBoundingClientRect=()=>({left:400,top:400,width:200,height:50});
  el.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100}));
  parent.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:200,clientY:100}));expect(State.cues[0].style.posX).toBe(60);
  return parent;
}
it('subtitle preview drag committed snapshot preserves foreign color and excludes only dragged coordinates',async()=>{
  const parent=await subtitleDrag();Subtitles.applyCueStylePatch(State.cues[0],{color:'#0000ff'});History.record('background color');
  expect(History.committedSnapshot().cues[0].style.color).toBe('#0000ff');
  parent.dispatchEvent(new MouseEvent('pointercancel',{bubbles:true}));
  expect(State.cues[0].style.color).toBe('#0000ff');expect(State.cues[0].style.posX).toBeUndefined();
});
it('subtitle preview drag cancel keeps a foreign color even without inspecting snapshot',async()=>{
  const parent=await subtitleDrag();Subtitles.applyCueStylePatch(State.cues[0],{color:'#0000ff'});History.record('background color');
  parent.dispatchEvent(new MouseEvent('pointercancel',{bubbles:true}));expect(State.cues[0].style.color).toBe('#0000ff');
});
it('text swap rejects same-id replacement source introduced by public Undo',()=>{
  State.cues[0].text='intermediate';History.record('edit');Subtitles.renderSubList();Subtitles.enterSwapMode('a');
  History.undo();Subtitles.renderSubList();const before=State.cues.map(c=>c.text),count=History.stack.length;
  document.querySelector('.sub-row[data-id="b"] .txt').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
  expect(State.cues.map(c=>c.text)).toEqual(before);expect(History.stack.length).toBe(count);
});

it('normal text swap is one undoable change and supports an empty source',()=>{
  State.cues[0].text='';History.reset();Subtitles.renderSubList();Subtitles.enterSwapMode('a');
  mouse(document.querySelector('.sub-row[data-id="b"] .txt'),'mousedown');
  expect(State.cues.map(c=>c.text)).toEqual(['second','']);expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues.map(c=>c.text)).toEqual(['','second']);History.redo();expect(State.cues.map(c=>c.text)).toEqual(['second','']);
});
it.each(['source-lock','target-lock','same-object-new-text','workspace'])('text swap refuses %s while pending',kind=>{
  Subtitles.renderSubList();Subtitles.enterSwapMode('a');
  if(kind==='source-lock') State.tracks[0].locked=true;
  else if(kind==='target-lock'){State.cues[1].track=1;State.tracks[1].locked=true;State.listTrack=1;}
  else if(kind==='same-object-new-text') {State.cues[0].text='background';History.record('background');}
  else Project.apply({version:3,fps:25,tracks:[{name:'new'}],cues:[{start:1,end:2,text:'new',track:1}],notes:[],duration:10});
  const before=structuredClone(State.cues),history=History.stack.length;
  const target=State.cues.at(-1);Subtitles.renderSubList();mouse(document.querySelector(`.sub-row[data-id="${target.id}"] .txt`),'mousedown');
  expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(history);
});
it('same-FPS paste keeps untimed cue semantics, style, group selection and Undo',()=>{
  State.cues=[{id:'a',start:1,end:1.001,text:'one short frame',track:0,style:{color:'#0000ff'}},{id:'b',start:0,end:0,text:'untimed',track:0,timed:false}];
  StateModule.setSelection({kind:'sub',ids:['a','b'],primary:'a'});History.reset();Model.copyCues();vi.spyOn(Media,'displayTime').mockReturnValue(5);Model.pasteCues();
  const added=State.selectedIds.map(id=>State.cues.find(c=>c.id===id));expect(added).toHaveLength(2);
  expect(added[0]).toMatchObject({text:'one short frame',start:5,end:5.04,style:{color:'#0000ff'}});expect(added[1]).toMatchObject({text:'untimed',timed:false,start:0,end:0});
  History.undo();expect(State.cues).toHaveLength(2);History.redo();expect(State.cues).toHaveLength(4);
});
it('locked track still refuses paste without disturbing selection or History',()=>{
  Model.copyCues();State.tracks[0].locked=true;const before=structuredClone(State.cues),ids=[...State.selectedIds];Model.pasteCues();
  expect(State.cues).toEqual(before);expect(State.selectedIds).toEqual(ids);expect(History.stack).toHaveLength(1);
});
it('mode exit skips locked provisional cues and preserves explicitly confirmed long Out',async()=>{
  const Transport=await import('../src/transport-controller.js');StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  State.duration=1000;Model.toggleSubMode();vi.spyOn(Media,'displayTime').mockReturnValue(1);await Transport.setIn();
  Media.displayTime.mockReturnValue(900);await Transport.setOut();expect(State.cues.find(c=>c.id==='a').end).toBe(900);
  State.cues.push({id:'locked',start:2,end:999,text:'locked',track:1,_tempEnd:true});State.tracks[1].locked=true;Model.toggleSubMode();
  expect(State.cues.find(c=>c.id==='a').end).toBe(900);expect(State.cues.find(c=>c.id==='locked')).toMatchObject({end:999,_tempEnd:true});
});
it('selection finalization commits one Undo and explicit timing edit consumes the provisional end',async()=>{
  const Transport=await import('../src/transport-controller.js');StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  State.duration=10;Model.toggleSubMode();vi.spyOn(Media,'displayTime').mockReturnValue(1);await Transport.setIn();
  expect(State.cues.find(c=>c.id==='a')).toMatchObject({end:10,_tempEnd:true});Subtitles.selectCue('b');
  expect(State.cues.find(c=>c.id==='a').end).toBe(3);expect(History.stack).toHaveLength(3);History.undo();expect(State.cues.find(c=>c.id==='a').end).toBe(10);
  Model.editCue({cueId:'a',operation:'end',value:4});Subtitles.selectCue('b');expect(State.cues.find(c=>c.id==='a').end).toBe(4);
});
it('normal preview drag excludes coordinates from snapshots and commits one undoable change',async()=>{
  const parent=await subtitleDrag();const before=History.committedSnapshot().cues[0].style;expect(before).toEqual({color:'#ff0000'});
  parent.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));expect(History.stack).toHaveLength(2);expect(State.cues[0].style.posX).toBe(60);
  History.undo();expect(State.cues[0].style).toEqual({color:'#ff0000'});History.redo();expect(State.cues[0].style.posX).toBe(60);
});
it('preview same-field conflict keeps background position and rolls back only other owned coordinates',async()=>{
  const parent=await subtitleDrag();State.cues[0].style.posX=77;State.cues[0].style.color='#0000ff';History.record('background position');
  const committed=History.committedSnapshot().cues[0].style;expect(committed).toMatchObject({posX:77,color:'#0000ff'});expect(committed.posY).toBeUndefined();
  parent.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:300,clientY:150}));expect(State.cues[0].style).toEqual({color:'#0000ff',posX:77});expect(History.stack).toHaveLength(2);
});
it('preview cancellation after a History reset cannot touch a replacement workspace',async()=>{
  const parent=await subtitleDrag();const replacement={...State.cues[0],style:{color:'#00ff00',posX:33}};State.cues=[replacement];History.reset();
  parent.dispatchEvent(new MouseEvent('pointercancel',{bubbles:true}));expect(replacement.style).toEqual({color:'#00ff00',posX:33});expect(History.stack).toHaveLength(1);
});

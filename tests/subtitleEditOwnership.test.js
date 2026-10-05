// @vitest-environment jsdom
import {afterAll,afterEach,beforeAll,beforeEach,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd().replace(/\\/g,'/');
let State,History,Model,Subtitles,Menus,UI,Media,Project,ProjectModule,Style,Styles,StateModule,savedBlob;
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
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(blob=>{savedBlob=blob;return 'blob:project-save';})});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
});
beforeEach(async()=>{
  vi.useFakeTimers();
  window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(501);UI.closeModal();Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'original',fontSize:80,visible:true,locked:false},{name:'second',fontSize:60,visible:true,locked:false}],cues:[{id:'a',start:1,end:2,text:'original',track:0},{id:'b',start:3,end:4,text:'second',track:0}],notes:[],listTrack:0,presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{name:'v1',visible:true,locked:false},{name:'v2',visible:true,locked:false}],fps:25,dropFrame:false,clipboard:[],duration:10,subMode:false});
  StateModule.setSelection({kind:'sub',ids:['a','b'],primary:'a'});
  State.trackCount=2;document.getElementById("subStyleFilter").value="";
  History.reset();
  Styles.savePresets([]);Style.renderTrackStyle();
  const saving=ProjectModule.ensureProjectSaved();
  if(document.getElementById('modalTitle').textContent==='開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show'))click('稍後再說');
  await saving;
});
afterEach(()=>{if(vi.isMockFunction(Media.displayTime)) Media.displayTime.mockRestore();});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});

const key=(target,key)=>{
  if(target===window) document.activeElement?.blur(); // Timeline keyboard context, outside editable controls.
  return target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
};
async function editText(){
  Subtitles.renderSubList();const txt=document.querySelector('.sub-row[data-id="a"] .txt');
  txt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();
  expect(txt.contentEditable).toBe('true');return txt;
}
it('list text preview must not remove a legal background text edit from committed snapshot',async()=>{
  const txt=await editText();txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  expect(Model.editCue({cueId:'a',operation:'text',value:'background'}).ok).toBe(true);
  expect(State.cues[0].text).toBe('background');
  expect(History.committedSnapshot().cues[0].text).toBe('background');
});
it('list text preview late-lock blur must preserve a legal background same-field edit',async()=>{
  const txt=await editText();txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  Model.editCue({cueId:'a',operation:'text',value:'background'});State.tracks[0].locked=true;
  txt.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
  expect(State.cues[0].text).toBe('background');
});
it('cue edit modal cannot silently replace background text with its unedited opening value',async()=>{
  await Style.openCueEditModal(State.cues[0]);vi.advanceTimersByTime(100);
  const ta=document.getElementById('cueEditTa');expect(ta.textContent).toBe('original');ta.innerText=ta.textContent;
  Model.editCue({cueId:'a',operation:'text',value:'background'});
  expect(document.getElementById('cueEditTa').innerText).toBe('original');click('確認');
  expect(State.cues[0].text).toBe('background');
});
it.each([{cell:'.tin',value:'00:00:02:00',field:'start'},{cell:'.tout',value:'00:00:01:00',field:'end'}])('list $field clamp stays on frame grid',async({cell,value,field})=>{
 Subtitles.renderSubList();const target=document.querySelector('.sub-row[data-id="a"] '+cell);
 target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();
 const input=target.querySelector('input');expect(input).toBeTruthy();input.value=value;key(input,'Enter');
 const frames=State.cues[0][field]*25;expect(frames).toBeCloseTo(Math.round(frames),8);
 expect(State.cues[0].end-State.cues[0].start).toBeGreaterThanOrEqual(1/25-1e-9);
});
it('keyboard P shift shares the project frame grid used by batch time shifting',async()=>{
 const {setSelection}=await import('../src/state.js');
 setSelection({kind:'sub',ids:['a'],primary:'a'});Subtitles.renderSubList();
 vi.spyOn(Media,'displayTime').mockReturnValue(1.13);key(window,'p');
 expect(State.cues[0].start*25).toBeCloseTo(Math.round(State.cues[0].start*25),8);
 expect(State.cues[0].end*25).toBeCloseTo(Math.round(State.cues[0].end*25),8);
});

it('normal list text preview still commits once and restores through Undo',async()=>{
 const txt=await editText();txt.innerText='confirmed';txt.dispatchEvent(new Event('input',{bubbles:true}));
 expect(History.committedSnapshot().cues[0].text).toBe('original');
 txt.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));expect(State.cues[0].text).toBe('confirmed');
 expect(History.stack).toHaveLength(2);History.undo();expect(State.cues[0].text).toBe('original');
});
it('normal list In edit on a legal frame preserves the supplied frame',async()=>{
 Subtitles.renderSubList();const target=document.querySelector('.sub-row[data-id="a"] .tin');
 target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();
 const input=target.querySelector('input');input.value='00:00:01:01';key(input,'Enter');
 expect(State.cues[0].start).toBeCloseTo(1.04,10);expect(History.stack).toHaveLength(2);
});
it('cancel at the import-target dialog must not change the existing project frame grid',async()=>{
 const SubIO=await import('../src/subio.js');State.mediaName=null;State.fps=25;
 State.cues[0].start=1.04;State.cues[0].end=2.04;History.reset();
 vi.useRealTimers();
 const request=SubIO.importDropped(new File(['1\n00:00:01,000 --> 00:00:02,000\nImported\n'],'incoming.srt'));
 await vi.waitFor(()=>expect(document.getElementById('importFpsSel')).toBeTruthy(),{interval:10,timeout:1000});
 const fps=document.getElementById('importFpsSel');fps.value='24';click('確定');
 await request;expect(document.getElementById('importTkSel')).toBeTruthy();click('取消');
 expect(State.cues[0].text).toBe('original');expect(History.stack).toHaveLength(1);
 expect(State.fps).toBe(25);
});

it('background text survives late-lock cancellation, actual save bytes, Undo and Redo',async()=>{
  const txt=await editText();txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  Model.editCue({cueId:'a',operation:'text',value:'background'});
  expect(History.stack.map(entry=>entry.snap.cues[0].text)).toEqual(['original','background']);
  vi.useRealTimers();expect(await Project.save()).toBeTruthy();
  const bytes=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsArrayBuffer(savedBlob);});
  const saved=JSON.parse(new TextDecoder('utf-16le').decode(bytes));
  expect(saved.cues[0].text).toBe('background');
  State.tracks[0].locked=true;txt.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
  History.undo();expect(State.cues[0].text).toBe('original');
  History.redo();expect(State.cues[0].text).toBe('background');
});

it('History reset invalidates an existing list preview token before the next input',async()=>{
  const txt=await editText();txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  History.reset();txt.innerText='stale input';txt.dispatchEvent(new Event('input',{bubbles:true}));
  expect(State.cues[0].text).toBe('draft');expect(txt.contentEditable).toBe('false');
  expect(History.stack).toHaveLength(1);
});

it.each(['Escape','focusout'])('normal preview cancellation via %s returns to the original without recording',async action=>{
  const txt=await editText();txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  if(action==='Escape') key(txt,'Escape');
  else {State.tracks[0].locked=true;txt.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));}
  expect(State.cues[0].text).toBe('original');expect(History.stack).toHaveLength(1);
  expect(History.committedSnapshot().cues[0].text).toBe('original');
});

it('a text draft cannot preview over a background edit before its first input',async()=>{
  const txt=await editText();Model.editCue({cueId:'a',operation:'text',value:'background'});
  txt.innerText='draft';txt.dispatchEvent(new Event('input',{bubbles:true}));
  expect(State.cues[0].text).toBe('background');expect(txt.innerText).toBe('background');
  expect(History.committedSnapshot().cues[0].text).toBe('background');
});

it('modal confirmation merges changed text with untouched background style fields',async()=>{
  await Style.openCueEditModal(State.cues[0]);vi.advanceTimersByTime(100);
  document.getElementById('cueEditTa').innerText='modal text';
  Model.editCue({cueId:'a',operation:'text-style',value:{text:'original',style:{fontSize:120,posX:35}}});
  click('確認');expect(State.cues[0]).toMatchObject({text:'modal text',style:{fontSize:120,posX:35}});
  expect(History.stack).toHaveLength(3);History.undo();expect(State.cues[0]).toMatchObject({text:'original',style:{fontSize:120,posX:35}});
  History.redo();expect(State.cues[0].text).toBe('modal text');
});

it.each(['text','style'])('modal rejects a competing change to the same %s field without a new history entry',async field=>{
  await Style.openCueEditModal(State.cues[0]);vi.advanceTimersByTime(100);
  if(field==='text') document.getElementById('cueEditTa').innerText='modal draft';
  else {document.getElementById('covK_fontSize').checked=true;document.getElementById('covV_fontSize').value='100';}
  Model.editCue({cueId:'a',operation:'text-style',value:{text:field==='text'?'background':'original',style:{fontSize:120}}});
  click('確認');expect(State.cues[0]).toMatchObject({text:field==='text'?'background':'original',style:{fontSize:120}});
  expect(History.stack).toHaveLength(2);expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
});

it.each(['inline','modal'])('a locked cue cannot enter %s editing',async adapter=>{
  UI.closeModal();document.querySelectorAll('.cue-inline-edit').forEach(node=>node.remove());State.tracks[0].locked=true;
  if(adapter==='modal') await Style.openCueEditModal(State.cues[0]);
  else {const block=document.createElement('div');document.getElementById('tlLayer').appendChild(block);await Style.startInlineEdit(block,State.cues[0]);}
  expect(document.querySelector('.cue-inline-edit')).toBeNull();expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  expect(History.stack).toHaveLength(1);
});

it('timeline inline confirmation rejects background text competition and preserves Undo/Redo',async()=>{
  const block=document.createElement('div');document.getElementById('tlLayer').appendChild(block);await Style.startInlineEdit(block,State.cues[0]);
  const editor=document.querySelector('.cue-inline-edit');editor.value='inline draft';
  Model.editCue({cueId:'a',operation:'text',value:'background'});key(editor,'Enter');
  expect(State.cues[0].text).toBe('background');expect(History.stack).toHaveLength(2);
  History.undo();History.redo();expect(State.cues[0].text).toBe('background');
});

it('normal timeline inline confirmation records once and supports Undo/Redo',async()=>{
  const block=document.createElement('div');document.getElementById('tlLayer').appendChild(block);await Style.startInlineEdit(block,State.cues[0]);
  const editor=document.querySelector('.cue-inline-edit');editor.value='confirmed';key(editor,'Enter');
  expect(State.cues[0].text).toBe('confirmed');expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues[0].text).toBe('original');History.redo();expect(State.cues[0].text).toBe('confirmed');
});

it.each(['list','modal'])('%s split cannot replace a competing background text edit',async adapter=>{
  State.cues[0].text='beforeafter';History.reset();
  let editor;
  if(adapter==='list') editor=await editText();
  else {await Style.openCueEditModal(State.cues[0]);vi.advanceTimersByTime(100);editor=document.getElementById('cueEditTa');}
  const range=document.createRange();range.setStart(editor.firstChild,6);range.collapse(true);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  vi.spyOn(Media,'displayTime').mockReturnValue(1.5);
  Model.editCue({cueId:'a',operation:'text',value:'background'});
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  expect(State.cues.map(cue=>cue.text)).toEqual(['background','second']);expect(History.stack).toHaveLength(2);
});

it.each(['list','modal'].flatMap(adapter=>[
  {adapter,fps:25,exact:25,df:false,startFrame:25,endFrame:50,rawTime:1.13,splitFrame:28},
  {adapter,fps:23.976,exact:24000/1001,df:false,startFrame:30,endFrame:60,rawTime:45.4/(24000/1001),splitFrame:45},
  {adapter,fps:29.97,exact:30000/1001,df:true,startFrame:30,endFrame:60,rawTime:45.4/(30000/1001),splitFrame:45},
]))('$adapter split writes whole frames at $fps DF=$df and restores through Undo/Redo',async({adapter,fps,exact,df,startFrame,endFrame,rawTime,splitFrame})=>{
  StateModule.setFps(df?String(fps)+'df':fps);Object.assign(State.cues[0],{start:startFrame/exact,end:endFrame/exact,text:'beforeafter'});History.reset();
  let editor;
  if(adapter==='list') editor=await editText();
  else {await Style.openCueEditModal(State.cues[0]);vi.advanceTimersByTime(100);editor=document.getElementById('cueEditTa');}
  const range=document.createRange();range.setStart(editor.firstChild,6);range.collapse(true);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  vi.spyOn(Media,'displayTime').mockReturnValue(rawTime);
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  expect(State.cues.map(cue=>cue.text)).toEqual(['before','after','second']);
  expect(State.cues[0].end).toBeCloseTo(splitFrame/exact,10);expect(State.cues[1].start).toBeCloseTo(splitFrame/exact,10);
  expect(State.selectedId).toBe(State.cues[1].id);expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues[0].text).toBe('beforeafter');History.redo();expect(State.cues[1].start).toBeCloseTo(splitFrame/exact,10);
});

it.each([{fps:23.976,exact:24000/1001,df:false},{fps:29.97,exact:30000/1001,df:true}])('fractional $fps DF=$df bounds use exact whole frames',({fps,exact,df})=>{
  StateModule.setFps(df?String(fps)+'df':fps);State.cues[0].start=30/exact;State.cues[0].end=60/exact;History.reset();
  expect(Model.editCue({cueId:'a',operation:'start',value:3}).ok).toBe(true);
  expect(State.cues[0].start).toBeCloseTo(59/exact,10);History.undo();
  expect(Model.editCue({cueId:'a',operation:'end',value:0}).ok).toBe(true);
  expect(State.cues[0].end).toBeCloseTo(31/exact,10);History.undo();History.redo();expect(State.cues[0].end).toBeCloseTo(31/exact,10);
});

it.each([{fps:23.976,exact:24000/1001,df:false},{fps:29.97,exact:30000/1001,df:true}])('P moves a $fps DF=$df group together on grid and keeps selection',({fps,exact,df})=>{
  StateModule.setFps(df?String(fps)+'df':fps);
  Object.assign(State.cues[0],{start:30/exact,end:60/exact});Object.assign(State.cues[1],{start:90/exact,end:120/exact});
  State.cues.push({id:'untimed',start:8,end:8,timed:false,text:'untimed',track:0});
  StateModule.setSelection({kind:'sub',ids:['a','b','untimed'],primary:'a'});History.reset();Subtitles.renderSubList();
  vi.spyOn(Media,'displayTime').mockReturnValue(45.4/exact);key(window,'p');
  expect(State.cues.slice(0,2).map(cue=>Math.round(cue.start*exact))).toEqual([45,105]);
  expect(State.cues.slice(0,2).map(cue=>Math.round(cue.end*exact))).toEqual([75,135]);
  expect(State.cues[2].start).toBe(8);expect(State.selectedIds).toEqual(['a','b','untimed']);expect(History.stack).toHaveLength(2);
  History.undo();History.redo();expect(State.cues[1].start).toBeCloseTo(105/exact,10);
});

it('P preserves the whole selection and all timings if any selected track is locked',()=>{
  State.cues[1].track=1;State.tracks[1].locked=true;History.reset();Subtitles.renderSubList();
  const before=structuredClone(State.cues);vi.spyOn(Media,'displayTime').mockReturnValue(1.13);key(window,'p');
  expect(State.cues).toEqual(before);expect(State.selectedIds).toEqual(['a','b']);expect(History.stack).toHaveLength(1);
});

it('subtitle-mode I uses the last legal end frame within an off-grid media duration',async()=>{
  const Transport=await import('../src/transport-controller.js');StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  State.subMode=true;State.duration=2.019;vi.spyOn(Media,'displayTime').mockReturnValue(1.13);History.reset();
  await Transport.setIn();expect(State.cues[0].start).toBeCloseTo(1.12,10);expect(State.cues[0].end).toBeCloseTo(2,10);
});

async function droppedImport(fpsValue='24',text='1\n00:00:01,000 --> 00:00:02,000\nImported\n',name='incoming.srt'){
  const SubIO=await import('../src/subio.js');State.mediaName=null;vi.useRealTimers();
  const request=SubIO.importDropped(new File([text],name));
  await vi.waitFor(()=>expect(document.getElementById('importFpsSel')).toBeTruthy(),{interval:10,timeout:1000});
  document.getElementById('importFpsSel').value=fpsValue;click('確定');await request;
  expect(document.getElementById('importTkSel')).toBeTruthy();return SubIO;
}

it.each(['24','23.976','29.97df'])('import commits the staged %s grid once and Undo/Redo restores it with the cues',async value=>{
  await droppedImport(value);expect(State.fps).toBe(25);expect(State.dropFrame).toBe(false);expect(History.stack).toHaveLength(1);
  document.getElementById('importTkSel').value='0';click('匯入');
  expect(State.fps).toBe(parseFloat(value));expect(State.dropFrame).toBe(value.endsWith('df'));expect(State.cues.map(cue=>cue.text)).toEqual(['Imported']);
  expect(History.stack).toHaveLength(2);History.undo();expect(State.fps).toBe(25);expect(State.cues.map(cue=>cue.text)).toEqual(['original','second']);
  History.redo();expect(State.fps).toBe(parseFloat(value));expect(State.cues[0].text).toBe('Imported');
});

it('Encore timecode is parsed with the staged DF grid before any project mutation',async()=>{
  await droppedImport('29.97df','00:01:00;02\t00:01:01;02\tEncore\n','incoming.txt');
  expect(State.fps).toBe(25);document.getElementById('importTkSel').value='0';click('匯入');
  expect(State.cues[0].start).toBeCloseTo(1800/(30000/1001),10);expect(State.cues[0].text).toBe('Encore');
});

it('SUB Tool ASS metadata uses the staged DF grid and preserves exact frame timing and styles',async()=>{
  const {SubFormats}=await import('../src/formats.js');
  const cue={id:'source',start:100/(30000/1001),end:136/(30000/1001),text:'ASS',track:0,style:{fontSize:120,posX:35}};
  const ass=SubFormats.toASS([cue],29.97,[{name:'ASS source',fontSize:80,visible:true,locked:false}],1920,1080,{includeMetadata:true,dropFrame:true});
  await droppedImport('29.97df',ass,'incoming.ass');expect(State.fps).toBe(25);click('匯入');
  const imported=State.cues.find(item=>item.text==='ASS');expect(imported.start).toBeCloseTo(cue.start,10);expect(imported.end).toBeCloseTo(cue.end,10);
  expect(imported.style).toMatchObject({fontSize:120,posX:35});expect(State.dropFrame).toBe(true);expect(History.stack).toHaveLength(2);
});

it.each(['取消','匯入'])('a later legal grid change survives old import %s',async action=>{
  await droppedImport('24');StateModule.setFps('29.97df');History.record('背景 FPS');click(action);
  expect(State.fps).toBe(29.97);expect(State.dropFrame).toBe(true);expect(State.cues.map(cue=>cue.text)).toEqual(['original','second']);
  expect(History.stack).toHaveLength(2);History.undo();expect(State.fps).toBe(25);History.redo();expect(State.dropFrame).toBe(true);
});

it('late locking the import target leaves the staged grid and cue replacement uncommitted',async()=>{
  await droppedImport('24');document.getElementById('importTkSel').value='0';State.tracks[0].locked=true;click('匯入');
  expect(State.fps).toBe(25);expect(State.cues.map(cue=>cue.text)).toEqual(['original','second']);expect(History.stack).toHaveLength(1);
});

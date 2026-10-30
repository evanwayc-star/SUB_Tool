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
it.each([1,2])('非主鍵 %s 拖曳不重排字幕軌，也不改字幕索引或 History',async button=>{
  await timeline();History.reset();
  const before=History.snap(),names=State.tracks.map(track=>track.name);
  const fire=(target,type,y)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button,clientX:10,clientY:y}));
  fire(document.querySelector('#tlGutterTracks .drag-handle'),'mousedown',5);
  fire(document,'mousemove',70);fire(document,'mouseup',70);
  expect(document.querySelector('.tl-dragging,.tl-drag-target')).toBeNull();
  expect(State.tracks.map(track=>track.name)).toEqual(names);
  expect(History.snap()).toEqual(before);expect(History.stack).toHaveLength(1);
});

it.each([
  {scroll:0,from:2,y:340},
  {scroll:100,from:2,y:240},
  {scroll:100,from:3,y:170},
])('字幕軌重排使用捲動後的內容座標（捲動 $scroll，來源 $from）',async({scroll,from,y})=>{
  State.tracks=[
    {name:'A',height:40},{name:'B',height:60},{name:'C',height:80},{name:'D',height:50},
  ];
  State.trackCount=4;State.listTrack=2;
  State.cues=State.tracks.map((_,track)=>({id:'cue-'+track,start:track,end:track+1,text:String(track),track}));
  await timeline();History.reset();
  const gutter=document.getElementById('tlGutterTracks');
  const originalRect=gutter.getBoundingClientRect;
  const originalScroll=gutter.scrollTop,tracksScroll=document.getElementById('tlTracks').scrollTop;
  try{
  gutter.getBoundingClientRect=()=>({left:0,top:150,right:150,bottom:400,width:150,height:250});
  gutter.scrollTop=scroll;document.getElementById('tlTracks').scrollTop=scroll;
  mouse(gutter.querySelector(`[data-track="${from}"] .drag-handle`),'mousedown',170);
  mouse(document,'mousemove',y);mouse(document,'mouseup',y);
  expect(State.tracks.map(track=>track.name)).toEqual(['A','B','D','C']);
  expect(State.cues.find(cue=>cue.id==='cue-2').track).toBe(3);
  expect(State.cues.find(cue=>cue.id==='cue-3').track).toBe(2);
  expect(State.listTrack).toBe(3);expect(History.stack).toHaveLength(2);
  History.undo();
  expect(State.tracks.map(track=>track.name)).toEqual(['A','B','C','D']);
  expect(State.listTrack).toBe(3);
  }finally{
    gutter.getBoundingClientRect=originalRect;gutter.scrollTop=originalScroll;
    document.getElementById('tlTracks').scrollTop=tracksScroll;
  }
});

it.each(['subtitle','video','audio'].flatMap(kind=>[0,1,2].map(button=>({kind,button}))))('$kind 軌列只接受主鍵高度手勢：button $button',async({kind,button})=>{
  State.clips=[{id:'gutter-clip',in:0,out:5,dur:5,offset:0,vtrack:0,primary:true,audioSourceId:'video',height:40}];
  State.tracks[0].height=40;State.videoTracks[0].height=40;
  const target=kind==='subtitle'?State.tracks[0]:kind==='video'?State.videoTracks[0]:State.clips[0];
  await timeline();History.reset();vi.spyOn(performance,'now').mockReturnValue(clickClock+=1000);
  const parent=kind==='subtitle'?'tlGutterTracks':kind==='video'?'tlGutterVtracks':'tlGutterAtracks';
  const selector=kind==='video'?'[data-vtrack="0"] .tl-resize-handle':'.tl-resize-handle';
  const handle=document.querySelector(`#${parent} ${selector}`);expect(handle).toBeTruthy();
  const fire=(element,type,y)=>element.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button,clientX:10,clientY:y}));
  fire(handle,'mousedown',100);fire(document,'mousemove',120);fire(document,'mouseup',120);
  expect(target.height).toBe(button===0?60:40);expect(History.stack).toHaveLength(button===0?2:1);
  if(button===0){
    History.undo();const restored=kind==='subtitle'?State.tracks[0]:kind==='video'?State.videoTracks[0]:State.clips[0];
    expect(restored.height).toBe(40);
  }else{
    // 右／中鍵連點也不得誤用左鍵雙擊的「重設高度」。
    fire(handle,'mousedown',100);fire(document,'mouseup',100);
    expect(target.height).toBe(40);expect(History.stack).toHaveLength(1);
  }
});

it.each(['replace-project','reorder-track','lock-track'])('空白時間軸新增字幕命令在 %s 後不能沿用舊目標',async change=>{
  await timeline();History.reset();
  document.getElementById('tlLayer').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:400,clientY:200}));
  const add=[...document.querySelectorAll('#ctxmenu .ci')].find(el=>el.textContent.includes('新增空白字幕'));expect(add).toBeTruthy();
  if(change==='replace-project') Project.apply({version:3,fps:25,duration:30,tracks:[{name:'different'}],cues:[],clips:[],notes:[],media:{}});
  else if(change==='reorder-track'){
    const handle=document.querySelector('#tlGutterTracks .drag-handle');
    mouse(handle,'mousedown',5);mouse(document,'mousemove',70);mouse(document,'mouseup',70);
  }else State.tracks[1].locked=true;
  const before=History.snap(),steps=History.stack.length;
  add.click();expect(History.snap()).toEqual(before);expect(History.stack).toHaveLength(steps);
});

it('空白時間軸有效的新增字幕命令仍落格並只記錄一次，可 Undo',async()=>{
  await timeline();History.reset();
  document.getElementById('tlLayer').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:403,clientY:200}));
  const add=[...document.querySelectorAll('#ctxmenu .ci')].find(el=>el.textContent.includes('新增空白字幕'));expect(add).toBeTruthy();
  add.click();const added=State.cues.find(cue=>!['a','b'].includes(cue.id));
  expect(added).toMatchObject({start:5.04,end:6.04,text:'',track:1});expect(History.stack).toHaveLength(2);
  History.undo();expect(State.cues.map(cue=>cue.id)).toEqual(['a','b']);
});

it('搜尋快捷鍵透過正式 command 接線同步開關與 mpv 讓位',async()=>{
  const {createCommands}=await import('../src/commands.js'),{on}=await import('../src/events.js');
  const commands=createCommands();let active=true;
  const sync=vi.fn();on('mpv:sync',()=>{if(active)sync();});
  on('action',action=>{if(active)commands.run(action);});
  const previous=State.keymap;
  try{
    State.keymap={search:[{key:'f',ctrl:true}]};
    document.getElementById('searchDialog').style.display='none';
    const event=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
    event();expect(document.getElementById('searchDialog').style.display).toBe('flex');
    expect(document.activeElement).toBe(document.getElementById('searchInput'));expect(sync).toHaveBeenCalledTimes(1);
    // 全域快捷鍵仍尊重文字輸入，回到非輸入區後同鍵關閉。
    window.dispatchEvent(new Event('blur'));document.getElementById('searchInput').blur();event();
    expect(document.getElementById('searchDialog').style.display).toBe('none');expect(sync).toHaveBeenCalledTimes(2);
  }finally{active=false;State.keymap=previous;}
});

it.each(['blur','pointercancel'])('字幕軌重排收到 %s 後撤銷，遲到 mouseup 不提交',async type=>{
  await timeline();History.reset();
  const names=State.tracks.map(track=>track.name),tracks=State.cues.map(cue=>cue.track);
  const handle=document.querySelector('#tlGutterTracks .drag-handle');
  mouse(handle,'mousedown',5);mouse(document,'mousemove',70);
  expect(document.querySelector('.tl-dragging')).toBeTruthy();
  window.dispatchEvent(new Event(type));
  expect(document.querySelector('.tl-dragging,.tl-drag-target')).toBeNull();
  mouse(document,'mouseup',70);
  expect(State.tracks.map(track=>track.name)).toEqual(names);
  expect(State.cues.map(cue=>cue.track)).toEqual(tracks);expect(History.stack).toHaveLength(1);
  // 下一次正常拖曳仍只提交一筆，字幕索引與列表一同重排。
  mouse(handle,'mousedown',5);mouse(document,'mousemove',70);mouse(document,'mouseup',70);
  expect(State.tracks.map(track=>track.name)).toEqual([...names].reverse());
  expect(State.cues.map(cue=>cue.track)).toEqual([1,1]);expect(State.listTrack).toBe(1);
  expect(History.stack).toHaveLength(2);
  History.undo();expect(State.tracks.map(track=>track.name)).toEqual(names);
});

it.each(['text','move','height','geometry','image-pointer','image-modal'])('公開專案媒體復原完成前取消 %s 預覽，再建立初始基準',async kind=>{
  const {on}=await import('../src/events.js');
  let bridgeActive=true;
  on('render:subList',()=>{if(bridgeActive) Subtitles.renderSubList();}); // 實際 app bootstrap 的 DOM bridge。
  let ready,finish;
  const entered=new Promise(resolve=>{ready=resolve;});
  const pending=new Promise(resolve=>{finish=resolve;});
  const fonts=vi.spyOn(Project,'_isFontAvailable').mockReturnValue(true); // jsdom 沒有 native 字型 metrics。
  const {Seq}=await import('../src/sequence.js');
  const restore=vi.spyOn(Media,'restorePendingImageClips').mockImplementation(async plan=>{
    if(kind.startsWith('image-')) Seq.restore(plan.pendingClips());
    ready();await pending;
  });
  const data={version:3,fps:25,duration:5,tracks:[{name:'字幕',height:40}],
    cues:[{start:1,end:2,text:'原始字幕',track:1}],notes:[],clips:[],media:{}};
  if(kind.startsWith('image-')) data.clips=[{id:'image',type:'image',name:'picture',path:'C:/picture.png',
    dur:5,in:0,out:5,offset:0,vtrack:0,natW:100,natH:50,posX:.5,posY:.5,scale:1}];
  const b64=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
  const loading=Project.loadDesktop({b64});await entered;
  const cue=State.cues[0];let before,live,head,end;
  if(kind==='text'){
    Subtitles.renderSubList();const txt=document.querySelector('.sub-row .txt');
    txt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await Promise.resolve();
    expect(txt.contentEditable).toBe('true');before=cue.text;
    txt.innerText='未確認草稿';txt.dispatchEvent(new Event('input',{bubbles:true}));
    live=()=>cue.text;head=()=>History.stack[0].snap.cues[0].text;
    end=()=>txt.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
  }else if(kind==='geometry' || kind.startsWith('image-')){
    const Renderer=await import('../src/video-renderer.js'),wrap=document.getElementById('videoWrap');
    Object.defineProperty(wrap,'clientWidth',{configurable:true,value:1000});
    Object.defineProperty(wrap,'clientHeight',{configurable:true,value:500});
    State.videoWidth=1000;State.videoHeight=500;vi.spyOn(Media,'displayTime').mockReturnValue(1.5);Renderer.renderVideoSub();
    if(kind==='geometry'){
      const parent=document.getElementById('videoSub'),el=parent.querySelector('.vsub-track.drag');expect(el).toBeTruthy();
      el.getBoundingClientRect=()=>({left:400,top:400,width:200,height:50});before=cue.style?.posX;
      el.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100}));
      parent.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:150,clientY:120}));
      Subtitles.applyCueStylePatch(cue,{color:'#0000ff'}); // 其他欄位的合法修改必須保留。
      live=()=>cue.style?.posX;head=()=>History.stack[0].snap.cues[0].style?.posX;
      end=()=>parent.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));
    }else{
      const clip=State.clips[0];before=clip.posX;
      if(kind==='image-pointer'){
        document.elementFromPoint=()=>null; // jsdom 的 native hit-test boundary。
        const image=document.querySelector('#imageLayer .img-wrap');expect(image).toBeTruthy();
        image.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:100,clientY:100}));
        document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:150,clientY:120}));
        end=()=>mouse(document,'mouseup',120);
      }else{
        Menus.showImageGeom(clip);vi.advanceTimersByTime(0);
        const input=document.getElementById('igX');input.value='60';input.dispatchEvent(new Event('input'));
        const confirm=document.querySelector('#modalFoot button.primary');end=()=>confirm.click();
      }
      clip.fadeIn=.5;
      live=()=>clip.posX;head=()=>History.stack[0].snap.clipGeo[0].posX;
    }
  }else{
    await timeline();
    if(kind==='move'){
      StateModule.setSelection({kind:'sub',ids:[cue.id]});before=cue.start;
      const send=(target,type,x)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:100}));
      send(document.querySelector('.cue-block'),'mousedown',80);send(window,'mousemove',160);
      live=()=>cue.start;head=()=>History.stack[0].snap.cues[0].start;
      end=()=>send(window,'mouseup',160);
    }else{
      vi.spyOn(performance,'now').mockReturnValue(clickClock+=1000);before=State.tracks[0].height;
      mouse(document.querySelector('#tlGutterTracks .tl-resize-handle'),'mousedown',100);mouse(document,'mousemove',120);
      live=()=>State.tracks[0].height;head=()=>History.stack[0].snap.tracks[0].height;
      end=()=>mouse(document,'mouseup',120);
    }
  }
  expect(live()).not.toBe(before);finish();await loading;
  expect(live()).toBe(before);expect(head()).toBe(before);expect(History.stack).toHaveLength(1);
  if(kind==='text'){
    expect(document.querySelector('.sub-row .txt').textContent).toBe('原始字幕');
    expect(document.querySelector('.sub-row .txt').contentEditable).not.toBe('true');
  }
  if(kind==='height') expect(document.querySelector('#tlGutterTracks .tl-gtrack').style.height).toBe('40px');
  if(kind==='geometry'){
    expect(cue.style.color).toBe('#0000ff');expect(History.stack[0].snap.cues[0].style.color).toBe('#0000ff');
    expect(document.getElementById('videoSub').classList.contains('dragging')).toBe(false);
  }
  if(kind.startsWith('image-')){
    expect(State.clips[0].fadeIn).toBe(.5);expect(History.stack[0].snap.clipGeo[0].fadeIn).toBe(.5);
    expect(document.getElementById('imageLayer').classList.contains('dragging')).toBe(false);
    if(kind==='image-modal') expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  }
  end();expect(live()).toBe(before);expect(History.stack).toHaveLength(1);
  let blob;
  URL.createObjectURL.mockImplementation(value=>{blob=value;return 'blob:project-save';});
  expect(await Project.save()).toBeTruthy();
  vi.useRealTimers();
  const bytes=await new Promise(resolve=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsArrayBuffer(blob);
  });
  vi.useFakeTimers();
  const saved=JSON.parse(new TextDecoder('utf-16le').decode(bytes));
  if(kind==='text') expect(saved.cues[0].text).toBe(before);
  else if(kind==='move') expect(saved.cues[0].start).toBe(before);
  else if(kind==='height') expect(saved.tracks[0].height).toBe(before);
  else if(kind==='geometry') expect(saved.cues[0].style).toEqual({color:'#0000ff'});
  else expect(saved.clips[0]).toMatchObject({posX:before,fadeIn:.5});
  bridgeActive=false;fonts.mockRestore();restore.mockRestore();
});
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
it.each([24,25,29.97])('public grouped move and copy drag preserve one-frame cues at %s FPS',async fps=>{
 const {getExactFps}=await import('../src/time.js');const rate=getExactFps(fps);State.fps=fps;State.snapOn=false;State.overwriteMode=true;
 const initial=[{id:'a',start:Math.round(rate)/rate,end:(Math.round(rate)+1)/rate,text:'one',track:0},
   {id:'b',start:Math.round(3*rate)/rate,end:(Math.round(3*rate)+1)/rate,text:'two',track:0}];
 for(const copy of [false,true]){
  State.cues=structuredClone(initial);StateModule.setSelection({kind:'sub',ids:['a','b'],primary:'a'});History.reset();await timeline();
  const modifiers=copy?{altKey:true}:{};const start=initial[0].start*80;
  const send=(target,type,x)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:100,...modifiers}));
  send(document.querySelector('.cue-block[data-id="a"]'),'mousedown',start);send(window,'mousemove',start+80);send(window,'mouseup',start+80);
  expect(State.cues).toHaveLength(copy?4:2);expect(History.stack).toHaveLength(2);
  for(const cue of State.cues){expect((cue.end-cue.start)*rate).toBeCloseTo(1,8);expect(cue.start*rate).toBeCloseTo(Math.round(cue.start*rate),8);}
  const result=structuredClone(State.cues);expect(History.stack.at(-1).snap.cues).toEqual(result);
  History.undo();expect(State.cues).toEqual(initial);History.redo();expect(State.cues).toEqual(result);
 }
 State.overwriteMode=false;State.snapOn=true;
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
async function provisionalCue(){
  const Transport=await import('../src/transport-controller.js');
  State.cues[1].track=1;State.duration=9;
  StateModule.setSelection({kind:'sub',ids:['a'],primary:'a'});
  Model.toggleSubMode();vi.spyOn(Media,'displayTime').mockReturnValue(1);await Transport.setIn();
  expect(State.cues[0]).toMatchObject({start:1,end:9,_tempEnd:true});
}
const dragCueEdge=(target,type,x)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:100}));
it.each(['timecode','percentage','right-edge'])('public %s duration edit after In survives selection, Undo and Redo',async method=>{
  const SubIO=await import('../src/subio.js');await provisionalCue();
  const steps=History.stack.length;
  if(method==='right-edge'){
    await timeline();
    dragCueEdge(document.querySelector('.cue-block[data-id="a"] .edge.r'),'mousedown',720);
    dragCueEdge(window,'mousemove',400);dragCueEdge(window,'mouseup',400);
  }else{
    document.getElementById('tcShiftSel').value='sel';
    if(method==='timecode'){
      document.getElementById('durAdjTcInput').value='00:00:04:00';SubIO.applyDurAdjTc(-1);
    }else{
      document.getElementById('durAdjPctInput').value='50';SubIO.applyDurAdjPct();
    }
  }
  expect(State.cues.find(cue=>cue.id==='a').end).toBe(5);
  Subtitles.selectCue('b');
  expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:1,end:5});
  expect(State.cues.find(cue=>cue.id==='a')._tempEnd).toBeUndefined();
  expect(History.stack).toHaveLength(steps+1);
  History.undo();expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:1,end:9,_tempEnd:true});
  History.redo();expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:1,end:5});
  expect(State.cues.find(cue=>cue.id==='a')._tempEnd).toBeUndefined();
});
it.each(['timecode-shift','keyboard-shift'])('public %s after In preserves the accepted span across selection and Undo',async method=>{
  const SubIO=await import('../src/subio.js');await import('../src/keyboard.js');await provisionalCue();
  const steps=History.stack.length,keys=State.keymap;
  try{
    if(method==='timecode-shift'){
      document.getElementById('tcShiftSel').value='sel';document.getElementById('tcShiftInput').value='00:00:01:00';SubIO.applyTcShift(1);
    }else{
      State.keymap={shift_timecode:[{key:'p'}]};Media.displayTime.mockReturnValue(2);
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true,cancelable:true}));
      window.dispatchEvent(new KeyboardEvent('keyup',{key:'p',bubbles:true}));
    }
    expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:2,end:10});
    Subtitles.selectCue('b');expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:2,end:10});
    expect(State.cues.find(cue=>cue.id==='a')._tempEnd).toBeUndefined();expect(History.stack).toHaveLength(steps+1);
    History.undo();expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:1,end:9,_tempEnd:true});
    History.redo();expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({start:2,end:10});
    expect(State.cues.find(cue=>cue.id==='a')._tempEnd).toBeUndefined();
  }finally{State.keymap=keys;}
});
it.each([false,true])('unchanged or locked P shift preserves provisional ownership (locked=%s)',async locked=>{
  await import('../src/keyboard.js');await provisionalCue();
  const steps=History.stack.length,keys=State.keymap;
  try{
    State.tracks[0].locked=locked;State.keymap={shift_timecode:[{key:'p'}]};
    Media.displayTime.mockReturnValue(locked?2:1);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true,cancelable:true}));
    window.dispatchEvent(new KeyboardEvent('keyup',{key:'p',bubbles:true}));
    expect(State.cues[0]).toMatchObject({start:1,end:9,_tempEnd:true});expect(History.stack).toHaveLength(steps);
  }finally{State.keymap=keys;}
});
it.each(['blur','pointercancel','unchanged'])('provisional duration survives %s drag without a committed timing change',async action=>{
  await provisionalCue();await timeline();const steps=History.stack.length;
  dragCueEdge(document.querySelector('.cue-block[data-id="a"] .edge.r'),'mousedown',720);
  dragCueEdge(window,'mousemove',400);
  expect(State.cues[0].end).toBe(5);
  expect(History.committedSnapshot().cues[0]).toMatchObject({end:9,_tempEnd:true});
  if(action==='unchanged') dragCueEdge(window,'mousemove',720);
  else window.dispatchEvent(new Event(action));
  dragCueEdge(window,'mouseup',720);
  expect(State.cues[0]).toMatchObject({end:9,_tempEnd:true});expect(History.stack).toHaveLength(steps);
  Subtitles.selectCue('b');expect(State.cues.find(cue=>cue.id==='a').end).toBe(3);
});
it('unchanged or locked batch duration leaves the provisional end available for later completion',async()=>{
  const SubIO=await import('../src/subio.js');await provisionalCue();const steps=History.stack.length;
  document.getElementById('tcShiftSel').value='sel';document.getElementById('durAdjPctInput').value='100';SubIO.applyDurAdjPct();
  expect(State.cues[0]).toMatchObject({end:9,_tempEnd:true});expect(History.stack).toHaveLength(steps);
  State.tracks[0].locked=true;document.getElementById('durAdjPctInput').value='50';SubIO.applyDurAdjPct();
  expect(State.cues[0]).toMatchObject({end:9,_tempEnd:true});expect(History.stack).toHaveLength(steps);
});
it.each(['確認套用','取消'])('overwrite duration proposal consumes provisional ownership only after %s',async action=>{
  await provisionalCue();
  State.cues.push({id:'covered',start:3,end:4,text:'background subtitle',track:0});History.record('背景新增');
  State.overwriteMode=true;State.overwriteKeep=false;
  try{
    await timeline();const steps=History.stack.length;
    dragCueEdge(document.querySelector('.cue-block[data-id="a"] .edge.r'),'mousedown',720);
    dragCueEdge(window,'mousemove',400);dragCueEdge(window,'mouseup',400);
    expect(document.getElementById('modalTitle').textContent).toBe('拖曳會覆蓋字幕');
    expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({end:9,_tempEnd:true});expect(History.stack).toHaveLength(steps);
    click(action);
    if(action==='取消'){
      expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({end:9,_tempEnd:true});expect(State.cues.some(cue=>cue.id==='covered')).toBe(true);
      expect(History.stack).toHaveLength(steps);
    }else{
      Subtitles.selectCue('b');expect(State.cues.find(cue=>cue.id==='a').end).toBe(5);
      expect(State.cues.some(cue=>cue.id==='covered')).toBe(false);expect(History.stack).toHaveLength(steps+1);
      History.undo();expect(State.cues.find(cue=>cue.id==='a')).toMatchObject({end:9,_tempEnd:true});expect(State.cues.some(cue=>cue.id==='covered')).toBe(true);
      History.redo();expect(State.cues.find(cue=>cue.id==='a').end).toBe(5);expect(State.cues.find(cue=>cue.id==='a')._tempEnd).toBeUndefined();
    }
  }finally{State.overwriteMode=false;State.overwriteKeep=false;}
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

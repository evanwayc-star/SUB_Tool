// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd().replace(/\\/g,'/');
let State,History,Model,Subtitles,Menus,UI,Media,Project,ProjectModule,Style,Styles;
const click=label=>[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent===label).click();
const clip=(id,values={})=>({id,name:id,path:'C:/'+id+'.mp4',in:0,out:4,dur:4,offset:0,vtrack:0,...values});
async function timeline(){
  const Timeline=await import(ROOT+'/src/timeline-renderer.js');
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
  ({State}=await import(ROOT+'/src/state.js'));
  ({History}=await import(ROOT+'/src/history.js'));
  Model=await import(ROOT+'/src/subtitle-model.js');
  Subtitles=await import(ROOT+'/src/subtitles.js');
  Menus=await import(ROOT+'/src/menus.js');
  UI=await import(ROOT+'/src/ui.js');
  ({Media}=await import(ROOT+'/src/media.js'));
  ProjectModule=await import(ROOT+'/src/project.js');({Project}=ProjectModule);
  Styles=await import(ROOT+'/src/substyle.js');
  ({StylePanelController:Style}=await import(ROOT+'/src/style-panel-controller.js'));
  const noop=()=>{};
  Style.bindStylePanelEvents({renderAll:noop,renderVideoSub:noop,refreshMpvSubs:noop,drawTimeline:noop,refreshStyleSummaries:noop,initPresetLibrary:noop,styleChanged:noop});
  const {initPresetLibrary}=await import(ROOT+'/src/preset-library.js');initPresetLibrary({styleChanged:noop});
  vi.spyOn(Media,'seek').mockResolvedValue(true);
});
beforeEach(async()=>{
  window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(501);UI.closeModal();Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'original',fontSize:80,visible:true,locked:false},{name:'second',fontSize:60,visible:true,locked:false}],cues:[{id:'a',start:1,end:2,text:'original',track:0},{id:'b',start:3,end:4,text:'second',track:0}],notes:[],listTrack:0,selectedId:'a',selectedIds:['a','b'],presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{name:'v1',visible:true,locked:false},{name:'v2',visible:true,locked:false}],fps:25,dropFrame:false,clipboard:[],duration:10});
  State.trackCount=2;
  History.reset();
  Styles.savePresets([]);Style.renderTrackStyle();
  const saving=ProjectModule.ensureProjectSaved();
  if(document.getElementById('modalTitle').textContent==='開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show'))click('稍後再說');
  await saving;
});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});

describe('editor mutation ownership through public commands',()=>{
  it('subtitle delete confirmation preserves same-ID replacement cue objects after Undo',()=>{
    State.cues[0].text='edited';History.record('edit');
    Subtitles.deleteSelectedWithPrompt();
    const original=State.cues[0];History.undo();
    expect(State.cues[0]).not.toBe(original);expect(State.cues[0].text).toBe('original');
    click('確定刪除');
    expect(State.cues).toHaveLength(2);
  });
  it('copy-track confirmation rejects a replacement source track',()=>{
    Model.doCopyTrack();
    State.tracks=[{name:'new workspace',fontSize:120,visible:true}];
    State.cues=[{id:'new',start:5,end:6,text:'new workspace',track:0}];History.reset();
    click('含文字內容');
    expect(State.tracks).toHaveLength(1);
    expect(State.cues.map(c=>c.text)).toEqual(['new workspace']);
  });
  it('clip duration confirmation respects a track locked since opening',()=>{
    const c=clip('duration',{out:2});State.clips=[c];History.reset();
    Menus.showClipDuration(c);document.getElementById('cdVal').value='00:00:03:00';
    State.videoTracks[0].locked=true;click('套用');
    expect(c.out).toBe(2);
  });
  it('clip duration recomputes its bound after a new neighbor appears',()=>{
    const c=clip('duration',{out:2,dur:10});State.clips=[c];History.reset();
    Menus.showClipDuration(c);document.getElementById('cdVal').value='00:00:08:00';
    State.clips.push(clip('background',{offset:3,out:2,dur:2}));click('套用');
    expect(c.offset+c.out).toBeLessThanOrEqual(State.clips.find(c=>c.id==='background').offset);
  });
  it('clip fade confirmation respects a track locked since opening',()=>{
    const c=clip('fade');State.clips=[c];History.reset();
    Menus.showClipFade(c);document.getElementById('cfInV').value='00:00:01:00';
    State.videoTracks[0].locked=true;click('套用');expect(c.fadeIn||0).toBe(0);
  });
  it('crossfade refuses an already locked destination video track',()=>{
    const previous=clip('previous');const c=clip('later',{offset:4});State.clips=[previous,c];History.reset();
    State.videoTracks[1].locked=true;Menus.showCrossfade(c);click('建立溶接');
    expect(c.vtrack).toBe(0);expect(c.offset).toBe(4);expect(c.fadeIn||0).toBe(0);
  });
  it('reset trim permits simultaneous content on another video track',()=>{
    const c=clip('trimmed',{in:1,out:3,dur:4,vtrack:1});State.clips=[clip('base'),c];History.reset();
    const block=document.createElement('div');block.className='clip-block';block.dataset.clipId=c.id;document.getElementById('tlLayer').appendChild(block);
    block.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:10,clientY:10}));
    const action=[...document.querySelectorAll('#ctxmenu .ci')].find(e=>e.textContent.includes('重設修剪'));
    expect(action).toBeTruthy();action.click();
    expect([c.in,c.out]).toEqual([0,4]);block.remove();
  });
  it('new-project confirmation preserves a replacement workspace loaded while pending',async()=>{
    ProjectModule.startNewProject();
    Project.apply({version:3,fps:25,tracks:[{name:'new'}],cues:[{start:5,end:6,text:'new workspace',track:1}],notes:[],duration:10});
    expect(State.cues[0].text).toBe('new workspace');
    const action=[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='確定清空');
    await action.onclick();expect(State.cues.map(c=>c.text)).toEqual(['new workspace']);
  });
  it('pre-export validator includes a later cue covered by an earlier long cue',async()=>{
    const {auditSubtitles,validateSubtitlesBeforeExport}=await import(ROOT+'/src/subtitle-audit.js');
    State.cues=[{id:'long',start:0,end:10,text:'long',track:0},{id:'short',start:1,end:2,text:'short',track:0},{id:'later',start:3,end:4,text:'later',track:0}];
    expect(auditSubtitles(State.cues).overlapNums).toEqual([1,2,3]);
    const errors=validateSubtitlesBeforeExport();
    expect(errors.filter(s=>s.includes('時間碼與前一句重疊'))).toHaveLength(2);
    expect(errors.some(s=>s.includes('第 3 句'))).toBe(true);
  });
  it('style coalescing records separate undo steps after selection targets change',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');
    setSelection({kind:'sub',ids:['a']});Style.renderTrackStyle();
    const input=document.getElementById('tsSize');input.value='100';input.dispatchEvent(new Event('input',{bubbles:true}));
    setSelection({kind:'sub',ids:['b']});Style.renderTrackStyle();
    input.value='120';input.dispatchEvent(new Event('input',{bubbles:true}));
    expect(State.cues.map(c=>Styles.effStyle(c,State.tracks[0]).fontSize)).toEqual([100,120]);
    expect(History.stack).toHaveLength(3);
    History.undo();expect(State.cues.map(c=>Styles.effStyle(c,State.tracks[0]).fontSize)).toEqual([100,80]);
  });
  it('preset rename retains a background-added preset',()=>{
    Styles.savePresets([{name:'original preset',style:{fontSize:80}}]);Style.renderTrackStyle();document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-ren="0"]').click();
    Styles.savePresets([...Styles.getPresets(),{name:'background preset',style:{fontSize:90}}]);
    document.getElementById('__presetNameRen').value='renamed preset';click('儲存');
    expect(Styles.getPresets().map(p=>p.name)).toEqual(['renamed preset','background preset']);
  });
  it('preset overwrite confirmation retains a preset appended while pending',async()=>{
    State.tracks[0].fontSize=Styles.STYLE_DEFAULTS.fontSize+10;
    Styles.savePresets([{name:'existing',style:{fontSize:70}}]);Style.renderTrackStyle();document.getElementById('tsPresetSave').click();
    document.getElementById('__presetName').value='existing';click('儲存');await Promise.resolve();await Promise.resolve();
    expect(document.getElementById('modalTitle').textContent).toBe('名稱已存在');
    Styles.savePresets([...Styles.getPresets(),{name:'background preset',style:{fontSize:90}}]);click('覆蓋');
    expect(Styles.getPresets().map(p=>p.name)).toEqual(['existing','background preset']);
  });
  it('lock-all clears selected clip and Backspace preserves locked clip position',async()=>{
    const Timeline=await import(ROOT+'/src/timeline-renderer.js');
    const {setSelection}=await import(ROOT+'/src/state.js');
    const c=clip('locked gap',{offset:4});State.clips=[c];History.reset();setSelection({kind:'video',ids:c.id});
    Timeline.toggleAllLock();expect(State.videoTracks[0].locked).toBe(true);expect(State.selectedClipId).toBe(null);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true}));
    expect(c.offset).toBe(4);
  });
  it('timeline cue move cancels when its source track becomes locked mid-gesture',async()=>{
    const Timeline=await import(ROOT+'/src/timeline-renderer.js');
    const {setSelection}=await import(ROOT+'/src/state.js');
    const layer=document.getElementById('tlLayer'),scroll=document.getElementById('tlScroll');
    for(const element of [layer,scroll]){
      element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
      Object.defineProperty(element,'clientWidth',{configurable:true,value:640});Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
    }
    State.pxPerSec=80;State.viewStart=0;State.clips=[];setSelection({kind:'sub',ids:['a']});Timeline.drawTimeline();
    const block=document.querySelector('.cue-block[data-id="a"]');expect(block).toBeTruthy();
    block.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:80,clientY:100}));
    State.tracks[0].locked=true;
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:120,clientY:100}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:120,clientY:100}));
    expect(State.cues.find(c=>c.id==='a').start).toBe(1);
  });
  it('normal delete removes only owned cues and preserves an unrelated addition and its Undo',()=>{
    Subtitles.deleteSelectedWithPrompt();
    State.cues.push({id:'added',start:5,end:6,text:'background',track:0});History.record('background');
    click('確定刪除');expect(State.cues.map(c=>c.id)).toEqual(['added']);
    History.undo();expect(State.cues.map(c=>c.id)).toEqual(['a','b','added']);
  });
  it('delete confirmation rejects a source track locked while pending',()=>{
    Subtitles.deleteSelectedWithPrompt();State.tracks[0].locked=true;click('確定刪除');
    expect(State.cues).toHaveLength(2);expect(History.stack).toHaveLength(1);
  });
  it.each([['含文字內容',['original','second']],['僅複製時間點（文字清空）',['','']]])('normal track copy %s keeps confirmed timing and style', (label,texts)=>{
    Model.doCopyTrack();click(label);
    expect(State.tracks[2].name).toBe('original_複製');
    expect(State.cues.filter(c=>c.track===2).map(c=>[c.start,c.end,c.text])).toEqual([[1,2,texts[0]],[3,4,texts[1]]]);
    expect(State.tracks[2].fontSize).toBe(80);History.undo();expect(State.tracks).toHaveLength(2);
  });
  it('track copy requires the confirmed membership to remain unchanged',()=>{
    Model.doCopyTrack();State.cues.push({id:'added',start:5,end:6,text:'background',track:0});click('含文字內容');
    expect(State.tracks).toHaveLength(2);expect(State.cues).toHaveLength(3);
  });
  it.each(['duration','fade'])('%s dialog rejects a same-ID replacement clip',kind=>{
    const c=clip('owner',{out:2});State.clips=[c];History.reset();
    if(kind==='duration'){Menus.showClipDuration(c);document.getElementById('cdVal').value='00:00:03:00';}
    else{Menus.showClipFade(c);document.getElementById('cfInV').value='00:00:01:00';}
    const replacement={...c};State.clips=[replacement];click('套用');
    expect(replacement.out).toBe(2);expect(replacement.fadeIn||0).toBe(0);expect(c.out).toBe(2);expect(c.fadeIn||0).toBe(0);
  });
  it('fade uses the live trimmed length and normal clearing remains undoable',()=>{
    const c=clip('fade');State.clips=[c];History.reset();Menus.showClipFade(c);
    document.getElementById('cfInV').value='00:00:02:00';c.out=.5;History.record('shorten');click('套用');
    expect(c.fadeIn).toBe(.5);Menus.showClipFade(c);click('清除');expect(c.fadeIn).toBe(0);
    History.undo();expect(State.clips[0].fadeIn).toBe(.5);
  });
  it.each(['source-lock','previous-replacement'])('crossfade confirmation rejects %s introduced while pending',kind=>{
    const previous=clip('previous'),c=clip('later',{offset:4});State.clips=[previous,c];History.reset();Menus.showCrossfade(c);
    if(kind==='source-lock') State.videoTracks[0].locked=true;
    else State.clips[0]={...previous};
    click('建立溶接');expect([c.vtrack,c.offset,c.fadeIn||0]).toEqual([0,4,0]);
  });
  it('normal crossfade changes the owned clip and rejects a live destination conflict',()=>{
    const previous=clip('previous'),c=clip('later',{offset:4});State.clips=[previous,c];History.reset();Menus.showCrossfade(c);click('建立溶接');
    expect([c.vtrack,c.offset,c.fadeIn]).toEqual([1,3,1]);History.undo();
    const restored=State.clips.find(c=>c.id==='later');Menus.showCrossfade(restored);
    State.clips.push(clip('occupant',{offset:3,vtrack:1}));click('建立溶接');
    expect([restored.vtrack,restored.offset,restored.fadeIn||0]).toEqual([0,4,0]);
  });
  it('clip command owner refuses locked Backspace even when a caller retains selection',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');
    const {closeClipGapLeft}=await import(ROOT+'/src/clip-model.js');
    const c=clip('gap',{offset:4});State.clips=[c];History.reset();setSelection({kind:'video',ids:c.id});State.videoTracks[0].locked=true;
    closeClipGapLeft();expect(c.offset).toBe(4);State.videoTracks[0].locked=false;closeClipGapLeft();expect(c.offset).toBe(0);
  });
  it('reset trim still refuses a genuine same-track conflict',async()=>{
    const {resetClipTrim}=await import(ROOT+'/src/clip-model.js');
    const c=clip('trim',{in:1,out:3,dur:4});State.clips=[c,clip('next',{offset:2,out:2,dur:2})];History.reset();
    expect(resetClipTrim(c)).toBe(false);expect([c.in,c.out]).toEqual([1,3]);
  });
  it('normal new-project confirmation clears its own workspace',async()=>{
    ProjectModule.startNewProject();await [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='確定清空').onclick();
    expect(State.cues).toEqual([]);expect(State.notes).toEqual([]);expect(History.stack).toHaveLength(1);
  });
  it('overlap owner excludes other tracks, untimed cues and touching boundaries',async()=>{
    const {auditSubtitles,validateSubtitlesBeforeExport}=await import(ROOT+'/src/subtitle-audit.js');
    State.cues=[{id:'a',track:0,start:0,end:2,text:'A'},{id:'b',track:1,start:1,end:4,text:'B'},{id:'c',track:0,start:2,end:4,text:'C'},{id:'u',track:0,start:1,end:5,text:'U',timed:false}];
    expect(auditSubtitles(State.cues).overlapNums).toEqual([]);expect(validateSubtitlesBeforeExport()).toEqual([]);
  });
  it('continuous style inputs to the same group still coalesce in one Undo',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a','b']});Style.renderTrackStyle();
    const input=document.getElementById('tsSize');input.value='100';input.dispatchEvent(new Event('input'));input.value='120';input.dispatchEvent(new Event('input'));
    expect(History.stack).toHaveLength(2);History.undo();expect(State.cues.map(c=>Styles.effStyle(c,State.tracks[0]).fontSize)).toEqual([80,80]);
  });
  it.each(['removed','changed','collision'])('preset rename protects %s library state introduced while pending',kind=>{
    Styles.savePresets([{name:'original preset',style:{fontSize:80}}]);Style.renderTrackStyle();document.getElementById('tsPresetMgr').click();document.querySelector('[data-pre-ren="0"]').click();
    const next=kind==='removed'?[]:kind==='changed'?[{name:'original preset',style:{fontSize:90}}]:[...Styles.getPresets(),{name:'renamed preset',style:{fontSize:90}}];
    Styles.savePresets(next);const saved=structuredClone(Styles.getPresets());document.getElementById('__presetNameRen').value='renamed preset';click('儲存');
    expect(Styles.getPresets()).toEqual(saved);
  });
  it.each([{altKey:true},{ctrlKey:true}])('copy drag with %j cancels on late lock without overwriting foreign selection',async modifiers=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a','b']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown',80,100,modifiers);mouse(window,'mousemove',120,100,modifiers);
    expect(State.cues).toHaveLength(4);State.cues[0].text='foreign';State.notes.push({id:'foreign-note',time:8,text:'keep'});
    setSelection({kind:'sub',ids:['b']});State.tracks[0].locked=true;mouse(window,'mouseup',120,100,modifiers);
    expect(State.cues).toHaveLength(2);expect(State.cues[0].text).toBe('foreign');expect(State.notes).toHaveLength(1);
    expect(State.selectedIds).toEqual(['b']);expect(State.tracks[0].locked).toBe(true);
    expect(State.cues.map(c=>[c.start,c.end])).toEqual([[1,2],[3,4]]);
  });
  it('normal grouped cue move stays one undoable operation',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a','b']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120);mouse(window,'mouseup',120);
    expect(State.cues.map(c=>c.start)).toEqual([1.52,3.52]);expect(State.selectedIds).toEqual(['a','b']);
    History.undo();expect(State.cues.map(c=>c.start)).toEqual([1,3]);
  });
  it('late destination lock cancels an already previewed cross-track cue move',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120,160);
    expect(State.cues[0].track).toBe(1);State.tracks[1].locked=true;State.cues[0].text='foreign';mouse(window,'mouseup',120,160);
    expect([State.cues[0].start,State.cues[0].track]).toEqual([1,0]);expect(State.cues[0].text).toBe('foreign');expect(State.tracks[1].locked).toBe(true);
  });
  it('clip commands respect a locked material even when its video track is unlocked',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');
    const {setClipDuration,setClipFade,resetClipTrim,fitClipToStage,closeClipGapLeft,crossfadeWithPrev,deleteSelectedClip}=await import(ROOT+'/src/clip-model.js');
    const previous=clip('previous'),c=clip('material',{offset:4,in:1,out:3,scale:.5,locked:true});State.clips=[previous,c];History.reset();
    setSelection({kind:'video',ids:c.id});
    setClipDuration(c,3);setClipFade(c,1,1);resetClipTrim(c);fitClipToStage(c);closeClipGapLeft();crossfadeWithPrev(c,1);deleteSelectedClip();
    expect(State.clips).toEqual([previous,c]);
    expect(c).toMatchObject({offset:4,in:1,out:3,scale:.5,vtrack:0});expect(c.fadeIn||0).toBe(0);expect(History.stack).toHaveLength(1);
  });
  it.each(['duration','fade','geometry'])('%s confirmation rejects a material locked while pending',kind=>{
    const c=clip('material',{out:2,scale:1});State.clips=[c];History.reset();
    if(kind==='duration'){Menus.showClipDuration(c);document.getElementById('cdVal').value='00:00:03:00';}
    else if(kind==='fade'){Menus.showClipFade(c);document.getElementById('cfInV').value='00:00:01:00';}
    else{Menus.showImageGeom(c);document.getElementById('igS').value='200';}
    c.locked=true;click('套用');expect(c.out).toBe(2);expect(c.scale).toBe(1);expect(c.fadeIn||0).toBe(0);
  });
  it('geometry confirmation rejects a replaced source track without changing its clip',()=>{
    const c=clip('geometry',{scale:1});State.clips=[c];History.reset();Menus.showImageGeom(c);document.getElementById('igS').value='200';
    State.videoTracks[0]={name:'replacement',visible:true,locked:false};click('套用');expect(c.scale).toBe(1);expect(History.stack).toHaveLength(1);
  });
  it('geometry cancellation after a late lock rolls back its preview and keeps background edits',()=>{
    const c=clip('geometry',{scale:1});State.clips=[c];History.reset();Menus.showImageGeom(c);vi.advanceTimersByTime(1);
    const size=document.getElementById('igS');size.value='200';size.dispatchEvent(new Event('input'));expect(c.scale).toBe(2);
    c.locked=true;c.name='background';State.notes.push({id:'background-note',time:2,text:'keep'});History.record('background');
    click('取消');expect(c.scale).toBe(1);expect(c.locked).toBe(true);expect(c.name).toBe('background');expect(State.notes).toHaveLength(1);
  });
  it('a context-menu swap rejects same-ID replacement clips introduced while the menu is open',()=>{
    const previous=clip('previous'),c=clip('later',{offset:4});State.clips=[previous,c];History.reset();
    const block=document.createElement('div');block.className='clip-block';block.dataset.clipId=c.id;document.getElementById('tlLayer').appendChild(block);
    block.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:10,clientY:10}));
    const action=[...document.querySelectorAll('#ctxmenu .ci')].find(e=>e.textContent.includes('與前一段交換'));
    expect(action).toBeTruthy();const replacement={...c};State.clips=[previous,replacement];action.click();
    expect(previous.offset).toBe(0);expect(replacement.offset).toBe(4);expect(c.offset).toBe(4);block.remove();
  });
  it('Shift range selection remains a selection operation without creating a gesture',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="b"]'),'mousedown',240,100,{shiftKey:true});mouse(window,'mousemove',280,100,{shiftKey:true});mouse(window,'mouseup',280,100,{shiftKey:true});
    expect(State.selectedIds).toEqual(['a','b']);expect(State.selectedId).toBe('a');expect(State.cues.map(c=>c.start)).toEqual([1,3]);expect(History.stack).toHaveLength(1);
  });
  it('a material locked after clip preview cancels its gesture and preserves a background rename',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');const c=clip('gesture',{offset:1,out:2});State.clips=[c];History.reset();setSelection({kind:'video',ids:c.id});await timeline();
    mouse(document.querySelector('.clip-block[data-clip-id="gesture"]'),'mousedown',80,40);mouse(window,'mousemove',120,40);
    expect(c.offset).toBeGreaterThan(1);c.locked=true;c.name='background rename';mouse(window,'mouseup',120,40);
    expect(c.offset).toBe(1);expect(c.locked).toBe(true);expect(c.name).toBe('background rename');
  });
  it('a non-frame live neighbor bound still leaves duration on the exact project grid',async()=>{
    const {getExactFps}=await import(ROOT+'/src/time.js');State.fps=29.97;
    const c=clip('grid',{out:2,dur:10});State.clips=[c];History.reset();Menus.showClipDuration(c);document.getElementById('cdVal').value='00:00:08:00';
    State.clips.push(clip('neighbor',{offset:3.01,out:2,dur:2}));click('套用');
    const end=c.offset+c.out-c.in;expect(end).toBeLessThanOrEqual(3.01);expect(end).toBeGreaterThan(2);
    expect(end*getExactFps(State.fps)).toBeCloseTo(Math.round(end*getExactFps(State.fps)),8);
  });
  it.each(['removed','changed'])('preset overwrite preserves a %s target introduced while pending',async kind=>{
    State.tracks[0].fontSize=Styles.STYLE_DEFAULTS.fontSize+10;
    Styles.savePresets([{name:'existing',style:{fontSize:70}}]);Style.renderTrackStyle();document.getElementById('tsPresetSave').click();
    document.getElementById('__presetName').value='existing';click('儲存');await Promise.resolve();await Promise.resolve();
    const next=kind==='removed'?[]:[{name:'existing',style:{fontSize:110}}];Styles.savePresets(next);const saved=structuredClone(Styles.getPresets());click('覆蓋');
    expect(Styles.getPresets()).toEqual(saved);
  });
  it('late-lock cancellation preserves background timing and style in live, committed and Undo states',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120,160);
    const c=State.cues[0];expect(c.track).toBe(1);
    c.start=1.8;c.end=2.7;c.style={...c.style,fontSize:110};History.record('background timing and style');
    const committed=History.committedSnapshot().cues.find(item=>item.id==='a');
    expect(committed).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
    State.tracks[0].locked=true;History.record('late lock');mouse(window,'mouseup',120,160);
    expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
    History.undo();expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
    History.undo();expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1,end:2,track:0});
    History.redo();expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
    History.redo();expect(State.tracks[0].locked).toBe(true);
  });
  it('a replaced workspace with the same cue id is not changed by old gesture cancellation',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120);
    Project.apply({version:3,fps:25,tracks:[{name:'replacement',locked:true}],cues:[{start:5,end:6,text:'replacement',track:1,style:{fontSize:110}}],notes:[],duration:10});
    const replacement=State.cues[0];replacement.id='a';mouse(window,'mouseup',120);
    expect(State.cues[0]).toBe(replacement);expect(replacement).toMatchObject({start:5,end:6,text:'replacement',track:0,style:{fontSize:110}});
  });
  it('an in-place background style edit cancels further gesture previews and remains undoable',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120,160);
    const c=State.cues[0];c.style.fontSize=110;History.record('background style');
    mouse(window,'mousemove',160,160);mouse(window,'mouseup',160,160);
    expect(c).toMatchObject({start:1,end:2,track:0,style:{fontSize:110}});
    expect(History.committedSnapshot().cues.find(item=>item.id==='a')).toMatchObject({start:1,end:2,track:0,style:{fontSize:110}});
    History.undo();expect(Styles.effStyle(State.cues[0],State.tracks[0]).fontSize).toBe(80);
    History.redo();expect(Styles.effStyle(State.cues[0],State.tracks[0]).fontSize).toBe(110);
  });
  it('a destination track replaced during cue preview invalidates only the old gesture',async()=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');mouse(window,'mousemove',120,160);
    const c=State.cues[0],replacement={name:'replacement',fontSize:110,locked:false};State.tracks[1]=replacement;
    mouse(window,'mouseup',120,160);expect(c).toMatchObject({start:1,end:2,track:0});expect(State.tracks[1]).toBe(replacement);
  });
  it.each(['mousemove','mouseup'])('background changes before the first preview survive %s and Undo/Redo',async nextEvent=>{
    const {setSelection}=await import(ROOT+'/src/state.js');setSelection({kind:'sub',ids:['a']});await timeline();
    mouse(document.querySelector('.cue-block[data-id="a"]'),'mousedown');
    const c=State.cues[0];c.start=1.8;c.end=2.7;c.style={fontSize:110};History.record('background before first preview');
    expect(History.committedSnapshot().cues.find(item=>item.id==='a')).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
    mouse(window,nextEvent,120);if(nextEvent==='mousemove')mouse(window,'mouseup',120);
    expect(c).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});expect(History.stack).toHaveLength(2);
    History.undo();expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1,end:2,track:0});
    History.redo();expect(State.cues.find(item=>item.id==='a')).toMatchObject({start:1.8,end:2.7,track:0,style:{fontSize:110}});
  });
});

// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,StateModule,History,Media,Timeline,Clips,Menus,UI,Project;
const clip=(id,values={})=>({id,name:id,path:`C:/${id}.mp4`,dur:2,in:0,out:2,offset:0,vtrack:0,...values});
const mouse=(target,type,x=10,y=10)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
const confirm=()=>[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='確定刪除')?.click();
const context=target=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:20,clientY:20}));
const geometry=()=>State.clips.map(c=>({id:c.id,offset:c.offset,vtrack:c.vtrack}));

beforeAll(async()=>{
  vi.useFakeTimers();
  document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html').body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},
    {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  StateModule=await import('../src/state.js');({State}=StateModule);
  ({History}=await import('../src/history.js'));({Media}=await import('../src/media.js'));
  Timeline=await import('../src/timeline-renderer.js');Clips=await import('../src/clip-model.js');
  Menus=await import('../src/menus.js');UI=await import('../src/ui.js');Project=await import('../src/project.js');
  const {on}=await import('../src/events.js');on('history:record',label=>History.record(label));
  vi.spyOn(Media,'seek').mockResolvedValue(true);
  for(const element of [document.getElementById('tlLayer'),document.getElementById('tlScroll')]){
    element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
    Object.defineProperty(element,'clientWidth',{configurable:true,value:640});
    Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
  }
});
beforeEach(async()=>{
  window.dispatchEvent(new Event('blur'));UI.closeModal();Menus.hideCtx();Media.externalAudio.clear();
  document.getElementById('tlScroll').scrollLeft=0;
  Object.assign(State,{tracks:[{name:'sub',visible:true,locked:false}],trackCount:1,
    cues:[{id:'keep',start:1,end:2,text:'keep',track:0}],notes:[],externalAudioState:[],externalAudioEnd:0,
    clips:[],videoTracks:[{name:'V1',visible:true,locked:false},{name:'V2',visible:true,locked:false}],
    audioProject:{buses:[],sourceMaps:{},exportLayout:{streams:[]}},fps:25,dropFrame:false,
    duration:10,pxPerSec:80,viewStart:0,vtracksCollapsed:false});
  StateModule.setSelection({kind:'sub',ids:['keep']});History.reset();
  const guard=Project.ensureProjectSaved();
  [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='稍後再說')?.click();await guard;
});
afterAll(()=>{window.dispatchEvent(new Event('blur'));UI.closeModal();Media.externalAudio.clear();vi.clearAllTimers();vi.useRealTimers();});

it('全部鎖定同時保存外音 runtime、專案純資料及一筆可 Undo/Redo 的 History',()=>{
  const audio=Media.createExternalAudioSource({audioSourceId:'lock-audio',duration:4,path:'C:/lock.wav',locked:false});
  History.reset();Timeline.toggleAllLock();
  expect(audio.locked).toBe(true);expect(State.externalAudioState[0].locked).toBe(true);
  expect(History.stack).toHaveLength(2);expect(History.stack[1].snap.externalAudioState[0].locked).toBe(true);
  History.undo();expect(Media.getExternalAudioSource(audio.id).locked).toBe(false);
  History.redo();expect(Media.getExternalAudioSource(audio.id).locked).toBe(true);
  Timeline.toggleAllLock();expect(Media.getExternalAudioSource(audio.id).locked).toBe(false);
  expect(State.externalAudioState[0].locked).toBe(false);expect(History.stack).toHaveLength(3);
});

it.each(['material','track'])('公開影片選取尊重 %s 鎖，保留既有字幕與焦點',kind=>{
  const target=clip('protected',{locked:kind==='material'});State.clips=[target];State.videoTracks[0].locked=kind==='track';
  Clips.selectClip(target.id);
  expect(State.selectedId).toBe('keep');expect(State.selectedClipId).toBe(null);expect(State.activeTrackKind).toBe('sub');
});
it.each(['none','forward','backward'])('刪除影片後只選合法相鄰段，候選為 %s',direction=>{
  const previous=clip('previous',{locked:direction!=='backward'}),deleted=clip('delete',{offset:3});
  const lockedTrack=clip('locked-track',{offset:5,vtrack:1}),lockedMaterial=clip('locked-material',{offset:8,locked:true});
  const next=clip('next',{offset:11,locked:direction!=='forward'});
  State.videoTracks[1].locked=true;State.clips=[previous,deleted,lockedTrack,lockedMaterial,next];History.reset();
  Clips.selectClip(deleted.id);Clips.deleteSelectedClip();
  expect(State.clips.some(c=>c.id===deleted.id)).toBe(false);
  expect(State.selectedClipId).toBe(direction==='none'?null:direction==='forward'?next.id:previous.id);
  expect(document.getElementById('stSel').textContent).toBe(direction==='none'?'':`已選影片段：${direction==='forward'?next.name:previous.name}`);
  expect(History.stack).toHaveLength(2);
});

it.each(['context','mute','select'])('鎖定外音的 %s 入口保留字幕選取，唯讀選單、播放定位和 mute 可用',async action=>{
  const asset=Media.createExternalAudioSource({audioSourceId:'locked-audio',duration:4,path:'C:/locked.wav',offset:2,locked:true});
  History.reset();Timeline.drawTimeline();
  if(action==='context'){
    context(document.querySelector('.external-audio-block'));
    expect(document.querySelector('[data-menu-id="locked_status"]')).not.toBe(null);
    expect(document.querySelector('[data-menu-id="remove_audio"]')).toBe(null);
    document.querySelector('[data-menu-id="seek_audio_start"]').click();
    expect(Media.seek).toHaveBeenLastCalledWith(2);
  }else if(action==='mute'){
    document.querySelector('.agtrack[data-audio-source-id="locked-audio"] .audio-clip-mute').click();
    await Promise.resolve();expect(asset.enabled).toBe(false);expect(State.externalAudioState[0].enabled).toBe(false);
    expect(History.stack).toHaveLength(2);
  }else Timeline.selectExternalAudioClip(asset.id);
  expect(State.selectedId).toBe('keep');expect(State.selectedAudioClipId).toBe(null);expect(State.activeTrackKind).toBe('sub');
});
it('未鎖定外音仍可透過同一右鍵選取 owner 切換，失效 id 保留目前選取',()=>{
  const asset=Media.createExternalAudioSource({audioSourceId:'editable-audio',duration:4,path:'C:/editable.wav'});
  Timeline.drawTimeline();context(document.querySelector('.external-audio-block'));
  expect(State.selectedAudioClipId).toBe(asset.id);expect(State.selectedId).toBe(null);
  Timeline.selectExternalAudioClip('missing');expect(State.selectedAudioClipId).toBe(asset.id);
});

it.each(['initial','confirmation'])('刪軌於 %s 遇到個別鎖定片段時拒絕整筆，包含前面未鎖片段',stage=>{
  const free=clip('free'),protectedClip=clip('protected',{offset:3,locked:stage==='initial'});
  State.clips=[free,protectedClip,clip('other',{vtrack:1})];History.reset();Timeline.drawTimeline();
  document.querySelector('.vgtrack[data-vtrack="0"] .gdel').click();
  if(stage==='initial') expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  else{protectedClip.locked=true;confirm();}
  expect(State.clips).toEqual([free,protectedClip,expect.objectContaining({id:'other'})]);
  expect(State.videoTracks.map(t=>t.name)).toEqual(['V1','V2']);expect(History.stack).toHaveLength(1);
});
it('合法刪軌仍刪除該軌所有片段並把其他軌重編號，且可一次 Undo',()=>{
  State.clips=[clip('free'),clip('second',{offset:3}),clip('other',{vtrack:1})];History.reset();Timeline.drawTimeline();
  document.querySelector('.vgtrack[data-vtrack="0"] .gdel').click();confirm();
  expect(State.clips).toHaveLength(1);expect(State.clips[0]).toMatchObject({id:'other',vtrack:0});expect(History.stack).toHaveLength(2);
  History.undo();expect(State.clips.map(c=>c.id)).toEqual(['free','second','other']);expect(State.videoTracks).toHaveLength(2);
});

it.each(['initial-lock','late-lock','unlocked'])('實際影片拖曳的連鎖插入為 %s 時保持原子性及一次 History',mode=>{
  const moved=clip('move'),free=clip('free',{offset:3}),last=clip('last',{offset:5,locked:mode==='initial-lock'});
  State.clips=[moved,free,last];State.videoTracks.length=1;State.cues=[];State.duration=7;History.reset();Timeline.drawTimeline();
  const initial=geometry();mouse(document.querySelector('.clip-block[data-clip-id="move"]'),'mousedown');
  mouse(window,'mousemove',170);expect(moved.offset).toBe(2);
  if(mode==='late-lock') last.locked=true;
  mouse(window,'mouseup',170);
  if(mode==='unlocked'){
    expect(geometry()).toEqual([{id:'move',offset:2,vtrack:0},{id:'free',offset:4,vtrack:0},{id:'last',offset:6,vtrack:0}]);
    expect(History.stack).toHaveLength(2);History.undo();expect(geometry()).toEqual(initial);
    History.redo();expect(State.clips.map(c=>c.offset)).toEqual([2,4,6]);
  }else{
    expect(geometry()).toEqual(initial);expect(State.duration).toBe(7);expect(History.stack).toHaveLength(1);
  }
});
it('拖曳預覽可越過鎖定鄰片，最後放在無重疊位置仍合法提交',()=>{
  const moved=clip('move'),protectedClip=clip('protected',{offset:3,locked:true});
  State.clips=[moved,protectedClip];State.videoTracks.length=1;State.cues=[];State.duration=5;History.reset();Timeline.drawTimeline();
  mouse(document.querySelector('.clip-block[data-clip-id="move"]'),'mousedown');
  mouse(window,'mousemove',170);expect(moved.offset).toBe(2);
  mouse(window,'mousemove',570);mouse(window,'mouseup',570);
  expect(moved.offset).toBe(7);expect(protectedClip.offset).toBe(3);expect(History.stack).toHaveLength(2);
});
it.each([true,false])('右鍵移到新軌時，連鎖末段 locked=%s 的准入與手勢相同',locked=>{
  const moved=clip('move',{offset:2}),free=clip('free',{offset:3,vtrack:1}),last=clip('last',{offset:5,vtrack:1,locked});
  State.clips=[moved,free,last];State.cues=[];State.duration=7;History.reset();Timeline.drawTimeline();const initial=geometry();
  context(document.querySelector('.clip-block[data-clip-id="move"]'));
  document.querySelector('[data-menu-id="move_track_up"]').click();
  if(locked){expect(geometry()).toEqual(initial);expect(History.stack).toHaveLength(1);}
  else{expect(moved.vtrack).toBe(1);expect([moved.offset,free.offset,last.offset]).toEqual([2,4,6]);expect(History.stack).toHaveLength(2);History.undo();expect(geometry()).toEqual(initial);}
});

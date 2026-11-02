// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,Media,Model,History,setSelection,on;
beforeEach(async()=>{
  vi.resetModules();vi.useFakeTimers();localStorage.clear();
  document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'),'utf8'),'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  HTMLElement.prototype.scrollIntoView=vi.fn();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>new Proxy({
    measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}}),
  },{get:(target,key)=>target[key]||(()=>{})}));
  let initialized=false;
  window.subtool={isDesktop:true,configLoad:async()=>({}),configSave:async()=>true,
    fontsList:async()=>({fonts:[]}),recentProjects:async()=>[],status:async()=>({ffmpeg:true}),
    getStartupFile:async()=>null,onProgress(){},onQueueStatus(){},onOpenFile(){},
    onAppRequestClose(){initialized=true;}};
  ({State,setSelection}=await import('../src/state.js'));
  ({Media}=await import('../src/media.js'));({History}=await import('../src/history.js'));
  Model=await import('../src/subtitle-model.js');({on}=await import('../src/events.js'));
  await import('../src/app.js');await vi.waitFor(()=>expect(initialized).toBe(true));
  Object.assign(State,{duration:10,fps:25,dropFrame:false,clips:[],
    cues:[{id:'source',text:'來源字幕',start:8,end:10,track:0,timed:true}],
    tracks:[{name:'字幕',visible:true,locked:false}],trackCount:1,listTrack:0,
    notes:[],externalAudioState:[],externalAudioEnd:0,subMode:false});
  setSelection({kind:'sub',ids:['source'],primary:'source'});History.reset();
});
afterEach(()=>{
  Media?.resetPresentationSession('test-finished');if(Media)Media.playing=false;
  vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();
  delete window.subtool;delete HTMLElement.prototype.scrollIntoView;
  delete window._ensurePlayheadVisible;delete window._markActiveRow;
});

function append(action){
  if(action==='paste'){Media.seek(10);Model.copyCues();Model.pasteCues();}
  else Model.addCueRelative(1);
  window.SUB.renderAll();window.SUB.drawTimeline();
}

it.each(['paste','relative'])('尾端 %s 新增字幕後可定位到新範圍，Undo／Redo 保持資料與可播放範圍一致',action=>{
  const changed=vi.fn();on('duration:known',changed);
  append(action);
  const added=State.cues.find(cue=>cue.id!=='source');
  expect(added).toMatchObject({start:10,end:12,timed:true});
  expect(State.duration).toBe(12);expect(changed).toHaveBeenCalledOnce();
  Media.seek(11);expect(Media.displayTime()).toBe(11);
  expect(History.stack).toHaveLength(2);
  expect(History.stack.at(-1).snap.cues).toEqual(State.cues);
  History.undo();expect(State.cues).toHaveLength(1);expect(State.duration).toBe(10);
  Media.seek(11);expect(Media.displayTime()).toBe(10);
  History.redo();expect(State.cues).toHaveLength(2);expect(State.duration).toBe(12);
  Media.seek(11);expect(Media.displayTime()).toBe(11);
});

it.each(['paste','relative'])('%s 不縮短較長的虛擬專案範圍',action=>{
  State.duration=60;const changed=vi.fn();on('duration:known',changed);
  append(action);
  expect(State.cues.find(cue=>cue.id!=='source')).toMatchObject({start:10,end:12});
  expect(State.duration).toBe(60);expect(changed).not.toHaveBeenCalled();
  Media.seek(50);expect(Media.displayTime()).toBe(50);expect(History.stack).toHaveLength(2);
});

it.each(['paste','relative'])('%s 未定時稿不以佔位時間延長專案',action=>{
  Object.assign(State.cues[0],{start:20,end:20,timed:false});History.reset();
  const changed=vi.fn();on('duration:known',changed);append(action);
  expect(State.cues.find(cue=>cue.id!=='source')).toMatchObject({start:20,end:20,timed:false});
  expect(State.duration).toBe(10);expect(changed).not.toHaveBeenCalled();
  expect(History.stack).toHaveLength(2);
});

it('新增只採用本次新字幕，不將其他手勢的長終點預覽當成專案長度',()=>{
  const preview={id:'preview',start:6,end:7,text:'正在調整',track:0,timed:true};
  State.cues.unshift(preview);History.reset();
  const release=History.beginPreview([{target:preview,fields:['end']}]);
  preview.end=900;
  try {
    append('relative');
    expect(State.duration).toBe(12);expect(preview.end).toBe(900);
    expect(History.stack.at(-1).snap.cues.find(cue=>cue.id==='preview').end).toBe(7);
    Media.seek(11);expect(Media.displayTime()).toBe(11);
  } finally {preview.end=7;release();}
});

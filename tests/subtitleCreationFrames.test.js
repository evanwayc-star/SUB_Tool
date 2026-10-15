// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,History,Timeline,Menus,Model;
beforeAll(async()=>{
  vi.useFakeTimers();
  document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html').body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},
    {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import('../src/state.js'));({History}=await import('../src/history.js'));
  Timeline=await import('../src/timeline-renderer.js');Menus=await import('../src/menus.js');Model=await import('../src/subtitle-model.js');
  for(const element of [document.getElementById('tlLayer'),document.getElementById('tlScroll')]){
    element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
    Object.defineProperty(element,'clientWidth',{configurable:true,value:640});Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
  }
});
beforeEach(()=>{
  Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'字幕',visible:true,locked:false}],trackCount:1,cues:[],notes:[],clips:[],
    videoTracks:[{name:'V1',visible:true,locked:false}],externalAudioState:[],externalAudioEnd:0,
    audioProject:{buses:[],sourceMaps:{},exportLayout:{streams:[]}},fps:25,dropFrame:false,duration:10,pxPerSec:80,viewStart:0,vtracksCollapsed:false});
  History.reset();Timeline.drawTimeline();
});
afterAll(()=>{Menus.hideCtx();vi.clearAllTimers();vi.useRealTimers();});

it('右鍵空白時間軸新增字幕在畫面與 History 中都對齊專案影格',()=>{
  document.getElementById('tlLayer').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:101,clientY:150}));
  [...document.querySelectorAll('#ctxmenu .ci')].find(item=>item.textContent.includes('新增空白字幕')).click();
  expect(State.cues).toHaveLength(1);
  expect(State.cues[0]).toMatchObject({start:32/25,end:57/25,timed:true});
  expect(History.stack.map(entry=>entry.label)).toEqual(['初始','右鍵新增字幕']);
  expect(History.stack.at(-1).snap.cues[0]).toEqual(State.cues[0]);
  History.undo();expect(State.cues).toEqual([]);
  History.redo();expect(State.cues[0]).toMatchObject({start:32/25,end:57/25});
});

it.each([
  [25,false,1.2625,2.2625,32,57,25],
  [25,false,-.08,-.04,0,1,25],
  [25,false,1.001,1.002,25,26,25],
  [25,false,2,1,50,51,25],
  [29.97,true,21600.012,21600.013,647353,647354,30000/1001],
  [23.976,false,21600.012,21600.013,517882,517883,24000/1001],
])('新增 owner 在 %s FPS/DF=%s 將 %s–%s 吸附為合法影格且至少一格',(fps,dropFrame,start,end,startFrame,endFrame,exact)=>{
  State.fps=fps;State.dropFrame=dropFrame;
  const cue=Model.addCue(start,end,'內容',0);
  expect(cue.start).toBeCloseTo(startFrame/exact,10);expect(cue.end).toBeCloseTo(endFrame/exact,10);
  expect(History.stack.at(-1).snap.cues[0]).toEqual(cue);
});

it('無時間碼新增保留 untimed，鎖軌拒絕不新增 History',()=>{
  const cue=Model.addCue(null,null,'無時間碼',0);
  expect(cue).toMatchObject({start:0,end:0,timed:false});
  State.tracks[0].locked=true;const count=History.stack.length;
  expect(Model.addCue(1.2625,2.2625,'拒絕',0)).toBe(null);
  expect(State.cues).toEqual([cue]);expect(History.stack).toHaveLength(count);
});

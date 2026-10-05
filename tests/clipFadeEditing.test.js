// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
const ROOT=process.cwd().replace(/\\/g,'/');
let State,History,Menus,UI,Media,ProjectModule,Seq,fadeAlphaAtTimeline,buildExportSnapshot;
const click=label=>[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent===label).click();
const clip=(id,values={})=>({id,name:id,path:'C:/'+id+'.mp4',in:0,out:10,dur:10,offset:0,vtrack:0,...values});
const mouse=(target,type,x,y=70)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y,altKey:true}));
beforeAll(async()=>{
  vi.useFakeTimers();
  const parsed=new DOMParser().parseFromString(fs.readFileSync(ROOT+'/index.html','utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import(ROOT+'/src/state.js'));({History}=await import(ROOT+'/src/history.js'));
  Menus=await import(ROOT+'/src/menus.js');UI=await import(ROOT+'/src/ui.js');({Media}=await import(ROOT+'/src/media.js'));
  ProjectModule=await import(ROOT+'/src/project.js');({Seq}=await import(ROOT+'/src/sequence.js'));
  ({fadeAlphaAtTimeline}=await import(ROOT+'/src/image-compositor-engine.js'));
  ({buildExportSnapshot}=await import(ROOT+'/src/delivery-job.js'));
  vi.spyOn(Media,'seek').mockResolvedValue(true);
});
beforeEach(async()=>{
  window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(501);UI.closeModal();Menus.hideCtx();
  Object.assign(State,{tracks:[{name:'sub',visible:true,locked:false}],cues:[],notes:[],clips:[],externalAudioState:[],externalAudioEnd:0,videoTracks:[{name:'v1',visible:true,locked:false},{name:'v2',visible:true,locked:false}],fps:25,dropFrame:false,clipboard:[],duration:10});
  History.reset();
  const saving=ProjectModule.ensureProjectSaved();
  if(document.getElementById('modalTitle').textContent==='開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show'))click('稍後再說');
  await saving;
});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});
function split(){
  const original=clip('mother',{fadeIn:8,fadeOut:2});State.clips=[original];
  const plan=Seq.planSplit(original,5);Object.assign(original,plan.left);
  const right=Seq.add({...plan.right,id:'right'});History.reset();return {original,right};
}
async function timeline(){
  const Timeline=await import(ROOT+'/src/timeline-renderer.js');
  const layer=document.getElementById('tlLayer'),scroll=document.getElementById('tlScroll');
  for(const element of [layer,scroll]){element.getBoundingClientRect=()=>({left:0,top:0,right:1000,bottom:500,width:1000,height:500});Object.defineProperty(element,'clientWidth',{configurable:true,value:1000});Object.defineProperty(element,'clientHeight',{configurable:true,value:500});}
  State.pxPerSec=80;State.viewStart=0;State.vtracksCollapsed=false;Timeline.drawTimeline();
  const edge=document.querySelector('.clip-block[data-clip-id="right"] .edge.l');expect(edge).toBeTruthy();
  return edge;
}
describe('split clip fade clock through public callers',()=>{
  it('explicit fade edits start a new fade at the current clip edges in preview and delivery',()=>{
    const {right}=split();Menus.showClipFade(right);
    document.getElementById('cfInV').value='00:00:02:00';document.getElementById('cfOutV').value='00:00:01:00';click('套用');
    expect(fadeAlphaAtTimeline(right,5)).toBe(0);
    expect(fadeAlphaAtTimeline(right,6)).toBeCloseTo(.5,9);
    const snapshot=buildExportSnapshot({state:State,sequenceEnd:Seq.end()});
    const exported=snapshot.clips.find(c=>c.id==='right')||snapshot.clips.find(c=>c.in===5);
    expect(fadeAlphaAtTimeline(exported,6)).toBeCloseTo(.5,9);
    History.undo();expect(State.clips.find(c=>c.id==='right')).toMatchObject({fadeIn:8,fadeOut:2,fadeSourceOffset:5,fadeSourceLength:10});
    History.redo();const restored=State.clips.find(c=>c.id==='right');expect(fadeAlphaAtTimeline(restored,6)).toBeCloseTo(.5,9);
    expect(restored.fadeSourceOffset).toBeUndefined();expect(restored.fadeSourceLength).toBeUndefined();
  });
  it('crossfade on the split right clip fades from its own new overlap start',()=>{
    const {right}=split();Menus.showCrossfade(right);click('建立溶接');
    expect(right.offset).toBe(4);expect(right.vtrack).toBe(1);
    expect(fadeAlphaAtTimeline(right,4)).toBe(0);
    expect(fadeAlphaAtTimeline(right,4.5)).toBeCloseTo(.5,9);
    History.undo();expect(State.clips.find(c=>c.id==='right')).toMatchObject({offset:5,vtrack:0,fadeIn:8,fadeSourceOffset:5,fadeSourceLength:10});
    History.redo();expect(fadeAlphaAtTimeline(State.clips.find(c=>c.id==='right'),4.5)).toBeCloseTo(.5,9);
  });
  it.each([{fps:25},{fps:23.976},{fps:29.97,dropFrame:true},{fps:25,type:'image'}])('real clip-left gesture preserves the original fade position with %j',async options=>{
    State.fps=options.fps;State.dropFrame=!!options.dropFrame;
    const {right}=split();const before={...right};
    if(options.type){right.type=options.type;before.type=options.type;History.reset();}
    const edge=await timeline();
    mouse(edge,'mousedown',400);mouse(window,'mousemove',480);mouse(window,'mouseup',480);
    const {getExactFps}=await import(ROOT+'/src/time.js');
    expect(right.offset).toBeCloseTo(Math.round(6*getExactFps(State.fps))/getExactFps(State.fps),9);
    for(let t=right.offset+.1;t<9.99;t+=.13)expect(fadeAlphaAtTimeline(right,t)).toBeCloseTo(fadeAlphaAtTimeline(before,t),9);
    const committed={...right};
    History.undo();expect(State.clips.find(c=>c.id==='right')).toMatchObject({in:5,offset:5,fadeSourceOffset:5});
    History.redo();expect(State.clips.find(c=>c.id==='right')).toMatchObject({in:committed.in,offset:committed.offset,fadeSourceOffset:committed.fadeSourceOffset});
  });
  it.each(['blur','late-track-lock'])('cancel by %s restores only this gesture and preserves a background record',async reason=>{
    const {right}=split(),before={...right};const edge=await timeline();
    mouse(edge,'mousedown',400);mouse(window,'mousemove',480);
    expect(right.fadeSourceOffset).toBe(6);
    State.notes.push({id:'background',time:9,text:'keep'});History.record('background note');
    expect(History.stack.at(-1).snap.clipGeo.find(c=>c.id==='right')).toMatchObject({in:5,offset:5,fadeSourceOffset:5});
    if(reason==='blur')window.dispatchEvent(new Event('blur'));
    else{State.videoTracks[0].locked=true;mouse(window,'mouseup',480);}
    expect(right).toMatchObject({in:5,offset:5,fadeSourceOffset:5,fadeSourceLength:10});
    expect(fadeAlphaAtTimeline(right,6.5)).toBeCloseTo(fadeAlphaAtTimeline(before,6.5),9);
    expect(State.notes.map(note=>note.text)).toEqual(['keep']);
  });
  it('clearing a split fade is undoable and does not retain hidden original-window state',()=>{
    const {right}=split();Menus.showClipFade(right);click('清除');
    expect(fadeAlphaAtTimeline(right,5.2)).toBe(1);expect(right.fadeSourceOffset).toBeUndefined();expect(right.fadeSourceLength).toBeUndefined();
    History.undo();expect(fadeAlphaAtTimeline(State.clips.find(c=>c.id==='right'),5.2)).toBeCloseTo(5.2/8,9);
  });
  it('an ordinary clip keeps its existing edge-based fade when trimmed',async()=>{
    const right=clip('right',{offset:5,fadeIn:2,fadeOut:1});State.clips=[right];History.reset();
    const edge=await timeline();mouse(edge,'mousedown',400);mouse(window,'mousemove',480);mouse(window,'mouseup',480);
    expect(right.fadeSourceOffset).toBeUndefined();expect(right.fadeSourceLength).toBeUndefined();expect(fadeAlphaAtTimeline(right,6)).toBe(0);expect(fadeAlphaAtTimeline(right,7)).toBeCloseTo(.5,9);
  });
});

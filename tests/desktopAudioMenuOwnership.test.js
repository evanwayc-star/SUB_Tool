// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,Media,Timeline,Menus,UI;
// 保持實際 menu → dialog → effects owner；只替換桌面檔案處理 adapter。
const normalizeAudio=vi.fn().mockRejectedValue(new Error('native processing test adapter'));
const context=target=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2}));

beforeAll(async()=>{
  vi.useFakeTimers();window.subtool={isDesktop:true,normalizeAudio,
    probe:vi.fn().mockResolvedValue({audio:[{index:0,channels:1,channelLayout:'mono'}]})};
  document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html').body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},
    {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import('../src/state.js'));({Media}=await import('../src/media.js'));
  Timeline=await import('../src/timeline-renderer.js');Menus=await import('../src/menus.js');UI=await import('../src/ui.js');
  vi.spyOn(Media,'seek').mockResolvedValue(true);
  for(const element of [document.getElementById('tlLayer'),document.getElementById('tlScroll')]){
    element.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:500,width:640,height:500});
    Object.defineProperty(element,'clientWidth',{configurable:true,value:640});Object.defineProperty(element,'clientHeight',{configurable:true,value:500});
  }
});
beforeEach(()=>{
  UI.closeModal();Menus.hideCtx();Media.audioEffects.invalidate({clear:true});Media.externalAudio.clear();normalizeAudio.mockClear();
  Object.assign(State,{tracks:[{name:'sub',locked:false}],trackCount:1,cues:[],notes:[],externalAudioState:[],externalAudioEnd:0,
    videoTracks:[{name:'V1',locked:false}],fps:25,dropFrame:false,duration:12,pxPerSec:80,viewStart:0,vtracksCollapsed:false,
    clips:[{id:'primary',name:'primary',path:'C:/primary.mp4',audioSourceId:'primary-id',audioSrc:'video',dur:4,in:0,out:4,offset:0,vtrack:0,primary:true},
      {id:'secondary',name:'secondary',path:'C:/secondary.mp4',audioSourceId:'secondary-id',audioSrc:'clip:secondary',dur:4,in:0,out:4,offset:4,vtrack:0}]});
});
afterAll(()=>{UI.closeModal();Media.audioEffects.invalidate({clear:true});Media.externalAudio.clear();vi.clearAllTimers();vi.useRealTimers();});

it.each([
  ['primary','gutter'],['secondary','gutter'],['secondary','block'],['external','gutter'],['external','block'],
])('%s 母素材的 %s 右鍵音訊平衡提交使用該來源，視窗標題與 native 路徑一致',async(sourceId,entry)=>{
  const external=sourceId==='external';
  const target=external ? Media.createExternalAudioSource({name:'external',path:'C:/external.wav',audioSourceId:'external-id',offset:8,duration:4})
    : State.clips.find(c=>c.id===sourceId);
  Timeline.drawTimeline();
  const selector=entry==='gutter' ? `.agtrack[data-audio-source-id="${sourceId}-id"]`
    : external ? `.external-audio-block[data-audio-asset-id="${target.id}"]` : `.audio-clip-block[data-clip-id="${sourceId}"]`;
  const element=document.querySelector(selector);expect(element).not.toBe(null);context(element);
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  expect(document.getElementById('modalTitle').textContent).toContain(sourceId);
  [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent.includes('套用')).click();
  await vi.waitFor(()=>expect(normalizeAudio).toHaveBeenCalledTimes(1));
  expect(normalizeAudio.mock.calls[0][0]).toBe(target.path);
  expect(normalizeAudio.mock.calls[0][2]).toBe(4);
  expect(State.clips.filter(c=>c!==target).every(c=>!c.hasAudioLimiter)).toBe(true);
});

it.each(['primary','secondary'])('只有 %s 套用效果時，各來源音訊區塊與右鍵對話框僅顯示自己的狀態',sourceId=>{
  const target=State.clips.find(clip=>clip.id===sourceId);
  Object.assign(target,{hasAudioLimiter:true,audioLimiterLabel:sourceId+' FX',audioLimiterSpec:{max:-6,min:-12}});
  Timeline.drawTimeline();
  for(const clip of State.clips){
    const applied=clip===target;
    const block=document.querySelector(`.audio-clip-block[data-clip-id="${clip.id}"]`);
    expect(block.classList.contains('has-limiter')).toBe(applied);
    expect(block.querySelector('.audio-clip-fx-badge')?.textContent||'').toBe(applied?'🎚 濾鏡 '+sourceId+' FX':'');
    context(block);document.querySelector('[data-menu-id="hard_limiter"]').click();
    expect(document.getElementById('modalTitle').textContent).toContain(clip.name);
    expect([...document.querySelectorAll('#modalFoot button')].some(button=>button.textContent==='還原原音')).toBe(applied);
    UI.closeModal();Menus.hideCtx();
  }
});

it.each([
  ['套用','C:/new.wav'],['還原原音','C:/new.wav'],
  ['套用','C:/old.wav'],['還原原音','C:/old.wav'],
])('來源重新載入後，舊音訊效果面板的「%s」不作用於相同 ID 的新素材 %s',async(action,replacementPath)=>{
  const details={name:'old voice',path:'C:/old.wav',audioSourceId:'voice-id',duration:4};
  const original=Media.createExternalAudioSource(details);
  Object.assign(original,{hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12}});
  Timeline.drawTimeline();
  context(document.querySelector('.agtrack[data-audio-source-id="voice-id"]'));
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  // Project 的媒體重建會先 reset，再以持久 audioSourceId 載入另一個物件。
  Media.reset();
  const replacement=Media.createExternalAudioSource({...details,name:'new voice',path:replacementPath});
  Object.assign(replacement,{hasAudioLimiter:true,audioLimiterSpec:{max:-12,min:-18}});
  expect(replacement).not.toBe(original);
  [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent===action).click();
  await vi.waitFor(()=>{
    expect(normalizeAudio).not.toHaveBeenCalled();
    expect(replacement.audioLimiterSpec).toEqual({max:-12,min:-18});
    expect(replacement.audioNormalizing).toBeUndefined();
  });
});

it('仍存活的母素材在開窗後切分，還原原音仍作用於整組來源',async()=>{
  const {Seq}=await import('../src/sequence.js');
  const original=State.clips[0],other=State.clips[1];
  Object.assign(original,{hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12}});
  Timeline.drawTimeline();
  context(document.querySelector('.agtrack[data-audio-source-id="primary-id"]'));
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  const split=Seq.planSplit(original,2);
  Object.assign(original,split.left);
  const right=Seq.add(split.right);
  [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='還原原音').click();
  await vi.waitFor(()=>{
    expect(original.audioLimiterSpec).toBeUndefined();
    expect(right.audioLimiterSpec).toBeUndefined();
  });
  expect(other.audioLimiterSpec).toBeUndefined();
  expect(normalizeAudio).not.toHaveBeenCalled();
});

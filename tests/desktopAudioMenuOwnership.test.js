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
  const {refreshAudioNormalizerDialog}=await import('../src/audio-normalizer-dialog.js');
  UI.bindAudioEffectStatusView(Timeline.refreshClipEffectBadges,refreshAudioNormalizerDialog);
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

it('右鍵面板改一般峰值後，套用保留畫面參數並提交 Peak 無聲保護流程',async()=>{
  Timeline.drawTimeline();
  context(document.querySelector('.audio-clip-block[data-clip-id="secondary"]'));
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  const peak=document.getElementById('hlPeakRadio');peak.checked=true;peak.dispatchEvent(new Event('change',{bubbles:true}));
  document.querySelector('#modalFoot button.primary').click();
  await vi.waitFor(()=>expect(normalizeAudio).toHaveBeenCalledOnce());
  expect(normalizeAudio.mock.calls[0][1]).toMatchObject({isTruePeak:false,maximumAmplitude:-6,targetLoudness:-12,inputBoost:6,sourceStream:0});
});

it('片段的平衡進度直接更新原來的區塊，切換到其他素材或完成後維持正確標示',async()=>{
  const {emit}=await import('../src/events.js');
  const clip=State.clips[0];
  Timeline.drawTimeline();
  const block=document.querySelector('.audio-clip-block[data-clip-id="primary"]');
  const other=document.querySelector('.audio-clip-block[data-clip-id="secondary"]');
  Object.assign(clip,{audioNormalizing:true,audioNormalizeLabel:'分析響度',audioNormalizeProgress:36});
  emit('media:audioEffectStatus',{active:[{sourceId:'primary-id',name:'primary',label:'分析響度',pct:36}]});
  const badge=block.querySelector('.audio-clip-fx-badge');
  expect(badge?.textContent).toBe('分析響度 36%');
  expect(other.querySelector('.audio-clip-fx-badge')).toBeNull();
  clip.audioNormalizeProgress=65;
  emit('media:audioEffectStatus',{active:[{sourceId:'primary-id',name:'primary',label:'分析響度',pct:65}]});
  expect(badge.textContent).toBe('分析響度 65%');
  expect(block.querySelector('.audio-clip-progress-bar').style.width).toBe('65%');
  Object.assign(clip,{audioNormalizing:false,hasAudioLimiter:true,audioLimiterLabel:'−6 dB'});
  emit('media:audioEffectStatus',{active:[],result:{status:'completed',name:'primary'}});
  expect(badge.textContent).toContain('−6 dB');
  expect(block.querySelector('.audio-clip-progress-bar')).toBeNull();
  expect(block).toBe(document.querySelector('.audio-clip-block[data-clip-id="primary"]'));
});

it('從片段送出並收起表單後仍顯示進度，重新開啟面板可讀到同一個工作的狀態',async()=>{
  let fail;
  normalizeAudio.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  Timeline.drawTimeline();
  const block=document.querySelector('.audio-clip-block[data-clip-id="primary"]');
  context(block);
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  document.querySelector('#modalFoot button.primary').click();
  const status=document.getElementById('stAudioEffect');
  expect(status.hidden).toBe(false);
  expect(status.textContent).toContain('音訊平衡');
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  await vi.waitFor(()=>expect(normalizeAudio).toHaveBeenCalledOnce());
  expect(status.title).toContain('primary');
  context(block);
  document.querySelector('[data-menu-id="hard_limiter"]').click();
  expect(document.getElementById('hlStatusTitle').textContent).toBe('音訊平衡處理中');
  expect(document.getElementById('hlStatusBadge').textContent).toContain('%');
  fail(new Error('測試音訊讀取失敗'));
  await vi.waitFor(()=>expect(status.textContent).toContain('失敗'));
  expect(status.title).toContain('測試音訊讀取失敗');
  expect(block.classList.contains('is-normalizing')).toBe(false);
  expect(document.getElementById('hlStatusTitle').textContent).not.toBe('音訊平衡處理中');
});

it.each([false,true])('運算中重新開啟保留目前設定，再按套用不會重開工作（自訂=%s）',async(custom)=>{
  let fail;
  normalizeAudio.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  Timeline.drawTimeline();
  const open=()=>{
    context(document.querySelector('.audio-clip-block[data-clip-id="primary"]'));
    document.querySelector('[data-menu-id="hard_limiter"]').click();
  };
  const set=(id,value)=>{
    const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));
  };
  open();
  set('hlPresetSelect','limit_minus_1db');
  if(custom)set('hlMinAmpNum','-20');
  document.querySelector('#modalFoot button.primary').click();
  try{
    await vi.waitFor(()=>expect(normalizeAudio).toHaveBeenCalledOnce());
    open();
    expect(document.getElementById('hlMaxAmpNum').value).toBe('-1');
    expect(document.getElementById('hlMinAmpNum').value).toBe(custom?'-20':'-14');
    expect(document.getElementById('hlPresetSelect').value).toBe(custom?'custom':'limit_minus_1db');
    document.getElementById('hlMaxAmpNum').focus();
    document.querySelector('#modalFoot button.primary').click();
    await Promise.resolve();await Promise.resolve();
    expect(normalizeAudio).toHaveBeenCalledOnce();
    expect(State.clips[0].audioNormalizing).toBe(true);
    expect(document.getElementById('stAudioEffect').hidden).toBe(false);
  }finally{
    fail?.(new Error('測試結束'));
    await vi.waitFor(()=>expect(State.clips[0].audioNormalizing).not.toBe(true));
  }
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

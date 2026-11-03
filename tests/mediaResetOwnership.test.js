// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const readyWave = (duration=1,amplitude=16384) => {
  const frames=Math.round(duration*4000),bytes=frames*2;
  const wav=new ArrayBuffer(44+bytes),view=new DataView(wav);
  for(const [at,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']]){
    for(let i=0;i<text.length;i++) view.setUint8(at+i,text.charCodeAt(i));
  }
  view.setUint32(4,36+bytes,true);view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,1,true);view.setUint32(24,4000,true);view.setUint32(28,8000,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,bytes,true);
  for(let i=0;i<frames;i++) view.setInt16(44+i*2,i%2?-amplitude:amplitude,true);
  return wav;
};

const desktopMock = vi.hoisted(() => ({
  isDesktop: true,
  fileURL: vi.fn(),
  ingest: vi.fn(),
  probe: vi.fn(),
}));

const domMock = vi.hoisted(() => {
  const listeners = new Map();
  const video = {
    style: {}, src: '', readyState: 0, duration: 5, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false,
    pause: vi.fn(), play: vi.fn(), load: vi.fn(),
    hasAttribute: name => name === 'src' && !!video.src,
    removeAttribute: name => { if (name === 'src') video.src = ''; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of [...(listeners.get(type) || [])]) listener({ type }); },
    dispatchEvent(event) { video.dispatch(event.type); return true; },
    resetEvents() { listeners.clear(); },
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', innerHTML: '', value: '',
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
        });
      }
      return elements.get(id);
    },
  };
});

const eventMock = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => eventMock);
vi.mock('../src/ui.js', () => ({renderCurrentTimecode:vi.fn(),
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, Wave, State, resetAudioProject, resetPlayerAdapter;

async function observeElementCommits() {
  const {AudioEngine}=await import('../src/audio-engine.js');
  const original=AudioEngine.prepareElements.bind(AudioEngine),starts=vi.fn();
  const prepare=vi.spyOn(AudioEngine,'prepareElements').mockImplementation((sourceTime,timelineTime,options)=>{
    const plan=original(sourceTime,timelineTime,options),commit=plan.commit;
    plan.commit=()=>{
      const result=commit();
      const record=started=>{if(started)starts(sourceTime,timelineTime);return started;};
      return result?.then?result.then(record):record(result);
    };
    return plan;
  });
  const restore=starts.mockRestore.bind(starts);
  starts.mockRestore=()=>{prepare.mockRestore();restore();};
  return starts;
}

describe('reset-scoped media ownership', () => {
  it.each(['detach','cached-restore','desktop-restore','web-restore'])('%s 的真實載入入口保留反向二倍速音訊',async kind=>{
    resetAudioProject();
    const {ensureAudioBusCount,ensureAudioSourceMap}=await import('../src/state.js');
    ensureAudioBusCount(3);ensureAudioSourceMap('mother',[{sourceStream:0,sourceChannel:0}]);
    const inheritedBus=State.audioProject.buses[2].id;
    State.audioProject.sourceMaps.mother.channels[0].busIds=[inheritedBus];
    class ReadyAudio {
      constructor(){this.readyState=1;this.src='';this.duration=10;this.preload='';this._target=new EventTarget();this.pause=vi.fn();this.load=vi.fn();}
      addEventListener(...args){this._target.addEventListener(...args);}
      removeEventListener(...args){this._target.removeEventListener(...args);}
      removeAttribute(name){if(name==='src')this.src='';}
    }
    const restore={_restore:true,_routingSourceId:'mother',duration:10,in:0,out:10,offset:0,speed:2,reverse:true};
    const oldCreate=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
    const oldRevoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
    vi.stubGlobal('Audio',ReadyAudio);
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:restored-audio'});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
    desktopMock.fileURL.mockResolvedValue('file:///cache.wav');
    desktopMock.ingest.mockResolvedValue({duration:10,channels:[{file:'C:/cache.wav',sourceStream:0,sourceChannel:0}]});
    const wave=vi.spyOn(Wave,'fromFile').mockResolvedValue(false);
    try{
      let asset;
      if(kind==='detach'){
        State.clips=[{id:'reverse',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0,speed:2,reverse:true,audioSrc:'video',audioSourceId:'mother'}];
        [asset]=await Media.detachClipAudio('reverse');
        expect(State.clips[0].audioDetached).toBe(true);
      }else if(kind==='web-restore')asset=await Media.addAudioFile(new File(['test'],'A.wav'),restore);
      else asset=await Media.addAudioFileDesktop('C:/A.mov',{...restore,preferCache:kind==='cached-restore'});
      expect(asset).toMatchObject({speed:2,reverse:true});
      expect(State.audioProject.sourceMaps[asset.audioSourceId].channels[0].busIds).toEqual([inheritedBus]);
      expect(State.externalAudioState[0]).not.toHaveProperty('_routingSourceId');
      expect(Media.externalAudio.timelineEnd()).toBe(5);
      expect(Media.audioSourcePlayback(asset.audioSrc,1)).toMatchObject({reverse:true,sourceTime:8,offset:2,rate:2});
      expect(State.duration).toBe(5);
    }finally{
      Media.reset();wave.mockRestore();vi.unstubAllGlobals();
      if(oldCreate)Object.defineProperty(URL,'createObjectURL',oldCreate);else delete URL.createObjectURL;
      if(oldRevoke)Object.defineProperty(URL,'revokeObjectURL',oldRevoke);else delete URL.revokeObjectURL;
    }
  });
  it('解除連結保留2倍速反轉的長度與預覽來源映射',async()=>{
    resetAudioProject();
    const clip={id:'reverse',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0,speed:2,reverse:true,audioSrc:'video',audioSourceId:'mother'};
    State.clips=[clip];State.duration=5;
    const cache=vi.spyOn(Media,'_addDesktopCachedAudio').mockImplementation(async(path,restore)=>Media.createExternalAudioSource({...restore,path,fallbackCount:1}));
    try{
      const [asset]=await Media.detachClipAudio(clip.id);
      expect(asset).toMatchObject({speed:2,reverse:true});
      expect(Media.externalAudio.timelineEnd()).toBe(5);
      expect(Media.audioSourcePlayback(asset.audioSrc,1)).toMatchObject({clip:Media.externalAudio.find(asset.id),reverse:true,sourceTime:8,offset:2,rate:2});
      expect(State.duration).toBe(5);
    }finally{cache.mockRestore();}
  });

  it('切割等待期間鎖定同一音訊列，不能提交左段或留下右段',async()=>{
    const asset=Media.createExternalAudioSource({path:'C:/A.wav',duration:8,in:0,out:8,offset:0,fallbackCount:1});
    const gate=deferred();
    const add=vi.spyOn(Media,'addAudioFileDesktop').mockImplementation(async(path,details)=>{await gate.promise;return Media.createExternalAudioSource({...details,path,fallbackCount:1});});
    try{
      const pending=Media.splitExternalAudio(asset.id,4);
      Media.setExternalAudioLocked(asset.timelineLaneId,true);gate.resolve();
      await expect(pending).resolves.toBeNull();
      expect(asset.out).toBe(8);expect(Media.externalAudioSources).toEqual([asset]);
    }finally{add.mockRestore();}
  });

  it('反轉片段的JKL倒帶改用來源正播，停止後還原片段來源倒播',async()=>{
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'reverse-source'}),direction:vi.fn().mockResolvedValue(true),mute:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const adapter=resetPlayerAdapter(desktopMock,domMock.video);await adapter.enterMpv({src:'A.mov'});
    expect(adapter.ownsNativeSourcePath('A.mov')).toBe(true);
    const clip={id:'reverse',path:'A.mov',in:0,out:10,dur:10,offset:0,reverse:true};State.clips=[clip];Media.activeClipId=clip.id;Media._gap=false;
    await expect(Media.setPlaybackDirection('backward')).resolves.toBe(true);
    expect(bridge.direction).toHaveBeenLastCalledWith('forward');
    await Media.setPlaybackDirection('forward');expect(bridge.direction).toHaveBeenLastCalledWith('backward');
  });

  it('切換來源期間的舊 duration 不能擴大新片段；loadfile 完成後採用新來源長度',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const gate=deferred();
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'old-session'}),loadfile:vi.fn(()=>gate.promise),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/old.mov'});
    const old={id:'old-duration',path:'C:/old.mov',dur:100,in:0,out:100,offset:0,vtrack:0,audioSourceId:'old'};
    const next={id:'new-duration',path:'C:/new.mov',dur:3,in:0,out:3,offset:100,vtrack:0,audioSourceId:'new'};
    State.clips=[old,next];State.videoTracks=[{visible:true}];Media.activeClipId=old.id;Media._gap=false;Media._mpvPath=old.path;
    const switching=Media._ensureClip(next,0,false);
    try{
      await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith(next.path));
      expect(Media.activeClipId).toBe(next.id);
      Media.observeMpvEvent({event:'property-change',name:'duration',data:100,sourceSessionId:'old-session'});
      expect(Seq.sourceDuration(next)).toBe(3);
      gate.resolve({ok:true,duration:5,sourceSessionId:'new-session'});await switching;
      expect(Seq.sourceDuration(next)).toBe(5);
      expect(next).toMatchObject({dur:3,out:3});
      Media.observeMpvEvent({event:'property-change',name:'duration',data:6,sourceSessionId:'new-session'});
      expect(Seq.sourceDuration(next)).toBe(6);
    }finally{gate.resolve({ok:false});await switching;runtime.stopBoundsFeeder();Media.reset();}
  });

  it('切換期間片段遭替換，舊來源事件與舊 loadfile 回覆都不能授予新片長度',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const gate=deferred();
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'old-session'}),loadfile:vi.fn(()=>gate.promise),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/old.mov'});
    const old={id:'old-replace',path:'C:/old.mov',dur:100,in:0,out:100,offset:0,vtrack:0,audioSourceId:'old'};
    const next={id:'replace',path:'C:/next.mov',dur:3,in:0,out:3,offset:100,vtrack:0,audioSourceId:'next'};
    const replacement={...next,path:'C:/replacement.mov',audioSourceId:'replacement'};
    State.clips=[old,next];State.videoTracks=[{visible:true}];Media.activeClipId=old.id;Media._gap=false;Media._mpvPath=old.path;
    const switching=Media._ensureClip(next,0,false);
    try{
      await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith(next.path));
      State.clips=[old,replacement];
      Media.observeMpvEvent({event:'property-change',name:'duration',data:100,sourceSessionId:'old-session'});
      expect(Seq.sourceDuration(replacement)).toBe(3);
      gate.resolve({ok:true,duration:90,sourceSessionId:'new-session'});await switching;
      expect(Seq.sourceDuration(replacement)).toBe(3);
      expect(replacement).toMatchObject({dur:3,out:3});
    }finally{gate.resolve({ok:false});await switching;runtime.stopBoundsFeeder();Media.reset();}
  });

  it('同一來源不同片段切換期間，仍接收該來源的有效 duration',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const gate=deferred();
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'shared-session'}),loadfile:vi.fn(),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn(()=>gate.promise),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/shared.mov'});
    const first={id:'shared-a',path:'C:/shared.mov',dur:3,in:0,out:3,offset:0,vtrack:0,audioSourceId:'a'};
    const next={id:'shared-b',path:'C:/shared.mov',dur:3,in:0,out:3,offset:3,vtrack:0,audioSourceId:'b'};
    State.clips=[first,next];State.videoTracks=[{visible:true}];Media.activeClipId=first.id;Media._gap=false;Media._mpvPath=first.path;
    const switching=Media._ensureClip(next,0,false);
    try{
      await vi.waitFor(()=>expect(bridge.direction).toHaveBeenCalled());
      expect(bridge.loadfile).not.toHaveBeenCalled();
      Media.observeMpvEvent({event:'property-change',name:'duration',data:5,sourceSessionId:'shared-session'});
      expect(Seq.sourceDuration(next)).toBe(5);
      expect(next).toMatchObject({dur:3,out:3});
      gate.resolve(true);await switching;
    }finally{gate.resolve(true);await switching;runtime.stopBoundsFeeder();Media.reset();}
  });

  it('真實換片期間新 session 唯一長度早於載入回覆，仍交接給目前片段',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const loadGate=deferred(),directionGate=deferred();let deliver;
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'old-session'}),
      loadfile:vi.fn(()=>loadGate.promise),onEvent:vi.fn(callback=>{deliver=callback;}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn(()=>directionGate.promise),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/old.mov'});runtime.onEvent(event=>Media.observeMpvEvent(event));
    const old={id:'early-old',path:'C:/old.mov',dur:100,in:0,out:100,offset:0,vtrack:0,audioSourceId:'old'};
    const next={id:'early-new',path:'C:/new.mov',dur:3,in:0,out:3,offset:100,vtrack:0,audioSourceId:'new'};
    State.clips=[old,next];State.videoTracks=[{visible:true}];Media.activeClipId=old.id;Media._gap=false;Media._mpvPath=old.path;
    const switching=Media._ensureClip(next,0,false);
    try{
      await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalled());
      deliver({event:'property-change',name:'duration',data:100,sourceSessionId:'old-session'});
      deliver({event:'property-change',name:'duration',data:10,sourceSessionId:'new-session'});
      loadGate.resolve({ok:true,duration:5,sourceSessionId:'new-session'});
      await vi.waitFor(()=>expect(bridge.direction).toHaveBeenCalled());
      await vi.waitFor(()=>expect(Seq.sourceDuration(next)).toBe(10));
      expect(next).toMatchObject({dur:3,out:3});
    }finally{loadGate.resolve({ok:false});directionGate.resolve(true);await switching;runtime.stopBoundsFeeder();Media.reset();}
  });

  it.each(['完成','實際呈現','替換片段','同素材另一片段','進入間隙','切回 Proxy','重新載入來源','新轉場','失敗'])('還原母素材等待畫格：%s 後只把唯一長度交給原 owner',async outcome=>{
    const {Seq}=await import('../src/sequence.js');
    const loadGate=deferred(),seekGate=deferred();let deliver;
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'proxy-session'}),
      loadfile:vi.fn(()=>loadGate.promise),onEvent:vi.fn(callback=>{deliver=callback;}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),rate:vi.fn().mockResolvedValue(),
      seek:vi.fn(()=>seekGate.promise),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    const received=vi.fn(event=>Media.observeMpvEvent(event));
    await runtime.enterMpv({src:'C:/proxy.mov'});runtime.onEvent(received);
    const clip={id:'transition-mother',path:'C:/mother.mov',dur:3,in:0,out:3,offset:0,vtrack:0,audioSourceId:'mother'};
    State.clips=[clip];State.videoTracks=[{visible:true}];Media.activeClipId=clip.id;Media._gap=false;
    Media._mpvPath='C:/proxy.mov';Media._reverseProxyActive=true;Media._reverseProxySourcePath=clip.path;
    const switching=Media._switchReverseShuttleSource(clip.path,false,{});
    try{
      await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalled());
      deliver({event:'property-change',name:'duration',data:10,sourceSessionId:'mother-session'});
      loadGate.resolve({ok:true,duration:3,sourceSessionId:'mother-session'});
      await vi.waitFor(()=>expect(bridge.seek).toHaveBeenCalled());
      expect(Media.mpvSourceTransitionPending()).toBe(true);
      await vi.waitFor(()=>expect(received).toHaveBeenCalledWith(expect.objectContaining({name:'duration',data:10})));
      expect(Seq.sourceDuration(clip)).toBe(3);
      if(outcome==='替換片段')State.clips=[{...clip}];
      if(outcome==='同素材另一片段'){
        const next={...clip,id:'another-placement'};State.clips.push(next);Media.activeClipId=next.id;
      }
      if(outcome==='進入間隙')Media._gap=true;
      if(outcome==='切回 Proxy')Media._reverseProxyActive=true;
      if(outcome==='重新載入來源'){
        bridge.loadfile.mockResolvedValueOnce({ok:true,sourceSessionId:'new-mother-session'});
        await runtime.loadfile(clip.path);
      }
      if(outcome==='新轉場')Media._ensureMpvSourceTransition().begin();
      if(outcome==='失敗')seekGate.resolve(false);else seekGate.resolve(true);
      await switching;
      if(outcome==='實際呈現')Media._ensureMpvSourceTransition().presented(0);
      else if(outcome!=='失敗')Media.acceptMpvSourceTime(0);
      expect(Seq.sourceDuration(clip)).toBe(['完成','實際呈現'].includes(outcome)?10:3);
      if(outcome==='替換片段')expect(Seq.sourceDuration(State.clips[0])).toBe(3);
    }finally{loadGate.resolve({ok:false});seekGate.resolve(true);await switching;runtime.stopBoundsFeeder();Media.reset();}
  });

  it('載入新來源後才送到的舊 session duration 不得擴大新片段',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'old-session'}),
      loadfile:vi.fn().mockResolvedValue({ok:true,duration:5,sourceSessionId:'new-session'}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/old.mov'});
    const old={id:'session-old',path:'C:/old.mov',dur:100,in:0,out:100,offset:0,vtrack:0,audioSourceId:'old'};
    const next={id:'session-new',path:'C:/new.mov',dur:3,in:0,out:3,offset:100,vtrack:0,audioSourceId:'new'};
    State.clips=[old,next];State.videoTracks=[{visible:true}];Media.activeClipId=old.id;Media._gap=false;Media._mpvPath=old.path;
    try{
      await Media._ensureClip(next,0,false);
      expect(Seq.sourceDuration(next)).toBe(5);
      Media.observeMpvEvent({event:'property-change',name:'duration',data:100,sourceSessionId:'old-session'});
      Media.observeMpvEvent({event:'property-change',name:'duration',data:100});
      expect(Seq.sourceDuration(next)).toBe(5);
      Media.observeMpvEvent({event:'property-change',name:'duration',data:6,sourceSessionId:'new-session'});
      expect(Seq.sourceDuration(next)).toBe(6);
    }finally{runtime.stopBoundsFeeder();Media.reset();}
  });

  it('同一路徑重新載入後拒絕舊 session duration、接受新 session',async()=>{
    const {Seq}=await import('../src/sequence.js');
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'first-session'}),
      loadfile:vi.fn().mockResolvedValue({ok:true,duration:3,sourceSessionId:'second-session'}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),
      rate:vi.fn().mockResolvedValue(),seek:vi.fn().mockResolvedValue(true),pause:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'C:/same.mov'});
    const clip={id:'same-reload',path:'C:/same.mov',dur:3,in:0,out:3,offset:0,vtrack:0,audioSourceId:'source'};
    State.clips=[clip];State.videoTracks=[{visible:true}];Media.activeClipId=clip.id;Media._gap=false;Media._mpvPath=clip.path;
    try{
      await runtime.loadfile(clip.path);
      Media.observeMpvEvent({event:'property-change',name:'duration',data:100,sourceSessionId:'first-session'});
      expect(Seq.sourceDuration(clip)).toBe(3);
      Media.observeMpvEvent({event:'property-change',name:'duration',data:5,sourceSessionId:'second-session'});
      expect(Seq.sourceDuration(clip)).toBe(5);
    }finally{runtime.stopBoundsFeeder();Media.reset();}
  });

  it('FFmpeg下載失敗後可重新嘗試，同時呼叫共用一個下載',async()=>{
    const original=window.FFmpeg;Media.ffmpeg=null;Media.ffmpegLoading=null;
    let online=false,requests=0;
    const append=vi.spyOn(document.head,'appendChild').mockImplementation(script=>{requests++;queueMicrotask(()=>online?script.onload():script.onerror(new Error('offline')));return script;});
    const ff={load:vi.fn().mockResolvedValue()};window.FFmpeg={createFFmpeg:()=>ff};
    try{
      await expect(Media.loadFFmpeg()).rejects.toThrow('offline');expect(requests).toBe(2);
      online=true;const [a,b]=await Promise.all([Media.loadFFmpeg(),Media.loadFFmpeg()]);
      expect(a).toBe(ff);expect(b).toBe(ff);expect(requests).toBe(3);expect(ff.load).toHaveBeenCalledOnce();
    }finally{append.mockRestore();window.FFmpeg=original;Media.ffmpeg=null;Media.ffmpegLoading=null;}
  });
  it('播放gap中改倍速不跳時間，後續時鐘才採用新斜率',()=>{
    let now=0;
    const clock=vi.spyOn(Media._transport,'_now').mockImplementation(()=>now);
    domMock.video.playbackRate=1;
    Media._transport.enterGap(10,{running:true});now=2000;
    expect(Media._transport.gapTimeAt(1)).toBe(12);
    Media.setRate(2);
    expect(Media._transport.gapTimeAt(2)).toBe(12);
    now=3000;expect(Media._transport.gapTimeAt(2)).toBe(14);
    Media.setRate(0.5);expect(Media._transport.gapTimeAt(0.5)).toBe(14);
    now=5000;expect(Media._transport.gapTimeAt(0.5)).toBe(15);
    Media._transport.freezeGap({playbackRate:0.5});Media.setRate(1);
    now=9000;expect(Media._transport.gapTimeAt(1)).toBe(15);
    clock.mockRestore();domMock.video.playbackRate=1;
  });

  it.each(['primary','secondary','external'])('late %s 原音cache只供還原，不能覆蓋已安裝effect與wave',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const processing={max:-6,min:-12,inputBoost:0};
    const processedPeaks=new Float32Array([0.05]),rawBytes=readyWave(10,8192);
    const expectedRawPeaks=Wave.calcFromWav(rawBytes);
    let owner;
    if(kind==='external') owner=Media.createExternalAudioSource({name:'A.wav',path:'C:/A.wav',duration:10,fallbackCount:1,audioLimiterSpec:processing});
    else{
      owner={id:'A',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:10,offset:0,vtrack:0,
        primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:A',audioSourceId:'mother',audioLimiterSpec:processing};
      State.clips=[owner];
    }
    owner.peaks=processedPeaks;
    const processed={id:'processed',kind:'element',source:owner.audioSrc,audioSourceId:owner.audioSourceId,
      sourceStream:0,sourceChannel:0,_audioEffect:true,file:'processed.wav',volume:0.4,solo:true,muted:false,
      el:{pause:vi.fn(),src:'processed.wav'},gain:{gain:{value:0.4},disconnect:vi.fn()}};
    Media.tracks=[processed];Wave.peaks=processedPeaks;
    const gate=deferred();desktopMock.ingest.mockReturnValue(gate.promise);
    desktopMock.fileURL.mockImplementation(path=>Promise.resolve('file:///'+path));
    const original={pause:vi.fn(),src:'raw.m4a'};
    const elements=vi.spyOn(Media._intakeSession,'materializeAudioElements').mockResolvedValue([original]);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>rawBytes}));
    try{
      const pending=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],10,owner,{needsProxy:false})
        :kind==='secondary'?Media._clipIngest(owner,{audio:[{channels:1}]})
          :Media.cacheExternalRoutingAudio(owner,owner.path,10,[{channels:1}]);
      gate.resolve({channels:[{file:'raw.m4a',sourceStream:0,sourceChannel:0}],wave:'raw-wave.wav'});
      await pending;
      expect(Media.tracks).toEqual([processed]);
      expect(processed.el.src).toBe('processed.wav');
      expect(owner.peaks).toBe(processedPeaks);
      const rawPeaks=Media._effectOriginalPeaks.get(owner.audioSourceId);
      expect(rawPeaks).toEqual(expectedRawPeaks);
      expect(rawPeaks).toHaveLength(2000);
      expect(rawPeaks[0]).toBe(-.25);expect(rawPeaks[1]).toBe(.25);
      expect(Media._effectOriginalTracks.get(owner.audioSourceId)[0]).toMatchObject({file:'raw.m4a',volume:0.4,solo:true});
      expect(Media._effectOriginalTracks.get(owner.audioSourceId)[0].gain.gain.value).toBe(0);
      Media._installAudioEffect(owner,null,null);
      expect(Media.tracks).toHaveLength(1);
      expect(Media.tracks[0].file).toBe('raw.m4a');
      expect(Media.tracks[0]._audioEffect).not.toBe(true);
      expect(owner.peaks).toBe(rawPeaks);
    }finally{elements.mockRestore();vi.unstubAllGlobals();}
  });

  it.each(['primary','secondary','external'])('%s 的長 WAV 整理期間可重設專案，不安裝舊峰值或啟動 fallback',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const duration=600,bytes=readyWave(duration),previous=Float32Array.from([-.1,.1]);
    const owner=kind==='external'
      ?Media.createExternalAudioSource({name:'A.wav',path:'C:/A.wav',duration,fallbackCount:1})
      :{id:'A',name:'A.mov',path:'C:/A.mov',dur:duration,in:0,out:duration,offset:0,vtrack:0,
        primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:A',audioSourceId:'mother'};
    if(kind!=='external')State.clips=[owner];
    owner.peaks=previous;
    desktopMock.ingest.mockResolvedValue({channels:[],wave:'long-wave.wav'});
    desktopMock.fileURL.mockResolvedValue('file:///long-wave.wav');
    const cancelled=deferred();let peaksAtCancel;
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>{
      setTimeout(()=>{peaksAtCancel=owner.peaks;Media.reset();cancelled.resolve();},0);
      return bytes;
    }})));
    const {AudioEngine}=await import('../src/audio-engine.js');
    const fallback=vi.spyOn(AudioEngine,'decodeAudioData');
    try{
      const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],duration,owner,{needsProxy:false})
        :kind==='secondary'?Media._clipIngest(owner,{audio:[{channels:1}]})
          :Media.cacheExternalRoutingAudio(owner,owner.path,duration,[{channels:1}]);
      await cancelled.promise;await work;
      expect(peaksAtCancel===previous).toBe(true);
      expect(owner.peaks===previous).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
    }finally{fallback.mockRestore();vi.unstubAllGlobals();}
  });

  it.each(['primary','secondary'])('%s 的完成波形不等待播放聲道 metadata 才顯示',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'wave-ready',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
      primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:wave-ready',audioSourceId:'ready-source'};
    State.clips=[owner];
    // 真正的單聲道 PCM WAV；波形內容先可讀，播放元素的 metadata 刻意仍在等。
    desktopMock.ingest.mockResolvedValue({cached:true,channels:[{file:'channel.m4a',sourceStream:0,sourceChannel:0}],wave:'ready.wav'});
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>readyWave()}));
    const gate=deferred(),audio=vi.spyOn(Media._intakeSession,'materializeAudioElements').mockReturnValue(gate.promise);
    const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],1,owner)
      :Media._clipIngest(owner,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(audio).toHaveBeenCalledOnce());
      await vi.waitFor(()=>expect(owner.peaks?.length).toBeGreaterThan(0));
      expect(Math.min(...owner.peaks)).toBeCloseTo(-0.5,3);
      expect(Math.max(...owner.peaks)).toBeCloseTo(0.5,3);
      expect(Media.tracks).toEqual([]);
      expect(Wave._sourceState(owner,false)?.mix.path).toBe('ready.wav');
    }finally{
      gate.resolve([]);await work;audio.mockRestore();vi.unstubAllGlobals();
    }
  });

  it.each(['primary','secondary'])('%s 先取得來源波形，不等待 Proxy 與完整母素材驗證',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'source-wave',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
      primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:source-wave',audioSourceId:'source-wave'};
    State.clips=[owner];
    desktopMock.prepareSourceWaveform=vi.fn().mockResolvedValue({wave:'source-wave.wav',temporary:true,start:0,duration:1,complete:true,sourceKey:'source-key'});
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);
    const gate=deferred();desktopMock.ingest.mockReturnValue(gate.promise);
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>readyWave()}));
    const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],1,owner)
      :Media._clipIngest(owner,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(owner.peaks?.length).toBeGreaterThan(0));
      expect(Math.min(...owner.peaks)).toBeCloseTo(-0.5,3);
      expect(Math.max(...owner.peaks)).toBeCloseTo(0.5,3);
      await vi.waitFor(()=>expect(desktopMock.ingest).toHaveBeenCalledOnce());
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce();
      expect(desktopMock.cleanupAudio).toHaveBeenCalledWith('source-wave.wav');
      expect(Wave._sourceState(owner,false)?.mix.path).toBeNull();
    }finally{
      gate.resolve({channels:[]});await work;vi.unstubAllGlobals();
      delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it.each(['primary','secondary'])('%s 連續波形完成前逐步顯示，正式保存後才開始 Proxy',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'continuous-wave',name:'A.mov',path:'C:/A.mov',dur:2,in:0,out:2,offset:0,vtrack:0,
      primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:continuous-wave',audioSourceId:'continuous-wave'};
    State.clips=[owner];desktopMock.sourceWaveformContinuous=true;
    const gate=deferred();desktopMock.prepareSourceWaveform=vi.fn().mockReturnValue(gate.promise);
    desktopMock.ingest.mockResolvedValue({channels:[]});
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    const key='a'.repeat(16),peaks=Float32Array.from({length:200},(_,i)=>i%2?.5:-.25);
    const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],2,owner)
      :Media._clipIngest(owner,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce());
      const request=desktopMock.prepareSourceWaveform.mock.calls[0][0];expect(request.continuous).toBe(true);
      const data={sourceKey:key,startSample:0,completedSamples:4000,totalSamples:8000,sampleRate:4000,resolution:100,peaks};
      MediaIntakeJobs.progress({...request,stage:'source-waveform',pct:50,waveform:data});
      expect(owner.peaks).toEqual(peaks);expect(desktopMock.ingest).not.toHaveBeenCalled();
      MediaIntakeJobs.progress({...request,stage:'source-waveform',pct:100,waveform:{...data,startSample:4000,completedSamples:8000}});
      expect(owner.peaks).toHaveLength(400);expect(desktopMock.ingest).not.toHaveBeenCalled();
      gate.resolve({wave:'shared/wave.wav',temporary:false,start:0,duration:2,complete:true,sourceKey:key});
      await work;expect(desktopMock.ingest).toHaveBeenCalledOnce();
      expect(Wave._sourceState(owner,false)?.mix.path).toBe('shared/wave.wav');
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce();
    }finally{
      gate.resolve({});await work;delete desktopMock.prepareSourceWaveform;delete desktopMock.sourceWaveformContinuous;
    }
  });

  it('最後一批波形已顯示但尚未完成時取消，重試仍等待持久 WAV 證據',async()=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'cancel-full-wave',name:'A.mov',path:'C:/A.mov',dur:2,in:0,out:2,offset:0,vtrack:0,
      primary:true,audioSrc:'video',audioSourceId:'cancel-full-wave'};
    State.clips=[owner];desktopMock.sourceWaveformContinuous=true;
    const first=deferred(),second=deferred();
    desktopMock.prepareSourceWaveform=vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    desktopMock.ingest.mockResolvedValue({channels:[]});
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    const key='a'.repeat(16),peaks=Float32Array.from({length:400},(_,i)=>i%2?.5:-.25);
    const data={sourceKey:key,startSample:0,completedSamples:8000,totalSamples:8000,sampleRate:4000,resolution:100,peaks};
    const work=Media._bgAudioIngest(owner.path,[{channels:1}],2,owner);
    let retry;
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce());
      MediaIntakeJobs.progress({...desktopMock.prepareSourceWaveform.mock.calls[0][0],stage:'source-waveform',pct:100,waveform:data});
      expect(owner.peaks).toHaveLength(400);expect(desktopMock.ingest).not.toHaveBeenCalled();
      await Media.cancelProxyJobs();await work;
      retry=Media._bgAudioIngest(owner.path,[{channels:1}],2,owner);
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(2));
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      MediaIntakeJobs.progress({...desktopMock.prepareSourceWaveform.mock.calls[1][0],stage:'source-waveform',pct:100,waveform:data});
      second.resolve({wave:'shared/wave.wav',temporary:false,start:0,duration:2,complete:true,sourceKey:key});
      await retry;expect(desktopMock.ingest).toHaveBeenCalledOnce();
      expect(Wave._sourceState(owner,false)?.mix.path).toBe('shared/wave.wav');
    }finally{
      first.resolve({});second.resolve({});await retry;
      delete desktopMock.prepareSourceWaveform;delete desktopMock.sourceWaveformContinuous;
    }
  });

  it.each(['primary','secondary'])('%s 連續波形保存失敗時不接著啟動 Proxy',async kind=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'failed-continuous',name:'A.mov',path:'C:/A.mov',dur:2,in:0,out:2,offset:0,vtrack:0,
      primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:failed-continuous',audioSourceId:'failed-continuous'};
    State.clips=[owner];desktopMock.sourceWaveformContinuous=true;
    desktopMock.prepareSourceWaveform=vi.fn().mockRejectedValue(new Error('checkpoint write failed'));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      if(kind==='primary')await Media._bgAudioIngest(owner.path,[{channels:1}],2,owner);
      else await Media._clipIngest(owner,{audio:[{channels:1}]});
      expect(desktopMock.ingest).not.toHaveBeenCalled();expect(owner.peaks).toBeFalsy();
    }finally{warn.mockRestore();delete desktopMock.prepareSourceWaveform;delete desktopMock.sourceWaveformContinuous;}
  });

  it.each(['complete','short'])('正式來源波形遇短快取時重建：%s',async mode=>{
    resetAudioProject();Media.ensureCtx();
    const source={id:'short-cache',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
      audioSrc:'clip:short-cache',audioSourceId:'short-cache'};State.clips=[source];
    desktopMock.prepareSourceWaveform=vi.fn().mockResolvedValueOnce({wave:'cached.wav',cached:true,start:0,duration:1,sourceKey:'same'})
      .mockResolvedValueOnce({wave:'fresh.wav',temporary:true,start:0,duration:1,sourceKey:'same'});
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve(file));
    vi.stubGlobal('fetch',vi.fn(async file=>({arrayBuffer:async()=>readyWave(file==='cached.wav'||mode==='short'?.25:1)})));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      expect(await Media._prepareSourceWaveform(source,source.path,[{channels:1}],1)).toBe(mode==='complete');
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(2);
      expect(desktopMock.prepareSourceWaveform.mock.calls[1][0]).toMatchObject({ignoreCached:true,start:0});
      expect(desktopMock.cleanupAudio).toHaveBeenCalledExactlyOnceWith('fresh.wav');
      if(mode==='complete') expect(source.peaks.slice(-20).every(value=>Math.abs(value)>.4)).toBe(true);
      else expect(source.peaks).toBeFalsy();
    }finally{
      warn.mockRestore();vi.unstubAllGlobals();delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it('mpv 初開即載入有效波形，重 intake 仍保留原本的延後資格',async()=>{
    resetAudioProject();
    desktopMock.mpv={launch:vi.fn().mockResolvedValue({ok:true,duration:1}),quit:vi.fn().mockResolvedValue()};
    resetPlayerAdapter(desktopMock);
    desktopMock.prepareSourceWaveform=vi.fn().mockResolvedValue({wave:'warm-wave.wav',cached:true,start:0,duration:1,complete:true,sourceKey:'source-key'});
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>readyWave()}));
    try{
      await expect(Media._loadViaMpv('C:/A.mov',{duration:1,audio:[{channels:1}]},null,null,{deferInitialAudio:true})).resolves.toBe(true);
      await vi.waitFor(()=>expect(State.clips[0]?.peaks?.length).toBeGreaterThan(0));
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce();
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      expect(Media._deferredInitialAudioIngest).toBeTypeOf('function');
      expect(Wave._sourceState(State.clips[0],false)?.mix.path).toBe('warm-wave.wav');
    }finally{
      Media.reset();vi.unstubAllGlobals();delete desktopMock.prepareSourceWaveform;
    }
  });

  it('HTML 原生 MKV 也先顯示分段波形，再開始完整驗證，不重跑舊 waveAudio',async()=>{
    desktopMock.stat=vi.fn().mockResolvedValue({exists:true,size:1024});
    desktopMock.probe.mockResolvedValue({duration:61,video:{codec:'h264',fps:25,width:64,height:48},audio:[{channels:1}]});
    desktopMock.waveAudio=vi.fn().mockResolvedValue('legacy.wav');
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);
    desktopMock.ingest.mockResolvedValue({channels:[]});
    const first=deferred(),middle=deferred(),gate=deferred();desktopMock.prepareSourceWaveform=vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(middle.promise)
      .mockReturnValueOnce(gate.promise);
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>readyWave(url.endsWith('native-first.wav')?5:url.endsWith('native-middle.wav')?55:1)})));
    domMock.video.readyState=1;domMock.video.duration=61;
    let loaded=false;
    const loading=Media.loadDesktopMedia('C:/native.mkv').then(()=>{loaded=true;});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce());
      await vi.waitFor(()=>expect(loaded).toBe(true));
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      expect(desktopMock.prepareSourceWaveform.mock.calls[0][0]).toMatchObject({start:0,length:5});
      first.resolve({wave:'native-first.wav',temporary:true,start:0,duration:5,sourceKey:'native'});
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(2));
      expect(State.clips[0].peaks).toHaveLength(5*100*2);
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      expect(desktopMock.waveAudio).not.toHaveBeenCalled();
      expect(desktopMock.prepareSourceWaveform.mock.calls[1][0]).toMatchObject({start:5,length:55});
      middle.resolve({wave:'native-middle.wav',temporary:true,start:5,duration:55,sourceKey:'native'});
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(3));
      expect(State.clips[0].peaks).toHaveLength(60*100*2);
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      gate.resolve({wave:'native-last.wav',temporary:true,start:60,duration:1,sourceKey:'native'});
      await vi.waitFor(()=>expect(State.clips[0].peaks).toHaveLength(61*100*2));
      await vi.waitFor(()=>expect(desktopMock.ingest).toHaveBeenCalledOnce());
    }finally{
      first.resolve({});middle.resolve({});gate.resolve({});await loading;
      await Promise.all([...Media._sourceWavePreparations.values()].map(entry=>entry.promise));
      vi.unstubAllGlobals();
      delete desktopMock.stat;delete desktopMock.waveAudio;delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it('同母素材切片共用優先波形，刪除原片段後由存續片段接收完成結果',async()=>{
    resetAudioProject();Media.ensureCtx();
    const first={id:'first',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:0.5,offset:0,vtrack:0,
      audioSrc:'clip:shared',audioSourceId:'shared'};
    const second={...first,id:'second',in:0.5,out:1,offset:0.5};State.clips=[first,second];
    const gate=deferred();desktopMock.prepareSourceWaveform=vi.fn().mockReturnValue(gate.promise);
    desktopMock.ingest.mockResolvedValue({channels:[]});
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>readyWave()}));
    const one=Media._clipIngest(first,{audio:[{channels:1}]}),two=Media._clipIngest(second,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce());
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      State.clips=[second];gate.resolve({wave:'shared.wav',cached:true,start:0,duration:1,complete:true,sourceKey:'source-key'});await Promise.all([one,two]);
      expect(first.peaks).toBeUndefined();
      expect(Math.max(...second.peaks)).toBeCloseTo(0.5,3);
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce();
    }finally{
      gate.resolve({});await Promise.all([one,two]);vi.unstubAllGlobals();delete desktopMock.prepareSourceWaveform;
    }
  });

  it.each([['primary','cancel'],['secondary','cancel'],['primary','reset'],['secondary','reset']])(
    '%s 優先波形在 %s 後不啟動重 intake，晚到暫存須清理',async(kind,mutation)=>{
    resetAudioProject();Media.ensureCtx();
    const owner={id:'cancel-wave',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
      primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:cancel-wave',audioSourceId:'cancel-wave'};
    State.clips=[owner];
    const gate=deferred();desktopMock.prepareSourceWaveform=vi.fn().mockReturnValue(gate.promise);
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);
    const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],1,owner)
      :Media._clipIngest(owner,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce());
      if(mutation==='reset') Media.reset();
      else await Media.cancelProxyJobs();
      await work;
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      gate.resolve({wave:'cancelled.wav',temporary:true});
      await vi.waitFor(()=>expect(desktopMock.cleanupAudio).toHaveBeenCalledWith('cancelled.wav'));
      expect(owner.peaks).toBeUndefined();
      expect(Wave._sourceState(owner,false)).toBeNull();
    }finally{
      gate.resolve({});await work;delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it('已有有效波形略過優先抽取，失敗時仍交由正常 ingest 補齊',async()=>{
    resetAudioProject();Media.ensureCtx();
    const source={id:'ready',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
      audioSrc:'clip:ready',audioSourceId:'ready',peaks:new Float32Array(200).fill(0.3)};State.clips=[source];
    desktopMock.prepareSourceWaveform=vi.fn().mockRejectedValue(new Error('wave unavailable'));
    desktopMock.ingest.mockResolvedValue({channels:[]});
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      await Media._clipIngest(source,{audio:[{channels:1}]});
      expect(desktopMock.prepareSourceWaveform).not.toHaveBeenCalled();
      source.peaks=null;
      await Media._clipIngest(source,{audio:[{channels:1}]});
      expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledOnce();
      expect(desktopMock.ingest).toHaveBeenCalledTimes(2);
    }finally{warn.mockRestore();delete desktopMock.prepareSourceWaveform;}
  });

  it.each([false,true])('來源分段先顯示真正時間範圍，換素材=%s 時禁止混合不同來源',async changed=>{
    resetAudioProject();Media.ensureCtx();
    const source={id:'segments',name:'long.mov',path:'C:/long.mov',dur:61,in:0,out:61,offset:0,vtrack:0,
      audioSrc:'clip:segments',audioSourceId:'segments'};State.clips=[source];
    const gate=deferred();desktopMock.prepareSourceWaveform=vi.fn()
      .mockResolvedValueOnce({wave:'first.wav',temporary:true,start:0,duration:5,complete:false,sourceKey:'original'})
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce({wave:'last.wav',temporary:true,start:60,duration:1,complete:false,sourceKey:'original'});
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);
    desktopMock.ingest.mockResolvedValue({channels:[]});
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>url.endsWith('first.wav')?readyWave(5):readyWave(url.endsWith('middle.wav')?55:1,8192)})));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const work=Media._clipIngest(source,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(2));
      expect(source.peaks).toHaveLength(5*100*2);
      expect(Math.max(...source.peaks)).toBeCloseTo(0.5,3);
      expect(desktopMock.ingest).not.toHaveBeenCalled();
      expect(desktopMock.prepareSourceWaveform.mock.calls[1][0]).toMatchObject({start:5,length:55,duration:61});
      const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
      expect(MediaIntakeJobs.snapshot().jobs.find(job=>job.progress?.overall)?.progress.pct).toBeCloseTo(5/61*100,4);
      gate.resolve({wave:'middle.wav',temporary:true,start:5,duration:55,complete:false,sourceKey:changed?'replacement':'original'});
      await work;
      if(changed){
        expect(source.peaks).toBeNull();
        expect(Wave._sourceState(source,false)?.mix.peaks).toBeNull();
      }else{
        expect(source.peaks).toHaveLength(61*100*2);
        expect(source.peaks[60*100*2]).toBeCloseTo(-0.25,3);
        expect(source.peaks[60*100*2+1]).toBeCloseTo(0.25,3);
      }
      expect(desktopMock.cleanupAudio).toHaveBeenCalledWith('first.wav');
      expect(desktopMock.cleanupAudio).toHaveBeenCalledWith('middle.wav');
      if(!changed)expect(desktopMock.cleanupAudio).toHaveBeenCalledWith('last.wav');
      expect(desktopMock.ingest).toHaveBeenCalledOnce();
    }finally{
      gate.resolve({});await work;warn.mockRestore();vi.unstubAllGlobals();
      delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it('分段期間真正切片複製的較早波形，也必須在來源變更後撤回',async()=>{
    resetAudioProject();Media.ensureCtx();State.videoTracks=[{visible:true}];
    const source={id:'split-wave',name:'long.mov',path:'C:/long.mov',dur:121,in:0,out:121,offset:0,vtrack:0,
      audioSrc:'clip:split-wave',audioSourceId:'split-wave'};State.clips=[source];
    const second=deferred(),third=deferred();desktopMock.prepareSourceWaveform=vi.fn()
      .mockResolvedValueOnce({wave:'one.wav',temporary:true,start:0,duration:5,sourceKey:'original'})
      .mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    desktopMock.cleanupAudio=vi.fn().mockResolvedValue(true);desktopMock.ingest.mockResolvedValue({channels:[]});
    desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>readyWave(url.endsWith('one.wav')?5:55)})));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const work=Media._clipIngest(source,{audio:[{channels:1}]});
    try{
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(2));
      expect(Media.splitClipAt(30)).toBe(true);
      const right=State.clips.find(clip=>clip!==source),firstPeaks=right.peaks;
      second.resolve({wave:'two.wav',temporary:true,start:5,duration:55,sourceKey:'original'});
      await vi.waitFor(()=>expect(desktopMock.prepareSourceWaveform).toHaveBeenCalledTimes(3));
      expect(source.peaks).not.toBe(firstPeaks);expect(right.peaks).toBe(firstPeaks);
      third.resolve({wave:'new-source.wav',temporary:true,start:60,duration:60,sourceKey:'replacement'});
      await work;
      expect(source.peaks===null).toBe(true);expect(right.peaks===null).toBe(true);
      expect(Wave.getSourceWaveform(right,right.peaks).peaks).toBeNull();
    }finally{
      second.resolve({});third.resolve({});await work;warn.mockRestore();vi.unstubAllGlobals();
      delete desktopMock.prepareSourceWaveform;delete desktopMock.cleanupAudio;
    }
  });

  it.each([['primary','reset'],['secondary','reset'],['primary','replace'],['secondary','replace']])(
    '%s 的並行波形讀取在 %s 後不可發布至新來源',async(kind,mutation)=>{
      resetAudioProject();Media.ensureCtx();
      const owner={id:'wave-late',name:'A.mov',path:'C:/A.mov',dur:1,in:0,out:1,offset:0,vtrack:0,
        primary:kind==='primary',audioSrc:kind==='primary'?'video':'clip:wave-late',audioSourceId:'late-source'};
      State.clips=[owner];
      desktopMock.ingest.mockResolvedValue({cached:true,channels:[{file:'channel.m4a',sourceStream:0,sourceChannel:0}],wave:'late.wav'});
      desktopMock.fileURL.mockImplementation(file=>Promise.resolve('file:///'+file));
      const gate=deferred(),read=vi.fn().mockReturnValue(gate.promise);
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:read}));
      const audio=vi.spyOn(Media._intakeSession,'materializeAudioElements').mockResolvedValue([]);
      const parse=vi.spyOn(Wave,'calcFromWavAsync');
      const work=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],1,owner)
        :Media._clipIngest(owner,{audio:[{channels:1}]});
      try{
        await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
        if(mutation==='reset') Media.reset();
        const replacement={...owner,name:'B.mov',path:'C:/B.mov'};
        State.clips=[replacement];
        const nextPeaks=new Float32Array([-0.25,0.25]);
        replacement.peaks=Wave.setSourceMixPeaks(replacement,nextPeaks,{mixPath:'next.wav'});
        gate.resolve(readyWave());await work;
        expect(parse).not.toHaveBeenCalled();
        expect(owner.peaks).toBeUndefined();
        expect(replacement.peaks).toBe(nextPeaks);
        expect(Wave._sourceState(replacement,false)?.mix).toMatchObject({path:'next.wav',peaks:nextPeaks});
      }finally{
        gate.resolve(readyWave());await work;audio.mockRestore();parse.mockRestore();vi.unstubAllGlobals();
      }
    });

  it('解除切割影片保留兩段的效果與原淡化視窗',async()=>{
    resetAudioProject();
    const left={id:'left',name:'A.mov',path:'C:/A.mov',dur:10,in:0,out:5,offset:0,vtrack:0,
      audioSrc:'video',audioSourceId:'mother',fadeIn:8,fadeOut:3,fadeSourceOffset:0,fadeSourceLength:10,
      hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12,inputBoost:0}};
    const right={...left,id:'right',in:5,out:10,offset:5,fadeSourceOffset:5};State.clips=[left,right];
    const cache=vi.spyOn(Media,'_addDesktopCachedAudio').mockImplementation(async(path,restore)=>Media.createExternalAudioSource({...restore,path,fallbackCount:1}));
    try{
      const result=await Media.detachClipAudio('left');
      expect(result).toHaveLength(2);
      expect(result.map(asset=>asset.fadeSourceOffset)).toEqual([0,5]);
      for(const asset of result) expect(asset).toMatchObject({fadeIn:8,fadeOut:3,fadeSourceLength:10,hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12},path:'C:/A.mov'});
      expect(State.clips.every(item=>item.audioDetached)).toBe(true);
    }finally{cache.mockRestore();}
  });
  it.each(['loadfile','mute','direction'])('reset 撤銷倒放 %s 之後的 continuation，不污染下一個來源',async stage=>{
    const gate=deferred();
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'old-session'}),quit:vi.fn().mockResolvedValue(),
      loadfile:vi.fn(()=>stage==='loadfile'?gate.promise:Promise.resolve({ok:true,sourceSessionId:'proxy-session'})),
      mute:vi.fn(()=>stage==='mute'?gate.promise:Promise.resolve()),
      direction:vi.fn(()=>stage==='direction'?gate.promise:Promise.resolve(true)),seek:vi.fn().mockResolvedValue(true),
    };
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'old.mov'});
    expect(runtime.ownsNativeSourcePath('old.mov')).toBe(true);
    State.clips=[{id:'old',path:'old.mov',in:0,out:5,dur:5,offset:0,primary:true}];
    Media.activeClipId='old';Media._gap=false;
    Media._reverseProxyPath='proxy.mov';Media._reverseProxySourcePath='old.mov';
    Media._mpvPath='old.mov';
    const switching=Media.setPlaybackDirection('backward');
    await vi.waitFor(()=>expect(bridge[stage]).toHaveBeenCalled());
    if(stage==='loadfile')expect(runtime.ownsNativeSourcePath('old.mov')).toBe(false);
    if(stage==='mute')expect(runtime.ownsNativeSourcePath('old.mov')).toBe(true);
    if(stage==='direction')expect(runtime.ownsNativeSourcePath('proxy.mov')).toBe(true);
    Media.reset();
    Media._mpvPath='new.mov';
    gate.resolve({ok:true,sourceSessionId:'proxy-session'});
    await expect(switching).resolves.toBe(false);
    expect(Media._mpvPath).toBe('new.mov');
    expect(Media._nativeReverse).toBe(false);
    expect(bridge.direction).toHaveBeenCalledTimes(stage==='direction'?1:0);
    expect(bridge.seek).toHaveBeenCalledTimes(stage==='direction'?1:0);
  });
  it.each([2,3])('V%s 影片切割保留效果/幾何/seek profile與原淡化窗口，snapshot可還原',async trackNumber=>{
    const vtrack=trackNumber-1;
    const {Seq}=await import('../src/sequence.js');
    const {fadeAlphaAtTimeline}=await import('../src/image-compositor-engine.js');
    State.fps=25;State.dropFrame=false;
    State.videoTracks=[{visible:true},{visible:true},{visible:true}];
    const original=Seq.add({name:'video',path:'source.mov',dur:10,in:0,out:10,offset:0,vtrack,
      natW:1920,natH:1080,height:96,
      scale:0.4,posX:0.2,posY:0.3,muted:true,mpvExactSeek:true,mpvSeekOffset:0.02,
      hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12,inputBoost:0},fadeIn:6,fadeOut:6});
    const originalAlpha=fadeAlphaAtTimeline(original,5);
    expect(Media.splitClipAt(5)).toBe(true);
    const right=State.clips.find(clip=>clip!==original);
    expect(right).toMatchObject({vtrack,natW:1920,natH:1080,height:96,scale:0.4,posX:0.2,posY:0.3,muted:true,mpvExactSeek:true,mpvSeekOffset:0.02,
      hasAudioLimiter:true,audioLimiterSpec:{max:-6},fadeSourceOffset:5,fadeSourceLength:10});
    expect(fadeAlphaAtTimeline(original,5)).toBeCloseTo(originalAlpha);
    expect(fadeAlphaAtTimeline(right,5)).toBeCloseTo(originalAlpha);
    const saved=Seq.snapshot();
    right.scale=2;right.height=140;right.locked=true;right.muted=false;right.mpvSeekOffset=8;delete right.fadeSourceLength;
    Seq.restore(saved);
    expect(Seq.byId(right.id)).toMatchObject({scale:0.4,height:96,locked:false,muted:true,mpvSeekOffset:0.02,fadeSourceLength:10});
    delete saved.find(clip=>clip.id===right.id).height;
    Seq.restore(saved);
    expect(Seq.byId(right.id).height).toBeUndefined();
  });
  it('倒放Proxy尚在load時切回正放，先等load完成再恢復母素材',async()=>{
    const gate=deferred();
    const bridge={launch:vi.fn().mockResolvedValue({ok:true,sourceSessionId:'mother-session'}),quit:vi.fn().mockResolvedValue(),
      loadfile:vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ok:true,sourceSessionId:'mother-reloaded'}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),seek:vi.fn().mockResolvedValue(true),
    };
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'mother.mov'});
    expect(runtime.ownsNativeSourcePath('mother.mov')).toBe(true);
    State.clips=[{id:'v',path:'mother.mov',in:0,out:5,dur:5,offset:0,primary:true}];
    Media.activeClipId='v';Media._gap=false;
    Media._reverseProxyPath='proxy.mov';Media._reverseProxySourcePath='mother.mov';
    const reverse=Media.setPlaybackDirection('backward');
    await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith('proxy.mov'));
    const forward=Media.setPlaybackDirection('forward');
    expect(bridge.direction).not.toHaveBeenCalled();
    gate.resolve({ok:true,sourceSessionId:'proxy-session'});
    await expect(reverse).resolves.toBe(false);
    await expect(forward).resolves.toBe(true);
    expect(bridge.loadfile.mock.calls.map(([path])=>path)).toEqual(['proxy.mov','mother.mov']);
    expect(bridge.direction).toHaveBeenCalledExactlyOnceWith('forward');
    expect(Media._nativeReverse).toBe(false);expect(Media._mpvPath).toBe('mother.mov');
    expect(runtime.ownsNativeSourcePath('mother.mov')).toBe(true);
  });
  beforeAll(async () => {
    window.subtool = desktopMock;
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 32 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelMerger(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      decodeAudioData(){ return Promise.resolve({
        duration: 1, numberOfChannels: 1, sampleRate: 100,
        getChannelData: () => new Float32Array(100),
      }); }
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.clips = [];
    desktopMock.fileURL.mockReset();
    desktopMock.ingest.mockReset();
    desktopMock.probe.mockReset();
    desktopMock.probe.mockResolvedValue({ duration: 8, audio: [{ channels: 1 }] });
    eventMock.emit.mockClear();
    domMock.video.src = '';
    domMock.video.readyState = 0;
    domMock.video.duration = 5;
    domMock.video.resetEvents();
    delete desktopMock.mpv;
    resetPlayerAdapter(desktopMock);
  });

  describe('secondary runtime completion and restoration retry', () => {
    const clip = (overrides={}) => ({
      id:'retry-runtime',name:'retry.mov',path:'C:/retry.mov',web:{url:'file:///retry.mov'},
      dur:8,in:0,out:8,offset:0,vtrack:0,audioSrc:'clip:retry-runtime',audioSourceId:'retry-source',...overrides,
    });
    const result = {channels:[{file:'C:/cache/retry.m4a',sourceStream:0,sourceChannel:0}]};
    function readyAudio(){
      vi.stubGlobal('Audio',class {
        constructor(){this.readyState=1;this.src='';this.duration=8;this.pause=vi.fn();this.load=vi.fn();this.events=new EventTarget();}
        addEventListener(...args){this.events.addEventListener(...args);}
        removeEventListener(...args){this.events.removeEventListener(...args);}
        removeAttribute(name){if(name==='src')this.src='';}
      });
      desktopMock.fileURL.mockImplementation(async path=>'file:///'+path);
    }

    it('retries a failed shared source through sequence restoration and installs its audio',async()=>{
      readyAudio();
      const first=clip(),split=clip({id:'retry-split',offset:8});State.clips=[first,split];
      const gate=deferred();desktopMock.ingest.mockReturnValueOnce(gate.promise).mockResolvedValue(result);
      const seek=vi.spyOn(Media,'seek').mockResolvedValue({status:'presented'});
      try{
        const a=Media.ensureClipRuntime(first,{audio:[{channels:1}]}),b=Media.ensureClipRuntime(split,{audio:[{channels:1}]});
        expect(a).toBe(b);expect(desktopMock.ingest).toHaveBeenCalledOnce();
        gate.reject(new Error('temporary native encode failure'));await Promise.all([a,b]);
        expect(Media.tracks).toHaveLength(0);
        await Media.restoreSequenceEditState(0);
        expect(desktopMock.ingest).toHaveBeenCalledTimes(2);
        expect(Media.sourceChannels(first.audioSrc)).toEqual([expect.objectContaining({file:'C:/cache/retry.m4a',audioSourceId:first.audioSourceId})]);
      }finally{seek.mockRestore();Media.reset();vi.unstubAllGlobals();}
    });

    it('keeps a successfully prepared silent source complete across repeated restorations',async()=>{
      const source=clip();State.clips=[source];desktopMock.ingest.mockResolvedValue({channels:[]});
      const seek=vi.spyOn(Media,'seek').mockResolvedValue({status:'presented'});
      try{
        await Media.ensureClipRuntime(source,{audio:[]});
        await Media.restoreSequenceEditState(0);await Media.restoreSequenceEditState(0);
        expect(desktopMock.ingest).toHaveBeenCalledOnce();expect(Media.tracks).toHaveLength(0);
      }finally{seek.mockRestore();Media.reset();}
    });

    it('allows a cancelled source to retry while discarding the old native result',async()=>{
      readyAudio();
      const source=clip();State.clips=[source];
      const gate=deferred();desktopMock.ingest.mockReturnValueOnce(gate.promise).mockResolvedValue(result);
      const seek=vi.spyOn(Media,'seek').mockResolvedValue({status:'presented'});
      const {setStatus}=await import('../src/ui.js');
      setStatus.mockClear();
      try{
        const work=Media.ensureClipRuntime(source,{audio:[{channels:1}]});
        expect(await Media.cancelProxyJobs()).toBe(true);await work;
        gate.resolve({proxy:'C:/cache/stale.mp4',channels:result.channels});await Promise.resolve();
        expect(source.proxyUrl).toBeUndefined();expect(Media.tracks).toHaveLength(0);
        expect(setStatus.mock.calls.some(([message])=>String(message).startsWith('影片音訊抽取失敗'))).toBe(false);
        await Media.restoreSequenceEditState(0);
        expect(desktopMock.ingest).toHaveBeenCalledTimes(2);expect(Media.sourceChannels(source.audioSrc)).toHaveLength(1);
      }finally{seek.mockRestore();Media.reset();vi.unstubAllGlobals();}
    });

    it('cannot install a previous project result into a recreated source with the same identity',async()=>{
      readyAudio();
      const old=clip();State.clips=[old];
      const gate=deferred();desktopMock.probe.mockReturnValueOnce(gate.promise);
      const seek=vi.spyOn(Media,'seek').mockResolvedValue({status:'presented'});
      try{
        const work=Media.ensureClipRuntime(old);Media.reset();
        const current=clip();State.clips=[current];desktopMock.ingest.mockResolvedValue(result);
        gate.resolve({audio:[{channels:1}]});await work;
        expect(desktopMock.ingest).not.toHaveBeenCalled();expect(Media.tracks).toHaveLength(0);
        await Media.restoreSequenceEditState(0);
        expect(desktopMock.ingest).toHaveBeenCalledOnce();expect(Media.sourceChannels(current.audioSrc)).toHaveLength(1);
      }finally{seek.mockRestore();Media.reset();vi.unstubAllGlobals();}
    });
  });

  it('drops a late external-audio metadata result after project reset', async () => {
    const audios = [];
    class PendingAudio {
      constructor(){
        this.readyState = 0; this.src = ''; this.preload = ''; this.duration = 8;
        this._target = new EventTarget(); this.pause = vi.fn(); this.load = vi.fn();
        audios.push(this);
      }
      addEventListener(...args){ this._target.addEventListener(...args); }
      removeEventListener(...args){ this._target.removeEventListener(...args); }
      removeAttribute(name){ if (name === 'src') this.src = ''; }
      dispatch(type){ this._target.dispatchEvent(new Event(type)); }
    }
    const oldAudio = globalThis.Audio;
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    vi.stubGlobal('Audio', PendingAudio);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:late-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    try {
      const pending = Media.addAudioFile({ name: 'A.wav', size: 100 });
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      Media.reset();
      audios[0].dispatch('loadedmetadata');

      await expect(pending).resolves.toBeNull();
      expect(State.externalAudioState).toEqual([]);
      expect(Media.externalAudioSources).toEqual([]);
      expect(Media.tracks).toEqual([]);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-audio');
    } finally {
      vi.unstubAllGlobals();
      if (oldAudio) globalThis.Audio = oldAudio;
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate);
      else delete URL.createObjectURL;
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke);
      else delete URL.revokeObjectURL;
    }
  });

  it.each([
    {in:0,out:0,height:128},
    {in:4,out:8,offset:4,height:96,fadeIn:6,fadeOut:6,fadeSourceOffset:4,fadeSourceLength:8},
  ])('刪除並由 History 重建外部快取音訊保留高度/範圍/原淡化視窗，舊 scrub voice 已停止 %#', async savedFields => {
    const { scheduleScrub } = await import('../src/audio-engine.js');
    class ReadyAudio {
      constructor(){
        this.tagName='AUDIO'; this.readyState=1; this.src=''; this.duration=8;
        this.pause=vi.fn(); this.load=vi.fn();
      }
      removeAttribute(name){ if(name==='src') this.src=''; }
    }
    vi.stubGlobal('Audio',ReadyAudio);
    desktopMock.fileURL.mockImplementation(async path=>'file:///'+path);
    desktopMock.ingest.mockResolvedValue({channels:[{file:'cache.m4a',sourceStream:0,sourceChannel:0}]});
    const clone={src:'',readyState:0,play:vi.fn(),pause:vi.fn()};
    const create=vi.spyOn(document,'createElement').mockReturnValue(clone);
    try{
      const saved={audioSourceId:'restored',path:'C:/voice.mov',name:'voice',duration:8,
        ...savedFields,preferCache:true};
      const asset=await Media.restoreExternalAudioSource(saved);
      expect(asset).toMatchObject({audioSourceId:'restored',...savedFields});
      const oldElement=Media.tracks[0].el;
      scheduleScrub(oldElement,1);
      const lateMetadata=clone.onloadedmetadata;
      expect(Media.removeExternalAudio(asset.id,{record:false})).toBe(true);
      lateMetadata();
      expect(clone.pause).toHaveBeenCalledOnce();
      expect(clone.play).not.toHaveBeenCalled();
      expect(clone.src).toBe('');

      Media.restoreExternalAudioEditState([saved]);
      await vi.waitFor(()=>expect(Media.externalAudioSources).toHaveLength(1));
      await vi.waitFor(()=>expect(Media.tracks).toHaveLength(1));
      expect(Media.externalAudioSources[0]).toMatchObject({audioSourceId:'restored',...savedFields});
      expect(State.externalAudioState[0]).toMatchObject(savedFields);
      expect(Media.tracks[0].el).not.toBe(oldElement);
    }finally{Media.reset();create.mockRestore();vi.unstubAllGlobals();}
  });

  it('does not recreate a removed audio asset waveform after late file decode', async () => {
    const readers = [];
    class ControlledFileReader {
      constructor(){ this.result = null; this.onload = null; this.onerror = null; readers.push(this); }
      readAsArrayBuffer(){}
    }
    class ReadyAudio {
      constructor(){
        this.readyState = 1; this.src = ''; this.preload = ''; this.duration = 8;
        this._target = new EventTarget(); this.pause = vi.fn(); this.load = vi.fn();
      }
      addEventListener(...args){ this._target.addEventListener(...args); }
      removeEventListener(...args){ this._target.removeEventListener(...args); }
      removeAttribute(name){ if (name === 'src') this.src = ''; }
    }
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    vi.stubGlobal('FileReader', ControlledFileReader);
    vi.stubGlobal('Audio', ReadyAudio);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:removed-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const originalFromFile = Wave.fromFile.bind(Wave);
    let waveformWork = null;
    const fromFile = vi.spyOn(Wave, 'fromFile').mockImplementation((...args) => {
      waveformWork = originalFromFile(...args);
      return waveformWork;
    });

    try {
      const asset = await Media.addAudioFile({ name: 'late.wav', size: 100 });
      expect(asset).not.toBeNull();
      expect(readers).toHaveLength(1);
      expect(Media.removeExternalAudio(asset.id, { record: false })).toBe(true);
      const durationAfterRemove = State.duration;

      readers[0].result = new ArrayBuffer(64);
      readers[0].onload();
      await expect(waveformWork).resolves.toBe(false);

      expect(Wave._sourceState(asset, false)).toBeNull();
      expect(State.duration).toBe(durationAfterRemove);
    } finally {
      fromFile.mockRestore();
      vi.unstubAllGlobals();
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate);
      else delete URL.createObjectURL;
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke);
      else delete URL.revokeObjectURL;
    }
  });

  it('restores native video audio after the last external mix source is deleted', () => {
    const asset = Media.createExternalAudioSource({
      name: 'reference.wav', path: 'C:/audio/reference.wav', duration: 8,
      in: 0, out: 8, offset: 0, fallbackCount: 1,
    });
    const element = { pause: vi.fn(), src: 'file:///reference.wav' };
    const gain = { disconnect: vi.fn(), gain: { value: 1 } };
    Media.tracks = [{
      id: 'external-track', kind: 'element', source: asset.audioSrc,
      el: element, gain, muted: false, solo: false, volume: 1,
      audioSourceId: asset.audioSourceId,
    }];
    domMock.video.src = 'file:///picture.mp4';
    domMock.video.muted = true;

    expect(Media.removeExternalAudio(asset.id, { record: false })).toBe(true);

    expect(Media.tracks).toEqual([]);
    expect(domMock.video.muted).toBe(false);
  });

  it('mutes mpv immediately when the active clip audio is detached', async () => {
    const mute = vi.fn().mockResolvedValue(undefined);
    desktopMock.mpv = { mute, launch: vi.fn().mockResolvedValue({ ok: true, duration: 8 }) };
    const runtime = resetPlayerAdapter(desktopMock);
    await runtime.enterMpv({ src: 'C:/media/picture.mov', bounds: { x: 0, y: 0, w: 640, h: 360 }, audio: [] });
    const clip = {
      id: 'detached-video', name: 'picture.mov', path: 'C:/media/picture.mov',
      dur: 8, in: 0, out: 8, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-picture', audioDetached: true,
    };
    State.clips = [clip];
    Media.activeClipId = clip.id;
    Media._applyClipAudio(clip, 0);
    await Promise.resolve();

    expect(mute).toHaveBeenCalledWith(true);
  });

  it('does not cancel primary audio preparation when an unrelated image is deleted', () => {
    const primary = {
      id: 'primary-video', name: 'picture.mov', path: 'C:/media/picture.mov',
      dur: 8, in: 0, out: 8, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-picture',
    };
    const image = {
      id: 'overlay-image', name: 'card.png', path: 'C:/media/card.png',
      type: 'image', dur: 4, in: 0, out: 4, offset: 1, vtrack: 1,
    };
    const pending = [{ id: 'pending-primary-channel' }];
    const ingestDone = vi.fn();
    State.clips = [primary, image];
    Media.pendingChannels = pending;
    Media._ingestDoneHandler = ingestDone;

    expect(Media.removeClip(image.id)).toBe(true);

    expect(Media.pendingChannels).toBe(pending);
    expect(Media._ingestDoneHandler).toBe(ingestDone);
  });

  it('cancels an older history audio restore when redo replaces its snapshot', async () => {
    const urlGate = deferred();
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    const restoreSpy = vi.spyOn(Media, 'restoreExternalAudioSource');

    Media.restoreExternalAudioEditState([{
      audioSourceId: 'history-A', timelineLaneId: 'history-A', name: 'A.wav',
      path: 'C:/audio/A.wav', duration: 8, in: 0, out: 8, offset: 0,
    }]);
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('C:/audio/A.wav'));
    const staleRestore = restoreSpy.mock.results[0].value;

    Media.restoreExternalAudioEditState([]);
    urlGate.resolve('file:///C:/audio/A.wav');
    await staleRestore;

    expect(Media.externalAudioSources).toEqual([]);
    expect(State.externalAudioState).toEqual([]);
    restoreSpy.mockRestore();
  });

  it('does not expose an optimistic half-clip while an external-audio split is pending', async () => {
    const rightGate = deferred();
    const asset = Media.createExternalAudioSource({
      name: 'dialog.wav', path: 'C:/audio/dialog.wav', duration: 8,
      in: 0, out: 8, offset: 0, fallbackCount: 1,
    });
    const addRight = vi.spyOn(Media, 'addAudioFileDesktop').mockReturnValue(rightGate.promise);

    const splitting = Media.splitExternalAudio(asset.id, 4);
    await vi.waitFor(() => expect(addRight).toHaveBeenCalledTimes(1));
    expect(asset.out).toBe(8);
    Media.moveExternalAudio(asset.id, 2);
    rightGate.resolve(null);
    await expect(splitting).resolves.toBeNull();

    expect(asset.offset).toBe(2);
    expect(asset.out).toBe(8);
    expect(Media.externalAudioSources).toEqual([asset]);
    addRight.mockRestore();
  });

  it('cancels detach when a new split placement joins the source during cache work', async () => {
    const cacheGate = deferred();
    const clip = {
      id: 'detach-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A', audioDetached: false,
    };
    State.clips = [clip];
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockReturnValue(cacheGate.promise);

    const detaching = Media.detachClipAudio(clip.id);
    await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1));
    expect(Media.splitClipAt(2.5)).toBe(true);
    cacheGate.resolve({ id: 'late-external', audioSourceId: 'external-A' });
    await expect(detaching).resolves.toBeNull();

    expect(State.clips).toHaveLength(2);
    expect(State.clips.every(item => item.audioDetached !== true)).toBe(true);
    cache.mockRestore();
  });

  it.each([
    ['offset', clip => { clip.offset = 3; }],
    ['trim', clip => { clip.in = 1; clip.out = 4; }],
    ['speed', clip => { clip.speed = 2; }],
    ['reverse', clip => { clip.reverse = true; }],
    ['track', clip => { clip.vtrack = 1; }],
    ['source', clip => { clip.audioSrc = 'clip:replacement'; }],
    ['mother', clip => { clip._originalPath = 'C:/media/replacement.mov'; }],
    ['fade', clip => { clip.fadeIn = 1; }],
    ['effect', clip => { clip.hasAudioLimiter = true; clip.audioLimiterSpec = { max: -6, min: -12 }; }],
    ['detached', clip => { clip.audioDetached = true; }],
  ])('解除影音等待期間同一物件的 %s 被修改，只撤銷本次建立的外音', async (_name, change) => {
    resetAudioProject();
    const cacheGate = deferred();
    const clip = {
      id: 'detach-owned', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A', audioDetached: false,
    };
    State.clips = [clip];
    State.videoTracks = [{ visible: true }, { visible: true }];
    const existing = Media.createExternalAudioSource({ name: '背景原音', path: 'C:/media/background.wav', duration: 2 });
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockImplementation(async (path, restore) => {
      await cacheGate.promise;
      return Media.createExternalAudioSource({ ...restore, path, fallbackCount: 1 });
    });
    try {
      const detaching = Media.detachClipAudio(clip.id);
      await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1));
      change(clip);
      const expected = JSON.stringify(clip);
      eventMock.emit.mockClear();
      cacheGate.resolve();

      await expect(detaching).resolves.toBeNull();
      expect(JSON.stringify(clip)).toBe(expected);
      expect(Media.externalAudioSources).toEqual([existing]);
      expect(eventMock.emit.mock.calls.filter(([type]) => type === 'history:record')).toEqual([]);
    } finally { cache.mockRestore(); }
  });

  it.each([1, 2])('解除影音第 %i 份音訊等待時提交來源配線，撤銷整批外音並保留新配線', async editAt => {
    resetAudioProject();
    const { AudioPipeline, AudioRoutingModel } = await import('../src/audio-routing-engine.js');
    const first = { id: 'detach-routing-first', name: 'A.mov', path: 'C:/media/A.mov', dur: 10,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true, audioSrc: 'video', audioSourceId: 'source-routing' };
    const second = { ...first, id: 'detach-routing-second', primary: false, in: 5, out: 10, offset: 5 };
    State.clips = [first, second]; State.videoTracks = [{ visible: true }];
    AudioPipeline.registerSource(first, [{ sourceStream: 0, sourceChannel: 0 }, { sourceStream: 0, sourceChannel: 1 }], 2);
    const gate = deferred(); let calls = 0;
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockImplementation(async (path, restore) => {
      if (++calls === editAt) await gate.promise;
      return Media.createExternalAudioSource({ ...restore, path, fallbackCount: 2 });
    });
    try {
      const work = Media.detachClipAudio(first.id);
      await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(editAt));
      const editor = AudioRoutingModel.editProject(State.audioProject, { preview: draft => { State.audioProject = draft; } });
      const buses = State.audioProject.buses;
      editor.setRoutes(first.audioSourceId, [
        { sourceStream: 0, sourceChannel: 0, busId: buses[1].id },
        { sourceStream: 0, sourceChannel: 1, busId: buses[0].id },
      ]);
      expect(editor.commit().saved).toBe(true);
      const expected = structuredClone(State.audioProject.sourceMaps[first.audioSourceId]);
      eventMock.emit.mockClear(); gate.resolve();

      await expect(work).resolves.toBeNull();
      expect(State.clips.every(clip => clip.audioDetached !== true)).toBe(true);
      expect(Media.externalAudioSources).toEqual([]);
      expect(State.audioProject.sourceMaps[first.audioSourceId]).toEqual(expected);
      expect(eventMock.emit.mock.calls.filter(([type]) => type === 'history:record')).toEqual([]);
    } finally { cache.mockRestore(); }
  });

  it('解除影音等待期間提交其他來源配線，仍以原來源配線完成整批外音', async () => {
    resetAudioProject();
    const { AudioPipeline, AudioRoutingModel } = await import('../src/audio-routing-engine.js');
    const clip = { id: 'detach-other-route', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true, audioSrc: 'video', audioSourceId: 'source-unchanged' };
    State.clips = [clip]; State.videoTracks = [{ visible: true }];
    AudioPipeline.registerSource(clip, [{ sourceStream: 0, sourceChannel: 0 }, { sourceStream: 0, sourceChannel: 1 }], 2);
    const expected = structuredClone(State.audioProject.sourceMaps[clip.audioSourceId]);
    const background = Media.createExternalAudioSource({ name: 'B.wav', path: 'C:/media/B.wav', duration: 2, fallbackCount: 2 });
    const gate = deferred();
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockImplementation(async (path, restore) => {
      await gate.promise;
      return Media.createExternalAudioSource({ ...restore, path, fallbackCount: 2 });
    });
    try {
      const work = Media.detachClipAudio(clip.id);
      await vi.waitFor(() => expect(cache).toHaveBeenCalledOnce());
      const editor = AudioRoutingModel.editProject(State.audioProject, { preview: draft => { State.audioProject = draft; } });
      editor.setRoutes(background.audioSourceId, [{ sourceStream: 0, sourceChannel: 0, busId: State.audioProject.buses[1].id }]);
      expect(editor.commit().saved).toBe(true);
      const changed = structuredClone(State.audioProject.sourceMaps[background.audioSourceId]);
      gate.resolve();

      const [detached] = await work;
      expect(clip.audioDetached).toBe(true);
      expect(State.audioProject.sourceMaps[detached.audioSourceId]).toEqual(expected);
      expect(State.audioProject.sourceMaps[background.audioSourceId]).toEqual(changed);
      expect(Media.externalAudioSources).toContain(background);
    } finally { cache.mockRestore(); }
  });

  it('解除影音等待期間無關字幕與視覺幾何編輯仍可保留並完成音訊', async () => {
    resetAudioProject();
    const cacheGate = deferred();
    const clip = {
      id: 'detach-unrelated', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A', audioDetached: false,
    };
    State.clips = [clip]; State.videoTracks = [{ visible: true }];
    const cache = vi.spyOn(Media, '_addDesktopCachedAudio').mockImplementation(async (path, restore) => {
      await cacheGate.promise;
      return Media.createExternalAudioSource({ ...restore, path, fallbackCount: 1 });
    });
    try {
      const detaching = Media.detachClipAudio(clip.id);
      await vi.waitFor(() => expect(cache).toHaveBeenCalledTimes(1));
      clip.scale = 0.5; clip.posX = 0.75;
      const cue = { id: 'background-cue', start: 1, end: 2, text: '背景字幕' };
      State.cues.push(cue);
      cacheGate.resolve();

      const result = await detaching;
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ offset: 0, in: 0, out: 5 });
      expect(clip).toMatchObject({ scale: 0.5, posX: 0.75, audioDetached: true });
      expect(State.cues).toContain(cue);
    } finally { cache.mockRestore(); }
  });

  it('does not register clip audio after proxy lookup loses reset ownership', async () => {
    const proxyURL = deferred();
    const clip = {
      id: 'clip-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, audioSourceId: 'source-A', audioSrc: 'clip:clip-A',
    };
    State.clips = [clip];
    resetAudioProject();
    desktopMock.ingest.mockResolvedValue({
      proxy: 'C:/cache/A-proxy.mp4',
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    desktopMock.fileURL.mockImplementation(path => path === 'C:/cache/A-proxy.mp4'
      ? proxyURL.promise
      : Promise.resolve(`file:///${path}`));

    const pending = Media._clipIngest(clip, { audio: [{ channels: 1 }] });
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('C:/cache/A-proxy.mp4'));
    Media.reset();
    resetAudioProject();
    State.clips = [];
    proxyURL.resolve('file:///C:/cache/A-proxy.mp4');
    await pending;

    expect(State.audioProject.sourceMaps['source-A']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('does not recreate a deleted primary clip waveform after late file decode', async () => {
    const readers = [];
    class ControlledFileReader {
      constructor(){ this.result = null; this.onload = null; this.onerror = null; readers.push(this); }
      readAsArrayBuffer(){}
    }
    vi.stubGlobal('FileReader', ControlledFileReader);
    const primary = {
      id: 'primary-A', name: 'A.mov', dur: 5, in: 0, out: 5, offset: 0,
      vtrack: 0, primary: true, audioSrc: 'video', audioSourceId: 'source-A',
    };
    State.clips = [primary];
    const work = Wave.fromFile({ name: 'A.mov' }, primary);
    await vi.waitFor(() => expect(readers).toHaveLength(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    const durationAfterDelete = State.duration;

    readers[0].result = new ArrayBuffer(64);
    readers[0].onload();
    await expect(work).resolves.toBe(false);

    expect(Wave._sourceState(primary, false)).toBeNull();
    expect(State.duration).toBe(durationAfterDelete);
    vi.unstubAllGlobals();
  });

  it('drops late mother-source background ingest after the last clip is deleted', async () => {
    const ingest = deferred();
    const primary = {
      id: 'primary-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A',
    };
    State.clips = [primary];
    resetAudioProject();
    desktopMock.ingest.mockReturnValueOnce(ingest.promise);

    const work = Media._bgAudioIngest('C:/media/A.mov', [{ channels: 1 }], 5, primary);
    await vi.waitFor(() => expect(desktopMock.ingest).toHaveBeenCalledTimes(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    ingest.resolve({
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    await work;

    expect(State.audioProject.sourceMaps['source-A']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('publishes a ready preview Proxy without restarting playback at the same frame', async () => {
    const primary = {
      id: 'primary-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 5,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A',
    };
    State.clips = [primary];
    desktopMock.ingest.mockResolvedValue({ proxy: 'C:/cache/A-proxy.mp4', channels: [] });
    desktopMock.fileURL.mockResolvedValue('file:///C:/cache/A-proxy.mp4');
    const seek = vi.spyOn(Media, 'seek');

    await Media._bgAudioIngest(primary.path, [], primary.dur, primary);

    expect(Media.webCodecsProxyUrl()).toBe('file:///C:/cache/A-proxy.mp4');
    expect(seek).not.toHaveBeenCalled();
    seek.mockRestore();
  });

  it('大型素材即使未操作播放點，也會在等待期限後開始準備音軌', async () => {
    vi.useFakeTimers();
    const start = vi.fn();
    try {
      Media.deferInitialAudioIngest(start, () => true);
      await vi.advanceTimersByTimeAsync(9999);
      expect(start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      Media.reset();
      vi.useRealTimers();
    }
  });

  it('keeps source work alive when a split placement still references the mother source', async () => {
    const ingest = deferred();
    const primary = {
      id: 'primary-A', name: 'A.mov', path: 'C:/media/A.mov', dur: 10,
      in: 0, out: 5, offset: 0, vtrack: 0, primary: true,
      audioSrc: 'video', audioSourceId: 'source-A',
    };
    const split = {
      ...primary, id: 'split-A', primary: false, in: 5, out: 10, offset: 5,
    };
    State.clips = [primary, split];
    resetAudioProject();
    desktopMock.ingest.mockReturnValueOnce(ingest.promise);

    const work = Media._bgAudioIngest('C:/media/A.mov', [{ channels: 1 }], 10, primary);
    await vi.waitFor(() => expect(desktopMock.ingest).toHaveBeenCalledTimes(1));
    expect(Media.removeClip(primary.id)).toBe(true);
    ingest.resolve({ channels: [] });
    await work;

    expect(State.clips).toContain(split);
    expect(State.audioProject.sourceMaps['source-A']).toEqual({ channels: [] });
  });

  it('does not let an old waveform request recreate a cleared registry', async () => {
    const urlGate = deferred();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    Wave.registerSourceWaveforms('video', { mixPath: 'A.wav' });

    const pending = Wave.loadSourceWaveform('video');
    Wave.clearSources();
    urlGate.resolve('file:///A.wav');

    await expect(pending).resolves.toBeNull();
    expect(Wave.sourceWaveforms.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses source identity and generation, not a reused numeric waveform index', async () => {
    Media.ensureCtx();
    const urlGate = deferred();
    desktopMock.fileURL.mockReturnValueOnce(urlGate.promise);
    const sourceA = { label: 'A', path: 'A.wav', peaks: null, sourceId: 'video', kind: 'mix', sourceKey: 'video' };
    const sourceB = { label: 'B', path: 'B.wav', peaks: null, sourceId: 'video', kind: 'mix', sourceKey: 'video' };
    Wave.sources = [sourceA];
    Wave.srcIdx = -1;

    const pending = Wave.selectSource(0);
    await vi.waitFor(() => expect(desktopMock.fileURL).toHaveBeenCalledWith('A.wav'));
    Wave.clearSources();
    Wave.sources = [sourceB];
    Wave.srcIdx = 0;
    urlGate.resolve('file:///A.wav');

    await pending;
    expect(sourceA.peaks).toBeNull();
    expect(sourceB.peaks).toBeNull();
    expect(Wave.sources[0]).toBe(sourceB);
  });

  it('公開自動跨段的 HTML 起播拒絕會停止播放與 follower，且可重新播放', async () => {
    const first={id:'first',name:'first',web:{url:'blob:first'},dur:1,in:0,out:1,offset:0,vtrack:0};
    const next={id:'next',name:'next',web:{url:'blob:next'},dur:5,in:0,out:5,offset:1,vtrack:0};
    State.clips=[first,next];State.duration=6;
    Media.activeClipId=first.id;Media.playing=true;
    domMock.video.src=first.web.url;domMock.video.currentTime=1;domMock.video.readyState=1;
    const playback=deferred(),start=await observeElementCommits();
    domMock.video.play.mockReturnValueOnce(playback.promise);
    const {setStatus}=await import('../src/ui.js');setStatus.mockClear();
    try{
      expect(Media.seqContinueAtEnd()).toBe(true);
      await vi.waitFor(()=>expect(domMock.video.src).toBe(next.web.url));
      await vi.waitFor(()=>expect(domMock.video.play).toHaveBeenCalled());
      playback.reject(new DOMException('source cannot start','NotSupportedError'));
      await vi.waitFor(()=>expect(Media.playing).toBe(false));
      expect(start).not.toHaveBeenCalled();
      expect(domMock.$('playBtn').textContent).toBe('▶');
      expect(setStatus).toHaveBeenCalledWith('無法播放影片段「next」','err');
      domMock.video.play.mockResolvedValue(undefined);
      Media.activeClipId=first.id;Media.playing=true;
      expect(Media.seqContinueAtEnd()).toBe(true);
      await vi.waitFor(()=>expect(start).toHaveBeenCalledOnce());
      expect(Media.activeClipId).toBe(next.id);
    }finally{
      playback.promise.catch(()=>{});playback.resolve();
      start.mockRestore();domMock.video.play.mockReset();Media.reset();
    }
  });

  it.each(['pause-resolve','pause-reject','replace-resolve','replace-reject'])('公開跨段的 %s 晚到結果不啟動舊聲音或停止新工作', async action => {
    const pair=prefix=>[
      {id:prefix+'-a',name:'A',web:{url:'blob:'+prefix+'-a'},dur:1,in:0,out:1,offset:0,vtrack:0},
      {id:prefix+'-b',name:'B',web:{url:'blob:'+prefix+'-b'},dur:5,in:0,out:5,offset:1,vtrack:0},
    ];
    const select=clips=>{
      State.clips=clips;State.duration=6;Media.activeClipId=clips[0].id;Media.playing=true;
      domMock.video.src=clips[0].web.url;domMock.video.currentTime=1;domMock.video.readyState=1;
    };
    const oldPlay=deferred(),newPlay=deferred(),start=await observeElementCommits();
    const {setStatus}=await import('../src/ui.js');setStatus.mockClear();
    domMock.video.play.mockReset();domMock.video.play.mockReturnValueOnce(oldPlay.promise).mockReturnValueOnce(newPlay.promise);
    try{
      select(pair('old'));expect(Media.seqContinueAtEnd()).toBe(true);
      await vi.waitFor(()=>expect(domMock.video.play).toHaveBeenCalledOnce());
      expect(start).not.toHaveBeenCalled();
      if(action.startsWith('pause'))Media.pause({seekOnPause:false});
      else{
        Media.reset();select(pair('new'));expect(Media.seqContinueAtEnd()).toBe(true);
        await vi.waitFor(()=>expect(domMock.video.play).toHaveBeenCalledTimes(2));
      }
      if(action.endsWith('reject'))oldPlay.reject(new DOMException('interrupted play','AbortError'));
      else oldPlay.resolve();
      await Promise.resolve();await Promise.resolve();
      expect(start).not.toHaveBeenCalled();
      expect(setStatus.mock.calls.some(([message])=>String(message).startsWith('無法播放影片段'))).toBe(false);
      if(action.startsWith('pause'))expect(Media.playing).toBe(false);
      else{
        expect(Media.playing).toBe(true);expect(Media.activeClip()?.id).toBe('new-b');
        newPlay.resolve();await vi.waitFor(()=>expect(start).toHaveBeenCalledExactlyOnceWith(0,1));
        expect(Media.playing).toBe(true);expect(Media.activeClip()?.id).toBe('new-b');
      }
    }finally{
      oldPlay.promise.catch(()=>{});oldPlay.resolve();newPlay.resolve();
      start.mockRestore();domMock.video.play.mockReset();Media.reset();
    }
  });

  it('keeps a newer clip switch lock when an older metadata wait is cancelled by reset', async () => {
    const clipA = { id: 'A', name: 'A', type: 'video', web: { url: 'blob:A' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    const clipB = { id: 'B', name: 'B', type: 'video', web: { url: 'blob:B' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    State.clips = [clipA];
    const first = Media._ensureClip(clipA, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:A'));

    Media.reset();
    domMock.video.readyState = 0;
    State.clips = [clipB];
    const second = Media._ensureClip(clipB, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:B'));
    expect(Media._seqSwitching).toBe(true);

    domMock.video.readyState = 1;
    domMock.video.dispatch('loadedmetadata');
    await Promise.all([first, second]);

    expect(Media.activeClipId).toBe('B');
    expect(Media._gap).toBe(false);
    expect(Media._seqSwitching).toBe(false);
  });

  it('clears a failed clip ownership so the same clip can retry metadata intake', async () => {
    const clip = { id: 'retry', name: 'retry', type: 'video', web: { url: 'blob:retry' }, in: 0, out: 5, offset: 0, vtrack: 0 };
    State.clips = [clip];
    const failed = Media._ensureClip(clip, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:retry'));
    domMock.video.dispatch('error');
    await failed;

    expect(Media.activeClipId).toBeNull();
    expect(Media._gap).toBe(true);
    expect(domMock.video.src).toBe('');

    domMock.video.readyState = 1;
    await Media._ensureClip(clip, 0, false);
    expect(Media.activeClipId).toBe('retry');
    expect(Media._gap).toBe(false);
  });

  it('retries the current paused clip after an older metadata switch is superseded', async () => {
    const oldClip = {
      id: 'same-id', name: 'old', type: 'video', web: { url: 'blob:old' },
      audioSrc: 'clip:same-id', path: 'C:/old.mov', in: 0, out: 5, offset: 0, vtrack: 0,
    };
    const currentClip = {
      ...oldClip, name: 'current', web: { url: 'blob:current' }, path: 'C:/current.mov',
    };
    State.clips = [oldClip];
    const switching = Media._ensureClip(oldClip, 0, false);
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:old'));

    State.clips = [currentClip];
    Media.restoreSequenceEditState(0);
    domMock.video.readyState = 1;
    await switching;
    await vi.waitFor(() => expect(domMock.video.src).toBe('blob:current'));

    expect(Media.activeClipId).toBe('same-id');
    expect(Media._gap).toBe(false);
    expect(Media._seqSwitching).toBe(false);
  });

  it('rolls back late project clips without consuming the restore plan after History supersedes it', async () => {
    const imageGate = deferred();
    const pending = [
      {
        id: 'saved-primary', primary: true, name: 'A.mov', path: 'C:/media/A.mov',
        dur: 8, in: 0, out: 8, offset: 0, audioSourceId: 'source-A',
      },
      {
        id: 'saved-image', type: 'image', name: 'card.png', path: 'C:/media/card.png',
        dur: 36000, in: 0, out: 4, offset: 2, vtrack: 1,
      },
      {
        id: 'saved-secondary', name: 'B.mov', path: 'C:/media/B.mov',
        dur: 5, in: 0, out: 5, offset: 8, audioSourceId: 'source-B',
      },
    ];
    const replaceClips = vi.fn();
    const plan = {
      owns: () => true,
      pendingClips: () => pending,
      consumeMediaRelink: () => false,
      replaceClips,
    };
    const lateImage = { ...pending[1] };
    const addImage = vi.spyOn(Media, 'addImageDesktop').mockImplementation(async () => {
      await imageGate.promise;
      State.clips.push(lateImage);
      return lateImage;
    });

    Media._registerPrimary({
      id: 'runtime-primary', name: 'A.mov', path: 'C:/media/A.mov', dur: 8, fps: 25,
    }, plan);
    await vi.waitFor(() => expect(addImage).toHaveBeenCalledTimes(1));

    State.clips = [];
    Media.restoreSequenceEditState(0);
    imageGate.resolve();
    await Media.waitForPendingProjectRestore();

    expect(State.clips).toEqual([]);
    expect(replaceClips).not.toHaveBeenCalled();
    expect(plan.pendingClips()).toEqual(pending);
    addImage.mockRestore();
  });
});

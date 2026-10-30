// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, Wave, State, resetAudioProject, resetPlayerAdapter;

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
    const bridge={launch:vi.fn().mockResolvedValue({ok:true}),direction:vi.fn().mockResolvedValue(true),mute:vi.fn().mockResolvedValue()};
    desktopMock.mpv=bridge;const adapter=resetPlayerAdapter(desktopMock,domMock.video);await adapter.enterMpv({src:'A.mov'});
    const clip={id:'reverse',path:'A.mov',in:0,out:10,dur:10,offset:0,reverse:true};State.clips=[clip];Media.activeClipId=clip.id;Media._gap=false;
    await expect(Media.setPlaybackDirection('backward')).resolves.toBe(true);
    expect(bridge.direction).toHaveBeenLastCalledWith('forward');
    await Media.setPlaybackDirection('forward');expect(bridge.direction).toHaveBeenLastCalledWith('backward');
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
    const processedPeaks=new Float32Array([0.05]),rawPeaks=new Float32Array([0.2]);
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
    const peaks=vi.spyOn(Wave,'calcFromWav').mockReturnValue(rawPeaks);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({arrayBuffer:async()=>new ArrayBuffer(2)}));
    try{
      const pending=kind==='primary'?Media._bgAudioIngest(owner.path,[{channels:1}],10,owner,{needsProxy:false})
        :kind==='secondary'?Media._clipIngest(owner,{audio:[{channels:1}]})
          :Media.cacheExternalRoutingAudio(owner,owner.path,10,[{channels:1}]);
      gate.resolve({channels:[{file:'raw.m4a',sourceStream:0,sourceChannel:0}],wave:'raw-wave.wav'});
      await pending;
      expect(Media.tracks).toEqual([processed]);
      expect(processed.el.src).toBe('processed.wav');
      expect(owner.peaks).toBe(processedPeaks);
      expect(Media._effectOriginalPeaks.get(owner.audioSourceId)).toBe(rawPeaks);
      expect(Media._effectOriginalTracks.get(owner.audioSourceId)[0]).toMatchObject({file:'raw.m4a',volume:0.4,solo:true});
      expect(Media._effectOriginalTracks.get(owner.audioSourceId)[0].gain.gain.value).toBe(0);
      Media._installAudioEffect(owner,null,null);
      expect(Media.tracks).toHaveLength(1);
      expect(Media.tracks[0].file).toBe('raw.m4a');
      expect(Media.tracks[0]._audioEffect).not.toBe(true);
      expect(owner.peaks).toBe(rawPeaks);
    }finally{elements.mockRestore();peaks.mockRestore();vi.unstubAllGlobals();}
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
    const bridge={launch:vi.fn().mockResolvedValue({ok:true}),quit:vi.fn().mockResolvedValue(),
      loadfile:vi.fn(()=>stage==='loadfile'?gate.promise:Promise.resolve({ok:true})),
      mute:vi.fn(()=>stage==='mute'?gate.promise:Promise.resolve()),
      direction:vi.fn(()=>stage==='direction'?gate.promise:Promise.resolve(true)),seek:vi.fn().mockResolvedValue(true),
    };
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'old.mov'});
    State.clips=[{id:'old',path:'old.mov',in:0,out:5,dur:5,offset:0,primary:true}];
    Media.activeClipId='old';Media._gap=false;
    Media._reverseProxyPath='proxy.mov';Media._reverseProxySourcePath='old.mov';
    Media._mpvPath='old.mov';
    const switching=Media.setPlaybackDirection('backward');
    await vi.waitFor(()=>expect(bridge[stage]).toHaveBeenCalled());
    Media.reset();
    Media._mpvPath='new.mov';
    gate.resolve({ok:true});
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
    const bridge={launch:vi.fn().mockResolvedValue({ok:true}),quit:vi.fn().mockResolvedValue(),
      loadfile:vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ok:true}),
      mute:vi.fn().mockResolvedValue(),direction:vi.fn().mockResolvedValue(true),seek:vi.fn().mockResolvedValue(true),
    };
    desktopMock.mpv=bridge;
    const runtime=resetPlayerAdapter(desktopMock,domMock.video);
    await runtime.enterMpv({src:'mother.mov'});
    State.clips=[{id:'v',path:'mother.mov',in:0,out:5,dur:5,offset:0,primary:true}];
    Media.activeClipId='v';Media._gap=false;
    Media._reverseProxyPath='proxy.mov';Media._reverseProxySourcePath='mother.mov';
    const reverse=Media.setPlaybackDirection('backward');
    await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith('proxy.mov'));
    const forward=Media.setPlaybackDirection('forward');
    expect(bridge.direction).not.toHaveBeenCalled();
    gate.resolve({ok:true});
    await expect(reverse).resolves.toBe(false);
    await expect(forward).resolves.toBe(true);
    expect(bridge.loadfile.mock.calls.map(([path])=>path)).toEqual(['proxy.mov','mother.mov']);
    expect(bridge.direction).toHaveBeenCalledExactlyOnceWith('forward');
    expect(Media._nativeReverse).toBe(false);expect(Media._mpvPath).toBe('mother.mov');
  });
  beforeAll(async () => {
    window.subtool = desktopMock;
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 32 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
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
    const playback=deferred(),start=vi.spyOn(Media,'startElementSources');
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
    const oldPlay=deferred(),newPlay=deferred(),start=vi.spyOn(Media,'startElementSources');
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

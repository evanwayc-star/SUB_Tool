// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const frameCallbacks = [];
  const video = {
    style: {},
    src: 'file:///program.mov',
    currentSrc: 'file:///program.mov',
    currentTime: 15,
    duration: 30,
    playbackRate: 1,
    muted: false,
    preservesPitch: true,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    dispatchEvent: vi.fn(),
    hasAttribute: vi.fn(name => name === 'src'),
    requestVideoFrameCallback: vi.fn(callback => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    frameCallbacks,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', value: 0, innerHTML: '',
          classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
          querySelectorAll: () => [],
        });
      }
      return elements.get(id);
    },
  };
});

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));
// These transport fixtures have no encoded bytes. Real source-window evidence
// through original File intake is covered by webSourceClock.test.js.
vi.mock('../src/decode/source-frame-index.js',()=>({sourceFrameWindow:vi.fn(()=>null),sourcePresentationMetadata:vi.fn(()=>null),clearSourceFrameIndexes:vi.fn()}));

let Media;
let State;
let resetPlayerAdapter;

describe('Media presentation runtime', () => {
  beforeAll(async () => {
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser() { return { connect: vi.fn(), fftSize: 0 }; }
      resume() {}
    };
    ({ Media } = await import('../src/media.js'));
    ({ State } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  });

  beforeEach(() => {
    State.fps = 25;
    State.dropFrame = false;
    State.duration = 130;
    State.videoTracks = [{ name: 'V1', visible: true, locked: false }];
    State.clips = [{
      id: 'clip-a', name: 'program.mov', web: { url: 'file:///program.mov' },
      dur: 30, in: 10, out: 20, offset: 100, vtrack: 0, primary: true,
    }];
    State.externalAudioEnd = 0;
    Media.playing = false;
    domMock.video.currentTime = 15;
    domMock.video.muted = false;
    domMock.video.play.mockClear();
    domMock.video.pause.mockClear();
    domMock.video.dispatchEvent.mockClear();
    domMock.video.hasAttribute.mockImplementation(name => name === 'src');
    domMock.frameCallbacks.length = 0;
    resetPlayerAdapter(null, domMock.video);
    Media.resetPresentationSession('test-reset');
    Media.setWebCodecsTakeover(false);
    Media.activeClipId = 'clip-a';
    Media._gap = false;
    Media._seqSwitching = false;
    Media._transport.seek(105, { duration: State.duration, fps: State.fps, dropFrame: State.dropFrame });
  });

  it('public Media presentation and playing readouts use video zero after a mother clock is registered',async()=>{
    const adapter=await import('../src/media-player-adapter.js');
    adapter.getPlayerAdapter().registerSourceClock(domMock.video.src,{timestampOffset:-.5});
    Object.assign(State.clips[0],{in:0,out:3,dur:3});State.duration=103;
    domMock.video.currentTime=.5;
    const pending=Media.requestPresentation(102.8);await Promise.resolve();
    expect(domMock.video.currentTime).toBeCloseTo(3.3,10);
    domMock.frameCallbacks.shift()(0,{mediaTime:3.3});
    await expect(pending).resolves.toMatchObject({status:'presented',requestedTime:102.8,presentedTime:102.8,source:'html5'});
    expect(Media.displayTime()).toBe(102.8);
    Media.playing=true;expect(Media.vTime()).toBeCloseTo(2.8,10);expect(Media.displayTime()).toBe(102.8);
    Media.playing=false;
  });

  it('畫格完成前不提交播放頭，完成後才把來源時間映回時間軸', async () => {
    const pending = Media.requestPresentation(104);
    await Promise.resolve();

    expect(domMock.video.currentTime).toBe(14);
    expect(Media.displayTime()).toBe(105);

    domMock.frameCallbacks.shift()(0, { mediaTime: 13.95 });
    const result = await pending;

    expect(result).toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.95, source: 'html5',
    });
    expect(Media.displayTime()).toBe(103.96);
  });

  it('影片間隙由 synthetic presenter 立即提交黑畫面位置', async () => {
    const result = await Media.requestPresentation(50);

    expect(result).toMatchObject({
      status: 'presented', requestedTime: 50, presentedTime: 50, source: 'synthetic',
    });
    expect(Media.displayTime()).toBe(50);
  });

  it.each(['pause','new-seek','new-seek-reverse-play','reset','reverse-play'])('native capture holds the real Media presenter and respects %s',async action=>{
    const {activateMpvTransport}=await import('../src/media-player-adapter.js');
    const bridge={launch:vi.fn(async()=>({ok:true})),present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
      play:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),rate:vi.fn(async()=>{}),mute:vi.fn(async()=>{})};
    const runtime=activateMpvTransport({mpv:bridge});await runtime.enterMpv({src:'C:/program.mov'});
    State.clips[0].path='C:/program.mov';Media._mpvPath='C:/program.mov';Media._nativeReverse=false;
    let release,started,owns;
    const ready=new Promise(resolve=>{started=resolve;});
    const pixels=new Promise(resolve=>{release=resolve;});
    try{
      Media.play();bridge.play.mockClear();
      const pending=Media.withPresentedFrame(105,async({isCurrent,adapter})=>{
        owns=isCurrent;expect(adapter).toBe(runtime);started();await pixels;
        if(!isCurrent())throw Object.assign(new Error('obsolete capture'),{name:'AbortError'});
        return'pixels';
      });
      const outcome=pending.then(value=>({value}),error=>({error}));
      await ready;expect(bridge.present.mock.lastCall[0]).toBe(15);expect(bridge.play).not.toHaveBeenCalled();
      let newer;
      if(action==='pause')Media.pause();
      if(action==='reset')Media.resetPresentationSession('new-workspace');
      if(action.startsWith('new-seek'))newer=Media.seek(106);
      if(action==='reverse-play'||action==='new-seek-reverse-play'){Media._nativeReverse=true;Media.play();expect(bridge.play).not.toHaveBeenCalled();}
      if(action==='reset'||action.startsWith('new-seek'))expect(owns()).toBe(false);
      release();const result=await outcome;if(newer)await newer;
      if(action==='reset'||action.startsWith('new-seek'))expect(result.error?.name).toBe('AbortError');else expect(result.value).toBe('pixels');
      expect(bridge.play).toHaveBeenCalledTimes(action.startsWith('new-seek')||action==='reverse-play'?1:0);
    }finally{release?.();Media._nativeReverse=false;Media.playing=false;runtime.stopBoundsFeeder();Media.resetPresentationSession('capture-test-finished');}
  });

  it.each(['negative acknowledgement','rejection','reverse preparation','success','superseded'])('native clip activation %s cannot acknowledge the previous mother source',async outcome=>{
    const {activateMpvTransport}=await import('../src/media-player-adapter.js');
    let release;
    const bridge={launch:vi.fn(async()=>({ok:true})),loadfile:vi.fn(async()=>({ok:true})),
      present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
      pause:vi.fn(async()=>{}),rate:vi.fn(async()=>{}),direction:vi.fn(async()=>true),mute:vi.fn(async()=>{})};
    if(outcome==='negative acknowledgement')bridge.loadfile.mockResolvedValueOnce({ok:false});
    if(outcome==='rejection')bridge.loadfile.mockRejectedValueOnce(new Error('source unavailable'));
    if(outcome==='superseded')bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const reverse=outcome==='reverse preparation'?vi.spyOn(Media,'prepareClipReverse').mockResolvedValueOnce(false):null;
    const runtime=activateMpvTransport({mpv:bridge});await runtime.enterMpv({src:'C:/program.mov'});
    State.clips[0].path='C:/program.mov';
    State.clips.push({id:'clip-b',path:'C:/next.mov',in:0,out:10,dur:10,offset:110,vtrack:0,
      ...(reverse?{reverse:true}:{})});
    Media._mpvPath='C:/program.mov';
    try{
      const pending=Media.requestPresentation(112);
      if(outcome==='superseded'){
        await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
        const current=Media.requestPresentation(104);
        release({ok:true});
        await expect(pending).resolves.toMatchObject({status:'failed',error:{name:'AbortError'}});
        await expect(current).resolves.toMatchObject({status:'presented',presentedTime:104});
        expect(bridge.present).toHaveBeenCalledOnce();expect(bridge.present.mock.lastCall[0]).toBe(14);
      }else if(outcome==='success'){
        await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:112});
        expect(Media.activeClip()?.id).toBe('clip-b');expect(Media.inGap()).toBe(false);
        expect(bridge.present).toHaveBeenCalledOnce();expect(bridge.present.mock.lastCall[0]).toBe(2);
      }else{
        await expect(pending).resolves.toMatchObject({status:'failed'});
        expect(bridge.present).not.toHaveBeenCalled();
        expect(Media.displayTime()).toBe(105);
      }
    }finally{reverse?.mockRestore();runtime.stopBoundsFeeder();Media.resetPresentationSession('activation-test-finished');}
  });

  it('WebCodecs 接管時會等所有合成層的實際 PTS，再提交播放頭', async () => {
    Media.setWebCodecsTakeover(true);
    const pending = Media.requestPresentation(104);
    await Promise.resolve();
    domMock.frameCallbacks.shift()(0, { mediaTime: 14 });

    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Media.displayTime()).toBe(105);

    Media.reportWebCodecsPresentation([104.01, 103.95]);
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.95, source: 'webcodecs',
    });
    expect(Media.displayTime()).toBe(103.96);
  });

  it('一般跳轉後立刻播放，必須等實際畫格呈現才啟動 presenter 時鐘', async () => {
    const pending = Media.seek(104);

    Media.play();

    expect(Media.playing).toBe(true);
    expect(Media.playbackTransitionPending()).toBe(true);
    expect(Media.presenterClockMoving()).toBe(false);
    expect(domMock.video.play).not.toHaveBeenCalled();

    await Promise.resolve();
    domMock.frameCallbacks.shift()(0, { mediaTime: 14 });
    await pending;

    expect(domMock.video.play).toHaveBeenCalledTimes(1);
    expect(Media.playbackTransitionPending()).toBe(false);
    expect(Media.presenterClockMoving()).toBe(true);
  });

  it('逐格可要求小於半格的呈現容差，舊畫格不能提前完成請求', async () => {
    const pending = Media.seek(104, { presentationTolerance: 0.01 });
    let settled = false;
    pending.then(() => { settled = true; });

    await Promise.resolve();
    domMock.frameCallbacks.shift()(0, { mediaTime: 13.95 });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(domMock.frameCallbacks).toHaveLength(1);

    domMock.frameCallbacks.shift()(0, { mediaTime: 13.995 });
    await expect(pending).resolves.toMatchObject({
      status: 'presented', requestedTime: 104, presentedTime: 103.995,
    });
  });

  it('跳轉後先播放再暫停，晚到畫格不得重新啟動播放', async () => {
    const pending = Media.seek(104);

    Media.play();
    Media.pause();
    await Promise.resolve();
    domMock.frameCallbacks.shift()(0, { mediaTime: 14 });
    await pending;

    expect(Media.playing).toBe(false);
    expect(Media.playbackTransitionPending()).toBe(false);
    expect(Media.presenterClockMoving()).toBe(false);
    expect(domMock.video.play).not.toHaveBeenCalled();
  });

  it('播放器實際停止後，下一次播放意圖會重新啟動 adapter', () => {
    Media.play();
    expect(domMock.video.play).toHaveBeenCalledTimes(1);

    Media.observePlayerPlaybackState(false, { source: 'mpv', reason: 'pause' });
    expect(Media.playing).toBe(false);

    Media.play();
    expect(domMock.video.play).toHaveBeenCalledTimes(2);
  });

  it('HTML5 ended 的實際停止位置會吸附到專案影格格網', () => {
    domMock.video.currentTime = 15.019;
    Media.play();
    expect(Media.displayTime()).toBeCloseTo(105.019, 6);

    Media.observePlayerPlaybackState(false, { source: 'html5', reason: 'ended' });

    expect(Media.playing).toBe(false);
    expect(Media.displayTime()).toBe(105);
    expect(Media._transport.pausedTime).toBe(105);
  });

  it.each(['source &lt;original&gt; &amp; safe.mxf',"O'Brien & reference.mxf",'source <b>original.mxf'])('large-file warning preserves the literal File name %s',async name=>{
    const {openModal}=await import('../src/ui.js');
    // The first two names are legal Windows basenames. A File is public input
    // on every web host; its synthetic size exercises the memory gate safely.
    const file=new File(['media'],name,{type:'video/x-mxf'});
    Object.defineProperty(file,'size',{value:9e9});
    openModal.mockClear();
    await expect(Media.transcodeAndExtract(file)).resolves.toBe(false);
    expect(openModal).toHaveBeenCalledOnce();
    expect(openModal.mock.lastCall[0]).toBe('檔案過大');
    const body=document.createElement('div');body.innerHTML=openModal.mock.lastCall[1];
    expect(body.firstElementChild.textContent).toBe(file.name);
    expect(body.firstElementChild.children).toHaveLength(0);
    expect(body.textContent).toContain('ffmpeg.wasm');
  });

  it.each(['complete','pause','pause-resume','pause-immediate-resume','pause-resume-new-seek','pause-resume-reset','pause-resume-source-replace','new-seek','seek-during-activation','reset'])('public clip-end growing-duration handoff respects %s before resuming',async action=>{
    const adapterModule=await import('../src/media-player-adapter.js');
    const events=new EventTarget(),properties=new Map(['currentSrc','currentTime','readyState','addEventListener','removeEventListener'].map(name=>[name,Object.getOwnPropertyDescriptor(domMock.video,name)]));
    const previousSrc=domMock.video.src,writes=[];let raw=1;
    Object.defineProperties(domMock.video,{
      currentSrc:{configurable:true,get:()=>domMock.video.src},
      currentTime:{configurable:true,get:()=>raw,set:target=>{writes.push(target);raw=Math.min(target,domMock.video.duration);}},
      readyState:{configurable:true,value:1},
    });
    domMock.video.addEventListener=events.addEventListener.bind(events);domMock.video.removeEventListener=events.removeEventListener.bind(events);
    try{
      domMock.video.src='file:///first.mov';domMock.video.duration=3.5;
      const first={id:'first',web:{url:domMock.video.src},dur:1,in:0,out:1,offset:0,vtrack:0,primary:true};
      const next={id:'next',web:{url:'file:///origin-five.mov'},dur:3,in:2.8,out:3,offset:1,vtrack:0};
      Object.assign(State,{fps:25,dropFrame:false,duration:1.2,clips:[first,next],videoTracks:[{visible:true}]});
      Media.tracks=[];Media.externalAudioSources=[];Media.activeClipId='first';Media._gap=false;
      adapterModule.resetPlayerAdapter(null,domMock.video);
      adapterModule.getPlayerAdapter().registerSourceClock(next.web.url,{presentationTimestampOffset:-5.5});
      Media.resetPresentationSession('handoff-test');Media._transport.seek(.96,{duration:1.2,fps:25});
      Media.play();domMock.video.play.mockClear();raw=1;
      const oldRequest=action==='seek-during-activation'?Media.seek(1):null;
      if(!oldRequest)expect(Media.seqContinueAtEnd()).toBe(true);
      await vi.waitFor(()=>expect(raw).toBe(3.5));
      expect(Media.presenterClockMoving()).toBe(false);expect(Media.displayTime()).toBe(1);
      expect(domMock.video.play).not.toHaveBeenCalled();
      const expand=duration=>{domMock.video.duration=duration;events.dispatchEvent(new Event('durationchange'));};
      if(action==='complete'){
        expand(7.9);await Promise.resolve();expect(raw).toBe(7.9);expect(domMock.video.play).not.toHaveBeenCalled();
        expand(8.5);await vi.waitFor(()=>expect(domMock.video.play).toHaveBeenCalledOnce());
        expect(raw).toBe(8.3);expect(Media.activeClipId).toBe('next');expect(Media.presenterClockMoving()).toBe(true);
      }else if(action.startsWith('pause-resume')||action==='pause-immediate-resume'){
        Media.pause();
        expect(Media.displayTime()).toBe(1);
        const afterCancel=writes.length;
        if(action==='pause-resume'){
          expand(8.5);
          await vi.waitFor(()=>expect(Media._seqSwitching).toBe(false));
          expect(writes.slice(afterCancel)).not.toContain(8.3);
        }
        Media.play();
        await vi.waitFor(()=>expect(writes.slice(afterCancel)).toContain(8.3));
        expect(Media.playbackTransitionPending()).toBe(true);
        expect(Media.presenterClockMoving()).toBe(false);
        expect(Media.displayTime()).toBe(1);
        expect(domMock.video.play).not.toHaveBeenCalled();
        if(action==='pause-resume-new-seek'){
          const afterPrevious=writes.length,pending=Media.seek(1.08,{presentationTolerance:.01});
          expand(8.5);
          await vi.waitFor(()=>expect(domMock.frameCallbacks).toHaveLength(1));
          expect(writes.slice(afterPrevious)).not.toContain(8.3);
          expect(raw).toBeCloseTo(8.38,12);
          domMock.frameCallbacks.shift()(0,{mediaTime:raw});
          await expect(pending).resolves.toMatchObject({status:'presented',presentedTime:expect.closeTo(1.08,12)});
          expect(Media.displayTime()).toBeCloseTo(1.08,12);
          return;
        }
        if(action==='pause-resume-reset'||action==='pause-resume-source-replace'){
          Media.reset();
          if(action==='pause-resume-source-replace'){
            domMock.video.src='file:///replacement.mov';
            raw=.12;
            State.clips=[{...next,web:{url:domMock.video.src},in:0,out:3,offset:0}];
          }
          const afterPrevious=writes.length,stoppedRaw=raw;
          expand(8.5);
          await vi.waitFor(()=>expect(Media._seqSwitching).toBe(false));
          expect(raw).toBe(stoppedRaw);
          expect(writes.slice(afterPrevious)).not.toContain(8.3);
          expect(domMock.video.play).not.toHaveBeenCalled();
          return;
        }
        if(action==='pause-immediate-resume'){
          expect(raw).toBe(3.5);
          expand(7.9);await Promise.resolve();expect(raw).toBe(7.9);
          expect(domMock.video.play).not.toHaveBeenCalled();
          expand(8.5);await Promise.resolve();
        }
        await vi.waitFor(()=>expect(domMock.frameCallbacks).toHaveLength(1));
        expect(raw).toBeCloseTo(8.3,12);
        // The raw setter is only positioning. Resume still needs the actual
        // target frame acknowledgement, just like an ordinary public seek.
        expect(domMock.video.play).not.toHaveBeenCalled();
        domMock.frameCallbacks.shift()(0,{mediaTime:raw});
        await vi.waitFor(()=>expect(domMock.video.play).toHaveBeenCalledOnce());
        expect(Media.displayTime()).toBeCloseTo(1,12);
        expect(Media.presenterClockMoving()).toBe(true);
      }else if(action==='new-seek'||action==='seek-during-activation'){
        const afterOld=writes.length,pending=Media.seek(1.08,{presentationTolerance:.01});
        await vi.waitFor(()=>expect(domMock.frameCallbacks).toHaveLength(1));
        expand(8.5);await Promise.resolve();
        expect(raw).toBeCloseTo(8.38,12);expect(writes.slice(afterOld)).not.toContain(8.3);
        domMock.frameCallbacks.shift()(0,{mediaTime:raw});
        const result=await pending;expect(result.status).toBe('presented');expect(result.presentedTime).toBeCloseTo(1.08,12);
        expect(Media.displayTime()).toBeCloseTo(1.08,12);
        if(oldRequest)expect(await oldRequest).toMatchObject({status:'failed',error:{name:'AbortError'}});
      }else{
        if(action==='pause')Media.pause();else Media.reset();
        const stoppedRaw=raw,afterCancel=writes.length;
        expand(8.5);await Promise.resolve();await vi.waitFor(()=>expect(Media._seqSwitching).toBe(false));
        expect(raw).toBe(stoppedRaw);expect(writes.slice(afterCancel)).not.toContain(8.3);
        expect(domMock.video.play).not.toHaveBeenCalled();expect(Media.playing).toBe(false);
        if(action==='pause')expect(Media.displayTime()).toBe(1);
      }
    }finally{
      Media.playing=false;adapterModule.getPlayerAdapter().cancelElementSeek(domMock.video);Media.resetPresentationSession('handoff-finished');
      await Promise.resolve();await Promise.resolve();
      for(const [name,descriptor]of properties){if(descriptor)Object.defineProperty(domMock.video,name,descriptor);else delete domMock.video[name];}
      domMock.video.src=previousSrc;
    }
  });
});

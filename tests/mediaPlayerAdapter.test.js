import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPlayerAdapter, resetPlayerAdapter,
} from '../src/media-player-adapter.js';

afterEach(() => resetPlayerAdapter(null));

it('public HTML seek accepts operation ownership and cancels a deferred raw target when the owner changes',async()=>{
  const element=new EventTarget();element.src='owned-video.mov';element.duration=3.5;
  let raw=0,owned=true;
  Object.defineProperty(element,'currentTime',{get:()=>raw,set:target=>{raw=Math.min(target,element.duration);}});
  const runtime=resetPlayerAdapter(null,element);
  runtime.registerSourceClock(element.src,{presentationTimestampOffset:-5.5});
  const pending=runtime.seek(2.8,{owns:()=>owned}).catch(error=>error);
  expect(raw).toBe(3.5);owned=false;
  await expect(pending).resolves.toMatchObject({name:'AbortError'});
  element.duration=8.5;element.dispatchEvent(new Event('durationchange'));
  expect(raw).toBe(3.5);
  await runtime.seek(1);expect(raw).toBe(6.5);
});

describe('desktop player adapter guide contract', () => {
  it('forwards subtitle guide updates and clear requests to the preload mpv bridge', async () => {
    const setGuide = vi.fn().mockResolvedValue(undefined);
    resetPlayerAdapter({ mpv: { setGuide } });

    const guide = { x: 12, y: 24, w: 320, h: 72 };
    await getPlayerAdapter().setGuide(guide);
    await getPlayerAdapter().setGuide(null);

    expect(setGuide).toHaveBeenNthCalledWith(1, guide);
    expect(setGuide).toHaveBeenNthCalledWith(2, null);
  });

  it('reports an unavailable guide capability instead of silently pretending success', async () => {
    resetPlayerAdapter({ mpv: {} });

    await expect(getPlayerAdapter().setGuide({ x: 0, y: 0, w: 1, h: 1 })).resolves.toBe(false);
  });
});

describe('active transport', () => {
  it.each([true,false])('detached frame presentation waits for the real source frame and retains ownership=%s',async retained=>{
    let rawTime=0,owns=true;
    const callbacks=[],seeks=[];
    const element=new EventTarget();element.src='freeze.mov';element.duration=3.5;
    element.requestVideoFrameCallback=callback=>{callbacks.push(callback);return callbacks.length;};
    element.cancelVideoFrameCallback=vi.fn();
    Object.defineProperty(element,'currentTime',{get:()=>rawTime,set:value=>{seeks.push(value);rawTime=Math.min(value,element.duration);}});
    const runtime=resetPlayerAdapter(null);
    runtime.registerSourceClock(element.src,{presentationTimestampOffset:-5.5});
    const pending=runtime.presentElement(element,2.8,{owns:()=>owns,frameTarget:2.8,frameStart:2.8,frameDuration:1/30});
    callbacks.shift()(0,{mediaTime:5.5});
    expect(callbacks).toHaveLength(1);expect(rawTime).toBe(3.5);
    element.duration=7.9;element.dispatchEvent(new Event('durationchange'));
    expect(rawTime).toBe(7.9);expect(seeks).toHaveLength(2);
    for(let event=0;event<40;event++)element.dispatchEvent(new Event('durationchange'));
    expect(seeks).toHaveLength(2);
    callbacks.shift()(0,{mediaTime:7.9});
    expect(callbacks).toHaveLength(1);
    element.duration=8.5;element.dispatchEvent(new Event('durationchange'));
    expect(rawTime).toBe(8.3);expect(seeks).toHaveLength(3);
    owns=retained;callbacks.shift()(0,{mediaTime:8.3});
    if(retained){
      const result=await pending;
      expect(result.presentedSourceTime).toBeCloseTo(2.8,14);
      expect(result.presentedSourceDuration).toBe(1/30);
    }
    else await expect(pending).rejects.toMatchObject({name:'AbortError'});
  });

  it.each(['mpv','html5','reselected-mpv'])('the main element seek shares active transport cancellation on %s',async transition=>{
    let rawTime=0;
    const element=new EventTarget();element.src='main.mov';element.duration=3.5;
    Object.defineProperty(element,'currentTime',{get:()=>rawTime,set:value=>{rawTime=Math.min(value,element.duration);}});
    const runtime=resetPlayerAdapter({mpv:{launch:vi.fn().mockResolvedValue({ok:true}),quit:vi.fn()}},element);
    runtime.registerSourceClock(element.src,{presentationTimestampOffset:-5.5});
    if(transition==='reselected-mpv')await runtime.enterHtml5(element);
    const current=runtime.seekElement(element,0,{owns:()=>true}).catch(error=>error);
    if(transition==='html5')await runtime.enterHtml5({src:'next.mov',currentTime:0});
    else await runtime.enterMpv({src:'native.mov'});
    expect(await current).toMatchObject({name:'AbortError'});
    element.duration=8.5;element.dispatchEvent(new Event('durationchange'));
    expect(rawTime).toBe(3.5);
    await runtime.enterHtml5(element);
    expect(runtime.seekElement(element,1)).toBeUndefined();
    expect(rawTime).toBe(6.5);
  });

  it.each(['owner','signal'])('rejected %s admission cannot cancel an owned deferred seek on the same element',async reason=>{
    vi.useFakeTimers();
    try{
      let rawTime=0;
      const element=new EventTarget();
      element.src='owned.mov';element.duration=3.5;
      Object.defineProperty(element,'currentTime',{get:()=>rawTime,set:value=>{rawTime=Math.min(value,element.duration);}});
      const runtime=resetPlayerAdapter(null);
      runtime.registerSourceClock(element.src,{presentationTimestampOffset:-5.5});
      const current=runtime.seekElement(element,0,{owns:()=>true});
      const controller=new AbortController();controller.abort();
      const stale=reason==='owner'?{owns:()=>false}:{signal:controller.signal};
      expect(()=>runtime.seekElement(element,2,stale)).toThrow(/aborted/);
      expect(rawTime).toBe(3.5);
      element.duration=8.5;element.dispatchEvent(new Event('durationchange'));
      await expect(current).resolves.toBeUndefined();
      expect(rawTime).toBe(5.5);expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });

  it('uncommitted element intake loses its operation owner before late duration metadata arrives',async()=>{
    vi.useFakeTimers();
    try{
      let owns=true,rawTime=0;
      const listeners=new Map();
      const element={src:'uncommitted.mov',duration:3.5,
        get currentTime(){return rawTime;},set currentTime(value){rawTime=Math.min(value,this.duration);},
        addEventListener:(event,callback)=>listeners.set(event,callback),
        removeEventListener:(event,callback)=>{if(listeners.get(event)===callback)listeners.delete(event);}};
      const runtime=resetPlayerAdapter(null);
      runtime.registerSourceClock(element.src,{presentationTimestampOffset:-5.5});
      const result=runtime.seekElement(element,0,{owns:()=>owns}).catch(error=>error);
      owns=false;await vi.advanceTimersByTimeAsync(25);
      expect(await result).toMatchObject({name:'AbortError'});
      element.duration=8.5;listeners.get('durationchange')?.();
      expect(rawTime).toBe(3.5);expect(listeners.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
      expect(()=>runtime.seekElement(element,0,{owns:()=>false})).toThrow(/aborted/);
    }finally{vi.useRealTimers();}
  });

  it('detached carriers independently retain their URI clocks and pending seek ownership',async()=>{
    const makeElement=src=>{
      const listeners=new Map();let rawTime=0;
      return {src,duration:3.5,get currentTime(){return rawTime;},set currentTime(value){rawTime=Math.min(value,this.duration);},
        addEventListener:(name,callback)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},
        removeEventListener:(name,callback)=>listeners.get(name)?.delete(callback),
        emit(name){for(const callback of [...listeners.get(name)||[]])callback();},listeners};
    };
    const runtime=resetPlayerAdapter(null),first=makeElement('mother.mov'),second=makeElement('mother.mov');
    runtime.registerSourceClock(first.src,{timestampOffset:-.5,presentationTimestampOffset:-5.5});
    const cancelled=runtime.seekElement(first,0).catch(error=>error);
    const completed=runtime.seekElement(second,2.8);
    runtime.cancelElementSeek(first);
    expect(await cancelled).toMatchObject({name:'AbortError'});
    first.duration=8.5;first.emit('durationchange');
    second.duration=8.5;second.emit('durationchange');await completed;
    expect(first.currentTime).toBe(3.5);expect(second.currentTime).toBe(8.3);
    expect([...first.listeners.values(),...second.listeners.values()].every(set=>set.size===0)).toBe(true);
    second.src='normalized.wav';second.duration=3;
    expect(runtime.seekElement(second,1)).toBeUndefined();
    expect(second.currentTime).toBe(1);
  });

  it('HTML retries a clamped absolute source target after MOV duration expands, then verifies its actual frame',async()=>{
    const listeners=new Map(),callbacks=[];
    let rawTime=0;
    const videoEl={src:'origin-five.mov',duration:3.5,
      get currentTime(){return rawTime;},set currentTime(value){rawTime=Math.min(value,this.duration);},
      addEventListener:(name,callback)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},
      removeEventListener:(name,callback)=>listeners.get(name)?.delete(callback),
      requestVideoFrameCallback:callback=>{callbacks.push(callback);return callbacks.length;},cancelVideoFrameCallback:vi.fn()};
    const emit=name=>{for(const callback of [...listeners.get(name)||[]])callback();};
    const runtime=resetPlayerAdapter(null,videoEl);
    runtime.registerSourceClock(videoEl.src,{timestampOffset:-.5,presentationTimestampOffset:-5.5});
    let completed=false;
    const initial=runtime.seek(0).then(()=>{completed=true;});
    expect(rawTime).toBe(3.5);await Promise.resolve();expect(completed).toBe(false);
    videoEl.duration=5.8;emit('durationchange');await initial;
    expect(rawTime).toBe(5.5);expect(runtime.sourceTime()).toBe(0);
    videoEl.duration=7.9;
    const presentation=runtime.present(2.8,{tolerance:.000001});
    expect(rawTime).toBe(7.9);
    callbacks.shift()(0,{mediaTime:7.9});expect(callbacks).toHaveLength(1);
    videoEl.duration=8.5;emit('durationchange');expect(rawTime).toBe(8.3);
    callbacks.shift()(0,{mediaTime:8.3});
    await expect(presentation).resolves.toMatchObject({presentedSourceTime:expect.closeTo(2.8,10)});
    expect([...listeners.values()].every(set=>set.size===0)).toBe(true);
  });

  it.each(['signal','source','transport'])('deferred HTML seek loses ownership on %s and never changes a newer source',async reason=>{
    const listeners=new Map();let rawTime=0;
    const videoEl={src:'old.mov',duration:1,get currentTime(){return rawTime;},set currentTime(value){rawTime=Math.min(value,this.duration);},
      addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
    const runtime=resetPlayerAdapter(null,videoEl),controller=new AbortController();
    const result=runtime.seek(5,{signal:controller.signal}).catch(error=>error);
    if(reason==='signal')controller.abort();
    else if(reason==='source'){videoEl.src='new.mov';listeners.get('durationchange')();}
    else await runtime.enterHtml5(videoEl);
    expect(await result).toMatchObject({name:'AbortError'});
    videoEl.duration=8;listeners.get('durationchange')?.();
    expect(rawTime).toBe(1);expect(listeners.size).toBe(0);
  });

  it('nonzero container origin selects the absolute HTML clock without changing the native descriptor', async () => {
    const callbacks=[];
    const videoEl={src:'file:///origin-five.mkv',currentTime:5.5,duration:8.5,
      requestVideoFrameCallback:callback=>{callbacks.push(callback);return callbacks.length;},cancelVideoFrameCallback:vi.fn()};
    const runtime=resetPlayerAdapter(null,videoEl);
    const descriptor={timestampOffset:-.5,presentationTimestampOffset:-5.5};
    runtime.registerSourceClock(videoEl.src,descriptor);
    expect(descriptor.timestampOffset).toBe(-.5);
    expect(runtime.sourceClock(videoEl.src)).toEqual({timestampOffset:-5.5});
    expect(runtime.sourceTime()).toBe(0);
    expect(runtime.sourceDuration()).toBe(3);
    await runtime.seek(0);
    expect(videoEl.currentTime).toBe(5.5);
    const pending=runtime.present(2.8,{tolerance:.000001,frameStart:2.8,frameDuration:1/30});
    expect(videoEl.currentTime).toBe(8.3);
    callbacks.shift()(0,{mediaTime:3.3});
    expect(callbacks).toHaveLength(1);
    callbacks.shift()(0,{mediaTime:8.3});
    await expect(pending).resolves.toMatchObject({presentedSourceTime:expect.closeTo(2.8,10)});
    runtime.registerSourceClock('proxy',null);videoEl.src='proxy';videoEl.duration=3;
    await runtime.seek(2.8);
    expect(videoEl.currentTime).toBe(2.8);
    expect(runtime.sourceDuration()).toBe(3);
  });

  it('HTML source zero owns seek, frame evidence, source clock and duration together', async () => {
    const callbacks=[];
    const videoEl={src:'file:///delayed-video.mkv',currentTime:.5,duration:3.5,
      requestVideoFrameCallback:callback=>{callbacks.push(callback);return callbacks.length;},cancelVideoFrameCallback:vi.fn()};
    const runtime=resetPlayerAdapter(null,videoEl);
    runtime.registerSourceClock(videoEl.src,{timestampOffset:-.5});
    expect(runtime.sourceTime()).toBe(0);
    expect(runtime.sourceDuration()).toBe(3);
    await runtime.seek(1.2);
    expect(videoEl.currentTime).toBe(1.7);
    const pending=runtime.present(2.8,{tolerance:.000001,frameStart:2.8,frameDuration:1/30});
    expect(videoEl.currentTime).toBe(3.3);
    callbacks.shift()(0,{mediaTime:2.8});
    expect(callbacks).toHaveLength(1);
    callbacks.shift()(0,{mediaTime:3.3});
    await expect(pending).resolves.toEqual({backend:'html5',presentedSourceTime:2.8,presentedSourceDuration:1/30});
  });

  it('changing source preserves each mother clock and keeps Proxy at zero', async () => {
    const videoEl={src:'mother-a',currentTime:3.3,duration:3.5};
    const runtime=resetPlayerAdapter(null,videoEl);
    runtime.registerSourceClock('mother-a',{timestampOffset:-.5});
    runtime.registerSourceClock('mother-b',{timestampOffset:-.25});
    expect(runtime.sourceTime()).toBe(2.8);
    videoEl.src='proxy';videoEl.duration=3;videoEl.currentTime=2.8;
    await runtime.enterHtml5(videoEl);
    expect(runtime.sourceTime()).toBe(2.8);
    expect(runtime.sourceDuration()).toBe(3);
    videoEl.src='mother-b';await runtime.seek(2.8);
    expect(videoEl.currentTime).toBe(3.05);
    videoEl.src='mother-a';await runtime.seek(2.8);
    expect(videoEl.currentTime).toBe(3.3);
  });

  it('HTML seeked fallback reports the same normalized source time', async () => {
    let seeked;
    const videoEl={src:'mother',currentTime:.5,addEventListener:(name,fn)=>{seeked=fn;},removeEventListener:vi.fn()};
    const runtime=resetPlayerAdapter(null,videoEl);
    runtime.registerSourceClock('mother',{timestampOffset:-.5});
    const pending=runtime.present(2.8,{tolerance:.000001});
    expect(videoEl.currentTime).toBe(3.3);
    seeked();
    await expect(pending).resolves.toMatchObject({presentedSourceTime:2.8});
  });
  it('mpv mode exposes native reverse direction while HTML5 keeps the fallback contract', async () => {
    const direction = vi.fn().mockResolvedValue(true);
    const runtime = resetPlayerAdapter({ mpv: {
      launch: vi.fn().mockResolvedValue({ ok: true }),
      direction,
    } });

    expect(runtime.supportsNativeReverse()).toBe(false);
    await runtime.enterMpv({ src: 'D:/media/a.mxf' });
    expect(runtime.supportsNativeReverse()).toBe(true);
    await runtime.direction('backward');
    await runtime.direction('forward');

    expect(direction).toHaveBeenNthCalledWith(1, 'backward');
    expect(direction).toHaveBeenNthCalledWith(2, 'forward');

    await runtime.enterHtml5({ pause: vi.fn() });
    expect(runtime.supportsNativeReverse()).toBe(false);
    await expect(runtime.direction('backward')).resolves.toBe(false);
  });

  it('HTML5 mode delegates transport to the injected video element', async () => {
    const videoEl = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
      preservesPitch: true,
    };
    const runtime = resetPlayerAdapter(null, videoEl);
    expect(runtime.type).toBe('html5');

    await runtime.play();
    expect(videoEl.play).toHaveBeenCalled();

    await runtime.pause();
    expect(videoEl.pause).toHaveBeenCalled();

    await runtime.seek(42);
    expect(videoEl.currentTime).toBe(42);

    await runtime.rate(0.5);
    expect(videoEl.playbackRate).toBe(0.5);
    expect(videoEl.preservesPitch).toBe(true);
  });

  it('HTML5 present 會略過舊畫格，直到 compositor 回報目標附近的實際畫格', async () => {
    const callbacks = [];
    const videoEl = {
      currentTime: 0,
      requestVideoFrameCallback: vi.fn(callback => {
        callbacks.push(callback);
        return callbacks.length;
      }),
      cancelVideoFrameCallback: vi.fn(),
    };
    const runtime = resetPlayerAdapter(null, videoEl);

    const pending = runtime.present(4.2, { tolerance: 0.05 });
    expect(videoEl.currentTime).toBe(4.2);
    callbacks.shift()(0, { mediaTime: 2 });
    expect(callbacks).toHaveLength(1);
    callbacks.shift()(0, { mediaTime: 4.18 });

    await expect(pending).resolves.toEqual({ backend: 'html5', presentedSourceTime: 4.18 });
  });

  it('HTML5 seeked 不會搶在畫格回呼前提交播放位置', async () => {
    let frameCallback;
    const listeners = new Map();
    const videoEl = {
      currentTime: 0,
      requestVideoFrameCallback: vi.fn(callback => { frameCallback = callback; return 1; }),
      cancelVideoFrameCallback: vi.fn(),
      addEventListener: vi.fn((name, callback) => listeners.set(name, callback)),
      removeEventListener: vi.fn((name) => listeners.delete(name)),
    };
    const runtime = resetPlayerAdapter(null, videoEl);
    let settled = false;
    const pending = runtime.present(7, { tolerance: 0.02 }).then(result => {
      settled = true;
      return result;
    });

    listeners.get('seeked')?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(videoEl.addEventListener).not.toHaveBeenCalledWith('seeked', expect.any(Function));

    frameCallback(0, { mediaTime: 7 });
    await expect(pending).resolves.toEqual({ backend: 'html5', presentedSourceTime: 7 });
  });

  it('沒有畫格回呼的 HTML5 環境仍可在 seeked 後完成定位', async () => {
    const listeners = new Map();
    const videoEl = {
      currentTime: 0,
      addEventListener: vi.fn((name, callback) => listeners.set(name, callback)),
      removeEventListener: vi.fn((name) => listeners.delete(name)),
    };
    const runtime = resetPlayerAdapter(null, videoEl);
    const pending = runtime.present(3.5, { tolerance: 0.02 });
    expect(videoEl.currentTime).toBe(3.5);
    listeners.get('seeked')();
    await expect(pending).resolves.toEqual({ backend: 'html5', presentedSourceTime: 3.5 });
    expect(listeners.has('seeked')).toBe(false);
  });

  it('mpv present 交由 native bridge 回報實際 video PTS', async () => {
    const present = vi.fn().mockResolvedValue({ backend: 'mpv', presentedSourceTime: 11.96 });
    const runtime = resetPlayerAdapter({ mpv: {
      launch: vi.fn().mockResolvedValue({ ok: true }),
      present,
    } });
    await runtime.enterMpv({ src: 'D:/media/a.mxf' });

    await expect(runtime.present(12, { exact: true, tolerance: 0.05 })).resolves.toEqual({
      backend: 'mpv', presentedSourceTime: 11.96,
    });
    expect(present).toHaveBeenCalledWith(12, { exact: true, tolerance: 0.05 });
  });

  it('HTML5 mode reports mpv-only transport operations as unavailable', async () => {
    const runtime = resetPlayerAdapter(null, {});
    await expect(runtime.subSet('test')).resolves.toBe(false);
    await expect(runtime.loadfile('/x')).resolves.toBe(false);
  });
});

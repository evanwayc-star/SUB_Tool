// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};

describe('Proxy 聲道接手後的定位與起播同步',()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

  it.each([[0,'continue'],[80,'continue'],[250,'continue'],[80,'pause'],[80,'reset'],[80,'seek'],[250,'late-ack'],[250,'late-ack-slow'],[80,'ack-error'],
    [0,'video-buffering'],[0,'video-pause'],[0,'video-reset'],[0,'video-seek'],[0,'video-failure'],[0,'video-reply-after-progress'],
    [0,'video-invalid-true'],[0,'video-invalid-false'],[0,'video-invalid-undefined'],[0,'video-invalid-clock'],[0,'video-buffering-16'],[0,'video-rebuffering']])(
    '同一來源兩個聲道定位準備相差 %i ms，%s 後不應回音或重播舊工作',async(readinessDelay,action)=>{
    vi.resetModules();
    document.body.innerHTML=readFileSync('index.html','utf8');
    const video=document.getElementById('video');
    video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
    const ingest=deferred(),elements=[],trace=[],channelCount=action==='video-buffering-16'?16:2;
    let Media,nativeEvent,nativeMuted=false,nativePlaying=false,deferReadiness=false,nextPlayAck=null,nextPresentation=null,nextPlaybackReady=null;
    const nativeProperty=(name,data)=>nativeEvent({event:'property-change',name,data,sourceSessionId:'mother'});
    const capture=event=>trace.push({event,nativeAudible:nativePlaying&&!nativeMuted,
      channels:elements.filter(element=>element.audible).map(element=>({src:element.src,time:element.currentTime}))});
    class AudioElement extends EventTarget{
      constructor(){
        super();this.src='';this._time=0;this.duration=12;this.readyState=4;this.seeking=false;
        this.paused=true;this.audible=false;this.playbackRate=1;this.pendingPlay=[];elements.push(this);
      }
      get currentTime(){return this._time;}
      set currentTime(value){
        this._time=value;
        if(deferReadiness){
          this.seeking=true;this.readyState=1;
          if(this.delayNextSeek)this.delayNextSeek=false;
          else queueMicrotask(()=>this.ready());
        }
      }
      play=vi.fn(()=>{
        this.paused=false;
        if(this.seeking||this.readyState<3)return new Promise((resolve,reject)=>this.pendingPlay.push({resolve,reject}));
        this.audible=true;capture('element-playing');return Promise.resolve();
      });
      pause=vi.fn(()=>{
        this.paused=true;this.audible=false;
        for(const pending of this.pendingPlay.splice(0))pending.reject(new DOMException('paused','AbortError'));
        capture('element-pause');
      });
      load=vi.fn();
      ready(){
        this.seeking=false;this.readyState=4;
        this.dispatchEvent(new Event('seeked'));this.dispatchEvent(new Event('canplay'));
        if(!this.paused&&this.pendingPlay.length){
          this.audible=true;capture('element-playing');
          for(const pending of this.pendingPlay.splice(0))pending.resolve();
        }
      }
      advance(seconds){if(this.audible)this._time+=seconds*this.playbackRate;}
    }
    const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
      createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
      createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
      createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
    window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({ok:true,duration:12,sourceSessionId:'mother'})),
      play:vi.fn(async options=>{
        nativePlaying=true;capture('native-play');if(nextPlayAck)await nextPlayAck.promise;
        if(nextPlaybackReady&&options?.waitForReady)return await nextPlaybackReady.promise;
        if(options?.waitForReady)return {ready:true,sourceTime:Media.vTime()};
      }),
      pause:vi.fn(async()=>{nativePlaying=false;capture('native-pause');}),
      present:vi.fn(async time=>{if(nextPresentation)await nextPresentation.promise;return {backend:'mpv',presentedSourceTime:time};}),
      quit:vi.fn(async()=>{}),onEvent:vi.fn(callback=>{nativeEvent=callback;}),mute:vi.fn(async value=>{nativeMuted=value;capture('native-mute');})};
    Object.defineProperty(window,'subtool',{configurable:true,value:{isDesktop:true,mpv,
      stat:vi.fn(async()=>({exists:true,size:6_000_000_000})),
      probe:vi.fn(async()=>({duration:12,video:{codec:'mpeg2video',fps:25,width:1920,height:1080},audio:[{channels:channelCount}]})),
      ingest:vi.fn(()=>ingest.promise),fileURL:vi.fn(async path=>`file:///${path}`)}});
    ({Media}=await import('../src/media.js'));
    const {State}=await import('../src/state.js');
    // This fixture exercises the mother video's clock with cached audio.
    // Switching the video to a smooth/local preview has separate coverage.
    State.previewMode='original';
    try{
      await Media.loadDesktopMedia('C:/mother.mxf');
      Media.play();
      ingest.resolve({proxy:'C:/cache/preview.mp4',channels:Array.from({length:channelCount},(_,sourceChannel)=>({
        file:`C:/cache/channel-${sourceChannel}.m4a`,label:`A${sourceChannel+1}`,sourceStream:0,sourceChannel,
      }))});
      await vi.waitFor(()=>expect(Media.tracks.filter(track=>track.kind==='element')).toHaveLength(channelCount));
      await vi.waitFor(()=>expect(elements.filter(element=>element.audible)).toHaveLength(channelCount));
      expect(nativeMuted).toBe(true);
      Media.pause({seekOnPause:false});
      if(action.startsWith('video-')){
        // A paused seek can return its target before unpause has enough video
        // data to advance. Command acceptance alone must not release followers.
        nextPresentation=deferred();nextPlaybackReady=deferred();
        const sought=Media.seek(4);
        Media.play();await flush();
        expect(elements.some(element=>element.audible)).toBe(false);
        for(const element of elements)element.play.mockClear();
        nextPresentation.resolve();await sought;await flush();
        const positions=[];
        for(let tick=0;tick<5;tick++){
          for(const element of elements)element.advance(.2);
          context.currentTime+=.2;
          Media.syncAudioDrift();await flush();
          positions.push(elements.map(element=>element.currentTime));
        }
        expect(elements.map(element=>element.play.mock.calls.length),JSON.stringify({positions,trace})).toEqual(Array(channelCount).fill(0));
        expect(mpv.play).toHaveBeenLastCalledWith(expect.objectContaining({waitForReady:true}));
        expect(nativeMuted).toBe(true);
        if(action.startsWith('video-invalid-')){
          nextPlaybackReady.resolve({'video-invalid-true':true,'video-invalid-false':false,
            'video-invalid-undefined':undefined,'video-invalid-clock':{ready:true}}[action]);
          await vi.waitFor(()=>expect(Media.playing).toBe(false));
          expect(elements.some(element=>element.audible)).toBe(false);expect(nativePlaying).toBe(false);
          expect(elements.map(element=>element.play.mock.calls.length)).toEqual([0,0]);return;
        }
        if(action==='video-failure'){
          nextPlaybackReady.reject(new Error('native playback readiness timeout'));
          await vi.waitFor(()=>expect(Media.playing).toBe(false));
          expect(elements.some(element=>element.audible)).toBe(false);expect(nativePlaying).toBe(false);
          return;
        }
        if(action==='video-pause'||action==='video-reset'){
          if(action==='video-pause')Media.pause({seekOnPause:false});else Media.reset();
          nextPlaybackReady.resolve({ready:true,sourceTime:4.04});await flush();
          expect(elements.some(element=>element.audible)).toBe(false);
          expect(Media.playing).toBe(false);return;
        }
        if(action==='video-seek'){
          const oldReady=nextPlaybackReady;nextPlaybackReady=deferred();
          const starts=mpv.play.mock.calls.length;
          await Media.seek(8);
          await vi.waitFor(()=>expect(mpv.play).toHaveBeenCalledTimes(starts+1));
          oldReady.resolve({ready:true,sourceTime:4.04});await flush();
          expect(elements.some(element=>element.audible)).toBe(false);
          nextPlaybackReady.resolve({ready:true,sourceTime:8});
          await vi.waitFor(()=>expect(elements.every(element=>element.audible)).toBe(true));
          expect(elements.map(element=>element.currentTime)).toEqual([8,8]);return;
        }
        if(action==='video-reply-after-progress')nativeProperty('time-pos',4.3);
        nextPlaybackReady.resolve({ready:true,sourceTime:4.04});
        await vi.waitFor(()=>expect(elements.every(element=>element.audible)).toBe(true));
        if(action==='video-reply-after-progress'){
          expect(elements.map(element=>element.currentTime)).toEqual([4.3,4.3]);return;
        }
        expect(elements.map(element=>element.play.mock.calls.length)).toEqual(Array(channelCount).fill(1));
        if(action==='video-rebuffering'){
          // A NAS source can briefly advance after seek, then run out of data.
          // The cached audio must not repeatedly replay the same 200 ms while
          // the native video's source clock remains at the accepted frame.
          nativeProperty('paused-for-cache',true);
          const stalledPositions=[];
          for(let tick=0;tick<5;tick++){
            for(const element of elements)element.advance(.2);
            context.currentTime+=.2;
            Media.syncAudioDrift();await flush();
            stalledPositions.push(elements.map(element=>element.currentTime));
          }
          expect(elements.map(element=>element.play.mock.calls.length),JSON.stringify({stalledPositions,trace}))
            .toEqual(Array(channelCount).fill(1));
          expect(elements.some(element=>element.audible)).toBe(false);
          return;
        }
        for(const element of elements)element.advance(.2);
        nativeProperty('time-pos',4.24);
        Media.syncAudioDrift();await flush();
        expect(elements.map(element=>element.play.mock.calls.length)).toEqual(Array(channelCount).fill(1));
        expect(elements.map(element=>element.currentTime)).toEqual(Array(channelCount).fill(4.2));
        return;
      }
      await Media.seek(4);
      const [first,second]=elements;
      const completeStaggeredStart=async target=>{
        deferReadiness=true;
        for(const element of elements)element.delayNextSeek=true;
        if(action.startsWith('late-ack')||action==='ack-error')nextPlayAck=deferred();
        Media.play();
        await vi.waitFor(()=>expect(elements.every(element=>element.seeking)).toBe(true));
        const starts=mpv.play.mock.calls.length;
        first.ready();await flush();
        expect(mpv.play).toHaveBeenCalledTimes(starts);
        expect(first.audible).toBe(false);
        if(['pause','reset','seek'].includes(action)){
          if(action==='pause')Media.pause({seekOnPause:false});
          if(action==='reset')Media.reset();
          if(action==='seek'){
            for(const element of elements)element.delayNextSeek=true;
            await Media.seek(9);
            await vi.waitFor(()=>expect(elements.every(element=>element.currentTime===9&&element.seeking)).toBe(true));
            second.dispatchEvent(new Event('canplay'));
            await flush();expect(elements.some(element=>element.audible)).toBe(false);
            first.ready();second.ready();
            await vi.waitFor(()=>expect(elements.every(element=>element.audible)).toBe(true));
            expect(elements.map(element=>element.currentTime)).toEqual([9,9]);
          }else{
            second.ready();await flush();
            expect(elements.some(element=>element.audible)).toBe(false);
            expect(mpv.play).toHaveBeenCalledTimes(starts);
          }
          return null;
        }
        const elapsed=readinessDelay/1000;
        first.advance(elapsed);context.currentTime+=elapsed;
        if(nativePlaying)nativeProperty('time-pos',target+elapsed);
        Media.syncAudioDrift();
        second.ready();await flush();
        if(action.startsWith('late-ack')||action==='ack-error'){
          await vi.waitFor(()=>expect(mpv.play).toHaveBeenCalledTimes(starts+1));
          expect(elements.some(element=>element.audible)).toBe(false);
          if(action==='ack-error'){
            second.dispatchEvent(new Event('error'));nextPlayAck.resolve();
            await vi.waitFor(()=>expect(Media.playing).toBe(false));
            expect(elements.some(element=>element.audible)).toBe(false);expect(nativePlaying).toBe(false);
            return null;
          }
          nativeProperty('time-pos',target+elapsed);
          if(action==='late-ack-slow')for(const element of elements)element.delayNextSeek=true;
          nextPlayAck.resolve();
          if(action==='late-ack-slow'){
            await vi.waitFor(()=>expect(elements.every(element=>element.seeking&&element.currentTime===target+elapsed)).toBe(true));
            first.ready();
            context.currentTime+=.4;
            nativeProperty('time-pos',target+elapsed+.4);
            Media.syncAudioDrift();expect(first.audible).toBe(false);
            second.ready();
          }
        }
        await vi.waitFor(()=>expect(elements.every(element=>element.audible)).toBe(true));
        if(action.startsWith('late-ack'))expect(elements.map(element=>element.currentTime)).toEqual([target+elapsed,target+elapsed]);
        await vi.waitFor(()=>expect(Media.playbackTransitionPending()).toBe(false));
        Media.syncAudioDrift();
        await flush();
        if(action==='late-ack-slow')expect(elements.map(element=>element.currentTime)).toEqual([target+elapsed+.4,target+elapsed+.4]);
        return Math.abs(first.currentTime-second.currentTime);
      };
      const firstJumpDrift=await completeStaggeredStart(4);
      if(action!=='continue')return;
      // 同位置的資料已就緒，暫停再播放便一起從目前位置開始；新的遠距
      // 跳轉再次需要 NAS 資料，聲道準備時間又可能不同。
      Media.pause({seekOnPause:false});
      deferReadiness=false;
      Media.play();
      await vi.waitFor(()=>expect(elements.filter(element=>element.audible)).toHaveLength(2));
      expect(Math.abs(first.currentTime-second.currentTime)).toBeLessThan(.01);
      Media.pause({seekOnPause:false});
      await Media.seek(8);
      const secondJumpDrift=await completeStaggeredStart(8);
      const audible=Media.tracks.filter(track=>track.kind==='element'&&track.el.audible&&track.gain.gain.value>0);
      expect(audible).toHaveLength(2);
      expect(Media.tracks.filter(track=>track.kind==='element')).toHaveLength(2);
      expect(trace.filter(entry=>entry.nativeAudible&&entry.channels.length)).toEqual([]);
      expect(nativeMuted).toBe(true);
      // 兩聲道可包含同一句對白；各自從舊 off 起播會產生 80 ms 回音，
      // 且現有 120 ms drift 容差不會校正。不能只檢查 play() 被呼叫幾次。
      expect(Math.max(firstJumpDrift,secondJumpDrift),JSON.stringify({firstJumpDrift,secondJumpDrift,trace,
        channels:audible.map(track=>({time:track.el.currentTime,gain:track.gain.gain.value}))})).toBeLessThan(.01);
    }finally{Media.reset();delete window.subtool;}
  });
});

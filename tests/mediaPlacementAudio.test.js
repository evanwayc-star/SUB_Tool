// @subtool-ci windows
// @vitest-environment jsdom
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {nativeTestTools} from './fixtures/native-tools.cjs';
vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
const buffers=[],elements=[];
function pcm(values,rate=10){
  const data=values.map(value=>Float32Array.from(value));
  return {duration:data[0].length/rate,length:data[0].length,sampleRate:rate,numberOfChannels:data.length,getChannelData:channel=>data[channel]};
}
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
  createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(.5)}),
  createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node(),
  createBuffer:(channels,count,rate)=>pcm(Array.from({length:channels},()=>Array(count).fill(0)),rate),
  createBufferSource:()=>{const source={...node(),playbackRate:{value:1},start:vi.fn(),stop:vi.fn()};buffers.push(source);return source;},
};
class AudioElement extends EventTarget{
  constructor(){super();this.src='';this.currentTime=0;this.duration=10;this.readyState=1;this.paused=true;this.playbackRate=1;this.preservesPitch=true;elements.push(this);}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
}
let Media,Wave,State,resetAudioProject,ensureAudioSourceMap,Seq,AudioEngine,resetPlayerAdapter,activateMpvTransport,video,History;
beforeAll(async()=>{
  document.body.innerHTML=readFileSync('index.html','utf8');
  video=document.getElementById('video');
  Object.defineProperty(video,'duration',{configurable:true,value:10});
  Object.defineProperty(video,'readyState',{configurable:true,value:1});
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  video.requestVideoFrameCallback=cb=>{queueMicrotask(()=>cb(0,{mediaTime:video.currentTime}));return 1;};
  video.cancelVideoFrameCallback=vi.fn();
  window.AudioContext=function(){return context;};globalThis.Audio=AudioElement;
  ({Media,Wave}=await import('../src/media.js'));({State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));({AudioEngine}=await import('../src/audio-engine.js'));
  ({resetPlayerAdapter,activateMpvTransport}=await import('../src/media-player-adapter.js'));
  const history=await import('../src/history.js');History=history.History;
  const {on}=await import('../src/events.js');on('history:record',history.recordHistory);
});
beforeEach(()=>{
  Media.reset();resetAudioProject();State.videoTracks=[{name:'V1',visible:true},{name:'V2',visible:true}];
  State.duration=10;State.fps=30;State.dropFrame=false;State.muted=false;
  video.src='file:///source.mov';video.currentTime=0;context.currentTime=0;buffers.length=0;elements.length=0;
  resetPlayerAdapter(null,video);Media.ensureCtx();
});
afterEach(()=>{Media.reset();vi.restoreAllMocks();});
function primary(){
  const clip=Seq.add({id:'mother',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},primary:true,
    dur:10,in:0,out:10,offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);return clip;
}
function overlap(){
  const left=primary();expect(Media.splitClipAt(5)).toBe(true);
  const right=State.clips.find(clip=>clip!==left);Seq.moveToTrack(right,1);right.offset=0;Seq.resolveOverlaps(right);Seq.recomputeDuration();
  return {left,right};
}
function track(kind='buffer'){
  const tr={kind,source:'video',audioSourceId:'mother-source',sourceStream:0,sourceChannel:0,
    gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),muted:false,solo:false,volume:1,
    ...(kind==='buffer'?{buffer:pcm([Array.from({length:100},(_,i)=>i/100)])}:{el:new AudioElement()})};
  if(tr.el)tr.el.src='file:///source.mov';Media.tracks.push(tr);return tr;
}
describe('公開 sequence placement 到實際音訊節點',()=>{
  it.skipIf(!existsSync(nativeTestTools().ffmpeg)).each([false,true])('轉檔退路讀真proxy header歸零，取消%s不能安裝晚到素材',async cancelled=>{
    const {ffmpeg}=nativeTestTools();
    const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'subtool-transcode-proxy-clock-'));
    const output=path.join(directory,'preview.mp4'),base=path.join(directory,'base.mp4');
    const rawDuration=Object.getOwnPropertyDescriptor(video,'duration');
    try{
      const encoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',
        'color=red:s=64x48:r=25:d=3','-an','-c:v','libx264','-bf','0','-fps_mode','passthrough',
        '-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart',base],{windowsHide:true,timeout:20000});
      expect(encoded.error||encoded.status,encoded.stderr?.toString()).toBe(0);
      const remuxed=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-itsoffset','0.533','-i',base,'-c:v','copy','-an',
        '-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart',output],{windowsHide:true,timeout:20000});
      expect(remuxed.error||remuxed.status,remuxed.stderr?.toString()).toBe(0);
      const proxy=readFileSync(output);let logger,release;
      const ff={setLogger:fn=>{logger=fn;},FS:vi.fn((command,name)=>command==='readFile'&&name==='prev.mp4'?proxy:undefined),
        run:vi.fn(async(...args)=>{if(args.length===2){logger({message:'Stream #0:0: Video: h264'});throw new Error('probe');}})};
      vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);
      vi.spyOn(AudioEngine,'_sourceMetadata').mockResolvedValue(null);
      vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:real-transcode-proxy');
      vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
      vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,{headers}={})=>{
        if(cancelled&&!release)await new Promise(resolve=>{release=resolve;});
        const match=/bytes=(\d+)-(\d+)/.exec(headers.Range),part=proxy.subarray(Number(match[1]),Number(match[2])+1);
        return {ok:true,status:206,arrayBuffer:async()=>part.buffer.slice(part.byteOffset,part.byteOffset+part.length)};
      });
      Object.defineProperty(video,'duration',{configurable:true,value:3.533});
      const pending=Media.loadVideoFile(new File([new Uint8Array(8)],'unsupported.mxf'));
      if(cancelled){
        await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
        Media.reset();await expect(pending).resolves.toBeUndefined();
        release();await Promise.resolve();expect(State.clips).toEqual([]);expect(video.currentTime).toBe(0);
      }else{
        await expect(pending).resolves.toBeUndefined();expect(State.duration).toBe(3);expect(Seq.primary().dur).toBe(3);
        expect(video.currentTime).toBe(.533);expect(Media.vTime()).toBe(0);
        await Media.seek(2.8);expect(video.currentTime).toBeCloseTo(3.333,10);expect(Media.vTime()).toBeCloseTo(2.8,10);
      }
    }finally{
      Object.defineProperty(video,'duration',rawDuration);
      const resolved=realpathSync(directory);
      if(path.dirname(resolved)!==realpathSync(tmpdir())||!path.basename(resolved).startsWith('subtool-transcode-proxy-clock-'))throw new Error('proxy test cleanup boundary');
      rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  });

  it('public overlap placement audio uses each mother player clock while normalized cache stays at zero',async()=>{
    const {getPlayerAdapter}=await import('../src/media-player-adapter.js');
    const {right}=overlap();right.speed=2;const tr=track('element');
    getPlayerAdapter().registerSourceClock(tr.el.src,{timestampOffset:-.5});
    await Media.requestPresentation(1);Media.startElementSources(1,1);
    const voices=elements.filter(element=>element!==tr.el);
    expect(voices.map(element=>[element.currentTime,element.playbackRate])).toEqual([[1.5,1],[7.5,2]]);
    Media.stopElementSources();
    right.offset=5;right.speed=1;Seq.recomputeDuration();
    tr.el.src='file:///normalized-channel.wav';Media.startElementSources(1,1);
    expect(tr.el.currentTime).toBe(1);
  });

  it('切割並跨軌疊合後，兩個buffer聲音與交付母素材區間一致，逐格也保留兩個聲音',async()=>{
    const {left,right}=overlap();track();await Media.requestPresentation(2);Media.startBufferSources(2);
    expect(buffers.map(source=>source.start.mock.calls[0][1])).toEqual([2,7]);
    const delivery=Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips});
    expect(delivery.buses[0].inputs.map(input=>[input.offset,input.trimStart,input.trimEnd])).toEqual([[0,0,5],[0,5,10]]);
    context.currentTime=1;video.currentTime=8;expect(AudioEngine.syncBuffers(8)).toBe(false);
    Media.stopBufferSources();expect(buffers.every(source=>source.stop.mock.calls.length>0)).toBe(true);
    buffers.length=0;Media.scrubAudio(2,.08);expect(buffers.map(source=>source.start.mock.calls[0][1])).toEqual([2,7]);
    AudioEngine.stopScrubs();expect(buffers.every(source=>source.stop.mock.calls.length>0)).toBe(true);
    right.offset=5;Seq.recomputeDuration();await Media.requestPresentation(2);buffers.length=0;Media.startBufferSources(2);
    expect(buffers.map(source=>source.start.mock.calls[0][1])).toEqual([2]);expect(left.in).toBe(0);
  });
  it('element疊合持有獨立時鐘和速率，停止與reset釋放clone並拒絕晚到metadata',async()=>{
    const {right}=overlap();right.speed=2;const tr=track('element');await Media.requestPresentation(1);
    Media.startElementSources(1,1);const clone=elements.find(element=>element!==tr.el);
    const voices=elements.filter(element=>element!==tr.el);expect(tr.el.paused).toBe(true);
    expect(voices.map(element=>[element.currentTime,element.playbackRate])).toEqual([[1,1],[7,2]]);
    Media.playing=true;video.currentTime=8;context.currentTime=.5;Media.syncAudioDrift();expect(voices[1].currentTime).toBe(8);
    Media.stopElementSources();expect(clone.paused).toBe(true);
    clone.play.mockClear();Media.reset();clone.dispatchEvent(new Event('canplay'));expect(clone.play).not.toHaveBeenCalled();expect(clone.src).toBe('');
  });
  it('公開播放等待metadata後只定位一次；seek完成的canplay不再打斷兩個placement',async()=>{
    const pending=[];
    class SeekingAudio extends AudioElement{
      constructor(){
        super();this.duration=NaN;this.readyState=0;this.seeks=[];
        let time=0;
        Object.defineProperty(this,'currentTime',{get:()=>time,set:value=>{
          time=value;this.seeks.push(value);this.readyState=1;
          pending.push(()=>{this.readyState=4;this.dispatchEvent(new Event('canplay'));});
        }});
      }
    }
    vi.stubGlobal('Audio',SeekingAudio);
    try{
      const {left,right}=overlap();left.fadeIn=4;right.speed=2;
      const tr=track('element');await Media.requestPresentation(1);Media.play();
      await vi.waitFor(()=>expect(elements.filter(element=>element!==tr.el)).toHaveLength(2));
      const voices=elements.filter(element=>element!==tr.el);
      expect(tr.el.paused).toBe(true);expect(voices.every(element=>element.paused)).toBe(true);
      // metadata 較晚到達時，起播仍使用當下的時間軸及各片段的來源時間。
      video.currentTime=7.2;context.currentTime=.1;
      for(const element of voices){element.duration=10;element.readyState=1;element.dispatchEvent(new Event('loadedmetadata'));}
      const settle=()=>{for(let i=0;i<8&&pending.length;i++)pending.shift()();expect(pending).toHaveLength(0);};
      settle();
      expect(voices.map(element=>[element.currentTime,element.playbackRate,element.paused])).toEqual([[1.1,1,false],[7.2,2,false]]);
      expect(voices.map(element=>element.seeks.length)).toEqual([1,1]);
      expect(voices.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
      await Media.seek(2);settle();
      expect(voices.map(element=>element.currentTime)).toEqual([2,9]);
      expect(voices.map(element=>element.seeks.length)).toEqual([2,2]);
      Media.pause({seekOnPause:false});
      for(const element of voices)element.dispatchEvent(new Event('canplay'));
      expect(voices.every(element=>element.paused)).toBe(true);expect(pending).toHaveLength(0);
    }finally{vi.unstubAllGlobals();}
  });
  it('公開播放的同源疊合結束後，只保留存活placement的一個element聲音',async()=>{
    const {right}=overlap();right.offset=2;Seq.recomputeDuration();
    const tr=track('element');await Media.requestPresentation(3);Media.play();
    await vi.waitFor(()=>expect(elements.filter(element=>!element.paused)).toHaveLength(2));
    const previous=elements.filter(element=>element!==tr.el);
    video.currentTime=8.1;context.currentTime=2.1;Media.seqTick();Media.syncAudioDrift();
    expect(Media.displayTime()).toBeCloseTo(5.1);
    expect(elements.filter(element=>!element.paused)).toHaveLength(1);
    expect(elements.find(element=>!element.paused).currentTime).toBeCloseTo(8.1);
    for(const element of previous)element.dispatchEvent(new Event('canplay'));
    expect(previous.every(element=>element.paused&&element.src==='')).toBe(true);
    await Media.seek(3);
    expect(tr.el.paused).toBe(true);
    expect(elements.filter(element=>!element.paused).map(element=>element.currentTime)).toEqual([3,6]);
  });
  it('兩個反向同源片段的PCM區間都被保留，而不互相取代',async()=>{
    const {left,right}=overlap();left.reverse=true;right.reverse=true;const tr=track();
    await Media.prepareClipReverseAudio(left);await Media.prepareClipReverseAudio(right);
    video.currentTime=3;Media.startBufferSources(3);
    expect(buffers).toHaveLength(2);expect(buffers.map(source=>source.start.mock.calls[0][1])).toEqual([2,2]);
    expect(buffers[0].buffer.getChannelData(0)[0]).toBeCloseTo(tr.buffer.getChannelData(0)[49]);
    expect(buffers[1].buffer.getChannelData(0)[0]).toBeCloseTo(tr.buffer.getChannelData(0)[99]);
  });
  it('刪除原片段後來源mute持久化到所有存活分割，且同名不同母素材不受影響',async()=>{
    const {left,right}=overlap();track();
    const other=Seq.add({id:'other',name:'source.mov',path:'D:/source.mov',dur:10,in:0,out:10,offset:20,
      audioSrc:'clip:other',audioSourceId:'other-source'});
    Media.removeClip(left.id);await Media.requestPresentation(2);Media.toggleSourceMute('video');
    expect(Media.sourceMuted('video')).toBe(true);expect(Seq.snapshot().find(clip=>clip.id===right.id).muted).toBe(true);expect(other.muted).toBeFalsy();
    Media.toggleSourceMute('video');expect(Seq.snapshot().find(clip=>clip.id===right.id).muted).toBe(false);
  });
  it('mpv的實際來源時間寫入live waveform；timeline offset、HTML時鐘和間隙不污染來源桶',async()=>{
    const clip=primary();track('element');clip.in=4;clip.out=6;clip.offset=20;Seq.recomputeDuration();
    const runtime=activateMpvTransport({mpv:{launch:async()=>({ok:true}),present:async t=>({presentedSourceTime:t}),pause:async()=>{},mute:async()=>{}}});
    await runtime.enterMpv({src:clip.path});Media.observeMpvEvent({event:'property-change',name:'time-pos',data:4.5});
    Media.playing=true;video.currentTime=0;Wave.initLive();Wave.captureLive();
    expect(Wave.peaks.length).toBe(10*Wave.resolution*2);expect(Wave.peaks[1]).toBe(0);
    expect(Wave.peaks[Math.floor(4.5*Wave.resolution)*2+1]).toBe(.5);
    const snapshot=Wave.peaks.slice();Media.playing=false;Wave.captureLive();expect(Wave.peaks).toEqual(snapshot);
    await Media.requestPresentation(10);Media.playing=true;Wave.captureLive();expect(Wave.peaks).toEqual(snapshot);
  });
  it('每placement獨立套用fade且自動在trim out止聲，來源mute/solo/音量仍控制所有聲音',async()=>{
    const {left,right}=overlap();delete left.fadeSourceLength;delete right.fadeSourceLength;delete right.fadeSourceOffset;
    left.fadeIn=4;left.fadeOut=0;right.fadeIn=0;right.fadeOut=4;right.speed=2;
    const tr=track();await Media.requestPresentation(1);Media.startBufferSources(7);
    const gates=buffers.map(source=>source.connect.mock.calls[0][0]),outputs=gates.map(gate=>gate.connect.mock.calls[0][0]);
    expect(gates[0]).not.toBe(gates[1]);expect(gates[0].gain.value).toBe(.25);expect(gates[1].gain.value).toBe(1);
    expect(outputs[0].gain.value).toBe(1);expect(outputs[1].gain.value).toBe(.6);
    expect(outputs.map(output=>output.connect.mock.calls[0][0])).toEqual([tr.gain,tr.gain]);
    expect(buffers.map(source=>source.start.mock.calls[0])).toEqual([[0,1,4],[0,7,3]]);
    expect(outputs[0].gain.setValueAtTime).toHaveBeenCalledWith(0,4);expect(outputs[1].gain.setValueAtTime).toHaveBeenCalledWith(0,1.5);
    Media.setSourceVolume('video',.4);expect(tr.gain.gain.value).toBe(.4);
    Media.toggleSourceMute('video');expect(tr.gain.gain.value).toBe(0);Media.toggleSourceSolo('video');expect(tr.gain.gain.value).toBe(.4);
    const delivery=Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips});
    expect(delivery.buses[0].inputs.map(input=>[input.speed||1,input.fadeIn,input.fadeOut,input.volume])).toEqual([[1,4,0,.4],[2,0,4,.4]]);
  });
  it('真正Media ticker啟動晚入場的同源placement並在第一段out後保留另一段',async()=>{
    const {left,right}=overlap();right.offset=2;Seq.recomputeDuration();track();await Media.requestPresentation(1);Media.play();
    await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));expect(buffers.at(-1).start.mock.calls[0][1]).toBe(1);
    video.currentTime=2.1;context.currentTime=1.1;Media.seqTick();
    expect(buffers.slice(-2).map(source=>source.start.mock.calls[0][1])).toEqual([2.1,5.1]);
    expect(buffers.slice(-2).map(source=>source.start.mock.calls[0][2])).toEqual([2.9,4.9]);
    const previous=buffers.slice(-2);video.currentTime=5.01;context.currentTime=4.01;Media.seqTick();
    await vi.waitFor(()=>expect(Media.activeClip()?.id).toBe(right.id));
    expect(previous.every(source=>source.stop.mock.calls.length>0)).toBe(true);
    expect(buffers.at(-1).start.mock.calls[0][1]).toBeCloseTo(8);expect(Media.activeClip()?.id).not.toBe(left.id);Media.pause();
  });
  it('公開轉場套用在播放中即時更新buffer placement的淡化，與交付一致',async()=>{
    const {left}=overlap();track();await Media.requestPresentation(1);Media.play();
    await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
    const {setClipFade}=await import('../src/clip-model.js');
    expect(setClipFade(left,4,0)).toBe(true);
    await vi.waitFor(()=>{
      Media.seqTick();Media.syncAudioDrift();
      const voice=buffers.findLast(source=>source.start.mock.calls[0]?.[1]===1);
      expect(voice.connect.mock.calls[0][0].gain.value).toBe(.25);
    });
    expect(Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips}).buses[0].inputs[0].fadeIn).toBe(4);
  });
  it('mpv背景聲道尚未載入時source mute能切換carrier，且交付fallback保持靜音',async()=>{
    const clip=primary(),mute=vi.fn(async()=>{});
    const runtime=activateMpvTransport({mpv:{launch:async()=>({ok:true}),pause:async()=>{},mute}});await runtime.enterMpv({src:clip.path});
    Media.toggleSourceMute('video');expect(Media.sourceMuted('video')).toBe(true);expect(mute).toHaveBeenLastCalledWith(true);
    expect(Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips}).buses.every(bus=>bus.inputs.length===0)).toBe(true);
    Media.toggleSourceMute('video');expect(Media.sourceMuted('video')).toBe(false);expect(mute).toHaveBeenLastCalledWith(false);
  });
  it('公開History undo/redo將來源mute快照投回存活聲音與交付計畫',async()=>{
    primary();const tr=track();await Media.requestPresentation(2);History.reset();Media.toggleSourceMute('video');
    expect(tr.gain.gain.value).toBe(0);expect(History.stack).toHaveLength(2);
    History.undo();await Media.waitForHistorySequenceRestore();expect(Media.sourceMuted('video')).toBe(false);expect(tr.muted).toBe(false);expect(tr.gain.gain.value).toBe(1);
    History.redo();await Media.waitForHistorySequenceRestore();expect(Media.sourceMuted('video')).toBe(true);expect(tr.gain.gain.value).toBe(0);
    expect(Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips}).buses.every(bus=>bus.inputs.length===0)).toBe(true);
  });
  it('抽取action持續可見、保留原始多串流的每個Mono聲道與路由，reset後拒絕舊action',async()=>{
    primary();let logger;
    const ff={setLogger:fn=>{logger=fn;},FS:vi.fn((command)=>command==='readFile'?new Uint8Array(8):undefined),
      run:vi.fn(async(...args)=>{if(args.includes('probe.in')){logger({message:'Stream #0:1: Audio: pcm\nStream #0:2: Audio: pcm'});throw new Error('probe');}})};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);
    vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(pcm([[.1,.2],[.3,.4]])).mockResolvedValueOnce(pcm([[.5,.6]]));
    const file=new File([new Uint8Array(8)],'source.mov');await Media.probeAndMaybeExtract(file);
    await vi.waitFor(()=>expect(Media.audioPanelState().extraction?.count).toBe(2));
    const {renderAudioTracks}=await import('../src/mixer.js');renderAudioTracks();renderAudioTracks();
    expect(getComputedStyle(document.getElementById('atHint')).display).not.toBe('none');expect(document.getElementById('extractLink')).not.toBeNull();
    const action=Media.audioPanelState().extraction;expect(await action.run()).toBe(true);
    expect(Media.tracks.filter(track=>track.kind==='buffer').map(track=>[track.audioSourceId,track.sourceStream,track.sourceChannel,...track.buffer.getChannelData(0)]))
      .toEqual([['mother-source',0,0,Math.fround(.1),Math.fround(.2)],['mother-source',0,1,Math.fround(.3),Math.fround(.4)],['mother-source',1,0,Math.fround(.5),Math.fround(.6)]]);
    expect(Media.tracks.every(track=>Media.trackAudible(track))).toBe(true);expect(ff.run.mock.calls.some(args=>args.includes('-ac'))).toBe(false);
    expect(Media.audioPanelState().extraction).toBeNull();Media.reset();expect(await action.run()).toBe(false);
  });
  it('公開loadVideoFile非原生轉檔同樣展開原始每個聲道，bus單獨控制不串音',async()=>{
    let logger;
    const ff={setLogger:fn=>{logger=fn;},FS:vi.fn(command=>command==='readFile'?new Uint8Array(8):undefined),
      run:vi.fn(async(...args)=>{if(args.length===2){logger({message:'Stream #0:1: Audio: pcm'});throw new Error('probe');}})};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(pcm([[.1,.2],[.7,.8]]));
    const descriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL');Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:transcoded')});
    try{await Media.loadVideoFile(new File([new Uint8Array(8)],'source.mxf'));}
    finally{if(descriptor)Object.defineProperty(URL,'createObjectURL',descriptor);else delete URL.createObjectURL;}
    const channels=Media.sourceChannels('video');expect(channels.map(track=>track.sourceChannel)).toEqual([0,1]);
    expect(channels[0].buffer.getChannelData(0)[0]).toBeCloseTo(.1);expect(channels[1].buffer.getChannelData(0)[0]).toBeCloseTo(.7);
    const clip=Seq.primary();
    expect(Math.max(...Wave.getSourceWaveform(clip).peaks)).toBeCloseTo(.5);
    Wave.setSourceWaveSelection(clip,'0:1');expect(Math.max(...Wave.getSourceWaveform(clip).peaks)).toBeCloseTo(.8);
    Media.toggleProjectBusMute(State.audioProject.buses[0].id);expect(channels[0].gain.gain.value).toBe(0);expect(channels[1].gain.gain.value).toBe(1);
    expect(ff.run.mock.calls.some(args=>args.includes('-ac'))).toBe(false);
  });
  it('公開多軌抽取按各stream decoder epoch歸零，mono副本維持來源時鐘而不再次裁切',async()=>{
    const clip=primary();clip.dur=1;clip.out=1;Seq.recomputeDuration();
    const ff={FS:command=>command==='readFile'?new Uint8Array(8):undefined,run:async()=>{}};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);
    const metadata={presentationTimestampOffset:-5.5,decoderAudioPresentationTimestampOffsets:[-5,-5.2],duration:1};
    const clock=vi.spyOn(AudioEngine,'_sourceMetadata').mockResolvedValue(metadata);
    vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(pcm([
      [...Array(500).fill(.2),...Array(1000).fill(.8)], [...Array(500).fill(-.2),...Array(1000).fill(-.8)]],1000))
      .mockResolvedValueOnce(pcm([[...Array(300).fill(.1),...Array(1000).fill(.6)]],1000));
    expect(await Media.extractAllAudio(new File([new Uint8Array(8)],'original.mov'),2)).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1);
    const channels=Media.sourceChannels('video');
    expect(channels.map(track=>[track.sourceStream,track.sourceChannel,track.buffer.duration,track.buffer.getChannelData(0)[0]]))
      .toEqual([[0,0,1,Math.fround(.8)],[0,1,1,Math.fround(-.8)],[1,0,1,Math.fround(.6)]]);
    for(const track of channels)expect(await AudioEngine.normalizeSourceAudioBuffer(track.buffer,{metadata,sourceStream:track.sourceStream})).toBe(track.buffer);
    await Media.requestPresentation(.2);Media.startBufferSources(.2);
    expect(buffers.map(buffer=>buffer.start.mock.calls[0][1])).toEqual([.2,.2,.2]);
  });
  it('公開抽取多 stream 波形保留全部原聲道；較短 stream 的尾端補零而不截斷來源',async()=>{
    const clip=primary();
    const ff={FS:command=>command==='readFile'?new Uint8Array(8):undefined,run:async()=>{}};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);
    vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValueOnce(pcm([[0,0],[.6,.6]],10))
      .mockResolvedValueOnce(pcm([[.3,.3,.3,.3,-.9,-.9,-.9,-.9]],20));
    expect(await Media.extractAllAudio(new File([new Uint8Array(8)],'multi.mov'),2)).toBe(true);
    expect(Wave.getSourceWaveOptions(clip).map(option=>option.id)).toEqual(['mix','0:0','0:1','1:0','vocals']);
    const mixed=Wave.getSourceWaveform(clip).peaks;
    expect(mixed).toHaveLength(80);expect(Math.max(...mixed)).toBeCloseTo(.3);expect(Math.min(...mixed)).toBeCloseTo(-.3);
    expect(mixed[79]).toBe(0);expect(mixed[78]).toBeCloseTo(-.3);
    Wave.setSourceWaveSelection(clip,'0:1');expect(Math.max(...Wave.getSourceWaveform(clip).peaks)).toBeCloseTo(.6);
    Wave.setSourceWaveSelection(clip,'1:0');const last=Wave.getSourceWaveform(clip).peaks;
    expect(last).toHaveLength(80);expect(Math.min(...last)).toBeCloseTo(-.9);
    Media.toggleSourceMute('video');Wave.setSourceWaveSelection(clip,'mix');expect(Wave.getSourceWaveform(clip).peaks).toBe(mixed);
  });
  it('同一路徑的獨立母素材保持自己的mute與voice，而不是按basename/path合併',async()=>{
    primary();const first=track();
    const other=Seq.add({id:'independent',name:'source.mov',path:'C:/source.mov',web:{url:'file:///source.mov'},
      dur:10,in:0,out:10,offset:0,vtrack:1,audioSrc:'clip:independent',audioSourceId:'independent-source'});
    ensureAudioSourceMap(other.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
    const second={...first,source:other.audioSrc,audioSourceId:other.audioSourceId,gain:AudioEngine.createGain(),buffer:pcm([Array(100).fill(.7)])};Media.tracks.push(second);
    await Media.requestPresentation(2);Media.toggleSourceMute('video');Media.startBufferSources(2);
    expect(first.gain.gain.value).toBe(0);expect(second.gain.gain.value).toBe(1);expect(other.muted).toBeFalsy();
    expect(Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips}).buses[0].inputs).toHaveLength(1);
  });
  it('真native HTML載入再同源split疊合只播放兩個placement，HTML與mpv carrier都保持靜音',async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),revoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:native-source'});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
    const create=document.createElement.bind(document);vi.spyOn(document,'createElement').mockImplementation((tag,options)=>{const element=create(tag,options);if(tag==='video')queueMicrotask(()=>element.onloadedmetadata?.());return element;});
    let logger;const ff={FS:()=>{},setLogger:fn=>{logger=fn;},run:async()=>{logger?.({message:'Stream #0:1: Audio: pcm'});throw new Error('probe');}};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue(pcm([Array(100).fill(.1),Array(100).fill(.2)]));
    try{await Media.loadVideoFile(new File([new Uint8Array(8)],'source.mp4',{type:'video/mp4'}));}
    finally{if(descriptor)Object.defineProperty(URL,'createObjectURL',descriptor);else delete URL.createObjectURL;if(revoke)Object.defineProperty(URL,'revokeObjectURL',revoke);else delete URL.revokeObjectURL;}
    expect(Media.tracks.filter(track=>track.kind==='native')).toHaveLength(2);
    const left=State.clips[0];Media.tracks.forEach(track=>{track.volume=.4;});
    State.audioProject.buses.forEach(bus=>{bus.volume=.3;});await Media.requestPresentation(1);Media.play();
    await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
    const {setClipFade}=await import('../src/clip-model.js');expect(setClipFade(left,4,0)).toBe(true);
    await vi.waitFor(()=>{
      expect(Media.presenterClockMoving()).toBe(true);expect(video.muted).toBe(true);
      expect(elements.filter(element=>!element.paused)).toHaveLength(1);
    });
    const monitor=vi.spyOn(AudioEngine.analyser,'getFloatTimeDomainData').mockImplementation(data=>data.fill(.015));
    Wave.initLive();Wave.captureLive();expect(Wave.peaks[201]).toBe(.5);expect(monitor).not.toHaveBeenCalled();
    left.fadeIn=0;Media.playing=false;Media.stopElementSources();expect(Media.splitClipAt(5)).toBe(true);const right=State.clips.find(clip=>clip!==left);
    Seq.moveToTrack(right,1);right.offset=0;Seq.resolveOverlaps(right);Seq.recomputeDuration();await Media.requestPresentation(2);
    Media.startElementSources(7,2);expect(video.muted).toBe(true);
    expect(elements.filter(element=>!element.paused).map(element=>element.currentTime)).toEqual([2,7]);
    const mute=vi.fn(async()=>{}),runtime=activateMpvTransport({mpv:{launch:async()=>({ok:true}),pause:async()=>{},mute}});
    await runtime.enterMpv({src:'source.mp4'});Media.syncMuteState();expect(mute).toHaveBeenLastCalledWith(true);
  });
  it('in-page波形驗收比較實际播放來源窗口，無法由來源0錯寫騙過',()=>{
    const clip=primary();track('element');clip.offset=20;Media.playing=true;video.currentTime=5;Wave.initLive();
    const source=readFileSync('scripts/acceptance/in-page/verify-v6-1-2-wiring.js','utf8');
    const block=source.slice(source.indexOf('/* ── 6.'),source.indexOf('/* ── 輸出'));
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'info').mockImplementation(()=>{});
    new Function('S','ok',block)({Media,Wave},vi.fn());Wave.peaks[1]=.7;expect(window.__vfyWave()).toBe(null);
    Wave.captureLive();expect(window.__vfyWave()).toBe(true);expect(log).toHaveBeenCalled();
    new Function('S','ok',block)({Media,Wave},vi.fn());Wave.captureLive();expect(window.__vfyWave()).toBe(null);
    Wave.peaks.fill(0);vi.spyOn(AudioEngine,'readTimeDomain').mockReturnValue(new Float32Array(2048));
    new Function('S','ok',block)({Media,Wave},vi.fn());Wave.captureLive();expect(window.__vfyWave()).toBe(null);
  });
  it('同源疊合的總混音不會寫成母素材某一時刻的原始波形',async()=>{
    const {right}=overlap(),tr=track();tr.buffer=pcm([Array.from({length:100},(_,i)=>i<50?.1:.2)]);
    await Media.requestPresentation(2);Media.startBufferSources(2);Media.playing=true;Wave.initLive();
    const mixed=buffers.reduce((sum,source)=>sum+source.buffer.getChannelData(0)[Math.round(source.start.mock.calls[0][1]*10)],0);
    expect(mixed).toBeCloseTo(.3,6);vi.spyOn(AudioEngine,'readTimeDomain').mockReturnValue(Float32Array.of(mixed));
    Wave.captureLive();expect(Wave.peaks.every(value=>value===0)).toBe(true);
    right.offset=8;Seq.recomputeDuration();await Media.requestPresentation(2);Media.playing=true;
    vi.mocked(AudioEngine.readTimeDomain).mockReturnValue(Float32Array.of(.1));Wave.captureLive();
    expect(Wave.peaks[401]).toBeCloseTo(.1,6);
  });
  it('連續公開scrub會停掉上一個request的全部placement聲音',async()=>{
    overlap();track();await Media.requestPresentation(2);Media.scrubAudio(2,.08);const previous=buffers.slice();
    expect(previous).toHaveLength(2);Media.scrubAudio(2.1,.08);
    expect(previous.every(source=>source.stop.mock.calls.length===1)).toBe(true);
    Media.pause();expect(buffers.every(source=>source.stop.mock.calls.length>0)).toBe(true);
  });
  it('公開抽取Mono聲道後的人聲reader保留原始L/R相位，不先相加成雙Mono',async()=>{
    primary();const ff={FS:command=>command==='readFile'?new Uint8Array(8):undefined,run:async()=>{}};
    vi.spyOn(Media,'loadFFmpeg').mockResolvedValue(ff);
    vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue(pcm([Array(100).fill(.25),Array(100).fill(-.25)]));
    expect(await Media.extractAllAudio(new File([new Uint8Array(8)],'source.mov'),1)).toBe(true);
    vi.stubGlobal('OfflineAudioContext',class{
      constructor(_channels,length){this.length=length;this.nodes=[];this.destination={};}
      createGain(){return {gain:{value:1},connect(){}};}
      createBufferSource(){const source={buffer:null,gain:null,connect(gain){this.gain=gain;},start(){}};this.nodes.push(source);return source;}
      async startRendering(){return {getChannelData:channel=>new Float32Array(this.length).fill(this.nodes.reduce((sum,source)=>sum+source.buffer.getChannelData(Math.min(channel,source.buffer.numberOfChannels-1))[0]*source.gain.gain.value,0))};}
    });
    try{
      const {vocalWaveformClient}=await import('../src/vocal-waveform-worker-client.js');
      vi.spyOn(vocalWaveformClient,'analyze').mockImplementation(async({readChunk})=>{
        const [left,right]=await readChunk({start:0,duration:1});expect(left[0]).toBe(.25);expect(right[0]).toBe(-.25);
        return new Float32Array(2000);
      });
      const {analyzeSourceVocals}=await import('../src/vocal-waveform-source.js');await analyzeSourceVocals('mother-source');
    }finally{vi.unstubAllGlobals();}
  });
  it.skipIf(!existsSync(process.env.FFMPEG_PATH||path.resolve('electron/ffmpeg/ffmpeg.exe')))('預覽兩個實際來源PCM聲音的相加值與native ffmpeg交付PCM一致',async()=>{
    const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'subtool-placement-pcm-'));
    try{
      const rate=48000,data=Float32Array.from({length:10*rate},(_,i)=>i<5*rate?.1:.2),raw=path.join(directory,'source.f32'),file=path.join(directory,'source.wav');
      writeFileSync(raw,Buffer.from(data.buffer));const ffmpeg=process.env.FFMPEG_PATH||path.resolve('electron/ffmpeg/ffmpeg.exe');
      const execute=args=>{const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});if(result.error||result.status!==0)throw new Error(result.error?.message||String(result.stderr));return result.stdout;};
      execute(['-y','-f','f32le','-ar',String(rate),'-ac','1','-i',raw,'-c:a','pcm_f32le',file]);
      const {left,right}=overlap();left.path=file;right.path=file;const tr=track();tr.buffer=pcm([data],rate);
      State.audioProject.exportLayout={streams:[{id:'mono',layout:'mono',busIds:[State.audioProject.buses[0].id]}]};
      await Media.requestPresentation(2);Media.startBufferSources(7);
      const preview=buffers.reduce((sum,source)=>sum+source.buffer.getChannelData(0)[Math.round(source.start.mock.calls[0][1]*rate)],0);
      const audioPlan=Media.projectAudioInterpretation().buildDeliveryPlan({clips:State.clips});
      const {buildDeliveryArgv}=createRequire(path.resolve('package.json'))('./electron/export-plan.js');const output=path.join(directory,'output.wav');
      const plan=buildDeliveryArgv({format:'wav',audioPlan,outPath:output});execute(plan.args);
      const rendered=execute(['-i',output,'-f','f32le','-ac','1','-ar',String(rate),'pipe:1']);
      expect(preview).toBeCloseTo(.3,6);expect(rendered.readFloatLE(2*rate*4)).toBeCloseTo(preview,5);
    }finally{if(path.dirname(path.resolve(directory))!==realpathSync(tmpdir()))throw new Error('temp cleanup boundary');rmSync(directory,{recursive:true,force:true});}
  });
});

// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/decode/source-frame-index.js',()=>({sourceFrameWindow:vi.fn(),sourcePresentationMetadata:vi.fn(()=>null),clearSourceFrameIndexes:vi.fn()}));
const elements=[];
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
  createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
  createAnalyser:()=>({...node(),fftSize:2048}),createMediaElementSource:()=>node(),
  createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
class AudioElement extends EventTarget{
  constructor(){super();Object.assign(this,{src:'',currentTime:0,duration:6,readyState:4,paused:true,playbackRate:1});elements.push(this);}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
}
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
let Media,State,Seq,AudioEngine,resetAudioProject,ensureAudioSourceMap,activateMpvTransport,resetPlayerAdapter,sourceFrameWindow,video,runtime,bridge,clip;
beforeAll(async()=>{
  document.body.innerHTML=readFileSync('index.html','utf8');video=document.getElementById('video');
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  Object.defineProperties(video,{duration:{configurable:true,value:6},readyState:{configurable:true,value:4}});
  window.AudioContext=function(){return context;};globalThis.Audio=AudioElement;
  window.subtool={isDesktop:true,fileURL:vi.fn(async path=>'file:///'+path),reverseAudio:vi.fn(async()=>({path:'C:/reverse.wav'}))};
  ({Media}=await import('../src/media.js'));({State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));({AudioEngine}=await import('../src/audio-engine.js'));
  ({activateMpvTransport,resetPlayerAdapter}=await import('../src/media-player-adapter.js'));
  ({sourceFrameWindow}=await import('../src/decode/source-frame-index.js'));
});
beforeEach(async()=>{
  Media.reset();resetAudioProject();State.videoTracks=[{name:'V1',visible:true}];State.fps=25;State.dropFrame=false;State.muted=false;
  video.src='file:///C:/mother.mov';video.currentTime=0;context.currentTime=0;elements.length=0;
  resetPlayerAdapter(null,video);Media.ensureCtx();
  clip=Seq.add({id:'mother',name:'mother.mov',path:'C:/mother.mov',primary:true,dur:6,in:0,out:6,offset:0,vtrack:0,
    reverse:true,speed:2,audioSrc:'video',audioSourceId:'mother-source'});
  Media.activeClipId=clip.id;ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0}]);
  bridge={launch:vi.fn(async()=>({ok:true})),loadfile:vi.fn(async()=>({ok:true})),
    present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
    pause:vi.fn(async()=>null),play:vi.fn(async()=>null),direction:vi.fn(async()=>true),rate:vi.fn(async()=>null),mute:vi.fn(async()=>null)};
  runtime=activateMpvTransport({mpv:bridge});await runtime.enterMpv({src:'C:/proxy.mp4'});
  Media._mpvPath='C:/proxy.mp4';Media._reverseProxyPath='C:/proxy.mp4';Media._reverseProxySourcePath=clip.path;Media._reverseProxyActive=true;
  Media.setRate(1);
  const tr={kind:'element',source:'video',audioSourceId:clip.audioSourceId,sourceStream:0,sourceChannel:0,
    el:new AudioElement(),gain:AudioEngine.createGain(),analyser:AudioEngine.createAnalyser(),volume:1,muted:false,solo:false};
  tr.el.src='file:///C:/mother-audio.wav';Media.tracks.push(tr);
  sourceFrameWindow.mockImplementation(async(_url,time)=>time>=4.96?{start:4.96,end:5}:{start:4.92,end:4.96});
  await Media.seek(.52);await Media.prepareClipReverseAudio(clip);await flush();
  bridge.loadfile.mockClear();bridge.present.mockClear();vi.useFakeTimers();
});
afterEach(()=>{Media.pause({seekOnPause:false});Media.reset();runtime?.stopBoundsFeeder();resetPlayerAdapter(null,video);vi.useRealTimers();vi.restoreAllMocks();});
const carrier=()=>elements.find(el=>el.src==='file:///C:/reverse.wav');
const progress=time=>Media.observeMpvEvent({event:'property-change',name:'time-pos',data:time});

describe('已呈現 Proxy 的反向首播進展與一次復原',()=>{
  it('停鐘期間不重複回拉真反向音源，超過實際下一 PTS 期限後停止聲音並只重載同 Proxy 一次',async()=>{
    let loaded;bridge.loadfile.mockImplementation(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();expect(carrier().paused).toBe(false);expect(carrier().currentTime).toBeCloseTo(1.04);
    carrier().currentTime=1.64;context.currentTime=.3;Media.syncAudioDrift();
    expect(carrier().currentTime).toBeCloseTo(1.64);
    await vi.advanceTimersByTimeAsync(1100);
    expect(bridge.loadfile).toHaveBeenCalledExactlyOnceWith('C:/proxy.mp4');expect(carrier().paused).toBe(true);
    loaded({ok:true});await flush();expect(bridge.present).toHaveBeenCalled();expect(bridge.play).toHaveBeenCalledTimes(2);
    expect(carrier().paused).toBe(true);
    Media.observeMpvEvent({event:'property-change',name:'pause',data:true});
    Media.startElementSources(4.96,.52);Media.seqTick();await flush();
    expect(Media.playing).toBe(true);expect(carrier().paused).toBe(true);
    progress(4.56);await flush();expect(carrier().paused).toBe(false);expect(carrier().currentTime).toBeCloseTo(1.44);
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);expect(Media.playing).toBe(true);
  });
  it('重載仍無真時鐘進展便暫停，不因 ACK 成功無限重試',async()=>{
    Media.play();await flush();await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.loadfile).toHaveBeenCalledTimes(1);expect(bridge.play).toHaveBeenCalledTimes(2);
    expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);
    const {setStatus}=await import('../src/ui.js');expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('反向播放'), 'err');
    await vi.advanceTimersByTimeAsync(30000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it('重載後定位由格間 4.98 落到實際 PTS 4.96，不把定位下降當成播放恢復',async()=>{
    progress(4.98);Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);
    expect(bridge.present).toHaveBeenCalledWith(4.96,expect.any(Object));
    expect(bridge.play).toHaveBeenCalledTimes(2);expect(carrier().paused).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);expect(Media.playing).toBe(false);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it('復原 play ACK 等待中收到真時鐘進展，接受後依最新來源位置起音',async()=>{
    let accepted;bridge.play.mockResolvedValueOnce(null).mockImplementationOnce(()=>new Promise(resolve=>{accepted=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);expect(accepted).toBeTypeOf('function');
    progress(4.56);await flush();expect(carrier().paused).toBe(true);
    accepted(null);await flush();expect(carrier().paused).toBe(false);expect(carrier().currentTime).toBeCloseTo(1.44);
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it('實際反向 time-pos 前進即解除監測，正常播放不重載',async()=>{
    Media.play();await flush();progress(4.92);await flush();
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).not.toHaveBeenCalled();expect(Media.playing).toBe(true);
  });
  it.each(['missing','first-frame','forward','mother'])('%s 沒有可靠反向下一格或不屬已知 Proxy，不猜期限',async reason=>{
    if(reason==='missing')sourceFrameWindow.mockResolvedValue(null);
    if(reason==='first-frame')sourceFrameWindow.mockResolvedValue({start:0,end:6});
    if(reason==='forward')clip.reverse=false;
    if(reason==='mother')Media._reverseProxyActive=false;
    Media.play();await flush();await vi.advanceTimersByTimeAsync(30000);expect(bridge.loadfile).not.toHaveBeenCalled();
  });
  it('VFR 稀疏畫格按真正前一 PTS 與慢速倍率等待，不能按平均 FPS 提早重載',async()=>{
    Media.setRate(.25);sourceFrameWindow.mockImplementation(async(_url,time)=>time>=4.96?{start:4.96,end:6}:{start:.96,end:4.96});
    Media.play();await flush();await vi.advanceTimersByTimeAsync(8999);expect(bridge.loadfile).not.toHaveBeenCalled();
    progress(.96);await flush();await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).not.toHaveBeenCalled();
  });
  it.each([{target:.52,indexed:false,phase:4.96},{target:.6,indexed:false,phase:4.8},{target:.52,indexed:true,phase:4.5}])(
    '低 FPS 同一持格的起始相位 $phase 不因只觀察到 PTS 4.5 提早重載',async({target,indexed,phase})=>{
      Media.setRate(.125); // 片段 2x × 播放 0.125x = 來源 0.25x。
      let indexReady=indexed;
      sourceFrameWindow.mockImplementation(async(_url,time)=>{
        if(!indexReady)return null;
        const start=Math.floor(time*2)/2;return {start,end:start+.5};
      });
      await Media.seek(target);
      expect(bridge.present.mock.lastCall[0]).toBeCloseTo(phase,8);
      // 原生 seek 的媒體時鐘可以保留格內相位，但觀察值只提供顯示的 PTS。
      indexReady=true;progress(4.5);Media.play();await flush();
      const firstStepMs=(phase-4)/.25*1000;
      await vi.advanceTimersByTimeAsync(firstStepMs-1);expect(bridge.loadfile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);progress(4);await flush();
      expect(carrier().paused).toBe(false);await vi.advanceTimersByTimeAsync(10000);
      expect(bridge.loadfile).not.toHaveBeenCalled();expect(Media.playing).toBe(true);
    });
  it('低 FPS 超過完整持格上界仍無進展才重載，第二次超時只暫停',async()=>{
    Media.setRate(.125);
    sourceFrameWindow.mockImplementation(async(_url,time)=>{const start=Math.floor(time*2)/2;return {start,end:start+.5};});
    await Media.seek(.52);progress(4.5);Media.play();await flush();
    await vi.advanceTimersByTimeAsync(4999);expect(bridge.loadfile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
    expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);
  });
  it.each(['pause','seek','reset','rate','source','direction','end'])('等待期間 %s 撤銷舊首播復原',async action=>{
    Media.play();await flush();
    if(action==='pause')Media.pause({seekOnPause:false});
    if(action==='seek'){Media.pause({seekOnPause:false});await Media.seek(1);}
    if(action==='reset')Media.reset();
    if(action==='rate')Media.setRate(.5);
    if(action==='source'){State.clips=[{...clip,path:'C:/new.mov'}];}
    if(action==='direction')await Media.setPlaybackDirection('backward');
    if(action==='end')Media.observeMpvEvent({event:'end-file',reason:'eof'});
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).not.toHaveBeenCalled();
  });
  it.each(['progress','pause','seek','reset','rate'])('延後索引在 %s 後完成，不替舊意圖啟動期限',async action=>{
    let indexed;sourceFrameWindow.mockImplementationOnce(()=>new Promise(resolve=>{indexed=resolve;}));
    Media.play();await flush();expect(indexed).toBeTypeOf('function');
    if(action==='progress')progress(4.92);
    if(action==='pause')Media.pause({seekOnPause:false});
    if(action==='seek'){Media.pause({seekOnPause:false});await Media.seek(1);}
    if(action==='reset')Media.reset();
    if(action==='rate')Media.setRate(.5);
    indexed({start:4.96,end:5});await flush();await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.loadfile).not.toHaveBeenCalled();
  });
  it.each(['pause','seek','reset','source'])('重載等待中 %s 不讓舊完成晚到起播',async action=>{
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);expect(loaded).toBeTypeOf('function');
    expect(carrier().paused).toBe(true);const plays=bridge.play.mock.calls.length;let seeking;
    if(action==='pause')Media.pause({seekOnPause:false});
    if(action==='seek'){Media.pause({seekOnPause:false});seeking=Media.seek(1);}
    if(action==='reset')Media.reset();
    if(action==='source')State.clips=[{...clip,path:'C:/new.mov'}];
    loaded({ok:true});await flush();if(seeking)await seeking;
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.play).toHaveBeenCalledTimes(plays);
    if(action!=='reset')expect(carrier().paused).toBe(true);
    expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it.each(['seek','rate'])('重載中仍播放的 %s 新意圖等待真畫格後接管，不留下假播放狀態',async action=>{
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);let seeking;
    if(action==='seek')seeking=Media.seek(1);
    else Media.setRate(.5);
    await flush();expect(bridge.play).toHaveBeenCalledTimes(1);
    loaded({ok:true});await flush();if(seeking)await seeking;
    expect(bridge.play).toHaveBeenCalledTimes(2);expect(Media.playing).toBe(true);expect(carrier().paused).toBe(false);
    if(action==='seek')expect(carrier().currentTime).toBeCloseTo(2);
    else expect(carrier().playbackRate).toBe(1);
    progress(action==='seek'?3.96:4.92);await flush();await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it('重載中改 JKL 方向先排在 loadfile 後，舊反向復原不得覆寫新方向',async()=>{
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);bridge.direction.mockClear();
    const direction=Media.setPlaybackDirection('backward');await flush();expect(bridge.direction).not.toHaveBeenCalled();
    loaded({ok:true});await direction;await flush();expect(bridge.direction).toHaveBeenCalledExactlyOnceWith('forward');
    expect(bridge.play).toHaveBeenCalledTimes(1);
  });
  it('重載等待中暫停再按播放，新的意圖等 loadfile 及真正畫格，不被舊完成吞掉',async()=>{
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);
    Media.pause({seekOnPause:false});Media.play();await flush();expect(bridge.play).toHaveBeenCalledTimes(1);
    loaded({ok:true});await flush();expect(bridge.present).toHaveBeenCalled();expect(bridge.play).toHaveBeenCalledTimes(2);
    progress(4.92);await flush();expect(carrier().paused).toBe(false);expect(Media.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it.each(['pause','seek'])('恢復畫格等待中 %s 撤銷起播，但保留較新定位',async action=>{
    let presented;bridge.present.mockImplementationOnce(()=>new Promise(resolve=>{presented=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);expect(presented).toBeTypeOf('function');
    Media.pause({seekOnPause:false});let seeking;
    if(action==='seek')seeking=Media.seek(1);
    presented({backend:'mpv',presentedSourceTime:4.96});await flush();if(seeking)await seeking;
    expect(bridge.play).toHaveBeenCalledTimes(1);expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);
    if(action==='seek')expect(Media.displayTime()).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it.each(['load-false','load-reject','direction','present','play'])('復原 %s 失敗有明確暫停且不重試',async stage=>{
    if(stage==='load-false')bridge.loadfile.mockResolvedValueOnce({ok:false});
    if(stage==='load-reject')bridge.loadfile.mockRejectedValueOnce(new Error('load failed'));
    if(stage==='direction')bridge.direction.mockResolvedValueOnce(false);
    if(stage==='present')bridge.present.mockRejectedValueOnce(new Error('no matching frame'));
    if(stage==='play')bridge.play.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('not accepted'));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(20000);
    expect(bridge.loadfile).toHaveBeenCalledTimes(1);expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);
  });
  it.each(['seek','play'].flatMap(intent=>['false','reject'].map(failure=>[intent,failure])))('較新 %s 等待共用重載 %s，不吞錯誤或假成功起播',async(intent,failure)=>{
    let loaded,rejected;bridge.loadfile.mockImplementationOnce(()=>new Promise((resolve,reject)=>{loaded=resolve;rejected=reject;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);let outcome;
    if(intent==='seek')outcome=Media.seek(1).then(value=>({value}),error=>({error}));
    else {Media.pause({seekOnPause:false});Media.play();}
    await flush();expect(bridge.play).toHaveBeenCalledTimes(1);
    if(failure==='false')loaded({ok:false});else rejected(new Error('native load failed'));
    await flush();if(outcome)expect(await outcome).toMatchObject({value:{status:'failed'}});
    expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);expect(bridge.play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);expect(bridge.loadfile).toHaveBeenCalledTimes(1);
  });
  it('同 Proxy 重載成功後讓字幕 bridge 重建原生字幕，不留空白',async()=>{
    const {on}=await import('../src/events.js');const refresh=vi.fn();on('mpv:refreshSubs',refresh);
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);
    expect(bridge.loadfile).toHaveBeenCalledTimes(1);expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(['false','reject'])('重載 %s 後 JKL 不宣稱新方向可用',async failure=>{
    let loaded,rejected;bridge.loadfile.mockImplementationOnce(()=>new Promise((resolve,reject)=>{loaded=resolve;rejected=reject;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);bridge.direction.mockClear();
    Media.pause({seekOnPause:false});const direction=Media.setPlaybackDirection('backward');await flush();
    if(failure==='false')loaded({ok:false});else rejected(new Error('load failed'));
    await expect(direction).resolves.toBe(false);expect(bridge.direction).not.toHaveBeenCalled();expect(bridge.play).toHaveBeenCalledTimes(1);
  });
  it.each(['pause','new-seek','new-source'])('已送出重載初始化到 0，%s 保留目前暫停畫格與字幕的真實所有權',async action=>{
    const {on}=await import('../src/events.js');const refresh=vi.fn();on('mpv:refreshSubs',refresh);
    let loaded,presented,nativeSource=4.96;
    bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=()=>{nativeSource=0;progress(0);resolve({ok:true});};}));
    bridge.present.mockImplementationOnce(time=>new Promise(resolve=>{presented=()=>{nativeSource=time;resolve({backend:'mpv',presentedSourceTime:time});};}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);Media.pause({seekOnPause:false});
    loaded();await flush();expect(nativeSource).toBe(0);expect(presented).toBeTypeOf('function');expect(refresh).toHaveBeenCalledTimes(1);
    expect(Media.displayTime()).toBe(.52);expect(Media.playing).toBe(false);expect(carrier().paused).toBe(true);let seeking;
    if(action==='new-seek')seeking=Media.seek(1);
    if(action==='new-source'){Media.reset();State.duration=10;}
    presented();await flush();if(seeking)await seeking;
    expect(bridge.play).toHaveBeenCalledTimes(1);expect(Media.playing).toBe(false);
    if(action==='pause'){expect(nativeSource).toBe(4.96);expect(Media.presentedTime()).toBe(.52);}
    if(action==='new-seek')expect(Media.displayTime()).toBe(1);
    if(action==='new-source')expect(Media.displayTime()).toBe(0);
  });
  it('真正 JKL 的 Pause→方向→Play 等暫停目標呈現，不從重載檔頭起播',async()=>{
    let loaded,presented,nativeSource=4.96;
    bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=()=>{nativeSource=0;progress(0);resolve({ok:true});};}));
    bridge.present.mockImplementationOnce(time=>new Promise(resolve=>{presented=()=>{nativeSource=time;resolve({backend:'mpv',presentedSourceTime:time});};}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);
    Media.cancelPresentation('reverse-start');Media.pause({seekOnPause:false});bridge.direction.mockClear();
    const direction=Media.setPlaybackDirection('backward');loaded();await flush();
    expect(nativeSource).toBe(0);expect(presented).toBeTypeOf('function');expect(bridge.direction).not.toHaveBeenCalled();
    presented();await expect(direction).resolves.toBe(true);expect(nativeSource).toBe(4.96);
    Media.setRate(1);Media.play();await flush();expect(bridge.play).toHaveBeenCalledTimes(2);
    expect(carrier().paused).toBe(true); // JKL 保留既有倒帶靜音契約。
  });
  it.each(['reset','source'])('實際重載完成前 %s 換掉 source owner，不補舊字幕或定位',async action=>{
    const {on}=await import('../src/events.js');const refresh=vi.fn();on('mpv:refreshSubs',refresh);
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);Media.pause({seekOnPause:false});
    if(action==='reset')Media.reset();else State.clips=[{...clip,path:'C:/new.mov'}];
    loaded({ok:true});await flush();expect(refresh).not.toHaveBeenCalled();expect(bridge.present).not.toHaveBeenCalled();
    expect(bridge.play).toHaveBeenCalledTimes(1);
  });
  it.each([1,2])('UI 連續 %s 次預設 pause() 在重載未完成時不向未就緒來源先送 seek',async count=>{
    let loaded;bridge.loadfile.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));bridge.seek=vi.fn(async()=>null);
    Media.play();await flush();await vi.advanceTimersByTimeAsync(1100);
    for(let i=0;i<count;i++)Media.pause();await flush();
    expect(bridge.seek).not.toHaveBeenCalled();expect(bridge.present).not.toHaveBeenCalled();
    loaded({ok:true});await flush();expect(bridge.present).toHaveBeenCalledWith(4.96,expect.any(Object));
    expect(Media.presentedTime()).toBe(.52);expect(Media.playing).toBe(false);expect(bridge.play).toHaveBeenCalledTimes(1);
  });
});

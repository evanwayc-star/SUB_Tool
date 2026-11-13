// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),showOsd:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/decode/source-frame-index.js',()=>({sourceFrameWindow:vi.fn(async()=>null),
  sourcePresentationMetadata:vi.fn(async()=>null),clearSourceFrameIndexes:vi.fn()}));

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const flush=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function fixture({path='C:/mother.mov',mode='original',prepareLocalPreview}={}){
  vi.resetModules();
  document.body.innerHTML=readFileSync('index.html','utf8');
  const video=document.getElementById('video');
  video.pause=vi.fn();video.play=vi.fn(async()=>{});video.load=vi.fn();
  const elements=[],presentations=[],trace=[];
  let nativeEvent,session=0,holdPresent=false;
  class AudioElement extends EventTarget{
    constructor(){super();this.src=`file:///cache-${elements.length}.m4a`;this._time=0;this.duration=12;
      this.readyState=4;this.seeking=false;this.paused=true;this.holdSeek=false;elements.push(this);}
    get currentTime(){return this._time;}
    set currentTime(value){this._time=value;trace.push({type:'seek',channel:elements.indexOf(this),time:value});
      if(this.holdSeek){this.seeking=true;this.readyState=1;}}
    play=vi.fn(async()=>{this.paused=false;trace.push({type:'play',channel:elements.indexOf(this),time:this._time});});
    pause=vi.fn(()=>{this.paused=true;});
    load=vi.fn();
    ready(){this.holdSeek=false;this.seeking=false;this.readyState=4;
      this.dispatchEvent(new Event('seeked'));this.dispatchEvent(new Event('canplay'));}
  }
  const context={state:'running',currentTime:0,destination:{},resume:vi.fn(),
    createGain:()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}}),
    createAnalyser:()=>({...node(),fftSize:2048,getFloatTimeDomainData:buf=>buf.fill(0)}),
    createMediaElementSource:()=>node(),createChannelSplitter:()=>node(),createChannelMerger:()=>node()};
  window.AudioContext=function(){return context;};vi.stubGlobal('Audio',AudioElement);
  const accepted=()=>({ok:true,duration:12,sourceSessionId:`source-${++session}`});
  const mpv={launch:vi.fn(async()=>accepted()),loadfile:vi.fn(async()=>accepted()),
    play:vi.fn(async()=>({ready:true,sourceTime:Media.vTime()})),pause:vi.fn(async()=>{}),
    seek:vi.fn(async()=>true),direction:vi.fn(async()=>true),cancelPresent:vi.fn(async()=>true),
    present:vi.fn(time=>{
      const result={backend:'mpv',presentedSourceTime:time};
      if(!holdPresent)return Promise.resolve(result);
      const work={...deferred(),time,result};presentations.push(work);return work.promise;
    }),mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{}),onEvent:vi.fn(callback=>{nativeEvent=callback;})};
  const desktop={isDesktop:true,mpv,fileURL:vi.fn(async file=>`file:///${file.replaceAll('\\','/')}`),
    ...(prepareLocalPreview?{prepareLocalPreview}:{}),cancelMediaIntake:vi.fn(async()=>true)};
  Object.defineProperty(window,'subtool',{configurable:true,value:desktop});
  const {Media}=await import('../src/media.js');
  const {State,resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
  const {activateMpvTransport}=await import('../src/media-player-adapter.js');
  const {clipSourceFingerprint}=await import('../src/media-intake-engine.js');
  const {Seq}=await import('../src/sequence.js');
  Media.reset();resetAudioProject();State.duration=12;State.fps=25;State.dropFrame=false;State.muted=false;State.previewMode=mode;
  const adapter=activateMpvTransport(desktop,video);
  adapter.onEvent(event=>Media.observeMpvEvent(event));
  await adapter.enterMpv({src:path});
  const clip=Seq.add({id:'mother',name:'mother.mov',path,primary:true,dur:12,in:0,out:12,
    offset:0,vtrack:0,audioSrc:'video',audioSourceId:'mother-audio'});
  Media.activeClipId=clip.id;Media._mpvPath=path;Media.ensureCtx();
  ensureAudioSourceMap(clip.audioSourceId,[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}]);
  const assets={path,proxy:'C:/cache/proxy.mp4',channels:[0,1].map(index=>({file:`C:/cache/channel-${index}.m4a`}))};
  for(let sourceChannel=0;sourceChannel<2;sourceChannel++)Media.tracks.push({kind:'element',source:'video',audioSourceId:clip.audioSourceId,
    sourceStream:0,sourceChannel,file:assets.channels[sourceChannel].file,el:new AudioElement(),gain:context.createGain(),muted:false,solo:false,volume:1});
  const register=()=>Media._previewCatalog().register(clipSourceFingerprint(clip),assets,Media.captureMediaOwnership());
  const startAt=async time=>{
    await Media.seek(time);Media.play();
    await vi.waitFor(()=>expect(elements.every(element=>!element.paused)).toBe(true));
  };
  const finishPresentation=async index=>{
    await vi.waitFor(()=>expect(presentations[index]).toBeDefined());
    const work=presentations[index];work.resolve(work.result);await flush();
  };
  const dispose=()=>{for(const work of presentations)work.resolve(work.result);Media.reset();delete window.subtool;};
  return {Media,State,Seq,clip,adapter,mpv,desktop,elements,trace,assets,register,startAt,accepted,finishPresentation,
    holdPresent:()=>{holdPresent=true;},emit:(name,data)=>nativeEvent({event:'property-change',name,data,sourceSessionId:`source-${session}`}),dispose};
}

it('順暢預覽正播使用已登記 proxy，原始模式切回母片且不改專案路徑或片段幾何',async()=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    const saved=JSON.stringify(f.clip);
    expect(await f.Media.setPreviewMode('smooth')).toBe(true);
    expect(f.mpv.loadfile).toHaveBeenLastCalledWith(f.assets.proxy);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
    expect(f.Media.previewState()).toMatchObject({mode:'smooth',sourceKind:'proxy',proxyAvailable:true});
    f.Media.play();await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(await f.Media.setPreviewMode('original')).toBe(true);
    expect(f.mpv.loadfile).toHaveBeenLastCalledWith(f.clip.path);
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.Media.previewState()).toMatchObject({mode:'original',sourceKind:'original'});
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.Media.playing).toBe(true);
    expect(JSON.stringify(f.clip)).toBe(saved);
    expect(f.Media.displayTime()).toBeCloseTo(4);
  }finally{f.dispose();}
});

it('NAS Proxy 完成後直接使用素材旁資產，不要求或採納本機複本',async()=>{
  const prepareLocalPreview=vi.fn(async()=>({available:true,local:true,proxy:'C:/local/copy.mp4',channels:[]}));
  const f=await fixture({path:'\\\\Storage\\DCP\\mother.mov',mode:'smooth',prepareLocalPreview});
  try{
    f.assets.proxy='\\\\Storage\\DCP\\.subtool_Cache\\proxy.mp4';
    await f.Media.seek(4);
    f.Media._publishPreviewAssets(f.clip,f.assets,f.Media.captureMediaOwnership());
    await vi.waitFor(()=>expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true));
    expect(prepareLocalPreview).not.toHaveBeenCalled();
    expect(f.Media.previewState()).toMatchObject({sourceKind:'proxy',network:true});
    expect(f.clip.path).toBe('\\\\Storage\\DCP\\mother.mov');
  }finally{f.dispose();}
});

it.each(['primary','clip'])('%s Proxy 完成不等待波形讀取，即可切換預覽且不必重開專案',async kind=>{
  const f=await fixture({mode:'smooth'}),wave=deferred();let work;
  try{
    await f.Media.seek(4);
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    vi.spyOn(MediaIntakeJobs,'ingest').mockResolvedValue({...f.assets,channels:[]});
    vi.spyOn(f.Media,'_loadOriginalWave').mockReturnValue(wave.promise);
    work=kind==='primary'?f.Media._bgAudioIngest(f.clip.path,[],12,f.clip):f.Media._clipIngest(f.clip,{audio:[]});
    await vi.waitFor(()=>expect(f.Media.previewState().proxyAvailable).toBe(true));
    await vi.waitFor(()=>expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true));
    expect(f.Media.displayTime()).toBeCloseTo(4);
  }finally{wave.resolve();await work;f.dispose();}
});

it.each(['primary','clip'])('%s 無聲 Proxy 必須等原聲道 commit 才可選入，不能出現音訊載入窗口',async kind=>{
  const f=await fixture({mode:'smooth'}),wave=deferred(),audio=deferred();let work;
  try{
    await f.Media.seek(4);f.Media.tracks=[];
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    vi.spyOn(MediaIntakeJobs,'ingest').mockResolvedValue(f.assets);
    vi.spyOn(f.Media,'_loadOriginalWave').mockReturnValue(wave.promise);
    const materialize=vi.spyOn(f.Media._intakeSession,'materializeAudioElements').mockReturnValue(audio.promise);
    work=kind==='primary'?f.Media._bgAudioIngest(f.clip.path,[{channels:2}],12,f.clip):f.Media._clipIngest(f.clip,{audio:[{channels:2}]});
    await vi.waitFor(()=>expect(materialize).toHaveBeenCalledOnce());await flush();
    expect(f.Media.previewState().proxyAvailable).toBe(false);
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.Media.tracks).toHaveLength(0);
    audio.resolve(f.elements);
    await vi.waitFor(()=>expect(f.Media.tracks).toHaveLength(2));
    await vi.waitFor(()=>expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true));
    f.Media.play();await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.elements.map(element=>element.currentTime)).toEqual([4,4]);
  }finally{audio.resolve(f.elements);wave.resolve();await work;f.dispose();}
});

it('Proxy 完成遇到定位中，定位完成後在同一位置自動接手，不丟失完成通知',async()=>{
  const f=await fixture({mode:'smooth'});
  try{
    f.holdPresent();const pending=f.Media.seek(4);
    await vi.waitFor(()=>expect(f.Media.presentationPending()).toBe(true));
    f.Media._publishPreviewAssets(f.clip,f.assets,f.Media.captureMediaOwnership());await flush();
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    await f.finishPresentation(0);await pending;
    await vi.waitFor(()=>expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true));
    expect(f.Media.displayTime()).toBeCloseTo(4);
  }finally{f.dispose();}
});

it('播放中 Proxy 完成保持目前聲畫，下一次 seek 直接使用同夾 Proxy 與原聲道元素',async()=>{
  const f=await fixture({mode:'smooth'});
  try{
    await f.startAt(1);const elements=f.Media.tracks.map(track=>track.el),files=f.Media.tracks.map(track=>track.file);
    const plays=f.elements.map(element=>element.play.mock.calls.length);
    f.Media._publishPreviewAssets(f.clip,f.assets,f.Media.captureMediaOwnership());await flush();
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual(plays);
    await f.Media.seek(6);
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
    expect(f.Media.tracks.map(track=>track.el)).toEqual(elements);
    expect(f.Media.tracks.map(track=>track.file)).toEqual(files);
    expect(f.elements.map(element=>element.currentTime)).toEqual([6,6]);
  }finally{f.dispose();}
});

it('Proxy 完成同步通知中的新 seek 擁有最新位置，不被完成交接拉回',async()=>{
  const f=await fixture({mode:'smooth'});
  try{
    await f.Media.seek(4);const {on}=await import('../src/events.js');let latest;
    on('media:preview-state',state=>{if(!latest&&state.proxyAvailable)latest=f.Media.seek(8);});
    f.Media._publishPreviewAssets(f.clip,f.assets,f.Media.captureMediaOwnership());await flush();await latest;
    expect(f.Media.displayTime()).toBeCloseTo(8);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
    expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(8);
  }finally{f.dispose();}
});

it.each(['reset','replace-source'])('Proxy 較晚完成遇到 %s 不得登記或切回舊來源',async action=>{
  const f=await fixture({mode:'smooth'}),result=deferred();let work;
  try{
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    vi.spyOn(MediaIntakeJobs,'ingest').mockReturnValue(result.promise);
    work=f.Media._bgAudioIngest(f.clip.path,[],12,f.clip);await flush();
    if(action==='reset')f.Media.reset();
    else{f.clip.path='C:/replacement.mov';await f.Media.seek(4);}
    const loads=f.mpv.loadfile.mock.calls.length;
    result.resolve({...f.assets,channels:[]});await work;await flush();
    expect(f.Media.previewState().proxyAvailable).toBe(false);
    expect(f.mpv.loadfile).toHaveBeenCalledTimes(loads);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(false);
  }finally{result.resolve({...f.assets,channels:[]});await work;f.dispose();}
});

it.each(['scale','fade','opacity','overlap','mixed-image','takeover'])(
  '原始模式保留母片載體，但 %s 畫面明確回報合成預覽',async kind=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    if(kind==='scale')f.clip.scale=.5;
    if(kind==='fade')f.clip.fadeIn=1;
    if(kind==='opacity')f.State.videoTracks[0].opacity=.5;
    if(kind==='overlap')f.State.clips.push({...f.clip,id:'upper',path:'C:/upper.mov',vtrack:1});
    if(kind==='mixed-image'){
      f.clip.vtrack=1;f.State.clips.push({id:'background',type:'image',path:'C:/background.png',in:0,out:12,dur:12,offset:0,vtrack:0});
    }
    if(kind==='takeover')f.Media.setWebCodecsTakeover(true);
    expect(await f.Media.setPreviewMode('original')).toBe(true);
    expect(f.Media.previewState()).toMatchObject({mode:'original',sourceKind:'original',available:true,compositePreview:true});
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.clip).toMatchObject({path:'C:/mother.mov',dur:12,in:0,out:12});
  }finally{f.dispose();}
});

it('上層圖片與單一滿版影片仍是原始呈現，合成讓回與間隙不留下舊提示',async()=>{
  const f=await fixture();
  try{
    await f.Media.seek(4);
    f.State.clips.push({id:'logo',type:'image',path:'C:/logo.png',in:0,out:12,dur:12,offset:0,vtrack:1});
    expect(f.Media.previewState()).toMatchObject({sourceKind:'original',compositePreview:false});
    f.State.clips.push({id:'previous-upper',path:'C:/upper.mov',in:0,out:2,dur:2,offset:0,vtrack:1});
    // WC emits its handoff notification before discarding the previous canvas
    // snapshot; that old frame's stack must not keep the badge in composite mode.
    f.Media.setWebCodecsComposited(true,{time:1});
    f.Media.setWebCodecsTakeover(true);
    expect(f.Media.previewState().compositePreview).toBe(true);
    f.Media.setWebCodecsTakeover(false);
    expect(f.Media.previewState().compositePreview).toBe(false);
    f.Media.setWebCodecsTakeover(true);f.clip.out=3;
    await f.Media.seek(4);
    expect(f.Media.inGap()).toBe(true);
    expect(f.Media.previewState().compositePreview).toBe(false);
  }finally{f.dispose();}
});

it('proxy 的載入片長與合法 session 長度事件不能擴大母素材的修剪上限',async()=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    f.mpv.loadfile.mockImplementationOnce(async()=>({...f.accepted(),duration:120}));
    expect(await f.Media.setPreviewMode('smooth')).toBe(true);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
    expect(f.Seq.sourceDuration(f.clip)).toBe(12);
    f.emit('duration',120);await flush();
    expect(f.Seq.sourceDuration(f.clip)).toBe(12);
    expect(f.clip).toMatchObject({path:'C:/mother.mov',dur:12,out:12});
    expect(await f.Media.setPreviewMode('original')).toBe(true);
    f.emit('duration',14);await flush();
    expect(f.Seq.sourceDuration(f.clip)).toBe(14);
    expect(f.clip).toMatchObject({dur:12,out:12});
  }finally{f.dispose();}
});

it('歸零 proxy 不沿用母片精準 seek 偏移，時間軸裁切與 offset 仍只換算一次',async()=>{
  const f=await fixture();
  try{
    Object.assign(f.clip,{in:2,out:12,offset:7,mpvExactSeek:true,mpvSeekOffset:.04});f.State.duration=17;
    f.register();
    // The mother's compensated command lands on its actual source frame 6;
    // command pre-roll is not itself a presented-frame observation.
    f.mpv.present.mockImplementationOnce(async()=>({backend:'mpv',presentedSourceTime:6}));
    await f.Media.seek(11);
    expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(5.96);
    expect(await f.Media.setPreviewMode('smooth')).toBe(true);
    expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(6);
    expect(f.mpv.seek.mock.calls.at(-1)[0]).toBeCloseTo(6);
    expect(f.Media.displayTime()).toBeCloseTo(11);
    expect(f.clip).toMatchObject({path:'C:/mother.mov',in:2,out:12,offset:7,mpvSeekOffset:.04});
  }finally{f.dispose();}
});

it('proxy 載入未完成就改選原始，晚到載入只能交接到最後選擇',async()=>{
  const f=await fixture(),loaded=deferred();
  try{
    f.register();await f.Media.seek(4);
    f.mpv.loadfile.mockImplementationOnce(()=>loaded.promise);
    const smooth=f.Media.setPreviewMode('smooth');
    await vi.waitFor(()=>expect(f.mpv.loadfile).toHaveBeenCalledWith(f.assets.proxy));
    const original=f.Media.setPreviewMode('original');
    loaded.resolve(f.accepted());
    await Promise.all([smooth,original]);await flush();
    expect(f.State.previewMode).toBe('original');
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.Media.previewState()).toMatchObject({mode:'original',sourceKind:'original',phase:'paused'});
    expect(f.Media.displayTime()).toBeCloseTo(4);
    expect(f.elements.every(element=>element.paused)).toBe(true);
  }finally{loaded.resolve(f.accepted());f.dispose();}
});

it('預覽模式通知同步 seek 新位置，外層切換不能把播放目標拉回通知前的位置',async()=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    const {on}=await import('../src/events.js');
    let notified=false,newerSeek;
    on('media:preview-state',state=>{
      if(notified||state.mode!=='smooth')return;
      notified=true;newerSeek=f.Media.seek(8);
    });
    const changed=f.Media.setPreviewMode('smooth');
    await changed;await newerSeek;await flush();
    expect(notified).toBe(true);
    expect(f.Media.displayTime()).toBeCloseTo(8);
    expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(8);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
    expect(f.elements.every(element=>element.paused)).toBe(true);
  }finally{f.dispose();}
});

it('預覽模式通知同步改選相反模式，外層只回報失權且不能再載入或覆蓋最後選擇',async()=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    const {on}=await import('../src/events.js');
    let notified=false,newerMode;
    on('media:preview-state',state=>{
      if(notified||state.mode!=='smooth')return;
      notified=true;newerMode=f.Media.setPreviewMode('original');
    });
    const stale=await f.Media.setPreviewMode('smooth');
    expect(await newerMode).toBe(true);await flush();
    expect(notified).toBe(true);
    expect(f.State.previewMode).toBe('original');
    expect(f.Media.previewState()).toMatchObject({mode:'original',sourceKind:'original',phase:'paused'});
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    expect(f.mpv.loadfile).not.toHaveBeenCalled();
    expect(f.Media.displayTime()).toBeCloseTo(4);
    expect(stale).toBe(false);
  }finally{f.dispose();}
});

it('播放中切換 proxy，畫格和第二聲道都就緒之前不重播 cached followers',async()=>{
  const f=await fixture();
  try{
    f.register();await f.startAt(4);
    for(const element of f.elements)element.play.mockClear();f.mpv.play.mockClear();
    f.holdPresent();f.elements[1].holdSeek=true;f.elements[1].readyState=1;
    const switching=f.Media.setPreviewMode('smooth');
    await vi.waitFor(()=>expect(f.mpv.loadfile).toHaveBeenCalledWith(f.assets.proxy));
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await f.finishPresentation(0);await flush();
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.mpv.play).not.toHaveBeenCalled();
    f.elements[1].ready();await switching;
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.elements.map(element=>element.play.mock.calls.length),JSON.stringify(f.trace)).toEqual([1,1]);
    expect(f.mpv.play).toHaveBeenCalledOnce();
  }finally{f.dispose();}
});

it('proxy seek 被較新目標取代，舊畫格晚到不能先播放舊位置',async()=>{
  const f=await fixture();
  try{
    f.register();await f.Media.setPreviewMode('smooth');await f.startAt(1);
    for(const element of f.elements)element.play.mockClear();f.mpv.play.mockClear();
    f.holdPresent();const first=f.Media.seek(4);
    await vi.waitFor(()=>expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(4));
    const latest=f.Media.seek(8);
    await f.finishPresentation(0);await first;
    expect(f.elements.every(element=>element.paused)).toBe(true);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await vi.waitFor(()=>expect(f.mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(8));
    await f.finishPresentation(1);await latest;
    await vi.waitFor(()=>expect(f.elements.every(element=>!element.paused)).toBe(true));
    expect(f.elements.map(element=>element.currentTime)).toEqual([8,8]);
    expect(f.elements.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    expect(f.adapter.ownsNativeSourcePath(f.assets.proxy)).toBe(true);
  }finally{f.dispose();}
});

it.each(['native-reverse','reverse-clip','reverse-preparing'])('%s 停用預覽切換，直接呼叫也不改設定、來源或呈現',async kind=>{
  const f=await fixture();
  try{
    f.register();await f.Media.seek(4);
    if(kind==='native-reverse')expect(await f.Media.setPlaybackDirection('backward')).toBe(true);
    else if(kind==='reverse-preparing')f.Media.setReverseShuttleMuted(true);
    else f.clip.reverse=true;
    const before={mode:f.State.previewMode,position:f.Media.displayTime(),presented:f.Media.presentedTime()};
    const calls=Object.fromEntries(['loadfile','seek','present','direction','play'].map(name=>[name,f.mpv[name].mock.calls.length]));
    expect(f.Media.previewState().available).toBe(false);
    expect(await f.Media.setPreviewMode('smooth')).toBe(false);
    expect(f.State.previewMode).toBe(before.mode);
    expect(f.Media.displayTime()).toBe(before.position);
    expect(f.Media.presentedTime()).toBe(before.presented);
    expect(f.adapter.ownsNativeSourcePath(f.clip.path)).toBe(true);
    for(const [name,count] of Object.entries(calls))expect(f.mpv[name]).toHaveBeenCalledTimes(count);
  }finally{f.dispose();}
});

it('公開切換原生播放方向會通知預覽模式可用性，回到正向後恢復',async()=>{
  const f=await fixture();
  try{
    await f.Media.seek(4);
    const {on}=await import('../src/events.js');
    const states=[];on('media:preview-state',state=>states.push(state));
    expect(await f.Media.setPlaybackDirection('backward')).toBe(true);
    expect(f.mpv.direction).toHaveBeenLastCalledWith('backward');
    expect(states.at(-1)).toMatchObject({available:false,mode:'original'});
    expect(await f.Media.setPlaybackDirection('forward')).toBe(true);
    expect(f.mpv.direction).toHaveBeenLastCalledWith('forward');
    expect(states.at(-1)).toMatchObject({available:true,mode:'original'});
  }finally{f.dispose();}
});

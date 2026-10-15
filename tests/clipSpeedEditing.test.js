// @vitest-environment jsdom
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';

const dom=vi.hoisted(()=>{
  const video={style:{},src:'file:///source.mov',currentTime:2,playbackRate:1,muted:false,
    hasAttribute:()=>true,pause:vi.fn(),dispatchEvent:vi.fn()};
  const elements=new Map();
  return {video,$(id){
    if(!elements.has(id)) elements.set(id,{style:{},textContent:'',innerHTML:'',value:0,
      querySelectorAll:()=>[],classList:{add:vi.fn(),remove:vi.fn()}});
    return elements.get(id);
  }};
});
const workspace=vi.hoisted(()=>({version:0}));
vi.mock('../src/dom.js',()=>dom);
vi.mock('../src/ui.js',()=>({showToast:vi.fn(),setStatus:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/project.js',()=>({Project:{captureWorkspaceOwnership:()=>{
  const version=workspace.version;return ()=>workspace.version===version;
}}}));
vi.mock('../src/subtitles.js',()=>({refreshSelectionUI:vi.fn()}));
vi.mock('../src/tcparse.js',()=>({parseTimecodeInput:vi.fn(),setupTimecodeInput:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn(),refreshTrackGutterActive:vi.fn()}));
vi.mock('../src/notes.js',()=>({renderNotes:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));

let Media,State,Seq,History,setClipSpeed,resetPlayerAdapter,getPlayerAdapter;
let bridge,desk,clip;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++) await Promise.resolve();};

beforeAll(async()=>{
  desk={isDesktop:true,ingest:vi.fn()};
  Object.defineProperty(window,'subtool',{configurable:true,value:desk});
  window.AudioContext=class {
    constructor(){this.state='running';this.destination={};this.currentTime=0;}
    createGain(){return {connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}};}
    createAnalyser(){return {connect:vi.fn(),fftSize:2048};}
  };
  ({Media}=await import('../src/media.js'));
  ({State}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));
  ({History}=await import('../src/history.js'));
  ({setClipSpeed}=await import('../src/clip-model.js'));
  ({resetPlayerAdapter,getPlayerAdapter}=await import('../src/media-player-adapter.js'));
});
beforeEach(async()=>{
  workspace.version++;
  Media.reset();
  Object.assign(State,{clips:[],videoTracks:[{name:'V1',visible:true,locked:false}],
    tracks:[],cues:[],notes:[],duration:0,externalAudioState:[],externalAudioEnd:0,fps:25,dropFrame:false});
  clip=Seq.add({id:'source',name:'source',path:'C:/source.mov',primary:true,in:0,out:8,dur:8,offset:0,vtrack:0});
  bridge={launch:vi.fn(async()=>({ok:true})),loadfile:vi.fn(async()=>({ok:true})),
    seek:vi.fn(async time=>{Media.observeMpvEvent({event:'property-change',name:'time-pos',data:time});return true;}),
    present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
    cancelPresent:vi.fn(async()=>true),rate:vi.fn(async()=>true),direction:vi.fn(async()=>true),
    pause:vi.fn(async()=>true),mute:vi.fn(async()=>true)};
  resetPlayerAdapter({mpv:bridge},dom.video);
  await getPlayerAdapter().enterMpv({src:clip.path});
  Object.assign(Media,{activeClipId:clip.id,_mpvPath:clip.path,_mpvTime:2});
  Media._transport.seek(2,{duration:State.duration,fps:25,dropFrame:false});
  desk.ingest.mockReset().mockResolvedValue({proxy:'C:/source.proxy.mp4'});
  History.reset();
});
afterEach(()=>{Media.reset();vi.restoreAllMocks();});

describe('片段速度編輯的完整公開生命週期',()=>{
  it('同軌鎖定鄰段拒絕時，不準備或切換 Proxy，不留下草稿與 History',async()=>{
    const next=Seq.add({id:'next',in:0,out:2,dur:2,offset:8,vtrack:0,locked:true});History.reset();
    expect(await setClipSpeed(clip,.5,true)).toBe(false);
    expect(clip.speed).toBeUndefined();expect(next.offset).toBe(8);
    expect(desk.ingest).not.toHaveBeenCalled();expect(bridge.loadfile).not.toHaveBeenCalled();expect(History.stack).toHaveLength(1);
  });
  it('未完成畫格只更新live草稿；背景字幕History保留原倍率/ripple，完成只加一筆Undo',async()=>{
    const next=Seq.add({id:'next',in:0,out:2,dur:2,offset:8,vtrack:0});History.reset();
    const frame=deferred();bridge.present.mockReturnValueOnce(frame.promise);
    const pending=setClipSpeed(clip,.5);
    expect(clip.speed).toBe(.5);expect(next.offset).toBe(16);
    expect(History.committedSnapshot().clips[0]).not.toHaveProperty('speed');expect(History.committedSnapshot().clips[1].offset).toBe(8);
    let settled=false;pending.then(()=>{settled=true;});await flush();expect(settled).toBe(false);
    State.cues.push({id:'background',track:0,start:1,end:2,text:'background'});History.record('背景字幕');
    expect(History.stack[1].snap.clipGeo[0]).not.toHaveProperty('speed');expect(History.stack[1].snap.clipGeo[1].offset).toBe(8);
    frame.resolve({backend:'mpv',presentedSourceTime:1});expect(await pending).toBe(true);
    expect(History.stack).toHaveLength(3);History.undo();
    expect(clip.speed).toBe(1);expect(next.offset).toBe(8);expect(State.cues[0].text).toBe('background');
  });
  it('Proxy準備期間取消，立即撤回草稿，晚到回覆不換來源或提交',async()=>{
    const proxy=deferred();desk.ingest.mockReturnValueOnce(proxy.promise);
    const controller=new AbortController();const pending=setClipSpeed(clip,2,true,{signal:controller.signal});
    expect(clip.reverse).toBe(true);controller.abort();expect(clip.reverse).toBeUndefined();
    proxy.resolve({proxy:'C:/late.proxy.mp4'});expect(await pending).toBe(false);
    expect(bridge.loadfile).not.toHaveBeenCalled();expect(History.stack).toHaveLength(1);
  });
  it.each(['proxy','load','frame'])('History reset 撤銷 %s 等待中的原生速度预覽，再建立已確認基準',async stage=>{
    const wait=deferred();
    const next=Seq.add({id:'next',in:0,out:2,dur:2,offset:8,vtrack:0});History.reset();
    if(stage==='proxy') desk.ingest.mockReturnValueOnce(wait.promise);
    if(stage==='load') bridge.loadfile.mockReturnValueOnce(wait.promise);
    if(stage==='frame') bridge.present.mockReturnValueOnce(wait.promise);
    const editing=setClipSpeed(clip,.5,stage!=='frame');
    if(stage==='proxy') await vi.waitFor(()=>expect(desk.ingest).toHaveBeenCalled());
    if(stage==='load') await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith('C:/source.proxy.mp4'));
    if(stage==='frame') await vi.waitFor(()=>expect(bridge.present).toHaveBeenCalledWith(1,expect.any(Object)));
    expect(clip.speed).toBe(.5);expect(next.offset).toBe(16);
    next.name='background';History.reset();
    expect(clip.speed).toBeUndefined();expect(clip.reverse).toBeUndefined();expect(next.offset).toBe(8);
    expect(History.stack[0].snap.clipGeo[0]).toMatchObject({speed:1,reverse:false});
    expect(History.stack[0].snap.clipGeo[1]).toMatchObject({offset:8,name:'background'});
    wait.resolve(stage==='proxy'?{proxy:'C:/source.proxy.mp4'}:stage==='load'?{ok:true}:{backend:'mpv',presentedSourceTime:1});
    expect(await editing).toBe(false);expect(History.stack).toHaveLength(1);
    expect(clip.speed).toBeUndefined();expect(next.offset).toBe(8);expect(Media.displayTime()).toBe(2);
    if(stage==='proxy') expect(bridge.loadfile).not.toHaveBeenCalled();
    if(stage==='load') expect(bridge.loadfile.mock.calls.map(args=>args[0])).toEqual(['C:/source.proxy.mp4','C:/source.mov']);
    if(stage==='frame') expect(bridge.present.mock.calls.map(args=>args[0])).toEqual([1,2]);
  });
  it.each(['lock','trackLock','replacement','workspace','changedTrim','fps'])('準備期間失去%s資格，晚到回覆不能切來源或提交',async reason=>{
    const proxy=deferred();desk.ingest.mockReturnValueOnce(proxy.promise);
    const pending=setClipSpeed(clip,2,true);
    if(reason==='lock')clip.locked=true;
    if(reason==='trackLock')State.videoTracks[0].locked=true;
    if(reason==='replacement')State.clips=[{...clip,speed:3,reverse:false}];
    if(reason==='workspace')workspace.version++;
    if(reason==='changedTrim')clip.in=1;
    if(reason==='fps')State.fps=30;
    proxy.resolve({proxy:'C:/late.proxy.mp4'});expect(await pending).toBe(false);
    expect(bridge.loadfile).not.toHaveBeenCalled();expect(History.stack).toHaveLength(1);
    if(reason==='changedTrim')expect(clip.in).toBe(1);
    if(reason==='replacement')expect(State.clips[0].speed).toBe(3);
  });
  it('播放中開始編輯先暫停，準備期間不送出舊位置seek',async()=>{
    const proxy=deferred();desk.ingest.mockReturnValueOnce(proxy.promise);Media.playing=true;
    const controller=new AbortController();const pending=setClipSpeed(clip,2,true,{signal:controller.signal});
    expect(Media.playing).toBe(false);expect(bridge.pause).toHaveBeenCalled();expect(bridge.seek).not.toHaveBeenCalled();
    controller.abort();proxy.resolve({proxy:'C:/late.proxy.mp4'});expect(await pending).toBe(false);
  });
  it('已送出loadfile期間取消，等待原生回覆後還原母素材，保留較新seek',async()=>{
    const loaded=deferred();bridge.loadfile.mockReturnValueOnce(loaded.promise);
    const controller=new AbortController();const pending=setClipSpeed(clip,2,true,{signal:controller.signal});
    await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith('C:/source.proxy.mp4'));
    controller.abort();const seek=Media.seek(5);loaded.resolve({ok:true});
    expect(await pending).toBe(false);expect((await seek).status).toBe('presented');
    expect(bridge.loadfile.mock.calls.map(args=>args[0])).toEqual(['C:/source.proxy.mp4','C:/source.mov']);
    expect(Media.displayTime()).toBe(5);expect(clip.reverse).toBeUndefined();expect(History.stack).toHaveLength(1);
  });
  it('loadfile未送出前取消，exclusive lane釋放後不執行Proxy切換',async()=>{
    const lane=deferred();const blocking=Media._intakeSession.queueExclusive(()=>lane.promise);
    const controller=new AbortController();const pending=setClipSpeed(clip,2,true,{signal:controller.signal});
    await flush();controller.abort();lane.resolve();await blocking;
    expect(await pending).toBe(false);expect(bridge.loadfile).not.toHaveBeenCalled();expect(History.stack).toHaveLength(1);
  });
  it('已送native load後同ID片段取代，記錄實際来源，下一次seek重新載入新片段母素材',async()=>{
    const loaded=deferred();bridge.loadfile.mockReturnValueOnce(loaded.promise);
    const pending=setClipSpeed(clip,2,true);
    await vi.waitFor(()=>expect(bridge.loadfile).toHaveBeenCalledWith('C:/source.proxy.mp4'));
    const replacement={...clip,speed:1,reverse:false};State.clips=[replacement];
    loaded.resolve({ok:true});expect(await pending).toBe(false);
    expect(Media._mpvPath).toBe('C:/source.proxy.mp4');expect(replacement.speed).toBe(1);expect(History.stack).toHaveLength(1);
    expect((await Media.seek(2)).status).toBe('presented');
    expect(bridge.loadfile.mock.calls.map(args=>args[0])).toEqual(['C:/source.proxy.mp4','C:/source.mov']);
    expect(Media._mpvPath).toBe('C:/source.mov');expect(Media.displayTime()).toBe(2);
  });
  it('Proxy來源seek等ack期間片段被取代，撤銷來源transition不留下假逾時',async()=>{
    const positioned=deferred();bridge.seek.mockReturnValueOnce(positioned.promise);
    const pending=setClipSpeed(clip,2,true);
    await vi.waitFor(()=>expect(bridge.seek).toHaveBeenCalledWith(2,undefined));
    expect(Media.mpvSourceTransitionPending()).toBe(true);
    State.clips=[{...clip,speed:1,reverse:false}];
    positioned.resolve(true);expect(await pending).toBe(false);
    expect(Media.mpvSourceTransitionPending()).toBe(false);
    expect(History.stack).toHaveLength(1);
  });
  it('Proxy來源seek等ack期間收到新播放目標，釋放舊transition並只完成新位置',async()=>{
    const positioned=deferred();bridge.seek.mockReturnValueOnce(positioned.promise);
    const pending=setClipSpeed(clip,2,true);
    await vi.waitFor(()=>expect(bridge.seek).toHaveBeenCalledWith(2,undefined));
    const latest=Media.seek(3);positioned.resolve(true);
    expect((await latest).status).toBe('presented');expect(await pending).toBe(true);
    expect(Media.displayTime()).toBe(3);expect(Media.mpvSourceTransitionPending()).toBe(false);
    expect(bridge.seek).toHaveBeenCalledTimes(1);expect(bridge.present).toHaveBeenCalledTimes(1);
    expect(History.stack).toHaveLength(2);
  });
  it('方向失敗只撤回自己的預览欄位；後來同軌offset及背景History不被吞掉',async()=>{
    const next=Seq.add({id:'next',in:0,out:2,dur:2,offset:8,vtrack:0});History.reset();
    const direction=deferred();bridge.direction.mockReturnValueOnce(direction.promise);
    const pending=setClipSpeed(clip,.5);await flush();next.offset=20;
    State.cues.push({id:'background',start:0,end:1,text:'keep',track:0});History.record('背景');
    expect(History.stack[1].snap.clipGeo[1].offset).toBe(20);
    direction.resolve(false);expect(await pending).toBe(false);
    expect(next.offset).toBe(20);expect(clip.speed).toBeUndefined();expect(State.cues[0].text).toBe('keep');
    expect(History.stack).toHaveLength(2);
  });
  it('較新播放目標在方向等待期間到達，完成不再seek舊位置',async()=>{
    const direction=deferred();bridge.direction.mockReturnValueOnce(direction.promise);
    const pending=setClipSpeed(clip,2);await flush();
    const seek=Media.seek(3);expect((await seek).status).toBe('presented');
    direction.resolve(true);expect(await pending).toBe(true);
    expect(Media.displayTime()).toBe(3);expect(bridge.present).toHaveBeenCalledTimes(1);
    expect(bridge.present).toHaveBeenCalledWith(6,expect.any(Object));expect(History.stack).toHaveLength(2);
  });
  it.each([false,true])('本次畫格仍pending時取消，還原來源位置且保留較新播放目標=%s',async newer=>{
    const frame=deferred();bridge.present.mockReturnValueOnce(frame.promise);
    const controller=new AbortController();const pending=setClipSpeed(clip,2,false,{signal:controller.signal});
    await vi.waitFor(()=>expect(bridge.present).toHaveBeenCalledWith(4,expect.any(Object)));
    controller.abort();
    let latest;
    if(newer) latest=Media.seek(5);
    frame.resolve({backend:'mpv',presentedSourceTime:4});
    expect(await pending).toBe(false);if(latest)expect((await latest).status).toBe('presented');
    expect(clip.speed).toBeUndefined();expect(Media.displayTime()).toBe(newer?5:2);
    expect(Media.vTime()).toBe(newer?5:2);expect(History.stack).toHaveLength(1);
    expect(bridge.present.mock.calls.map(args=>args[0])).toEqual([4,newer?5:2]);
  });
  it('同片段新編輯先等待舊清理，舊回覆不能撤回或提交新草稿',async()=>{
    const proxy=deferred();desk.ingest.mockReturnValueOnce(proxy.promise);
    const old=setClipSpeed(clip,2,true);const latest=setClipSpeed(clip,.5);
    proxy.resolve({proxy:'C:/late.proxy.mp4'});
    expect(await old).toBe(false);expect(await latest).toBe(true);
    expect(clip.speed).toBe(.5);expect(clip.reverse).toBe(false);expect(History.stack).toHaveLength(2);
    expect(bridge.loadfile).not.toHaveBeenCalled();
  });
  it('反轉套用等待實際目標畫格後完成，回正向還原母素材，只各留一筆編輯',async()=>{
    expect(await setClipSpeed(clip,2,true)).toBe(true);
    expect(clip).toMatchObject({speed:2,reverse:true});expect(Media._mpvPath).toBe('C:/source.proxy.mp4');
    expect(bridge.direction).toHaveBeenCalledWith('backward');expect(Media.presentationPending()).toBe(false);
    expect(History.committedSnapshot().clips[0]).toMatchObject({speed:2,reverse:true});
    expect(await setClipSpeed(clip,1,false)).toBe(true);
    expect(Media._mpvPath).toBe('C:/source.mov');expect(bridge.direction).toHaveBeenCalledWith('forward');expect(History.stack).toHaveLength(3);
  });
});

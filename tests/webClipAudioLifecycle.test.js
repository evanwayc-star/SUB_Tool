// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';

vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));

const elements=[];
const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const pcm=()=>({duration:12,sampleRate:1000,length:12000,numberOfChannels:2,
  getChannelData:()=>new Float32Array(12000).fill(.2)});
class ReadyAudio extends EventTarget{
  constructor(){super();this.src='';this.duration=12;this.readyState=1;this.currentTime=0;this.paused=true;this.playbackRate=1;elements.push(this);}
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();
  removeAttribute(key){if(key==='src')this.src='';}
}
let Media,Wave,State,Seq,AudioEngine,History,recordHistory,video,decode;
beforeEach(async()=>{
  vi.resetModules();
  delete window.subtool;
  document.body.innerHTML=readFileSync('index.html','utf8');
  video=document.getElementById('video');
  for(const [key,value] of Object.entries({duration:12,readyState:1,videoWidth:1920,videoHeight:1080}))
    Object.defineProperty(video,key,{configurable:true,value});
  video.play=vi.fn(async()=>{});video.pause=vi.fn();video.load=vi.fn();
  video.requestVideoFrameCallback=cb=>{queueMicrotask(()=>cb(0,{mediaTime:video.currentTime}));return 1;};
  video.cancelVideoFrameCallback=vi.fn();
  vi.stubGlobal('Audio',ReadyAudio);
  vi.stubGlobal('AudioContext',class{
    constructor(){this.state='running';this.currentTime=0;this.destination={};}
    resume(){}createGain(){return {...node(),gain:{value:1}};}createAnalyser(){return {...node(),fftSize:32};}
    createMediaElementSource(el){return {...node(),element:el};}createChannelSplitter(){return node();}createChannelMerger(){return node();}
  });
  let urls=0;
  vi.spyOn(URL,'createObjectURL').mockImplementation(file=>`blob:${file.name}:${++urls}`);
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const create=document.createElement.bind(document);
  vi.spyOn(document,'createElement').mockImplementation((tag,options)=>{
    if(tag!=='video')return create(tag,options);
    const probe={duration:12,readyState:1,pause:vi.fn(),load:vi.fn(),removeAttribute(){}};
    Object.defineProperty(probe,'src',{get(){return this.url||'';},set(url){this.url=url;queueMicrotask(()=>this.onloadedmetadata?.());}});
    return probe;
  });
  ({Media,Wave}=await import('../src/media.js'));({State}=await import('../src/state.js'));({Seq}=await import('../src/sequence.js'));
  ({AudioEngine}=await import('../src/audio-engine.js'));({History,recordHistory}=await import('../src/history.js'));
  const {on}=await import('../src/events.js');on('history:record',recordHistory);
  const {resetAudioProject}=await import('../src/state.js');
  Media.reset();resetAudioProject();State.fps=30;State.dropFrame=false;State.muted=false;elements.length=0;
  vi.spyOn(Media,'probeAndMaybeExtract').mockResolvedValue(true);
  decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue(pcm());
  await Media.loadVideoFile({name:'primary.mp4',size:600_000_000});
  History.reset();
});
afterEach(()=>{Media.reset();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('web sequence original audio owns its lifecycle independently of waveform',()=>{
  it.each(['large','decode-failure','pending-wave'])('%s 第二段仍有原音、原聲道配線與 source clock',async mode=>{
    let finish;
    if(mode==='decode-failure')decode.mockRejectedValue(new Error('optional waveform decode failed'));
    if(mode==='pending-wave')decode.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    video.currentTime=12;
    const file=mode==='large'?{name:'second.mp4',size:600_000_000}:new File([new Uint8Array(8)],'second.mp4');
    const second=await Media.addClipWeb(file);
    expect(second.offset).toBe(12);
    const channels=Media.sourceChannels(second.audioSrc);
    expect(channels.map(track=>[track.sourceStream,track.sourceChannel])).toEqual([[0,0],[0,1]]);
    expect(channels.every(track=>track.file===file)).toBe(true);
    expect(History.stack.at(-1).snap.audioProject.sourceMaps[second.audioSourceId].channels).toHaveLength(2);
    await Media.seek(13);Media.play();
    await vi.waitFor(()=>expect(channels[0].el.paused).toBe(false));
    expect(channels[0].el.currentTime).toBe(1);
    expect(channels[0].el).toBe(channels[1].el);
    expect(channels.every(track=>Media.trackAudible(track)&&track.gain.gain.value>0)).toBe(true);
    expect(video.muted).toBe(true);
    expect(Media.sourceChannels('video').every(track=>track.gain.gain.value===0)).toBe(true);
    Media.toggleProjectBusMute(State.audioProject.buses[0].id);
    expect(channels.map(track=>track.gain.gain.value)).toEqual([0,1]);
    Media.toggleSourceMute(second.audioSrc);expect(channels.every(track=>track.gain.gain.value===0)).toBe(true);
    if(mode==='large')expect(decode).not.toHaveBeenCalled();
    else await vi.waitFor(()=>expect(decode).toHaveBeenCalledOnce());
    Media.reset();finish?.(pcm());
    await Promise.resolve();expect(Media.tracks).toHaveLength(0);
  });

  it('新增第二來源疊合與切割來源使用各自時鐘；回主影片後停止第二來源',async()=>{
    video.currentTime=2;
    const second=await Media.addClipWeb({name:'second.mp4',size:600_000_000});
    await Media.seek(3);Media.play();
    await vi.waitFor(()=>expect(elements.filter(el=>!el.paused)).toHaveLength(2));
    expect(elements.filter(el=>!el.paused).map(el=>el.currentTime).sort()).toEqual([1,3]);
    expect(Media.sourceChannels(second.audioSrc).every(track=>Media.trackAudible(track))).toBe(true);
    Media.pause({seekOnPause:false});
    expect(Media.splitClipAt(5)).toBe(true);
    const right=State.clips.find(clip=>clip.audioSourceId===second.audioSourceId&&clip!==second);
    expect(Media.sourceChannels(second.audioSrc)).toHaveLength(2);
    expect(right.audioSrc).toBe(second.audioSrc);
    await Media.seek(1);Media.play();
    await vi.waitFor(()=>expect(Media.presenterClockMoving()).toBe(true));
    expect(Media.sourceChannels(second.audioSrc).every(track=>track._srcHidden&&track.el.paused)).toBe(true);
  });

  it.each([false,true])('remove/Undo/Redo 由同一原音 owner 重建來源，playing=%s',async running=>{
    video.currentTime=12;
    const second=await Media.addClipWeb({name:'second.mp4',size:600_000_000});
    await Media.seek(13);Media.play();
    const old=Media.sourceChannels(second.audioSrc)[0].el;
    await vi.waitFor(()=>expect(old.paused).toBe(false));
    if(!running)Media.pause({seekOnPause:false});
    Media.removeClip(second.id);recordHistory('移除影片');
    expect(old.src).toBe('');expect(old.paused).toBe(true);
    History.undo();await Media.waitForHistorySequenceRestore();
    const channels=Media.sourceChannels(second.audioSrc);
    expect(Seq.byId(second.id)).not.toBeNull();expect(channels).toHaveLength(2);
    expect(channels[0].el).not.toBe(old);expect(channels[0].el.src).toBe(second.web.url);
    await Media.seek(13);Media.play();await vi.waitFor(()=>expect(channels[0].el.paused).toBe(false));
    expect(channels.every(track=>track.gain.gain.value>0)).toBe(true);
    History.redo();await Media.waitForHistorySequenceRestore();
    expect(Media.sourceChannels(second.audioSrc)).toHaveLength(0);
    expect(channels[0].el.src).toBe('');expect(channels[0].el.paused).toBe(true);
    old.dispatchEvent(new Event('canplay'));expect(old.paused).toBe(true);
  });

  it.each([false,true])('History 復原中的較新 seek/play/pause 保持最新意圖，resume=%s',async resume=>{
    video.currentTime=12;
    const second=await Media.addClipWeb({name:'second.mp4',size:600_000_000});
    await Media.seek(13);Media.play();
    await vi.waitFor(()=>expect(Media.sourceChannels(second.audioSrc)[0].el.paused).toBe(false));
    Media.removeClip(second.id);recordHistory('移除影片');
    History.undo();
    Media.pause();
    const latest=Media.seek(14);
    if(resume)Media.play();
    await latest;await Media.waitForHistorySequenceRestore();
    const channels=Media.sourceChannels(second.audioSrc);
    expect(Media.displayTime()).toBe(14);expect(Media.playing).toBe(resume);
    if(resume)await vi.waitFor(()=>expect(channels[0].el.paused).toBe(false));
    else expect(channels[0].el.paused).toBe(true);
    Media.play();await vi.waitFor(()=>expect(channels[0].el.paused).toBe(false));
    expect(channels[0].el.currentTime).toBe(2);
  });

  it.each(['delete','reset','failure'])('late waveform %s 不再建立舊來源波形或修改新原音',async mode=>{
    let resolve,reject;
    decode.mockImplementation(()=>new Promise((done,fail)=>{resolve=done;reject=fail;}));
    video.currentTime=12;
    const second=await Media.addClipWeb(new File([new Uint8Array(8)],'late.mp4'));
    await vi.waitFor(()=>expect(decode).toHaveBeenCalledOnce());
    const old=Media.sourceChannels(second.audioSrc)[0].el;
    if(mode==='reset')Media.reset();else Media.removeClip(second.id);
    expect(old.src).toBe('');expect(old.paused).toBe(true);
    const newer=mode==='failure'?await Media.addClipWeb({name:'current.mp4',size:600_000_000}):null;
    const current=newer?Media.sourceChannels(newer.audioSrc):null;
    if(mode==='failure')reject(new Error('late optional waveform failure'));else resolve(pcm());
    await vi.waitFor(()=>expect(Wave.getSourceWaveform(second).peaks).toBeNull());
    expect(Media.sourceChannels(second.audioSrc)).toHaveLength(0);
    expect(Wave.sourceWaveforms.get(second.audioSourceId)?.mix.peaks).toBeFalsy();
    if(newer)expect(Media.sourceChannels(newer.audioSrc)).toEqual(current);
  });
});

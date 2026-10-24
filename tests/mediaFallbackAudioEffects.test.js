// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const video = {
    style: {},
    src: '',
    readyState: 1,
    duration: 12,
    videoWidth: 1920,
    videoHeight: 1080,
    playbackRate: 1,
    currentTime: 0,
    muted: false,
    hasAttribute: () => false,
    pause: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', innerHTML: '', value: '',
          addEventListener: vi.fn(), removeEventListener: vi.fn(),
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
        });
      }
      return elements.get(id);
    },
  };
});

const deskMock = vi.hoisted(() => ({
  stat: vi.fn(async () => ({ exists: true, size: 1024 })),
  probe: vi.fn(async () => ({
    duration: 12,
    video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
    audio: [{ channels: 6, channelLayout: '5.1' }],
  })),
  ingest: vi.fn(),
  fileURL: vi.fn(async path => `file:///${String(path).replaceAll('\\', '/')}`),
  waveAudio: vi.fn(),
  cleanupAudio: vi.fn(),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), showOsd: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));
vi.mock('../src/subtitles.js', () => ({ selectCueSingle: vi.fn(), commitCueTimeEdit: vi.fn() }));
vi.mock('../src/subtitle-model.js', () => ({ addCue: vi.fn(), cueTrackLocked: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/notes.js', () => ({ updateNoteActive: vi.fn() }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

let Media;
let Wave;
let State;
let resetAudioProject;
let resetPlayerAdapter;
let setStatus;
let showToast;

describe('HTML fallback mother audio follows the installed effect owner', () => {
  afterEach(()=>{ Media.reset(); delete window.subtool.reverseAudio; vi.unstubAllGlobals(); });
  beforeAll(async () => {
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, ...deskMock },
    });
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), fftSize: 0 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelMerger(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      decodeAudioData(buffer){
        const view=new DataView(buffer),numberOfChannels=view.getUint16(22,true),sampleRate=view.getUint32(24,true);
        const length=(buffer.byteLength-44)/2/numberOfChannels;
        const channels=Array.from({length:numberOfChannels},(_,channel)=>Float32Array.from({length},(_,index)=>view.getInt16(44+(index*numberOfChannels+channel)*2,true)/32768));
        return Promise.resolve({duration:length/sampleRate,length,numberOfChannels,sampleRate,getChannelData:channel=>channels[channel]});
      }
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
    ({ setStatus, showToast } = await import('../src/ui.js'));
  });

  beforeEach(() => {
    deskMock.stat.mockClear();
    deskMock.probe.mockClear();
    deskMock.fileURL.mockClear();
    deskMock.ingest.mockReset();
    deskMock.waveAudio.mockReset();
    deskMock.cleanupAudio.mockReset();
    setStatus.mockClear();
    showToast.mockClear();
    deskMock.ingest.mockResolvedValue({ channels: [] });
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.cues = [];
    State.clips = [];
    State.mediaPath = null;
    resetAudioProject();
    domMock.video.src = '';
    domMock.video.readyState = 1;
    domMock.video.duration = 12;
    delete window.subtool.streamIngest;
  });

  it.each([
    {name:'silent-first',values:[[0],[.8]],durations:[1,1],first:.4,tail:.4},
    {name:'opposite-phase',values:[[.8],[-.8]],durations:[1,1],first:0,tail:0},
    {name:'unequal-channels',values:[[.2,.4],[.9]],durations:[1,1],first:.5,tail:.5},
    {name:'short-tail',values:[[.6,.6],[.9]],durations:[1,.5],first:.7,tail:.4},
    {name:'non-contiguous-streams',sourceStreams:[1,3],values:[[.2,.4],[.9]],durations:[1,1],first:.5,tail:.5},
    {name:'reordered-streams',sourceStreams:[3,1],values:[[.2,.4],[.9]],durations:[1,1],first:.5,tail:.5},
  ])('public effect $name mixes all PCM channels before extrema and reloads the same mix',async({values,durations,first,tail,sourceStreams=values.map((unused,index)=>index)})=>{
    const assignments=[];
    class AudioAdapter{constructor(){this.readyState=1;this.duration=1;}set src(value){if(value)assignments.push({value,crossOrigin:this.crossOrigin});this.url=value;}get src(){return this.url||'';}addEventListener(){}removeEventListener(){}pause(){}load(){}}
    vi.stubGlobal('Audio',AudioAdapter);
    const descriptors=values.flatMap((channels,index)=>channels.map((unused,sourceChannel)=>({sourceStream:sourceStreams[index],sourceChannel})));
    const source={id:'effect-source',path:'C:/media/multistream.mov',audioSrc:'video',audioSourceId:'effect-source',in:0,out:1,dur:1,offset:0,vtrack:0,primary:true,descriptors};
    State.clips=[source];
    window.subtool.normalizeAudio=vi.fn(async(path,options)=>({outputPath:`C:/cache/effect-stream-${options.sourceStream}.wav`}));
    deskMock.fileURL.mockImplementation(async path=>'file:///'+path);
    deskMock.waveAudio.mockImplementation(async path=>path+'.wave.wav');
    vi.stubGlobal('fetch',vi.fn(async url=>{const stream=sourceStreams.indexOf(Number(/stream-(\d+)/.exec(url)[1]));return {arrayBuffer:async()=>wav(values[stream],durations[stream])};}));
    resetPlayerAdapter(window.subtool,domMock.video);
    const registry=vi.spyOn(Wave,'setSourceMixPeaks');
    expect(await Media.audioEffects.apply(source,{max:-6,min:-12})).toMatchObject({status:'completed'});
    expect(assignments).toEqual(sourceStreams.map(stream=>({value:`file:///C:/cache/effect-stream-${stream}.wav`,crossOrigin:'anonymous'})));
    expect(Media.tracks.map(track=>[track.sourceStream,track.sourceChannel])).toEqual(descriptors.map(d=>[d.sourceStream,d.sourceChannel]));
    expect(deskMock.waveAudio.mock.calls.map(([path])=>path)).toEqual(sourceStreams.map(stream=>`C:/cache/effect-stream-${stream}.wav`));
    const peaks=Wave.getSourceWaveform(source).peaks;
    expect(peaks).toHaveLength(200);expect(peaks[1]).toBeCloseTo(first,4);expect(peaks.at(-1)).toBeCloseTo(tail,4);
    if(values[0].length>1){
      const channel=`${sourceStreams[0]}:1`;
      Wave.setSourceWaveSelection(source,channel);await Wave.loadSourceWaveform(source,channel);
      expect(fetch.mock.lastCall[0]).toBe(`file:///C:/cache/effect-stream-${sourceStreams[0]}.wav.wave.wav`);
      expect(Wave.getSourceWaveform(source).peaks[1]).toBeCloseTo(values[0][1],4);
      Wave.setSourceWaveSelection(source,'mix');
    }
    const descriptor=registry.mock.calls.find(([,supplied])=>supplied===peaks)[2].mixPath;
    expect(Object.isFrozen(descriptor)).toBe(true);expect(Object.isFrozen(descriptor.paths)).toBe(true);
    expect(Object.isFrozen(descriptor.sourceStreams)).toBe(true);expect(descriptor.sourceStreams).toEqual(sourceStreams);
    Wave.forgetSourceWaveforms(source);Wave.registerSourceWaveforms(source,{mixPath:descriptor});
    expect(await Wave.loadSourceWaveform(source,'mix')).toEqual(peaks);
    if(values[0].length>1){
      // Runtime track iteration order must not change the member identity.
      Media.tracks.reverse();Wave.forgetSourceWaveforms(source);Wave.registerSourceWaveforms(source,{mixPath:descriptor});
      const channel=`${sourceStreams[0]}:1`;
      await Wave.setSourceWaveSelection(source,channel);
      await Wave.loadSourceWaveform(source,channel);
      expect(fetch.mock.lastCall[0]).toBe(`file:///C:/cache/effect-stream-${sourceStreams[0]}.wav.wave.wav`);
      expect(Wave.getSourceWaveform(source).peaks[1]).toBeCloseTo(values[0][1],4);
    }
    expect(fetch.mock.calls.every(([url])=>url.endsWith('.wave.wav'))).toBe(true);
    expect(Media.tracks.every(track=>track.file===`C:/cache/effect-stream-${track.sourceStream}.wav`)).toBe(true);
    if(values[0].length>1){
      Wave.forgetSourceWaveforms(source);Wave.registerSourceWaveforms(source,{mixPath:descriptor});
      const channel=`${sourceStreams[0]}:1`,late=deferred(),beforeFetch=fetch.mock.calls.length;
      fetch.mockImplementationOnce(async()=>({arrayBuffer:()=>late.promise}));
      Wave.setSourceWaveSelection(source,channel);const oldRead=Wave.loadSourceWaveform(source,channel);
      await vi.waitFor(()=>expect(fetch.mock.calls).toHaveLength(beforeFetch+1));
      expect(fetch.mock.lastCall[0]).toBe(`file:///C:/cache/effect-stream-${sourceStreams[0]}.wav.wave.wav`);
      if(sourceStreams[0]===3)Media.reset();else{
        Wave.forgetSourceWaveforms(source);Wave.registerSourceWaveforms(source,{mixPath:descriptor,mixPeaks:peaks});
      }
      late.resolve(wav([.95,.95]));
      await expect(oldRead).resolves.toBeNull();
      expect(Wave.getSourceWaveform(source).peaks).toBe(sourceStreams[0]===3?null:peaks);
    }
    registry.mockRestore();
  });

  it('reset during the second processed PCM read cannot publish the old mix or retain prepared elements',async()=>{
    const delayed=deferred(),elements=[];
    class AudioAdapter{constructor(){this.readyState=1;this.duration=1;this.src='';elements.push(this);}addEventListener(){}removeEventListener(){}pause(){}load(){}}
    vi.stubGlobal('Audio',AudioAdapter);
    const source={id:'old-effect',path:'C:/media/old.mov',audioSrc:'video',audioSourceId:'old-effect',in:0,out:1,dur:1,offset:0,vtrack:0,primary:true,descriptors:[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0}]};
    State.clips=[source];window.subtool.normalizeAudio=vi.fn(async(path,options)=>({outputPath:`C:/cache/stream-${options.sourceStream}.wav`}));
    deskMock.fileURL.mockImplementation(async path=>'file:///'+path);deskMock.waveAudio.mockImplementation(async path=>path+'.wave.wav');
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:()=>String(url).includes('stream-1')?delayed.promise:Promise.resolve(wav(.6))})));
    resetPlayerAdapter(window.subtool,domMock.video);
    const work=Media.audioEffects.apply(source,{max:-6,min:-12});
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));Media.reset();delayed.resolve(wav(.8));
    expect(await work).toMatchObject({status:'replaced'});
    expect(Media.tracks).toEqual([]);expect(Wave.getSourceWaveform(source).peaks).toBeNull();
    expect(elements.every(element=>element.src==='')).toBe(true);
  });

  it.each(['stream','ingest','native'])('late %s original audio does not replace an installed audio effect or waveform', async kind=>{
    const rawURL=deferred();
    const processedWave=wav(.25),originalWave=wav(.75);
    const raw='C:/cache/raw.wav';
    class AudioAdapter {
      constructor(){this.readyState=1;this.duration=12;this.paused=true;this.src='';this.volume=1;}
      addEventListener(){} removeEventListener(){} pause(){this.paused=true;} load(){}
      play(){this.paused=false;return Promise.resolve();}
    }
    vi.stubGlobal('Audio',AudioAdapter);
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:kind==='native'?'vp9':'prores',fps:25,width:1920,height:1080},audio:[{channels:1}]});
    deskMock.fileURL.mockImplementation(path=>path===raw?rawURL.promise:Promise.resolve('file:///'+path));
    const result={streamUrl:'file:///C:/cache/proxy.mp4',channels:[{file:raw,sourceStream:0,sourceChannel:0}],wave:'C:/cache/raw-wave.wav',ingestJobId:22,cached:false};
    if(kind==='stream')window.subtool.streamIngest=vi.fn(async()=>result);
    else deskMock.ingest.mockResolvedValue(kind==='native'?{channels:[]}:result);
    window.subtool.normalizeAudio=vi.fn(async()=>({outputPath:'C:/cache/effect.wav'}));
    window.subtool.cancelAudioNormalization=vi.fn();
    if(kind==='native')deskMock.waveAudio.mockReturnValueOnce(rawURL.promise).mockResolvedValue('C:/cache/effect-wave.wav');
    else deskMock.waveAudio.mockResolvedValue('C:/cache/effect-wave.wav');
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>String(url).includes('raw-wave')?originalWave:processedWave})));
    resetPlayerAdapter(window.subtool,domMock.video);
    const loading=Media.loadDesktopMedia(kind==='native'?'C:/media/native.webm':'C:/media/fallback.mov');
    await vi.waitFor(()=>expect(State.clips).toHaveLength(1));
    const source=State.clips[0];
    await Media.audioEffects.apply(source,{max:-6,min:-12,inputBoost:0});
    expect(Media.tracks).toHaveLength(1);
    expect(Media.tracks[0].file).toBe('C:/cache/effect.wav');
    const effected=Media.tracks[0];const effectPeaks=source.peaks;
    effected.volume=.4;effected.muted=false;effected.solo=true;
    if(kind==='stream')window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:{jobId:22}}));
    rawURL.resolve(kind==='native'?'C:/cache/raw-wave.wav':'file:///'+raw);await loading;
    await vi.waitFor(()=>expect(setStatus).toHaveBeenLastCalledWith(kind==='stream'?'媒體已載入':kind==='native'?'媒體已載入（原生直讀，免轉 Proxy）':'媒體已載入（桌面模式）','ok'));
    expect(Media.tracks).toEqual([effected]);
    expect(source.peaks).toBe(effectPeaks);
    expect(Wave.getSourceWaveform(source).peaks).toBe(effectPeaks);
    await Media.audioEffects.apply(source,null);
    if(kind!=='native'){expect(Media.tracks).toHaveLength(1);expect(Media.tracks[0].file).toBe(raw);}
    expect(Media.tracks.find(track=>track.sourceChannel===0)).toMatchObject({volume:.4,muted:false,solo:true});
    expect(source.peaks[1]).toBeCloseTo(.75,4);
    expect(source.path).toBe(kind==='native'?'C:/media/native.webm':'C:/media/fallback.mov');
    expect(source.audioLimiterSpec).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it.each([0,1])('原生雙聲道 Stream%s 快取晚到仍保留效果正播與反轉來源，還原才接回原音快取',async sourceStream=>{
    const originalCache=deferred(),originalWave=deferred();
    class AudioAdapter {
      constructor(){this.readyState=1;this.duration=12;this.paused=true;this.src='';this.currentTime=0;this.volume=1;
        this.play=vi.fn(()=>{this.paused=false;return Promise.resolve();});}
      addEventListener(){} removeEventListener(){} pause(){this.paused=true;} load(){}
    }
    vi.stubGlobal('Audio',AudioAdapter);
    const mother='C:/media/native-stereo.webm',processed='C:/cache/effect-stereo.wav';
    const channels=[0,1].map(sourceChannel=>({file:`C:/cache/original-${sourceChannel}.m4a`,sourceStream,sourceChannel}));
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:'vp9',fps:25,width:1920,height:1080},audio:[{channels:2}]});
    deskMock.ingest.mockReturnValue(originalCache.promise);
    deskMock.fileURL.mockImplementation(async path=>'file:///'+path);
    deskMock.waveAudio.mockImplementation(path=>path===mother?originalWave.promise:Promise.resolve('C:/cache/effect-wave.wav'));
    window.subtool.normalizeAudio=vi.fn(async()=>({outputPath:processed}));
    window.subtool.reverseAudio=vi.fn(async({path})=>({path:path+'.reverse.wav'}));
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>String(url).includes('original-wave')?wav([.7,.9]):wav([.25,.5])})));
    resetPlayerAdapter(window.subtool,domMock.video);
    const loading=Media.loadDesktopMedia(mother);
    await vi.waitFor(()=>expect(State.clips).toHaveLength(1));
    const source=State.clips[0];
    expect(await Media.audioEffects.apply(source,{max:-6,min:-12})).toMatchObject({status:'completed'});
    const effectTracks=[...Media.tracks],effectElement=effectTracks[0].el,effectPeaks=source.peaks;
    expect(effectTracks.map(track=>track.file)).toEqual([processed,processed]);
    Media.startElementSources(0,0);
    await vi.waitFor(()=>expect(effectElement.play).toHaveBeenCalledOnce());

    originalCache.resolve({channels});originalWave.resolve('C:/cache/original-wave.wav');
    await loading;
    expect(Media.tracks).toEqual(effectTracks);
    expect(effectTracks.map(track=>track.file)).toEqual([processed,processed]);
    expect(effectTracks.map(track=>[track.sourceStream,track.sourceChannel])).toEqual([[0,0],[0,1]]);
    expect(effectElement.src).toBe('file:///'+processed);
    expect(source.peaks).toBe(effectPeaks);
    Media.startElementSources(0,0);
    await vi.waitFor(()=>expect(effectElement.play).toHaveBeenCalledTimes(2));
    Media.stopElementSources();
    source.reverse=true;
    expect(await Media.prepareClipReverseAudio(source)).toBe(true);
    expect(window.subtool.reverseAudio.mock.calls.map(([request])=>request.path)).toEqual([processed,processed]);

    expect(await Media.audioEffects.apply(source,null)).toMatchObject({status:'completed'});
    expect(Media.tracks.map(track=>track.file)).toEqual(channels.map(channel=>channel.file));
    expect(Media.tracks.map(track=>[track.sourceStream,track.sourceChannel])).toEqual([[sourceStream,0],[sourceStream,1]]);
    expect(Media.tracks.every(track=>!track._audioEffect)).toBe(true);
    expect(source.peaks[1]).toBeCloseTo(.8,4);
  });

  it.each(['before IPC reply','during video metadata'])('retains stream completion %s and installs original audio exactly once',async moment=>{
    let made=0;
    class AudioAdapter {
      constructor(){made++;this.readyState=1;this.duration=12;this.paused=true;this.src='';}
      addEventListener(){} removeEventListener(){} pause(){} load(){}
    }
    vi.stubGlobal('Audio',AudioAdapter);
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:'prores',fps:25,width:1920,height:1080},audio:[{channels:1}]});
    const result={streamUrl:'file:///C:/cache/proxy.mp4',channels:[{file:'C:/cache/raw.wav',sourceStream:0,sourceChannel:0}],ingestJobId:22,cached:false};
    const done=jobId=>window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:{jobId}}));
    window.subtool.streamIngest=vi.fn(async()=>{if(moment==='before IPC reply'){done(undefined);done('');done(999);done(22);done(22);}return result;});
    deskMock.fileURL.mockImplementation(path=>Promise.resolve('file:///'+path));
    if(moment==='during video metadata')domMock.video.readyState=0;
    resetPlayerAdapter(window.subtool,domMock.video);
    const loading=Media.loadDesktopMedia('C:/media/early.mov');
    if(moment==='during video metadata'){
      await vi.waitFor(()=>expect(typeof domMock.video.onloadedmetadata).toBe('function'));
      done(undefined);done('');done(999);expect(made).toBe(0);done(22);done(22);expect(made).toBe(0);
      domMock.video.readyState=1;domMock.video.onloadedmetadata();
    }
    await loading;
    await vi.waitFor(()=>expect(Media.tracks.filter(t=>t.file==='C:/cache/raw.wav')).toHaveLength(1));
    done(22);done(999);await Promise.resolve();expect(made).toBe(1);
    expect(Media.pendingChannels).toEqual([]);
  });

  it.each(['replacement','metadata error'])('cleans its stream completion listener on %s and ignores later old completion',async reason=>{
    const remove=vi.spyOn(window,'removeEventListener');
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:'prores',fps:25},audio:[]});
    window.subtool.streamIngest=vi.fn(async()=>({streamUrl:'file:///C:/cache/proxy.mp4',channels:[{file:'C:/cache/old.wav'}],ingestJobId:22,cached:false}));
    domMock.video.readyState=0;resetPlayerAdapter(window.subtool,domMock.video);
    const loading=Media.loadDesktopMedia('C:/media/old.mov');
    await vi.waitFor(()=>expect(typeof domMock.video.onloadedmetadata).toBe('function'));
    if(reason==='metadata error')domMock.video.onerror();
    else Media.reset();
    await loading;
    window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:{jobId:22}}));
    expect(Media.tracks.some(t=>t.file==='C:/cache/old.wav')).toBe(false);
    expect(remove).toHaveBeenCalledWith('desk:ingest-done',expect.any(Function));remove.mockRestore();
  });
});

function wav(amplitude,duration=1){
  const values=Array.isArray(amplitude)?amplitude:[amplitude],channels=values.length,frames=Math.round(4000*duration),bytes=frames*channels*2;
  const buffer=new ArrayBuffer(44+bytes),view=new DataView(buffer);
  for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<4;i++)view.setUint8(offset+i,text.charCodeAt(i));
  view.setUint32(4,bytes+36,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,4000,true);view.setUint32(28,4000*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);view.setUint32(40,bytes,true);
  for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++)view.setInt16(44+(i*channels+ch)*2,Math.round((i%2?values[ch]:-values[ch])*32768),true);
  return buffer;
}

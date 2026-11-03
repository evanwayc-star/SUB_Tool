// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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
          querySelector: () => null,
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
  cancelMediaIntake: vi.fn(async()=>1),
  releaseStream: vi.fn(async()=>{}),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', async original => ({
  renderCurrentTimecode: (await original()).renderCurrentTimecode,
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

function sourceWave(seconds, amplitude=16384) {
  const count=Math.round(4000*seconds),buffer=new ArrayBuffer(44+count*2),view=new DataView(buffer);
  for(const [offset,value] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
    for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));
  view.setUint32(4,36+count*2,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,4000,true);view.setUint32(28,8000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,count*2,true);
  for(let i=0;i<count;i++)view.setInt16(44+i*2,i%2?amplitude:-amplitude,true);
  return buffer;
}

let Media;
let Wave;
let State;
let resetAudioProject;
let resetPlayerAdapter;
let setStatus;
let showToast;
let pending;
let shuttleRewind;
let shuttlePause;
let stepFrame;
let jklReset;

describe('desktop mother-source intake ownership', () => {
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
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
    ({ setStatus, showToast } = await import('../src/ui.js'));
    ({ shuttleRewind, shuttlePause, stepFrame, jklReset } = await import('../src/transport-controller.js'));
  });

  beforeEach(() => {
    pending = new Map();
    deskMock.stat.mockClear();
    deskMock.probe.mockClear();
    deskMock.fileURL.mockClear();
    deskMock.ingest.mockReset();
    deskMock.waveAudio.mockReset();
    deskMock.cleanupAudio.mockReset();
    deskMock.cancelMediaIntake.mockClear();
    deskMock.releaseStream.mockClear();
    setStatus.mockClear();
    showToast.mockClear();
    deskMock.ingest.mockImplementation(({ path }) => {
      const work = deferred();
      pending.set(path, work);
      return work.promise;
    });
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

  it.each(['native-six-channel','non-native-no-stream'].flatMap(branch=>['complete','save-failure'].map(outcome=>({branch,outcome}))))
  ('B2 $branch 在持久波形完成前不啟動 ingest：$outcome',async({branch,outcome})=>{
    const native=branch==='native-six-channel',wave=deferred(),key='c'.repeat(16);
    deskMock.probe.mockResolvedValue({duration:2,video:{codec:native?'h264':'prores',fps:25,width:1920,height:1080},audio:[{channels:6}]});
    window.subtool.sourceWaveformContinuous=true;
    window.subtool.prepareSourceWaveform=vi.fn(()=>wave.promise);
    window.subtool.mediaSourceKey=vi.fn(async()=>key);
    const fetchWave=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('完整進度應直接交接，不重讀 WAV'));
    delete window.subtool.streamIngest;delete window.subtool.mpv;resetPlayerAdapter(window.subtool);
    const {MediaIntakeJobs}=await import('../src/media-intake-jobs.js');
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const loading=Media.loadDesktopMedia('C:/media/B2.mov');
    try{
      await vi.waitFor(()=>expect(window.subtool.prepareSourceWaveform).toHaveBeenCalledOnce(),{timeout:1000});
      const request=window.subtool.prepareSourceWaveform.mock.calls[0][0];
      expect(request).toMatchObject({path:'C:/media/B2.mov',duration:2,continuous:true,audio:[{channels:6}]});
      const data={sourceKey:key,startSample:0,completedSamples:4000,totalSamples:8000,sampleRate:4000,resolution:100,
        peaks:Float32Array.from({length:200},(_,index)=>index%2?.5:-.25)};
      MediaIntakeJobs.progress({...request,stage:'source-waveform',waveform:data,pct:50});
      expect(getProvisionalSourceWaveform()?.peaks).toEqual(data.peaks);
      expect(deskMock.ingest).not.toHaveBeenCalled();expect(State.clips).toEqual([]);
      if(outcome==='save-failure'){
        wave.reject(new Error('checkpoint save failed'));await loading;
        expect(deskMock.ingest).not.toHaveBeenCalled();expect(getProvisionalSourceWaveform()).toBeNull();
        expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('波形尚未完成'),'err');
      }else{
        MediaIntakeJobs.progress({...request,stage:'source-waveform',waveform:{...data,startSample:4000,completedSamples:8000},pct:100});
        const savedPeaks=getProvisionalSourceWaveform().peaks;
        expect(deskMock.ingest).not.toHaveBeenCalled();
        wave.resolve({wave:'shared/wave.wav',sourceKey:key,start:0,duration:2,complete:true,temporary:false});
        await vi.waitFor(()=>expect(deskMock.ingest).toHaveBeenCalledOnce());
        expect(deskMock.ingest.mock.calls[0][0]).toMatchObject({path:'C:/media/B2.mov',needsProxy:!native});
        // 真 ingest 回覆不含 sourceKey；正式 metadata 就緒後重新核對來源再交接。
        pending.get('C:/media/B2.mov').resolve({channels:[],wave:'shared/wave.wav'});
        await loading;
        expect(State.clips).toHaveLength(1);
        expect(State.clips[0].peaks).toBe(savedPeaks);
        expect(Wave.getSourceMixPeaks(State.clips[0])).toBe(savedPeaks);
        expect([...Wave.sourceWaveforms.values()].find(entry=>entry.mix.peaks===savedPeaks)?.mix.path).toBe('shared/wave.wav');
        expect(getProvisionalSourceWaveform()).toBeNull();
        expect(window.subtool.mediaSourceKey).toHaveBeenCalledWith('C:/media/B2.mov');
        expect(fetchWave).not.toHaveBeenCalled();
      }
    }finally{
      Media.reset();wave.resolve({});for(const work of pending.values())work.resolve({channels:[]});await loading;
      fetchWave.mockRestore();
      delete window.subtool.sourceWaveformContinuous;delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;
      deskMock.probe.mockResolvedValue({duration:12,video:{codec:'h264',fps:25,width:1920,height:1080},audio:[{channels:6,channelLayout:'5.1'}]});
    }
  });

  it.each(['complete','short'])('舊快取短 PCM 經真 waveform runtime 重建：%s',async mode=>{
    const require=createRequire(import.meta.url);
    const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
    const {FileAuthority}=require('../electron/file-authority.js');
    const {createProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-short-source-wave-'));
    const source=path.join(root,'mother.mov'),cacheRoot=path.join(root,'cache'),tempRoot=path.join(root,'tmp');
    fs.mkdirSync(tempRoot);fs.writeFileSync(source,'source');
    const runtime=createMediaIntakeRuntime({cacheRoot,tempRoot,allowSidecarCache:false,delay:async()=>{},
      fileAuthority:new FileAuthority({internalDirectories:[cacheRoot,tempRoot]}),
      ffmpegExecution:{execute:async (args,options)=>{
        if(Number.isInteger(options.outputDescriptor))fs.writeSync(options.outputDescriptor,wav(mode==='short'?.25:1));
        else for(const file of args.filter(value=>/\.(m4a|wav|mp4)$/.test(value)))fs.writeFileSync(file,file.endsWith('.wav')?wav(1):'initial data');
      }}});
    const wav=seconds=>{
      const count=4000*seconds,b=Buffer.alloc(44+count*2);
      b.write('RIFF',0);b.writeUInt32LE(36+count*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
      b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(4000,24);b.writeUInt32LE(8000,28);
      b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);
      for(let i=0;i<count;i++)b.writeInt16LE(i%2?16384:-16384,44+i*2);return b;
    };
    let entry;
    try{
      const result=await runtime.ingest({src:source,duration:1,needsProxy:false,audio:[{channels:1}]});
      const directory=path.dirname(path.dirname(result.wave));
      const metaFile=path.join(directory,'meta.json'),generation=path.join(path.dirname(result.wave),'cache-meta.json');
      fs.unlinkSync(generation);const meta=JSON.parse(fs.readFileSync(metaFile,'utf8'));delete meta.artifactSizes;
      fs.writeFileSync(metaFile,JSON.stringify(meta));fs.writeFileSync(result.wave,wav(.25));
      const native=await runtime.waveform({src:source,duration:1,start:0,length:1,audio:[{channels:1}]});
      expect(native.cached).toBe(true);expect(fs.statSync(native.wave).size).toBe(2044);
      const jobs={prepareWaveform:fn=>fn({owns:()=>true,report:()=>true}),
        prepareSourceWaveform:vi.fn(opts=>runtime.waveform({src:opts.path,...opts}))};
      const bridge={fileURL:async file=>file,cleanupAudio:vi.fn(async file=>runtime.cleanupGeneratedFile(file)),mediaSourceKey:async()=>native.sourceKey};
      const owner=createProvisionalSourceWaveform({jobs,bridge,decode:(bytes,duration)=>Wave.calcSourceWaveform(bytes,duration),
        read:async file=>{const bytes=fs.readFileSync(file);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}});
      entry=owner.begin({path:source,name:'mother.mov',duration:1,audio:[{channels:1}],owns:()=>true});
      await entry.finished;
      expect(jobs.prepareSourceWaveform).toHaveBeenCalledTimes(2);
      expect(jobs.prepareSourceWaveform.mock.calls[1][0].ignoreCached).toBe(true);
      if(mode==='short') expect(owner.snapshot()).toBeNull();
      else{
        const peaks=owner.snapshot().peaks;
        expect(peaks).toHaveLength(200);
        expect(peaks.slice(-20).every(value=>Math.abs(value)>.4)).toBe(true);
      }
      expect(fs.readFileSync(result.wave).equals(wav(.25))).toBe(true);
      expect(bridge.cleanupAudio).toHaveBeenCalledOnce();
      expect(fs.existsSync(bridge.cleanupAudio.mock.calls[0][0])).toBe(false);
    }finally{
      entry?.cancel();
      await runtime.close();const resolved=fs.realpathSync(root);
      if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-short-source-wave-'))throw new Error('拒絕清理測試範圍外路徑');
      fs.rmSync(resolved,{recursive:true,force:true});
    }
  });

  it.each(['native','multichannel'].flatMap(branch=>['reset','grow','error'].map(outcome=>({branch,outcome}))))
  ('桌面 $branch 影片初始定位保留匯入所有權：$outcome',async({branch,outcome})=>{
    const properties=['currentTime','addEventListener','removeEventListener']
      .map(name=>[name,Object.getOwnPropertyDescriptor(domMock.video,name)]);
    const carrier=new EventTarget();
    let rawTime=0,settled=false,load;
    try{
      domMock.video.addEventListener=(...args)=>carrier.addEventListener(...args);
      domMock.video.removeEventListener=(...args)=>carrier.removeEventListener(...args);
      Object.defineProperty(domMock.video,'currentTime',{configurable:true,
        get:()=>rawTime,set:value=>{
          if(outcome==='error'&&value>=5)throw new Error('source seek failed');
          rawTime=Math.min(value,domMock.video.duration);
        }});
      domMock.video.duration=3.5;domMock.video.readyState=1;
      resetPlayerAdapter(window.subtool,domMock.video);
      deskMock.probe.mockResolvedValueOnce({duration:3,
        video:{codec:'h264',fps:30,width:64,height:48,timestampOffset:-.5,presentationTimestampOffset:-5.5},
        audio:branch==='native'?[]:[{channels:6,channelLayout:'5.1'}]});
      deskMock.ingest.mockResolvedValueOnce({channels:[]});
      load=Media.loadDesktopMedia('C:/media/origin-five.mov').then(()=>{settled=true;});
      if(outcome==='error'){
        await load;
        expect(State.clips).toEqual([]);expect(State.duration).toBe(0);
        expect(setStatus).toHaveBeenLastCalledWith('讀取失敗','');
        expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('無法定位影片'));
        return;
      }
      await vi.waitFor(()=>expect(rawTime).toBe(3.5));
      expect(settled).toBe(false);
      if(outcome==='reset'){
        Media.reset();
        await vi.waitFor(()=>expect(settled).toBe(true),{timeout:500,interval:10});
        domMock.video.duration=8.5;carrier.dispatchEvent(new Event('durationchange'));
        expect(rawTime).toBe(3.5);expect(State.clips).toEqual([]);expect(State.duration).toBe(0);
      }else{
        domMock.video.duration=8.5;carrier.dispatchEvent(new Event('durationchange'));await load;
        expect(rawTime).toBe(5.5);expect(Media.vTime()).toBe(0);
        expect(State.duration).toBe(3);expect(State.clips[0].dur).toBe(3);
      }
    }finally{
      domMock.video.duration=8.5;carrier.dispatchEvent(new Event('durationchange'));
      await load?.catch(()=>{});
      Media.reset();
      for(const [name,descriptor]of properties){
        if(descriptor)Object.defineProperty(domMock.video,name,descriptor);
        else delete domMock.video[name];
      }
    }
  });

  it('原生預覽 metadata 較短時保留 ffprobe 母素材片長', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/native.webm');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it('邊轉邊播 Proxy 的暫時片長不縮短母素材', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    window.subtool.streamIngest = vi.fn(async () => ({
      streamUrl: 'file:///C:/cache/growing-proxy.mp4', cached: true, channels: [],
    }));
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/growing.mov');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it.each(['fresh','restore','newer','changed','failure'])('跨機驗證等待期間顯示獨立來源波形，%s 就緒並核對相同證據才交給正式素材',async mode=>{
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const {ProjectRestorePlan}=await import('../src/project-intake-engine.js');
    const {Seq}=await import('../src/sequence.js');
    const stream=deferred(),duration=1,key='a'.repeat(16);
    const pcm=new ArrayBuffer(44+8000),view=new DataView(pcm);
    for(const [offset,value] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
      for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));
    view.setUint32(4,8036,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,4000,true);view.setUint32(28,8000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,8000,true);
    for(let i=0;i<4000;i++)view.setInt16(44+i*2,i%2?16384:-16384,true);
    deskMock.probe.mockResolvedValueOnce({duration,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>stream.promise);
    window.subtool.prepareSourceWaveform=vi.fn(async()=>({wave:'C:/cache/independent-wave.wav',sourceKey:key,start:0,duration,temporary:true}));
    const verify=deferred();
    window.subtool.mediaSourceKey=vi.fn(()=>mode==='newer'?verify.promise:Promise.resolve(mode==='changed'?'b'.repeat(16):key));
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>pcm})));
    try{
      const plan=mode==='restore'?new ProjectRestorePlan({mediaRelink:true,clips:[
        {primary:true,path:'C:/media/A.mov',audioSourceId:'saved-source',in:.2,out:.8,dur:1,offset:3},
        {path:'C:/media/A.mov',audioSourceId:'saved-source',in:0,out:.5,dur:1,offset:5,reverse:true},
      ]}):null;
      const loading=Media.loadDesktopMedia('C:/media/A.mov',plan);
      await vi.waitFor(()=>expect(getProvisionalSourceWaveform()?.peaks?.some(value=>Math.abs(value)>.4)).toBe(true));
      expect(State.clips).toEqual([]);expect(window.subtool.streamIngest).toHaveBeenCalledOnce();
      if(mode==='failure'){
        stream.reject(new Error('stream failure'));await loading;
        expect(getProvisionalSourceWaveform()).toBeNull();expect(State.clips).toEqual([]);
        expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/independent-wave.wav');
        return;
      }
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,cached:true,channels:[]});
      await loading;
      if(mode==='changed'){
        await vi.waitFor(()=>expect(getProvisionalSourceWaveform()).toBeNull());
        expect(State.clips[0].peaks).toBeFalsy();
        expect(window.subtool.prepareSourceWaveform).toHaveBeenCalledOnce();
        return;
      }
      if(mode==='newer'){
        await vi.waitFor(()=>expect(window.subtool.mediaSourceKey).toHaveBeenCalledOnce());
        const newer=Float32Array.from({length:200},(_,i)=>i%2?.9:-.9);
        Media._commitOriginalWave(State.clips[0],newer,{mixPath:'new-wave'});
        verify.resolve(key);
        await vi.waitFor(()=>expect(getProvisionalSourceWaveform()).toBeNull());
        expect(State.clips[0].peaks).toBe(newer);
      }
      await vi.waitFor(()=>expect(State.clips[0]?.peaks?.some(value=>Math.abs(value)>.4)).toBe(true));
      if(plan){
        await Media.waitForPendingProjectRestore();expect(State.clips).toHaveLength(2);
        expect(State.clips[0]).toMatchObject({in:.2,out:.8,offset:3});
        expect(State.clips[1]).toMatchObject({in:0,out:.5,offset:5,reverse:true});
        expect(Seq.toSource(5,State.clips[1])).toBeCloseTo(.5);
        expect(Wave.getSourceWaveform(State.clips[1]).peaks).toBe(State.clips[0].peaks);
      }
      expect(getProvisionalSourceWaveform()).toBeNull();expect(window.subtool.mediaSourceKey).toHaveBeenCalledWith('C:/media/A.mov');
      expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/independent-wave.wav');
    }finally{
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,cached:true,channels:[]});
      verify.resolve(key);
      Media.reset();delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;vi.unstubAllGlobals();
    }
  });

  it('取消 Proxy 時撤銷尚在準備的獨立波形並清理晚到 WAV',async()=>{
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const stream=deferred(),wave=deferred();
    deskMock.probe.mockResolvedValueOnce({duration:1,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>stream.promise);
    window.subtool.prepareSourceWaveform=vi.fn(()=>wave.promise);
    window.subtool.mediaSourceKey=vi.fn(async()=> 'a'.repeat(16));
    try{
      const loading=Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(()=>expect(window.subtool.prepareSourceWaveform).toHaveBeenCalledOnce());
      await Media.cancelProxyJobs();
      wave.resolve({wave:'C:/cache/late-wave.wav',sourceKey:'a'.repeat(16),start:0,duration:1,temporary:true});
      await loading;
      await vi.waitFor(()=>expect(deskMock.cleanupAudio).toHaveBeenCalledExactlyOnceWith('C:/cache/late-wave.wav'));
      expect(getProvisionalSourceWaveform()).toBeNull();expect(State.clips).toEqual([]);
    }finally{
      stream.resolve({streamUrl:'http://127.0.0.1:8080/old',streamLeaseId:'old',cached:true,channels:[]});
      wave.resolve(null);Media.reset();delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;
    }
  });

  it.each(['late','newer','newer-registry','selected-channel','replaced','changed'])('波形完成後串流就緒，交接查驗期間 %s 仍由最新來源擁有',async mode=>{
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const stream=deferred(),wave=deferred(),verify=deferred(),key='a'.repeat(16);
    const pcm=new ArrayBuffer(44+8000),view=new DataView(pcm);
    for(const [offset,value] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
      for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));
    view.setUint32(4,8036,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,4000,true);view.setUint32(28,8000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,8000,true);
    for(let i=0;i<4000;i++)view.setInt16(44+i*2,i%2?16384:-16384,true);
    deskMock.probe.mockResolvedValueOnce({duration:1,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>stream.promise);
    window.subtool.prepareSourceWaveform=vi.fn().mockReturnValueOnce(wave.promise)
      .mockResolvedValue({wave:'C:/cache/followup-wave.wav',sourceKey:key,start:0,duration:1,temporary:true});
    window.subtool.mediaSourceKey=vi.fn(()=>verify.promise);
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>pcm})));
    try{
      const loading=Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(()=>expect(window.subtool.prepareSourceWaveform).toHaveBeenCalledOnce());
      expect(window.subtool.streamIngest).not.toHaveBeenCalled();
      wave.resolve({wave:'C:/cache/late-wave.wav',sourceKey:key,start:0,duration:1,temporary:true});
      await vi.waitFor(()=>expect(window.subtool.streamIngest).toHaveBeenCalledOnce());
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,cached:true,channels:[]});
      await loading;
      expect(State.clips).toHaveLength(1); // 串流可用後，交接查驗不阻塞已可播放的影片。
      const primary=State.clips[0];
      const newer=Float32Array.from({length:200},(_,i)=>i%2?.9:-.9);
      if(mode==='newer')Media._commitOriginalWave(primary,newer,{mixPath:'new-wave'});
      if(mode==='newer-registry') Wave.setSourceMixPeaks(primary,newer,{mixPath:'new-wave'});
      if(mode==='selected-channel'){
        Wave.registerSourceWaveforms(primary,{channels:[{sourceStream:0,sourceChannel:0,peaks:newer}]});
        Wave.setSourceWaveSelection(primary,'0:0');
      }
      if(mode==='replaced')Media.reset();
      verify.resolve(mode==='changed'?'b'.repeat(16):key);
      await vi.waitFor(()=>expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/late-wave.wav'));
      if(mode==='late'||mode==='selected-channel'){
        await vi.waitFor(()=>expect(primary.peaks?.some(value=>Math.abs(value)>.4)).toBe(true));
      }else if(mode==='newer') expect(primary.peaks).toBe(newer);
      else if(mode==='newer-registry') expect(Wave.getSourceWaveform(primary).peaks).toBe(newer);
      else expect(primary.peaks).toBeFalsy();
      if(mode==='selected-channel')expect(Wave.getSourceWaveform(primary).peaks).toBe(newer);
      if(mode==='changed')expect(window.subtool.mediaSourceKey).toHaveBeenCalledWith('C:/media/A.mov');
      if(mode==='replaced')expect(State.clips).toEqual([]);
      await vi.waitFor(()=>expect(getProvisionalSourceWaveform()).toBeNull());
    }finally{
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,cached:true,channels:[]});
      wave.resolve(null);verify.resolve(key);Media.reset();delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;vi.unstubAllGlobals();
    }
  });

  it('長片先顯示前五秒波形，補齊分鐘邊界與全片後才啟動 Proxy',async()=>{
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const stream=deferred(),segments=[],key='a'.repeat(16),waves=new Map();
    deskMock.probe.mockResolvedValueOnce({duration:120,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>stream.promise);
    window.subtool.prepareSourceWaveform=vi.fn(options=>{
      const gate=deferred();segments.push({options,...gate});return gate.promise;
    });
    window.subtool.mediaSourceKey=vi.fn(async()=>key);
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>waves.get(String(url).split('/').at(-1))})));
    const finish=(index,amplitude)=>{
      const {start,length}=segments[index].options,wave=`segment-${index}.wav`;
      waves.set(wave,sourceWave(length,amplitude));
      segments[index].resolve({wave,sourceKey:key,start,duration:length,temporary:true});
    };
    const loading=Media.loadDesktopMedia('C:/media/long.mov');
    try{
      await vi.waitFor(()=>expect(segments).toHaveLength(1));
      expect(segments[0].options).toMatchObject({start:0,length:5,duration:120});
      finish(0,16384);
      await vi.waitFor(()=>expect(getProvisionalSourceWaveform()?.peaks).toHaveLength(1000));
      expect(getProvisionalSourceWaveform().peaks[1]).toBeCloseTo(.5,3);
      expect(window.subtool.streamIngest).not.toHaveBeenCalled();
      await vi.waitFor(()=>expect(segments).toHaveLength(2));
      expect(segments[1].options).toMatchObject({start:5,length:55,duration:120});
      finish(1,8192);
      await vi.waitFor(()=>expect(segments).toHaveLength(3));
      expect(segments[2].options).toMatchObject({start:60,length:60,duration:120});
      expect(window.subtool.streamIngest).not.toHaveBeenCalled();
      finish(2,24576);
      await vi.waitFor(()=>expect(window.subtool.streamIngest).toHaveBeenCalledOnce());
      expect(getProvisionalSourceWaveform().peaks).toHaveLength(24000);
      expect(State.clips).toEqual([]);
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,cached:true,channels:[]});
      await loading;
      await vi.waitFor(()=>expect(State.clips[0]?.peaks).toHaveLength(24000));
      const peaks=State.clips[0].peaks;
      expect(peaks[999]).toBeCloseTo(.5,3);expect(peaks[1001]).toBeCloseTo(.25,3);expect(peaks[12001]).toBeCloseTo(.75,3);
      expect(segments).toHaveLength(3);
      expect(deskMock.cleanupAudio).toHaveBeenCalledWith('segment-0.wav');
    }finally{
      Media.reset();for(const segment of segments)segment.resolve(null);stream.resolve(null);await loading;
      delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;vi.unstubAllGlobals();
    }
  });

  it('串流完成的新波形不被等待查驗的優先波形覆蓋',async()=>{
    const stream=deferred(),verify=deferred(),key='a'.repeat(16);
    const original=sourceWave(120,16384),full=sourceWave(120,24576);
    deskMock.probe.mockResolvedValueOnce({duration:120,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>stream.promise);
    window.subtool.prepareSourceWaveform=vi.fn(async()=>({wave:'priority.wav',sourceKey:key,start:0,duration:120,cached:true}));
    window.subtool.mediaSourceKey=vi.fn(()=>verify.promise);
    vi.stubGlobal('fetch',vi.fn(async url=>({arrayBuffer:async()=>String(url).includes('full-wave')?full:original})));
    try{
      const loading=Media.loadDesktopMedia('C:/media/long.mov');
      await vi.waitFor(()=>expect(window.subtool.streamIngest).toHaveBeenCalledOnce());
      stream.resolve({streamUrl:'http://127.0.0.1:8080/stream',streamLeaseId:'lease',sourceKey:key,
        cached:false,ingestJobId:'job-1',channels:[],wave:'C:/cache/full-wave.wav'});
      await loading;const primary=State.clips[0];
      await vi.waitFor(()=>expect(window.subtool.mediaSourceKey).toHaveBeenCalledOnce());
      window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:{jobId:'job-1'}}));
      await vi.waitFor(()=>expect(primary.peaks?.length).toBe(24000));
      const complete=primary.peaks;
      expect(complete.some(value=>Math.abs(value)>.7)).toBe(true);
      verify.resolve(key);
      const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
      await vi.waitFor(()=>expect(getProvisionalSourceWaveform()).toBeNull());
      expect(primary.peaks===complete).toBe(true);
      expect(Wave.getSourceMixPeaks(primary)===complete).toBe(true);
      expect(window.subtool.prepareSourceWaveform).toHaveBeenCalledOnce();
    }finally{
      Media.reset();verify.resolve(key);stream.resolve(null);
      delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;vi.unstubAllGlobals();
    }
  });

  it('長片完整波形整理時仍可取消，取消後不發布峰值也不啟動 Proxy',async()=>{
    const {getProvisionalSourceWaveform}=await import('../src/provisional-source-waveform.js');
    const duration=7200,key='a'.repeat(16),bytes=sourceWave(duration);
    deskMock.probe.mockResolvedValueOnce({duration,video:{codec:'prores',fps:25},audio:[{channels:1}]});
    window.subtool.streamIngest=vi.fn(()=>new Promise(()=>{}));
    window.subtool.prepareSourceWaveform=vi.fn(async()=>({wave:'complete.wav',sourceKey:key,start:0,duration,cached:true,temporary:true}));
    window.subtool.mediaSourceKey=vi.fn(async()=>key);
    let cancelFinished,peaksAtCancel;
    const cancelled=new Promise(resolve=>{cancelFinished=resolve;});
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>{
      setTimeout(()=>{
        peaksAtCancel=getProvisionalSourceWaveform()?.peaks;
        void Media.cancelProxyJobs().then(cancelFinished);
      },0);
      return bytes;
    }})));
    try{
      await Media.loadDesktopMedia('C:/media/two-hours.mov');
      await cancelled;
      expect(peaksAtCancel===undefined).toBe(true);
      expect(getProvisionalSourceWaveform()).toBeNull();
      expect(window.subtool.streamIngest).not.toHaveBeenCalled();
      expect(State.clips).toEqual([]);
      await vi.waitFor(()=>expect(deskMock.cleanupAudio).toHaveBeenCalledWith('complete.wav'));
    }finally{
      Media.reset();delete window.subtool.prepareSourceWaveform;delete window.subtool.mediaSourceKey;vi.unstubAllGlobals();
    }
  });

  it.each(['stream','ingest'])('%s 載入完整長波形時可重設專案，舊影片不接收晚到 peaks',async mode=>{
    const duration=600,bytes=sourceWave(duration);
    deskMock.probe.mockResolvedValueOnce({duration,video:{codec:'prores',fps:25},audio:[{channels:6}]});
    const result={streamUrl:'file:///C:/cache/proxy.mp4',cached:true,proxy:'C:/cache/proxy.mp4',channels:[],wave:'long-wave.wav'};
    if(mode==='stream')window.subtool.streamIngest=vi.fn(async()=>result);
    else deskMock.ingest.mockResolvedValueOnce(result);
    const cancelled=deferred();let primary,peaksAtCancel;
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>{
      setTimeout(()=>{
        primary=State.clips[0];peaksAtCancel=primary?.peaks;
        Media.reset();setStatus('新專案','ok');cancelled.resolve();
      },0);
      return bytes;
    }})));
    const decode=vi.spyOn(Wave,'calcFromWavAsync');
    try{
      const loading=Media.loadDesktopMedia('C:/media/long.mov');
      await cancelled.promise;await decode.mock.results[0].value;await loading;
      expect(primary?.path).toBe('C:/media/long.mov');
      expect(peaksAtCancel==null).toBe(true);
      expect(setStatus).toHaveBeenLastCalledWith('新專案','ok');
      expect(primary.peaks==null).toBe(true);
      expect(State.clips).toEqual([]);
    }finally{decode.mockRestore();Media.reset();vi.unstubAllGlobals();}
  });

  it('專案重連串流等 metadata 時失權，釋放自己的 lease 和未交接影片',async()=>{
    const {ProjectLoadSession}=await import('../src/project-intake-engine.js');
    const session=new ProjectLoadSession({media:Media}),generation=session.begin();
    const plan=session.createRestorePlan(generation,{mediaRelink:true,clips:[{primary:true,path:'C:/media/A.mov',dur:12,in:0,out:12,offset:0}]});
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'prores',fps:25},audio:[]});
    window.subtool.streamIngest=vi.fn(async()=>({streamUrl:'http://127.0.0.1:8080/old',streamLeaseId:'old-lease',cached:true,channels:[]}));
    domMock.video.readyState=0;
    const loading=session.restoreMedia(generation,{kind:'load',path:'C:/media/A.mov'});
    await vi.waitFor(()=>expect(typeof domMock.video.onloadedmetadata).toBe('function'));
    session.begin({preserveMaterial:true});domMock.video.onloadedmetadata();await loading;
    expect(deskMock.releaseStream).toHaveBeenCalledExactlyOnceWith('old-lease');
    expect(domMock.video.src).toBe('');expect(State.clips).toEqual([]);
    expect(plan.needsMediaRelink()).toBe(true);
  });

  it('舊串流的延遲 metadata 收尾不釋放或卸載已交接的新串流',async()=>{
    const {ProjectLoadSession}=await import('../src/project-intake-engine.js');
    const session=new ProjectLoadSession({media:Media}),generation=session.begin();
    session.createRestorePlan(generation,{mediaRelink:true,clips:[{primary:true,path:'C:/media/A.mov',dur:12,in:0,out:12,offset:0}]});
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:'prores',fps:25},audio:[]});
    window.subtool.streamIngest=vi.fn(async({path})=>path.endsWith('A.mov')
      ?{streamUrl:'http://127.0.0.1:8080/old',streamLeaseId:'old-lease',cached:true,channels:[]}
      :{streamUrl:'http://127.0.0.1:8080/new',streamLeaseId:'new-lease',cached:true,channels:[]});
    domMock.video.readyState=0;
    const old=session.restoreMedia(generation,{kind:'load',path:'C:/media/A.mov'});
    await vi.waitFor(()=>expect(typeof domMock.video.onloadedmetadata).toBe('function'));
    const oldMetadata=domMock.video.onloadedmetadata;
    session.begin({preserveMaterial:true});domMock.video.readyState=1;
    await Media.loadDesktopMedia('C:/media/B.mov');oldMetadata();await old;
    expect(deskMock.releaseStream).toHaveBeenCalledExactlyOnceWith('old-lease');
    expect(domMock.video.src).toBe('http://127.0.0.1:8080/new');
    expect(State.clips[0]).toMatchObject({path:'C:/media/B.mov'});
  });

  it('一般 ingest Proxy 的 metadata 較短時保留母素材片長', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 6, channelLayout: '5.1' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [] });
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/multichannel.webm');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it('切到另一段原生影片時不讓較短 metadata 覆寫其已探測片長', async () => {
    const info = {
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [],
    };
    deskMock.probe.mockResolvedValueOnce(info).mockResolvedValueOnce(info);
    await Media.loadDesktopMedia('C:/media/first.webm');
    const second = await Media.addClipDesktop('C:/media/second.webm');
    domMock.video.duration = 30;

    await Media._ensureClip(second, 0, false);

    expect(second.dur).toBe(120);
    expect(second.out).toBe(120);
  });

  it('一般 ingest 音訊 metadata 失敗時保留影片並顯示錯誤', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 6, channelLayout: '5.1' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [{ file: 'C:/cache/bad.wav' }] });
    const audio = vi.spyOn(Media._intakeSession, 'materializeAudioElements')
      .mockRejectedValueOnce(new Error('metadata 讀取失敗'));

    try {
      await Media.loadDesktopMedia('C:/media/audio-error.webm');
      expect(State.clips[0].path).toBe('C:/media/audio-error.webm');
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('metadata 讀取失敗'));
      expect(setStatus).toHaveBeenLastCalledWith('影片已載入，但音訊預覽載入失敗', 'err');
    } finally {
      audio.mockRestore();
    }
  });

  it.each([
    {name:'trimmed',offset:0,speed:1,cueEnd:0,audioEnd:0,expected:2},
    {name:'offset and speed',offset:3,speed:2,cueEnd:0,audioEnd:0,expected:4},
    {name:'subtitle tail',offset:0,speed:2,cueEnd:7,audioEnd:0,expected:7},
    {name:'external audio tail',offset:0,speed:2,cueEnd:0,audioEnd:8,expected:8},
    {name:'trim during analysis',offset:3,speed:2,cueEnd:0,audioEnd:0,expected:4,editDuringLoad:true},
  ])('native waveform metadata preserves the $name timeline duration',async({offset,speed,cueEnd,audioEnd,expected,editDuringLoad})=>{
    const {AudioEngine}=await import('../src/audio-engine.js');
    const {Seq}=await import('../src/sequence.js');
    const {ProjectRestorePlan}=await import('../src/project-intake-engine.js');
    const pcm={duration:12,length:1200,sampleRate:100,numberOfChannels:2,getChannelData:()=>new Float32Array(1200)};
    const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue(pcm);
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({arrayBuffer:async()=>new ArrayBuffer(8)});
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'h264',fps:25,width:1920,height:1080},audio:[{channels:2}]});
    deskMock.ingest.mockResolvedValueOnce({channels:[]});
    State.cues=cueEnd?[{id:'tail',start:0,end:cueEnd,text:'tail',timed:true}]:[];
    const plan=new ProjectRestorePlan({clips:[{name:'trimmed.mov',path:'C:/media/trimmed.mov',primary:true,
      audioSourceId:'trimmed-source',in:editDuringLoad?0:2,out:editDuringLoad?12:4,
      offset:editDuringLoad?0:offset,speed:editDuringLoad?1:speed}]});
    const waveform=deferred();deskMock.waveAudio.mockReturnValueOnce(waveform.promise);
    try{
      const loading=Media.loadDesktopMedia('C:/media/trimmed.mov',plan);
      await vi.waitFor(()=>expect(deskMock.waveAudio).toHaveBeenCalled());
      if(editDuringLoad){Object.assign(Seq.primary(),{in:2,out:4,offset,speed});Seq.recomputeDuration();}
      if(audioEnd)Media.createExternalAudioSource({name:'tail',path:'C:/tail.wav',duration:audioEnd,in:0,out:audioEnd});
      waveform.resolve('C:/cache/wave.wav');await loading;await Media.waitForPendingProjectRestore();
      expect(Seq.primary()).toMatchObject({in:2,out:4,offset,speed,dur:12});
      expect(State.duration).toBe(expected);
    }finally{decode.mockRestore();fetch.mockRestore();}
  });

  it.each(['URL','read','decode'])('原生波形 %s 失敗仍釋放本次暫存 WAV，保留已載入影片',async failure=>{
    const {AudioEngine}=await import('../src/audio-engine.js');
    const wavePath='C:/cache/generated-wave.wav';
    const resolveURL=deskMock.fileURL.getMockImplementation();
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'vp9',fps:25,width:1920,height:1080},audio:[{channels:2}]});
    deskMock.ingest.mockResolvedValueOnce({channels:[]});
    deskMock.waveAudio.mockResolvedValueOnce(wavePath);
    deskMock.fileURL.mockImplementation(path=>path===wavePath&&failure==='URL'?Promise.reject(new Error('wave URL unavailable')):resolveURL(path));
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
      if(failure==='read')throw new Error('wave read failed');
      return {arrayBuffer:async()=>new ArrayBuffer(8)};
    });
    const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockRejectedValue(new Error('invalid wave data'));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      await Media.loadDesktopMedia('C:/media/native.webm');
      expect(State.clips).toHaveLength(1);
      expect(State.clips[0].path).toBe('C:/media/native.webm');
      expect(deskMock.cleanupAudio).toHaveBeenCalledExactlyOnceWith(wavePath);
    }finally{deskMock.fileURL.mockImplementation(resolveURL);fetch.mockRestore();decode.mockRestore();warn.mockRestore();}
  });

  it.each(['success','reset','cleanup-failure'])('原生波形 %s 恰好釋放一次暫存檔，清理拒絕不變成未處理錯誤',async outcome=>{
    const {AudioEngine}=await import('../src/audio-engine.js');
    const wavePath='C:/cache/generated-wave.wav',wave=deferred();
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'vp9',fps:25,width:1920,height:1080},audio:[{channels:2}]});
    deskMock.ingest.mockResolvedValueOnce({channels:[]});deskMock.waveAudio.mockReturnValueOnce(wave.promise);
    if(outcome==='cleanup-failure')deskMock.cleanupAudio.mockRejectedValueOnce(new Error('cleanup IPC unavailable'));
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({arrayBuffer:async()=>new ArrayBuffer(8)});
    const decode=vi.spyOn(AudioEngine,'decodeAudioData').mockResolvedValue({duration:12,length:1200,sampleRate:100,numberOfChannels:1,
      getChannelData:()=>new Float32Array(1200).fill(.5)});
    try{
      const loading=Media.loadDesktopMedia('C:/media/native.webm');
      await vi.waitFor(()=>expect(deskMock.waveAudio).toHaveBeenCalledOnce());
      if(outcome==='reset'){ Media.reset(); setStatus('新專案','ok'); }
      wave.resolve(wavePath);await loading;
      expect(deskMock.cleanupAudio).toHaveBeenCalledExactlyOnceWith(wavePath);
      if(outcome==='reset'){
        expect(State.clips).toEqual([]);expect(decode).not.toHaveBeenCalled();
        expect(setStatus).toHaveBeenLastCalledWith('新專案','ok');
      }else{
        expect(State.clips[0].peaks.some(value=>value!==0)).toBe(true);
        expect(setStatus).toHaveBeenLastCalledWith('媒體已載入（原生直讀，免轉 Proxy）','ok');
      }
    }finally{fetch.mockRestore();decode.mockRestore();}
  });

  it.each(['URL','metadata','deferred metadata','stale'])('mpv background audio %s rejection is owned and settled',async failure=>{
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({duration:12,sourceSessionId:'background-session'})),
      present:vi.fn(async time=>({backend:'mpv',presentedSourceTime:time})),
      quit:vi.fn(async()=>{}),onEvent:vi.fn(),setBounds:vi.fn(async()=>{})};
    window.subtool.mpv=mpv;resetPlayerAdapter(window.subtool);
    const deferredStart=failure==='deferred metadata';
    if(deferredStart){
      deskMock.stat.mockResolvedValueOnce({exists:true,size:9*1024**3});
      deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'hq_hqa',fps:25,width:1920,height:1080},audio:[{channels:2}]});
    }
    deskMock.ingest.mockResolvedValueOnce({channels:[{file:'C:/cache/bad.wav'}]});
    const failed=deferred();
    const materialize=failure==='URL'?null:vi.spyOn(Media._intakeSession,'materializeAudioElements').mockImplementationOnce(()=>failed.promise);
    if(failure==='URL')deskMock.fileURL.mockRejectedValueOnce(new Error('cache URL unavailable'));
    try{
      await Media.loadDesktopMedia(deferredStart?'C:/media/background.avi':'C:/media/background.mxf');
      if(deferredStart){
        expect(deskMock.ingest).not.toHaveBeenCalled();
        await expect(Media.requestPresentation(0)).resolves.toMatchObject({status:'presented'});
      }
      if(failure!=='URL'){
        await vi.waitFor(()=>expect(materialize).toHaveBeenCalledOnce());
        if(failure==='stale'){
          Media.reset();State.mediaName='new project';setStatus('new project ready','ok');
          Media.pendingChannels=[{label:'new source',ready:false}];
        }
        failed.reject(new Error('metadata unavailable'));
      }
      if(failure==='stale'){
        await new Promise(resolve=>setTimeout(resolve,25));
        expect(Media.pendingChannels).toEqual([{label:'new source',ready:false}]);
        expect(setStatus).toHaveBeenLastCalledWith('new project ready','ok');
        expect(showToast).not.toHaveBeenCalled();
      }else{
        await vi.waitFor(()=>expect(setStatus).toHaveBeenLastCalledWith('影片已載入，但音訊預覽載入失敗','err'));
        expect(Media.pendingChannels).toEqual([]);expect(State.clips).toHaveLength(1);
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining(failure==='URL'?'cache URL unavailable':'metadata unavailable'));
      }
    }finally{
      materialize?.mockRestore();Media.reset();delete window.subtool.mpv;resetPlayerAdapter(window.subtool);
      deskMock.fileURL.mockImplementation(path=>Promise.resolve(`file:///${String(path).replaceAll('\\','/')}`));
    }
  });

  it('邊轉邊播音訊 metadata 失敗時顯示錯誤', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    window.subtool.streamIngest = vi.fn(async () => ({
      streamUrl: 'file:///C:/cache/growing-proxy.mp4', cached: true,
      channels: [{ file: 'C:/cache/bad.wav' }],
    }));
    const audio = vi.spyOn(Media._intakeSession, 'materializeAudioElements')
      .mockRejectedValueOnce(new Error('metadata 讀取失敗'));

    try {
      await Media.loadDesktopMedia('C:/media/audio-error.mov');
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith(
        '影片已載入，但音訊預覽載入失敗', 'err'));
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('metadata 讀取失敗'));
    } finally {
      audio.mockRestore();
    }
  });

  it('discarding A after B starts prevents late ingest results from replacing B', async () => {
    const loadA = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/A.mp4')).toBe(true));

    const loadB = Media.loadDesktopMedia('C:/media/B.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/B.mp4')).toBe(true));

    pending.get('C:/media/B.mp4').resolve({ channels: [] });
    await loadB;
    pending.get('C:/media/A.mp4').resolve({ channels: [] });
    await loadA;

    expect(State.mediaPath).toBe('C:/media/B.mp4');
    expect(domMock.video.src).toBe('file:///C:/media/B.mp4');
    expect(State.clips).toHaveLength(1);
    expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mp4', primary: true });
  });

  it('Proxy cancel revokes the actual background caller and preserves the loaded mother clip',async()=>{
    const primary=Media._registerPrimary({name:'A.mxf',path:'C:/media/A.mxf',dur:12,audioSourceId:'source-a'});
    Media.pendingChannels=[{label:'pending',ready:false}];
    const work=Media._bgAudioIngest(primary.path,[{channels:1}],12,primary);
    const request=deskMock.ingest.mock.calls.at(-1)[0];
    expect(request).toMatchObject({sessionId:expect.any(String),requestId:expect.any(String)});
    expect(await Media.cancelProxyJobs()).toBe(true);
    await work;
    expect(deskMock.cancelMediaIntake).toHaveBeenCalledWith({sessionId:request.sessionId});
    expect(State.clips).toContain(primary);
    expect(Media.pendingChannels).toEqual([]);
    pending.get(primary.path).resolve({proxy:'stale.mp4',channels:[{file:'stale.wav'}]});
    await Promise.resolve();await Promise.resolve();
    expect(Media.tracks).toEqual([]);
    expect(deskMock.fileURL).not.toHaveBeenCalledWith('stale.mp4');
    expect(showToast).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith('已取消 Proxy 與音訊背景處理','ok');
  });

  it('取消背景 Proxy 保留已提交 mpv 的時間回報，reset 後才撤銷該 transport',async()=>{
    const callbacks=[];
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({duration:12,sourceSessionId:'mother-session'})),
      pause:vi.fn(async()=>{}),play:vi.fn(async()=>{}),mute:vi.fn(async()=>{}),quit:vi.fn(async()=>{}),
      onEvent:vi.fn(callback=>callbacks.push(callback)),setBounds:vi.fn(async()=>{})};
    window.subtool.mpv=mpv;resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'prores',fps:25,width:1920,height:1080},audio:[{channels:1}]});
    try{
      await Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(()=>expect(pending.has('C:/media/A.mov')).toBe(true));
      expect(callbacks).toHaveLength(1);
      Media.playing=true;
      callbacks[0]({event:'property-change',name:'time-pos',data:2,sourceSessionId:'mother-session'});
      expect(Media.displayTime()).toBe(2);
      await expect(Media.cancelProxyJobs()).resolves.toBe(true);
      callbacks[0]({event:'property-change',name:'time-pos',data:3,sourceSessionId:'mother-session'});
      expect(Media.displayTime()).toBe(3);
      expect(State.clips[0].path).toBe('C:/media/A.mov');
      expect(Media.pendingChannels).toEqual([]);
      Media.reset();State.duration=0;
      callbacks[0]({event:'property-change',name:'duration',data:99,sourceSessionId:'mother-session'});
      expect(State.duration).toBe(0);
      pending.get('C:/media/A.mov').resolve({proxy:'stale.mp4',channels:[{file:'stale.wav'}]});
      await Promise.resolve();await Promise.resolve();
      expect(Media.tracks).toEqual([]);
      expect(deskMock.fileURL).not.toHaveBeenCalledWith('stale.mp4');
    }finally{Media.reset();delete window.subtool.mpv;resetPlayerAdapter(window.subtool);}
  });

  it('switching projects cancels old native work and starts the next intake without waiting for its reply',async()=>{
    const loadA=Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(()=>expect(pending.has('C:/media/A.mp4')).toBe(true));
    const requestA=deskMock.ingest.mock.calls.at(-1)[0];
    const loadB=Media.loadDesktopMedia('C:/media/B.mp4');
    await vi.waitFor(()=>expect(pending.has('C:/media/B.mp4')).toBe(true));
    await loadA;
    const requestB=deskMock.ingest.mock.calls.at(-1)[0];
    expect(requestB.sessionId).not.toBe(requestA.sessionId);
    expect(deskMock.cancelMediaIntake).toHaveBeenCalledWith({sessionId:requestA.sessionId});
    pending.get('C:/media/B.mp4').resolve({channels:[]});await loadB;
    pending.get('C:/media/A.mp4').resolve({channels:[]});await Promise.resolve();
    expect(State.mediaPath).toBe('C:/media/B.mp4');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('同專案首次加入影片保留已接受外音的背景快取工作',async()=>{
    const asset=Media.createExternalAudioSource({name:'voice.wav',path:'C:/media/voice.wav',duration:12,in:0,out:12,
      offset:0,audioSourceId:'voice-source',descriptors:[{sourceStream:0,sourceChannel:0}]});
    const cache=Media.cacheExternalRoutingAudio(asset,asset.path,12,[{channels:1}]);
    const request=deskMock.ingest.mock.calls.at(-1)[0];
    const loading=Media.loadDesktopMedia('C:/media/first.mp4');
    try{
      await vi.waitFor(()=>expect(pending.has('C:/media/first.mp4')).toBe(true));
      pending.get(asset.path).resolve({channels:[]});
      await expect(cache).resolves.toEqual({channels:[]});
      expect(Media.externalAudioSources).toContain(asset);
      expect(deskMock.cancelMediaIntake).not.toHaveBeenCalledWith({sessionId:request.sessionId});
    }finally{pending.get('C:/media/first.mp4')?.resolve({channels:[]});await loading;}
  });

  it('does not attach stale background channels to the new primary after proxy URL lookup', async () => {
    const proxyURL = deferred();
    deskMock.ingest.mockResolvedValueOnce({
      proxy: 'C:/cache/A-proxy.mp4',
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    deskMock.fileURL.mockImplementation(path => path === 'C:/cache/A-proxy.mp4'
      ? proxyURL.promise
      : Promise.resolve(`file:///${String(path).replaceAll('\\', '/')}`));

    const primaryA = Media._registerPrimary({
      name: 'A.mp4', path: 'C:/media/A.mp4', dur: 12, audioSourceId: 'source-a',
    });
    const stale = Media._bgAudioIngest('C:/media/A.mp4', [{ channels: 1 }], 12, primaryA);
    await vi.waitFor(() => expect(deskMock.fileURL).toHaveBeenCalledWith('C:/cache/A-proxy.mp4'));

    Media.reset();
    resetAudioProject();
    State.mediaName = 'B.mp4';
    Media._registerPrimary({
      name: 'B.mp4', path: 'C:/media/B.mp4', dur: 12, audioSourceId: 'source-b',
    });
    proxyURL.resolve('file:///C:/cache/A-proxy.mp4');
    await stale;

    expect(State.audioProject.sourceMaps['source-b']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('does not commit desktop native waveform data after the last source placement is deleted', async () => {
    const wavePath = deferred();
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 2, channelLayout: 'stereo' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [] });
    deskMock.waveAudio.mockReturnValueOnce(wavePath.promise);

    const loading = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(deskMock.waveAudio).toHaveBeenCalledTimes(1));
    const primary = State.clips[0];
    expect(Media.removeClip(primary.id)).toBe(true);
    wavePath.resolve('C:/cache/A-wave.wav');
    await loading;

    expect(Wave._sourceState(primary, false)).toBeNull();
    expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/A-wave.wav');
  });

  it('uses mpv preview for a native MP4 when frame-accurate preview is available', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect(Media.mpvMode).toBe(true);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it.each(['24','29.97df'])('mpv 重建母素材保留專案 %s 格網，clip 記錄真實來源30fps', async savedFps => {
    const { setFps }=await import('../src/state.js');
    const { ProjectRestorePlan }=await import('../src/project-intake-engine.js');
    setFps(savedFps);
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(async()=>({duration:12})),
      quit:vi.fn(async()=>{}),onEvent:vi.fn(),setBounds:vi.fn(async()=>{})};
    window.subtool.mpv=mpv;resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({duration:12,video:{codec:'h264',fps:30,width:1920,height:1080},audio:[]});
    try {
      await Media.loadDesktopMedia('C:/media/restore-fps.mp4',new ProjectRestorePlan());
      expect(Media.mpvMode).toBe(true);
      expect(State.fps).toBe(savedFps==='24'?24:29.97);
      expect(State.dropFrame).toBe(savedFps.endsWith('df'));
      expect(State.clips[0].fps).toBe(30);
    } finally {
      Media.reset();delete window.subtool.mpv;resetPlayerAdapter(window.subtool);
    }
  });

  it('maps mpv source time through the active clip and ignores stale time-pos in a gap', async () => {
    let notifyMpv = () => {};
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12, sourceSessionId: 'mapped-session' })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => { notifyMpv = callback; }),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/offset-clip.mp4');
      const clip = State.clips[0];
      Object.assign(clip, { in: 1, out: 11, offset: 10 });
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 2, sourceSessionId: 'mapped-session' });
      expect(Media.displayTime()).toBe(11);
      expect(domMock.$('tcCur').textContent).toBe('00:00:11:00');
      expect(domMock.$('seekBar').value).toBe(11000);

      Media._gap = true;
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 5, sourceSessionId: 'mapped-session' });
      expect(Media._mpvTime).toBe(2);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('大型 Canopus AVI 初次匯入只建音訊快取，加入第二支影片才補做主影片 Proxy', async () => {
    const source='C:/media/large-canopus.avi';
    let notifyMpv=()=>{};
    const mpv={
      detect:vi.fn(async()=>({available:true})),
      launch:vi.fn(async()=>({duration:7400,sourceSessionId:'canopus-session'})),
      quit:vi.fn(async()=>{}), onEvent:vi.fn(callback=>{ notifyMpv=callback; }), setBounds:vi.fn(async()=>{}),
      seek:vi.fn(async()=>{}), mute:vi.fn(async()=>{}),
    };
    window.subtool.mpv=mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.stat.mockResolvedValueOnce({exists:true,size:116_524_384_242});
    deskMock.probe.mockResolvedValueOnce({
      duration:7448.441,
      video:{codec:'hq_hqa',fps:30000/1001,width:1920,height:1080},
      audio:[{channels:2,codec:'pcm_s16le'}],
    });
    deskMock.ingest.mockImplementation(async ({path,needsProxy})=>({
      channels:[],
      ...(path===source&&needsProxy?{proxy:'C:/cache/canopus-proxy.mp4'}:{}),
    }));

    const {Seq}=await import('../src/sequence.js');
    const observedDuration=vi.spyOn(Seq,'observeSourceDuration');
    try{
      await Media.loadDesktopMedia(source);
      expect(State.duration).toBe(7448.441);
      observedDuration.mockClear();
      notifyMpv({event:'property-change',name:'duration',data:7400,sourceSessionId:'canopus-session'});
      expect(observedDuration).toHaveBeenCalledWith(State.clips[0],7448.441);
      expect(State.duration).toBe(7448.441);
      expect(State.clips[0].dur).toBe(7448.441);
      expect(deskMock.ingest).not.toHaveBeenCalled();
      Media._commitPresentedTarget(0);
      await vi.waitFor(()=>expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
        path:source,needsProxy:false,
      })));
      expect(Media.webCodecsProxyPath()).toBeNull();

      await Media.addClipDesktop('C:/media/second.mp4');
      await vi.waitFor(()=>expect(Media.webCodecsProxyPath()).toBe(source));
      expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
        path:source,needsProxy:true,
      }));
    } finally {
      observedDuration.mockRestore();
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it.each([
    ['逐格', () => stepFrame(-1), 7.96],
    ['連續滑鼠定位', () => { shuttlePause(); Media.seek(6); Media.seek(5.5); }, 5.52],
  ])('原生倒播轉%s時，播放目標立即更新，呈現等 Proxy 還原母素材', async (action, seek, target) => {
    let notifyMpv = () => {};
    let sourceSessionId='reverse-mother';
    const restore = deferred();
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12, sourceSessionId })),
      loadfile: vi.fn(async path => {
        const result=await (path === 'C:/media/long-gop.mp4'
          ? restore.promise : { ok: true, duration: 12, sourceSessionId:'reverse-proxy' });
        sourceSessionId=result.sourceSessionId;
        return result;
      }),
      seek: vi.fn(async () => {}),
      present: vi.fn(async time => ({ backend: 'mpv', presentedSourceTime: time })),
      direction: vi.fn(async () => true),
      mute: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      play: vi.fn(async () => {}),
      rate: vi.fn(async () => {}),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => { notifyMpv = event=>callback({...event,sourceSessionId}); }),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    deskMock.ingest.mockResolvedValueOnce({ proxy: 'C:/cache/short-gop-proxy.mp4', channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/long-gop.mp4');
      await vi.waitFor(() => expect(Media.reverseShuttleProxyReady()).toBe(true));
      Media._mpvTime = 8;
      shuttleRewind();
      await vi.waitFor(() => expect(Media._nativeReverse).toBe(true));
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 8 });
      mpv.loadfile.mockClear();
      mpv.present.mockClear();

      seek();
      expect(domMock.$('seekBar').value).toBe(Math.round(target * 1000));
      expect(Media.displayTime()).toBe(target);
      await vi.waitFor(() => expect(mpv.loadfile).toHaveBeenCalledWith('C:/media/long-gop.mp4'));
      expect(mpv.loadfile).toHaveBeenCalledTimes(1);
      expect(mpv.present).not.toHaveBeenCalled();

      restore.resolve({ ok: true, duration: 12, sourceSessionId:'reverse-restored' });
      await vi.waitFor(() => expect(mpv.present).toHaveBeenCalledWith(
        target, expect.objectContaining({ tolerance: expect.any(Number) }),
      ));
      await vi.waitFor(() => expect(Media._reverseProxyActive).toBe(false));
      expect(mpv.loadfile).toHaveBeenCalledTimes(1);
      expect(mpv.present).toHaveBeenCalledTimes(1);
    } finally {
      restore.resolve({ ok: true, duration: 12, sourceSessionId:'reverse-restored' });
      jklReset();
      vi.restoreAllMocks();
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('短 GOP Proxy 就緒後倒播切到 Proxy，停止時在同一來源時間切回母素材', async () => {
    let notifyMpv = () => {};
    let sourceSessionId='mother-session', sourceGeneration=0;
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12, sourceSessionId })),
      loadfile: vi.fn(async () => ({ ok: true, duration: 12, sourceSessionId:sourceSessionId=`source-${++sourceGeneration}` })),
      seek: vi.fn(async () => {}),
      direction: vi.fn(async () => true),
      mute: vi.fn(async () => {}),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => { notifyMpv = event=>callback({...event,sourceSessionId}); }),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    deskMock.ingest.mockResolvedValueOnce({ proxy: 'C:/cache/short-gop-proxy.mp4', channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/long-gop.mp4');
      await vi.waitFor(() => expect(Media.reverseShuttleProxyReady()).toBe(true));
      expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({ needsProxy: true }));

      Media._mpvTime = 8;
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(true);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(1, 'C:/cache/short-gop-proxy.mp4');
      expect(mpv.seek).toHaveBeenLastCalledWith(8, undefined);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 0 });
      expect(Media._mpvTime).toBe(8);
      expect(Media.presentedTime()).toBeNull();
      notifyMpv({ event: 'property-change', name: 'duration', data: 11 });
      expect(State.duration).toBe(12);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 8 });
      expect(Media.presentedTime()).toBe(8);

      Media._mpvTime = 7.5;
      await expect(Media.setPlaybackDirection('forward')).resolves.toBe(true);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(2, 'C:/media/long-gop.mp4');
      expect(mpv.seek).toHaveBeenLastCalledWith(7.5, undefined);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 0 });
      expect(Media._mpvTime).toBe(7.5);

      mpv.seek.mockRejectedValueOnce(new Error('seek failed'));
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(false);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(3, 'C:/cache/short-gop-proxy.mp4');
      expect(mpv.loadfile).toHaveBeenNthCalledWith(4, 'C:/media/long-gop.mp4');
      expect(Media._reverseProxyActive).toBe(false);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 7.5 });
      expect(Media.mpvSourceTransitionPending()).toBe(false);

      mpv.loadfile.mockResolvedValueOnce({ ok: false });
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(false);
      expect(Media.mpvSourceTransitionPending()).toBe(false);
      expect(Media._reverseProxyActive).toBe(false);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('uses mpv preview for a native H.265 MP4 when frame-accurate preview is available', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12, sourceSessionId:'hevc-session' })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      present: vi.fn(async time => ({ backend: 'mpv', presentedSourceTime: time })),
      direction: vi.fn(async () => true),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'hevc', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate-h265.mp4');
      await Media.seek(3.96);

      expect(Media.mpvMode).toBe(true);
      expect(mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(3.94, 8);
      expect(mpv.present.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ exact: true }));
      expect(Media.supportsNativeReverse()).toBe(false);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('restores normal mpv seeking without shortening a probed clip after source switch', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12, sourceSessionId:'primary-session' })),
      loadfile: vi.fn(async () => ({ ok: true, duration: 8, sourceSessionId:'following-session' })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      mute: vi.fn(async () => {}),
      // The real preload exposes direction acceptance and frame evidence.
      direction: vi.fn(async () => true),
      present: vi.fn(async time => ({ backend: 'mpv', presentedSourceTime: time })),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'hevc', fps: 25, width: 1920, height: 1080 },
        audio: [],
      })
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
        audio: [],
      });

    try {
      await Media.loadDesktopMedia('C:/media/primary-h265.mp4');
      const h264 = await Media.addClipDesktop('C:/media/following-h264.mp4');
      mpv.seek.mockClear();

      await expect(Media.seek(h264.offset + 3.96)).resolves.toMatchObject({
        status:'presented',presentedTime:expect.closeTo(h264.offset+3.96,8),
      });

      expect(mpv.direction).toHaveBeenLastCalledWith('forward');
      expect(mpv.seek).toHaveBeenLastCalledWith(3.96, undefined);
      expect(h264.dur).toBe(12);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('keeps a compositable source URL for frame-accurate MP4 mpv preview', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect(State.clips[0].web?.url).toBe('file:///C:/media/frame-accurate.mp4');
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('falls back to HTML5 when frame-accurate MP4 mpv preview cannot launch', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => { throw new Error('mpv pipe failed'); }),
      quit: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect({ mode: Media.mpvMode, source: domMock.video.src }).toEqual({
        mode: false,
        source: 'file:///C:/media/frame-accurate.mp4',
      });
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('專案重連的 mpv 啟動等待期間失權，回覆後關閉 native 且不交接主片段',async()=>{
    const {ProjectLoadSession}=await import('../src/project-intake-engine.js');
    const session=new ProjectLoadSession({media:Media}),generation=session.begin(),launch=deferred();
    const plan=session.createRestorePlan(generation,{mediaRelink:true,clips:[{primary:true,path:'C:/media/A.mov',dur:12,in:0,out:12,offset:0}]});
    const mpv={detect:vi.fn(async()=>({available:true})),launch:vi.fn(()=>launch.promise),quit:vi.fn(async()=>{}),onEvent:vi.fn(),setBounds:vi.fn(async()=>{})};
    window.subtool.mpv=mpv;resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValue({duration:12,video:{codec:'prores',fps:25,width:1920,height:1080},audio:[]});
    try{
      const loading=session.restoreMedia(generation,{kind:'load',path:'C:/media/A.mov'});
      await vi.waitFor(()=>expect(mpv.launch).toHaveBeenCalledOnce());
      session.begin({preserveMaterial:true});launch.resolve({duration:12});await loading;
      expect(mpv.quit).toHaveBeenCalledOnce();expect(State.clips).toEqual([]);
      expect(plan.needsMediaRelink()).toBe(true);expect(session.activePlan.needsMediaRelink()).toBe(true);
    }finally{Media.reset();delete window.subtool.mpv;resetPlayerAdapter(window.subtool);}
  });

  it('serializes overlapping mpv launches and cleans the stale native runtime before B starts', async () => {
    const launches = new Map();
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(({ src }) => {
        const work = deferred();
        launches.set(src, work);
        return work.promise;
      }),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValue({
      duration: 12,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      const loadA = Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(() => expect(launches.has('C:/media/A.mov')).toBe(true));
      const loadB = Media.loadDesktopMedia('C:/media/B.mov');
      await Promise.resolve();
      expect(mpv.launch).toHaveBeenCalledTimes(1);

      // 主程序可能已建立 native window/process，卻在 pipe 連線階段失敗。
      launches.get('C:/media/A.mov').reject(new Error('mpv pipe failed'));
      await vi.waitFor(() => expect(launches.has('C:/media/B.mov')).toBe(true));
      const staleRuntimeWasCleaned = mpv.quit.mock.calls.length === 1;
      launches.get('C:/media/B.mov').resolve({ duration: 12 });
      await Promise.all([loadA, loadB]);

      expect(staleRuntimeWasCleaned).toBe(true);
      expect(State.mediaPath).toBe('C:/media/B.mov');
      expect(State.clips).toHaveLength(1);
      expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mov', primary: true });
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('ignores late events from an mpv intake after a newer HTML media load owns the timeline', async () => {
    const callbacks = [];
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => callbacks.push(callback)),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
        audio: [],
      })
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
        audio: [{ channels: 6, channelLayout: '5.1' }],
      });
    deskMock.ingest.mockResolvedValue({ channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/A.mov');
      expect(callbacks).toHaveLength(1);
      await Media.loadDesktopMedia('C:/media/B.mp4');
      const current = State.clips[0];

      callbacks[0]({ event: 'property-change', name: 'duration', data: 99 });

      expect(State.mediaPath).toBe('C:/media/B.mp4');
      expect(current).toMatchObject({ path: 'C:/media/B.mp4', dur: 12, out: 12 });
      expect(State.duration).toBe(12);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });
});

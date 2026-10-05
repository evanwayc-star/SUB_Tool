import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({state:{clips:[],audioProject:{sourceMaps:{}}},media:{externalAudioSources:[],tracks:[]},
  desktop:{vocalWaveChunk:vi.fn(),cancelVocalWaveChunk:vi.fn(),vocalWaveFingerprint:vi.fn()},analyze:vi.fn(),
  cache:{read:vi.fn(),write:vi.fn(),select:vi.fn(),rememberPreference:vi.fn()}}));
vi.mock('../src/state.js',()=>({State:mocks.state,DESK:mocks.desktop}));
vi.mock('../src/media.js',()=>({Media:mocks.media}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{decodeAudioData:vi.fn()}}));
vi.mock('../src/vocal-waveform-worker-client.js',()=>({vocalWaveformClient:{analyze:mocks.analyze},vocalAbortError:()=>new DOMException('cancelled','AbortError')}));
vi.mock('../src/vocal-waveform-cache.js',async importOriginal=>({...await importOriginal(),vocalWaveformCache:mocks.cache}));
import { analyzeSourceVocals, resolveVocalSource, restoreCachedSourceVocals, rememberSourceVocalSelection } from '../src/vocal-waveform-source.js';
const source={id:'clip',audioSourceId:'audio',audioSrc:'video',_originalPath:'mother.mkv',path:'processed.wav',dur:40,in:10,out:12,offset:4};
const pcm=(frames,value=1)=>({samples:new Float32Array(frames*2).fill(value).buffer,sampleRate:44100,channels:2});
const nativeRead=mocks.desktop.vocalWaveChunk;
const nativeFingerprint=mocks.desktop.vocalWaveFingerprint;
beforeEach(()=>{
  vi.resetAllMocks();mocks.desktop.vocalWaveChunk=nativeRead;mocks.desktop.vocalWaveFingerprint=nativeFingerprint;mocks.state.clips=[{...source}];mocks.state.audioProject.sourceMaps={};mocks.media.externalAudioSources=[];mocks.media.tracks=[];
  mocks.desktop.cancelVocalWaveChunk.mockResolvedValue(true);
  mocks.cache.read.mockResolvedValue(null);mocks.cache.write.mockResolvedValue(true);mocks.cache.select.mockResolvedValue(true);
});
afterEach(()=>vi.unstubAllGlobals());

it('以活躍來源 ID 解析重新建立的片段；只讀母素材完整時長，不讀效果檔或播放區間',async()=>{
  expect(resolveVocalSource(source)).toBe(mocks.state.clips[0]);
  mocks.desktop.vocalWaveChunk.mockResolvedValue(pcm(44100));
  mocks.analyze.mockImplementation(async ({duration,readChunk})=>{
    expect(duration).toBe(40);await readChunk({start:0,duration:1});return new Float32Array(8000);
  });
  await analyzeSourceVocals('audio');
  expect(mocks.desktop.vocalWaveChunk).toHaveBeenCalledWith(expect.objectContaining({path:'mother.mkv',start:0,duration:1,sourceStream:0}));
  expect(mocks.desktop.vocalWaveChunk.mock.calls[0][0].requestId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
});

it('多串流從來源 descriptors 混合，不以 project bus 或輸出編組猜 stream',async()=>{
  mocks.state.audioProject.sourceMaps.audio={channels:[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0},{sourceStream:1,sourceChannel:1}]};
  mocks.desktop.vocalWaveChunk.mockImplementation(async ({sourceStream})=>pcm(441,sourceStream?0.6:0.2));
  mocks.analyze.mockImplementation(async ({readChunk})=>{
    const [left,right]=await readChunk({start:0,duration:.01});
    expect(left[0]).toBeCloseTo(.4);expect(right[0]).toBeCloseTo(.4);return new Float32Array(8000);
  });
  await analyzeSourceVocals('video');
  expect(mocks.desktop.vocalWaveChunk.mock.calls.map(([request])=>request.sourceStream)).toEqual([0,1]);
});

it('合法短音訊／已超過音訊尾端補零，不改來源時長與時間位置',async()=>{
  mocks.desktop.vocalWaveChunk.mockResolvedValueOnce(pcm(44100,.2)).mockResolvedValueOnce(pcm(0));
  mocks.analyze.mockImplementation(async ({readChunk})=>{
    const [first]=await readChunk({start:0,duration:4});
    expect(first).toHaveLength(4*44100);expect(first[0]).toBeCloseTo(.2);expect(first[44100]).toBe(0);
    const [tail]=await readChunk({start:10,duration:1});expect(tail.every(value=>value===0)).toBe(true);
    return new Float32Array(8000);
  });
  await analyzeSourceVocals('audio');
});

it('取消會指定本次 request id 終止 native；來源換檔後晚到 PCM 拒絕提交',async()=>{
  let done;const controller=new AbortController();
  mocks.desktop.vocalWaveChunk.mockImplementation(()=>new Promise(resolve=>{done=resolve;}));
  mocks.analyze.mockImplementation(async ({readChunk})=>{await readChunk({start:0,duration:1});return new Float32Array(8000);});
  const promise=analyzeSourceVocals('audio',{signal:controller.signal});
  const rejected=expect(promise).rejects.toMatchObject({name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();done(pcm(44100));await rejected;
  expect(mocks.desktop.cancelVocalWaveChunk).toHaveBeenCalledWith(mocks.desktop.vocalWaveChunk.mock.calls[0][0].requestId);
  const replaced=analyzeSourceVocals('audio');const rejectedReplacement=expect(replaced).rejects.toMatchObject({name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,0));
  mocks.state.clips[0]._originalPath='different.mkv';done(pcm(44100));await rejectedReplacement;
});

it('同母素材切割的兩個來源共用分離工作，取消一個不取消仍顯示人聲的另一個',async()=>{
  mocks.state.clips.push({...source,id:'split',audioSourceId:'split-audio',audioSrc:'split-runtime'});
  const first=new AbortController(),second=new AbortController();let done;
  mocks.analyze.mockImplementation(()=>new Promise(resolve=>{done=resolve;}));
  const a=analyzeSourceVocals('audio',{signal:first.signal});
  const b=analyzeSourceVocals('split-audio',{signal:second.signal});
  const rejected=expect(a).rejects.toMatchObject({name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(mocks.analyze).toHaveBeenCalledTimes(1);
  first.abort();await rejected;
  expect(mocks.analyze.mock.calls[0][0].signal.aborted).toBe(false);
  const peaks=new Float32Array(8000);done(peaks);expect(await b).toBe(peaks);
});

it('瀏覽器保留第二 stream 的原音，不把效果音訊或重複 buffer 混入分析',async()=>{
  mocks.desktop.vocalWaveChunk=null;
  mocks.state.clips[0].dur=1;
  mocks.state.clips[0].descriptors=[{sourceStream:0},{sourceStream:1}];
  const music={value:.2},voice={value:.6};
  mocks.media.tracks=[{audioSourceId:'audio',sourceStream:0,buffer:music},
    {audioSourceId:'audio',sourceStream:1,buffer:voice},{audioSourceId:'audio',sourceStream:1,buffer:voice},
    {audioSourceId:'audio',sourceStream:0,buffer:{value:9},_audioEffect:true}];
  vi.stubGlobal('OfflineAudioContext',class{
    constructor(_channels,length){this.length=length;this.nodes=[];this.destination={};}
    createGain(){return {gain:{value:1},connect(){}};}
    createBufferSource(){const node={buffer:null,gain:null,connect(gain){this.gain=gain;},start(){}};this.nodes.push(node);return node;}
    async startRendering(){const sum=this.nodes.reduce((total,node)=>total+node.buffer.value*node.gain.gain.value,0);return {getChannelData:()=>new Float32Array(this.length).fill(sum)};}
  });
  mocks.analyze.mockImplementation(async ({readChunk})=>{
    const [left]=await readChunk({start:0,duration:1});expect(left[0]).toBeCloseTo(.4);return new Float32Array(200);
  });
  await analyzeSourceVocals('audio');
});

it('完成後以可信母素材、模型、時長與來源 streams 記錄完整峰值，關閉重建可只讀恢復',async()=>{
  const fingerprint='a'.repeat(64),peaks=new Float32Array(8000);
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue(fingerprint);
  mocks.analyze.mockResolvedValue(peaks);
  const records=new Map();
  mocks.cache.write.mockImplementation(async(descriptor,_duration,result)=>{records.set(descriptor,{peaks:result,selected:false});return true;});
  mocks.cache.read.mockImplementation(async(descriptor,_duration,{selectedOnly=false}={})=>{
    const item=records.get(descriptor);return item&&(!selectedOnly||item.selected)?item.peaks:null;
  });
  mocks.cache.select.mockImplementation(async(descriptor,selected)=>{records.get(descriptor).selected=selected;return true;});
  expect(await analyzeSourceVocals('audio')).toBe(peaks);
  expect(mocks.cache.write).toHaveBeenCalledWith(expect.stringContaining(fingerprint),40,peaks);
  expect(await rememberSourceVocalSelection('audio',true)).toBe(true);
  mocks.state.clips=[{...source,id:'reopened',audioSourceId:'new-audio',audioSrc:'new-runtime'}];
  expect(await restoreCachedSourceVocals('new-audio')).toBe(peaks);
  expect(mocks.analyze).toHaveBeenCalledTimes(1);
  await rememberSourceVocalSelection('new-audio',false);
  expect(await restoreCachedSourceVocals('new-audio')).toBeNull();
});

it('明確切換人聲命中快取直接回峰值，不啟動模型／PCM並回報快取來源',async()=>{
  const peaks=new Float32Array(8000),onProgress=vi.fn();
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue('b'.repeat(64));mocks.cache.read.mockResolvedValue(peaks);
  expect(await analyzeSourceVocals('audio',{onProgress})).toBe(peaks);
  expect(mocks.analyze).not.toHaveBeenCalled();expect(mocks.desktop.vocalWaveChunk).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith({percent:100,label:'已載入人聲快取'});
});

it('恢復查詢對尚未登錄的素材回 undefined，未選人聲或缺失cache回 null且不分析',async()=>{
  expect(await restoreCachedSourceVocals('not-loaded')).toBeUndefined();
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue('c'.repeat(64));
  expect(await restoreCachedSourceVocals('audio')).toBeNull();
  expect(mocks.analyze).not.toHaveBeenCalled();expect(mocks.desktop.vocalWaveChunk).not.toHaveBeenCalled();
});

it('改時長、來源 streams 或母素材內容會使用不同 cache 指紋',async()=>{
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue('d'.repeat(64));
  await restoreCachedSourceVocals('audio');
  mocks.state.clips[0].dur=41;await restoreCachedSourceVocals('audio');
  mocks.state.clips[0].descriptors=[{sourceStream:1}];await restoreCachedSourceVocals('audio');
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue('e'.repeat(64));await restoreCachedSourceVocals('audio');
  expect(new Set(mocks.cache.read.mock.calls.map(([descriptor])=>descriptor)).size).toBe(4);
  expect(mocks.analyze).not.toHaveBeenCalled();
});

it('分析期間原地換檔不能寫入先前指紋，也不提交混合舊新素材的結果',async()=>{
  mocks.desktop.vocalWaveFingerprint.mockResolvedValueOnce('f'.repeat(64)).mockResolvedValueOnce('a'.repeat(64));
  mocks.analyze.mockResolvedValue(new Float32Array(8000));
  await expect(analyzeSourceVocals('audio')).rejects.toThrow(/母素材在分析期間變更/);
  expect(mocks.cache.write).not.toHaveBeenCalled();
});

it('取消指紋查詢立即放棄待分析工作，不等待遲到 native 讀取也不保存',async()=>{
  let complete;const controller=new AbortController();
  mocks.desktop.vocalWaveFingerprint.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const pending=analyzeSourceVocals('audio',{signal:controller.signal});
  const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await rejected;
  complete('a'.repeat(64));await new Promise(resolve=>setTimeout(resolve,0));
  expect(mocks.analyze).not.toHaveBeenCalled();expect(mocks.cache.write).not.toHaveBeenCalled();
});

it('記憶偏好以最後呼叫為準，晚到人聲偏好不能蓋掉已切回原音的選擇',async()=>{
  let complete;
  mocks.desktop.vocalWaveFingerprint.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}))
    .mockResolvedValue('a'.repeat(64));
  const stale=rememberSourceVocalSelection('audio',true);
  expect(await rememberSourceVocalSelection('audio',false)).toBe(true);
  complete('a'.repeat(64));expect(await stale).toBe(false);
  expect(mocks.cache.select).toHaveBeenCalledTimes(1);
  expect(mocks.cache.select.mock.calls[0][1]).toBe(false);
});

it('restore仍在讀指紋時明確選原音，偏好在呼叫同步寫入，立即關閉不等native或IDB',async()=>{
  let complete;
  mocks.desktop.vocalWaveFingerprint.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const pending=rememberSourceVocalSelection('audio',false);
  expect(mocks.cache.rememberPreference).toHaveBeenCalledWith(JSON.stringify(['desktop','mother.mkv',40,[0]]),false);
  expect(mocks.cache.select).not.toHaveBeenCalled();
  // Simulate closing the project before the file read completes.
  mocks.state.clips=[];complete('a'.repeat(64));expect(await pending).toBe(false);
  expect(mocks.cache.select).not.toHaveBeenCalled();
});

it('Windows不同大小寫mother path共用同步偏好key，browser偏好不用runtimeID或blob URL',async()=>{
  mocks.state.clips[0]._originalPath='C:\\Media\\MOTHER.mkv';
  mocks.desktop.vocalWaveFingerprint.mockResolvedValue('a'.repeat(64));
  await rememberSourceVocalSelection('audio',false);const key=mocks.cache.rememberPreference.mock.calls.at(-1)[0];
  mocks.state.clips[0]._originalPath='c:/media/mother.mkv';
  await rememberSourceVocalSelection('audio',true);expect(mocks.cache.rememberPreference.mock.calls.at(-1)[0]).toBe(key);
  mocks.desktop.vocalWaveChunk=null;mocks.desktop.vocalWaveFingerprint=null;
  mocks.state.clips[0]._file={name:'voice.wav',size:2,lastModified:123,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};
  await rememberSourceVocalSelection('audio',false);
  expect(mocks.cache.rememberPreference.mock.calls.at(-1)[0]).toBe(JSON.stringify(['browser','voice.wav',2,123,40,[0]]));
});

it('指紋不可用時仍可正常分離但不持久化；瀏覽器 File 以完整內容辨識',async()=>{
  mocks.desktop.vocalWaveFingerprint.mockRejectedValue(new Error('offline share'));
  mocks.analyze.mockResolvedValue(new Float32Array(8000));
  await analyzeSourceVocals('audio');expect(mocks.cache.write).not.toHaveBeenCalled();
  mocks.desktop.vocalWaveChunk=null;mocks.desktop.vocalWaveFingerprint=null;
  mocks.state.clips[0]._file={size:2,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};
  await restoreCachedSourceVocals('audio');const first=mocks.cache.read.mock.calls.at(-1)[0];
  mocks.state.clips[0]._file={size:2,arrayBuffer:async()=>new Uint8Array([1,3]).buffer};
  await restoreCachedSourceVocals('audio');expect(mocks.cache.read.mock.calls.at(-1)[0]).not.toBe(first);
});

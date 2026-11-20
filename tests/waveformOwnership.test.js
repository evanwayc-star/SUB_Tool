import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({ fileURL: vi.fn() }));
vi.mock('../src/state.js', () => ({ State: { audioProject: { sourceMaps: {} } }, DESK: desktop }));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/util.js', () => ({ readFile: vi.fn() }));
vi.mock('../src/audio-engine.js', () => ({ AudioEngine: { isReady: true } }));
vi.mock('../src/audio-routing-engine.js', () => ({ AudioPipeline: {} }));
vi.mock('../src/media.js', () => ({ Media: { tracks: [], activeSource: null } }));
vi.mock('../src/dom.js', () => ({ $: vi.fn(), video: {} }));
vi.mock('../src/ui.js', () => ({renderCurrentTimecode:vi.fn(), setStatus: vi.fn() }));

import { Wave } from '../src/waveform-decoder.js';
import { State } from '../src/state.js';
import { Media } from '../src/media.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function sourcePcm(seconds=600){
  const frames=seconds*4000,buffer=new ArrayBuffer(44+frames*2),view=new DataView(buffer);
  for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
    for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));
  view.setUint32(4,buffer.byteLength-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,1,true);view.setUint32(24,4000,true);view.setUint32(28,8000,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,frames*2,true);
  new Int16Array(buffer,44).fill(8192);return buffer;
}

// FFmpeg writes WAVE_FORMAT_EXTENSIBLE for multichannel PCM. The last channel
// has a signal across the whole file, including the last peak bucket.
function multichannelPcm(seconds){
  const channels=16, frames=seconds*4000, start=68;
  const buffer=new ArrayBuffer(start+frames*channels*2), view=new DataView(buffer);
  for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[60,'data']])
    for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));
  view.setUint32(4,buffer.byteLength-8,true);view.setUint32(16,40,true);view.setUint16(20,0xfffe,true);
  view.setUint16(22,channels,true);view.setUint32(24,4000,true);view.setUint32(28,4000*channels*2,true);
  view.setUint16(32,channels*2,true);view.setUint16(34,16,true);view.setUint16(36,22,true);view.setUint16(38,16,true);
  new Uint8Array(buffer,44,16).set([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113]);
  view.setUint32(64,frames*channels*2,true);
  const pcm=new Int16Array(buffer,start);
  for(let i=0;i<frames;i++)pcm[(i+1)*channels-1]=i%2 ? 16384 : -8192;
  return buffer;
}

it('分段讀取多聲道平衡後的實際 PCM 格式，混音與個別聲道的首尾峰值正確',async()=>{
  const buffer=multichannelPcm(40), sizes=[];
  desktop.fileURL.mockResolvedValue('http://fixture/normalized.wave.wav');
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
    const range=/^bytes=(\d+)-(\d+)$/.exec(options?.headers?.Range||'');
    if(!range)throw new Error('平衡後的長波形不可整檔讀入');
    const first=Number(range[1]),end=Math.min(Number(range[2])+1,buffer.byteLength);
    sizes.push(end-first);
    return {status:206,arrayBuffer:async()=>buffer.slice(first,end)};
  }));
  const {peaks}=await Wave.preparePcmMix(['fixture'],{duration:40});
  expect(peaks).toHaveLength(8000);
  expect([...peaks.slice(0,2),...peaks.slice(-2)]).toEqual([-.25/16,.5/16,-.25/16,.5/16]);
  Wave.registerSourceWaveforms('effect',{channels:[{sourceChannel:15,file:'fixture',pcmChannel:15}]});
  const selected=await Wave.loadSourceWaveform('effect','0:15');
  expect([...selected.slice(0,2),...selected.slice(-2)]).toEqual([-.25,.5,-.25,.5]);
  expect(Math.max(...sizes)).toBeLessThan(buffer.byteLength/2);
});

beforeEach(() => {
  Wave.clearSources();
  Wave.peaks = null;
  Media.tracks = [];
  desktop.fileURL.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['channel','mix'])('長 WAV 的 %s 波形計算中仍能換檔，舊峰值不污染新來源',async kind=>{
  const bytes=sourcePcm(),nextPeaks=Float32Array.from([-.75,.75]);
  desktop.fileURL.mockResolvedValue('file:///old.wav');
  const changed=deferred();
  vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>{
    setTimeout(()=>{
      Wave.registerSourceWaveforms('source-1',{channels:[{sourceChannel:0,file:'new.wav',peaks:nextPeaks}],mixPath:'new.wav',mixPeaks:nextPeaks});
      changed.resolve();
    },0);
    return bytes;
  }})));
  if(kind==='channel')Wave.registerSourceWaveforms('source-1',{channels:[{sourceChannel:0,file:'old.wav'}]});
  else Wave.registerSourceWaveforms('source-1',{mixPath:{paths:['old.wav'],duration:600}});
  const pending=Wave.loadSourceWaveform('source-1',kind==='channel'?'0:0':'mix');
  await changed.promise;
  expect(await pending===null).toBe(true);
  expect(await Wave.loadSourceWaveform('source-1',kind==='channel'?'0:0':'mix')).toBe(nextPeaks);
});

it('同一來源的波形檔更換後，舊解碼晚到不會污染新檔且新解碼仍可開始', async () => {
  const oldUrl = deferred();
  const peaks = new Float32Array([-0.5, 0.5]);
  desktop.fileURL.mockReturnValueOnce(oldUrl.promise).mockResolvedValueOnce('file:///B.wav');
  const fetch = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(Wave, 'calcFromWavAsync').mockResolvedValue(peaks);

  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'A.wav' }] });
  const oldLoad = Wave.loadSourceWaveform('source-1', '0:0');
  // Re-registering the same file must retain the in-flight request.
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'A.wav' }] });
  const sameLoad = Wave.loadSourceWaveform('source-1', '0:0');
  expect(desktop.fileURL).toHaveBeenCalledTimes(1);
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'B.wav' }] });
  oldUrl.resolve('file:///A.wav');
  expect(await oldLoad).toBeNull();
  expect(await sameLoad).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  expect(await Wave.loadSourceWaveform('source-1', '0:0')).toBe(peaks);
  expect(desktop.fileURL.mock.calls.map(([path]) => path)).toEqual(['A.wav', 'B.wav']);
  expect(Wave.getSourceWaveform('source-1').peaks).toBeNull();
  Wave.setSourceWaveSelection('source-1', '0:0');
  expect(Wave.getSourceWaveform('source-1').peaks).toBe(peaks);
});

it('完整聲道清單取代預覽占位，刪除目前選取的聲道後回到 MIX', () => {
  const mix = new Float32Array([-0.2, 0.2]);
  const mono = new Float32Array([-0.4, 0.4]);
  Wave.registerSourceWaveforms('source-1', {
    mixPeaks: mix,
    channels: [{ sourceChannel: 0 }, { sourceChannel: 1 }, { sourceStream: 1, sourceChannel: 0 }],
  });
  Wave.setSourceWaveSelection('source-1', '0:1');
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, peaks: mono }] });

  expect(Wave.getSourceWaveOptions('source-1').filter(option => option.kind === 'channel').map(option => option.id)).toEqual(['0:0']);
  expect(Wave.getSourceWaveSelection('source-1')).toBe('mix');
  expect(Wave.getSourceWaveform('source-1').peaks).toBe(mix);

  // The old Stereo preview can still exist while the authoritative source
  // list becomes empty; reading options must not restore those placeholders.
  Media.tracks = [{ audioSourceId: 'source-1', sourceChannel: 0 }, { audioSourceId: 'source-1', sourceChannel: 1 }];
  Wave.registerSourceWaveforms('source-1', { channels: [] });
  expect(Wave.getSourceWaveOptions('source-1').filter(option => option.kind === 'channel')).toEqual([]);
});

it('只有路由與 MIX 時，S6 可單獨產生，失敗只在手動重試後重跑', async () => {
  const source={audioSourceId:'eight-mono',path:'mother.mov',dur:1};
  const channels=Array.from({length:8},(_,sourceStream)=>({sourceStream,sourceChannel:0}));
  const mix=Float32Array.from([-.1,.1]);
  const work=deferred();
  desktop.prepareSourceWaveform=vi.fn().mockRejectedValueOnce(new Error('素材暫時離線')).mockReturnValue(work.promise);
  State.clips=[source];
  try{
    Wave.registerSourceWaveforms(source,{channels,mixPeaks:mix});
    const option=()=>Wave.getSourceWaveOptions(source).find(item=>item.id==='5:0');
    expect(option()).toMatchObject({ready:false,preparing:false});
    expect(desktop.prepareSourceWaveform).not.toHaveBeenCalled();
    Wave.setSourceWaveSelection(source.audioSourceId,'5:0');
    await vi.waitFor(()=>expect(option().error?.message).toContain('離線'));
    expect(Wave.getSourceWaveform(source).peaks).toBeNull();
    expect(option().preparing).toBe(false);
    expect(desktop.prepareSourceWaveform).toHaveBeenCalledTimes(1);
    desktop.fileURL.mockResolvedValue('file:///s6.wav');
    vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>sourcePcm(1)})));
    Wave.setSourceWaveSelection(source.audioSourceId,'5:0');
    expect(option().preparing).toBe(true);
    expect(Wave.getSourceWaveform(source).peaks).toBeNull();
    work.resolve({complete:true,wave:'s6.wav'});
    await vi.waitFor(()=>expect(option().ready).toBe(true));
    expect(option()).toMatchObject({preparing:false,error:null});
    expect(desktop.prepareSourceWaveform).toHaveBeenCalledTimes(2);
    expect(desktop.prepareSourceWaveform.mock.lastCall[0]).toMatchObject({path:'mother.mov',duration:1,continuous:true,channel:channels[5]});
    expect([...Wave.getSourceWaveform(source).peaks.slice(-2)]).toEqual([0,.25]);
    expect(Wave.getSourceWaveOptions(source).filter(o=>o.kind==='channel'&&o.ready).map(o=>o.id)).toEqual(['5:0']);
  }finally{delete desktop.prepareSourceWaveform;delete State.clips;}
});

it('重新開啟後，已保存的 S6 峰值直接顯示，不再取回 PCM', async()=>{
  const source={audioSourceId:'eight',path:'mother.mov',dur:1.002};
  const channel={sourceStream:5,sourceChannel:0};
  const peaks=new Float32Array(202);peaks.set([-.75,.875],200);
  desktop.prepareSourceWaveform=vi.fn(async()=>({sourceKey:'d'.repeat(16),wave:'s6.wav',duration:source.dur,
    start:0,complete:true,cached:true,channel,displayPeaks:peaks}));
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  try{
    for(let open=0;open<2;open++){
      Wave.clearSources();
      Wave.registerSourceWaveforms(source,{channels:[channel]});
      expect(await Wave.loadSourceWaveform(source,'5:0')).toEqual(peaks);
    }
    expect(desktop.prepareSourceWaveform.mock.lastCall[0]).toMatchObject({displayPeaks:true,channel});
    expect(desktop.fileURL).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  }finally{delete desktop.prepareSourceWaveform;}
});

it('平衡後的 S6 首次只算自己的聲道，重開依效果配方直接還原',async()=>{
  const source={audioSourceId:'balanced',path:'mother.mov',dur:40};
  const effectPeaksCache={path:source.path,streams:[{sourceStream:5,cacheKey:'f'.repeat(64)}],
    resolution:100,channel:{sourceStream:5,sourceChannel:15}};
  const entry={...effectPeaksCache.channel,pcmChannel:15,file:'effect.wave.wav',effectPeaksCache};
  const pcm=multichannelPcm(40);
  let saved=null;
  desktop.audioEffectPeaks=vi.fn(async request=>{
    expect(request.channel).toEqual(effectPeaksCache.channel);
    if(request.peaks){saved=new Float32Array(request.peaks);return {saved:true};}
    return {peaks:saved};
  });
  desktop.fileURL.mockResolvedValue('http://fixture/effect.wave.wav');
  const fetch=vi.fn(async(_url,{headers:{Range}})=>{
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(Range);
    return {status:206,arrayBuffer:async()=>pcm.slice(+a,+b+1)};
  });
  vi.stubGlobal('fetch',fetch);
  try{
    Wave.registerSourceWaveforms(source,{channels:[entry]});
    const fresh=await Wave.loadSourceWaveform(source,'5:15');
    expect([...fresh.slice(-2)]).toEqual([-.25,.5]);expect(fetch).toHaveBeenCalled();
    Wave.clearSources();fetch.mockClear();
    Wave.registerSourceWaveforms(source,{channels:[entry]});
    expect(await Wave.loadSourceWaveform(source,'5:15')).toEqual(fresh);
    expect(fetch).not.toHaveBeenCalled();
  }finally{delete desktop.audioEffectPeaks;}
});

it.each([false, true])('已移除聲道的舊解碼晚到，不會重建或覆蓋同座標（重新加入=%s）', async readded => {
  const oldUrl = deferred();
  const oldPeaks = new Float32Array([-0.1, 0.1]);
  const newPeaks = new Float32Array([-0.8, 0.8]);
  desktop.fileURL.mockReturnValueOnce(oldUrl.promise);
  const fetch = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(Wave, 'calcFromWavAsync').mockResolvedValue(oldPeaks);
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0 }, { sourceChannel: 1, file: 'old.wav' }] });
  const oldLoad = Wave.loadSourceWaveform('source-1', '0:1');
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0 }] });
  if (readded) Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0 }, { sourceChannel: 1, file: 'new.wav', peaks: newPeaks }] });

  oldUrl.resolve('file:///old.wav');
  expect(await oldLoad).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(await Wave.loadSourceWaveform('source-1', '0:1')).toBe(readded ? newPeaks : null);
  expect(Wave.getSourceWaveOptions('source-1').some(option => option.id === '0:1')).toBe(readded);
});

it('省略聲道清單只更新 MIX，保留聲道選擇與相同 entry 的待完成解碼', async () => {
  const url = deferred();
  const peaks = new Float32Array([-0.6, 0.6]);
  desktop.fileURL.mockReturnValueOnce(url.promise);
  vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })));
  vi.spyOn(Wave, 'calcFromWavAsync').mockResolvedValue(peaks);
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'A.wav' }] });
  const pending = Wave.loadSourceWaveform('source-1', '0:0');
  Wave.setSourceWaveSelection('source-1', '0:0');
  Wave.registerSourceWaveforms('source-1', { mixPeaks: new Float32Array([-0.2, 0.2]) });

  expect(Wave.getSourceWaveSelection('source-1')).toBe('0:0');
  expect(Wave.getSourceWaveOptions('source-1').filter(option => option.kind === 'channel').map(option => option.id)).toEqual(['0:0']);
  url.resolve('file:///A.wav');
  expect(await pending).toBe(peaks);
  expect(desktop.fileURL).toHaveBeenCalledTimes(1);
  expect(Wave.getSourceWaveform('source-1').peaks).toBe(peaks);
});

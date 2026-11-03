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

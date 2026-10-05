import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  analyze:vi.fn(),restore:vi.fn(),remember:vi.fn(),emit:vi.fn(),
  state:{clips:[],audioProject:{sourceMaps:{}},duration:20},
  media:{tracks:[],activeSource:'video'},
}));
vi.mock('../src/state.js',()=>({State:mocks.state,DESK:null}));
vi.mock('../src/events.js',()=>({emit:mocks.emit}));
vi.mock('../src/util.js',()=>({readFile:vi.fn()}));
vi.mock('../src/audio-engine.js',()=>({AudioEngine:{isReady:true}}));
vi.mock('../src/audio-routing-engine.js',()=>({AudioPipeline:{}}));
vi.mock('../src/media.js',()=>({Media:mocks.media}));
vi.mock('../src/dom.js',()=>({$:vi.fn(),video:{}}));
vi.mock('../src/ui.js',()=>({setStatus:vi.fn()}));
vi.mock('../src/vocal-waveform-source.js',()=>({
  analyzeSourceVocals:mocks.analyze,
  restoreCachedSourceVocals:mocks.restore,
  rememberSourceVocalSelection:mocks.remember,
}));

import { Wave } from '../src/waveform-decoder.js';

function deferred(){
  let resolve,reject;
  const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}

const source={audioSourceId:'source-1',audioSrc:'video',dur:20,in:10,out:13,offset:5};
const original=new Float32Array([-0.8,0.8]);

beforeEach(()=>{
  Wave.clearSources();
  Wave.peaks=null;
  mocks.analyze.mockReset();
  mocks.restore.mockReset().mockResolvedValue(null);
  mocks.remember.mockReset().mockResolvedValue(undefined);
  mocks.emit.mockClear();
  mocks.state.clips=[source];
  Wave.registerSourceWaveforms(source,{mixPath:'A.wav',mixPeaks:original});
});
afterEach(()=>Wave.clearSources());

describe('來源人聲波形選擇',()=>{
  it('整列有不同母素材時，所有分析完成才一起切換，先完成者仍顯示原波形',async()=>{
    const left={audioSourceId:'asset-left',timelineLaneId:'lane-1'};
    const right={audioSourceId:'asset-right',timelineLaneId:'lane-1'};
    const first=deferred(),second=deferred();
    mocks.analyze.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Wave.registerSourceWaveforms(left,{mixPeaks:original});
    Wave.registerSourceWaveforms(right,{mixPeaks:original});
    const selection=Wave.setSourceWaveLaneSelection([left,right],'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledTimes(2));
    const result=new Float32Array([-0.2,0.2]);
    first.resolve(result);
    await vi.waitFor(()=>expect(Wave.getSourceWaveOptions(left).find(item=>item.id==='vocals').ready).toBe(true));
    expect(Wave.getSourceWaveform(left).peaks).toBe(original);
    expect(Wave.getSourceWaveform(right).peaks).toBe(original);
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({selection:'mix',pending:true,vocalsSelected:false});
    second.resolve(result);
    await selection;
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({selection:'vocals',pending:false,vocalsSelected:true});
    expect(Wave.getSourceWaveform(left).peaks).toBe(result);
    expect(Wave.getSourceWaveform(right).peaks).toBe(result);
  });

  it('整列其中一項失敗時不會留下部分人聲選擇',async()=>{
    const left={audioSourceId:'asset-left'},right={audioSourceId:'asset-right'};
    const first=deferred(),second=deferred();
    mocks.analyze.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Wave.registerSourceWaveforms(left,{mixPeaks:original});
    Wave.registerSourceWaveforms(right,{mixPeaks:original});
    const selection=Wave.setSourceWaveLaneSelection([left,right],'vocals');
    const rejection=expect(selection).rejects.toThrow('分析失敗');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledTimes(2));
    first.resolve(new Float32Array([-0.2,0.2]));
    second.reject(new Error('分析失敗'));
    await rejection;
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({selection:'mix',pending:false,vocalsSelected:false});
    expect(Wave.getSourceWaveform(left).peaks).toBe(original);
    expect(Wave.getSourceWaveform(right).peaks).toBe(original);
    expect(mocks.remember).not.toHaveBeenCalledWith(expect.anything(),true);
  });

  it('切開的外部音檔整列切換全部 runtime 來源，混合狀態不標成人聲',async()=>{
    const left={id:'left',audioSourceId:'asset-left',audioSrc:'ext:left',timelineLaneId:'lane-1',duration:20,in:0,out:10,offset:0};
    const right={id:'right',audioSourceId:'asset-right',audioSrc:'ext:right',timelineLaneId:'lane-1',duration:20,in:10,out:20,offset:10};
    Wave.registerSourceWaveforms(left,{mixPeaks:original});
    Wave.registerSourceWaveforms(right,{mixPeaks:original});
    const vocal=new Float32Array(20*100*2);
    vocal[15*100*2+1]=0.4;
    mocks.analyze.mockResolvedValue(vocal);
    await Wave.setSourceWaveLaneSelection([left,right,left],'vocals');
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
    expect(Wave.getSourceWaveform(left).peaks).toBe(vocal);
    expect(Wave.getSourceWaveform(right).peaks[15*100*2+1]).toBeCloseTo(0.4);
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({
      selection:'vocals',mixed:false,vocalsSelected:true,
    });
    Wave.setSourceWaveSelection(left,'mix');
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({
      selection:'mixed',mixed:true,vocalsSelected:false,label:'混合（依各片段）',
    });
    await Wave.setSourceWaveLaneSelection([left,right],'vocals');
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
    expect(Wave.getSourceWaveLaneState([left,right]).vocalsSelected).toBe(true);
    await Wave.setSourceWaveLaneSelection([left,right],'mix');
    expect(Wave.getSourceWaveform(left).peaks).toBe(original);
    expect(Wave.getSourceWaveform(right).peaks).toBe(original);
    expect(Wave.getSourceWaveLaneState([left,right]).mixed).toBe(false);
  });

  it('整列取消會撤銷所有切片訂閱，晚到共用結果不重開人聲波形',async()=>{
    const left={audioSourceId:'asset-left',timelineLaneId:'lane-1'};
    const right={audioSourceId:'asset-right',timelineLaneId:'lane-1'};
    const pending=deferred();
    mocks.analyze.mockReturnValue(pending.promise);
    Wave.registerSourceWaveforms(left,{mixPeaks:original});
    Wave.registerSourceWaveforms(right,{mixPeaks:original});
    const selection=Wave.setSourceWaveLaneSelection([left,right],'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledTimes(2));
    mocks.analyze.mock.calls.forEach(([_source,options])=>options.onProgress({percent:35,label:'分離人聲'}));
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({pending:true,progress:35});
    await Wave.setSourceWaveLaneSelection([left,right],'mix');
    expect(mocks.analyze.mock.calls.every(([_source,options])=>options.signal.aborted)).toBe(true);
    pending.resolve(new Float32Array([-0.2,0.2]));
    await selection;
    expect(Wave.getSourceWaveLaneState([left,right])).toMatchObject({
      selection:'mix',pending:false,vocalsSelected:false,
    });
    expect(Wave.getSourceWaveform(right).peaks).toBe(original);
  });

  it('分離期間保留既有波形與進度，完整完成才切換且不改專案或監聽來源',async()=>{
    const pending=deferred();
    mocks.analyze.mockReturnValue(pending.promise);
    const before=JSON.stringify({state:mocks.state,activeSource:mocks.media.activeSource});
    const selection=Wave.setSourceWaveSelection(source,'vocals');
    expect(Wave.getSourceWaveform(source,original)).toMatchObject({
      peaks:original,selection:'mix',fallback:false,pending:true,
    });
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledOnce());
    const options=mocks.analyze.mock.calls[0][1];
    options.onProgress({percent:32.4,label:'分離人聲'});
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals')).toMatchObject({
      label:'人聲（分離配樂 32%）',preparing:true,progress:32,selected:false,
    });
    const vocal=new Float32Array(20*100*2);
    vocal[10*100*2+1]=0.5;
    pending.resolve(vocal);
    expect(await selection).toBe('vocals');
    expect(Wave.getSourceWaveform(source)).toMatchObject({peaks:vocal,fallback:false,pending:false});
    expect(Wave.getSourceWaveform(source).peaks.length).toBe(4000);
    expect(JSON.stringify({state:mocks.state,activeSource:mocks.media.activeSource})).toBe(before);
  });

  it('完成後可切回原音、聲道再切人聲，同母素材的剪輯共用結果',async()=>{
    const vocal=new Float32Array([-0.2,0.2]);
    const channel=new Float32Array([-0.4,0.4]);
    mocks.analyze.mockResolvedValue(vocal);
    Wave.registerSourceWaveforms(source,{channels:[{sourceChannel:0,peaks:channel}]});
    await Wave.setSourceWaveSelection(source,'vocals');
    Wave.setSourceWaveSelection(source,'mix');
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    Wave.setSourceWaveSelection(source,'0:0');
    expect(Wave.getSourceWaveform(source).peaks).toBe(channel);
    await Wave.setSourceWaveSelection({...source,in:12,out:17,offset:30},'vocals');
    expect(Wave.getSourceWaveform(source).peaks).toBe(vocal);
    expect(mocks.analyze).toHaveBeenCalledOnce();
  });

  it('分析及取消期間保留原先選取的聲道，遲到結果不能切換或記住人聲',async()=>{
    const pending=deferred(),channel=new Float32Array([-0.4,0.4]);
    Wave.registerSourceWaveforms(source,{channels:[{sourceChannel:0,peaks:channel}]});
    Wave.setSourceWaveSelection(source,'0:0');
    mocks.analyze.mockReturnValue(pending.promise);
    const selection=Wave.setSourceWaveSelection(source,'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledOnce());
    expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'0:0',peaks:channel,pending:true});
    Wave.setSourceWaveSelection(source,'cancel-vocals');
    expect(mocks.analyze.mock.calls[0][1].signal.aborted).toBe(true);
    expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'0:0',peaks:channel,pending:false});
    pending.resolve(new Float32Array([-0.2,0.2]));
    await selection;
    expect(Wave.getSourceWaveform(source).peaks).toBe(channel);
    expect(mocks.remember).not.toHaveBeenCalledWith(expect.anything(),true);
  });

  it('成功切換後等待顯示偏好落盤，選回聲道會記住原音選擇',async()=>{
    const saved=deferred(),result=new Float32Array([-0.2,0.2]);
    mocks.analyze.mockResolvedValue(result);
    mocks.remember.mockReturnValueOnce(saved.promise).mockResolvedValue(undefined);
    let settled=false;
    const selection=Wave.setSourceWaveSelection(source,'vocals').then(()=>{settled=true;});
    await vi.waitFor(()=>expect(mocks.remember).toHaveBeenCalledWith(source,true));
    expect(Wave.getSourceWaveform(source).peaks).toBe(result);
    expect(settled).toBe(false);
    saved.resolve();
    await selection;
    Wave.setSourceWaveSelection(source,'mix');
    await vi.waitFor(()=>expect(mocks.remember).toHaveBeenLastCalledWith(source,false));
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
  });

  it('重複點選進行中的人聲選項不建立第二份工作',async()=>{
    const pending=deferred();
    mocks.analyze.mockReturnValue(pending.promise);
    const first=Wave.setSourceWaveSelection(source,'vocals');
    const second=Wave.setSourceWaveSelection(source.audioSourceId,'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledOnce());
    pending.resolve(new Float32Array([-0.2,0.2]));
    await Promise.all([first,second]);
    expect(mocks.analyze).toHaveBeenCalledOnce();
  });

  it('手動重新選人聲命中快取時保留完成狀態的快取標示',async()=>{
    const result=new Float32Array([-0.2,0.2]);
    mocks.analyze.mockImplementation(async(_source,{onProgress})=>{
      onProgress({percent:100,label:'已載入人聲快取'});
      return result;
    });
    await Wave.setSourceWaveSelection(source,'vocals');
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals')).toMatchObject({
      ready:true,preparing:false,detail:'已讀取人聲波形快取',selected:true,
    });
  });

  it('切回原音立即取消，晚到進度及結果不能取代後續的新分析',async()=>{
    const old=deferred(),next=deferred();
    mocks.analyze.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first=Wave.setSourceWaveSelection(source,'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledTimes(1));
    const oldOptions=mocks.analyze.mock.calls[0][1];
    Wave.setSourceWaveSelection(source,'mix');
    expect(oldOptions.signal.aborted).toBe(true);
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    const second=Wave.setSourceWaveSelection(source,'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledTimes(2));
    oldOptions.onProgress({percent:99,label:'舊工作'});
    old.resolve(new Float32Array([-0.9,0.9]));
    await first;
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals').progress).toBe(0);
    const result=new Float32Array([-0.3,0.3]);
    next.resolve(result);
    await second;
    expect(Wave.getSourceWaveform(source).peaks).toBe(result);
  });

  it.each([
    ['重設專案',()=>Wave.clearSources()],
    ['移除來源',()=>Wave.forgetSourceWaveforms(source)],
    ['更換波形檔',()=>Wave.registerSourceWaveforms(source,{mixPath:'B.wav'})],
  ])('%s 撤銷分離，不接受遲到的結果',async(_name,replace)=>{
    const pending=deferred();
    mocks.analyze.mockReturnValue(pending.promise);
    const selection=Wave.setSourceWaveSelection(source,'vocals');
    await vi.waitFor(()=>expect(mocks.analyze).toHaveBeenCalledOnce());
    const signal=mocks.analyze.mock.calls[0][1].signal;
    replace();
    expect(signal.aborted).toBe(true);
    Wave.registerSourceWaveforms(source,{mixPath:'C.wav',mixPeaks:original});
    pending.resolve(new Float32Array([-0.9,0.9]));
    await selection;
    expect(Wave.getSourceWaveSelection(source)).toBe('mix');
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals').ready).toBe(false);
  });

  it('分離失敗回到之前選擇的原音聲道，保留可重試入口',async()=>{
    const channel=new Float32Array([-0.4,0.4]);
    Wave.registerSourceWaveforms(source,{channels:[{sourceChannel:0,peaks:channel}]});
    Wave.setSourceWaveSelection(source,'0:0');
    mocks.analyze.mockRejectedValueOnce(new Error('模型下載失敗'));
    await expect(Wave.setSourceWaveSelection(source,'vocals')).rejects.toThrow('模型下載失敗');
    expect(Wave.getSourceWaveSelection(source)).toBe('0:0');
    expect(Wave.getSourceWaveform(source).peaks).toBe(channel);
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals').label).toContain('重試');
    const result=new Float32Array([-0.2,0.2]);
    mocks.analyze.mockResolvedValue(result);
    await Wave.setSourceWaveSelection(source,'vocals');
    expect(Wave.getSourceWaveform(source).peaks).toBe(result);
  });
});

describe('重開專案的人聲波形快取顯示',()=>{
  function registerFresh(){
    Wave.clearSources();
    mocks.restore.mockClear();
    Wave.registerSourceWaveforms(source,{mixPath:'A.wav',mixPeaks:original});
  }

  it('只讀取有效且先前選人聲的快取，原音保持可見至讀取完成',async()=>{
    const pending=deferred(),result=new Float32Array([-0.2,0.2]);
    mocks.restore.mockReturnValue(pending.promise);
    const before=JSON.stringify(mocks.state);
    registerFresh();
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    await vi.waitFor(()=>expect(mocks.restore).toHaveBeenCalledOnce());
    pending.resolve(result);
    await vi.waitFor(()=>expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'vocals',peaks:result}));
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.state)).toBe(before);
  });

  it('讀取快取期間明確選回原音會使遲到快取失效且記住原音',async()=>{
    const pending=deferred();
    mocks.restore.mockReturnValue(pending.promise);
    registerFresh();
    await vi.waitFor(()=>expect(mocks.restore).toHaveBeenCalledOnce());
    const signal=mocks.restore.mock.calls[0][1].signal;
    Wave.setSourceWaveSelection(source,'mix');
    expect(signal.aborted).toBe(true);
    pending.resolve(new Float32Array([-0.2,0.2]));
    await vi.waitFor(()=>expect(mocks.remember).toHaveBeenCalledWith(source,false));
    expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'mix',peaks:original});
    expect(Wave.getSourceWaveOptions(source).find(item=>item.id==='vocals').ready).toBe(false);
  });

  it.each([
    ['重設專案',()=>Wave.clearSources()],
    ['移除來源',()=>Wave.forgetSourceWaveforms(source)],
    ['更換波形檔',()=>Wave.registerSourceWaveforms(source,{mixPath:'B.wav',mixPeaks:original})],
  ])('%s 不接受先前的快取結果',async(_name,replace)=>{
    const pending=deferred();
    mocks.restore.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    registerFresh();
    await vi.waitFor(()=>expect(mocks.restore).toHaveBeenCalledOnce());
    const signal=mocks.restore.mock.calls[0][1].signal;
    replace();
    expect(signal.aborted).toBe(true);
    Wave.registerSourceWaveforms(source,{mixPath:'C.wav',mixPeaks:original});
    pending.resolve(new Float32Array([-0.9,0.9]));
    await vi.waitFor(()=>expect(Wave.sourceWaveforms.get(source.audioSourceId).vocalRestore).toBeNull());
    expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'mix',peaks:original});
  });

  it('素材尚未 resolve 可在後續登錄重試，查無快取不啟動分析',async()=>{
    const result=new Float32Array([-0.2,0.2]);
    mocks.restore.mockResolvedValueOnce(undefined).mockResolvedValueOnce(result);
    registerFresh();
    await vi.waitFor(()=>expect(Wave.sourceWaveforms.get(source.audioSourceId).vocalRestore).toBeNull());
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(Wave.getSourceWaveform(source).peaks).toBe(original);
    Wave.registerSourceWaveforms(source);
    await vi.waitFor(()=>expect(Wave.getSourceWaveform(source).selection).toBe('vocals'));
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it('初次登錄缺少 metadata 的 cache miss，補齊 metadata 後重查一次',async()=>{
    const early={audioSourceId:'early',audioSrc:'clip:early'};
    const result=new Float32Array([-0.2,0.2]);
    Wave.clearSources();
    mocks.restore.mockClear().mockResolvedValueOnce(null).mockResolvedValueOnce(result);
    Wave.registerSourceWaveforms(early,{mixPeaks:original});
    await vi.waitFor(()=>expect(Wave.sourceWaveforms.get('early').vocalRestoreComplete).toBe(true));
    Wave.registerSourceWaveforms(early);
    expect(mocks.restore).toHaveBeenCalledOnce();
    Object.assign(early,{path:'movie.mkv',dur:20,descriptors:[{sourceStream:0}]});
    Wave.registerSourceWaveforms(early);
    await vi.waitFor(()=>expect(Wave.getSourceWaveSelection(early)).toBe('vocals'));
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it('已明確選原音時，metadata 補齊不重新套用人聲快取',async()=>{
    const early={audioSourceId:'early',audioSrc:'clip:early'};
    Wave.clearSources();
    mocks.restore.mockClear().mockResolvedValue(null);
    Wave.registerSourceWaveforms(early,{mixPeaks:original});
    await vi.waitFor(()=>expect(Wave.sourceWaveforms.get('early').vocalRestoreComplete).toBe(true));
    Wave.setSourceWaveSelection(early,'mix');
    Object.assign(early,{path:'movie.mkv',dur:20,descriptors:[{sourceStream:0}]});
    Wave.registerSourceWaveforms(early);
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(Wave.getSourceWaveform(early).peaks).toBe(original);
  });

  it.each([null,new Error('快取不可讀')])('無快取或讀取失敗保持原波形且不自動分析',async(result)=>{
    if(result instanceof Error) mocks.restore.mockRejectedValue(result);
    else mocks.restore.mockResolvedValue(result);
    registerFresh();
    await vi.waitFor(()=>expect(Wave.sourceWaveforms.get(source.audioSourceId).vocalRestore).toBeNull());
    expect(Wave.getSourceWaveform(source)).toMatchObject({selection:'mix',peaks:original});
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
});

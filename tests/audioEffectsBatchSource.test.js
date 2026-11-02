// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint.js');
let Media, State, desk, root;

beforeAll(async () => {
  document.body.innerHTML = fs.readFileSync('index.html', 'utf8');
  desk = { isDesktop:true };
  window.subtool = desk;
  ({ Media } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
});
beforeEach(()=>{desk.probe=vi.fn(async()=>({audio:[{channels:1}]}));});

afterEach(() => {
  if (root) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-effects-batch-')) {
      throw new Error('拒絕刪除測試目錄以外資料');
    }
    fs.rmSync(real, { recursive:true, force:true });
    root = null;
  }
  vi.restoreAllMocks();
});

it('兩音訊串流之間同路徑換母素材，不發布混合新舊來源的處理結果', async () => {
  desk.probe.mockResolvedValue({audio:[{channels:1},{channels:1}]});
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov');
  fs.writeFileSync(sourcePath, 'old mother');
  const outputs = [];
  desk.audioSourceFingerprint = vocalSourceFingerprint;
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  desk.normalizeAudio = vi.fn(async (file, options) => {
    const outputPath = path.join(root, `stream-${options.sourceStream}.wav`);
    fs.writeFileSync(outputPath, fs.readFileSync(file));
    outputs.push(outputPath);
    if (options.sourceStream === 0) {
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, 'new mother');
    }
    return { outputPath };
  });
  const source = { path:sourcePath, duration:5, descriptors:[
    { sourceStream:0, sourceChannel:0 }, { sourceStream:1, sourceChannel:0 },
  ] };
  await expect(Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  })).rejects.toThrow(/母素材.*變更/);
  expect(desk.normalizeAudio).toHaveBeenCalledTimes(1);
  expect(outputs).toHaveLength(1);
  expect(fs.existsSync(outputs[0])).toBe(false);
  expect(fs.readFileSync(sourcePath,'utf8')).toBe('new mother');
});

it('穩定母素材的多串流仍保留各串流來源座標及輸出', async () => {
  desk.probe.mockResolvedValue({audio:[{channels:1},{channels:3}]});
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov');
  fs.writeFileSync(sourcePath, 'same mother');
  desk.audioSourceFingerprint = vocalSourceFingerprint;
  desk.cleanupAudio = vi.fn();
  desk.normalizeAudio = vi.fn(async (file, options) => {
    const outputPath = path.join(root, `stream-${options.sourceStream}.wav`);
    fs.writeFileSync(outputPath, fs.readFileSync(file));
    return { outputPath };
  });
  const source = { path:sourcePath, duration:5, descriptors:[
    { sourceStream:0, sourceChannel:0 }, { sourceStream:1, sourceChannel:2 },
  ] };
  const result = await Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  });
  expect(result.streams.map(item => item.sourceStream)).toEqual([0,1]);
  expect(result.streams[1].descriptors.map(item=>item.sourceChannel)).toEqual([0,1,2]);
  expect(result.sourceFingerprint).toBe(await vocalSourceFingerprint(sourcePath));
  expect(result.streams.map(item => fs.readFileSync(item.outputPath,'utf8'))).toEqual(['same mother','same mother']);
  expect(desk.cleanupAudio).not.toHaveBeenCalled();
});

it('最後一軌完成後母素材被替換，清理整批輸出且不交接', async () => {
  desk.probe.mockResolvedValue({audio:[{channels:1},{channels:1}]});
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov');
  fs.writeFileSync(sourcePath, 'old mother');
  const outputs = [];
  desk.audioSourceFingerprint = vocalSourceFingerprint;
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  desk.normalizeAudio = vi.fn(async (file, options) => {
    const outputPath = path.join(root, `stream-${options.sourceStream}.wav`);
    fs.writeFileSync(outputPath, fs.readFileSync(file)); outputs.push(outputPath);
    if (options.sourceStream === 1) {
      fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'new mother');
    }
    return { outputPath };
  });
  const source = { path:sourcePath, descriptors:[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0}] };
  await expect(Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  })).rejects.toThrow(/母素材.*變更/);
  expect(outputs).toHaveLength(2);
  expect(outputs.every(file => !fs.existsSync(file))).toBe(true);
  expect(desk.cleanupAudio).toHaveBeenCalledTimes(2);
});

it.each(['empty','malformed','error'])('輸出後母素材證據 %s 時拒絕交接並清理', async failure => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov'); fs.writeFileSync(sourcePath, 'mother');
  const outputPath = path.join(root, 'stream.wav'); let written = false;
  desk.audioSourceFingerprint = vi.fn(async file => {
    if (written) { if (failure === 'error') throw new Error('讀取失敗'); return failure === 'malformed' ? 'invalid' : ''; }
    return vocalSourceFingerprint(file);
  });
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  desk.normalizeAudio = vi.fn(async () => { fs.writeFileSync(outputPath, 'output'); written = true; return {outputPath}; });
  const source = {path:sourcePath,descriptors:[{sourceStream:0,sourceChannel:0}]};
  await expect(Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  })).rejects.toThrow(/母素材/);
  expect(fs.existsSync(outputPath)).toBe(false);
});

it('舊版 bridge 沒有來源指紋時不能啟動無法核對的多串流工作', async () => {
  desk.probe.mockResolvedValue({audio:[{channels:1},{channels:1}]});
  delete desk.audioSourceFingerprint;
  desk.normalizeAudio = vi.fn();
  const source = {path:'C:/mother.mov',descriptors:[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0}]};
  await expect(Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  })).rejects.toThrow(/母素材.*(驗證|核對)/);
  expect(desk.normalizeAudio).not.toHaveBeenCalled();
});

it('舊版 bridge 的單串流仍可處理但不產生可供快取的來源證據', async () => {
  delete desk.audioSourceFingerprint;
  desk.normalizeAudio = vi.fn(async () => ({outputPath:'C:/temporary.wav'}));
  const source = {path:'C:/mother.mov',descriptors:[{sourceStream:0,sourceChannel:0}]};
  const result = await Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  });
  expect(result.outputPath).toBe('C:/temporary.wav');
  expect(result.sourceFingerprint).toBeUndefined();
});

it('探測串流資訊時母素材被替換，不啟動音訊處理', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov'); fs.writeFileSync(sourcePath, 'old mother');
  desk.audioSourceFingerprint = vocalSourceFingerprint;
  desk.normalizeAudio = vi.fn();
  desk.probe = vi.fn(async file => {
    fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'new mother');
    return {audio:[{channels:1}]};
  });
  await expect(Media._processAudioEffect({path:sourcePath}, {max:-6,min:-12}, {
    id:'batch', signal:new AbortController().signal, progress:()=>{},
  })).rejects.toThrow(/母素材.*變更/);
  expect(desk.normalizeAudio).not.toHaveBeenCalled();
});

it('原生處理期間取消，即使輸出稍後成功回傳也回收該檔', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov'); fs.writeFileSync(sourcePath, 'mother');
  const outputPath = path.join(root, 'stream.wav'); let finish;
  desk.audioSourceFingerprint = vocalSourceFingerprint;
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  desk.cancelAudioNormalization = vi.fn();
  desk.normalizeAudio = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = Media._processAudioEffect({path:sourcePath,descriptors:[{sourceStream:0,sourceChannel:0}]}, {max:-6,min:-12}, {
    id:'batch', signal:controller.signal, progress:()=>{},
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  controller.abort();
  fs.writeFileSync(outputPath, 'finished after cancel'); finish({outputPath});
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  expect(desk.cancelAudioNormalization).toHaveBeenCalledWith('batch-0');
  expect(fs.existsSync(outputPath)).toBe(false);
});

it('整批輸出完成後準備期間失權，實際 Media 工廠回收尚未安裝的全部輸出', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const outputs = [path.join(root, 'one.wav'), path.join(root, 'two.wav')];
  outputs.forEach(file => fs.writeFileSync(file, 'generated'));
  desk.audioSourceFingerprint = vi.fn(async () => 'a'.repeat(64));
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  const source = {id:'clip',type:'video',audioSourceId:'source',path:'C:/mother.mov'};
  State.clips = [source];
  let finish;
  const process = vi.spyOn(Media, '_processAudioEffect').mockResolvedValue({
    outputPath:outputs[0],streams:outputs.map(outputPath=>({outputPath})),sourceFingerprint:'a'.repeat(64),
  });
  const prepare = vi.spyOn(Media, '_prepareAudioEffect').mockImplementation(() => new Promise(resolve => {finish=resolve;}));
  const install = vi.spyOn(Media, '_installAudioEffect').mockImplementation(() => {});
  const effects=Media.audioEffects;
  const pending=effects.apply(source,{max:-6,min:-12});
  try {
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    effects.invalidate();
    finish({dispose:vi.fn()});
    await expect(pending).resolves.toEqual({status:'replaced'});
    expect(process).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(outputs.every(file=>!fs.existsSync(file))).toBe(true);
    expect(desk.cleanupAudio).toHaveBeenCalledTimes(2);
  } finally { effects.invalidate({clear:true}); State.clips=[]; }
});

it.each(['sync','apply'])('背景補足串流後 %s 不沿用舊聲道佈局的效果輸出', async mode => {
  const {AudioPipeline}=await import('../src/audio-routing-engine.js');
  const priorEffects=Media._audioEffects, priorTracks=Media.tracks, priorProject=State.audioProject;
  Media._audioEffects=null;
  const source={id:'clip-layout',type:'video',audioSourceId:'layout',path:'C:/mother.mov'};
  State.clips=[source]; State.audioProject=null;
  Media.tracks=[{audioSourceId:'layout',_audioEffect:true}];
  desk.audioSourceFingerprint=vi.fn(async()=> 'a'.repeat(64));
  desk.normalizeAudio=vi.fn(async (_file,options)=>({outputPath:`C:/stream-${options.sourceStream}.wav`}));
  desk.cleanupAudio=vi.fn();
  const prepared=vi.spyOn(Media,'_prepareAudioEffect').mockImplementation(async (_source,result)=>result);
  const installed=vi.spyOn(Media,'_installAudioEffect').mockImplementation(()=>{});
  const effects=Media.audioEffects, spec={max:-6,min:-12};
  try {
    AudioPipeline.registerSource(source,[{sourceStream:0,sourceChannel:0}]);
    expect((await effects.apply(source,spec)).status).toBe('completed');
    expect(installed.mock.lastCall[1].streams.map(stream=>stream.sourceStream)).toEqual([0]);
    desk.probe.mockResolvedValue({audio:[{channels:1},{channels:1}]});
    AudioPipeline.registerSource(source,[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0}]);
    if(mode==='apply') await effects.apply(source,spec);
    await vi.waitFor(()=>expect(installed.mock.lastCall[1].streams.map(stream=>stream.sourceStream)).toEqual([0,1]),{timeout:300});
    expect(desk.normalizeAudio.mock.calls.map(call=>call[1].sourceStream)).toEqual([0,0,1]);
  } finally {
    effects.invalidate({clear:true}); Media._audioEffects=priorEffects; Media.tracks=priorTracks;
    State.clips=[];State.audioProject=priorProject;prepared.mockRestore();installed.mockRestore();
  }
});

it('背景補足串流時原處理仍在執行，保留使用者意圖並重做完整佈局', async () => {
  const {AudioPipeline}=await import('../src/audio-routing-engine.js');
  const priorEffects=Media._audioEffects, priorTracks=Media.tracks, priorProject=State.audioProject;
  Media._audioEffects=null;
  const source={id:'clip-running',type:'video',audioSourceId:'running',path:'C:/mother.mov'};
  State.clips=[source]; State.audioProject=null; Media.tracks=[{audioSourceId:'running',_audioEffect:true}];
  desk.audioSourceFingerprint=vi.fn(async()=> 'a'.repeat(64));
  desk.cleanupAudio=vi.fn(async()=>{}); desk.cancelAudioNormalization=vi.fn();
  let finishOld;
  desk.normalizeAudio=vi.fn((_file,options)=>{
    if(!finishOld) return new Promise(resolve=>{finishOld=resolve;});
    return Promise.resolve({outputPath:`C:/new-${options.sourceStream}.wav`});
  });
  const prepared=vi.spyOn(Media,'_prepareAudioEffect').mockImplementation(async (_source,result)=>result);
  const installed=vi.spyOn(Media,'_installAudioEffect').mockImplementation(()=>{});
  const effects=Media.audioEffects;
  try {
    AudioPipeline.registerSource(source,[{sourceStream:0,sourceChannel:0}]);
    const pending=effects.apply(source,{max:-6,min:-12});
    await vi.waitFor(()=>expect(finishOld).toBeTypeOf('function'));
    desk.probe.mockResolvedValue({audio:[{channels:1},{channels:1}]});
    AudioPipeline.registerSource(source,[{sourceStream:0,sourceChannel:0},{sourceStream:1,sourceChannel:0}]);
    await vi.waitFor(()=>expect(installed.mock.lastCall?.[1]?.streams.map(stream=>stream.sourceStream)).toEqual([0,1]),{timeout:500});
    finishOld({outputPath:'C:/old.wav'});
    expect(await pending).toEqual({status:'replaced'});
    expect(desk.cleanupAudio).toHaveBeenCalledWith('C:/old.wav');
    expect(desk.normalizeAudio.mock.calls.map(call=>call[1].sourceStream)).toEqual([0,0,1]);
  } finally {
    finishOld?.({outputPath:'C:/old.wav'});
    effects.invalidate({clear:true}); Media._audioEffects=priorEffects; Media.tracks=priorTracks;
    State.clips=[];State.audioProject=priorProject;prepared.mockRestore();installed.mockRestore();
  }
});

it('等待母素材指紋時取消，等待核對結束後清理已生成輸出', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-effects-batch-'));
  const sourcePath = path.join(root, 'mother.mov'); fs.writeFileSync(sourcePath, 'mother');
  const outputPath = path.join(root, 'stream.wav'); let written = false, entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  desk.audioSourceFingerprint = vi.fn(async file => {
    if (written) { entered = true; await gate; }
    return vocalSourceFingerprint(file);
  });
  desk.cleanupAudio = vi.fn(async file => { fs.unlinkSync(file); });
  desk.normalizeAudio = vi.fn(async () => { fs.writeFileSync(outputPath, 'output'); written = true; return {outputPath}; });
  const source = {path:sourcePath,descriptors:[{sourceStream:0,sourceChannel:0}]};
  const controller = new AbortController();
  const pending = Media._processAudioEffect(source, {max:-6,min:-12}, {
    id:'batch', signal:controller.signal, progress:()=>{},
  });
  try {
    await vi.waitFor(() => expect(entered).toBe(true), {timeout:300});
    controller.abort(); release();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(desk.cleanupAudio).toHaveBeenCalledOnce();
  } finally { release(); }
});

// @subtool-ci windows
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from 'acorn';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createAudioNormalizationRuntime } = require('../electron/audio-normalization-runtime.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { accessVocalPeaks } = require('../electron/vocal-waveform-sidecar.js');
const { vocalSourceFingerprint } = require('../electron/vocal-waveform-fingerprint.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { motherSourceFingerprint } = require('../electron/mother-source-evidence.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { audioLimiterFilter } = require('../shared/audio-loudness.cjs');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();

function sourceEvidenceBridge(source) {
  const main=fs.readFileSync('electron/main.js','utf8'),handlers=new Map();
  const ast=parse(main,{ecmaVersion:'latest',sourceType:'script'});
  const authority=new FileAuthority();
  const context={motherSourceFingerprint,
    ...require('../electron/vocal-waveform-fingerprint'),
    requireReadablePath:require('../electron/ipc-guards').createIpcGuards(authority).requireReadablePath,
    ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)}};
  const channels=['audio:source-fingerprint','audio:vocal-wave-fingerprint'];
  const registrations=ast.body.filter(n=>n.expression?.callee?.object?.name==='ipcMain'
    && channels.includes(n.expression.arguments[0]?.value));
  vm.runInNewContext(registrations.map(n=>main.slice(n.start,n.end)).join('\n'),context);
  const declaration=ast.body.flatMap(n=>n.declarations||[]).find(d=>d.id.name==='audioNormalizationRuntime');
  const adapter=declaration.init.arguments[0].properties.find(p=>p.key.name==='fingerprintSource').value;
  const fingerprintSource=vm.runInNewContext(main.slice(adapter.start,adapter.end),context);
  let api;
  vm.runInNewContext(fs.readFileSync('electron/preload.js','utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld:(_name,exposed)=>{api=exposed;}},
      ipcRenderer:{invoke:(channel,...args)=>handlers.get(channel)({},...args)},webUtils:{}}),
    ArrayBuffer,Uint8Array,Promise,TypeError,RangeError});
  authority.grantTrustedFile(source,{read:true,write:false});
  return {api,fingerprintSource};
}
function amplitude(bytes, frequency, start = .62, end = .78) {
  const first = Math.round(start * 4000), last = Math.round(end * 4000);
  let sine = 0, cosine = 0;
  for (let index = first; index < last; index++) {
    const sample = bytes.readFloatLE(index * 4), phase = 2 * Math.PI * frequency * index / 4000;
    sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (last - first);
}

describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('平衡化預覽 WAV 的來源時鐘', () => {
  it('兩個桌面掛載同一 NAS 素材，共用音訊平衡、報告與峰值，回傳各自有效的來源指紋',async()=>{
    const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-effect-nas-'));
    const mounts=['client-A','client-B'].map(label=>path.join(root,label));
    const sources=mounts.map(dir=>path.join(dir,'film.wav')),runtimes=[];
    const real=fs.realpathSync.native;
    let shared=false;
    vi.spyOn(fs.realpathSync,'native').mockImplementation((file,...args)=>
      shared && sources.includes(file)?'//studio-nas/projects/film.wav':real(file,...args));
    try{
      fs.mkdirSync(mounts[0]);
      const generated=spawnSync(FFMPEG,['-hide_banner','-v','error','-f','lavfi','-i','sine=frequency=400:duration=2','-c:a','pcm_s16le',sources[0]],{windowsHide:true});
      expect(generated.status).toBe(0);
      const ff=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>root});
      const execute=vi.fn((args,opts)=>ff.execute(args,{...opts,executionKind:'direct'}));
      const open=source=>{
        const authority=new FileAuthority();authority.grantTrustedFile(source);
        const runtime=createMediaIntakeRuntime({fileAuthority:authority,tempRoot:root,cacheRoot:root});
        runtimes.push(runtime);
        const probe=createMediaProbe({executable:FFPROBE});
        return createAudioNormalizationRuntime({createTempPath:()=>path.join(root,'temp.wav'),execute,
          fingerprintSource:motherSourceFingerprint,probe:(file,opts)=>probe.describe(file,opts),
          withEffectCache:(file,work)=>runtime.withAudioEffectCache(file,work),grantRead(){}});
      };
      const legacy=open(sources[0]),legacyOptions={sourceStream:0,maximumAmplitude:-5,targetLoudness:-18};
      const old=await legacy.normalize(sources[0],legacyOptions);
      await runtimes.pop().close();execute.mockClear();
      shared=true;
      const first=open(sources[0]),opts={sourceStream:0,maximumAmplitude:-3,targetLoudness:-14};
      expect(await first.normalize(sources[0],legacyOptions)).toMatchObject({cacheHit:true,outputPath:old.outputPath});
      expect(execute).not.toHaveBeenCalled();
      const original=await first.normalize(sources[0],opts);
      expect(original.cacheHit).toBe(false);
      const recipe={resolution:100,streams:[{sourceStream:0,cacheKey:original.cacheKey}]},peaks=Float32Array.of(-.25,.75);
      await first.displayPeaks(sources[0],{...recipe,peaks});
      const vocalRecipe=async source=>JSON.stringify([1,'a'.repeat(64),'b'.repeat(64),44100,100,
        await vocalSourceFingerprint(source),2,[0]]);
      const vocals=Float32Array.from({length:400},(_,i)=>i%2?0.75:-0.25);
      expect(await accessVocalPeaks({path:sources[0],descriptor:await vocalRecipe(sources[0]),peaks:vocals},
        runtimes[0].withAudioEffectCache)).toBe(true);
      const report=await first.analyze(sources[0]),pcm=fs.readFileSync(original.outputPath);
      await runtimes.pop().close();
      fs.renameSync(mounts[0],mounts[1]);execute.mockClear();
      // Some read-only SMB exports reject mkdir even when the directory exists.
      const writes=[];
      for(const [api,name] of [[fs,'mkdirSync'],[fs,'openSync'],[fs.promises,'open']]){
        const original=api[name];
        vi.spyOn(api,name).mockImplementation((file,...args)=>{
          if(typeof file==='string' && file.startsWith(mounts[1]) && (name==='mkdirSync'||/[wa+]/.test(args[0]))){
            writes.push(file);throw Object.assign(new Error('NAS 唯讀'),{code:'EROFS'});
          }
          return original.call(api,file,...args);
        });
      }
      const second=open(sources[1]),warm=await second.normalize(sources[1],opts);
      expect(warm.cacheHit).toBe(true);
      expect(warm.sourceFingerprint).not.toBe(original.sourceFingerprint);
      expect(warm.sourceFingerprint).toBe(await motherSourceFingerprint(sources[1]));
      expect(fs.readFileSync(warm.outputPath)).toEqual(pcm);
      expect(await second.analyze(sources[1])).toEqual(report);
      expect((await second.displayPeaks(sources[1],recipe)).peaks).toEqual(peaks);
      expect(await accessVocalPeaks({path:sources[1],descriptor:await vocalRecipe(sources[1])},
        runtimes[0].withAudioEffectCache)).toEqual(vocals);
      expect(execute).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      const info=await runtimes[0].cacheInfo(sources[1],{sourceOnly:true});
      expect(info.source.locations).toEqual(expect.arrayContaining([expect.objectContaining({audioEffects:true})]));
    }finally{
      await Promise.all(runtimes.map(runtime=>runtime.close()));vi.restoreAllMocks();
      if(path.dirname(root)!==fs.realpathSync(tmpdir())||!path.basename(root).startsWith('subtool-effect-nas-'))throw new Error('測試目錄衝突');
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
  it('以同一遍產生預聽及真實逐聲道波形，重啟重用兩者、精準報告和顯示峰值',async()=>{
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-normalization-hot-'));
    try{
      const source=path.join(directory,'stereo.wav'),outdir=path.join(directory,'.subtool_Cache','source-bucket','audio-effects');
      fs.mkdirSync(outdir,{recursive:true});
      const run=args=>{
        const r=spawnSync(FFMPEG,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:8*1024*1024});
        expect(r.status,r.stderr?.toString()).toBe(0);return r.stdout;
      };
      const generate=f=>run(['-y','-f','lavfi','-i',`aevalsrc=0.1*sin(2*PI*${f}*t)|0.04*sin(2*PI*890*t):s=48000:d=2.5`,'-c:a','pcm_s16le',source]);
      const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>directory});
      const jobs=[],probe=createMediaProbe({executable:FFPROBE});
      const {api,fingerprintSource}=sourceEvidenceBridge(source);
      const make=(cached)=>createAudioNormalizationRuntime({createTempPath:()=>path.join(directory,'old-preview.wav'),
        execute:(args,options)=>{jobs.push(options.jobId);return execution.execute(args,{...options,executionKind:'direct'});},
        probe:(file,options)=>probe.describe(file,options),fingerprintSource,
        ...(cached?{withEffectCache:(_src,work)=>work({directory:outdir,verify(){}}),grantRead(){}}:{})});
      const options={maximumAmplitude:-3,targetLoudness:-14,sourceStream:0};
      generate(440);
      const baseline=await make(false).normalize(source,options);
      jobs.length=0;
      const cold=await make(true).normalize(source,options);
      const evidence=await api.audioSourceFingerprint(source);
      expect(cold.sourceFingerprint).toBe(evidence);
      expect(await api.vocalWaveFingerprint(source)).not.toBe(evidence);
      expect(jobs).toEqual(['loudnorm-p1','loudnorm-p2']);
      expect(cold.cacheHit).toBe(false);
      const pcm=(src,rate)=>run(['-i',src,...(rate?['-ar',String(rate)]:[]),'-c:a','pcm_s16le','-f','s16le','pipe:1']);
      expect(pcm(cold.outputPath).equals(pcm(baseline.outputPath))).toBe(true);
      expect(pcm(cold.wavePath).equals(pcm(baseline.outputPath,4000))).toBe(true);
      const picks={resolution:100,streams:[{sourceStream:0,cacheKey:cold.cacheKey}]};
      const peaks=Float32Array.of(-.75,.25,-.125,.5);
      await make(true).displayPeaks(source,{...picks,peaks});
      const mixed=await make(true).analyze(source);
      jobs.length=0;
      const reopened=make(true),warm=await reopened.normalize(source,options);
      expect(warm).toMatchObject({cacheHit:true,outputPath:cold.outputPath,wavePath:cold.wavePath,report:cold.report,
        sourceFingerprint:await api.audioSourceFingerprint(source)});
      expect(await reopened.analyze(source)).toEqual(mixed);
      expect((await reopened.displayPeaks(source,picks)).peaks).toEqual(peaks);
      expect((await reopened.displayPeaks(source,{...picks,channel:{sourceStream:0,sourceChannel:1}})).peaks).toBeNull();
      expect(jobs).toHaveLength(0);
      fs.truncateSync(cold.wavePath,1024);
      expect((await reopened.normalize(source,options)).cacheHit).toBe(false);
      jobs.length=0;generate(660);
      expect((await reopened.normalize(source,options)).cacheKey).not.toBe(cold.cacheKey);
      expect((await reopened.displayPeaks(source,picks)).peaks).toBeNull();
      expect(jobs).toEqual(['loudnorm-p1','loudnorm-p2']);
    }finally{
      if(path.dirname(directory)!==fs.realpathSync(tmpdir())||!path.basename(directory).startsWith('subtool-normalization-hot-'))throw new Error('快取測試目錄衝突');
      fs.rmSync(directory,{recursive:true,force:true});
    }
  },30000);
  it.each([false,true])('獨占 handle 產出 %s 模式 WAV 可 seek 且保留選取 stream 與來源時鐘',async isTruePeak=>{
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-normalization-clock-native-'));
    const source=path.join(directory,'multiple.mkv');
    const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>directory});
    const probe=createMediaProbe({executable:FFPROBE});
    const owner=createMediaIntakeRuntime({tempRoot:directory,cacheRoot:directory,
      fileAuthority:new FileAuthority({internalDirectories:[directory]})});
    const run=args=>{
      const result=spawnSync(FFMPEG,['-hide_banner','-nostdin','-loglevel','error',...args],
        {windowsHide:true,timeout:20000,maxBuffer:2*1024*1024});
      expect(result.error||result.status,result.stderr?.toString()).toBe(0);return result.stdout;
    };
    let serial=0;
    const makeRuntime=owned=>createAudioNormalizationRuntime({
      createTempPath:()=>path.join(directory,`preview-${serial++}.wav`),
      execute:(args,options)=>execution.execute(args,{...options,executionKind:'direct'}),
      probe:(file,options)=>probe.describe(file,options),fingerprintSource:motherSourceFingerprint,
      ...(owned?{produceTemporaryFile:(file,work)=>owner.produceTemporaryFile(file,work),
        withTemporaryDescriptor:(file,expected,work)=>owner.withTemporaryDescriptor(file,expected,work)}:{}),
      removeFile:file=>fs.promises.unlink(file),
    });
    try{
      run(['-y','-itsoffset','0.5','-f','lavfi','-i','color=red:s=64x48:r=10:d=2',
        '-itsoffset','1.5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1',
        '-itsoffset','0','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2.5',
        '-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','libx264','-c:a','pcm_s16le',source]);
      const options={isTruePeak,sourceStream:0,maximumAmplitude:-6,targetLoudness:-12};
      const expected=await makeRuntime(false).normalize(source,options);
      const actual=await makeRuntime(true).normalize(source,options);
      const decode=file=>run(['-i',file,'-ar','4000','-ac','1','-f','f32le','pipe:1']);
      const first=decode(expected.outputPath),second=decode(actual.outputPath);
      expect(second).toEqual(first);
      expect(second.length/4).toBe(8000);
      expect(amplitude(second,440,.1,.8)).toBeLessThan(.001);
      expect(amplitude(second,440,1.2,1.8)).toBeGreaterThan(.01);
      expect(amplitude(second,880,1.2,1.8)).toBeLessThan(.005);
      const stat=fs.statSync(actual.outputPath),header=fs.readFileSync(actual.outputPath).subarray(0,12);
      expect(header.toString('ascii',0,4)).toBe('RIFF');expect(header.toString('ascii',8,12)).toBe('WAVE');
      expect(header.readUInt32LE(4)+8).toBe(stat.size);
    }finally{
      await owner.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();
      const resolved=fs.realpathSync(directory);
      if(path.dirname(resolved)!==fs.realpathSync(tmpdir())||!path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除平衡化測試目錄外的資料');
      fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  },30000);
  it.each([1,2])('多 stream 分析含 %s 聲道靜音與另一條有聲 mono，依全部原始聲道平均量測',async silentChannels=>{
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-normalization-clock-native-'));
    const source=path.join(directory,'multiple.mkv');
    const probe=createMediaProbe({executable:FFPROBE});
    const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>directory});
    const runtime=createAudioNormalizationRuntime({createTempPath:()=> 'unused.wav',
      probe:(file,options)=>probe.describe(file,options),
      execute:(args,options)=>execution.execute(args,{...options,executionKind:'direct'})});
    try{
      const generated=spawnSync(FFMPEG,['-hide_banner','-nostdin','-loglevel','error','-y','-f','lavfi','-i',
        `anullsrc=r=48000:cl=${silentChannels===1?'mono':'stereo'}:d=1`,'-f','lavfi','-i',
        'sine=frequency=440:sample_rate=48000:duration=1','-map','0:a:0','-map','1:a:0','-c:a','pcm_s16le',source],
      {windowsHide:true,timeout:20000});
      expect(generated.error||generated.status,generated.stderr?.toString()).toBe(0);
      const report=await runtime.analyze(source,{duration:1});
      expect(report.isSilence).toBe(false);
      expect(report.maxDb).toBeCloseTo(20*Math.log10(.125/(silentChannels+1)),0);
      expect(report.meanDb).toBeGreaterThan(-40);
    }finally{
      await execution.cancelAllAndWait();await probe.cancelAllAndWait();
      const resolved=fs.realpathSync(directory);
      if(path.dirname(resolved)!==fs.realpathSync(tmpdir())||!path.basename(resolved).startsWith('subtool-normalization-clock-native-'))throw new Error('拒絕清除未核對的量測測試目錄');
      fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  },30000);

  it.each([false,true].flatMap(isTruePeak=>[[.1,-80],[1,-80],[1,-72]].map(([duration,peakDb])=>({isTruePeak,duration,peakDb}))))
  ('$isTruePeak 模式整體響度為 -inf 的 $duration 秒、峰值 $peakDb dB 底噪在預覽與交付保持原音', async ({isTruePeak,duration,peakDb}) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'low-level.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', `aevalsrc=${10 ** (peakDb / 20)}*sin(2*PI*440*t):s=48000:d=${duration}`, '-c:a', 'pcm_f32le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12, isTruePeak, inputBoost:6 });
      const sourcePcm = run(['-i', source, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBe(Math.round(duration * 48000) * 2);
      expect(preview.equals(sourcePcm), '缺少整體響度不應把低於門檻的底噪放大').toBe(true);
      expect(result.isSilence).toBe(true);
      expect(result.report.input_i).toBe('-inf');
      expect(Number(result.report.input_tp)).toBeCloseTo(peakDb, 1);
      const filter = audioLimiterFilter({ max: -6, min: -12, isTruePeak, inputBoost:6, reports: { 0: result.report } });
      expect(filter).toBe('anull');
      const delivered = run(['-i', source, '-af', `${filter},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(delivered).toEqual(sourcePcm);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('相對門檻低於 -70 但整體響度高於 -70 的實際音訊仍套用效果', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'quiet.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1,volume=-39dB', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12 });
      expect(result.isSilence).toBe(false);
      expect(Number(result.report.input_i)).toBeGreaterThan(-70);
      expect(Number(result.report.input_thresh)).toBeLessThan(-70);
      const filter = audioLimiterFilter({ max: -6, min: -12, reports: { 0: result.report } });
      const sourcePcm = run(['-i', source, '-f', 's16le', 'pipe:1']);
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', `${filter},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBe(sourcePcm.length);
      expect(preview).not.toEqual(sourcePcm);
      expect(delivered).toEqual(preview);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it.each([false,true])('%s 模式 100ms 可聽短音的整體響度為 -inf 時，預覽與交付仍處理實際峰值', async isTruePeak => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'short.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    let pass1Stderr = '';
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct', onStderr: chunk => {
        if (options.jobId === 'loudnorm-p1') pass1Stderr += chunk;
        options.onStderr?.(chunk);
      } }),
      removeFile: file => fs.promises.unlink(file),
    });
    const options = { isTruePeak, maximumAmplitude: -6, targetLoudness: -12, inputBoost:6 };
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1,volume=8', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, options);
      expect(pass1Stderr).toMatch(/"input_i"\s*:\s*"-inf"/);
      expect(pass1Stderr).toMatch(/"input_tp"\s*:\s*"-0\.00"/);
      expect(result.isSilence).toBe(false);
      expect(result.report).toBeNull();
      const analysis = await runtime.analyze(source);
      expect(analysis.maxDb).toBeGreaterThan(-1);
      expect(analysis.meanDb).toBeGreaterThan(-5);
      expect(analysis.isSilence).toBe(false);
      expect(analysis.meanSource).toBe('volumedetect');
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', `${audioLimiterFilter(options)},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBeGreaterThan(0);
      expect(delivered).toEqual(preview);
      let peak = 0;
      for (let offset = 0; offset < preview.length; offset += 2) peak = Math.max(peak, Math.abs(preview.readInt16LE(offset)) / 32768);
      expect(peak).toBeGreaterThan(.1);
      expect(peak).toBeLessThan(.55);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('實際靜音量測的 inf 偏移可保存，使預覽與交付均維持靜音保護', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'silence.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, 'preview.wav'),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    try {
      run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-c:a', 'pcm_s16le', source]);
      const result = await runtime.normalize(source, { maximumAmplitude: -6, targetLoudness: -12 });
      expect(result.isSilence).toBe(true);
      expect(result.report).toMatchObject({ input_i: '-inf', input_tp: '-inf', target_offset: 'inf' });
      const filter = audioLimiterFilter({ max: -6, min: -12, reports: { 0: result.report } });
      expect(filter).toBe('anull');
      const preview = run(['-i', result.outputPath, '-f', 'f32le', 'pipe:1']);
      const delivered = run(['-i', source, '-af', filter, '-f', 'f32le', 'pipe:1']);
      expect(preview.length).toBe(48000 * 4);
      expect(delivered).toEqual(preview);
      for (let offset = 0; offset < delivered.length; offset += 4) expect(delivered.readFloatLE(offset)).toBe(0);
    } finally {
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('第一遍輸出報告後失敗時，實際 PCM 與單遍交付濾鏡一致', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const source = path.join(directory, 'mother.wav');
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    let pass1Stderr = '';
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, 'processed.wav'),
      execute: async (args, options) => {
        const result = await execution.execute(args, {
          ...options, executionKind: 'direct', onStderr: chunk => {
            options.onStderr?.(chunk);
            if (options.jobId === 'loudnorm-p1') pass1Stderr += chunk;
          },
        });
        if (options.jobId === 'loudnorm-p1') throw new Error('injected failure after actual FFmpeg report');
        return result;
      },
      removeFile: file => fs.promises.unlink(file),
    });
    const options = { isTruePeak: true, maximumAmplitude: -6, targetLoudness: -12 };
    const originalWarn = console.warn;
    try {
      run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', source]);
      console.warn = () => {};
      const result = await runtime.normalize(source, options);
      expect(pass1Stderr).toContain('target_offset');
      expect(result.report).toBeNull();
      const preview = run(['-i', result.outputPath, '-f', 's16le', 'pipe:1']);
      const delivery = run(['-i', source, '-af', `${audioLimiterFilter(options)},aresample=48000:async=1:first_pts=0`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
      expect(preview.length).toBeGreaterThan(0);
      expect(preview).toEqual(delivery);
    } finally {
      console.warn = originalWarn;
      await execution.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it.each([1, 7, 50])('Peak 預先讀取 %s ms：預覽、重做與交付濾鏡保留首尾脈衝樣本', async lookAheadTime => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const rate = 48000, pulseSamples = [0, 24000, 47999], input = Buffer.alloc(rate * 4);
    for (const sample of pulseSamples) input.writeFloatLE(.125, sample * 4);
    const run = (args, bytes) => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        input: bytes, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const source = path.join(directory, 'impulses.wav'), probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    let serial = 0;
    const runtime = createAudioNormalizationRuntime({
      createTempPath: () => path.join(directory, `processed-${serial++}.wav`),
      probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file),
    });
    const expectPulses = bytes => {
      expect(bytes.length / 4).toBe(rate);
      const actual = [];
      for (let sample = 0; sample < rate; sample++) {
        if (Math.abs(bytes.readFloatLE(sample * 4)) > .01) actual.push(sample);
      }
      expect(actual).toEqual(pulseSamples);
      for (const sample of pulseSamples) expect(bytes.readFloatLE(sample * 4)).toBeCloseTo(.125, 4);
    };
    const options = { isTruePeak: false, inputBoost: 0, maximumAmplitude: -6, lookAheadTime };
    const decode = file => run(['-i', file, '-f', 'f32le', 'pipe:1']);
    try {
      run(['-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s16le', source], input);
      const first = await runtime.normalize(source, options);
      expectPulses(decode(first.outputPath));
      const second = await runtime.normalize(first.outputPath, options);
      expectPulses(decode(second.outputPath));
      expectPulses(run(['-i', source, '-af', audioLimiterFilter(options), '-f', 'f32le', 'pipe:1']));
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([0, 5])('容器原點 %s：Peak／True Peak／無聲／指定 delayed stream／再處理保持來源秒數', async origin => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-normalization-clock-native-'));
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0); return result.stdout;
    };
    const source = path.join(directory, 'mother.mkv'), probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    let serial = 0;
    const runtime = createAudioNormalizationRuntime({ createTempPath: () => path.join(directory, `processed-${serial++}.wav`),
      probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
      removeFile: file => fs.promises.unlink(file) });
    const decode = file => run(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1']);
    const expectSourceClock = bytes => {
      expect(bytes.length / 4 / 4000).toBe(3);
      const wanted = amplitude(bytes, 880);
      expect(wanted).toBeGreaterThan(.02); expect(amplitude(bytes, 440)).toBeLessThan(wanted * .04);
    };
    try {
      run(['-y', '-itsoffset', String(origin + .5), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
        '-itsoffset', String(origin), '-f', 'lavfi', '-i',
        'aevalsrc=if(lt(t\\,1)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=3.5',
        '-itsoffset', String(origin + 1.5), '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2',
        '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3.5',
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:a:0',
        '-c:v', 'libx264', '-fps_mode:v', 'passthrough', '-c:a', 'pcm_s16le', source]);
      for (const isTruePeak of [false, true]) {
        const first = await runtime.normalize(source, { sourceStream: 0, isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        expectSourceClock(decode(first.outputPath));
        const second = await runtime.normalize(first.outputPath, { isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        expectSourceClock(decode(second.outputPath));
        expect((await probe.describe(second.outputPath)).audio[0].timestampOffset).toBe(0);
        const delayed = await runtime.normalize(source, { sourceStream: 1, isTruePeak, maximumAmplitude: -3, targetLoudness: -14 });
        const pcm = decode(delayed.outputPath);
        expect(pcm.length / 4 / 4000).toBe(3);
        expect(amplitude(pcm, 660, .2, .8)).toBeLessThan(.00001);
        expect(amplitude(pcm, 660, 1.12, 1.28)).toBeGreaterThan(.02);
      }
      const silent = await runtime.normalize(source, { sourceStream: 2, isTruePeak: true, silenceProtection: true });
      expect(silent.isSilence).toBe(true); const silence = decode(silent.outputPath);
      expect(silence.length / 4 / 4000).toBe(3);
      for (let index = 0; index < silence.length; index += 4) expect(silence.readFloatLE(index)).toBe(0);
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-normalization-clock-native-')) throw new Error('拒絕清除未核對的平衡化時鐘測試目錄');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
});

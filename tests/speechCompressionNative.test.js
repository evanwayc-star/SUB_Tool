// @subtool-ci windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {afterEach,expect,it} from 'vitest';
import {nativeTestTools} from './fixtures/native-tools.cjs';

const require=createRequire(import.meta.url);
const {createSpeechAudioCompressor,createSpeechCompressionRuntime}=require('../electron/speech-audio-compressor.js');
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const {createFFmpegExecution}=require('../electron/ffmpeg-execution-engine.js');
const {FileAuthority}=require('../electron/file-authority.js');
const {ffmpeg}=nativeTestTools();
const roots=[];
afterEach(()=>{
  for(const root of roots.splice(0)){
    const real=fs.realpathSync(root);
    if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-speech-native-'))
      throw new Error('拒絕清理測試根目錄以外的資料');
    fs.rmSync(real,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
function wav(seconds=1){
  const frames=16000*seconds,data=Buffer.alloc(44+frames*2);
  data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);
  data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)data.writeInt16LE(Math.round(16000*Math.sin(2*Math.PI*440*i/16000)),44+i*2);
  return data;
}
function setup({onProcess=null}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-speech-native-'));roots.push(root);
  let seq=0;
  const execution=createFFmpegExecution({getFFmpegPath:()=>ffmpeg,getUserDataDir:()=>root});
  const intake=createMediaIntakeRuntime({tempRoot:root,cacheRoot:path.join(root,'cache'),allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[root]}),ffmpegExecution:execution});
  const compressor=createSpeechAudioCompressor({
    createTempPath:ext=>path.join(root,`speech-${seq++}.${ext}`),
    produceTemporaryFile:(file,work)=>intake.produceTemporaryFile(file,work),
    withTemporaryDescriptor:(file,owner,work)=>intake.withTemporaryDescriptor(file,owner,work),
    assertTemporaryOutput:(file,owner)=>intake.assertTemporaryOutput(file,owner),
    cleanupGeneratedFile:file=>intake.cleanupGeneratedFile(file),
    execute:(args,options)=>execution.execute(args,{...options,onProcess:child=>{options.onProcess?.(child);onProcess?.(child);}}),
  });
  return {root,execution,intake,compressor};
}

it.skipIf(!fs.existsSync(ffmpeg))('受控 fd 的真 FFmpeg MP3 保留辨識音訊頻率與時長',async()=>{
  const fixture=setup();
  try{
    const result=await fixture.compressor.compress(wav());
    const mp3=Buffer.from(result.b64,'base64');
    expect(result).toMatchObject({type:'audio/mpeg',name:'audio.mp3',size:mp3.length});
    const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','mp3','-i','pipe:0',
      '-f','s16le','-ac','1','-ar','16000','pipe:1'],{input:mp3,windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
    expect(decoded.error||decoded.status,decoded.stderr?.toString()).toBe(0);
    const samples=decoded.stdout.length/2;
    expect(samples).toBeGreaterThanOrEqual(16000);expect(samples).toBeLessThan(18400);
    let crossings=0,peak=0;
    for(let i=1601;i<Math.min(samples-1600,14400);i++){
      const a=decoded.stdout.readInt16LE((i-1)*2),b=decoded.stdout.readInt16LE(i*2);
      if(a<0&&b>=0)crossings++;peak=Math.max(peak,Math.abs(b));
    }
    expect(peak).toBeGreaterThan(3000);
    const seconds=(Math.min(samples-1600,14400)-1601)/16000;
    expect(crossings/seconds).toBeGreaterThan(435);expect(crossings/seconds).toBeLessThan(445);
    expect(fs.readdirSync(fixture.root).filter(name=>/^speech-\d+\.(wav|mp3)$/.test(name))).toEqual([]);
  }finally{await fixture.intake.close();await fixture.execution.cancelAllAndWait();}
},30000);

it.skipIf(!fs.existsSync(ffmpeg))('取消真 FFmpeg 時等待 child close 後才清理受控輸入與輸出',async()=>{
  let speechRuntime,closed=false;
  const fixture=setup({onProcess:child=>{
    child.once('close',()=>{closed=true;});speechRuntime.cancel('speech-native-cancel');
  }});
  speechRuntime=createSpeechCompressionRuntime({compressor:fixture.compressor});
  try{
    await expect(speechRuntime.compress(wav(10),'speech-native-cancel')).rejects.toThrow();
    expect(closed).toBe(true);expect(speechRuntime.activeCount()).toBe(0);
    expect(fs.readdirSync(fixture.root).filter(name=>/^speech-\d+\.(wav|mp3)$/.test(name))).toEqual([]);
  }finally{await fixture.intake.close();await fixture.execution.cancelAllAndWait();}
},30000);

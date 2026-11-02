import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createSpeechAudioCompressor, createSpeechCompressionRuntime } = require('../electron/speech-audio-compressor.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { parse } = require('acorn');
const ExportLease = require('../electron/export-lease.js');
const roots=[];
function wav() {
  const data=Buffer.alloc(44+320);
  data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);
  data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(320,40);return data;
}
function setup() {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-speech-owner-'));roots.push(root);
  const input=path.join(root,'speech.wav'),output=path.join(root,'speech.mp3');
  return {root,input,output};
}
afterEach(()=>{
  for(const root of roots.splice(0)){
    const real=fs.realpathSync(root);
    if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-speech-owner-'))
      throw new Error('拒絕清理測試根目錄以外的資料');
    fs.rmSync(real,{recursive:true,force:true});
  }
});
function compressorFor({root,input,output,execute,withDescriptor,cleanup,allocations=[]}) {
  const runtime=createMediaIntakeRuntime({tempRoot:root,cacheRoot:path.join(root,'cache'),allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[root]}),ffmpegExecution:{execute:async()=>{}}});
  return createSpeechAudioCompressor({
    createTempPath:ext=>{allocations.push(ext);return ext==='wav'?input:output;},
    produceTemporaryFile:(file,work)=>runtime.produceTemporaryFile(file,work),
    withTemporaryDescriptor:(file,owner,work)=>withDescriptor?withDescriptor(runtime,file,owner,work):runtime.withTemporaryDescriptor(file,owner,work),
    assertTemporaryOutput:(file,owner)=>runtime.assertTemporaryOutput(file,owner),
    cleanupGeneratedFile:file=>cleanup?cleanup(runtime,file):runtime.cleanupGeneratedFile(file),
    execute,
  });
}

it('不建立輸入暫存檔，也不動同名外部檔案',async()=>{
  const files=setup();fs.writeFileSync(files.input,'foreign input');
  const allocations=[];
  const compressor=compressorFor({...files,allocations,execute:async(_args,{inputBytes,outputDescriptor})=>{
    expect(inputBytes.equals(wav())).toBe(true);fs.writeSync(outputDescriptor,Buffer.from('encoded'));
  }});
  await compressor.compress(wav());
  expect(allocations).toEqual(['mp3']);
  expect(fs.readFileSync(files.input,'utf8')).toBe('foreign input');
});

it('輸出暫存路徑被其他檔案佔用時不覆寫也不刪除',async()=>{
  const files=setup();fs.writeFileSync(files.output,'foreign output');
  const compressor=compressorFor({...files,execute:async(_args,{outputDescriptor})=>{fs.writeSync(outputDescriptor,Buffer.from('encoded'));}});
  await expect(compressor.compress(wav())).rejects.toThrow();
  expect(fs.readFileSync(files.output,'utf8')).toBe('foreign output');
});

it.each(['output'])('%s 預留後被替換時拒絕轉檔並保留外部檔案',async kind=>{
  const files=setup();let executed=false,replaced=false;
  const compressor=compressorFor({...files,
    withDescriptor:async(runtime,file,owner,work)=>{
      if(file===files[kind]&&!replaced){
        replaced=true;fs.renameSync(file,`${file}.previous`);fs.writeFileSync(file,`foreign ${kind}`);
      }
      return runtime.withTemporaryDescriptor(file,owner,work);
    },execute:async()=>{executed=true;}});
  await expect(compressor.compress(wav())).rejects.toThrow();
  expect(executed).toBe(false);
  expect(fs.readFileSync(files[kind],'utf8')).toBe(`foreign ${kind}`);
});

it('成功寫入後的清理若遇同名新檔，不刪除該新檔',async()=>{
  const files=setup();let replaced=false;
  const compressor=compressorFor({...files,
    execute:async(_args,{outputDescriptor})=>{fs.writeSync(outputDescriptor,Buffer.from('encoded'));},
    cleanup:(runtime,file)=>{
      if(file===files.output&&!replaced){
        replaced=true;fs.renameSync(file,`${file}.previous`);fs.writeFileSync(file,'foreign output');
      }
      return runtime.cleanupGeneratedFile(file);
    }});
  const result=await compressor.compress(wav());
  expect(Buffer.from(result.b64,'base64').toString()).toBe('encoded');
  expect(fs.readFileSync(files.output,'utf8')).toBe('foreign output');
});

it.each([false,true])('FFmpeg 執行期間 caller 修改原始 WAV，取消=%s 時不影響凍結輸入',async cancelled=>{
  const files=setup();let started,release,observed;const original=wav();
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const compressor=compressorFor({...files,execute:async(_args,options)=>{
    options.onProcess?.({killed:false,kill(){}});
    started();await gate;
    observed=options.inputBytes[44];
    fs.writeSync(options.outputDescriptor,Buffer.from('mp3 derived from '+observed));
  }});
  const runtime=createSpeechCompressionRuntime({compressor});
  const work=runtime.compress(original,'speech-same-inode');
  await ready;
  original[44]=73;
  if(cancelled)expect(runtime.cancel('speech-same-inode')).toBe(true);
  release();
  const outcome=await work.then(result=>({result}),error=>({error}));
  expect(observed).toBe(0);
  if(cancelled) expect(outcome.error).toBeDefined();
  else expect(Buffer.from(outcome.result.b64,'base64').toString()).toBe('mp3 derived from 0');
  expect(fs.existsSync(files.input)).toBe(false);
});

it('輸出未能預留且沒有輸入暫存；真 main quit 保留外部檔案',async()=>{
  const files=setup(),tempFiles=new Set(),owner=ExportLease.captureOutputDirectory(files.root);
  fs.writeFileSync(files.output,'foreign output');
  const runtime=createMediaIntakeRuntime({tempRoot:files.root,tempRootAuthority:owner,cacheRoot:path.join(files.root,'cache'),allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[files.root]}),forgetTemporaryFile:file=>tempFiles.delete(file),ffmpegExecution:{execute:async()=>{}}});
  const allocations=[];
  const compressor=createSpeechAudioCompressor({
    createTempPath:ext=>{allocations.push(ext);const file=ext==='wav'?files.input:files.output;tempFiles.add(file);return file;},
    produceTemporaryFile:(file,work)=>runtime.produceTemporaryFile(file,work),
    withTemporaryDescriptor:(file,expected,work)=>runtime.withTemporaryDescriptor(file,expected,work),
    assertTemporaryOutput:(file,expected)=>runtime.assertTemporaryOutput(file,expected),
    cleanupGeneratedFile:file=>runtime.cleanupGeneratedFile(file),execute:async()=>{throw new Error('不應啟動');},
  });
  await expect(compressor.compress(wav())).rejects.toThrow();
  expect(allocations).toEqual(['mp3']);expect(tempFiles.has(files.output)).toBe(false);
  fs.writeFileSync(files.input,'foreign later');
  const main=fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
  const tree=parse(main,{ecmaVersion:'latest',sourceType:'script'});
  const registration=tree.body.find(node=>node.expression?.callee?.object?.name==='app'
    &&node.expression?.callee?.property?.name==='on'&&node.expression?.arguments?.[0]?.value==='quit');
  expect(registration).toBeTruthy();let quit;
  vm.runInNewContext(main.slice(registration.start,registration.end),{
    app:{on:(_event,callback)=>{quit=callback;}},mpvHost:{dispose(){}},mediaIntakeRuntime:runtime,
    tempFiles,TMP:files.root,TMP_OWNER:owner,ExportLease,path,fs,
  });
  quit();
  expect(fs.readFileSync(files.input,'utf8')).toBe('foreign later');
  expect(fs.readFileSync(files.output,'utf8')).toBe('foreign output');
});

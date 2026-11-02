import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {afterEach,expect,it} from 'vitest';

const require=createRequire(import.meta.url);
const {parse}=require('acorn');
const {FileAuthority}=require('../electron/file-authority.js');
const {createMediaIntakeRuntime}=require('../electron/media-intake-runtime.js');
const {createSpeechAudioCompressor,createSpeechCompressionRuntime}=require('../electron/speech-audio-compressor.js');
const roots=[];
afterEach(()=>{
  for(const root of roots.splice(0)){
    const real=fs.realpathSync(root);
    if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('subtool-speech-ipc-'))
      throw new Error('拒絕清理測試根目錄以外的資料');
    fs.rmSync(real,{recursive:true,force:true});
  }
});
function wav(){
  const data=Buffer.alloc(44+320);data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);
  data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(320,40);
  return data;
}
function setup({occupied=false}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-speech-ipc-'));roots.push(root);
  const paths=[],tempFiles=new Set();let seq=0;
  const runtime=createMediaIntakeRuntime({tempRoot:root,cacheRoot:path.join(root,'cache'),allowSidecarCache:false,
    fileAuthority:new FileAuthority({internalDirectories:[root]}),forgetTemporaryFile:file=>tempFiles.delete(file),ffmpegExecution:{execute:async()=>{}}});
  const tmpPath=extension=>{const file=path.join(root,`speech-${seq++}.${extension}`);paths.push(file);tempFiles.add(file);
    if(occupied&&extension==='mp3')fs.writeFileSync(file,'foreign output');return file;};
  const received=[];
  const runFF=async(args,options)=>{
    expect(args).toContain('pipe:0');expect(args).toContain('fd:');expect(options.inputDescriptor).toBeUndefined();
    expect(options.outputDescriptor).toBeGreaterThanOrEqual(3);
    received.push(Buffer.from(options.inputBytes));fs.writeSync(options.outputDescriptor,Buffer.from('encoded mp3'));
  };
  const source=fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const selected=ast.body.filter(node=>
    (node.type==='VariableDeclaration'&&node.declarations.some(declaration=>['speechAudioCompressor','speechCompressionRuntime'].includes(declaration.id?.name)))||
    (node.type==='ExpressionStatement'&&node.expression?.callee?.object?.name==='ipcMain'&&node.expression.callee.property?.name==='handle'
      &&['speech:compressAudio','speech:cancelCompression'].includes(node.expression.arguments[0]?.value)));
  const handlers=new Map();
  vm.runInNewContext(selected.map(node=>source.slice(node.start,node.end)).join('\n'),{
    createSpeechAudioCompressor,createSpeechCompressionRuntime,mediaIntakeRuntime:runtime,tmpPath,runFF,FFMPEG:'fake',
    ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)},
  });
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(),'electron/preload.js'),'utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},
      ipcRenderer:{invoke:(channel,...args)=>Promise.resolve().then(()=>handlers.get(channel)({sender:{}},...args)),on(){},send(){}},webUtils:{}}),
    ArrayBuffer,Uint8Array,Promise,TypeError,RangeError,
  });
  return {root,paths,tempFiles,api,received};
}

it('真 preload→main 壓縮入口以凍結 WAV 與輸出 owner fd 壓縮並清理暫存',async()=>{
  const fixture=setup(),input=wav();
  const result=await fixture.api.compressSpeechAudio(new Uint8Array(input),'speech-ipc-owner');
  expect(fixture.received).toHaveLength(1);expect(fixture.received[0].equals(input)).toBe(true);
  expect(Buffer.from(result.b64,'base64').toString()).toBe('encoded mp3');
  expect(fixture.paths).toHaveLength(1);expect(fixture.tempFiles.size).toBe(0);
  expect(fixture.paths.every(file=>!fs.existsSync(file))).toBe(true);
});

it('真 preload→main 壓縮入口遇到輸出預佔時保留外部檔且不啟動',async()=>{
  const fixture=setup({occupied:true});
  await expect(fixture.api.compressSpeechAudio(new Uint8Array(wav()),'speech-ipc-occupied')).rejects.toThrow();
  expect(fixture.paths).toHaveLength(1);expect(fixture.received).toHaveLength(0);
  expect(fs.readFileSync(fixture.paths[0],'utf8')).toBe('foreign output');
  expect(fixture.tempFiles.size).toBe(0);
});

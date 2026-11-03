import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);
const { createAudioNormalizationRuntime }=require('../electron/audio-normalization-runtime.js');
const { createMediaIntakeRuntime }=require('../electron/media-intake-runtime.js');
const { FileAuthority }=require('../electron/file-authority.js');
const { motherSourceFingerprint }=require('../electron/mother-source-evidence.js');
const measured=(options)=>{
  if(options.jobId!=='loudnorm-p1')return false;
  options.onStderr(JSON.stringify({input_i:'-22',input_tp:'-2',input_lra:'0',input_thresh:'-32',target_offset:'0'}));
  return true;
};
const roots=[];
afterEach(()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0)){
    const resolved=fs.realpathSync(root);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('subtool-normalize-owner-')) throw new Error('拒絕清除測試目錄外的資料');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
function fixture({probe,execute,fingerprintSource}={}){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-normalize-owner-'));roots.push(dir);
  const output=path.join(dir,'preview.wav'),reserved=new Set([output]);
  const owner=createMediaIntakeRuntime({tempRoot:dir,cacheRoot:dir,
    fileAuthority:new FileAuthority({internalDirectories:[dir]}),forgetTemporaryFile:file=>reserved.delete(file)});
  const write=execute||vi.fn(async(args,options)=>{
    if(measured(options))return;
    if(Number.isInteger(options.outputDescriptor)) fs.writeSync(options.outputDescriptor,Buffer.from('owned wav'));
    else fs.writeFileSync(args.at(-1),'owned wav');
  });
  const runtime=createAudioNormalizationRuntime({createTempPath:()=>output,execute:write,probe,fingerprintSource,
    produceTemporaryFile:(file,action)=>owner.produceTemporaryFile(file,action),
    withTemporaryDescriptor:(file,expected,action)=>owner.withTemporaryDescriptor(file,expected,action),
    removeFile:async file=>fs.promises.unlink(file)});
  return {dir,output,reserved,runtime,write};
}

describe('音訊平衡化私有輸出的實際檔案歸屬',()=>{
  it('量測期間同路徑母素材被替換，不發布舊聲量報告',async()=>{
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const f=fixture({fingerprintSource:motherSourceFingerprint,execute:async(args,options)=>{
      options.onStderr('mean_volume: -12 dB\nmax_volume: -2 dB');started();await gate;
    }});
    const source=path.join(f.dir,'source.wav');fs.writeFileSync(source,'old mother audio');
    const work=f.runtime.analyze(source);await entered;
    fs.renameSync(source,source+'.old');fs.writeFileSync(source,'new mother audio');release();
    await expect(work).rejects.toThrow(/母素材.*變更/);
    expect(fs.readFileSync(source,'utf8')).toBe('new mother audio');
  });
  it('輸出期間母素材被替換，不交付舊音訊結果',async()=>{
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    const f=fixture({fingerprintSource:motherSourceFingerprint,execute:async(args,options)=>{
      if(measured(options))return;
      fs.writeSync(options.outputDescriptor,Buffer.from('old output'));started();await gate;
    }});
    const source=path.join(f.dir,'source.wav');fs.writeFileSync(source,'old mother audio');
    const work=f.runtime.normalize(source,{isTruePeak:false});await entered;
    fs.renameSync(source,source+'.old');fs.writeFileSync(source,'new mother audio');release();
    await expect(work).rejects.toThrow(/母素材.*變更/);
    expect(fs.existsSync(f.output)).toBe(false);expect(fs.readFileSync(source,'utf8')).toBe('new mother audio');
  });
  it('同名外來檔已存在時拒絕啟動 writer，不覆寫或刪除',async()=>{
    const f=fixture();fs.writeFileSync(f.output,'foreign original');
    await expect(f.runtime.normalize('mother.wav',{isTruePeak:false})).rejects.toMatchObject({code:'EEXIST'});
    expect(f.write).not.toHaveBeenCalled();expect(fs.readFileSync(f.output,'utf8')).toBe('foreign original');
    expect(f.reserved.size).toBe(0);
  });
  it('等待 probe 時預留路徑被替換，不能啟動 writer 或刪除替代檔',async()=>{
    let resume;const entered=new Promise(resolve=>{resume=resolve;});
    const f=fixture({probe:()=>entered});
    const work=f.runtime.normalize('mother.wav',{isTruePeak:false});
    const moved=f.output+'.moved';fs.renameSync(f.output,moved);fs.writeFileSync(f.output,'foreign replacement');
    resume({duration:1});await expect(work).rejects.toThrow(/身分|變更/);
    expect(f.write).not.toHaveBeenCalled();expect(fs.readFileSync(f.output,'utf8')).toBe('foreign replacement');
    expect(fs.readFileSync(moved).length).toBe(0);expect(f.reserved.size).toBe(0);
  });
  it('第一遍完成時輸出失去所有權，不能退回單遍或啟動第二遍 writer',async()=>{
    let f;
    const execute=vi.fn(async(_args,options)=>{
      expect(measured(options)).toBe(true);
      fs.renameSync(f.output,f.output+'.moved');
      fs.writeFileSync(f.output,'foreign between passes');
    });
    f=fixture({execute});
    await expect(f.runtime.normalize('mother.wav',{isTruePeak:true})).rejects
      .toMatchObject({code:'UNSAFE_NORMALIZATION_OUTPUT'});
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.output,'utf8')).toBe('foreign between passes');
    expect(fs.statSync(f.output+'.moved').size).toBe(0);
    expect(f.reserved.size).toBe(0);
  });
  it('writer 進行時路徑換成外來檔，不能交付或刪除替代檔',async()=>{
    let f;
    const execute=vi.fn(async(args,options)=>{
      if(measured(options))return;
      if(Number.isInteger(options.outputDescriptor))fs.writeSync(options.outputDescriptor,Buffer.from('owned output'));
      else fs.writeFileSync(args.at(-1),'owned output');
      fs.renameSync(f.output,f.output+'.moved');fs.writeFileSync(f.output,'foreign after write');
    });
    f=fixture({execute});
    await expect(f.runtime.normalize('mother.wav',{isTruePeak:false})).rejects.toThrow(/身分|變更/);
    expect(fs.readFileSync(f.output,'utf8')).toBe('foreign after write');
    expect(fs.readFileSync(f.output+'.moved','utf8')).toBe('owned output');expect(f.reserved.size).toBe(0);
  });
  it('成功只寫入預留 handle 並交付該 WAV 給 caller',async()=>{
    const f=fixture();const result=await f.runtime.normalize('mother.wav',{isTruePeak:false});
    expect(f.write.mock.calls[0][1].outputDescriptor).toBeUndefined();
    const [args,options]=f.write.mock.calls.at(-1);
    expect(args.at(-1)).toBe('fd:');expect(args.slice(-3,-1)).toEqual(['-f','wav']);
    expect(Number.isInteger(options.outputDescriptor)).toBe(true);
    expect(result.outputPath).toBe(f.output);expect(fs.readFileSync(f.output,'utf8')).toBe('owned wav');
    expect(f.reserved.has(f.output)).toBe(true);
  });
  it('輸出 handle 關閉失敗時不能先發出完成狀態',async()=>{
    const progress=[];let outputDescriptor;
    const originalClose=fs.closeSync;
    const execute=vi.fn(async(args,options)=>{
      if(measured(options))return;
      outputDescriptor=options.outputDescriptor;
      fs.writeSync(outputDescriptor,Buffer.from('output'));
      vi.spyOn(fs,'closeSync').mockImplementation(fd=>{
        originalClose(fd);
        if(fd===outputDescriptor)throw new Error('close failed');
      });
    });
    const f=fixture({execute});
    await expect(f.runtime.normalize('mother.wav',{isTruePeak:false},{onProgress:event=>progress.push(event)})).rejects.toThrow('close failed');
    expect(progress.some(event=>event.stage==='done')).toBe(false);
    expect(fs.existsSync(f.output)).toBe(false);
  });
  it.each([false,true])('True Peak 的無聲保護=%s 在第二遍才寫入同一預留 handle',async isSilence=>{
    const report=isSilence
      ?{input_i:'-99',input_tp:'-99',input_thresh:'-99',target_offset:'0'}
      :{input_i:'-22',input_tp:'-2',input_lra:'0',input_thresh:'-32',target_offset:'0'};
    const execute=vi.fn(async(args,options)=>{
      if(options.jobId==='loudnorm-p1')options.onStderr(JSON.stringify(report));
      else fs.writeSync(options.outputDescriptor,Buffer.from('second pass'));
    });
    const f=fixture({execute});
    const result=await f.runtime.normalize('mother.wav',{isTruePeak:true,silenceProtection:true});
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0].at(-1)).toBe('-');
    expect(execute.mock.calls[0][1].outputDescriptor).toBeUndefined();
    expect(execute.mock.calls[1][0].at(-1)).toBe('fd:');
    expect(result.isSilence).toBe(isSilence);
    expect(fs.readFileSync(f.output,'utf8')).toBe('second pass');
  });
  it('取消正在寫入的工作時等 writer 結束，才關閉 handle 並清除本工作檔案',async()=>{
    const controller=new AbortController(),kill=vi.fn();let reject;
    const execute=vi.fn((args,options)=>{
      if(measured(options))return;
      fs.writeSync(options.outputDescriptor,Buffer.from('partial'));
      options.onProcess({kill});return new Promise((resolve,fail)=>{reject=fail;});
    });
    const f=fixture({execute});const work=f.runtime.normalize('mother.wav',{isTruePeak:false},{signal:controller.signal});
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));controller.abort();
    expect(kill).toHaveBeenCalledOnce();expect(fs.readFileSync(f.output,'utf8')).toBe('partial');
    reject(new Error('writer stopped'));await expect(work).rejects.toMatchObject({name:'AbortError'});
    expect(fs.existsSync(f.output)).toBe(false);expect(f.reserved.size).toBe(0);
  });
  it('量測後無法讀取母素材證據時保守拒絕報告',async()=>{
    const fingerprintSource=vi.fn().mockResolvedValueOnce('initial').mockRejectedValueOnce(new Error('network unavailable'));
    const f=fixture({fingerprintSource,execute:async(args,options)=>options.onStderr('mean_volume: -12 dB\nmax_volume: -2 dB')});
    await expect(f.runtime.analyze('mother.wav')).rejects.toMatchObject({code:'AUDIO_SOURCE_CHANGED'});
  });
});

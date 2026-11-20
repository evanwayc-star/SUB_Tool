/* 原音效果預聽、低取樣率波形和量測報告共用素材旁的快取。ready 最後發布；
   重新開啟時核對母素材、處理配方、輸出身分及完整 PCM 長度。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, webcrypto } = require('node:crypto');
const { promisify } = require('node:util');
const { createClipCacheArtifact } = require('./clip-cache-artifact');
const { completeWave } = require('./clip-audio-cache');
const { normalizeLimiterOptions } = require('../shared/audio-loudness.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest();
const recipeKey = (...parts) => digest(JSON.stringify(parts)).toString('hex');
const changed = () => new Error('音訊平衡快取在處理中變更');
const maxPeakBytes = 2 * 4 * 100 * 86400;
const write = promisify(fs.write);
const payloadDigest = async bytes => bytes.length < 65536 ? digest(bytes)
  : Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes));

function fileStamp(file, shared = false) {
  const stat = fs.lstatSync(file, {bigint:true});
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1n)throw changed();
  // The NAS recipe binds the server/share. Device numbers belong to each client.
  if(shared && stat.ino>0n && stat.birthtimeNs>0n && stat.mtimeNs>0n)
    return ['nas',stat.ino,stat.birthtimeNs,stat.size,stat.mtimeNs].join(':');
  return [stat.dev,stat.ino,stat.birthtimeNs,stat.size,stat.mtimeNs].join(':');
}
async function readSmallFile(file,limit,verify){
  verify();
  const before=fileStamp(file),handle=await fs.promises.open(file,'r');
  try{
    const stat=await handle.stat({bigint:true});
    if(!stat.size || stat.size>BigInt(limit) || [stat.dev,stat.ino,stat.birthtimeNs,stat.size,stat.mtimeNs].join(':')!==before)throw changed();
    const bytes=Buffer.alloc(Number(stat.size));
    for(let offset=0;offset<bytes.length;){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if(!bytesRead)throw changed();
      offset+=bytesRead;
    }
    verify();
    if(fileStamp(file)!==before)throw changed();
    return bytes;
  }finally{await handle.close();}
}

// Reading/writing bytes through the reserved descriptor keeps the pathname out of the writer.
async function writeAll(fd,bytes){
  for(let offset=0;offset<bytes.length;){
    const {bytesWritten}=await write(fd,bytes,offset,bytes.length-offset);
    if(!bytesWritten)throw new Error('無法完整寫入音訊平衡快取');
    offset+=bytesWritten;
  }
}
async function readRecord(store,limit,verify){
  for(const candidate of store.candidates()){
    try{
      const bytes=await readSmallFile(candidate.path,limit+32,()=>{verify();candidate.verify();});
      if(bytes.length>32 && (await payloadDigest(bytes.subarray(32))).equals(bytes.subarray(0,32))){
        verify();candidate.verify();return bytes.subarray(32);
      }
    }catch{/* Treat an incomplete or modified record as a miss. */}
  }
  return null;
}
async function writeRecord(store,bytes,verify){
  verify();
  const out=store.reserve();
  try{
    await writeAll(out.fd,await payloadDigest(bytes));
    await writeAll(out.fd,bytes);
    verify();out.publish();
  }finally{await out.close();}
}
function companion(artifact,name){
  artifact.verify();
  const file=path.join(path.dirname(artifact.path),name);
  const fd=fs.openSync(file,'wx+'),owner=fs.fstatSync(fd,{bigint:true});
  const verify=()=>{
    artifact.verify();
    const stat=fs.lstatSync(file,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n||stat.dev!==owner.dev||stat.ino!==owner.ino)throw changed();
  };
  try{verify();}catch(error){fs.closeSync(fd);throw error;}
  return {file,fd,verify,remove(){verify();fs.unlinkSync(file);}};
}

function createAudioEffectCache({withEffectCache,grantRead,probe,fingerprintSource,normalize,analyze}){
  async function measured(src,options={}){
    const identity=await fingerprintSource(src);
    options.signal?.throwIfAborted();
    let measuredReport=null,analyzing=false;
    try{return await withEffectCache(src,async({directory,verify,sharedSourceKey,readLegacy})=>{
      const measurementStore=(folder,id)=>createClipCacheArtifact(folder,recipeKey('mix-measurement-v1',id),'json');
      const store=measurementStore(directory,sharedSourceKey||identity);
      const cached=await readRecord(store,16384,verify) || await readLegacy?.(old=>
        readRecord(measurementStore(old.directory,identity),16384,old.verify));
      if(cached){
        let report;
        try{report=JSON.parse(cached);}catch{/* a malformed receipt is a miss */}
        if(await fingerprintSource(src)!==identity)throw changed();
        options.signal?.throwIfAborted();verify();
        if(report&&['maxDb','meanDb','minDb','dynamicRangeDb'].every(k=>Number.isFinite(report[k])))return report;
      }
      analyzing=true;
      const report=await analyze(src,options);
      analyzing=false;
      if(await fingerprintSource(src)!==identity)throw changed();
      options.signal?.throwIfAborted();
      measuredReport=report;
      await writeRecord(store,Buffer.from(JSON.stringify(report)),verify);
      return report;
    });}catch(error){
      options.signal?.throwIfAborted();
      // Measurement only reads the original. Saving its small receipt is optional
      // when the source is mounted read-only or the sidecar volume is full.
      if(analyzing||!['EACCES','EPERM','EROFS','ENOSPC','SIDECAR_CACHE_UNAVAILABLE'].includes(error?.code))throw error;
      return measuredReport||analyze(src,options);
    }
  }
  async function cachedNormalize(src,rawOptions={},lifecycle={}){
    const stream=rawOptions.sourceStream??0,options=normalizeLimiterOptions(rawOptions);
    if(!Number.isInteger(stream)||stream<0||stream>255)throw new TypeError('無效的來源音訊串流');
    const identity=await fingerprintSource(src);
    lifecycle.signal?.throwIfAborted();
    const {preset,...settings}=options; // UI preset name cannot change PCM.
    const pcmKey=id=>recipeKey('audio-effect-pcm-v1',id,stream,settings);
    return withEffectCache(src,async context=>{
      const {directory,verify,sharedSourceKey,readLegacy}=context;
      const key=pcmKey(sharedSourceKey||identity);
      const current=()=>{lifecycle.signal?.throwIfAborted();verify();};
      const store=createClipCacheArtifact(directory,key,'wav');
      const deliver=(outputPath,wavePath,report,cached,reader,recipe)=>{
        current();reader.verify();
        grantRead(outputPath);grantRead(wavePath);
        const result={outputPath,wavePath,cacheKey:recipe,cacheHit:cached,sourceFingerprint:identity,options,report:report.report,isSilence:report.isSilence};
        lifecycle.onProgress?.({pct:100,stage:cached?'cached':'done',label:cached?'已讀取音訊平衡快取':'音訊平衡快取已就緒'});
        if(lifecycle.retainPreview && reader.retain)result.leaseId=lifecycle.retainPreview(reader.retain());
        return result;
      };
      async function readPreview(reader,recipe,candidates){
        const shared=Boolean(reader.sharedSourceKey);
        for(const entry of candidates.candidates()){
          const folder=path.dirname(entry.path),wave=path.join(folder,'wave.wav');
          const owned=()=>{current();reader.verify();entry.verify();};
          let record;
          try{
            const data=await readSmallFile(path.join(folder,'effect.json'),32768,owned);
            if(!digest(data.subarray(32)).equals(data.subarray(0,32)))continue;
            record=JSON.parse(data.subarray(32));
            if(record.key!==recipe||record.reusable!==true||fileStamp(entry.path,shared)!==record.output||fileStamp(wave,shared)!==record.wave)continue;
          }catch{continue;}
          const media=await probe(src,{signal:lifecycle.signal});
          owned();
          const expectedChannels=media.audio?.[stream]?.channels,duration=Number(media.duration);
          if(!expectedChannels||!duration
            || !await completeWave(entry.path,duration,owned,{sampleRate:null,expectedChannels})
            || !await completeWave(wave,duration,owned,{sampleRate:4000,expectedChannels}))continue;
          if(await fingerprintSource(src)!==identity)throw changed();
          owned();
          if(fileStamp(entry.path,shared)!==record.output||fileStamp(wave,shared)!==record.wave)throw changed();
          return deliver(entry.path,wave,record,true,reader,recipe);
        }
        return null;
      }
      const hit=await readPreview(context,key,store) || await readLegacy?.(old=>{
        const legacyKey=pcmKey(identity);
        return readPreview(old,legacyKey,createClipCacheArtifact(old.directory,legacyKey,'wav'));
      });
      if(hit)return hit;
      current();
      const out=store.reserve();
      let wave,metadata,published=false;
      try{
        wave=companion(out,'wave.wav');
        const owned=()=>{current();out.verify();wave.verify();};
        const result=await normalize(src,rawOptions,lifecycle,{path:out.path,fd:out.fd,waveFd:wave.fd,verify:owned});
        const duration=result.sourceDuration||lifecycle.duration;
        if(!(duration>0) || !await completeWave(out.path,duration,owned,{sampleRate:null})
          || !await completeWave(wave.file,duration,owned,{sampleRate:4000}))throw new Error('音訊平衡未產生完整的預聽與聲道波形');
        if(await fingerprintSource(src)!==identity)throw changed();
        owned();
        // Set an explicit write time after FFmpeg closes its inherited handles. Windows
        // otherwise defers the last-write update until our reservation handle closes.
        const now=new Date();
        fs.futimesSync(out.fd,now,now);fs.futimesSync(wave.fd,now,now);
        const record={key,reusable:result.reusable,report:result.report,isSilence:result.isSilence,output:fileStamp(out.path,!!sharedSourceKey),wave:fileStamp(wave.file,!!sharedSourceKey)};
        const bytes=Buffer.from(JSON.stringify(record));
        metadata=companion(out,'effect.json');
        await writeAll(metadata.fd,digest(bytes));await writeAll(metadata.fd,bytes);
        owned();metadata.verify();out.publish();published=true;
        return deliver(out.path,wave.file,record,false,context,key);
      }finally{
        try{
          for(const file of [metadata,wave].filter(Boolean)){
            fs.closeSync(file.fd);
            if(!published)try{file.remove();}catch{/* Changed files belong to their new owner. */}
          }
        }finally{await out.close();}
      }
    });
  }
  async function displayPeaks(src,{streams,channel,resolution,peaks}={}){
    if(resolution!==100 || !Array.isArray(streams) || !streams.length || streams.length>256
      || streams.some(s=>!s||!Number.isInteger(s.sourceStream)||s.sourceStream<0||s.sourceStream>255||!/^[0-9a-f]{64}$/.test(s.cacheKey))
      || new Set(streams.map(s=>s.sourceStream)).size!==streams.length)throw new Error('音訊平衡波形來源無效');
    if(channel && (!streams.some(s=>s.sourceStream===channel.sourceStream)||!Number.isInteger(channel.sourceChannel)
      || channel.sourceChannel<0 || channel.sourceChannel>255))throw new Error('音訊平衡波形聲道無效');
    if(peaks!==undefined){
      if(!(peaks instanceof Float32Array)||!peaks.length||peaks.length%2||peaks.byteLength>maxPeakBytes)
        throw new Error('音訊平衡波形資料無效');
      for(let i=0;i<peaks.length;i+=262144){
        const region=peaks.subarray(i,i+262144);
        if(region.some(n=>!Number.isFinite(n)||Math.abs(n)>1))throw new Error('音訊平衡波形資料無效');
        if(i+region.length<peaks.length)await new Promise(resolve=>setImmediate(resolve));
      }
    }
    const identity=await fingerprintSource(src);
    return withEffectCache(src,async({directory,verify,sharedSourceKey,readLegacy})=>{
      const displayStore=(folder,id)=>createClipCacheArtifact(folder,
        recipeKey('audio-effect-display-v1',id,streams.map(s=>[s.sourceStream,s.cacheKey]),
          channel?[channel.sourceStream,channel.sourceChannel]:null,resolution),'peaks');
      const store=displayStore(directory,sharedSourceKey||identity);
      if(peaks!==undefined){
        const bytes=Buffer.from(peaks.buffer,peaks.byteOffset,peaks.byteLength);
        if(await fingerprintSource(src)!==identity)throw changed();
        await writeRecord(store,bytes,verify);
        return {saved:true};
      }
      const bytes=await readRecord(store,maxPeakBytes,verify) || await readLegacy?.(old=>
        readRecord(displayStore(old.directory,identity),maxPeakBytes,old.verify));
      if(!bytes||bytes.length%8)return {peaks:null};
      if(await fingerprintSource(src)!==identity)throw changed();
      return {peaks:new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length))};
    });
  }
  return {normalize:cachedNormalize,analyze:measured,displayPeaks};
}
module.exports={createAudioEffectCache,readRecord,writeRecord};

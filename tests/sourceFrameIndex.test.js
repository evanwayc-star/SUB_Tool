// @subtool-ci windows
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { sourceFrameWindow, sourcePresentationMetadata, clearSourceFrameIndexes } from '../src/decode/source-frame-index.js';
import { demuxFile, demuxIndex, presentationSamples, SampleReader } from '../src/decode/demux.js';
import { createNativePreviewRuntime } from '../src/media-player-adapter.js';
import { descriptorOf } from '../electron/media-probe.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const {ffmpeg,ffprobe}=nativeTestTools();
const nativeIt=fs.existsSync(ffmpeg)?it:it.skip;
const directories=[];
afterEach(()=>{
  clearSourceFrameIndexes();vi.unstubAllGlobals();
  for(const directory of directories.splice(0))fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

function fixture(args,extension='mp4',{tailMoov=false}={}){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-frame-index-test-'));directories.push(dir);
  const file=path.join(dir,'source.'+extension);
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args,...(tailMoov?[]:['-movflags','+faststart']),file],{windowsHide:true,timeout:30000});
  // Node lacks Chromium's file URL Range loader; keep the real MP4 parser and
  // source-window module, replacing only the byte delivery adapter.
  vi.stubGlobal('fetch',vi.fn(async(unused,{headers}={})=>{
    const match=/bytes=(\d+)-(\d+)/.exec(headers?.Range||'');
    if(!match)throw new Error('metadata must use Range');
    const source=fs.existsSync(unused)?unused:file;
    const start=Number(match[1]),end=Math.min(fs.statSync(source).size,Number(match[2])+1);
    const bytes=Buffer.alloc(Math.max(0,end-start)),handle=fs.openSync(source,'r');
    try{fs.readSync(handle,bytes,0,bytes.length,start);}finally{fs.closeSync(handle);}
    return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
  }));
  return file;
}

function placeTailMoov(file){
  const original=fs.readFileSync(file);
  let offset=0;
  while(offset<original.length&&original.toString('ascii',offset+4,offset+8)!=='moov')offset+=original.readUInt32BE(offset);
  expect(offset).toBeLessThan(original.length);
  // Keep mdat and stco unchanged; an actual sparse free box moves only moov.
  const padding=500*1024*1024+1024-original.length,header=Buffer.alloc(8);
  header.writeUInt32BE(padding);header.write('free',4);
  const handle=fs.openSync(file,'r+');
  try{
    fs.writeSync(handle,header,0,header.length,offset);
    fs.writeSync(handle,original.subarray(offset),0,original.length-offset,offset+padding);
  }finally{fs.closeSync(handle);}
  return original;
}

describe('presenter source frame evidence',()=>{
  nativeIt('500MiB檔尾moov真MOV跳過free/mdat，只讀有界索引且保留原生PTS與樣本payload',async()=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.5',
      '-map','0:v','-map','1:a','-c:v','libx264','-bf','3','-c:a','pcm_s16le'],'mov',{tailMoov:true});
    const original=placeTailMoov(file);
    expect(fs.statSync(file).size).toBeGreaterThan(500*1024*1024);
    const probe=ffprobe;
    const frames=JSON.parse(execFileSync(probe,['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})).frames;
    const expected=frames.map(frame=>Math.round(Number(frame.best_effort_timestamp_time)*1e6));
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata).toEqual({presentationTimestampOffset:-5.5,audioPresentationTimestampOffset:-5,
      audioPresentationTimestampOffsets:[-5],decoderAudioPresentationTimestampOffsets:[-5],duration:3});
    const tail=await sourceFrameWindow(file,2.8,{timestampOffset:-5.5});
    expect(Math.round(tail.start*1e6)).toBe(2800000);expect(Math.round(tail.end*1e6)).toBe(2833333);
    const raw=await demuxIndex(file),whole=await demuxFile(original.buffer.slice(original.byteOffset,original.byteOffset+original.length));
    expect(presentationSamples(raw.index,raw.info).map(sample=>sample.timestamp).sort((a,b)=>a-b)).toEqual(expected);
    const reader=new SampleReader(file,raw.index,raw.maxEnd);
    reader.ensure(0);await vi.waitFor(()=>expect(reader.data(0)).not.toBeNull());
    expect(Buffer.from(reader.data(0))).toEqual(Buffer.from(whole.chunks[0].data));reader.dispose();
    const reads=fetch.mock.calls.map(([,options])=>/bytes=(\d+)-(\d+)/.exec(options.headers.Range));
    expect(reads.some(match=>Number(match[1])>500*1024*1024-64*1024)).toBe(true);
    expect(reads.reduce((sum,match)=>sum+Number(match[2])-Number(match[1])+1,0)).toBeLessThan(1024*1024);
  });

  nativeIt.each(['webm','mkv'])('%s真first-video block與完整container end給HTML來源clock，origin不借音訊PTS',async extension=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=5',
      '-map','0:v','-map','1:a','-c:v',extension==='webm'?'libvpx-vp9':'libx264',
      '-c:a',extension==='webm'?'libopus':'pcm_s16le'],extension);
    const probe=ffprobe;
    const descriptor=descriptorOf(JSON.parse(execFileSync(probe,['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})));
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBe(descriptor.video.presentationTimestampOffset);
    expect(metadata.duration).toBeCloseTo(descriptor.duration,10);
    expect(metadata.audioPresentationTimestampOffset).toBe(extension==='webm'?-4.9945:-5);
    expect(metadata.audioPresentationTimestampOffsets).toEqual([metadata.audioPresentationTimestampOffset]);
    const decoded=JSON.parse(execFileSync(probe,['-v','error','-select_streams','a:0','-show_entries','frame=pts_time','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000}));
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([-Number(decoded.frames[0].pts_time)]);
    const runtime=createNativePreviewRuntime({video:{src:file,currentTime:5.5,duration:5.5+metadata.duration}});
    runtime.registerSourceClock(file,metadata);
    expect(runtime.sourceTime()).toBe(0);expect(runtime.playerTime(2.8)).toBe(8.3);
  });

  nativeIt('audio-only Opus WebM計入CodecDelay，與原生container毫秒tick內的音訊原點一致',async()=>{
    const file=fixture(['-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:a','libopus'],'webm');
    const probe=ffprobe;
    const descriptor=descriptorOf(JSON.parse(execFileSync(probe,['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})));
    const metadata=await sourcePresentationMetadata(file);
    // The first encoded block is 5.001s; its CodecDelay is 6.5ms.
    expect(metadata.presentationTimestampOffset).toBeCloseTo(-4.9945,10);
    expect(metadata.audioPresentationTimestampOffset).toBe(-4.9945);
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([-5.001]);
    expect(Math.abs(metadata.presentationTimestampOffset-descriptor.audio[0].presentationTimestampOffset)).toBeLessThan(.001);
    expect(metadata.duration+(-metadata.presentationTimestampOffset)).toBe(8.008);
  });

  nativeIt.each(['mp4','webm'])('%s 500MiB母素材payload只讀有界Range header',async extension=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=1','-c:v',extension==='webm'?'libvpx-vp9':'libx264'],extension);
    fs.truncateSync(file,500*1024*1024);
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBe(-5.5);expect(metadata.duration).toBe(1);
    const reads=fetch.mock.calls.map(([,options])=>/bytes=(\d+)-(\d+)/.exec(options.headers.Range));
    const requested=reads.reduce((sum,match)=>sum+Number(match[2])-Number(match[1])+1,0);
    expect(requested).toBeLessThan(5*1024*1024);
  });

  nativeIt.each(['30','30000/1001'])('真CFR %s含B-preroll的CTS與edit精度只合併round一次，全部PTS匹配原生畫格',async rate=>{
    const file=fixture(['-f','lavfi','-i',`testsrc2=size=64x36:rate=${rate}:duration=1`,'-c:v','libx264','-bf','3']);
    const probe=ffprobe;
    const frames=JSON.parse(execFileSync(probe,['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})).frames;
    const expected=frames.map(frame=>Math.round(Number(frame.best_effort_timestamp_time)*1e6));
    const raw=await demuxIndex(file),actual=presentationSamples(raw.index,raw.info).map(sample=>sample.timestamp).sort((a,b)=>a-b);
    expect(actual).toEqual(expected);
    const fps=rate==='30'?30:30000/1001;
    for(const index of [0,1,2,3,14,29]){
      const window=await sourceFrameWindow(file,index/fps);
      expect(window.start).toBe(expected[index]/1e6);
    }
  });

  nativeIt.each([0,5])('web母素材原點%s由真edit-list推得，完整movie header保留更晚PCM音訊尾端',async origin=>{
    const file=fixture(['-itsoffset',String(origin+.5),'-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset',String(origin),'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=5',
      '-map','0:v','-map','1:a','-fps_mode','passthrough','-c:v','libx264','-bf','3','-c:a','pcm_s16le'],'mov');
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata).toEqual({presentationTimestampOffset:-(origin+.5),audioPresentationTimestampOffset:-origin||0,
      audioPresentationTimestampOffsets:[-origin||0],decoderAudioPresentationTimestampOffsets:[-origin||0],duration:4.5});
    const reads=fetch.mock.calls.length;
    const first=await sourceFrameWindow(file,0,{timestampOffset:metadata.presentationTimestampOffset});
    expect(first.start).toBe(0);expect(first.end).toBeCloseTo(.033333,10);
    expect(fetch).toHaveBeenCalledTimes(reads);
    const runtime=createNativePreviewRuntime({video:{src:file,currentTime:origin+.5,duration:origin+5}});
    runtime.registerSourceClock(file,metadata);
    expect(runtime.sourceTime()).toBe(0);expect(runtime.sourceDuration()).toBe(4.5);
    runtime.registerSourceClock('processed-proxy',null);
    expect(runtime.playerTime(1,'processed-proxy')).toBe(1);
  });

  nativeIt.each(['m4a','mov'])('audio-only %s真sample/header時鐘以第一呈現PCM或AAC為來源零點',async extension=>{
    const file=fixture(['-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3',
      '-c:a',extension==='mov'?'pcm_s16le':'aac'],extension);
    const probe=ffprobe;
    const descriptor=descriptorOf(JSON.parse(execFileSync(probe,['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})));
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBeCloseTo(descriptor.audio[0].presentationTimestampOffset,6);
    expect(metadata.audioPresentationTimestampOffset).toBe(metadata.presentationTimestampOffset);
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([metadata.presentationTimestampOffset]);
    // MOV movie ticks are milliseconds, while FFprobe's duration may retain
    // the audio track's sub-millisecond ticks. HTML follows that movie end.
    expect(metadata.duration).toBe(extension==='m4a'?3.022:3);
    expect(Math.abs(metadata.duration-descriptor.duration)).toBeLessThan(.001);
    expect(await sourceFrameWindow(file,1,{timestampOffset:metadata.presentationTimestampOffset})).toBeNull();
    await expect(demuxIndex(file)).rejects.toThrow('找不到視訊軌');
  });

  nativeIt('延後video的MOV保留AAC decoder有效edit原點，metadata不把音訊prefix當成video來源零點',async()=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.5',
      '-map','0:v','-map','1:a','-c:v','libx264','-bf','3','-c:a','aac'],'mov');
    const probe=ffprobe;
    const actual=JSON.parse(execFileSync(probe,['-v','error','-show_streams','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000}));
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBe(-5.5);expect(metadata.duration).toBe(3);
    expect(metadata.audioPresentationTimestampOffset).toBe(-4.978);
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([-4.978]);
    expect(metadata.audioPresentationTimestampOffset).toBe(-Number(actual.streams.find(stream=>stream.codec_type==='audio').start_time));
  });

  nativeIt('ordinary AAC media_time1024 decoder origin仍是active edit 0，不保留負preroll或移到下一packet',async()=>{
    const file=fixture(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.5','-c:a','aac'],'m4a');
    const raw=await demuxIndex(file,{allowAudio:true}),samples=presentationSamples(raw.index,raw.info);
    expect(samples[0].timestamp).toBe(-21333);
    const metadata=await sourcePresentationMetadata(file);
    expect(metadata.presentationTimestampOffset).toBe(0);expect(metadata.audioPresentationTimestampOffset).toBe(0);
    expect(metadata.audioPresentationTimestampOffsets).toEqual([0]);expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([0]);expect(metadata.duration).toBe(3.5);
  });

  nativeIt.each(['mov','webm'])('%s多soundtrack的decoder epoch依stream順序保留，第二軌不得借第一軌原點',async extension=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3',
      '-itsoffset','6','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=3',
      '-map','0:v','-map','1:a','-map','2:a','-c:v',extension==='mov'?'libx264':'libvpx-vp9','-c:a',extension==='mov'?'aac':'libopus'],extension);
    const metadata=await sourcePresentationMetadata(file);
    const offsets=extension==='mov'?[-4.978,-5.978]:[-4.9945,-5.9945];
    expect(metadata.presentationTimestampOffset).toBe(-5.5);expect(metadata.audioPresentationTimestampOffset).toBe(offsets[0]);
    expect(metadata.audioPresentationTimestampOffsets).toEqual(offsets);expect(Object.isFrozen(metadata.audioPresentationTimestampOffsets)).toBe(true);
    const decodedOffsets=extension==='mov'?offsets:[-5.001,-6.001];
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual(decodedOffsets);
    expect(Object.isFrozen(metadata.decoderAudioPresentationTimestampOffsets)).toBe(true);
  });

  nativeIt('AAC母素材copyts轉Opus WebM後decoder epoch比encoded CodecDelay時鐘晚，依真decodedframe選起點',async()=>{
    const original=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3',
      '-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.5',
      '-map','0:v','-map','1:a','-c:v','libx264','-c:a','aac'],'mov');
    const converted=path.join(path.dirname(original),'converted.webm');
    execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-copyts','-i',original,'-c:v','libvpx-vp9','-c:a','libopus',converted],{windowsHide:true,timeout:30000});
    const probe=ffprobe;
    const decoded=JSON.parse(execFileSync(probe,['-v','error','-select_streams','a:0','-show_entries','frame=pts_time,nb_samples','-of','json',converted],{windowsHide:true,encoding:'utf8',timeout:10000}));
    const metadata=await sourcePresentationMetadata(converted);
    expect(metadata.audioPresentationTimestampOffset).toBe(-4.9725);
    expect(metadata.decoderAudioPresentationTimestampOffsets).toEqual([-4.979]);
    expect(metadata.decoderAudioPresentationTimestampOffsets[0]).toBe(-Number(decoded.frames[0].pts_time));
    expect(decoded.frames[0].nb_samples).toBe(648);
  });

  it('失去intake歸屬立即停止等待header，晚到解析不能發布該intake的來源時鐘',async()=>{
    let finish,owns=true;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
    const pending=sourcePresentationMetadata('blob:old',{owns:()=>owns});
    owns=false;
    await expect(pending).resolves.toBeNull();
    finish({ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(0)});
    await Promise.resolve();
  });

  nativeIt('absolute MOV edit-list PTS uses the registered HTML clock when its container starts at 5.5 seconds',async()=>{
    const file=fixture(['-itsoffset','5.5','-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3','-fps_mode','passthrough','-c:v','libx264','-bf','3']);
    const probe=ffprobe;
    const descriptor=descriptorOf(JSON.parse(execFileSync(probe,['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,encoding:'utf8',timeout:10000})));
    expect(descriptor.video.timestampOffset).toBe(0);
    expect(descriptor.video.presentationTimestampOffset).toBe(-5.5);
    const video={src:file,currentTime:5.5,duration:8.5};
    const runtime=createNativePreviewRuntime({video});
    runtime.registerSourceClock(file,descriptor.video);
    const first=await sourceFrameWindow(file,0,runtime.sourceClock(file));
    expect(first.start).toBe(0);expect(first.end).toBeCloseTo(.033333,10);
    const tail=await sourceFrameWindow(file,2.8,runtime.sourceClock(file));
    expect(tail.start).toBeCloseTo(2.8,10);expect(tail.end).toBeCloseTo(2.833333,10);
    expect(await sourceFrameWindow(file,3,runtime.sourceClock(file))).toBeNull();
  });

  nativeIt('probe-confirmed video zero maps actual delayed MP4 sample windows in both directions',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=30:duration=3','-f','lavfi','-i','anullsrc=r=48000:cl=mono',
      '-filter_complex','[0:v]setpts=PTS+.5/TB[v]','-map','[v]','-map','1:a','-t','3.5','-fps_mode','passthrough','-c:v','libx264','-bf','0','-c:a','aac']);
    const clock={timestampOffset:-.5};
    const first=await sourceFrameWindow(file,0,clock);expect(first.start).toBe(0);expect(first.end).toBeCloseTo(.033333,10);
    const tail=await sourceFrameWindow(file,2.8,clock);expect(tail.start).toBeCloseTo(2.8,10);expect(tail.end).toBeCloseTo(2.833333,10);
    expect(await sourceFrameWindow(file,2.8)).toEqual({start:2.8,end:2.833333});
    expect(await sourceFrameWindow(file,3,clock)).toBeNull();
  });

  nativeIt('真VFR的短畫格使用相鄰CTS，不使用平均FPS',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=50:duration=2','-vf',"select='not(mod(n,4))+eq(mod(n,4),1)'",'-fps_mode','vfr','-c:v','libx264','-bf','0']);
    expect(await sourceFrameWindow(file,0)).toEqual({start:0,end:.02});
    expect(await sourceFrameWindow(file,.02)).toEqual({start:.02,end:.08});
    expect(await sourceFrameWindow(file,.07)).toEqual({start:.02,end:.08});
    expect(await sourceFrameWindow(file,.08)).toEqual({start:.08,end:.1});
  });

  nativeIt('真B畫格CFR扣除edit-list預滾偏移，按呈現順序定位',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=25:duration=2','-c:v','libx264','-bf','3']);
    expect(await sourceFrameWindow(file,0)).toEqual({start:0,end:.04});
    expect(await sourceFrameWindow(file,1.01)).toEqual({start:1,end:1.04});
    expect(await sourceFrameWindow(file,1.04)).toEqual({start:1.04,end:1.08});
    const bytes=fs.readFileSync(file);
    const whole=await demuxFile(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    const streamed=await demuxIndex(file);
    expect(whole.info.presentationOffsetUs).toBe(streamed.info.presentationOffsetUs);
    expect(whole.info.presentationOffsetUs).toBe(-80000);
    const normalized=presentationSamples(whole.chunks,whole.info);
    expect(normalized.map(sample=>sample.timestamp)).toEqual(presentationSamples(streamed.index,streamed.info).map(sample=>sample.timestamp));
    expect(normalized[0].timestamp).toBe(0);
    expect(normalized[0].data).toBe(whole.chunks[0].data);
    expect(whole.chunks[0].timestamp).toBe(80000);
  });

  nativeIt('同一來源的暫時I/O失敗恢復後可重新取得真畫格證據',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=25:duration=1','-c:v','libx264','-bf','0']);
    fetch.mockRejectedValueOnce(new Error('temporary reader failure'));
    expect(await sourceFrameWindow(file,.02)).toBeNull();
    expect(await sourceFrameWindow(file,.02)).toEqual({start:0,end:.04});
  });

  nativeIt('真VFR B畫格的呈現格長取相鄰CTS，保留原始decode順序與樣本',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=50:duration=2','-vf',"select='not(mod(n,4))+eq(mod(n,4),1)'",'-fps_mode','vfr','-c:v','libx264','-bf','3']);
    const raw=await demuxIndex(file),samples=presentationSamples(raw.index,raw.info);
    expect(raw.info.presentationOffsetUs).toBe(-80000);
    expect(samples.find(sample=>sample.timestamp===160000).duration).toBe(20000);
    expect(samples.find(sample=>sample.timestamp===180000).duration).toBe(60000);
    expect(samples.map(sample=>sample.offset)).toEqual(raw.index.map(sample=>sample.offset));
    expect(await sourceFrameWindow(file,.17)).toEqual({start:.16,end:.18});
    expect(await sourceFrameWindow(file,.23)).toEqual({start:.18,end:.24});
  });

  nativeIt('reset前的晚到I/O失敗不得刪除同URL的新成功索引',async()=>{
    const file=fixture(['-f','lavfi','-i','testsrc2=size=64x36:rate=25:duration=1','-c:v','libx264','-bf','0']);
    const reader=fetch;
    let rejectOld,first=true;
    vi.stubGlobal('fetch',vi.fn((...args)=>{
      if(first){first=false;return new Promise((unused,reject)=>{rejectOld=reject;});}
      return reader(...args);
    }));
    const old=sourceFrameWindow(file,.02);
    clearSourceFrameIndexes();
    expect(await sourceFrameWindow(file,.02)).toEqual({start:0,end:.04});
    const reads=reader.mock.calls.length;
    rejectOld(new Error('old source closed'));
    expect(await old).toBeNull();
    expect(await sourceFrameWindow(file,.02)).toEqual({start:0,end:.04});
    expect(reader).toHaveBeenCalledTimes(reads);
  });

  it('沒有可支援的edit-list證據時不猜樣本呈現時間',()=>{
    expect(presentationSamples([{timestamp:80000,duration:40000}],{presentationOffsetUs:null})).toBeNull();
  });

  it('未支援的來源返回沒有證據，不補造來源格長',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('unsupported source')));
    expect(await sourceFrameWindow('file:///unsupported.mxf',.02)).toBeNull();
    expect(await sourceFrameWindow(null,.02)).toBeNull();
  });
});

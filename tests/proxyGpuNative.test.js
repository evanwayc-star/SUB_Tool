// @subtool-ci windows
import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require=createRequire(import.meta.url);
const {buildIngestArgs,previewPipelineCandidates}=require('../electron/ffmpeg-execution-engine.js');
const {buildAudioIngestPlan}=require('../electron/media-intake-runtime.js');
const {createMediaProbe}=require('../electron/media-probe.js');
const {ffmpeg,ffprobe}=nativeTestTools();
const roots=[];

function run(binary,args) {
  const result=spawnSync(binary,args,{windowsHide:true,timeout:15000,maxBuffer:16*1024*1024});
  expect(result.error||result.status,result.stderr?.toString()).toBe(0);
  return result.stdout;
}
function videoInfo(file) {
  return JSON.parse(run(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_streams',
    '-show_entries','frame=best_effort_timestamp_time,pict_type:stream=codec_name,width,height,pix_fmt,has_b_frames,color_space,color_primaries,color_transfer',
    '-of','json',file]).toString());
}
function rgb(file) {
  return run(ffmpeg,['-v','error','-xerror','-i',file,'-vf','crop=16:16:0:0,format=rgb24',
    '-frames:v','1','-f','rawvideo','pipe:1']).subarray(0,3);
}
function pcm(file) {
  return run(ffmpeg,['-v','error','-xerror','-i',file,'-ac','1','-ar','4000','-f','f32le','pipe:1']);
}
function rms(bytes) {
  let sum=0;
  for(let i=0;i<bytes.length;i+=4) sum+=bytes.readFloatLE(i)**2;
  return Math.sqrt(sum/(bytes.length/4));
}

afterEach(()=>{
  for(const dir of roots.splice(0)) {
    const actual=fs.realpathSync(dir);
    if(path.dirname(actual)!==fs.realpathSync(tmpdir())||!path.basename(actual).startsWith('subtool-proxy-gpu-native-')) {
      throw new Error('拒絕清理未核對的 GPU 測試目錄');
    }
    fs.rmSync(actual,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

it('NVENC 實機 Proxy 的畫格、色彩與音訊內容維持正式規格',async context=>{
  if(process.platform!=='win32'||!fs.existsSync(ffmpeg)||!fs.existsSync(ffprobe)) {
    context.skip('Windows 原生 FFmpeg／ffprobe 不可用');return;
  }
  // 只以實際短編碼判斷 NVENC 硬體可用性；成功後任何管線失敗都是測試失敗。
  const probe=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i',
    'testsrc2=size=320x180:rate=5:duration=0.2','-c:v','h264_nvenc','-f','null','-'],
  {windowsHide:true,timeout:15000});
  if(probe.error) throw probe.error;
  if(probe.status!==0) {
    const reason=(probe.stderr||Buffer.alloc(0)).toString();
    if(/cannot load.*(?:nvcuda|nvencode)|no (?:nvenc capable|capable|cuda capable) devices|unknown encoder.*h264_nvenc|driver does not support|no device available/i.test(reason)) {
      context.skip(`NVENC 不可用：${reason.trim().slice(0,240)}`);return;
    }
    throw new Error(`NVENC 探針失敗：${reason}`);
  }
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-proxy-gpu-native-'));roots.push(dir);
  const mediaProbe=createMediaProbe({executable:ffprobe});
  try {
    for(const kind of ['h264','prores']) {
      const source=path.join(dir,`${kind}.mov`);
      run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=red:s=320x180:r=5:d=1.2',
        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.2',
        '-c:v',kind==='h264'?'libx264':'prores_ks',
        ...(kind==='h264'?['-pix_fmt','yuv420p']:['-profile:v','2','-pix_fmt','yuv422p10le']),
        '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',
        '-c:a','pcm_s16le','-shortest',source]);
      const description=await mediaProbe.describe(source);
      const candidate=previewPipelineCandidates({encoder:'h264_nvenc',video:description.video,needsProxy:true})[0];
      expect(candidate.mode).toBe(kind==='h264'?'cuda':'cuda-upload');
      const outputs=[];
      // 固定同一 NVENC 參數，只比較硬體與 CPU 解碼／縮放造成的差異。
      for(const [variant,pipeline] of [['gpu',candidate],['cpu',{encoder:'h264_nvenc',mode:'software'}]]) {
        const prefix=path.join(dir,`${kind}-${variant}`),audio=buildAudioIngestPlan(description.audio);
        const channels=audio.channels.map((channel,index)=>({...channel,file:`${prefix}-${index}.m4a`}));
        const output={proxy:`${prefix}.mp4`,wave:`${prefix}.wav`,channels};
        const args=buildIngestArgs({src:source,needsProxy:true,proxyPath:output.proxy,video:description.video,
          encoder:pipeline.encoder,pipeline,fc:audio.filters,channels,chMaps:audio.channelMaps,
          waveLabel:audio.waveLabel,wavePath:output.wave});
        if(pipeline===candidate) expect(args[args.indexOf('-vf')+1]).toContain('scale_cuda');
        run(ffmpeg,args);
        run(ffmpeg,['-v','error','-xerror','-i',output.proxy,'-f','null','-']);
        outputs.push(output);
      }
      const [gpu,cpu]=outputs,[actual,reference]=outputs.map(output=>videoInfo(output.proxy));
      expect(actual.streams[0]).toMatchObject({codec_name:'h264',width:854,height:480,pix_fmt:'yuv420p',has_b_frames:0});
      for(const field of ['color_space','color_primaries','color_transfer']) expect(actual.streams[0][field]).toBe(reference.streams[0][field]);
      expect(actual.frames).toHaveLength(6);
      expect(actual.frames.map(frame=>frame.best_effort_timestamp_time)).toEqual(reference.frames.map(frame=>frame.best_effort_timestamp_time));
      expect(actual.frames.every(frame=>frame.pict_type!=='B')).toBe(true);
      const pixel=rgb(gpu.proxy),referencePixel=rgb(cpu.proxy);
      expect(referencePixel[0]).toBeGreaterThan(200);expect(referencePixel[0]).toBeGreaterThan(referencePixel[1]+100);
      for(let channel=0;channel<3;channel++) expect(Math.abs(pixel[channel]-referencePixel[channel])).toBeLessThanOrEqual(6);
      expect(gpu.channels).toHaveLength(1);
      for(const [actualFile,expectedFile] of [[gpu.wave,cpu.wave],[gpu.channels[0].file,cpu.channels[0].file]]) {
        const actualPcm=pcm(actualFile),expectedPcm=pcm(expectedFile);
        expect(actualPcm.length).toBeGreaterThanOrEqual(4000*4);
        expect(rms(actualPcm)).toBeGreaterThan(0.01);
        expect(actualPcm).toEqual(expectedPcm);
      }
    }
  } finally {await mediaProbe.cancelAllAndWait();}
});

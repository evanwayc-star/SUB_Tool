// @subtool-ci windows
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { buildDeliveryArgv } = require('../electron/export-plan');
const { createDeliveryRunner } = require('../electron/delivery-runner');
const { verifyDeliveryMedia } = require('../electron/delivery-verification');
const { pumpReverseFeeds } = require('../electron/delivery-reverse');
const { createMediaProbe } = require('../electron/media-probe');
const { captureOutputDirectory, captureOutputAuthority, captureDestinationEvidence, captureDestinationEvidenceAsync,
  prepareSharedLeaseRoot, listLeases } = require('../electron/export-lease');
const { spawnExportWatchdog } = require('../electron/export-watchdog');
const ffmpeg = process.env.FFMPEG_PATH || path.resolve('electron/ffmpeg/ffmpeg.exe');
const ffprobe = process.env.FFPROBE_PATH || path.resolve('electron/ffmpeg/ffprobe.exe');
const temp = fs.realpathSync(os.tmpdir());
let root;
const run = (args, input) => {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
    { input, cwd: root, windowsHide: true, timeout: 20000 });
  if (result.error) throw result.error;
  expect(result.status, String(result.stderr)).toBe(0);
  return result.stdout;
};
beforeEach(() => { root = fs.mkdtempSync(path.join(temp, 'subtool-delivery-integrity-')); });
afterEach(() => {
  const real = fs.realpathSync(root);
  if (path.dirname(real) !== temp || !path.basename(real).startsWith('subtool-delivery-integrity-')) throw Error('錯誤的測試暫存目錄');
  fs.rmSync(real, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))('交付像素、長濾鏡與成品格式', () => {
  it('ProRes 保留 422 交錯色線與 10-bit 亮度階梯，支援 ASS 和有透明來源的疊層', async () => {
    const w = 64, h = 32, source = path.join(root, '母片.mkv');
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) raw.writeUInt16LE(440 + Math.floor(x / 8), 2 * (y * w + x));
      for (let x = 0; x < w / 2; x++) {
        raw.writeUInt16LE(y % 2 ? 780 : 220, 2 * (w * h + y * w / 2 + x));
        raw.writeUInt16LE(512, 2 * (1.5 * w * h + y * w / 2 + x));
      }
    }
    run(['-f','rawvideo','-pixel_format','yuv422p10le','-video_size','64x32','-framerate','25',
      '-i','pipe:0','-c:v','ffv1',source], Buffer.concat(Array(5).fill(raw)));
    const image = path.join(root, 'overlay.png');
    run(['-f','lavfi','-i','color=red@0.5:s=8x8,format=rgba','-frames:v','1',image]);
    fs.writeFileSync(path.join(root, 'mark.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 64\nPlayResY: 32\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,8,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,1,0,1,0,0,0,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:00.20,Default,,0,0,0,,A\n');
    const clip = { path: source, type: 'video', offset: 0, in: 0, out: .2, natW: w, natH: h, audio: [] };
    for (const layered of [false,true]) {
      const output = path.join(root, `quality-${layered}.mov`);
      const clips = [clip];
      if (layered) clips.push({ ...clip, type: 'image', path: image, natW: 8, natH: 8, vtrack: 1,
        scale: .25, posX: .125, posY: .125, fadeIn: .08 });
      const plan = buildDeliveryArgv({ clips, videoTracks: [{ vt: 0 },{ vt: 1, opacity: .8 }],
        assFileName: layered ? 'mark.ass' : null, format:'prores',width:w,height:h,duration:.2,fps:25,outPath:output },
      { proresArgs: () => ['-c:v','prores_ks','-profile:v','3','-pix_fmt','yuv422p10le','-c:a','pcm_s24le'] });
      run(plan.args);
      await verifyDeliveryMedia(output, {format:'prores',duration:.2,fps:25,channels:[2]}, ffprobe);
      const result = run(['-i',output,'-frames:v','1','-pix_fmt','yuv422p10le','-f','rawvideo','pipe:1']);
      const chroma = Array.from({length:8}, (_, i) => result.readUInt16LE(2*(w*h+(8+i)*w/2+16)));
      expect(chroma).toEqual([220,780,220,780,220,780,220,780]);
      const luma = Array.from({length:8}, (_, i) => result.readUInt16LE(2*(16*w+8*i+4)));
      expect(new Set(luma).size).toBeGreaterThan(4);
    }
  });

  it.each([160,1000])('%i 個單格剪段用工作擁有的濾鏡檔匯出，逐格確認顏色與完成時清理', async count => {
    const mother = path.join(root, '交通 燈.mov'), output = path.join(root, '成品.mp4');
    run(['-f','lavfi','-i',"color=red:s=16x16:r=25:d=0.16,drawbox=c=green:t=fill:enable='eq(n,1)',drawbox=c=blue:t=fill:enable='eq(n,2)',drawbox=c=yellow:t=fill:enable='eq(n,3)'",'-c:v','libx264','-bf','0',mother]);
    const order = [1,3,0,2];
    const duration = count / 25;
    const clips = Array.from({length:count}, (_,i) => ({ path:mother,natW:16,natH:16,type:'video',audio:[],
      in:order[i%4]/25,out:(order[i%4]+1)/25,offset:i/25 }));
    let graphFile;
    const updates = [];
    const runner = createDeliveryRunner({ queueDir:()=>root,tempDir:root,nativeCapabilities:{assertReady:async()=>{}},
      mediaProbe:()=>({describe:async()=>({audio:[],video:null}),audioBitrates:async()=>[]}),
      queue:{assertJobCapabilities(){},reportProgress(_id, data){updates.push(data);},registerActiveJob(){},clearActiveJob(){}},
      encoder:{bitrateArgs:()=>['-c:v','libx264','-preset','veryfast']},
      runFfmpeg: async (args, options) => {
        graphFile = options.inputEvidence.find(record=>record.path.endsWith('.ffgraph')).path;
        expect(fs.statSync(graphFile).size).toBeGreaterThan(32767);
        run(['-filter_complex_threads','1',...args]);
        await verifyDeliveryMedia(output,options.verification,ffprobe);
        return {};
      },
    });
    await runner.run({id:'long',outputAuthority:captureDestinationEvidence(captureOutputAuthority(output,captureOutputDirectory(root))),
      payload:{format:'h264',outPath:output,clips,width:16,height:16,duration,fps:25}});
    expect(updates.at(-1),JSON.stringify(updates)).toMatchObject({done:true});
    expect(fs.existsSync(graphFile)).toBe(false);
    const colors = file => run(['-i',file,'-map','0:v:0','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const original = colors(mother), result = colors(output);
    expect(result.length).toBe(count*3);
    for(let i=0;i<count;i++) expect(result.subarray(3*i,3*i+3)).toEqual(original.subarray(3*order[i%4],3*order[i%4]+3));
    await expect(verifyDeliveryMedia(output,{format:'h264',duration,fps:25,channels:[6]},ffprobe)).rejects.toThrow(/聲道/);
    fs.truncateSync(output,fs.statSync(output).size-100);
    await expect(verifyDeliveryMedia(output,{format:'h264',duration,fps:25,channels:[2]},ffprobe)).rejects.toThrow();
  });

  it('分塊倒放 VFR、變速與非格點 offset 逐格及完整 PCM 等於同一交付格網', async () => {
    const source = path.join(root,'timed.mkv');
    run(['-f','lavfi','-i','testsrc2=s=128x64:r=25:d=1','-f','lavfi','-i','sine=frequency=523:duration=1:sample_rate=48000',
      '-vf',"select='not(between(n,5,10))'",'-fps_mode','passthrough','-c:v','libx264','-g','6','-bf','2','-c:a','pcm_s16le',source]);
    const out = path.join(root,'reverse.mp4');
    for (const speed of [.5,1,2]) {
      const clip = {path:source,type:'video',in:.12,out:.88,offset:.021,speed,reverse:true,natW:128,natH:64};
      const spec = {format:'h264',width:64,height:32,fps:30,duration:.76/speed+.021,clips:[clip],outPath:out};
      const env = {hasAudioStream:()=>true,vencArgsBitrate:()=>['-c:v','libx264','-qp','0','-threads:v','1']};
      const raw = flag => run(['-i',out,'-map',flag,'-f','framemd5','pipe:1']).toString().split('\n')
        .filter(line=>line && !line.startsWith('#'));
      run(buildDeliveryArgv(spec,env).args);
      const expected = [raw('0:v'),raw('0:a')];
      const plan = buildDeliveryArgv(spec,{...env,bufferedReverse:true,reverseBufferBytes:24000});
      expect(plan.reverseFeeds).toHaveLength(1);
      const child = spawn(ffmpeg,['-hide_banner','-loglevel','error',...plan.args],
        {cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe','pipe']});
      let error = '';
      child.stderr.on('data',chunk=>{error+=chunk;});
      const controller = new AbortController();
      const closed = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code?reject(Error(error)):resolve());});
      try {
        await Promise.all([closed,pumpReverseFeeds(ffmpeg,plan.reverseFeeds,child.stdio.slice(3),controller.signal)]);
        expect([raw('0:v'),raw('0:a')]).toEqual(expected);
      } finally {
        controller.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed.catch(()=>{});
      }
    }
  });

  it('滿版直出以有原點的真實描述為準，VFR 缺格、非零容器起點與末格符合黑底時鐘', async () => {
    const source = path.join(root,'late-vfr.mkv'), outPath = path.join(root,'simple.mp4');
    run(['-f','lavfi','-i','testsrc2=s=64x32:r=25:d=1','-vf',"select='not(between(n,5,10))',setpts=PTS+5/TB",
      '-fps_mode','passthrough','-c:v','libx264','-bf','2',source]);
    const { video } = await createMediaProbe({executable:ffprobe}).describe(source);
    expect(video.streamStart).toBe(5);
    const spec = {format:'h264',width:64,height:32,fps:25,duration:1,outPath,
      clips:[{type:'video',path:source,in:0,out:1,offset:0,audio:[],natW:64,natH:32}]};
    const hashes = [];
    for (const clock of [{...video,streamStart:undefined},video]) {
      const plan = buildDeliveryArgv(spec,{sourceClock:()=>clock,vencArgsBitrate:()=>['-c:v','libx264','-qp','0','-threads:v','1']});
      const graph = plan.args[plan.args.indexOf('-filter_complex')+1];
      expect(graph.includes('overlay=')).toBe(clock.streamStart == null);
      run(plan.args);
      hashes.push(run(['-i',outPath,'-map','0:v:0','-f','framemd5','pipe:1']).toString());
    }
    expect(hashes[0].split('\n').filter(line=>line&&!line.startsWith('#'))).toHaveLength(25);
    expect(hashes[1]).toBe(hashes[0]);
  });

  it('小型 WAV 維持 RIFF，實際 PCM 和 RIFF 長度都在發布前核對', async () => {
    const output = path.join(root,'ordinary.wav');
    const { args } = buildDeliveryArgv({format:'wav',duration:.2,outPath:output,audioPlan:{buses:[{id:'A'}]}});
    run(args);
    expect(fs.readFileSync(output).toString('ascii',0,4)).toBe('RIFF');
    const expected = {format:'wav',duration:.2,channels:[1]};
    await verifyDeliveryMedia(output,expected,ffprobe);
    const fd = fs.openSync(output,'r+');
    try { fs.writeSync(fd,Buffer.alloc(4,255),0,4,4); } finally { fs.closeSync(fd); }
    await expect(verifyDeliveryMedia(output,expected,ffprobe)).rejects.toThrow(/RIFF/);
  });

  it('獨立 watchdog 在驗證聲道失敗時保留舊檔，同一工作改正後可提交', async () => {
    const outPath = path.join(root, '交付.wav'), queueDir = path.join(root,'queue');
    fs.mkdirSync(queueDir);
    fs.writeFileSync(outPath, 'original');
    const { args } = buildDeliveryArgv({format:'wav',duration:.2,outPath,audioPlan:{buses:[{id:'A'}]}});
    for (const channels of [[6],[1]]) {
      const outputAuthority = await captureDestinationEvidenceAsync(captureOutputAuthority(outPath,captureOutputDirectory(root)));
      const job = spawnExportWatchdog({ffmpegPath:ffmpeg,ffprobePath:ffprobe,args,outPath,queueDir,
        cwd:root,outputFormat:'wav',verification:{format:'wav',duration:.2,channels},
        ...prepareSharedLeaseRoot(root),outputAuthority,jobId:'verify'+channels[0]});
      await job.ready;
      const completed = await job.completion;
      expect(completed.ok).toBe(channels[0] === 1);
      if (!completed.ok) expect(fs.readFileSync(outPath,'utf8')).toBe('original');
      else await verifyDeliveryMedia(outPath,{format:'wav',duration:.2,channels},ffprobe);
      expect(listLeases(queueDir)).toEqual([]);
    }
  });

  it.skipIf(process.platform !== 'win32')('一千條長來源路徑超過 Windows argv，或系統無法開啟額外串流時說明分批方式並保留成品', async () => {
    const outPath = path.join(root,'原交付.mp4'), source = path.join(root,'source.dat'), queueDir = path.join(root,'queue');
    fs.writeFileSync(outPath,'prior delivery'); fs.writeFileSync(source,'source'); fs.mkdirSync(queueDir);
    const paths = Array.from({length:1000},(_,i)=>path.join(root,`片段母素材-${i}.mov`));
    for (const file of paths) fs.linkSync(source,file);
    for (const kind of ['paths','pipes']) {
      const outputAuthority = await captureDestinationEvidenceAsync(captureOutputAuthority(outPath,captureOutputDirectory(root)));
      const errors = [];
      const config = {ffmpegPath:ffmpeg,outPath,queueDir,cwd:root,...prepareSharedLeaseRoot(root),outputAuthority,jobId:kind};
      if (kind === 'paths') Object.assign(config,{args:[...paths.flatMap(file=>['-i',file]),outPath],sourcePaths:paths});
      else Object.assign(config,{args:['-y',outPath],reverseFeeds:Array.from({length:256},()=>({source}))});
      const job = spawnExportWatchdog(config,{onMessage:event=>{if(event.type==='error')errors.push(event);}});
      await job.ready.catch(()=>{});
      expect((await job.completion).ok).toBe(false);
      expect(errors.some(e=>e.code===(kind==='paths'?'DELIVERY_ARGUMENT_LIMIT':'DELIVERY_INPUT_LIMIT'))).toBe(true);
      expect(fs.readFileSync(outPath,'utf8')).toBe('prior delivery');
      expect(listLeases(queueDir)).toEqual([]);
    }
  });
});

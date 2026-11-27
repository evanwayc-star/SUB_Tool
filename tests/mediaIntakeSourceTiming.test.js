// @subtool-ci windows
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { parse } from 'acorn';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require = createRequire(import.meta.url);
const { createMediaProbe } = require('../electron/media-probe.js');
const { createMediaIntakeRuntime, cacheKeyFor, sourceAudioClockFilter } = require('../electron/media-intake-runtime.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
const roots = [];

function run(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

function pcm(file) {
  return run(['-i', file, '-map', '0:a:0', '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
}

function audioMetadata(file) {
  const result = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', file], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  expect(result.error || result.status, result.stderr?.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()).streams;
}

function energy(bytes, start, end, frequency = null) {
  let sum = 0, sine = 0, cosine = 0;
  const first = Math.round(start * 4000), last = Math.round(end * 4000);
  expect(bytes.length / 4).toBeGreaterThanOrEqual(last);
  for (let index = first; index < last; index++) {
    const value = bytes.readFloatLE(index * 4);
    sum += value * value;
    const phase = 2 * Math.PI * (frequency || 0) * index / 4000;
    sine += value * Math.sin(phase); cosine += value * Math.cos(phase);
  }
  return frequency == null ? Math.sqrt(sum / (last - first)) : 2 * Math.hypot(sine, cosine) / (last - first);
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-intake-source-clock-')) throw new Error('拒絕清除未核對的來源時間測試目錄');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe.skipIf(!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE))('母素材來源時間的音訊快取', () => {
  it.each(['ingest', 'waveform'])('%s 保留 MOV 的八種單聲道 speaker layout 的每軌 PCM 與等權波形', async mode => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'speaker-labelled-mono.mov'), cache = path.join(directory, 'cache');
    const layouts = ['DL', 'DR', 'FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
    const frequencies = layouts.map((_, index) => 200 * (index + 1));
    const args = ['-y', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=25:d=1.2'];
    for (const frequency of frequencies) args.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1.2`);
    args.push('-map', '0:v:0');
    layouts.forEach((layout, index) => args.push('-map', `${index + 1}:a:0`, `-filter:a:${index}`, `channelmap=map=0:channel_layout=${layout}`));
    run([...args, '-c:v', 'libx264', '-c:a', 'pcm_s24le', source]);
    // Do not let fixture muxing silently turn all inputs into ordinary Mono:
    // AAC rejects DL/DR, and speaker downmixing can also attenuate other tracks.
    expect(audioMetadata(source).map(stream => [stream.channels, stream.channel_layout])).toEqual(
      layouts.map(layout => [1, layout === 'FC' ? 'mono' : `1 channels (${layout})`]),
    );
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const authority = new FileAuthority({ internalDirectories: [directory] }); authority.grantTrustedFile(source, { read: true });
    const calls = [];
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority,
      ffmpegExecution: { execute: (args, options) => { calls.push(args); return execution.execute(args, options); } },
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false,
      describeAudio: async file => (await probe.describe(file)).audio });
    try {
      const descriptor = await probe.describe(source);
      expect(descriptor.audio.map(stream => [stream.index, stream.streamIndex, stream.channels])).toEqual(
        layouts.map((_, index) => [index, index + 1, 1]),
      );
      const request = { src: source, duration: descriptor.duration, audio: descriptor.audio, needsProxy: false };
      // A simultaneous -ac 1 waveform output can make filter negotiation
      // normalize AAC by accident. Reuse a completed wave so only the eight
      // M4A files are encoded, matching opening a project after priority wave.
      const completedWave = mode === 'ingest' ? await runtime.waveform({ ...request, continuous: true }) : null;
      if (completedWave) expect(completedWave).toMatchObject({ complete: true, continuous: true });
      const result = await runtime[mode](request);
      expect(result.cached).toBe(false);
      if (mode === 'ingest') {
        expect(result.wave).toBe(completedWave.wave);
        expect(calls).toHaveLength(2);
        expect(calls[1].filter(value => value.endsWith('.wav'))).toEqual([]);
        expect(result.channels.map(channel => [channel.sourceStream, channel.sourceChannel])).toEqual(layouts.map((_, index) => [index, 0]));
        for (const [index, channel] of result.channels.entries()) {
          expect(path.extname(channel.file)).toBe('.m4a');
          expect(audioMetadata(channel.file)).toMatchObject([{ codec_name: 'aac', channels: 1, channel_layout: 'mono' }]);
          const samples = pcm(channel.file);
          expect(energy(samples, .2, 1, frequencies[index]), layouts[index]).toBeCloseTo(.125, 2);
          expect(energy(samples, .2, 1), layouts[index]).toBeCloseTo(.125 / Math.SQRT2, 2);
          for (const frequency of frequencies.filter(value => value !== frequencies[index])) {
            expect(energy(samples, .2, 1, frequency), `${layouts[index]} must not contain ${frequency} Hz`).toBeLessThan(.002);
          }
        }
      } else {
        expect(result).toMatchObject({ channels: [], complete: true, start: 0 });
      }
      const waveform = pcm(result.wave);
      expect(waveform.length / 4 / 4000).toBeCloseTo(1.2, 2);
      for (const frequency of frequencies) expect(energy(waveform, .2, 1, frequency), `${frequency} Hz in ${mode} MIX`).toBeCloseTo(.125 / 8, 3);
      expect(energy(waveform, .2, 1)).toBeCloseTo(.03125, 3);
      if (mode === 'ingest') {
        const selected = await runtime.waveform({ ...request, continuous: true, channel: { sourceStream: 5, sourceChannel: 0 } });
        expect(selected.wave).not.toBe(result.wave);
        const samples = pcm(selected.wave);
        for (const [i, frequency] of frequencies.entries())
          expect(energy(samples, .2, 1, frequency)).toBeCloseTo(i === 5 ? .125 : 0, 3);
      }
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it('從原檔產生所選 S6 聲道的波形，跨工作重用素材旁快取且不混入 MIX', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-'));
    roots.push(directory);
    const source = path.join(directory, 'six streams.mov'), cache = path.join(directory, 'cache'), temp = path.join(directory, 'temp');
    fs.mkdirSync(cache); fs.mkdirSync(temp);
    run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1',
      '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*440*t)|0.5*sin(2*PI*880*t):s=48000:d=1',
      '-map', '0:a', '-map', '0:a', '-map', '0:a', '-map', '0:a', '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => temp });
    const authority = new FileAuthority({ internalDirectories: [temp, cache] });
    authority.grantTrustedFile(source);
    const calls = [], events = [];
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority, ffmpegExecution: {
      execute(args, options) { calls.push(args); return execution.execute(args, options); },
    }, tempRoot: temp, cacheRoot: cache, allowSidecarCache: true, backgroundWaveforms: true,
    describeAudio: async file => (await probe.describe(file)).audio, sendProgress: (_, data) => events.push(data) });
    const request = { src: source, duration: 1, continuous: true };
    const channel = sourceChannel => ({ sourceStream: 5, sourceChannel });
    try {
      const right = await runtime.waveform({ ...request, channel: channel(1), displayPeaks:true }, { owner: { sessionId: 'test', requestId: 'S6R' } });
      expect(right).toMatchObject({ complete: true, cached: false, temporary: false, channel: channel(1) });
      expect(right.wave).toContain('.subtool_Cache'); expect(authority.canRead(right.wave)).toBe(true);
      expect(events.filter(event => event.requestId === 'S6R').every(event => event.jobId === 'source-channel-wave')).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ jobId: 'source-channel-wave', pct: 100, done: true, channel: channel(1) }));
      const rightSamples = pcm(right.wave);
      expect(right.displayPeaks).toBeInstanceOf(Float32Array);
      expect(right.displayPeaks.length).toBe(200);
      expect(right.displayPeaks[101]).toBeCloseTo(.5,2);
      expect(events.filter(event=>event.requestId==='S6R').map(event=>event.phase)).toEqual(expect.arrayContaining(['cache-check','generating']));
      expect(energy(rightSamples, .2, .8, 880)).toBeCloseTo(.5, 3);
      expect(energy(rightSamples, .2, .8, 440)).toBeLessThan(.001);
      expect(calls).toHaveLength(1);
      expect(calls[0][calls[0].indexOf('-filter_complex') + 1].match(/\[0:a:\d+\]/g)).toEqual(['[0:a:5]']);
      const info = await runtime.cacheInfo(source, { sourceOnly: true });
      expect(info.source.locations).toMatchObject([{ kind: 'sidecar', waveform: { state: 'missing', hasSourceChannels: true } }]);
      const [mix, left] = await Promise.all([runtime.waveform(request), runtime.waveform({ ...request, channel: channel(0) })]);
      expect(new Set([mix.wave, left.wave, right.wave]).size).toBe(3);
      expect(energy(pcm(mix.wave), .2, .8, 880)).toBeCloseTo(.5 / 7, 3);
      expect(energy(pcm(left.wave), .2, .8, 440)).toBeCloseTo(.25, 3);
      expect(energy(pcm(left.wave), .2, .8, 880)).toBeLessThan(.001);
      await expect(runtime.waveform({ ...request, channel: channel(1) })).resolves.toMatchObject({ wave: right.wave, cached: true });
      await expect(runtime.waveform({ ...request, channel: channel(2) })).rejects.toThrow(/S6.*Ch3/);
      expect(calls).toHaveLength(3);
      // Inspect actual PCM opens inside the same runtime that executes in each
      // desktop worker. Directory enumeration must not read the other WAVs.
      const reader = createMediaIntakeRuntime({ fileAuthority: authority, tempRoot: temp, cacheRoot: cache,
        allowSidecarCache: true, describeAudio: async file => (await probe.describe(file)).audio });
      const opened = vi.spyOn(fs, 'openSync');
      try {
        await expect(reader.waveform({ ...request, channel: channel(1) })).resolves.toMatchObject({ wave: right.wave, cached: true });
        const waveReads = opened.mock.calls.map(([file]) => file).filter(file => typeof file === 'string' && file.endsWith('.wav'));
        expect([...new Set(waveReads)]).toEqual([right.wave]);
      } finally { opened.mockRestore(); await reader.close(); }
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it.each([0,5])('優先波形分段保留容器起點 %s 的來源時間及所有音訊 stream',async origin=>{
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'subtool-intake-source-clock-'));roots.push(directory);
    const source=path.join(directory,'wave-segments.mkv'),cache=path.join(directory,'cache');
    run(['-y','-itsoffset',String(origin+.5),'-f','lavfi','-i','color=red:s=64x48:r=24:d=3',
      '-itsoffset',String(origin),'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.5',
      '-itsoffset',String(origin+1.5),'-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
      '-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','libx264','-c:a','pcm_s16le',source]);
    const probe=createMediaProbe({executable:FFPROBE});
    const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>directory});
    const runtime=createMediaIntakeRuntime({fileAuthority:new FileAuthority({internalDirectories:[directory]}),
      ffmpegExecution:execution,tempRoot:directory,cacheRoot:cache,allowSidecarCache:false,
      describeAudio:async file=>(await probe.describe(file)).audio});
    try{
      const info=await probe.describe(source),request={src:source,duration:info.duration,audio:info.audio};
      const beginning=await runtime.waveform({...request,start:0,length:1.5});
      const later=await runtime.waveform({...request,start:1.5,length:1.5});
      expect(beginning).toMatchObject({cached:false,temporary:true,start:0,duration:1.5,complete:false});
      expect(later).toMatchObject({cached:false,temporary:true,start:1.5,duration:1.5,complete:false,sourceKey:beginning.sourceKey});
      const complete=await runtime.ingest({...request,needsProxy:false});
      const firstPcm=pcm(beginning.wave),laterPcm=pcm(later.wave),fullPcm=pcm(complete.wave);
      expect(firstPcm.length/4).toBe(6000);expect(laterPcm.length/4).toBe(6000);
      // Each sine source has 0.125 peak amplitude. Both are Mono, so the
      // two-channel source mix contributes 0.0625 per frequency even while
      // the later stream is still silent.
      expect(energy(firstPcm,.2,.8,440)).toBeCloseTo(.0625,2);
      expect(energy(firstPcm,.2,.8,880)).toBeLessThan(.002);
      expect(energy(firstPcm,1.1,1.4,880)).toBeCloseTo(.0625,2);
      for(const frequency of [440,880]){
        expect(energy(laterPcm,.2,1.2,frequency)).toBeCloseTo(.0625,2);
        expect(energy(laterPcm,.2,1.2,frequency)).toBeCloseTo(energy(fullPcm,1.7,2.7,frequency),3);
      }
      // Compare every interior PCM sample as well as spectral energy, not file existence.
      let squareError=0;
      for(let frame=400;frame<5600;frame++)squareError+=(laterPcm.readFloatLE(frame*4)-fullPcm.readFloatLE((frame+6000)*4))**2;
      expect(Math.sqrt(squareError/5200)).toBeLessThan(.002);
    }finally{await runtime.close();await execution.cancelAllAndWait();await probe.cancelAllAndWait();}
  },30000);

  it.each([
    { name: 'SD 無色彩標籤', size: '320x180', matrix: null, expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: 'HD 無色彩標籤', size: '1920x1080', matrix: null, expectedMatrix: 'bt709', expectedRgb: [255, 23, 0] },
    { name: '600h 無色彩標籤', size: '1024x600', matrix: null, expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: '寬短無色彩標籤', size: '1280x540', matrix: null, expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: '600h 窄像素自然高 1200 無色彩標籤', size: '1024x600', sar: '1/2', matrix: null, expectedMatrix: 'bt709', expectedRgb: [255, 23, 0] },
    { name: 'SD 明示 709', size: '320x180', matrix: 'bt709', expectedMatrix: 'bt709', expectedRgb: [255, 23, 0] },
    { name: 'HD 明示 601', size: '1920x1080', matrix: 'smpte170m', expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: 'SD 只有 709 矩陣', size: '320x180', matrix: 'bt709', omitted: ['colorPrimaries', 'colorTransfer'], expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: 'HD 只有 601 矩陣', size: '1920x1080', matrix: 'smpte170m', omitted: ['colorPrimaries', 'colorTransfer'], expectedMatrix: 'bt709', expectedRgb: [255, 23, 0] },
    { name: 'SD 709 缺 primaries', size: '320x180', matrix: 'bt709', omitted: ['colorPrimaries'], expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: 'SD 709 缺 transfer', size: '320x180', matrix: 'bt709', omitted: ['colorTransfer'], expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0] },
    { name: 'HD 601 缺矩陣', size: '1920x1080', matrix: 'smpte170m', omitted: ['colorSpace'], expectedMatrix: 'bt709', expectedRgb: [255, 23, 0] },
    { name: 'SD 只有 709 矩陣邊轉邊播', size: '320x180', matrix: 'bt709', omitted: ['colorPrimaries', 'colorTransfer'], expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0], mode: 'stream' },
    { name: 'SD 無標籤邊轉邊播', size: '320x180', matrix: null, expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0], mode: 'stream' },
  ])('$name 母素材在預覽 Proxy 保留來源觀感與實際 RGB', async ({ size, sar, matrix, omitted = [], expectedMatrix, expectedRgb, mode = 'ingest' }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'sd-red.mp4'), cache = path.join(directory, 'cache');
    const untagged = matrix ? path.join(directory, 'untagged.mp4') : source;
    run(['-y', '-f', 'lavfi', '-i', `color=red:s=${size}:r=5:d=0.2`, ...(sar ? ['-vf', `setsar=${sar}`] : []), '-c:v', 'libx264', untagged]);
    if (matrix) {
      const id = matrix === 'bt709' ? 1 : 6;
      const fields = [['colorSpace', 'matrix_coefficients', '-colorspace'],
        ['colorPrimaries', 'colour_primaries', '-color_primaries'], ['colorTransfer', 'transfer_characteristics', '-color_trc']]
        .filter(([field]) => !omitted.includes(field));
      run(['-y', '-i', untagged, '-c:v', 'copy', '-bsf:v',
        `h264_metadata=video_full_range_flag=0${fields.map(([, field]) => `:${field}=${id}`).join('')}`,
        ...fields.flatMap(([, , option]) => [option, matrix]), source]);
    }
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const runtime = createMediaIntakeRuntime({
      fileAuthority: new FileAuthority({ internalDirectories: [cache] }), ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {},
      describeVideo: async file => (await probe.describe(file)).video,
    });
    try {
      const inputVideo = (await probe.describe(source)).video;
      for (const field of omitted) expect(inputVideo[field]).toBeUndefined();
      const work = await runtime[mode]({ src: source, duration: 0.2, needsProxy: true, audio: [] });
      await work.completion;
      const result = work.response || work;
      const metadata = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', result.proxy], { windowsHide: true });
      expect(metadata.status).toBe(0);
      const video = JSON.parse(metadata.stdout.toString()).streams[0];
      // Actual Chromium RED: an untagged 720p frame falls back to 709 and turns
      // Y81/U90/V240 red into RGB255/24/0. Decode using the output's interpretation.
      const outputMatrix = video.color_space || 'bt709';
      const pixel = run(['-i', result.proxy, '-vf', `crop=2:2:0:0,scale=in_color_matrix=${outputMatrix}:out_range=pc,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
      expect([...pixel.subarray(0, 3)]).toEqual(expectedRgb);
      expect(video.height).toBe(Math.min(720, Number(size.split('x')[1])));
      expect(video.color_space).toBe(expectedMatrix);
      expect(video.color_primaries).toBe(expectedMatrix);
      expect(video.color_transfer).toBe(expectedMatrix);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  });

  it.each([
    { encoder: 'libvpx-vp9', matrix: 'smpte170m', expectedMatrix: 'smpte170m', expectedRgb: [253, 0, 0], complete: true },
    // Retained source and pre-fix Proxy both decode as Y62/U102/V239 here:
    // FFmpeg gives RGB251/0/0, while Chromium's converter gives RGB253/0/0.
    { encoder: 'libvpx-vp9', matrix: 'bt709', expectedMatrix: 'bt709', expectedRgb: [251, 0, 0], complete: true },
    { encoder: 'libvpx-vp9', matrix: null, expectedMatrix: 'bt709', expectedRgb: [255, 23, 0], complete: true },
    { encoder: 'libaom-av1', matrix: 'smpte170m', expectedMatrix: 'smpte170m', expectedRgb: [255, 23, 0] },
    { encoder: 'libaom-av1', matrix: null, expectedMatrix: 'bt709', expectedRgb: [255, 23, 0], complete: true },
  ])('$encoder 矩陣 $matrix 的 Proxy 保留實測 Chromium 來源觀感', async ({ encoder, matrix, expectedMatrix, expectedRgb, complete }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, `source.${encoder === 'libvpx-vp9' ? 'webm' : 'mp4'}`), cache = path.join(directory, 'cache');
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=5:d=0.2', '-c:v', encoder, '-cpu-used', '8',
      '-pix_fmt', 'yuv420p', ...(matrix ? ['-colorspace', matrix] : []), source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const runtime = createMediaIntakeRuntime({ fileAuthority: new FileAuthority({ internalDirectories: [cache] }), ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {},
      describeVideo: async file => (await probe.describe(file)).video });
    try {
      const input = (await probe.describe(source)).video;
      expect(input.colorPrimaries).toBeUndefined(); expect(input.colorTransfer).toBeUndefined();
      const result = await runtime.ingest({ src: source, duration: 0.2, needsProxy: true, audio: [] });
      const output = (await probe.describe(result.proxy)).video;
      // Chromium maps VP9 frame color enums, while incomplete AV1 color falls
      // back to 709. The H.264 Proxy must keep each source's observed pixels.
      const interpretedMatrix = output.colorPrimaries && output.colorTransfer && output.colorSpace ? output.colorSpace : 'bt709';
      const pixel = run(['-i', result.proxy, '-vf', `crop=2:2:0:0,scale=in_color_matrix=${interpretedMatrix}:out_range=pc,format=rgb24`,
        '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
      expect([...pixel.subarray(0, 3)]).toEqual(expectedRgb);
      expect(output.colorSpace).toBe(expectedMatrix);
      if (complete) { expect(output.colorPrimaries).toBe(expectedMatrix); expect(output.colorTransfer).toBe(expectedMatrix); }
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  });

  it.each(['RGB', 'RGB gbr', 'full-range YUV'])('%s 母素材轉成 Proxy 後保持實際 RGB，不能只改標籤', async kind => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'source.mkv'), cache = path.join(directory, 'cache');
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=5:d=0.2',
      ...(kind.startsWith('RGB') ? ['-vf', 'format=bgr0', '-c:v', 'ffv1', ...(kind === 'RGB gbr' ? ['-colorspace', 'rgb'] : [])]
        : ['-c:v', 'libx264', '-pix_fmt', 'yuvj420p', '-color_range', 'pc']), source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const runtime = createMediaIntakeRuntime({ fileAuthority: new FileAuthority({ internalDirectories: [cache] }), ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {},
      describeVideo: async file => (await probe.describe(file)).video });
    const rgb = (file, matrix = null) => [...run(['-i', file, '-vf', `crop=2:2:0:0,${matrix ? `scale=in_color_matrix=${matrix}:out_range=pc,` : ''}format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']).subarray(0, 3)];
    try {
      const before = rgb(source);
      const result = await runtime.ingest({ src: source, duration: 0.2, needsProxy: true, audio: [] });
      const output = (await probe.describe(result.proxy)).video;
      const after = rgb(result.proxy, output.colorSpace || 'bt709');
      for (let index = 0; index < 3; index++) expect(Math.abs(after[index] - before[index])).toBeLessThanOrEqual(3);
      expect(['smpte170m', 'bt709']).toContain(output.colorSpace);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  });

  it('舊色彩 Proxy 只補建影片，保留既有聲道與波形，重開後可命中新色彩快取', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'legacy-sd.mp4'), cache = path.join(directory, 'cache');
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=5:d=0.2', '-f', 'lavfi', '-i', 'sine=duration=0.2',
      '-c:v', 'libx264', '-c:a', 'aac', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const options = { fileAuthority: new FileAuthority({ internalDirectories: [cache] }), ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {} };
    const legacy = createMediaIntakeRuntime(options);
    let current;
    try {
      const request = { src: source, duration: 0.2, needsProxy: true, audio: [{ channels: 1 }] };
      const old = await legacy.ingest(request);
      await legacy.close();
      const oldProxy = fs.readFileSync(old.proxy), oldWave = fs.readFileSync(old.wave), oldChannel = fs.readFileSync(old.channels[0].file);
      current = createMediaIntakeRuntime({ ...options, describeVideo: async file => (await probe.describe(file)).video });
      const repaired = await current.ingest(request);
      expect(repaired.cached).toBe(false);
      expect(repaired.proxy).not.toBe(old.proxy);
      expect(repaired.wave).toBe(old.wave); expect(repaired.channels).toEqual(old.channels);
      expect(fs.readFileSync(old.proxy)).toEqual(oldProxy);
      expect(fs.readFileSync(old.wave)).toEqual(oldWave); expect(fs.readFileSync(old.channels[0].file)).toEqual(oldChannel);
      expect((await probe.describe(repaired.proxy)).video.colorSpace).toBe('smpte170m');
      await current.close();
      current = createMediaIntakeRuntime({ ...options, describeVideo: async file => (await probe.describe(file)).video });
      expect(await current.ingest(request)).toEqual({ ...repaired, cached: true });
    } finally { await current?.close(); await legacy.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  });

  it.each([0, 5])('實際 waveAudio IPC 的容器起點 %s 保留來源第一秒靜音與完整波形', async origin => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'direct.mkv'), wave = path.join(directory, 'wave.wav');
    run(['-y', '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', String(origin + 1), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const main = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
    const call = parse(main, { ecmaVersion: 'latest' }).body.map(node => node.expression).find(node =>
      node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === 'ffmpeg:waveAudio');
    let waveAudio;
    vm.runInNewContext(main.slice(call.start, call.end), {
      ipcMain: { handle: (name, handler) => { waveAudio = handler; } },
      requireReadablePath(channel, file) { expect(channel).toBe('ffmpeg:waveAudio'); expect(file).toBe(source); },
      mediaProbe: probe, sourceAudioClockFilter, tmpPath: () => wave,
      mediaIntakeRuntime: createMediaIntakeRuntime({ tempRoot: directory,
        fileAuthority: new FileAuthority({ internalDirectories: [directory] }) }),
      runFF: (args, options) => execution.execute(args, { ...options, executionKind: 'direct' }),
    });
    try {
      const descriptor = await probe.describe(source);
      expect(await waveAudio({ sender: {} }, { path: source, duration: descriptor.duration })).toBe(wave);
      const samples = pcm(wave);
      expect(samples.length / 4 / 4000).toBeCloseTo(3, 2);
      expect(energy(samples, 0.1, 0.8)).toBeLessThan(0.0001);
      expect(energy(samples, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
    } finally { await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it.each([
    ...['ingest', 'stream'].flatMap(mode => [0, 5].map(origin => ({ mode, origin, audioDelay: 1, codec: 'pcm_s16le' }))),
    { mode: 'ingest', origin: 0, audioDelay: 1, codec: 'aac' },
    { mode: 'stream', origin: 0, audioDelay: 0, codec: 'aac' },
  ])('$mode 容器起點 $origin、$codec：波形、聲道與 Proxy 共用來源時鐘，重開不回舊 cache', async ({ mode, origin, audioDelay, codec }) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'mother.mkv'), cache = path.join(directory, 'cache');
    run(['-y', '-itsoffset', String(origin), '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=3',
      '-itsoffset', String(origin + audioDelay), '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${3 - audioDelay}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', codec, source]);
    const authority = new FileAuthority({ internalDirectories: [cache] }); authority.grantTrustedFile(source, { read: true });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const options = { fileAuthority: authority, ffmpegExecution: execution, tempRoot: directory,
      cacheRoot: cache, allowSidecarCache: false, delay: async () => {} };
    const runtime = createMediaIntakeRuntime(options), probe = createMediaProbe({ executable: FFPROBE });
    try {
      const descriptor = await probe.describe(source);
      expect(descriptor.duration).toBeCloseTo(3, codec === 'aac' ? 1 : 2);
      // A restored estimate must not shorten the Proxy's actual video.
      const duration = mode === 'stream' && origin === 5 ? 1 : descriptor.duration;
      const request = { src: source, duration, needsProxy: true, audio: descriptor.audio };
      const work = await runtime[mode](request); await work.completion;
      const result = work.response || work;
      const waveform = pcm(result.wave), channel = pcm(result.channels[0].file);
      if (audioDelay) {
        expect(energy(waveform, 0.1, 0.8)).toBeLessThan(0.0001);
        expect(energy(channel, 0.1, 0.8)).toBeLessThan(0.0002);
      } else {
        expect(energy(waveform, 0.001, 0.012, 440)).toBeGreaterThan(0.075);
        expect(energy(channel, 0.001, 0.012, 440)).toBeGreaterThan(0.075);
      }
      expect(energy(waveform, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
      expect(energy(channel, 1.1, 1.8, 440)).toBeGreaterThan(0.08);
      expect(waveform.length / 4 / 4000).toBeCloseTo(3, codec === 'aac' ? 1 : 2);
      const proxy = await probe.describe(result.proxy);
      expect(proxy.duration).toBeCloseTo(3, 2);
      if (mode === 'stream') {
        expect(result.previewMix).toBe(true);
        const preview = pcm(result.proxy);
        if (audioDelay) expect(energy(preview, 0.001, 0.012)).toBeLessThan(.0002);
        else expect(energy(preview, 0.001, 0.012, 440)).toBeGreaterThan(.075);
        expect(energy(preview, 1.1, 1.8, 440)).toBeGreaterThan(.08);
      }
      const reopened = createMediaIntakeRuntime(options);
      try { expect(await reopened.ingest(request)).toEqual({ cached: true,
        proxy: result.proxy, wave: result.wave, channels: result.channels }); }
      finally { await reopened.close(); }
      const oldKey = require('../electron/mother-source-evidence.js').motherSourceFingerprintSync(source, { namespace: 'source-v2', digestLength: 16 });
      expect(cacheKeyFor(source)).not.toBe(oldKey);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it('完整聲道完成前，由成長中的 HTTP Proxy 讀到對齊的畫格與兩軌脈衝，完成後仍可 seek', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-'));
    roots.push(dir);
    const source = path.join(dir, 'pulse.mkv'), cache = path.join(dir, 'cache');
    const pulse = "between(mod(t,1),0.2,0.52)";
    run(['-y', '-itsoffset', '5', '-f', 'lavfi', '-i',
      "testsrc2=s=640x360:r=25:d=6,drawbox=x=300:y=160:w=40:h=40:c=black:t=fill,drawbox=x=300:y=160:w=40:h=40:c=white:t=fill:enable='" + pulse + "'",
      ...[440, 660].flatMap(hz => ['-itsoffset', '5', '-f', 'lavfi', '-i',
        `aevalsrc='0.3*sin(2*PI*${hz}*t)*${pulse}':s=48000:d=6`]),
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    const authority = new FileAuthority({ internalDirectories: [cache] }); authority.grantTrustedFile(source, { read: true });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => dir });
    const probe = createMediaProbe({ executable: FFPROBE });
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority, cacheRoot: cache, tempRoot: dir, allowSidecarCache: false,
      ffmpegExecution: { execute(args, options) {
        const index = args.indexOf('-i');
        return execution.execute([...args.slice(0, index), '-readrate', '1', ...args.slice(index)], options);
      } } });
    function pixel(file, time) {
      return run(['-ss', String(time), '-i', file, '-vf', 'crop=2:2:320:180,format=gray',
        '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'])[0];
    }
    try {
      const info = await probe.describe(source);
      const work = await runtime.stream({ src: source, needsProxy: true, duration: info.duration, audio: info.audio });
      const result = work.response;
      expect(result.previewMix).toBe(true);
      let completed = false;
      work.completion.then(() => { completed = true; });
      const response = await fetch(result.streamUrl, { headers: { Range: 'bytes=0-' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Length')).toBeNull();
      const reader = response.body.getReader();
      let chunks = Buffer.alloc(0), offset = 0, fragments = 0;
      try {
        while (fragments < 22) {
          const part = await reader.read();
          expect(part.done).toBe(false);
          chunks = Buffer.concat([chunks, part.value]);
          while (offset + 8 <= chunks.length) {
            const bytes = chunks.readUInt32BE(offset);
            if (bytes < 8 || offset + bytes > chunks.length) break;
            if (chunks.toString('ascii', offset + 4, offset + 8) === 'mdat') fragments++;
            offset += bytes;
          }
        }
        expect(completed).toBe(false);
      } finally { await reader.cancel(); }
      const prefix = path.join(dir, 'first-fragments.mp4');
      fs.writeFileSync(prefix, chunks.subarray(0, offset));
      const preview = pcm(prefix);
      expect(pixel(prefix, .08)).toBeLessThan(15);
      expect(pixel(prefix, .32)).toBeGreaterThan(240);
      expect(energy(preview, .02, .15)).toBeLessThan(.001);
      for (const hz of [440, 660]) expect(energy(preview, .25, .45, hz)).toBeCloseTo(.15, 2);
      expect(energy(preview, .58, .74)).toBeLessThan(.001);
      await work.completion;
      expect((await probe.describe(result.proxy)).duration).toBeCloseTo(6, 2);
      expect(pixel(result.proxy, 2.32)).toBeGreaterThan(240);
      expect(pixel(result.proxy, 2.64)).toBeLessThan(15);
      const sought = run(['-ss', '2.3', '-i', result.proxy, '-t', '0.45', '-map', '0:a', '-ar', '4000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
      for (const hz of [440, 660]) expect(energy(sought, .02, .15, hz)).toBeCloseTo(.15, 2);
      expect(energy(sought, .30, .42)).toBeLessThan(.001);
      for (const [i, hz] of [440, 660].entries()) {
        const mono = pcm(result.channels[i].file);
        expect(energy(mono, 2.25, 2.45, hz)).toBeCloseTo(.3, 2);
        expect(energy(mono, 2.25, 2.45, i ? 440 : 660)).toBeLessThan(.002);
      }
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);

  it('不同 stream 的開聲時間各自保留，負 lead 裁去來源第零秒以前的聲音', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-intake-source-clock-')); roots.push(directory);
    const source = path.join(directory, 'staggered.mkv'), cache = path.join(directory, 'cache');
    run(['-y', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=30:d=2',
      '-f', 'lavfi', '-i', "aevalsrc=if(lt(t\\,1)\\,0.12*sin(2*PI*440*t)\\,0.12*sin(2*PI*880*t)):s=48000:d=2.5",
      '-itsoffset', '1.5', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
    const authority = new FileAuthority({ internalDirectories: [cache] }); authority.grantTrustedFile(source, { read: true });
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => directory });
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority, ffmpegExecution: execution,
      tempRoot: directory, cacheRoot: cache, allowSidecarCache: false, delay: async () => {} });
    const probe = createMediaProbe({ executable: FFPROBE });
    try {
      const descriptor = await probe.describe(source);
      expect(descriptor.duration).toBeCloseTo(2, 2);
      const result = await runtime.ingest({ src: source, duration: descriptor.duration, needsProxy: true, audio: descriptor.audio });
      const first = pcm(result.channels[0].file), second = pcm(result.channels[1].file), wave = pcm(result.wave);
      expect(energy(first, 0.6, 0.9, 880)).toBeGreaterThan(0.08);
      expect(energy(first, 0.6, 0.9, 440)).toBeLessThan(0.002);
      expect(energy(second, 0.1, 0.8)).toBeLessThan(0.0002);
      expect(energy(second, 1.1, 1.8, 660)).toBeGreaterThan(0.08);
      // The first Mono stream has amplitude 0.12 and the second is silent in
      // this interval; source MIX still divides by both original channels.
      expect(energy(wave, 0.6, 0.9, 880)).toBeCloseTo(0.06, 2);
      expect(energy(wave, 0.6, 0.9, 440)).toBeLessThan(0.002);
      expect(energy(wave, 0.6, 0.9, 660)).toBeLessThan(0.002);
      expect((await probe.describe(result.proxy)).duration).toBeCloseTo(2, 2);
    } finally { await runtime.close(); await execution.cancelAllAndWait(); await probe.cancelAllAndWait(); }
  }, 30000);
});

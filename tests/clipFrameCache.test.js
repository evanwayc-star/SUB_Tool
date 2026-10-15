// @subtool-ci windows
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { nativeTestTools } from './fixtures/native-tools.cjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createClipFrameCache, validateClipFrameRequest, buildClipFrameArgs } = require('../electron/clip-frame-cache.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { createMediaProbe } = require('../electron/media-probe.js');
const { motherSourceFingerprint } = require('../electron/mother-source-evidence.js');
const ROOT = path.resolve('');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = nativeTestTools();
const nativeIt = fs.existsSync(FFMPEG) ? it : it.skip;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=', 'base64');
const directories = [];

function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-clip-frame-test-'));
  directories.push(directory);
  const source = path.join(directory, 'mother.mp4');
  const cacheRoot = path.join(directory, 'frames');
  fs.writeFileSync(source, 'mother video');
  const authority = new FileAuthority();
  authority.grantTrustedFile(source, { read: true, write: false });
  const execute = vi.fn(async args => fs.writeFileSync(args.at(-1), PNG));
  const probe = vi.fn(async () => ({ duration: 2, video: { fps: 30, width: 1, height: 1 } }));
  const options = { cacheRoot, fileAuthority: authority, execute, probe, ...extra };
  const runtime = createClipFrameCache(options);
  return { directory, source, cacheRoot, authority, execute, probe, runtime, options,
    request: { path: source, time: 0.967, fps: 30 } };
}

function preload() {
  let api;
  const invoke = vi.fn().mockResolvedValue({});
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), send: vi.fn() }, webUtils: {} }),
    Promise, ArrayBuffer, Uint8Array, TypeError, RangeError,
  });
  return { api, invoke };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-clip-frame-test-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('固定畫面的母素材幀快取', () => {
  it.each([{ time: NaN }, { time: Infinity }, { time: -1 }, { time: '0' }, { fps: 0 },
    { fps: 241 }, { fps: NaN }, { fps: '30' }, { path: '' }, { path: null }, { path: 'bad\0path' }])
  ('main 與 preload 都拒絕非法參數 %j', invalid => {
    const request = { path: 'C:/mother.mp4', time: 0, fps: 30, ...invalid };
    expect(() => validateClipFrameRequest(request)).toThrow();
    const bridge = preload();
    expect(() => bridge.api.clipFrame(request)).toThrow();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('preload 只傳母來源、時間與 FPS，main IPC 在 runtime 前核對實際 read capability', async () => {
    const bridge = preload();
    const request = { path: 'C:/mother.mp4', time: 1, fps: 30 };
    await bridge.api.clipFrame({ ...request, output: 'C:/forbidden.png' });
    expect(bridge.invoke).toHaveBeenCalledWith('ffmpeg:clipFrame', request);
    const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const registration = ast.body.find(node => node.type === 'ExpressionStatement'
      && node.expression.type === 'CallExpression' && node.expression.callee.object?.name === 'ipcMain'
      && node.expression.arguments[0]?.value === 'ffmpeg:clipFrame');
    expect(registration).toBeDefined();
    let handler;
    const authority = new FileAuthority(), frame = vi.fn().mockResolvedValue({ ok: true });
    vm.runInNewContext(source.slice(registration.start, registration.end), {
      ipcMain: { handle: (_, callback) => { handler = callback; } }, validateClipFrameRequest,
      requireReadablePath: createIpcGuards(authority).requireReadablePath, clipFrameCache: { frame },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => handler({}, request)).toThrow(/未授權/);
      expect(frame).not.toHaveBeenCalled();
      authority.grantTrustedFile(request.path, { read: true, write: false });
      await handler({}, request);
      expect(frame).toHaveBeenCalledWith(request);
    } finally { warn.mockRestore(); }
  });

  it('只授權完整產物，重開命中同一幀；來源改變後建立新快取', async () => {
    const f = fixture();
    const first = await f.runtime.frame(f.request);
    expect(first).toMatchObject({ ok: true, time: f.request.time, width: 1, height: 1 });
    expect(f.authority.canRead(first.path)).toBe(true);
    expect(f.authority.canWrite(first.path)).toBe(false);
    expect(f.authority.canRead(path.join(f.cacheRoot, 'unrelated.png'))).toBe(false);
    expect(await createClipFrameCache(f.options).frame(f.request)).toEqual(first);
    expect(f.execute).toHaveBeenCalledOnce();
    fs.writeFileSync(f.source, 'new larger mother source');
    const changed = await f.runtime.frame(f.request);
    expect(changed.path).not.toBe(first.path);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(changed.path)).toEqual(PNG);
  });

  it('同大小改寫並還原 mtime 後，公開 frame 重新產生 PNG 而不沿用舊固定畫面', async () => {
    const f = fixture();
    const fixedTime = new Date('2026-10-01T00:00:00.000Z');
    fs.writeFileSync(f.source, 'AAAA');
    fs.utimesSync(f.source, fixedTime, fixedTime);
    const changedPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=', 'base64');
    f.execute.mockImplementation(async args => {
      const bytes = fs.readFileSync(f.source, 'utf8') === 'AAAA' ? PNG : changedPNG;
      fs.writeFileSync(args.at(-1), bytes);
    });
    const first = await f.runtime.frame(f.request);
    const before = fs.statSync(f.source);
    fs.writeFileSync(f.source, 'BBBB');
    fs.utimesSync(f.source, fixedTime, fixedTime);
    const after = fs.statSync(f.source);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });

    const changed = await createClipFrameCache(f.options).frame(f.request);
    expect(changed.path).not.toBe(first.path);
    expect(changed.width).toBe(2);
    expect(fs.readFileSync(first.path)).toEqual(PNG);
    expect(fs.readFileSync(changed.path)).toEqual(changedPNG);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('抽幀期間同大小換內容並還原 mtime，拒絕發布 PNG 並清除 staging', async () => {
    const f = fixture();
    const fixedTime = new Date('2026-10-01T00:00:00.000Z');
    fs.writeFileSync(f.source, 'AAAA');
    fs.utimesSync(f.source, fixedTime, fixedTime);
    f.execute.mockImplementationOnce(async args => {
      fs.writeFileSync(args.at(-1), PNG);
      fs.writeFileSync(f.source, 'BBBB');
      fs.utimesSync(f.source, fixedTime, fixedTime);
    });
    await expect(f.runtime.frame(f.request)).rejects.toThrow(/已變更/);
    expect(fs.readdirSync(f.cacheRoot)).toEqual([]);
    expect(f.runtime.activeCount()).toBe(0);
  });

  it('同一目標只產生一次，精確 NTSC 秒數不捨入、EOF 只往半開範圍內移一微秒', async () => {
    const f = fixture();
    const results = await Promise.all([f.runtime.frame(f.request), f.runtime.frame(f.request)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.execute).toHaveBeenCalledOnce();
    const last = await f.runtime.frame({ ...f.request, time: 2 });
    expect(last.time).toBe(2 - 1e-6);
    const ntsc = await f.runtime.frame({ ...f.request, time: 29 / (30000 / 1001), fps: 29.97 });
    expect(ntsc.time).toBe(29 / (30000 / 1001));
    expect(f.runtime.activeCount()).toBe(0);
  });

  it('隔離平均 FPS 與 seek 重基準舊快取，同一來源秒數不因 caller FPS 不同而重複抽取', async () => {
    const f = fixture();
    const identity = { resolved: await fs.promises.realpath(f.source),
      fingerprint: await motherSourceFingerprint(f.source, { namespace: 'clip-frame-source-v1' }) };
    fs.mkdirSync(f.cacheRoot);
    const oldPaths = [{ version: 3, ...identity, fps: 30, frameIndex: 29 },
      { version: 4, ...identity, time: f.request.time }].map(value => {
      const key = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const file = path.join(f.cacheRoot, `${key}.png`);
      fs.writeFileSync(file, PNG);
      return file;
    });
    const result = await f.runtime.frame(f.request);
    for (const oldPath of oldPaths) expect(result.path).not.toBe(oldPath);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await f.runtime.frame({ ...f.request, fps: 25 })).toEqual(result);
    expect(f.execute).toHaveBeenCalledOnce();
    for (const oldPath of oldPaths) expect(fs.readFileSync(oldPath)).toEqual(PNG);
  });

  it('遠距固定畫格只 seek 目標附近並保留 GOP，沒有全片 reverse 或 frame-index 掃描', () => {
    const args = buildClipFrameArgs({ path: 'large.mxf', time: 21600.024, fps: 25 }, 'frame.png', { timestampOffset: -.5 });
    expect(Number(args[args.indexOf('-ss') + 1])).toBeCloseTo(21600.024, 6);
    expect(args).toContain('-noaccurate_seek');
    expect(args).toContain('-copyts');
    expect(args).toContain('-start_at_zero');
    expect(args[args.indexOf('-vf') + 1]).not.toMatch(/reverse|select=.*n/);
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
  });

  it('未授權／預覽來源、沒有影片、超出結尾不能啟動抽幀', async () => {
    const f = fixture();
    await expect(f.runtime.frame({ ...f.request, path: path.join(f.directory, 'forbidden.mp4') })).rejects.toThrow(/未授權/);
    await expect(f.runtime.frame({ ...f.request, time: 2.1 })).rejects.toThrow(/結尾/);
    const derived = createClipFrameCache({ ...f.options, isPreviewCacheMedia: () => true });
    await expect(derived.frame(f.request)).rejects.toThrow(/母素材/);
    const noVideo = createClipFrameCache({ ...f.options, probe: async () => ({ duration: 2, video: null }) });
    await expect(noVideo.frame(f.request)).rejects.toThrow(/影片畫面/);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('不完整 PNG、來源途中被改與關閉期間不能發布，私有 staging 全部清除', async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async args => fs.writeFileSync(args.at(-1), PNG.subarray(0, 24)));
    await expect(f.runtime.frame(f.request)).rejects.toThrow(/完整 PNG/);
    f.execute.mockImplementationOnce(async args => {
      fs.writeFileSync(args.at(-1), PNG);
      fs.writeFileSync(f.source, 'source changed while decoding');
    });
    await expect(f.runtime.frame(f.request)).rejects.toThrow(/已變更/);
    await expect(createClipFrameCache({ ...f.options, isClosing: () => true }).frame(f.request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readdirSync(f.cacheRoot)).toEqual([]);
  });

  it('逾時先終止並等 close，未確認退出前不釋放 staging 或發布結果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = new EventEmitter();
    child.kill = vi.fn();
    let stage, closing = false, processStarted;
    const ready = new Promise(resolve => { processStarted = resolve; });
    const execute = vi.fn((args, options) => {
      stage = args.at(-1); fs.writeFileSync(stage, PNG);
      return new Promise((resolve, reject) => {
        child.once('close', () => reject(new Error('process terminated')));
        options.onProcess(child); processStarted();
      });
    });
    const f = fixture({ execute, isClosing: () => closing, timeoutMs: 50, terminationGraceMs: 20 });
    const pending = f.runtime.frame(f.request), outcome = pending.catch(error => error);
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('未建立程序就已完成請求'); })]);
      expect(stage).toBeDefined();
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(fs.existsSync(stage)).toBe(true);
      expect(f.runtime.activeCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null, 'SIGKILL');
      expect(await outcome).toMatchObject({ code: 'CLIP_FRAME_TIMEOUT' });
      expect(fs.existsSync(stage)).toBe(false);
      expect(f.runtime.activeCount()).toBe(0);
    } finally {
      closing = true;
      child.emit('close', null, 'SIGKILL');
      await outcome;
    }
  });

  it('沿用全域 FFmpeg shutdown owner，close 前不能完成關閉或刪除抽幀 staging', async () => {
    const f = fixture();
    const child = new EventEmitter();
    child.stderr = new EventEmitter(); child.kill = vi.fn();
    let staging = null, closing = false, processStarted;
    const ready = new Promise(resolve => { processStarted = resolve; });
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'trusted-ffmpeg', getUserDataDir: () => f.directory,
      spawnDirect: (_, args) => {
        staging = args.at(-1); fs.writeFileSync(staging, PNG); return child;
      } });
    const runtime = createClipFrameCache({ ...f.options,
      execute: (args, options) => execution.execute(args, { ...options, onProcess: process => {
        options.onProcess(process); processStarted();
      } }), isClosing: () => closing });
    const pending = runtime.frame(f.request), outcome = pending.catch(error => error);
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('未建立程序就已完成請求'); })]);
      expect(staging).toBeDefined();
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      let stopped = false;
      void shutdown.then(() => { stopped = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(stopped).toBe(false);
      expect(fs.existsSync(staging)).toBe(true);
      await expect(runtime.frame(f.request)).rejects.toMatchObject({ name: 'AbortError' });
      child.emit('close', null, 'SIGTERM');
      expect(await outcome).toMatchObject({ name: 'AbortError' }); await shutdown;
      expect(fs.existsSync(staging)).toBe(false);
      expect(runtime.activeCount()).toBe(0);
    } finally {
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGKILL');
      try { await shutdown; }
      finally { await outcome; }
    }
  });

  it('shutdown 等待固定畫面 owner 清除 staging，不能只等 FFmpeg close', async () => {
    const f = fixture(), child = new EventEmitter();
    child.stderr = new EventEmitter(); child.kill = vi.fn();
    let staging, closing = false, finishCleanup, cleanupStarted, processStarted;
    const ready = new Promise(resolve => { processStarted = resolve; });
    const cleanupGate = new Promise(resolve => { finishCleanup = resolve; });
    const cleanupEntered = new Promise(resolve => { cleanupStarted = resolve; });
    const originalUnlink = fsp.unlink;
    const unlink = vi.spyOn(fsp, 'unlink').mockImplementation(async file => {
      if (file === staging) { cleanupStarted(); await cleanupGate; }
      return originalUnlink(file);
    });
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'trusted-ffmpeg', getUserDataDir: () => f.directory,
      spawnDirect: (_, args) => { staging = args.at(-1); fs.writeFileSync(staging, PNG); return child; } });
    const runtime = createClipFrameCache({ ...f.options,
      execute: (args, options) => execution.execute(args, { ...options, onProcess: process => {
        options.onProcess(process); processStarted();
      } }), isClosing: () => closing });
    const pending = runtime.frame(f.request), outcome = pending.catch(error => error);
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('未建立程序就已完成請求'); })]);
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGTERM');
      await shutdown;
      await Promise.race([cleanupEntered, pending.then(() => { throw new Error('尚未進入 staging 清理'); })]);
      let idle = false;
      const waiting = runtime.waitForIdle().then(() => { idle = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(idle).toBe(false);
      expect(fs.existsSync(staging)).toBe(true);
      await expect(runtime.frame(f.request)).rejects.toMatchObject({ name: 'AbortError' });
      finishCleanup();
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      await waiting;
      expect(fs.existsSync(staging)).toBe(false);
      expect(runtime.activeCount()).toBe(0);
    } finally {
      closing = true;
      const shutdown = execution.cancelAllAndWait();
      child.emit('close', null, 'SIGKILL'); finishCleanup();
      try { await shutdown; await outcome; await runtime.waitForIdle?.(); }
      finally { unlink.mockRestore(); }
    }
  });

  it('shutdown 等待固定畫面 fingerprint 准入，關閉期間拒絕新請求且取消退出後可重用', async () => {
    const f = fixture();
    let closing = false, resumeRead, readStarted;
    const gate = new Promise(resolve => { resumeRead = resolve; });
    const entered = new Promise(resolve => { readStarted = resolve; });
    const originalRealpath = fsp.realpath;
    const realpath = vi.spyOn(fsp, 'realpath').mockImplementation(async (...args) => {
      if (args[0] === f.source) { readStarted(); await gate; }
      return originalRealpath(...args);
    });
    const runtime = createClipFrameCache({ ...f.options, isClosing: () => closing });
    const outcome = runtime.frame(f.request).catch(error => error);
    try {
      await entered; closing = true;
      expect(runtime.activeCount()).toBe(0);
      let idle = false;
      const waiting = runtime.waitForIdle().then(() => { idle = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(idle).toBe(false);
      await expect(runtime.frame(f.request)).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      resumeRead();
      expect(await outcome).toMatchObject({ name: 'AbortError' }); await waiting;
      expect(fs.existsSync(f.cacheRoot)).toBe(false);
      closing = false;
      expect(await runtime.frame(f.request)).toMatchObject({ ok: true });
      await runtime.waitForIdle();
      expect(f.execute).toHaveBeenCalledOnce();
    } finally {
      resumeRead(); await outcome; await runtime.waitForIdle?.(); realpath.mockRestore();
    }
  });

  nativeIt('真62格30fps的probe向上捨入時長，末格仍可擷取而不落到EOF',async()=>{
    const f=fixture();
    const create=spawnSync(FFMPEG,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=64x48:r=30',
      '-frames:v','62','-c:v','libx264','-pix_fmt','yuv420p',f.source],{windowsHide:true,timeout:20000});
    expect(create.status,create.stderr?.toString()).toBe(0);
    const probed=spawnSync(FFPROBE,['-v','error','-show_entries','format=duration','-of','json',f.source],{windowsHide:true,timeout:10000});
    expect(probed.status,probed.stderr?.toString()).toBe(0);
    const duration=Number(JSON.parse(probed.stdout).format.duration);
    expect(duration).toBe(2.066667);
    const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>f.directory});
    const runtime=createClipFrameCache({...f.options,execute:(args,options)=>execution.execute(args,options),
      probe:async()=>({duration,video:{fps:30,width:64,height:48}})});
    try{
      expect(await runtime.frame({path:f.source,time:duration,fps:30})).toMatchObject({time:duration-1e-6,width:64,height:48});
    }finally{await execution.cancelAllAndWait();}
  },30000);

  nativeIt.each([
    { origin: 0, videoOffset: 0 }, { origin: 5, videoOffset: 0 },
    { origin: 0, videoOffset: .5 }, { origin: 5, videoOffset: .5 },
    { origin: 5, videoOffset: .5, longFrame: true },
  ])('public cache 依 VFR 真時間區間取首尾與長畫格，不以平均 FPS 猜：%j', async scenario => {
    const f = fixture(), source = path.join(f.directory, 'vfr.mkv');
    f.authority.grantTrustedFile(source, { read: true });
    const endBlue = scenario.longFrame ? 2 : .2, endYellow = endBlue + .04, duration = endYellow + .04;
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    const video = path.join(f.directory, 'vfr.mov');
    const pts = `settb=AVTB,setpts=if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,0.04\\,if(eq(N\\,2)\\,${endBlue}\\,${endYellow})))/TB`;
    run(['-y', '-f', 'lavfi', '-i',
      "color=red:s=64x48:r=25:d=0.16,drawbox=c=green:t=fill:enable='eq(n,1)',drawbox=c=blue:t=fill:enable='eq(n,2)',drawbox=c=yellow:t=fill:enable='eq(n,3)'",
      '-vf', pts, '-c:v', 'libx264', '-bf', '2', '-g', '240', '-fps_mode', 'passthrough', video]);
    // 先編碼 VFR，再 remux 給容器真 offset；編碼時的空 edit-list
    // 與容器/影片不同原點不是同一件事，不能只假設 setpts 改了 header。
    run(['-y', '-itsoffset', String(scenario.origin + scenario.videoOffset), '-i', video,
      '-itsoffset', String(scenario.origin), '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${duration + scenario.videoOffset}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const describeSource = (file, options) => probe.describe(file, options);
    const descriptor = await describeSource(source);
    expect(descriptor.duration).toBeCloseTo(duration, 6);
    expect(descriptor.video.timestampOffset).toBeCloseTo(-scenario.videoOffset, 6);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipFrameCache({ ...f.options, probe: describeSource,
      execute: (args, options) => execution.execute(args, options) });
    const targets = [0, .039, .04, scenario.longFrame ? 1 : .12, endBlue - .001, endBlue, endYellow, duration];
    const colors = [[253, 0, 0], [253, 0, 0], [0, 127, 0], [0, 127, 0], [0, 127, 0], [0, 0, 254], [253, 253, 0], [253, 253, 0]];
    try {
      for (let index = 0; index < targets.length; index++) {
        const result = await runtime.frame({ path: source, time: targets[index], fps: 25 });
        const pixel = run(['-i', result.path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixel[channel] - colors[index][channel]),
          `origin ${scenario.origin}, offset ${scenario.videoOffset}, source ${targets[index]}: ${[...pixel]}`).toBeLessThan(8);
        expect(result.time).toBeCloseTo(Math.min(targets[index], duration - 1e-6), 9);
      }
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    }
  }, 30000);

  nativeIt.each([30, 30000 / 1001])('public cache 在 %s fps 真 PTS 格界前後一微秒與有理數格界取 containing frame', async rate => {
    const f = fixture();
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    run(['-y', '-f', 'lavfi', '-i',
      `color=red:s=64x48:r=${rate}:d=3,drawbox=c=green:t=fill:enable='eq(mod(n,3),1)',drawbox=c=blue:t=fill:enable='eq(mod(n,3),2)'`,
      '-c:v', 'libx264', '-bf', '2', '-g', '240', f.source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const pts = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', f.source], { windowsHide: true, timeout: 10000 });
    expect(pts.status, pts.stderr?.toString()).toBe(0);
    const ticks = JSON.parse(pts.stdout).frames.map(frame => Math.round(Number(frame.pts_time) * 1e6));
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipFrameCache({ ...f.options, probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, options) });
    const colors = [[253, 0, 0], [0, 127, 0], [0, 0, 254]];
    try {
      for (const index of [0, 1, 2, 29, 30, 31, 61]) {
        const targets = [{ time: index / rate, frame: index }, { time: (ticks[index] + 1) / 1e6, frame: index }];
        if (index) targets.unshift({ time: (ticks[index] - 1) / 1e6, frame: index - 1 });
        for (const target of targets) {
        const result = await runtime.frame({ path: f.source, time: target.time, fps: rate });
        const pixel = run(['-i', result.path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixel[channel] - colors[target.frame % 3][channel]),
          `rate ${rate}, source ${target.time}, frame ${target.frame}: ${[...pixel]}`).toBeLessThan(8);
        }
      }
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    }
  }, 30000);

  nativeIt.each([0, 5].flatMap(origin => [0, .5].map(videoOffset => ({ origin, videoOffset }))))
  ('public cache 的 bounded seek 不量化近格界目標，保留真容器與影片原點：%j', async ({ origin, videoOffset }) => {
    const f = fixture(), source = path.join(f.directory, 'origin.mkv');
    f.authority.grantTrustedFile(source, { read: true });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    run(['-y', '-itsoffset', String(origin + videoOffset), '-f', 'lavfi', '-i',
      "color=red:s=64x48:r=30:d=2,drawbox=c=green:t=fill:enable='eq(mod(n,3),1)',drawbox=c=blue:t=fill:enable='eq(mod(n,3),2)'",
      '-itsoffset', String(origin), '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${2 + videoOffset}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-g', '240', '-bf', '2', '-fps_mode:v', 'passthrough',
      '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const descriptor = await probe.describe(source);
    expect(descriptor.video.timestampOffset).toBe(-videoOffset || 0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipFrameCache({ ...f.options, probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, options) });
    try {
      for (const [time, color] of [[.999999, [0, 0, 254]], [1, [253, 0, 0]], [1.000001, [253, 0, 0]]]) {
        const result = await runtime.frame({ path: source, time, fps: 30 });
        const pixel = run(['-i', result.path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixel[channel] - color[channel]),
          `origin ${origin}, video offset ${videoOffset}, source ${time}: ${[...pixel]}`).toBeLessThan(8);
      }
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    }
  }, 30000);

  nativeIt('來源首格之前的真 presentation 空白不能借未來畫格發布 PNG', async () => {
    const f = fixture(), source = path.join(f.directory, 'leading-gap.mkv');
    f.authority.grantTrustedFile(source, { read: true });
    const run = args => {
      const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.error || result.status, result.stderr?.toString()).toBe(0);
      return result.stdout;
    };
    run(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=25:d=0.16', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.8',
      '-filter_complex', '[0:v]setpts=PTS+0.52/TB[v]', '-map', '[v]', '-map', '1:a:0',
      '-c:v', 'libx264', '-bf', '0', '-fps_mode', 'passthrough', '-c:a', 'pcm_s16le', source]);
    const probe = createMediaProbe({ executable: FFPROBE });
    const descriptor = await probe.describe(source);
    expect(descriptor.video.timestampOffset).toBe(0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipFrameCache({ ...f.options, probe: (file, options) => probe.describe(file, options),
      execute: (args, options) => execution.execute(args, options) });
    try {
      for (const time of [0, .12]) await expect(runtime.frame({ path: source, time, fps: 25 })).rejects.toThrow(/完整 PNG/);
      expect(runtime.activeCount()).toBe(0);
      expect(fs.readdirSync(f.cacheRoot)).toEqual([]);
      const result = await runtime.frame({ path: source, time: .52, fps: 25 });
      const pixel = run(['-i', result.path, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      expect(pixel[0]).toBeGreaterThan(245); expect(pixel[2]).toBeLessThan(8);
    } finally {
      await execution.cancelAllAndWait(); await probe.cancelAllAndWait();
    }
  }, 30000);

  nativeIt.each([[30, '30'], [29.97, '30000/1001']])
  ('真 FFmpeg 擷取 %s fps 切點前一格仍為紅，下一格為藍且保留原解析度', async (fps, ratio) => {
    const f = fixture();
    const rate = fps === 29.97 ? 30000 / 1001 : fps;
    const create = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=red:s=64x48:r=${ratio}`, '-f', 'lavfi', '-i', `color=blue:s=64x48:r=${ratio}`,
      '-filter_complex', '[0:v]trim=end_frame=30,setpts=PTS-STARTPTS[r];[1:v]trim=end_frame=30,setpts=PTS-STARTPTS[b];[r][b]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-g', '240', '-bf', '2', '-pix_fmt', 'yuv420p', f.source], { windowsHide: true, timeout: 20000 });
    expect(create.status, create.stderr?.toString()).toBe(0);
    const execution = createFFmpegExecution({ getFFmpegPath: () => FFMPEG, getUserDataDir: () => f.directory });
    const runtime = createClipFrameCache({ ...f.options, execute: (args, options) => execution.execute(args, options),
      probe: async () => ({ duration: 60 / rate, video: { fps: rate, width: 64, height: 48 } }) });
    try {
      const before = await runtime.frame({ path: f.source, time: 29 / rate, fps });
      const after = await runtime.frame({ path: f.source, time: 30 / rate, fps });
      expect(before).toMatchObject({ width: 64, height: 48, time: 29 / rate });
      expect(after).toMatchObject({ width: 64, height: 48, time: 30 / rate });
      const rgb = file => {
        const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file,
          '-vf', 'crop=1:1:32:24', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 10000 });
        expect(result.status, result.stderr?.toString()).toBe(0);
        return [...result.stdout];
      };
      const red = rgb(before.path), blue = rgb(after.path);
      expect(red[0]).toBeGreaterThan(220); expect(red[2]).toBeLessThan(30);
      expect(blue[2]).toBeGreaterThan(220); expect(blue[0]).toBeLessThan(30);
      expect(buildClipFrameArgs({ path: f.source, time: 29 / rate, fps }, before.path)).toContain('-noaccurate_seek');
    } finally { await execution.cancelAllAndWait(); }
  }, 30000);
});

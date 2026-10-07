// @subtool-ci windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createClipFrameCache, validateClipFrameRequest, buildClipFrameArgs } = require('../electron/clip-frame-cache.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const ROOT = path.resolve('');
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'electron/ffmpeg/ffmpeg.exe');
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
    expect(first).toMatchObject({ ok: true, time: 29 / 30, width: 1, height: 1 });
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

  it('同一幀只產生一次，精確 NTSC 格網與素材結尾不會擷取下一格', async () => {
    const f = fixture();
    const results = await Promise.all([f.runtime.frame(f.request), f.runtime.frame(f.request)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.execute).toHaveBeenCalledOnce();
    const last = await f.runtime.frame({ ...f.request, time: 2 });
    expect(last.time).toBe(59 / 30);
    const ntsc = await f.runtime.frame({ ...f.request, time: 29 / (30000 / 1001), fps: 29.97 });
    expect(ntsc.time).toBe(29 / (30000 / 1001));
    expect(f.runtime.activeCount()).toBe(0);
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

  nativeIt('真62格30fps的probe向上捨入時長，末格仍可擷取而不落到EOF',async()=>{
    const f=fixture();
    const create=spawnSync(FFMPEG,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=64x48:r=30',
      '-frames:v','62','-c:v','libx264','-pix_fmt','yuv420p',f.source],{windowsHide:true,timeout:20000});
    expect(create.status,create.stderr?.toString()).toBe(0);
    const ffprobe=path.join(path.dirname(FFMPEG),'ffprobe.exe');
    const probed=spawnSync(ffprobe,['-v','error','-show_entries','format=duration','-of','json',f.source],{windowsHide:true,timeout:10000});
    expect(probed.status,probed.stderr?.toString()).toBe(0);
    const duration=Number(JSON.parse(probed.stdout).format.duration);
    expect(duration).toBe(2.066667);
    const execution=createFFmpegExecution({getFFmpegPath:()=>FFMPEG,getUserDataDir:()=>f.directory});
    const runtime=createClipFrameCache({...f.options,execute:(args,options)=>execution.execute(args,options),
      probe:async()=>({duration,video:{fps:30,width:64,height:48}})});
    try{
      expect(await runtime.frame({path:f.source,time:duration,fps:30})).toMatchObject({time:61/30,width:64,height:48});
    }finally{await execution.cancelAllAndWait();}
  },30000);

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
      expect(buildClipFrameArgs({ path: f.source, time: 29 / rate, fps }, before.path)).not.toContain('-vf');
    } finally { await execution.cancelAllAndWait(); }
  }, 30000);
});

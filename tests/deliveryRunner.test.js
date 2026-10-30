import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createDeliveryRunner } = require('../electron/delivery-runner.js');
const { createExportQueue } = require('../electron/export-queue.js');
const QueueStore = require('../electron/queue-store.js');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { acquireLease, releaseLease, listLeases, stageOutputPath } = require('../electron/export-lease.js');
const nativeFs = require('node:fs');

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function make(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'subtool-delivery-runner-'));
  tempRoots.push(root);
  const queueDir = path.join(root, 'queue');
  const tempDir = path.join(root, 'temp');
  const sent = [];
  const active = new Map();
  const queue = {
    assertJobCapabilities: vi.fn(),
    reportProgress: vi.fn(() => true),
    registerActiveJob: vi.fn((id, value) => { active.set(id, value); return true; }),
    clearActiveJob: vi.fn(id => active.delete(id)),
    activeJob: vi.fn(id => active.get(id) || null),
    ...overrides.queue,
  };
  const runFfmpeg = overrides.runFfmpeg || vi.fn(async (args, options) => {
    const controller = {
      process: { pid: 42 }, stop: vi.fn(), completion: Promise.resolve(),
    };
    options.onProcess(controller);
    options.onProgress({ jobId: options.jobId, pct: 50 });
    return { maps: ['mpeg2video (native) -> h264 (libx264)'] };
  });
  const runner = createDeliveryRunner({
    queue,
    queueDir: () => queueDir,
    tempDir,
    mediaProbe: overrides.mediaProbe || (() => ({
      hasAudio: vi.fn(async () => false),
      audioBitrates: vi.fn(async () => ['320k']),
    })),
    runFfmpeg,
    nativeCapabilities: Object.hasOwn(overrides, 'nativeCapabilities')
      ? overrides.nativeCapabilities : { assertReady: vi.fn(async () => {}) },
    encoder: {
      name: () => 'libx264',
      hwdecArgs: () => [],
      bitrateArgs: () => ['-c:v', 'libx264'],
      proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'],
    },
    fonts: { root: () => null, timecodeFile: () => null, ...overrides.fonts },
    events: {
      senderForId: id => id ? { id } : null,
      fallbackSender: () => ({ id: 'fallback' }),
      send: (target, event, payload) => sent.push({ target, event, payload }),
    },
    now: overrides.now || (() => 1000),
  });
  return { runner, queue, queueDir, tempDir, sent, active, runFfmpeg };
}

function videoJob(overrides = {}) {
  return {
    id: 'delivery-1', senderId: 7, assRef: null,
    payload: {
      format: 'h264', width: 1920, height: 1080, fps: 25, duration: 10,
      videoKbps: 8000, audioPlan: null, timecodeWatermark: null,
      outPath: 'D:/out/delivery.mp4',
      videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
      clips: [{
        path: 'D:/source/master.mxf', type: 'video', vtrack: 0,
        in: 0, out: 10, offset: 0, natW: 1280, natH: 720,
        fadeIn: 0, fadeOut: 0,
      }],
    },
    ...overrides,
  };
}

describe('delivery runner public interface', () => {
  it('佇列失敗後重試同一 frozen 工作會再核對 native 能力，修復前不啟動母素材 probe', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'subtool-delivery-capability-retry-')); tempRoots.push(root);
    const queueDir = path.join(root, 'queue'), tempDir = path.join(root, 'work');
    let available = false, runner;
    const assertReady = vi.fn(async () => {
      if (!available) throw Object.assign(new Error('aac_mf runtime unavailable'), { code: 'DELIVERY_ENCODER_UNAVAILABLE' });
    });
    const hasAudio = vi.fn(async () => false), runFfmpeg = vi.fn(async () => ({ maps: [] }));
    const queue = createExportQueue({ dir: () => queueDir, store: QueueStore, history: QueueStore.QueueHistory,
      admission: { sourcePathsOf: job => QueueStore.collectSourcePaths(job.payload),
        assertJobAdmissible() {}, assertMasterMedia() {}, assertOutputAvailable() {}, assertOutputFormat() {} },
      grantPersistedCapabilities() {}, canReadSource: () => true, canWriteDelivery: () => true,
      isFile: () => true, runJob: job => runner.run(job), onChanged() {},
    });
    runner = createDeliveryRunner({ queue, queueDir: () => queueDir, tempDir,
      nativeCapabilities: { assertReady }, mediaProbe: () => ({ hasAudio, audioBitrates: async () => [] }),
      encoder: { bitrateArgs: () => ['-c:v', 'libx264'] }, runFfmpeg,
    });
    const job = videoJob({ status: 'queued', createdAt: Date.now() });
    job.payload.format = 'airline-dmpes'; job.payload.outPath = path.join(root, 'air.mpg');
    queue.addJob(job);
    await vi.waitFor(() => expect(queue.get(job.id).status).toBe('failed'));
    await vi.waitFor(() => expect(queue.activeJob(job.id)).toBeNull());
    expect(hasAudio).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(existsSync(tempDir)).toBe(false);
    available = true;
    expect(queue.retryJob(job.id)).toBe(true);
    await vi.waitFor(() => expect(queue.get(job.id).status).toBe('done'));
    expect(assertReady).toHaveBeenCalledTimes(2);
    expect(hasAudio).toHaveBeenCalledOnce();
    expect(runFfmpeg).toHaveBeenCalledOnce();
    const args = runFfmpeg.mock.calls[0][0];
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac_mf');
  });

  it('缺少 native 能力 adapter 時拒絕建立 runner，不能讓交付默默略過能力檢查', () => {
    expect(() => make({ nativeCapabilities: null })).toThrow(/native.*能力/);
  });

  it.each(['airline-dmpes', 'airline-dmpes-4m', 'dvd-iso', 'bd-iso'])
  ('%s 缺少實際 native 能力時，在母素材 probe、暫存與編碼前拒絕', async format => {
    const failure = Object.assign(new Error('此交付缺少 native 能力'), { code: 'DELIVERY_ENCODER_UNAVAILABLE' });
    const assertReady = vi.fn(async () => { throw failure; });
    const hasAudio = vi.fn(async () => false);
    const setup = make({ nativeCapabilities: { assertReady }, mediaProbe: () => ({ hasAudio }) });
    const job = videoJob();
    Object.assign(job.payload, { format, outPath: /-iso$/.test(format) ? 'D:/out/disc.iso' : 'D:/out/air.mpg' });
    await setup.runner.run(job);
    expect(assertReady).toHaveBeenCalledWith(job.payload, { signal: expect.any(AbortSignal) });
    expect(hasAudio).not.toHaveBeenCalled();
    expect(setup.runFfmpeg).not.toHaveBeenCalled();
    expect(existsSync(setup.tempDir)).toBe(false);
    expect(setup.sent.at(-1)?.payload).toMatchObject({ error: true, errorMsg: failure.message });
    expect(setup.active.size).toBe(0);
  });

  it.each(['user-stop', 'shutdown'])('能力探針準備期間可 %s，取消後不讀母素材或建立暫存', async reason => {
    let signal;
    const assertReady = vi.fn((payload, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('native probe aborted')), { once: true });
    }));
    const hasAudio = vi.fn();
    const setup = make({ nativeCapabilities: { assertReady }, mediaProbe: () => ({ hasAudio }) });
    const pending = setup.runner.run(videoJob());
    setup.active.get('delivery-1').stop(reason);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(hasAudio).not.toHaveBeenCalled();
    expect(setup.runFfmpeg).not.toHaveBeenCalled();
    expect(existsSync(setup.tempDir)).toBe(false);
    expect(setup.active.size).toBe(0);
    if (reason === 'shutdown') expect(setup.sent).toEqual([]);
    else expect(setup.sent.at(-1)?.payload).toMatchObject({ stopped: true });
  });
  it.each([false, true])('時間碼字型用 ASCII 相對路徑交付並在成功／失敗後清除（failure=%s）', async failure => {
    let source, staged;
    const bytes=Buffer.from('original font bytes');
    const setup=make({fonts:{timecodeFile:()=>source},runFfmpeg:vi.fn(async (args, options)=>{
      const graph=args[args.indexOf('-filter_complex')+1];
      staged=/drawtext=fontfile=([^:]+):/.exec(graph)?.[1];
      expect(staged).toMatch(/^[a-zA-Z0-9_.-]+$/);
      expect(options.cwd).toBe(setup.tempDir);
      expect(readFileSync(path.join(options.cwd,staged))).toEqual(bytes);
      if(failure) throw new Error('native encoder failure');
      return {maps:[]};
    })});
    const fontDir=path.join(path.dirname(setup.tempDir),'字型 🚀');mkdirSync(fontDir);
    source=path.join(fontDir,'face.ttf');writeFileSync(source,bytes);
    const job=videoJob();job.payload.timecodeWatermark={start:'01:00:00:00'};
    await setup.runner.run(job);
    expect(setup.runFfmpeg).toHaveBeenCalledOnce();
    expect(staged).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(readFileSync(source)).toEqual(bytes);
    expect(readdirSync(setup.tempDir)).toEqual([]);
    expect(setup.sent.at(-1)?.payload).toMatchObject(failure?{error:true}:{done:true});
  });
  it.each(['wav', 'h264', 'prores', 'mod-fhd', 'airline-exw', 'airline-dmpes', 'airline-dmpes-4m', 'dvd-iso', 'bd-iso'])
  ('%s 對 audioPlan 獨立母來源取得時鐘證據，交付不依賴來源出現在影片清單', async format => {
    const source = path.resolve('D:/external/delayed.mov');
    const hasAudio = vi.fn(async () => true), audioVideoStartOffsets = vi.fn(async file => file === source ? [1] : [0]);
    const f = make({ mediaProbe: () => ({ hasAudio, audioVideoStartOffsets, audioBitrates: vi.fn(async () => []) }) });
    const job = videoJob();
    job.payload = { ...job.payload, format, fps: 29.97, duration: 3,
      clips: format === 'wav' ? [] : [{ ...job.payload.clips[0], out: 3 }],
      outPath: 'D:/out/delivery.' + (format === 'wav' ? 'wav' : format === 'prores' ? 'mov' : /-iso$/.test(format) ? 'iso' : format === 'mod-fhd' ? 'ts' : format.startsWith('airline-') ? 'mpg' : 'mp4'),
      audioPlan: { buses: ['left', 'right'].map(id => ({ id, inputs: [{ file: source, trimStart: 0, trimEnd: 3,
        sourceStream: 0, sourceChannel: 0 }] })), streams: [{ layout: 'stereo', busIds: ['left', 'right'] }] },
    };
    await f.runner.run(job);
    expect(audioVideoStartOffsets).toHaveBeenCalledWith(source, { signal: expect.any(AbortSignal) });
    expect(f.runFfmpeg).toHaveBeenCalledOnce();
    const args = f.runFfmpeg.mock.calls[0][0], graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('asetpts=PTS-STARTPTS+1.000000/TB,aresample=first_pts=0,atrim=');
    expect(f.queue.reportProgress).toHaveBeenLastCalledWith(job.id, expect.objectContaining({ done: true }));
  });
  it.skipIf(process.platform !== 'win32')('Windows 同母檔的大小寫別名只探測一次，音訊路由仍使用同一份開聲時間', async () => {
    const source = path.resolve('D:/source/Master.mov');
    const hasAudio = vi.fn(async () => true), audioVideoStartOffsets = vi.fn(async () => [1]);
    const setup = make({ mediaProbe: () => ({ hasAudio, audioVideoStartOffsets, audioBitrates: async () => [] }) });
    const job = videoJob();
    job.payload.clips = [{ ...job.payload.clips[0], path: source, out: 3 }];
    job.payload.duration = 3;
    job.payload.audioPlan = { buses: [{ id: 'mono', inputs: [{ file: source.toUpperCase(), trimStart: 0, trimEnd: 3,
      sourceStream: 0, sourceChannel: 0 }] }], streams: [{ layout: 'mono', busIds: ['mono'] }] };
    await setup.runner.run(job);
    expect(hasAudio).toHaveBeenCalledOnce();
    expect(audioVideoStartOffsets).toHaveBeenCalledOnce();
    const args = setup.runFfmpeg.mock.calls[0][0];
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('asetpts=PTS-STARTPTS+1.000000/TB,aresample=first_pts=0,atrim=');
    expect(setup.queue.reportProgress).toHaveBeenLastCalledWith(job.id, expect.objectContaining({ done: true }));
  });
  it.each(['user-stop', 'shutdown'])('準備期 probe 可以 %s，未啟動 ffmpeg 前就完整取消', async reason => {
    let signal;
    const setup = make({ mediaProbe: () => ({
      hasAudio: (file, options) => new Promise((resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
      }),
    }) });
    const run = setup.runner.run(videoJob());
    const active = setup.active.get('delivery-1');
    expect(active.p).toBeNull();
    await vi.waitFor(() => expect(signal).toBeDefined());
    active.stop(reason);
    expect(signal.aborted).toBe(true);
    await run;
    await active.completion;
    expect(setup.runFfmpeg).not.toHaveBeenCalled();
    expect(setup.active.size).toBe(0);
    if (reason === 'user-stop') expect(setup.sent.at(-1)?.payload).toMatchObject({ stopped: true });
    else expect(setup.sent).toEqual([]);
  });

  it.each(['user-stop', 'shutdown'])('發佈成品後 %s 取消結果 probe，仍提交 done 而不把已交付檔案降成 stopped', async reason => {
    let setup;
    setup = make({ mediaProbe: () => ({
      hasAudio: async () => false,
      audioBitrates: async () => { setup.active.get('delivery-1').stop(reason); throw new Error('probe aborted'); },
    }) });
    await setup.runner.run(videoJob());
    expect(setup.sent.at(-1)?.payload).toMatchObject({ done: true, result: { audioActualBitrates: null } });
    expect(setup.active.size).toBe(0);
  });

  it.each(['h264', 'mod-fhd', 'airline-exw'])('%s 成品成功後結果資訊 probe 失敗仍回報 done 並清除 active 工作', async format => {
    const audioBitrates = vi.fn(async () => { throw new Error('結果資訊讀取失敗'); });
    const setup = make({ mediaProbe: () => ({ hasAudio: async () => false, audioBitrates }) });
    const job = videoJob();
    job.payload.format = format;

    await setup.runner.run(job);
    await setup.queue.registerActiveJob.mock.calls[0][1].completion;

    expect(setup.runFfmpeg).toHaveBeenCalledOnce();
    expect(audioBitrates).toHaveBeenCalledOnce();
    expect(setup.queue.reportProgress).toHaveBeenLastCalledWith('delivery-1',
      expect.objectContaining({ done: true, result: expect.objectContaining({ audioActualBitrates: null }) }));
    expect(setup.sent.at(-1)?.payload).toMatchObject({ done: true, result: { audioActualBitrates: null } });
    expect(setup.sent.some(item => item.payload?.error || item.payload?.stopped)).toBe(false);
    expect(setup.active.size).toBe(0);
    expect(setup.queue.clearActiveJob).toHaveBeenCalledWith('delivery-1');
  });

  it.each(['FFMPEG_EXIT', 'INVALID_TRANSPORT', 'LEASE_RELEASE_FAILED'])('真正 execution 以 %s 拒絕時仍回報失敗，不執行結果資訊 probe', async code => {
    const failure = Object.assign(new Error(`成品階段失敗：${code}`), { code });
    const audioBitrates = vi.fn();
    const setup = make({
      mediaProbe: () => ({ hasAudio: async () => false, audioBitrates }),
      runFfmpeg: vi.fn(async () => { throw failure; }),
    });

    await setup.runner.run(videoJob());

    expect(audioBitrates).not.toHaveBeenCalled();
    expect(setup.queue.reportProgress).toHaveBeenLastCalledWith('delivery-1',
      expect.objectContaining({ error: true, errorMsg: failure.message }));
    expect(setup.sent.some(item => item.payload?.done)).toBe(false);
    expect(setup.active.size).toBe(0);
  });

  it.each([false, true])('成品提交後停止仍依 lease 收尾結果保存終態（releaseFailure=%s）', async releaseFailure => {
    const root = mkdtempSync(path.join(tmpdir(), 'subtool-delivery-release-')); tempRoots.push(root);
    const queueDir = path.join(root, 'queue'), outPath = path.join(root, 'delivery.mp4');
    const token = 'completed-delivery-token', stagePath = stageOutputPath(outPath, token);
    const completedBytes = Buffer.from('completed delivery bytes preserved after commit');
    const sent = [], stop = vi.fn(), releaseError = Object.assign(new Error('輸出鎖暫時無法移除'), { code: 'EPERM' });
    let runner, lease, failedReleaseAttempts = 0;
    const queue = createExportQueue({ dir: () => queueDir, store: QueueStore, history: QueueStore.QueueHistory,
      admission: { sourcePathsOf: job => QueueStore.collectSourcePaths(job.payload),
        assertJobAdmissible() {}, assertMasterMedia() {}, assertOutputAvailable() {}, assertOutputFormat() {} },
      grantPersistedCapabilities() {}, canReadSource: () => true, canWriteDelivery: () => true,
      isFile: () => true, runJob: job => runner.run(job), onChanged() {},
    });
    const rmdir = nativeFs.rmdirSync;
    const removeLock = vi.spyOn(nativeFs, 'rmdirSync').mockImplementation((file, ...args) => {
      if (releaseFailure && file === lease?.lockPath) { failedReleaseAttempts++; throw releaseError; }
      return rmdir(file, ...args);
    });
    const execution = createFFmpegExecution({ getFFmpegPath: () => 'ffmpeg', getQueueDir: () => queueDir,
      spawnWatchdog(config, handlers) {
        // 控制 watchdog 的跨程序通知時機；stage、commit 與 lease 收尾仍操作真實檔案。
        const completion = Promise.resolve().then(() => {
          lease = acquireLease({ queueDir, outPath, token, stagePath, jobId: config.jobId });
          writeFileSync(stagePath, completedBytes);
          nativeFs.renameSync(stagePath, outPath);
          expect(queue.stopJob(config.jobId)).toBe(true);
          let release;
          try { release = releaseLease({ queueDir, outPath, token }); }
          catch (error) {
            release = { retainedLease: true, error: { code: error.code, message: error.message } };
            handlers.onMessage({ type: 'error', code: 'LEASE_RELEASE_FAILED', message: error.message });
          }
          // 正式 watchdog 已 commit 的結果沒有 cleanup，殘留鎖在 release 中。
          return { ok: !release?.error, code: 0, cleanup: null, release };
        });
        return { ready: Promise.resolve(), completion, stop };
      },
    });
    const audioBitrates = vi.fn(async () => []);
    const runFfmpeg = vi.fn((args, options) => execution.execute(args, options));
    runner = createDeliveryRunner({ queue, queueDir: () => queueDir, tempDir: path.join(root, 'work'),
      nativeCapabilities: { assertReady: async () => {} },
      mediaProbe: () => ({ hasAudio: async () => false, audioBitrates }),
      encoder: { bitrateArgs: () => ['-c:v', 'libx264'] }, runFfmpeg,
      events: { senderForId: () => ({}), send: (target, event, data) => sent.push(data) },
    });
    const job = videoJob({ status: 'queued', createdAt: Date.now() });
    job.payload.outPath = outPath;
    try {
      queue.addJob(job);
      await vi.waitFor(() => {
        expect(runFfmpeg).toHaveBeenCalledOnce();
        expect(queue.activeJob(job.id)).toBeNull();
      });
      expect(stop).toHaveBeenCalledWith('user-stop');
      expect(readFileSync(outPath)).toEqual(completedBytes);
      expect(existsSync(stagePath)).toBe(false);
      expect(failedReleaseAttempts).toBe(releaseFailure ? 1 : 0);
      if (releaseFailure) {
        expect(listLeases(queueDir)).toMatchObject([{ valid: true, owner: { token } }]);
        expect(() => acquireLease({ queueDir, outPath, jobId: 'next', token: 'next' })).toThrow(/already leased/);
        expect(queue.get(job.id)).toMatchObject({ status: 'failed', errorMsg: expect.stringContaining(releaseError.message) });
        expect(QueueStore.loadTerminalOutcomes(queueDir)).toMatchObject([
          { id: job.id, status: 'failed', errorMsg: expect.stringContaining(releaseError.message) },
        ]);
        expect(sent.at(-1)).toMatchObject({ error: true, errorMsg: expect.stringContaining(releaseError.message) });
        expect(audioBitrates).not.toHaveBeenCalled();
      } else {
        expect(listLeases(queueDir)).toEqual([]);
        expect(queue.get(job.id).status).toBe('done');
        expect(sent.at(-1)).toMatchObject({ done: true });
        expect(audioBitrates).toHaveBeenCalledOnce();
      }
    } finally { removeLock.mockRestore(); }
  });

  it('航空來源的音訊前導時間送入正式轉檔計畫', async () => {
    const setup = make({ mediaProbe: () => ({
      hasAudio: async () => true,
      audioVideoStartOffsets: async () => [-481 / 48000],
      audioBitrates: async () => [{ channels: 2, kbps: 128 }],
    }) });
    const job = videoJob();
    Object.assign(job.payload, { format: 'airline-exw', outPath: 'D:/out/delivery.mpg' });
    await setup.runner.run(job);
    const argv = setup.runFfmpeg.mock.calls[0][0];
    expect(argv[argv.indexOf('-filter_complex') + 1])
      .toContain('asetpts=PTS-STARTPTS-0.010021/TB,aresample=first_pts=0');
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 缺省音訊沿用 stereo，最後回報單一 ISO', async format => {
    const setup = make();
    const job = videoJob();
    Object.assign(job.payload, { format, outPath: 'D:/out/disc.iso' });
    await setup.runner.run(job);
    expect(setup.runFfmpeg).toHaveBeenCalledWith(expect.any(Array),
      expect.objectContaining({ outputFormat: format, discAudioPlan: null,
        discVideoFps: format === 'bd-iso' ? 25 : 29.97 }));
    expect(setup.sent.at(-1)?.payload).toMatchObject({ done: true,
      result: { container: 'iso', outputFiles: [path.join('D:/out', 'disc.iso')], audioActualBitrates: null } });
  });
  it('光碟容量估算包含超出影像範圍的音訊尾端', async () => {
    const setup = make();
    const job = videoJob();
    const audioPlan = { buses: [{ id: 'a', inputs: [{ file: 'long.wav', trimStart: 0, trimEnd: 7200 }] }],
      streams: [{ layout: 'mono', busIds: ['a'] }] };
    Object.assign(job.payload, { format: 'dvd-iso', outPath: 'D:/out/disc.iso', audioPlan });
    await setup.runner.run(job);
    expect(setup.runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(['-b:v', '4100k']),
      expect.objectContaining({ duration: 7200, discAudioPlan: { streams: expect.arrayContaining([
        expect.objectContaining({ layout: 'mono', busIds: ['a'] }),
      ]) } }));
  });
  it('MOD-FHD 把封裝模式傳到 execution，編碼器與音訊結果反映固定規格', async () => {
    const setup = make();
    const job = videoJob();
    job.payload.format = 'mod-fhd';
    job.payload.outPath = 'D:/out/delivery.ts';
    await setup.runner.run(job);
    expect(setup.runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(['-f', 'mpegts']),
      expect.objectContaining({ outputFormat: 'mod-fhd' }));
    expect(setup.sent.at(-1)?.payload).toMatchObject({ done: true,
      result: { encoder: 'libx264', gpu: false, videoKbps: 7280, audioBitrates: ['256k'] } });
  });
  it('以完整交易執行計畫、註冊程序並提交可觀察結果', async () => {
    let clock = 1000;
    const setup = make({ now: () => (clock += 250) });

    await setup.runner.run(videoJob());

    expect(setup.queue.assertJobCapabilities).toHaveBeenCalledOnce();
    expect(setup.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining(['-c:v', 'libx264', 'D:/out/delivery.mp4']),
      expect.objectContaining({ jobId: 'delivery-1', cwd: setup.tempDir }),
    );
    expect(setup.queue.registerActiveJob).toHaveBeenCalledOnce();
    expect(setup.queue.clearActiveJob).toHaveBeenCalledWith('delivery-1');
    expect(setup.sent.at(-1)).toMatchObject({
      target: { id: 7 }, event: 'task-progress',
      payload: { done: true, result: { encoder: 'libx264', gpu: false, videoKbps: 8000 } },
    });
  });

  it('queue 拒絕終態時不會先通知 renderer 完成', async () => {
    const setup = make({ queue: { reportProgress: vi.fn(() => false) } });

    await setup.runner.run(videoJob());

    expect(setup.queue.reportProgress).toHaveBeenCalledWith('delivery-1', expect.objectContaining({ done: true }));
    expect(setup.sent.some(item => item.payload?.done)).toBe(false);
  });

  it('找不到 frozen ASS 時以 MISSING_SOURCE 拒絕，ffmpeg 不會啟動', async () => {
    const setup = make();

    await expect(setup.runner.run(videoJob({ assRef: 'missing.ass' }))).rejects.toMatchObject({
      code: 'MISSING_SOURCE',
    });
    expect(setup.runFfmpeg).not.toHaveBeenCalled();
    expect(existsSync(path.join(setup.tempDir, 'burn_delivery-1.ass'))).toBe(false);
  });

  it('使用者停止優先於隨後的 shutdown，回報 stopped 而不是 error', async () => {
    let setup;
    const runFfmpeg = vi.fn(async (args, options) => {
      const controller = { process: {}, stop: vi.fn(), completion: Promise.resolve() };
      options.onProcess(controller);
      setup.active.get('delivery-1').stopped = true;
      setup.active.get('delivery-1').shutdown = true;
      throw new Error('terminated');
    });
    setup = make({ runFfmpeg });

    await setup.runner.run(videoJob());

    expect(setup.queue.reportProgress).toHaveBeenLastCalledWith(
      'delivery-1', expect.objectContaining({ stopped: true }),
    );
    expect(setup.sent.at(-1)?.payload).toMatchObject({ stopped: true });
  });
});

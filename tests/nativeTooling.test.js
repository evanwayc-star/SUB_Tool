import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  bundledNativeRequirements,
  createDeliveryCapabilities,
  deliveryVideoEncoderArgs,
  detectNativeTool,
  mpvEmbeddingSupported,
  nativeToolCandidates,
  previewVideoEncoderArgs,
  videoEncoderCandidates,
} = require('../electron/ffmpeg-execution-engine.js');

function deliverySpec(format) {
  return { format, width: 640, height: 360, fps: 29.97, duration: 1, videoKbps: 5000,
    outPath: 'delivery.out', clips: format === 'wav' ? [] : [{ path: 'master.mov', type: 'video',
      in: 0, out: 1, offset: 0, natW: 640, natH: 360 }],
    audioPlan: { buses: ['left', 'right'].map(id => ({ id, inputs: [{ file: 'master.mov',
      trimStart: 0, trimEnd: 1, sourceStream: 0, sourceChannel: 0 }] })),
    streams: [{ layout: 'stereo', busIds: ['left', 'right'] }] } };
}

function capabilities(overrides = {}) {
  const calls = [];
  const spawn = vi.fn((executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; });
    const call = { executable, args, options, child }; calls.push(call);
    queueMicrotask(() => {
      if (overrides.respond) return overrides.respond(call);
      child.stdout.emit('data', Buffer.from('dvdauthor mkisofs tsMuxeR version\nframe=3\nout_time_us=100000\nprogress=end\n'));
      child.emit('close', 0, null);
    });
    return child;
  });
  const engine = createDeliveryCapabilities({
    spawn, getFFmpegPath: () => '/native/ffmpeg',
    getDiscPaths: () => ({ dvdauthor: '/native/dvdauthor', mkisofs: '/native/mkisofs', tsmuxer: '/native/tsMuxeR' }),
    encoder: { name: () => 'libx264', bitrateArgs: kbps => deliveryVideoEncoderArgs('libx264', kbps),
      proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] },
    ...overrides.options,
  });
  return { engine, calls, spawn };
}

describe('交付 native 能力的公開 interface', () => {
  it.each([
    ['h264', ['v:libx264', 'a:aac'], []],
    ['prores', ['v:prores_ks', 'a:pcm_s24le'], []],
    ['wav', ['a:pcm_s24le'], []],
    ['mod-fhd', ['v:libx264', 'a:aac'], []],
    ['airline-exw', ['v:libx264', 'a:aac'], []],
    ['airline-dmpes', ['v:libx264', 'a:aac_mf'], []],
    ['airline-dmpes-4m', ['v:libx264', 'a:aac_mf'], []],
    ['dvd-iso', ['v:mpeg2video', 'a:ac3'], ['dvdauthor', 'mkisofs']],
    ['bd-iso', ['v:libx264', 'a:ac3'], ['tsMuxeR']],
  ])('%s 探測純交付計畫真正採用的編碼器與合成工具', async (format, codecs, tools) => {
    const { engine, calls } = capabilities();
    const spec = deliverySpec(format), original = structuredClone(spec);
    await engine.assertReady(spec);
    const encodes = calls.filter(call => call.executable === '/native/ffmpeg');
    expect(encodes.map(({ args }) => {
      const index = args.findIndex(arg => /^-c:[av]$/.test(arg));
      return `${args[index].slice(3)}:${args[index + 1]}`;
    })).toEqual(codecs);
    for (const { args, options } of encodes) {
      expect(args).toContain('lavfi');
      expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
      expect(args).not.toContain('master.mov');
      expect(options.windowsHide).toBe(true);
    }
    expect(calls.filter(call => call.executable !== '/native/ffmpeg').map(call => call.executable.split('/').at(-1)))
      .toEqual(tools);
    expect(spec).toEqual(original);
  });

  it('編碼器列得出但 runtime 開不起來仍拒絕，修好後重試不沿用失敗', async () => {
    let broken = true;
    const { engine, calls } = capabilities({ respond: ({ args, child }) => {
      const fails = args.includes('aac_mf') && broken;
      if (fails) child.stderr.emit('data', Buffer.from('mfplat runtime unavailable'));
      else child.stdout.emit('data', Buffer.from('frame=3\nout_time_us=100000\nprogress=end\n'));
      child.emit('close', fails ? 1 : 0, null);
    } });
    await expect(engine.assertReady(deliverySpec('airline-dmpes'))).rejects.toMatchObject({
      code: 'DELIVERY_ENCODER_UNAVAILABLE', message: expect.stringContaining('aac_mf'),
    });
    broken = false;
    await engine.assertReady(deliverySpec('airline-dmpes'));
    expect(calls.filter(call => call.args.includes('aac_mf'))).toHaveLength(2);
    expect(calls.some(call => call.args.includes('-encoders'))).toBe(false);
    expect(calls.some(call => call.args.includes('aac'))).toBe(false);
  });

  it('能力檢查不要求 runner 尚未準備的時間碼字型，也不改寫凍結的燒入 TC 規格', async () => {
    const { engine } = capabilities();
    const spec = { ...deliverySpec('mod-fhd'), timecodeWatermark: { start: '01:00:00;00' } };
    const original = structuredClone(spec);
    await engine.assertReady(spec);
    expect(spec).toEqual(original);
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 缺少合成工具或其 runtime 時直接拒絕', async format => {
    const { engine } = capabilities({ respond: ({ executable, child }) => {
      if (executable !== '/native/ffmpeg') child.emit('error', Object.assign(new Error('native DLL missing'), { code: 'ENOENT' }));
      else child.stdout.emit('data', Buffer.from('frame=3\nout_time_us=100000\nprogress=end\n'));
      child.emit('close', executable === '/native/ffmpeg' ? 0 : null, null);
    } });
    await expect(engine.assertReady(deliverySpec(format))).rejects.toMatchObject({ code: 'DISC_NATIVE_MISSING' });
  });

  it('exit 0 卻沒有編出任何時間的探針不算具備 encoder 能力', async () => {
    const { engine } = capabilities({ respond: ({ child }) => {
      child.stdout.emit('data', Buffer.from('out_time_us=0\nprogress=end\n'));
      child.emit('close', 0, null);
    } });
    await expect(engine.assertReady(deliverySpec('h264'))).rejects.toMatchObject({ code: 'DELIVERY_ENCODER_UNAVAILABLE' });
  });

  it.each(['h264', 'dvd-iso'])('%s 每次準備重測，執行檔沒變但 DLL/runtime 消失也必須拒絕', async format => {
    let broken = false;
    const { engine, calls } = capabilities({ respond: ({ executable, child }) => {
      const fails = broken && (format === 'h264' || executable !== '/native/ffmpeg');
      if (fails) child.emit('error', new Error('runtime DLL removed'));
      else child.stdout.emit('data', Buffer.from('dvdauthor mkisofs\nframe=3\nout_time_us=100000\nprogress=end\n'));
      child.emit('close', fails ? null : 0, null);
    } });
    await engine.assertReady(deliverySpec(format));
    const first = calls.length;
    broken = true;
    await expect(engine.assertReady(deliverySpec(format))).rejects.toMatchObject({
      code: format === 'h264' ? 'DELIVERY_ENCODER_UNAVAILABLE' : 'DISC_NATIVE_MISSING',
    });
    expect(calls.length).toBeGreaterThan(first);
  });

  it('短影片探針已交出畫格但因 NVENC 重排使 out_time_us=0，仍接受其完成證據', async () => {
    const { engine } = capabilities({ respond: ({ args, child }) => {
      child.stdout.emit('data', Buffer.from(args.includes('-c:v')
        ? 'frame=3\nout_time_us=0\nprogress=end\n' : 'out_time_us=100000\nprogress=end\n'));
      child.emit('close', 0, null);
    }, options: { encoder: { name: () => 'h264_nvenc', bitrateArgs: kbps => deliveryVideoEncoderArgs('h264_nvenc', kbps) } } });
    await expect(engine.assertReady(deliverySpec('h264'))).resolves.toBeUndefined();
  });

  it('取消探針仍等 writer close，error 或 kill 回傳不會冒充關閉證據', async () => {
    const { engine, calls } = capabilities({ respond: () => {} });
    const controller = new AbortController();
    const work = engine.assertReady(deliverySpec('h264'), { signal: controller.signal });
    const observed = work.then(() => 'ready', error => error.name);
    let settled = false; observed.then(() => { settled = true; });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const child = calls[0].child;
    child.kill.mockImplementation(() => { child.emit('error', new Error('kill pending')); return true; });
    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    expect(await observed).toBe('AbortError');
    expect(calls).toHaveLength(1);
  });

  it('主程序關閉時取消未入列探針並等 close，取消關閉後可重新準入', async () => {
    let hold = true;
    const { engine, calls } = capabilities({ respond: ({ child }) => {
      if (!hold) {
        child.stdout.emit('data', Buffer.from('frame=3\nout_time_us=100000\nprogress=end\n'));
        child.emit('close', 0, null);
      }
    } });
    const pending = engine.assertReady(deliverySpec('h264')).catch(error => error.name);
    const child = calls[0].child;
    child.kill.mockImplementation(() => true);
    let closed = false;
    const shutdown = engine.cancelAllAndWait().then(() => { closed = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalled();
    expect(closed).toBe(false);
    child.emit('close', null, 'SIGKILL');
    expect(await pending).toBe('AbortError');
    await shutdown;
    await expect(engine.assertReady(deliverySpec('h264'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
    expect(engine.resume()).toBe(true);
    hold = false;
    await engine.assertReady(deliverySpec('h264'));
    expect(calls).toHaveLength(3);
  });
});

describe('原生工具候選路徑', () => {
  it('Apple Silicon 只產生 macOS arm64 路徑，不混入 Windows 執行檔', () => {
    const candidates = nativeToolCandidates('ffmpeg', {
      platform: 'darwin',
      arch: 'arm64',
      moduleDir: '/Applications/SUB Tool.app/Contents/Resources/app.asar/electron',
      resourcesPath: '/Applications/SUB Tool.app/Contents/Resources',
      env: { FFMPEG_PATH: '/custom/ffmpeg' },
      homeDir: '/Users/evan',
    });

    expect(candidates).toContain(
      '/Applications/SUB Tool.app/Contents/Resources/app.asar.unpacked/electron/ffmpeg/darwin-arm64/ffmpeg',
    );
    expect(candidates).toContain('/opt/homebrew/bin/ffmpeg');
    expect(candidates).toContain('/custom/ffmpeg');
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/\.exe$/i),
      expect.stringContaining('Program Files'),
      expect.stringContaining('\\'),
    ]));
  });

  it('內建檔不可執行時會繼續探測 Apple Silicon Homebrew 路徑', () => {
    const calls = [];
    const result = detectNativeTool('ffmpeg', {
      platform: 'darwin',
      arch: 'arm64',
      moduleDir: '/app/electron',
      resourcesPath: '/app/resources',
      env: {},
      homeDir: '/Users/evan',
      spawnSync(candidate) {
        calls.push(candidate);
        if (candidate === '/opt/homebrew/bin/ffmpeg') return { status: 0, signal: null };
        return { status: null, signal: null, error: { code: 'ENOENT', message: 'not found' } };
      },
    });

    expect(result.path).toBe('/opt/homebrew/bin/ffmpeg');
    expect(calls.at(-1)).toBe('/opt/homebrew/bin/ffmpeg');
    expect(result.attempts.at(-1)).toMatchObject({
      candidate: '/opt/homebrew/bin/ffmpeg',
      ok: true,
      status: 0,
    });
  });

  it('Apple Silicon 測試版只封裝 ffmpeg 與 ffprobe，不宣稱支援 mpv', () => {
    const requirements = bundledNativeRequirements({ platform: 'darwin', arch: 'arm64' });

    expect(requirements.map(item => item.relativePath)).toEqual([
      'electron/ffmpeg/darwin-arm64/ffmpeg',
      'electron/ffmpeg/darwin-arm64/ffprobe',
    ]);
    expect(requirements.every(item => item.executable)).toBe(true);
  });

  it('未實作的 Windows ARM 不會誤套 x64 原生檔需求', () => {
    expect(() => bundledNativeRequirements({ platform: 'win32', arch: 'arm64' }))
      .toThrow(/尚未支援 win32\/arm64/);
  });

  it('macOS 優先探測 VideoToolbox，Windows 維持既有三種硬體編碼器', () => {
    expect(videoEncoderCandidates('darwin')).toEqual(['h264_videotoolbox']);
    expect(videoEncoderCandidates('win32')).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf']);
  });

  it('VideoToolbox 探測成功後，proxy 與交付匯出真的使用該編碼器', () => {
    expect(previewVideoEncoderArgs('h264_videotoolbox')).toEqual([
      '-c:v', 'h264_videotoolbox',
      '-b:v', '4M',
      '-realtime', '1',
      '-allow_sw', '1',
      '-bf', '0',
    ]);
    expect(deliveryVideoEncoderArgs('h264_videotoolbox', 8000)).toEqual([
      '-c:v', 'h264_videotoolbox',
      '-b:v', '8000k',
      '-maxrate', '8000k',
      '-bufsize', '16000k',
      '-realtime', '1',
      '-allow_sw', '1',
    ]);
  });

  it('抽出參數映射後仍保留既有 Windows 與 libx264 行為', () => {
    expect(previewVideoEncoderArgs('h264_nvenc')).toContain('h264_nvenc');
    expect(previewVideoEncoderArgs('libx264')).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '26',
    ]);
    expect(deliveryVideoEncoderArgs('h264_qsv', 6000)).toEqual([
      '-c:v', 'h264_qsv', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
    ]);
  });

  it('每個可探測的硬體編碼器都同時有 proxy 與交付參數映射', () => {
    for (const platform of ['win32', 'darwin']) {
      for (const encoder of videoEncoderCandidates(platform)) {
        expect(previewVideoEncoderArgs(encoder).slice(0, 2)).toEqual(['-c:v', encoder]);
        expect(deliveryVideoEncoderArgs(encoder, 6000).slice(0, 2)).toEqual(['-c:v', encoder]);
      }
    }
  });

  it('第一版只在 Windows 啟用已驗證的 mpv HWND 嵌入', () => {
    expect(mpvEmbeddingSupported('win32')).toBe(true);
    expect(mpvEmbeddingSupported('darwin')).toBe(false);
  });

  it('Windows mpv 探測使用實際 bundle 目錄與 --version，而不是 ffmpeg/mpv.exe', () => {
    const calls = [];
    const result = detectNativeTool('mpv', {
      platform: 'win32',
      moduleDir: 'C:\\app\\electron',
      resourcesPath: 'C:\\app\\resources',
      env: { MPV_PATH: 'D:\\tools\\mpv.exe' },
      spawnSync(candidate, args) {
        calls.push({ candidate, args });
        return candidate.endsWith('mpv.exe') ? { status: 0, signal: null } : { status: null, signal: null };
      },
    });

    expect(nativeToolCandidates('mpv', {
      platform: 'win32', moduleDir: 'C:\\app\\electron', resourcesPath: 'C:\\app\\resources', env: {},
    })).toEqual(expect.arrayContaining([
      'C:\\app\\electron\\mpv\\mpv.exe',
      'C:\\app\\resources\\app.asar.unpacked\\electron\\mpv\\mpv.exe',
    ]));
    expect(calls[0]).toEqual({ candidate: 'C:\\app\\electron\\mpv\\mpv.exe', args: ['--version'] });
    expect(result.path).toBe('C:\\app\\electron\\mpv\\mpv.exe');
  });
});

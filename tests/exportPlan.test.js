/* 匯出計畫（electron/export-plan.js）。

   這些邏輯決定交付成品長什麼樣，而在抽出成獨立模組之前【一行測試都沒有】——
   它們長在 ipcMain.handle 裡，與 dialog 和 ffprobe spawn 糾纏，vitest 起不了 Electron。
   抽出接縫的整個目的就是讓這裡可以被測。

   對應 docs/技術架構說明.md §0.4（filtergraph 跳脫）與 §0.6（有產出不等於對）。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(ROOT, 'electron/export-plan.js'));

describe('模組本身保持純淨', () => {
  const fs = require('node:fs');
  const stripComments = src =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const requiresIn = src =>
    [...stripComments(src).matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);

  /* 這條是這個接縫的立身之本：一旦有人在裡面 require('electron') 或 require('fs')，
     它就再也不能在 vitest 裡跑，測試會整批消失而沒有人發現。

     v6.1.2 之前這裡斷言的是「一個 require 都不可以有」。那是用來代替真正想守的
     東西——【沒有副作用、起得了 vitest】——的一個近似。為了讓片段幾何與淡入淡出
     的規則能與 renderer 共用同一份實作（shared/*.cjs），這裡改成守真正的那件事：
     只准 require `shared/` 底下的零相依純模組，而且那些模組自己也不可以 require
     任何東西（純淨必須是遞移的，否則 shared/ 會變成偷渡 fs 的後門）。 */
  it('只 require shared/ 底下的純模組，不碰 electron/fs/spawn', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron/export-plan.js'), 'utf8');
    for (const spec of requiresIn(src)) {
      expect(spec, `export-plan.js 不可 require「${spec}」`).toMatch(/^\.\.\/shared\/[\w-]+\.cjs$/);
    }
  });

  it('被 require 的 shared/ 模組自己也零相依（純淨是遞移的）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron/export-plan.js'), 'utf8');
    const specs = requiresIn(src);
    expect(specs.length, 'shared/ 模組沒被 require＝這條測試變成空轉').toBeGreaterThan(0);
    for (const spec of specs) {
      const full = path.join(ROOT, 'electron', spec);
      expect(fs.existsSync(full), `${spec} 不存在——打包時 require 會在啟動就失敗`).toBe(true);
      expect(requiresIn(fs.readFileSync(full, 'utf8')),
        `${spec} 自己 require 了東西，純淨不再遞移`).toEqual([]);
    }
  });
});

describe('AAC 交付 bitrate 依聲道數給足', () => {
  /* 曾經的缺陷是匯出時取到播放快取 chN.m4a 的 128k。這裡鎖住交付值。 */
  it.each([
    [1, '192k'],
    [2, '320k'],
    [6, '640k'],
  ])('%i 聲道 → %s', (channels, expected) => {
    expect(P.aacBitrateForChannels(channels)).toBe(expected);
  });

  it('未知聲道數不會回 undefined（會變成 ffmpeg 的 -b:a undefined）', () => {
    for (const n of [0, 3, 7, 16, null, undefined, NaN]) {
      expect(String(P.aacBitrateForChannels(n))).toMatch(/^\d+k$/);
    }
  });
});

/* §0.4：filtergraph 會先拆選項、選項值再拆一次，所以磁碟機冒號必須跳兩層。
   只跳一層 → ffmpeg 把 ':' 當選項分隔符 → 整條 filterchain 解析失敗 → 匯出直接掛掉。 */
describe('drawtext 值的跳脫（§0.4）', () => {
  it('冒號、分號、反斜線、引號、方括號都被跳脫', () => {
    expect(P._drawtextValue('C:\\Users\\a')).toBe('C\\:/Users/a');
    expect(P._drawtextValue('a;b')).toBe('a\\;b');
    expect(P._drawtextValue("it's")).toBe("it\\'s");
    expect(P._drawtextValue('[x]')).toBe('\\[x\\]');
  });

  it('反斜線一律先轉成正斜線（Windows 路徑進 filtergraph 的前提）', () => {
    expect(P._drawtextValue('C:\\a\\b\\c')).not.toContain('\\\\');
  });
});

describe('時間碼浮水印濾鏡', () => {
  const tc = { start: '01:00:00:00', rate: 25 };

  it('沒有字型就明確報錯，不會默默產出沒有時間碼的成品', () => {
    expect(() => P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', null))
      .toThrow(/更紗黑體/);
  });

  it('字型路徑與時間碼都經過跳脫後才進 filtergraph', () => {
    const out = P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', 'C:\\font\\a.ttf');
    expect(out).toContain("fontfile='C\\:/font/a.ttf'");
    expect(out).toContain("timecode='01\\:00\\:00\\:00'");
    expect(out.startsWith('[v]')).toBe(true);
    expect(out.endsWith('[o]')).toBe(true);
  });

  /* 使用者已明確表示之後會有 4K 專案。字級是畫面短邊的 3.2%，
     所以解析度變大時時間碼會等比變大，不會在 4K 上變成一顆小點。
     容差 ±1 是四捨五入：1080×0.032=34.56→35、2160×0.032=69.12→69。 */
  it('字級隨畫面尺寸等比縮放（4K ≈ FHD 的兩倍）', () => {
    const size = (w, h) =>
      +/fontsize=(\d+)/.exec(P._buildExportTimecodeFilter('[v]', tc, w, h, '[o]', 'f.ttf'))[1];
    expect(size(3840, 2160)).toBeCloseTo(size(1920, 1080) * 2, -0.5);
    expect(Math.abs(size(3840, 2160) - size(1920, 1080) * 2)).toBeLessThanOrEqual(1);
  });

  it('tc24hmax=0：跨過 24 小時不會回捲', () => {
    expect(P._buildExportTimecodeFilter('[v]', tc, 1920, 1080, '[o]', 'f.ttf'))
      .toContain('tc24hmax=0');
  });
});

/* 這裡的設計刻意分成兩種結果，不要把它們統一：
     沒有要求浮水印（null）→ 回 null，安靜略過；
     有要求但設定壞掉      → 大聲 throw。
   若壞掉的設定也回 null，使用者會拿到一支「勾了卻沒有時間碼」的成品而不知情——
   正是 §0.6「有產出不等於對」。 */
describe('時間碼浮水印的正規化', () => {
  it('接受 HH:MM:SS:FF 並帶出速率', () => {
    const w = P._normaliseExportTimecodeWatermark({ start: '01:00:00:00' }, 25);
    expect(w).toMatchObject({ start: '01:00:00:00' });
    expect(Number(w.rate)).toBeGreaterThan(0);
  });

  it('沒有要求浮水印時回 null（安靜略過）', () => {
    expect(P._normaliseExportTimecodeWatermark(null, 25)).toBeNull();
    expect(P._normaliseExportTimecodeWatermark(undefined, 25)).toBeNull();
  });

  it('有要求但設定無效時丟出例外，不會默默匯出沒有時間碼的成品', () => {
    expect(() => P._normaliseExportTimecodeWatermark({}, 25)).toThrow(/無效/);
    expect(() => P._normaliseExportTimecodeWatermark({ start: '亂寫' }, 25)).toThrow(/無效/);
    expect(() => P._normaliseExportTimecodeWatermark({ start: '1:2' }, 25)).toThrow(/無效/);
  });
});

describe('數值進 filtergraph 前一律定點化', () => {
  /* 直接把 JS 數字塞進 filtergraph 會出現 1e-7 這種科學記號，ffmpeg 解析不了。 */
  /* 實務值域：時間（秒）、音量倍率、0..1 的位置比例。
     toFixed 在 1e21 以上才會退回科學記號，那不是這裡會出現的數字。 */
  it('_filterNumber 在實務值域內永遠是定點小數', () => {
    for (const v of [0, 1, -3.5, 0.0000001, 86400, 1e-9, 99999.999]) {
      expect(P._filterNumber(v)).not.toMatch(/e/i);
    }
  });

  it('非數值退回 fallback，不會產出 NaN', () => {
    expect(P._filterNumber('abc', 1)).toBe('1.000000');
    expect(P._filterNumber(undefined, 0)).toBe('0.000000');
    expect(P._finiteNumber(NaN, 7)).toBe(7);
  });
});

describe('WAV 交付的聲道組裝', () => {
  const plan = {
    buses: [
      { id: 'a1', name: 'A1', inputs: [{ file: 'x.mxf', stream: 0, channel: 0 }] },
      { id: 'a2', name: 'A2', inputs: [{ file: 'x.mxf', stream: 0, channel: 1 }] },
    ],
    streams: [],
  };

  it('bus 數量決定輸出聲道數，順序即 bus 順序', () => {
    const fc = [];
    const norm = P._normalizeAudioPlan(plan, { requireStreams: false });
    const planned = P._buildPlannedAudio(norm, [], fc, 0, 5);
    const wav = P._buildWavOutput(planned.busLabels, norm, fc);
    expect(wav.channels).toBe(2);
    expect(typeof wav.label).toBe('string');
  });
});

/* ============================================================================
   交付規格 → ffmpeg argv（buildDeliveryArgv）

   這一段以前【一行測試都沒有】。它整段長在 _runJobLogic() 裡，和 fs.readFileSync、
   spawn、佇列廣播糾纏，vitest 起不了 Electron；於是鐵律 §0.1（三路一致）與
   §0.4（Windows 路徑跳脫兩層）最容易靜默壞掉的那一段，只能靠人工匯出後看成品。

   音訊那半早就住在本檔並有測試，影像那半沒有——把它搬過來就是為了下面這些。
============================================================================ */
describe('交付 argv：影像合成', () => {
  const clip = (over = {}) => ({
    path: 'C:/source/master.mxf', type: 'video', vtrack: 0,
    in: 10, out: 20, offset: 0, fadeIn: 0, fadeOut: 0, ...over,
  });
  const spec = (over = {}) => ({
    format: 'mp4', width: 1920, height: 1080, fps: 25, duration: 10,
    videoKbps: 8000, audioPlan: null, timecodeWatermark: null,
    assFileName: null, outPath: 'C:/out/deliverable.mp4',
    videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
    clips: [clip()], ...over,
  });
  const env = (over = {}) => ({ hasAudioStream: () => false, ...over });
  const fcOf = args => args[args.indexOf('-filter_complex') + 1];

  it('沒有片段時明確失敗，不會產生一組會跑出空檔的 argv', () => {
    expect(() => P.buildDeliveryArgv(spec({ clips: [] }), env())).toThrow('沒有可匯出的影片段');
  });

  /* 44GB MXF 的教訓：同一個實體檔案只開一次 input，並用 -ss 加在 -i 前，
     否則 ffmpeg 會從 0 開始慢速解碼，而且每個 input 各建一個 hwaccel 實例耗盡 VRAM。 */
  it('同一支母素材只開一次 input，且 -ss 在 -i 前面', () => {
    const { args } = P.buildDeliveryArgv(spec({
      clips: [clip({ in: 10, out: 20, offset: 0 }), clip({ in: 30, out: 40, offset: 10 })],
    }), env());
    expect(args.filter(a => a === 'C:/source/master.mxf')).toHaveLength(1);
    const i = args.indexOf('-ss');
    expect(args[i + 2]).toBe('-i');
    expect(+args[i + 1]).toBeCloseTo(9.5); // 最早用到的 in 再退 0.5 秒
  });

  it('outPath 一定是最後一個 argv', () => {
    const { args } = P.buildDeliveryArgv(spec(), env());
    expect(args[0]).toBe('-y');
    expect(args[args.length - 1]).toBe('C:/out/deliverable.mp4');
    expect(args).toContain('-movflags');
  });

  it('ProRes 交付走 prores_ks，且不帶 AAC bitrate', () => {
    const { args, plannedEncoder, kbps, audioBitrates } = P.buildDeliveryArgv(
      spec({ format: 'prores', outPath: 'C:/out/master.mov' }),
      env({ proresArgs: () => ['-c:v', 'prores_ks', '-c:a', 'pcm_s24le'] }));
    expect(plannedEncoder).toBe('prores_ks');
    expect(args).toContain('prores_ks');
    expect(args).not.toContain('-b:a:0');
    expect(kbps).toBeNull();
    expect(audioBitrates).toBeNull();
  });

  it('GPU 編碼器只影響標籤與參數，不改變 filtergraph', () => {
    const cpu = P.buildDeliveryArgv(spec(), env({ vencArgsBitrate: () => ['-c:v', 'libx264'] }));
    const gpu = P.buildDeliveryArgv(spec(), env({
      encoderName: 'h264_nvenc',
      vencArgsBitrate: () => ['-c:v', 'h264_nvenc'],
      hwdecArgs: () => ['-hwaccel', 'auto'],
    }));
    expect(cpu.isGpu).toBe(false);
    expect(gpu.isGpu).toBe(true);
    expect(gpu.label).toContain('GPU NVENC');
    expect(fcOf(gpu.args)).toBe(fcOf(cpu.args));
    expect(gpu.args).toContain('-hwaccel');
  });

  /* 交付時長要取「宣告值」與「音訊 plan 尾端」的較大者：音訊較長時 ffmpeg 會
     延長成品，佇列顯示與進度換算必須用同一個值，否則進度條會停在 100% 之前。 */
  it('音訊 plan 比宣告時長更長時，交付時長跟著延長', () => {
    const audioPlan = P._normalizeAudioPlan({
      buses: [{ id: 'a1', inputs: [{ file: 'C:/source/master.mxf', sourceStream: 0, sourceChannel: 0, offset: 0, trimStart: 0, trimEnd: 30, volume: 1 }] }],
      streams: [{ id: 's', layout: 'mono', busIds: ['a1'] }],
    });
    const { duration, args } = P.buildDeliveryArgv(spec({ duration: 10, audioPlan }), env());
    expect(duration).toBe(30);
    expect(fcOf(args)).toContain('d=30.000'); // 黑底也拉到同一個長度
  });
});

describe('交付 argv：燒錄字幕與時間碼（鐵律 §0.4 路徑跳脫）', () => {
  const base = {
    format: 'mp4', width: 1920, height: 1080, fps: 25, duration: 5,
    videoKbps: 8000, audioPlan: null, timecodeWatermark: null,
    outPath: 'C:/out/deliverable.mp4',
    videoTracks: [{ vt: 0 }],
    clips: [{ path: 'C:/source/a.mov', type: 'video', vtrack: 0, in: 0, out: 5, offset: 0 }],
  };
  const fcOf = args => args[args.indexOf('-filter_complex') + 1];

  /* v4.31.2 的真實事故：filtergraph 先拆選項、選項值再拆一次，所以磁碟機冒號
     字面上必須是 `C\\:/...`。只寫一個反斜線 → ffmpeg 把 `:` 當選項分隔符、
     整條 filterchain 解析失敗 → 匯出直接掛掉。 */
  it('fontsdir 的磁碟機冒號跳【兩層】，反斜線一律轉成正斜線', () => {
    const { args } = P.buildDeliveryArgv({ ...base, assFileName: 'job-1.ass' },
      { hasAudioStream: () => false, fontsDir: 'C:\\Users\\Evan\\SUB_Tool\\font' });
    const fc = fcOf(args);
    expect(fc).toContain('ass=job-1.ass:fontsdir=C\\\\:/Users/Evan/SUB_Tool/font');
    expect(fc).not.toContain('\\Users'); // 反斜線沒轉乾淨
  });

  it('沒有 font/ 目錄時不加 fontsdir，字幕仍然燒錄', () => {
    const { args } = P.buildDeliveryArgv({ ...base, assFileName: 'job-1.ass' },
      { hasAudioStream: () => false, fontsDir: null });
    expect(fcOf(args)).toContain('ass=job-1.ass[vout]');
  });

  /* ASS 只帶檔名（cwd=TMP）而不是完整路徑——這是繞開路徑跳脫的整個理由，
     一旦有人「順手改成絕對路徑」，Windows 上就會再踩一次 §0.4。 */
  it('ass 濾鏡只引用檔名，不放絕對路徑', () => {
    const { args } = P.buildDeliveryArgv({ ...base, assFileName: 'job-1.ass' },
      { hasAudioStream: () => false });
    expect(fcOf(args)).not.toMatch(/ass=[A-Za-z]:/);
  });

  /* 時間碼是交付用 burn-in，必須接在 ASS 後面，才會永遠在字幕與所有影像之上。 */
  it('時間碼濾鏡接在字幕之後，且最終 map 指向時間碼的輸出', () => {
    const { args } = P.buildDeliveryArgv({
      ...base, assFileName: 'job-1.ass',
      timecodeWatermark: P._normaliseExportTimecodeWatermark({ start: '10:00:00:00' }, 25),
    }, { hasAudioStream: () => false, timecodeFontFile: 'C:/font/sarasa-mono.ttf' });
    const fc = fcOf(args);
    expect(fc.indexOf('ass=job-1.ass')).toBeLessThan(fc.indexOf('drawtext='));
    expect(fc).toContain('[vout]drawtext=');
    expect(args[args.indexOf('-map') + 1]).toBe('[vtimecode]');
  });

  it('沒有字幕也沒有時間碼時，直接 map 疊層結果', () => {
    const { args } = P.buildDeliveryArgv({ ...base, assFileName: null }, { hasAudioStream: () => false });
    expect(args[args.indexOf('-map') + 1]).toBe('[ov0]');
  });
});

describe('交付 argv：WAV', () => {
  const wavPlan = {
    buses: [
      { id: 'a1', inputs: [{ file: 'C:/source/master.mxf', sourceStream: 0, sourceChannel: 0, offset: 0, trimStart: 0, trimEnd: 8, volume: 1 }] },
      { id: 'a2', inputs: [{ file: 'C:/source/master.mxf', sourceStream: 0, sourceChannel: 1, offset: 0, trimStart: 0, trimEnd: 8, volume: 1 }] },
    ],
    streams: [],
  };

  it('走 24-bit PCM 48k，聲道數＝專案音軌數，且不帶任何視訊參數', () => {
    const { args, plannedEncoder, isGpu, audioChannels, label } = P.buildDeliveryArgv({
      format: 'wav', duration: 8, outPath: 'C:/out/mix.wav',
      audioPlan: P._normalizeAudioPlan(wavPlan, { requireStreams: false }),
    }, {});
    expect(plannedEncoder).toBe('pcm_s24le');
    expect(isGpu).toBe(false);
    expect(audioChannels).toBe(2);
    expect(label).toContain('2 軌');
    expect(args).toContain('-ar');
    expect(args).not.toContain('-c:v');
    expect(args[args.length - 1]).toBe('C:/out/mix.wav');
  });

  it('沒有專案音軌路由時明確擋下，不會輸出一個無聲的 WAV', () => {
    expect(() => P.buildDeliveryArgv({ format: 'wav', duration: 8, outPath: 'C:/out/mix.wav', audioPlan: null }, {}))
      .toThrow(/專案音軌路由/);
  });

  it('啟用音訊平衡化 (loudness) 時，注入 loudnorm 濾鏡', () => {
    const planWithLoudness = {
      ...wavPlan,
      loudness: {
        enabled: true,
        maximumAmplitude: -6.0,
        targetLoudness: -12.0,
        isTruePeak: true,
      },
    };
    const { args } = P.buildDeliveryArgv({
      format: 'wav',
      duration: 8,
      outPath: 'C:/out/mix_norm.wav',
      audioPlan: P._normalizeAudioPlan(planWithLoudness, { requireStreams: false }),
    }, {});
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('loudnorm=I=-12.0:TP=-6.0');
    expect(args[args.indexOf('-map') + 1]).toBe('[wavNorm]');
  });
});

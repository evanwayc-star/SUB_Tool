'use strict';

// Free Windows/macOS end-to-end check: node scripts/acceptance/verify-screen-text-native.js --offline
// Paid smoke: node scripts/acceptance/verify-screen-text-native.js <video> <start> <seconds>
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScreenTextRuntime } = require('../../electron/screen-text-runtime');
const { SCREEN_TEXT_DEFAULT_MODELS } = require('../../shared/screen-text-options.cjs');

const root = path.resolve(__dirname, '..', '..');
const toolDir = path.join(root, 'electron', 'ffmpeg', ...(process.platform === 'darwin' ? ['darwin-arm64'] : []));
const suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = path.join(toolDir, 'ffmpeg' + suffix);

function runFFmpeg(output, args, input) {
  const child = spawnSync(ffmpegPath, ['-hide_banner', '-v', 'error', ...args], {
    cwd: output, input, windowsHide: true, timeout: 30000,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr.toString());
  return child.stdout;
}

async function verifyOffline(output, runtime, owner) {
  const source = path.join(output, 'two-video-tracks.mkv');
  fs.writeFileSync(path.join(output, 'word.ass'), [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 160', 'PlayResY: 90',
    '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Default,Arial,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    'Dialogue: 0,0:00:00.16,0:00:00.46,Default,,0,0,0,,OK', '',
  ].join('\n'));
  runFFmpeg(output, ['-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=1',
    '-filter_complex', '[0:v]ass=word.ass[main]', '-map', '[main]', '-map', '1:v', '-disposition:v:0', '0',
    '-disposition:v:1', 'default', '-c:v', 'ffv1', source]);
  const request = { path: source, requestId: 'native-offline', start: 0, end: 1, samplesPerSecond: 10,
    provider: 'gemini', model: 'offline-custom-model', sourceLang: 'en', frameWidth: 1920,
    smartAccuracy: false, contentMode: 'faithful', maxNewRequests: 0 };
  const cold = await runtime.recognize(owner, request, true);
  assert.equal(cold.metrics.pendingWindows, 1);
  assert.equal(cold.metrics.imageAppearances, 11);
  const jpeg = Buffer.from(cold.previewJpeg, 'base64');
  fs.writeFileSync(path.join(output, 'preview.jpg'), jpeg);
  const pixel = runFFmpeg(output, ['-i', 'pipe:0', '-vf', 'crop=2:2:80:73', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], jpeg);
  assert.ok(pixel[0] > 240 && pixel[1] < 15 && pixel[2] < 15, 'OCR 預覽應讀取紅色主軌');
  const sourceFrame = runFFmpeg(output, ['-ss', '0.32', '-i', source, '-map', '0:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  let white = 0;
  for (let i = 0; i < sourceFrame.length; i += 3) if (sourceFrame[i+1] > 200 && sourceFrame[i+2] > 200) white++;
  assert.ok(white > 50, '來源確認含有白色 OK 字卡');
  const blocked = await runtime.recognize(owner, request);
  assert.equal(blocked.cancelled, true);
  assert.match(blocked.error, /新增 API 請求上限/);
  assert.deepEqual(blocked.cues, []);
  assert.equal(blocked.metrics.newRequests, 0);
  const configs = fs.readdirSync(output, { recursive: true }).filter(name => path.basename(name) === 'config.json');
  assert.equal(configs.length, 1);
  // A hand-labeled provider response for this fixture tests cache replay with zero paid requests.
  const record = { window_index: 0, global_start: 0, global_end: 10, actual_times: [0, .12, .2, .32, .4, .52, .6, .72, .8, .92, .96],
    detected_language: 'en', events: [{ start_frame: 2, end_frame: 4, slot: 'bottom', kind: 'dialogue', text: 'OK' }],
    usage: { input_tokens: 1234, output_tokens: 54, cached_input_tokens: 42 }, elapsed_seconds: 1, provider: request.provider, model: request.model };
  fs.writeFileSync(path.join(output, path.dirname(configs[0]), 'win_00000.json'), JSON.stringify(record));
  const warm = await runtime.recognize(owner, request, true);
  assert.equal(warm.metrics.cachedWindows, 1);
  assert.equal(warm.metrics.pendingImageAppearances, 0);
  const result = await runtime.recognize(owner, request);
  assert.deepEqual(result.cues, [{ start: .16, end: .46, text: 'OK', kind: 'dialogue', slot: 'bottom' }]);
  assert.equal(result.metrics.newRequests, 0);
  assert.equal(result.metrics.inputTokens, 0);
  assert.equal(result.metrics.outputTokens, 0);
  assert.equal(result.metrics.estimatedCostUsd, 0);
  const summaries = fs.readdirSync(output, { recursive: true }).filter(name => path.basename(name) === 'run_summary.json');
  assert.equal(summaries.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(output, summaries[0]), 'utf8'));
  assert.equal(summary.vision_model, request.model);
  assert.equal(summary.vision_stats.estimated_cost_usd, 0);
  assert.deepEqual(summary.total_estimated_cost, { usd: 0, twd: 0 });
  return { output, mode: 'offline', previewRgb: [...pixel.subarray(0,3)], captionWhitePixels: white,
    cold: cold.metrics, warm: warm.metrics, result };
}

async function main() {
  const [source, startValue = '0', secondsValue = '8'] = process.argv.slice(2);
  const offline = source === '--offline';
  const start = Number(startValue), seconds = Number(secondsValue);
  if (!offline && (!source || !Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30)) {
    throw new Error('使用 --offline 進行免金鑰驗收，或提供授權影片、起點和最多 30 秒的長度進行付費測試');
  }
  const provider = process.env.SUBTOOL_VISION_PROVIDER || 'openai';
  if (!offline && !Object.hasOwn(SCREEN_TEXT_DEFAULT_MODELS, provider)) throw new Error('測試供應商須為 openai 或 gemini');
  let key = offline ? '' : (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (!offline && process.env.SUBTOOL_VISION_TEST_KEY_STDIN === '1') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    key = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!offline && !key) throw new Error('缺少測試 API 金鑰');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-card-vision-smoke-'));
  const runtime = createScreenTextRuntime({
    executable: path.join(root, 'electron/card-vision/bin', `${process.platform}-${process.arch}`, 'subtool-card-vision' + suffix),
    settings: { apiKey: () => key }, cacheDir: output, ffmpegPath, ffprobePath: path.join(toolDir, 'ffprobe' + suffix),
    onProgress: (_, update) => { if (!offline) console.log(JSON.stringify(update)); },
  });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const timer = setTimeout(() => runtime.cancel(owner, offline ? 'native-offline' : 'native-smoke'), 240000);
  try {
    let report;
    if (offline) {
      report = await verifyOffline(output, runtime, owner);
    } else {
      const request = { requestId: 'native-smoke', path: path.resolve(source), start, end: start + seconds, provider,
        model: SCREEN_TEXT_DEFAULT_MODELS[provider], sourceLang: 'auto', samplesPerSecond: 10, frameWidth: 1920,
        smartAccuracy: true, contentMode: 'variety' };
      const planned = await runtime.recognize(owner, request, true);
      fs.writeFileSync(path.join(output, 'preview.jpg'), Buffer.from(planned.previewJpeg, 'base64'));
      const result = await runtime.recognize(owner, request);
      report = { output, mode: 'cloud', source, start, end: request.end, model: request.model, plan: planned.metrics, result };
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.result.cancelled) throw new Error('辨識只完成部分內容，請查看保留的結果');
  } finally {
    clearTimeout(timer);
    await runtime.cancelAllAndWait();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

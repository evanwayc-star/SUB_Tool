'use strict';

// Real cloud smoke: node scripts/acceptance/verify-screen-text-native.js <video> <start> <seconds>
// Requires OPENAI_API_KEY (or SUBTOOL_VISION_TEST_KEY_STDIN=1 for a private stdin key).
// Reads only a short authorized range; outputs and cache remain in the reported TEMP folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createScreenTextRuntime } = require('../../electron/screen-text-runtime');

async function main() {
  const [source, startValue = '0', secondsValue = '8'] = process.argv.slice(2);
  const start = Number(startValue), seconds = Number(secondsValue);
  if (!source || !Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new Error('請提供影片、起點及最多 30 秒的測試長度');
  }
  let key = process.env.OPENAI_API_KEY || '';
  if (process.env.SUBTOOL_VISION_TEST_KEY_STDIN === '1') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    key = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!key) throw new Error('缺少測試 API 金鑰');
  const root = path.resolve(__dirname, '..', '..');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-card-vision-smoke-'));
  const toolDir = path.join(root, 'electron', 'ffmpeg', ...(process.platform === 'darwin' ? ['darwin-arm64'] : []));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const runtime = createScreenTextRuntime({
    executable: path.join(root, 'electron/card-vision/bin', `${process.platform}-${process.arch}`, `subtool-card-vision${suffix}`),
    settings: { apiKey: () => key }, cacheDir: output,
    ffmpegPath: path.join(toolDir, `ffmpeg${suffix}`), ffprobePath: path.join(toolDir, `ffprobe${suffix}`),
    onProgress: (_, update) => console.log(JSON.stringify({ progress: update.progress, message: update.message })),
  });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const timer = setTimeout(() => runtime.cancel(owner, 'native-smoke'), 240000);
  try {
    console.log(JSON.stringify({ output, source, start, end: start + seconds }));
    const result = await runtime.recognize(owner, { requestId: 'native-smoke', path: path.resolve(source), start,
      end: start + seconds, provider: 'openai', model: 'gpt-5.4', sourceLang: 'auto',
      samplesPerSecond: 10, frameWidth: 1920, smartAccuracy: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ output, result }));
  } finally {
    clearTimeout(timer);
    await runtime.cancelAllAndWait();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

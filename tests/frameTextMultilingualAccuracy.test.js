import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createFrameTextRuntime } = require('../electron/frame-text-runtime.js');
const models = ['detector.onnx', 'recognizer.onnx', 'characters.json', 'korean.onnx', 'korean-characters.json',
  'english.onnx', 'english-characters.json'];
const prepared = models.every(file => existsSync(path.resolve('electron/frame-ocr/paddle', file)));

it.skipIf(!prepared)('單格辨識保留日文句號、韓文兩行的間隔和英文數字符號', async () => {
  const runtime = createFrameTextRuntime();
  const sender = Object.assign(new EventEmitter(), {isDestroyed:() => false});
  const samples = [
    ['japanese', 'jpn', '次の駅は渋谷です。'],
    ['korean', 'kor', '환승 통로는 오른쪽입니다.\n곧 열차가 도착합니다.'],
    ['symbols', 'eng', '±2.5% / (25°C)'],
  ];
  try {
    for (const [name, language, expected] of samples) {
      const pngBase64 = readFileSync(new URL(`./fixtures/frame-text-${name}.png`, import.meta.url)).toString('base64');
      const {text} = await runtime.recognize(sender, {requestId:name, languages:[language], pngBase64});
      expect(text).toBe(expected);
    }
  } finally {
    await runtime.close();
  }
}, 60000);

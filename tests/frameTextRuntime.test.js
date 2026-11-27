import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFrameTextRuntime } = require('../electron/frame-text-runtime');
const english = fs.readFileSync(new URL('./fixtures/frame-text-english.png', import.meta.url)).toString('base64');
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });
const request = (pngBase64 = english) => ({ requestId: 'frame-test', pngBase64 });
let runtime, temporary;
afterEach(async () => {
  await runtime?.close();
  runtime = null;
  if (temporary) {
    for (const name of ['tesseract.js-core', '@tesseract.js-data']) fs.unlinkSync(path.join(temporary, name));
    fs.rmdirSync(path.join(temporary, 'scripts'));
    fs.rmdirSync(temporary);
    temporary = null;
  }
});

it('拒絕無效、超出解碼上限的 PNG 與無效工作編號', async () => {
  runtime = createFrameTextRuntime();
  const tooLarge = Buffer.from(english, 'base64');
  tooLarge.writeUInt32BE(65000, 16);
  await expect(runtime.recognize(owner(), request('file:///a.png'))).rejects.toThrow(/PNG/);
  await expect(runtime.recognize(owner(), request(tooLarge.toString('base64')))).rejects.toThrow(/尺寸|過大/);
  await expect(runtime.recognize(owner(), { pngBase64: english })).rejects.toThrow(/編號/);
  await expect(runtime.recognize(owner(), { ...request(), languages:['eng','unavailable'] })).rejects.toThrow(/語言/);
  await expect(runtime.recognize(owner(), { ...request(), languages:'eng' })).rejects.toThrow(/語言/);
});

it('離線讀回英文字，取消只會停止同一視窗的對應工作，再次執行能完成', async () => {
  // Clean npm ci contains the common models. No optional script download is needed here.
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-frame-ocr-test-'));
  fs.mkdirSync(path.join(temporary, 'scripts'));
  for (const name of ['tesseract.js-core', '@tesseract.js-data']) {
    fs.symlinkSync(path.resolve('node_modules', name), path.join(temporary, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  runtime = createFrameTextRuntime({ resourcesDir: temporary });
  const sender = owner();
  const cancelled = expect(runtime.recognize(sender, request())).rejects.toThrow(/取消/);
  await new Promise(resolve => setImmediate(resolve));
  expect(await runtime.cancel(owner(), 'frame-test')).toBe(false);
  expect(await runtime.cancel(sender, 'unrelated')).toBe(false);
  expect(await runtime.cancel(sender, 'frame-test')).toBe(true);
  await cancelled;
  for (const languages of [[], ['eng'], []]) {
    expect(await runtime.recognize(sender, { ...request(), languages })).toEqual({ text: 'Subtitle test 2026' });
  }
}, 30000);

it.skipIf(!fs.existsSync(path.resolve('electron/frame-ocr/scripts/Armenian.traineddata.gz')))
('整格辨識在同一畫面逐行保留亞美尼亞文、泰文、繁中與英文', async () => {
  runtime = createFrameTextRuntime();
  const png = fs.readFileSync(new URL('./fixtures/frame-text-scripts.png', import.meta.url)).toString('base64');
  expect(await runtime.recognize(owner(), request(png))).toEqual({ text: 'Բարի լույս\nภาษาไทย\n剪輯工具\nSTATION 2026' });
}, 60000);

it('同一個 worker 切換單語與複選，只用勾選的模型讀取中英兩行', async () => {
  runtime = createFrameTextRuntime();
  const sender = owner();
  const bilingual = fs.readFileSync(new URL('./fixtures/frame-text-bilingual.png', import.meta.url)).toString('base64');
  for (const languages of [['eng'], ['chi_tra','eng'], ['eng'], ['chi_tra','eng']]) {
    const {text} = await runtime.recognize(sender, { ...request(bilingual), languages });
    const rows = text.split(/\n+/);
    expect(rows.at(-1)).toBe('STATION 12');
    if (languages.includes('chi_tra')) expect(rows[0]).toBe('車站入口');
    else expect(text).not.toMatch(/\p{Script=Han}/u);
  }
});

it.skipIf(!fs.existsSync(path.resolve('electron/frame-ocr/paddle/korean.onnx')))
('自動辨識短韓文，複選同一行韓中英時保留三種文字', async () => {
  runtime = createFrameTextRuntime();
  const sender = owner();
  for (const [file, languages, text] of [
    ['frame-text-korean-short.png', [], '물빛 산길'],
    ['frame-text-mixed-korean-han.png', ['eng','kor','chi_tra'], '한국 東京 Central'],
    ['frame-text-mixed-korean-han.png', [], '한국 東京 Central'],
  ]) {
    const png = fs.readFileSync(new URL('./fixtures/' + file, import.meta.url)).toString('base64');
    expect(await runtime.recognize(sender, {...request(png), languages})).toEqual({text});
  }
}, 30000);

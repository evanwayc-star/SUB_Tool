import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const {createPaddleReader} = require('../electron/frame-text-paddle.js');
const paddle = path.resolve('electron/frame-ocr/paddle');
const reader = createPaddleReader(paddle);
const have = name => existsSync(path.join(paddle,name));
const runCjk = it.skipIf(!have('detector.onnx') || !have('characters.json') || !have('recognizer.onnx'));
const english = readFileSync(new URL('./fixtures/frame-text-english.png', import.meta.url));
const bilingual = readFileSync(new URL('./fixtures/frame-text-bilingual.png', import.meta.url));

it('缺少來源或超過畫素上限時在模型載入前拒絕，模式只接受既有字典', async () => {
  const unused = createPaddleReader('missing-local-models');
  await expect(unused.read(Buffer.alloc(8))).rejects.toThrow(/圖片/);
  const forged = Buffer.from(bilingual); forged.writeUInt32BE(2000000,16);
  await expect(unused.read(forged)).rejects.toThrow(/尺寸/);
  await expect(unused.read(english,'unknown')).rejects.toThrow(/模式/);
});

runCjk('雜色背景的單行繁中，直接讀回四字與原始範圍', async () => {
  const strip = new PNG({width:278,height:76}), page = PNG.sync.read(bilingual);
  PNG.bitblt(page, strip, 80,21,278,76,0,0);
  // White subtitle over a coloured background; the original caption provides
  // the glyph shapes, not a mock recognizer or a machine-specific system font.
  for (let y=0; y<strip.height; y++) {
    for (let x=0; x<strip.width; x++) {
      const i=4*(y*strip.width+x), ink=1-strip.data[i]/255;
      for (let c=0; c<3; c++) {
        const bg=48+30*Math.sin(x/28+c)+18*Math.cos(y/10+c);
        strip.data[i+c]=Math.round(bg+(250-bg)*ink);
      }
    }
  }
  const [line] = await reader.read(PNG.sync.write(strip));
  expect(line.text).toBe('車站入口'); expect(line.confidence).toBeGreaterThan(0.96);
  expect(line.rect).toEqual({x:0,y:0,w:278,h:76});
});

runCjk('一般畫面偵測兩行，按來源位置逐行保留中英文', async () => {
  const lines = await reader.read(bilingual);
  expect(lines.map(r => r.text)).toEqual(['車站入口','STATION 12']);
  expect(lines.every(r => r.confidence > 0.95 && r.confidence <= 1)).toBe(true);
  expect(lines[0].rect.y + lines[0].rect.h).toBeLessThan(lines[1].rect.y);
  expect(lines[0].rect.x).toBeGreaterThan(30);
  expect(lines[1].rect.w).toBeGreaterThan(lines[0].rect.w);
});

runCjk('寬扁裁圖裡有上下兩行時仍然完整辨識', async () => {
  const page = PNG.sync.read(bilingual), banner = new PNG({width:640,height:115});
  banner.data.fill(255);
  for (let y=0; y<115; y++) {
    for (let x=0; x<220; x++) {
      const from=4*(2*y*page.width+2*x), to=4*(y*banner.width+180+x);
      page.data.copy(banner.data,to,from,from+4);
    }
  }
  const lines=await reader.read(PNG.sync.write(banner));
  expect(lines.map(r=>r.text)).toEqual(['車站入口','STATION 12']);
  expect(lines[0].rect.y + lines[0].rect.h).toBeLessThan(lines[1].rect.y);
});

runCjk('透明空白圖不產生文字或座標', async () => {
  const blank=new PNG({width:240,height:45});
  for(let i=0;i<blank.data.length;i+=4) blank.data[i]=(i*7)%251;
  expect(await reader.read(PNG.sync.write(blank))).toEqual([]);
});

it.skipIf(!have('detector.onnx') || !have('english.onnx') || !have('korean.onnx'))(
  '在同一個 reader 來回切換英、韓模型，字典及座標獨立', async () => {
    for (const language of ['english','korean','english']) {
      const lines=await reader.read(english,language);
      expect(lines.map(r=>r.text)).toEqual(['Subtitle test 2026']);
      expect(lines[0].confidence).toBeGreaterThan(0.95);
      expect(lines[0].rect.w).toBeLessThan(500);
    }
  });

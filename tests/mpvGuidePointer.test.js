/* mpv guide 的輸入責任契約。

   guide 是 OS 層原生視窗，無法只讓其中一塊 DOM 點穿透；若讓它接管指標，就會和
   主 renderer 的 #imageLayer 競爭同一個 drag gesture。它因此只能顯示原生畫面上方
   的框／控制點，所有操作都走主 renderer 的既有 DOM pointer state machine。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('guide 只畫、不接 pointer', () => {
  it('重用圖片節點時同步裁切、清除舊樣式並依快照更新疊層順序', () => {
    const html = read('electron/main.js').match(/const MPV_GUIDE_HTML = `([\s\S]*?)`;\s*\/\* Windows/)[1];
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const image = (id, style = '') => `<div class="img-wrap" data-id="${id}"><img src="data:image/png;base64,AA==" style="${style}"></div>`;
    const bounds = { x: 0, y: 0, w: 640, h: 360 };
    try {
      dom.window.setImages(image('lower') + image('upper'), bounds);
      const lower = dom.window.document.querySelector('[data-id="lower"]');
      dom.window.setImages(image('upper') + image('middle') + image('lower', 'clip-path:inset(0px 320px 180px 0px)'), bounds);
      expect(dom.window.document.querySelector('[data-id="lower"]')).toBe(lower);
      expect(lower.querySelector('img').style.clipPath).toBe('inset(0px 320px 180px 0px)');
      expect([...dom.window.document.querySelectorAll('#imgContainer .img-wrap')].map(node => node.dataset.id)).toEqual(['upper', 'middle', 'lower']);
      dom.window.setImages(image('lower'), bounds);
      expect(lower.querySelector('img').style.clipPath).toBe('');
      expect([...dom.window.document.querySelectorAll('#imgContainer .img-wrap')]).toEqual([lower]);
    } finally { dom.window.close(); }
  });

  it('mpv host 永久啟用原生視窗穿透，不再有條件切換輸入抓取', () => {
    const host = stripComments(read('electron/mpv-host.js'));

    expect(host).toMatch(/guideWin\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
    expect(host).not.toMatch(/mpv-guide:imagePointer/);
    expect(host).not.toMatch(/handleGuidePointer|isGuideSender|setGuideInteractive/);
  });

  it('主程序與 preload 不再暴露第二條 guide pointer IPC 路徑', () => {
    const main = stripComments(read('electron/main.js'));
    const preload = stripComments(read('electron/preload.js'));
    const renderer = stripComments(read('src/video-renderer.js'));

    expect(main).not.toMatch(/mpv-guide:imagePointer|mpv:imagePointer/);
    expect(preload).not.toMatch(/onImagePointer|mpv:imagePointer/);
    expect(renderer).not.toMatch(/onImagePointer/);
  });

  it('文件明確指定永久穿透與主 renderer DOM 的單一互動責任', () => {
    const doc = read('docs/技術架構說明.md');

    expect(doc).toMatch(/永久穿透/);
    expect(doc).toMatch(/#imageLayer/);
    expect(doc).toMatch(/單一.*互動|互動.*單一/s);
  });
});

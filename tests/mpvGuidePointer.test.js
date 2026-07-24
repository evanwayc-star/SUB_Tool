/* mpv guide 視窗的指標轉送契約。完整背景見 docs/技術架構說明.md §0.9。

   這裡守的是一條【違反後會靜默壞掉】的不變量：guide 視窗必須永久穿透，
   絕對不可以在 hover 時去搶指標抓取權。一旦搶了，底層的視訊軌拖曳與右鍵選單
   就會失效——畫面完全正常，只是按不動，而且不會有任何錯誤訊息。

   為什麼是原始碼契約而不是行為測試：這兩支檔案跑在 Electron 主程序與 preload，
   都依賴 electron 模組，vitest 裡起不了。行為面由真機 CDP 驗證涵蓋（見 開發與驗證.md §3）。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const preload = () => stripComments(read('electron/mpv-guide-preload.js'));
const main = () => stripComments(read('electron/main.js'));

describe('guide 指標轉送只收帶座標的拖曳事件', () => {
  /* enter/leave 曾經同時存在於三處（送出端、preload 白名單、主程序分支），
     卻從來沒有執行過：送出端沒帶座標，訊息在 preload 的 x/y 檢查就被丟掉。
     文件卻把它描述成「拖曳能精確運作的原因」。死碼 + 錯誤的文件放了好幾個版本。 */
  it('preload 白名單不含 enter／leave', () => {
    const line = preload().match(/const POINTER_TYPES\s*=\s*new Set\(\[([^\]]*)\]/);
    expect(line, '找不到 POINTER_TYPES 宣告').not.toBeNull();

    const types = line[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(types).toEqual(['start', 'move', 'end', 'cancel']);
  });

  it('主程序的 IPC 白名單不含 enter／leave', () => {
    expect(main()).not.toMatch(/\[\s*'start',\s*'move',\s*'end',\s*'cancel',\s*'enter'/);
    expect(main()).toMatch(/\[\s*'start',\s*'move',\s*'end',\s*'cancel'\s*\]/);
  });

  /* 這道守衛正是讓 enter/leave 變成死碼的那一行。它同時也是真正的輸入驗證：
     沒有座標的指標事件本來就不該往下走。移掉它會讓上面兩條白名單失去意義。 */
  it('preload 仍擋掉沒有座標的訊息', () => {
    expect(preload()).toMatch(/if\s*\(\s*x\s*==\s*null\s*\|\|\s*y\s*==\s*null\s*\)\s*return/);
  });

  it('guide 的 DOM 不再送出 enter／leave', () => {
    expect(main()).not.toMatch(/send\(\s*['"]enter['"]/);
    expect(main()).not.toMatch(/send\(\s*['"]leave['"]/);
  });
});

describe('文件與程式碼一致', () => {
  /* §0.9 現在寫明「這三處死碼已移除、不要接回去」。若有人把程式碼改回來卻沒動文件，
     或反過來把這段警告刪掉，這裡就會紅——本專案吃過太多次「文件描述的機制不存在」的虧。 */
  it('§0.9 有記載 guide 永久穿透與 enter／leave 的教訓', () => {
    const doc = read('docs/技術架構說明.md');
    expect(doc).toMatch(/永久穿透/);
    expect(doc).toMatch(/從來沒有執行過/);
  });
});

/* 匯出路徑安全：常用樣式匯出時的檔名有一段來自【使用者匯入的 .json 內容】（preset.group），
   一路傳到主程序做 path.join(選定資料夾, name)。path.join 會把 "../" 正規化掉，
   所以未淨化的 group 可以讓檔案落在使用者選定資料夾之外——不需要任何 XSS，
   只要「匯入別人給的樣式包 → 之後按一次匯出樣式」就會發生，而 UI 仍顯示匯出成功。

   【v5.9.1：這支測試本身修過一次】
   在此之前它做兩件事，兩件都沒有測到真正在跑的程式：
     1. 在測試檔裡**自己宣告一份 sanitize()**，然後測那份副本；
     2. 用正規表示式掃 src/app.js 與 electron/main.js 的**原始碼字面**。
   把字元類別改寬鬆、但保持同一個敘述形狀，兩者都照樣通過——等於沒有守衛。
   （docs/開發與驗證.md §3 第三例記的就是這個反模式，只是那次發生在事件連線上。）

   現在兩道防線各自成為可 import 的模組，測試直接執行它們：
     src/export-name-safety.js        renderer 端淨化
     electron/export-name-safety.js   主程序端圍堵 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sanitizeFolderSegment, sanitizeFileNameSegment, presetExportRelativePath } from '../src/export-job-engine.js';

const require = createRequire(import.meta.url);
const { isPathContained } = require('../electron/export-name-safety.js');

const ATTACKS = [
  '../../../../Windows/System32',
  '..\\..\\..\\..\\Windows',
  '..',
  '....',
  './../..',
  'C:/Windows',
  'a/../../../b',
  '.',
  '../',
  '..\\',
];

describe('renderer 端淨化（src/export-name-safety.js）', () => {
  it('所有越界字串淨化後都不再含有路徑分隔符或單純的點', () => {
    for (const g of ATTACKS) {
      const s = sanitizeFolderSegment(g);
      expect(s, `group=${JSON.stringify(g)}`).not.toMatch(/[/\\]/);
      expect(s, `group=${JSON.stringify(g)}`).not.toMatch(/^\.+$/);
    }
  });

  it('冒號也會被拿掉（否則 C:/Windows 在 Windows 上是絕對路徑）', () => {
    expect(sanitizeFolderSegment('C:/Windows')).not.toMatch(/:/);
  });

  it('正常的資料夾與名稱不受影響', () => {
    expect(sanitizeFolderSegment('我的樣式')).toBe('我的樣式');
    expect(sanitizeFolderSegment('News Package')).toBe('News Package');
    expect(sanitizeFileNameSegment('主標 A-1')).toBe('主標 A-1');
  });

  it('空值安全', () => {
    expect(sanitizeFolderSegment(null)).toBe('');
    expect(sanitizeFolderSegment(undefined)).toBe('');
    expect(sanitizeFileNameSegment(null)).toBe('');
  });
});

describe('preset → 匯出相對路徑', () => {
  it('沒有分組時不產生資料夾層', () => {
    expect(presetExportRelativePath({ name: '主標' })).toBe('主標.json');
  });

  it('有分組時產生一層資料夾', () => {
    expect(presetExportRelativePath({ group: '新聞', name: '主標' })).toBe('新聞/主標.json');
  });

  /* 這一條是整組的重點：任何惡意 group／name 組出來的相對路徑，
     都必須仍然落在目標資料夾內——直接拿主程序那一側的圍堵函式來驗。 */
  it('任何越界的 group 或 name，組出來的路徑都留在目標資料夾內', () => {
    const root = path.resolve('/tmp/export-target');
    for (const bad of ATTACKS) {
      expect(isPathContained(root, presetExportRelativePath({ group: bad, name: '主標' })),
        `group=${JSON.stringify(bad)}`).toBe(true);
      expect(isPathContained(root, presetExportRelativePath({ group: '新聞', name: bad })),
        `name=${JSON.stringify(bad)}`).toBe(true);
      expect(isPathContained(root, presetExportRelativePath({ group: bad, name: bad })),
        `both=${JSON.stringify(bad)}`).toBe(true);
    }
  });
});

describe('主程序端圍堵（electron/export-name-safety.js）', () => {
  const root = path.resolve('/tmp/export-target');

  it('未淨化的越界檔名會被判定為越界（第二道防線確實有效）', () => {
    expect(isPathContained(root, '../../../../Windows/evil.json')).toBe(false);
    expect(isPathContained(root, 'a/../../../b.json')).toBe(false);
    expect(isPathContained(root, '..')).toBe(false);
    if (process.platform === 'win32') {
      expect(isPathContained(root, '..\\..\\evil.json')).toBe(false);
    }
  });

  it('正常路徑放行', () => {
    expect(isPathContained(root, 'ok.json')).toBe(true);
    expect(isPathContained(root, 'sub/ok.json')).toBe(true);
    expect(isPathContained(root, '我的樣式/主標.json')).toBe(true);
  });

  /* 前綴相同但不是子目錄的旁支必須擋掉：
     /tmp/export-target-evil 以 /tmp/export-target 為前綴，但不在它底下。 */
  it('相同前綴的旁支資料夾不算在內', () => {
    expect(isPathContained(root, '../export-target-evil/x.json')).toBe(false);
  });
});

/* 匯出路徑安全：常用樣式匯出時的檔名有一段來自【使用者匯入的 .json 內容】（preset.group），
   一路傳到主程序做 path.join(選定資料夾, name)。path.join 會把 "../" 正規化掉，
   所以未淨化的 group 可以讓檔案落在使用者選定資料夾之外——不需要任何 XSS，
   只要「匯入別人給的樣式包 → 之後按一次匯出樣式」就會發生，而 UI 仍顯示匯出成功。
   兩道防線都在這裡鎖住：renderer 端淨化 group，主程序端再驗證最終路徑沒有越界。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 與 src/app.js 匯出分支同一組淨化規則 */
const sanitize = (s) => (s || '').replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+$/, '_');

/* 與 electron/main.js dialog:exportDirectory 同一組圍堵判斷 */
const contained = (root, name) => {
  const r = path.resolve(root);
  const full = path.resolve(r, name);
  return full === r || full.startsWith(r + path.sep);
};

const ATTACKS = [
  '../../../../Windows/System32',
  '..\\..\\..\\..\\Windows',
  '..',
  '....',
  './../..',
  'C:/Windows',
  'a/../../../b',
];

describe('preset.group 淨化（src/app.js 匯出分支）', () => {
  it('所有越界字串淨化後都不再含有路徑分隔符或單純的點', () => {
    for (const g of ATTACKS) {
      const s = sanitize(g);
      expect(s, `group=${JSON.stringify(g)}`).not.toMatch(/[/\\]/);
      expect(s, `group=${JSON.stringify(g)}`).not.toMatch(/^\.+$/);
    }
  });

  it('淨化後組出來的完整檔名一律留在目標資料夾內', () => {
    const root = path.resolve('/tmp/export-target');
    for (const g of ATTACKS) {
      const name = `${sanitize(g)}/${sanitize('style')}.json`;
      expect(contained(root, name), `group=${JSON.stringify(g)}`).toBe(true);
    }
  });

  it('正常的資料夾與名稱不受影響', () => {
    expect(sanitize('我的樣式')).toBe('我的樣式');
    expect(sanitize('News Package')).toBe('News Package');
    expect(contained(path.resolve('/tmp/x'), '我的樣式/主標.json')).toBe(true);
  });
});

describe('主程序圍堵（electron/main.js dialog:exportDirectory）', () => {
  it('未淨化的越界檔名會被判定為越界（第二道防線確實有效）', () => {
    const root = path.resolve('/tmp/export-target');
    expect(contained(root, '../../../../Windows/evil.json')).toBe(false);
    expect(contained(root, 'a/../../../b.json')).toBe(false);
    if (process.platform === 'win32') {
      expect(contained(root, '..\\..\\evil.json')).toBe(false);
    }
    expect(contained(root, 'ok.json')).toBe(true);
    expect(contained(root, 'sub/ok.json')).toBe(true);
  });

  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

  it('main.js 確實有做路徑圍堵，不是只靠呼叫端淨化', () => {
    expect(main).toMatch(/exportDirectory blocked \(escapes target dir\)/);
    expect(main).toMatch(/fullPath !== root && !fullPath\.startsWith\(root \+ path\.sep\)/);
  });

  it('ffmpeg:cleanup 只能刪 CACHE/TMP 底下的檔（不可為任意路徑刪除原語）', () => {
    expect(main).toMatch(/ffmpeg:cleanup blocked \(outside cache\)/);
  });

  it('mpv:screenshot 有副檔名檢查', () => {
    expect(main).toMatch(/mpv:screenshot blocked \(bad ext\)/);
  });

  it('mpv 啟動時以 -- 終止選項解析，來源不會被當成 mpv 選項', () => {
    expect(main).toMatch(/mpvArgs\.push\('--', src\)/);
  });

  it('importDirectory 回傳相對路徑，樣式資料夾結構才不會在匯入時被攤平', () => {
    expect(main).toMatch(/path\.relative\(dir, p\)\.split\(path\.sep\)\.join\('\/'\)/);
  });
});

describe('src/app.js 匯出分支確實淨化 group', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  it('safeGroup 存在且用於組檔名', () => {
    expect(app).toMatch(/const safeGroup = \(p\.group \|\| ''\)\.replace/);
    expect(app).toMatch(/const folder = safeGroup \? `\$\{safeGroup\}\/` : '';/);
  });
});

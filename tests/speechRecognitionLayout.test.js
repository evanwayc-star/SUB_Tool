import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

describe('音訊辨識與文本匹配視窗版面', () => {
  it('寬螢幕讓內容與處理設定以容器中央為界等寬排列', () => {
    expect(css).toMatch(
      /\.asr-settings-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,1fr\)\s+minmax\(0,1fr\)[^}]*\}/u
    );
  });

  it('窄螢幕把兩個設定區塊依原本鍵盤順序改為單欄', () => {
    expect(css).toMatch(
      /@media\(max-width:760px\)\s*\{[\s\S]*?\.asr-settings-grid\s*\{\s*grid-template-columns\s*:\s*1fr\s*\}/u
    );
  });
});

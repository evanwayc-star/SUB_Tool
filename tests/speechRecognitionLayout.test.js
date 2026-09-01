import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
const speechRecognition = fs.readFileSync(path.join(ROOT, 'src', 'speech-recognition.js'), 'utf8');

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

  it('雲端 API Key 與音訊語言使用同高標題槽對齊控制項', () => {
    expect(speechRecognition).toContain('class="asr-field asr-language-field"');
    expect(css).toMatch(
      /\.asr-settings-grid\.is-transcribe #asrKeyRow>\.asr-field-heading,[\s\S]*?\.asr-settings-grid\.is-transcribe \.asr-language-field>label\{min-height:28px\}/u
    );
  });

  it('音訊素材名稱使用藍色，且只有多素材時才顯示總時長', () => {
    expect(css).toMatch(/\.asr-source-name\{[^}]*color:#93c5fd[^}]*\}/u);
    expect(speechRecognition).toMatch(
      /const totalDurationSummary = clips\.length > 1[\s\S]*?class="asr-duration-pill">總計約/u
    );
    expect(speechRecognition).toContain('${totalDurationSummary}');
  });
});

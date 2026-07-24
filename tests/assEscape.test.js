/* ASS 文字跳脫：使用者輸入的字面文字不可被 libass 當成控制碼吃掉。
   這裡鎖住的是實測出來的行為（內建 ffmpeg/libass，1000x562 畫面數亮像素）：
     AAABBBCCC        → 4940（9 字基準）
     AAA{BBB}CCC      → 2997  ← {BBB} 整段被吞，只剩 AAACCC
     AAA\{BBB\}CCC    → 5579  ← 11 字完整渲染
     C:\Users\test    → 4091  ← 單獨反斜線不受影響，13 字完整渲染（故刻意不動它）
     AAA\NBBB         → 兩行  ← \N 被當成換行
   對應 docs/技術架構說明.md §0.1（三路一致）與 §0.6（有產出不等於對）。 */
import { describe, it, expect } from 'vitest';
import { assEscapeText, assJoinVertical, verticalChars } from '../src/substyle.js';
import { SubFormats } from '../src/formats.js';

const ZW = '​';

describe('assEscapeText', () => {
  it('大括號跳脫成 \\{ \\}（否則整段被當 override tag 吃掉）', () => {
    expect(assEscapeText('AAA{BBB}CCC')).toBe('AAA\\{BBB\\}CCC');
  });

  it('從 SRT 匯入殘留的 {\\an8} 標籤會被保留成可見文字', () => {
    const out = assEscapeText('{\\an8}字幕內容');
    expect(out).toContain('\\{');
    expect(out).toContain('\\}');
    // 內部的 \a 不是 N/n/h，不必切斷
    expect(out).toBe('\\{\\an8\\}字幕內容');
  });

  it('切斷 \\N \\n \\h 這三種控制序列', () => {
    expect(assEscapeText('AAA\\NBBB')).toBe(`AAA\\${ZW}NBBB`);
    expect(assEscapeText('AAA\\nBBB')).toBe(`AAA\\${ZW}nBBB`);
    expect(assEscapeText('AAA\\hBBB')).toBe(`AAA\\${ZW}hBBB`);
  });

  it('一般 Windows 路徑不動它（實測 libass 只認 \\N \\n \\h）', () => {
    expect(assEscapeText('C:\\Users\\test')).toBe('C:\\Users\\test');
    expect(assEscapeText('D:\\影片\\第01集.mp4')).toBe('D:\\影片\\第01集.mp4');
  });

  it('純中文對白完全不變（日常情境零影響）', () => {
    expect(assEscapeText('這是一句普通的字幕')).toBe('這是一句普通的字幕');
  });

  it('null / undefined 回空字串，不丟例外', () => {
    expect(assEscapeText(null)).toBe('');
    expect(assEscapeText(undefined)).toBe('');
  });

  it('跳脫產生的反斜線本身不會再被 \\N 規則誤傷', () => {
    // '{' → '\{'，新插入的反斜線後面接的是 '{' 而非 N/n/h
    expect(assEscapeText('{N}')).toBe('\\{N\\}');
  });
});

describe('直書路徑同樣受保護', () => {
  const st = { fontSize: 80, letterSpacing: 0, lineSpacing: 1 };

  it('assJoinVertical 會跳脫使用者字元，但保留自己的 {\\fs} 控制碼', () => {
    const out = assJoinVertical(verticalChars('A{B'), st);
    expect(out).toContain('\\{');          // 使用者的大括號被跳脫
    expect(out).not.toContain('{B');       // 不會殘留未跳脫的開括號
  });

  it('半形空白的 \\h 墊高 hack 不受跳脫影響', () => {
    const out = assJoinVertical(verticalChars('A B'), { ...st, fontSize: 80 });
    expect(out).toContain('\\h');          // 控制碼仍在
    expect(out).not.toContain(`\\${ZW}h`); // 沒有被當成使用者文字切斷
  });
});

/* 上面測的是純函式。真正會出事的地方是【呼叫點】——跳脫函式再正確，
   只要 toASS() 忘了套用，使用者的文字照樣會被 libass 吃掉。
   這一組走完整的 SubFormats.toASS()，鎖住那條路徑。 */
describe('toASS() 這個呼叫點真的有套用跳脫', () => {
  const cue = (text, extra = {}) => ({ start: 1, end: 2, text, track: 0, ...extra });

  it('使用者輸入的大括號在輸出的 Dialogue 行裡是跳脫過的', () => {
    const ass = SubFormats.toASS([cue('前面{註}後面')], 25);
    const line = ass.split('\n').find(l => l.startsWith('Dialogue:'));

    expect(line).toContain('\\{註\\}');
    // 不可出現未跳脫的 {註 —— 那會讓 libass 從這裡開始吃掉整段
    expect(line).not.toMatch(/(?<!\\)\{註/);
  });

  it('我們自己送的控制碼沒有被一起跳脫（否則整句定位會壞掉）', () => {
    const ass = SubFormats.toASS([cue('文字')], 25);
    const line = ass.split('\n').find(l => l.startsWith('Dialogue:'));

    // \pos / \an 這類是我們要給 libass 的指令，必須維持未跳脫的 { }
    expect(line).toMatch(/\{\\(pos|an|fs|c&)/);
  });

  it('\\N 被切斷後不再被當成強制換行', () => {
    const ass = SubFormats.toASS([cue('AAA\\NBBB')], 25);
    const line = ass.split('\n').find(l => l.startsWith('Dialogue:'));

    expect(line).not.toContain('AAA\\NBBB');
    expect(line).toContain(ZW);   // 零寬空格插在反斜線與 N 之間
  });

  it('真正的多行字幕仍然輸出成 \\N（跳脫不可誤傷它）', () => {
    const ass = SubFormats.toASS([cue('第一行\n第二行')], 25);
    const line = ass.split('\n').find(l => l.startsWith('Dialogue:'));

    expect(line).toContain('第一行\\N第二行');
    expect(line).not.toContain(`\\${ZW}N第二行`);
  });
});

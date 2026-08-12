/* 指令表的完整性（src/commands.js）。

   【這是把 switch 攤成資料的唯一理由】
   指令是三個來源共用的介面：index.html 的 data-act 按鈕、keyboard.js 的
   emit('action', …)、以及右鍵選單。以前它的實作是 app.js 裡一個 82 個 case 的
   switch，而 app.js 沒有任何 export——沒有任何方法回答「這顆按鈕真的有實作嗎」。
   少一個 case 的後果是按下去什麼都不會發生，沒有錯誤、沒有 log。

   實測：攤成表之後第一次跑這個檢查，就抓到 keyboard.js 送出的 'mark-in'、
   'mark-out'、'mark-clear' 三個指令根本不存在（那三個 case 也沒有任何按鍵
   綁得到，兩端都是死的，所以一直沒被發現）。

   這裡刻意【讀原始碼】而不是 import commands.js：createCommands() 會把 media、
   timeline、subio 等整條依賴鏈拉進來，需要 DOM 與一堆 mock；而要檢查的是
   「有沒有這個 id」，不是它做了什麼。用原始碼比對就不必付那個代價。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const commandsSrc = read('src/commands.js');
/* 表格條目：縮排四格的 'id': —— 與 CLOSE_PANELS 那四個由迴圈補上的。 */
const tableIds = [...commandsSrc.matchAll(/^ {4}'([a-z0-9_-]+)':/gm)].map(m => m[1]);
const closeIds = [...commandsSrc.matchAll(/^ {2}'(close-[a-z]+)':/gm)].map(m => m[1]);
const COMMANDS = new Set([...tableIds, ...closeIds]);

const htmlActs = [...read('index.html').matchAll(/data-act="([^"]+)"/g)].map(m => m[1]);
const keyboardActs = [...read('src/keyboard.js').matchAll(/emit\('action',\s*'([^']+)'/g)].map(m => m[1]);

describe('指令表本身', () => {
  it('抓得到整張表（解析沒有失效）', () => {
    expect(COMMANDS.size).toBeGreaterThan(70);
    expect(COMMANDS.has('playpause')).toBe(true);
    expect(COMMANDS.has('close-mixer')).toBe(true); // 迴圈補上的那四個
  });

  it('沒有重複的 id（後者會靜默覆蓋前者）', () => {
    const all = [...tableIds, ...closeIds];
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('每個觸發點都有對應的指令', () => {
  it('index.html 的每個 data-act 都在表上', () => {
    const missing = [...new Set(htmlActs)].filter(act => !COMMANDS.has(act));
    expect(missing, `這些按鈕按下去不會有任何反應：${missing.join('、')}`).toEqual([]);
  });

  it('keyboard.js 送出的每個 action 都在表上', () => {
    const missing = [...new Set(keyboardActs)].filter(act => !COMMANDS.has(act));
    expect(missing, `這些快捷鍵按下去不會有任何反應：${missing.join('、')}`).toEqual([]);
  });
});

/* 反方向：表上有、但沒有任何地方會觸發的 id ＝ 永遠不會被執行到的程式碼。
   一度有六個（exp-srt／exp-ass／exp-encore／exp-txt 被 exp-dialog 的格式勾選取代，
   seek-start／add-cue 的實際使用者是直接呼叫函式的快捷鍵），已全部移除。
   這條不留允許清單——要新增指令，就連同觸發點一起加。 */
describe('沒有任何指令是孤兒', () => {
  it('每個指令都至少有一個觸發點（index.html 或快捷鍵）', () => {
    const triggered = new Set([...htmlActs, ...keyboardActs]);
    const orphans = [...COMMANDS].filter(id => !triggered.has(id)).sort();
    expect(orphans, `這些指令沒有任何地方會觸發：${orphans.join('、')}`).toEqual([]);
  });
});

/* 指令表現在已經完全自給自足，不再需要 app.js 注入任何接線！ */
describe('完美單向資料流', () => {
  it('commands.js 不再依賴 ctx，完全獨立運作', () => {
    const used = [...commandsSrc.matchAll(/\bctx\.([a-zA-Z]+)/g)];
    expect(used, '發現殘留的 ctx 依賴').toEqual([]);
  });
});

/* app.js 不該再留著第二套指令分派。 */
describe('app.js 只剩接線', () => {
  it('doAction 是一行委派，不再是 switch', () => {
    const appSrc = read('src/app.js');
    expect(appSrc).toContain('function doAction(act, force = false){ return Commands.run(act, { force }); }');
    expect(appSrc).not.toMatch(/switch\s*\(\s*act\s*\)/);
  });
});

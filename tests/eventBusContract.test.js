/* 事件匯流排的契約（v6.1.2）。

   `events.js` 的 emit 在沒有 handler 時是【靜默 no-op】，而事件名是字串：
     - eslint 的 no-undef 看不到字串內容；
     - rollup 沒有模組邊可以檢查（這正是用匯流排換來的）；
     - 於是「半條邊」——有人發沒人聽、有人聽沒人發——不會有任何徵兆。

   壞掉的樣子：功能安靜地不作用。實際發生過的四筆（v6.1.2 修）：
     render:searchCount → #searchCount 永遠不更新（搜尋結果計數是死的）
     render:subList     → 搜尋後字幕列不重繪，.search-match 高亮出不來
     render:selection   → 刪除／貼上後選取列的 UI 不同步
     render:checkPanel  → Trim 後字元檢查面板不刷新
   另有 render:timeline 這個沒人訂閱的名字（通用的那個叫 timeline:invalidate）。

   反向也發生過：app.js 曾訂閱 panel:toggle 但全專案零個 emit，
   那筆是靠人工發現的（見 app.js 該處註解）。

   【這支測得到什麼、測不到什麼】
   測得到：emit 名與 on 名的集合相等、沒有名稱被訂閱兩次。
   測不到：handler 做的事對不對，也測不到「該發事件的地方忘了發」。 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* 先拿掉註解。這一步不是潔癖——本專案的區塊註解裡就寫著 emit('event')、
   emit('media:*') 這種說明用的假名稱，不濾掉會把它們當成真的發送點。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1'); // 前面加守衛，避免砍掉 http:// 這種
}

/* 只認直接呼叫（前面不是 `.` 或識別字），才不會把 ipcRenderer.on / el.on 算進來。
   timeline-renderer.js 把 on 改名成 _onEvent import，一併認。 */
const EMIT_RE = /(?<![.\w])emit\s*\(\s*['"]([^'"]+)['"]/g;
const ON_RE = /(?<![.\w])(?:on|_onEvent)\s*\(\s*['"]([^'"]+)['"]/g;

function census() {
  const emitted = new Map();
  const subscribed = new Map();
  for (const file of jsFiles(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const code = stripComments(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(EMIT_RE)) {
        if (!emitted.has(m[1])) emitted.set(m[1], []);
        emitted.get(m[1]).push(`${rel}:${i + 1}`);
      }
      for (const m of line.matchAll(ON_RE)) {
        if (!subscribed.has(m[1])) subscribed.set(m[1], []);
        subscribed.get(m[1]).push(`${rel}:${i + 1}`);
      }
    });
  }
  return { emitted, subscribed };
}

describe('事件匯流排：不可留下半條邊', () => {
  const { emitted, subscribed } = census();

  it('每個被 emit 的事件都有訂閱者', () => {
    const dangling = [...emitted.entries()]
      .filter(([name]) => !subscribed.has(name))
      .map(([name, sites]) => `${name}  ←  ${sites.join(', ')}`);
    expect(dangling, `這些事件有人發、沒人聽（emit 是靜默 no-op，不會報錯）：\n${dangling.join('\n')}`)
      .toEqual([]);
  });

  it('每個被訂閱的事件都有發送端', () => {
    const orphan = [...subscribed.entries()]
      .filter(([name]) => !emitted.has(name))
      .map(([name, sites]) => `${name}  ←  ${sites.join(', ')}`);
    expect(orphan, `這些訂閱永遠不會被觸發：\n${orphan.join('\n')}`).toEqual([]);
  });

  it('同一個事件不可被訂閱兩次', () => {
    /* events.js 的 on() 是 push、不去重，所以重複訂閱＝handler 跑兩遍。
       app.js 曾把 on('render:trackStyle', renderTrackStyle) 註冊兩次，
       於是每次選取變更都把整個樣式面板（含 preset 的 <optgroup> DOM）重建兩遍。 */
    const dupes = [...subscribed.entries()]
      .filter(([, sites]) => sites.length > 1)
      .map(([name, sites]) => `${name}  ←  ${sites.join(', ')}`);
    expect(dupes, `重複訂閱會讓 handler 跑多次：\n${dupes.join('\n')}`).toEqual([]);
  });

  it('普查本身有抓到東西（避免正規表示式失效卻全綠）', () => {
    expect(emitted.size).toBeGreaterThan(20);
    expect(subscribed.size).toBeGreaterThan(20);
    expect(emitted.has('render:all')).toBe(true);
    expect(subscribed.has('render:all')).toBe(true);
  });
});

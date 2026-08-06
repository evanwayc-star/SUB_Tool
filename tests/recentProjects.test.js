/* 最近開啟專案的清單規則（electron/recent-projects.js）。

   規則很短，但壞掉的樣子都是安靜的：同一支檔案出現兩列、清單無限長大、
   或剛開過的那筆沒有排到最前面——沒有一種會報錯。

   【路徑為什麼由主程序持有】
   fileAuthority 的授權是每次工作階段的，重開程式後舊路徑不再被授權。
   若讓 renderer 記住路徑再送回去開，等於給了它一條「叫主程序讀任意檔案」的路。
   所以清單在主程序這邊，renderer 只拿得到顯示字串與索引。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = require(path.join(ROOT, 'electron/recent-projects.js'));

/* 用平台原生的絕對路徑組測資——addRecent 會 path.resolve()，
   在 POSIX 上寫 'D:/x' 不是絕對路徑，測到的會是別的東西。 */
const abs = name => path.resolve(path.sep === '\\' ? `D:\\proj\\${name}` : `/proj/${name}`);

describe('addRecent', () => {
  it('新的排最前面', () => {
    let list = R.addRecent([], abs('a.subtool'), { now: 1 });
    list = R.addRecent(list, abs('b.subtool'), { now: 2 });
    expect(list.map(x => x.name)).toEqual(['b.subtool', 'a.subtool']);
  });

  it('同一支檔只留一列，並移到最前面（不是新增第二列）', () => {
    let list = R.addRecent([], abs('a.subtool'), { now: 1 });
    list = R.addRecent(list, abs('b.subtool'), { now: 2 });
    list = R.addRecent(list, abs('a.subtool'), { now: 3 });
    expect(list.map(x => x.name)).toEqual(['a.subtool', 'b.subtool']);
    expect(list[0].at).toBe(3);
  });

  /* Windows 的路徑比對不分大小寫。不處理的話 D:\A.subtool 與 d:\a.subtool
     會變成兩列，看起來像開了兩個不同的專案。 */
  it('路徑比對不分大小寫', () => {
    const lower = path.resolve(path.sep === '\\' ? 'D:\\proj\\a.subtool' : '/proj/a.subtool');
    const upper = path.resolve(path.sep === '\\' ? 'd:\\PROJ\\A.SUBTOOL' : '/proj/a.subtool');
    let list = R.addRecent([], lower, { now: 1 });
    list = R.addRecent(list, upper, { now: 2 });
    expect(list.length).toBe(1);
  });

  it('上限 10 筆，超過的從尾端丟掉', () => {
    let list = [];
    for (let i = 0; i < 15; i++) list = R.addRecent(list, abs(`p${i}.subtool`), { now: i });
    expect(list.length).toBe(R.MAX_ENTRIES);
    expect(list.length).toBe(10);
    expect(list[0].name).toBe('p14.subtool');   // 最新
    expect(list.at(-1).name).toBe('p5.subtool'); // 最舊還留著的
  });

  it('不就地修改傳進來的清單', () => {
    const original = R.addRecent([], abs('a.subtool'), { now: 1 });
    const copy = JSON.parse(JSON.stringify(original));
    R.addRecent(original, abs('b.subtool'), { now: 2 });
    expect(original).toEqual(copy);
  });

  it('空字串／非字串一律忽略，不可以塞進一筆壞資料', () => {
    const base = R.addRecent([], abs('a.subtool'), { now: 1 });
    expect(R.addRecent(base, '', { now: 2 })).toEqual(base);
    expect(R.addRecent(base, '   ', { now: 2 })).toEqual(base);
    expect(R.addRecent(base, null, { now: 2 })).toEqual(base);
    expect(R.addRecent(base, 42, { now: 2 })).toEqual(base);
  });
});

describe('sanitize', () => {
  /* settings.json 是使用者可以直接編輯的檔案——不可信任它的內容。 */
  it('濾掉形狀不對的項目', () => {
    const out = R.sanitize([
      { path: abs('ok.subtool'), name: 'ok.subtool' },
      { path: '' }, { path: 123 }, null, undefined, 'not-an-object', {},
    ]);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('ok.subtool');
  });

  it('不是陣列時回空陣列，不丟例外', () => {
    expect(R.sanitize(undefined)).toEqual([]);
    expect(R.sanitize(null)).toEqual([]);
    expect(R.sanitize({ nope: true })).toEqual([]);
    expect(R.sanitize('x')).toEqual([]);
  });

  it('讀取時也套上限（設定檔被手動塞了 100 筆也不會爆選單）', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ path: abs(`p${i}.subtool`) }));
    expect(R.sanitize(many).length).toBe(10);
  });
});

describe('removeRecent', () => {
  it('移除指定路徑（不分大小寫）', () => {
    let list = R.addRecent([], abs('a.subtool'), { now: 1 });
    list = R.addRecent(list, abs('b.subtool'), { now: 2 });
    const out = R.removeRecent(list, abs('a.subtool').toUpperCase());
    expect(out.map(x => x.name)).toEqual(['b.subtool']);
  });

  it('移除不存在的路徑不會改變清單', () => {
    const list = R.addRecent([], abs('a.subtool'), { now: 1 });
    expect(R.removeRecent(list, abs('zzz.subtool'))).toEqual(list);
  });
});

/* SUB Tool — 極簡 i18n 骨架（X4 phase 1，葉模組零相依）

   設計（漸進式、非破壞性）：
   - 以「原文（繁中）字串本身」作為 key，t('已匯出') 在預設 zh 下原樣回傳，
     因此把任何使用者可見字串包成 t(...) 都不會改變現有行為。
   - 要支援其他語言時，新增一份 MESSAGES.<lang>（key=繁中原文）並呼叫 setLang('en')；
     找不到對應翻譯時回退原文，故抽離工作可一條一條漸進進行，未抽的字串照常顯示。
   - 帶參數的字串用函式值：t('已匯出 {0}', name) 由各 message 自行格式化，或直接用樣板字串。

   phase 1 只建立機制並示範抽離 subio 匯出流程的幾條文案；其餘約 900 條為後續階段。 */

const MESSAGES = {
  // en: { '所選軌道沒有字幕': 'Selected track has no subtitles', ... }  // 未來新增
};

let _lang = 'zh';
function setLang(l) { _lang = l; }
function getLang() { return _lang; }

// t(原文, ...args)：zh 直接回原文；其他語言查表，缺則回退原文。
// 簡易 {0}{1} 佔位符替換，方便帶變數的字串。
function t(src, ...args) {
  let s = src;
  if (_lang !== 'zh') {
    const tbl = MESSAGES[_lang];
    if (tbl && tbl[src] != null) s = tbl[src];
  }
  if (args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] != null ? args[+i] : m));
  return s;
}

export { t, setLang, getLang };

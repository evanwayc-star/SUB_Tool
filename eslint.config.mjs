import globals from 'globals';

/* 開發期靜態安全網。ESLint 9+ 的 flat config【不會】預設套用 recommended——
   規則沒寫在這裡就是沒開。這份刻意維持小而窄：只收「違反後會靜默壞掉」的規則
   （見 AGENTS.md §7 與 docs/技術架構說明.md §0），不做風格檢查。

   真實事故：State 物件曾有 8 個欄位重複宣告（後者覆蓋前者），
   在版控裡活了好幾個版本沒被發現——因為 no-dupe-keys 從來沒開。 */
const silentBugRules = {
  'no-undef': 'error',          // 跨模組漏 import：本專案原本唯一的規則
  'no-dupe-keys': 'error',      // 物件重複鍵：後者靜默覆蓋前者
  'no-dupe-else-if': 'error',   // 重複的 else-if 條件：第二個永遠不會進去
  'no-duplicate-case': 'error', // switch 重複 case：第二個是死碼
  'no-unsafe-negation': 'error',// !a in b —— 幾乎一定是想寫 !(a in b)
  'no-self-assign': 'error',
  'no-self-compare': 'error',   // a === a：想比的通常是別的東西
  'use-isnan': 'error',         // x === NaN 永遠是 false
  'no-unreachable': 'error',
  'no-dupe-class-members': 'error',
  /* 預設的 except-parens 模式：抓 if(a = b) 這種筆誤，但放行
     while((m = re.exec(s))) —— 多包一層括號就是「我知道我在賦值」的表態，
     那是 regex 逐一比對的標準寫法（見 subtitles.js:332）。 */
  'no-cond-assign': 'error',
  'no-unused-vars': 'off',      // 刻意關閉：本專案有大量刻意保留的匯出
};

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, structuredClone: 'readonly', __APP_VERSION__: 'readonly' },
    },
    rules: silentBugRules,
  },
  /* electron/ 以前【完全沒有被檢查】——舊設定的 files 只寫了 src/**，
     所以 `eslint src electron` 裡的 electron 那段是無聲的 no-op，2,268 行零規則。
     主程序是 CommonJS + Node globals，與 renderer 不同，需要自己的區塊。 */
  {
    files: ['electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: silentBugRules,
  },
];

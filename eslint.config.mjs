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

/* 選取狀態的唯一入口。三種選取（字幕／視訊片段／音訊片段）互斥、
   activeTrackKind 必須與被選中的 id 同類——這兩條不變量寫在 state.js 的
   setSelection() 裡，違反時【不會報錯】，只會讓 Delete／Ctrl+K／↑↓
   作用在使用者以為沒選中的東西上。 */
const selectionFence = {
  selector: "AssignmentExpression[left.object.name='State'][left.property.name=/^(selectedId|selectedIds|selectedClipId|selectedAudioClipId|activeTrackKind)$/]",
  message: '選取狀態請改用 state.js 的 setSelection / deselect / pruneSelection / focusTrackKind，不要直接賦值（見 state.js setSelection 的不變量註解）。',
};

/* Media 的底線名稱是它的內部欄位。以前 app.js／pointer-interaction.js／
   decode/player.js 直接讀寫 _wcTakeover、_gap、_activeClip、_srcLocalT，
   等於把 Media 的內部結構變成全專案介面的一部分——改個欄位名就會靜默壞掉，
   而 `mpvMode && !_wcTakeover` 這種組合更被各處手抄了七次。

   已改走公開入口：activeClip() / inGap() / sourceLocalTime() /
   mpvPresenting() / webCodecsTakeover() / setWebCodecsTakeover() … */
/* ── 這道圍籬守的是【識別字】，不是接縫 ──────────────────────────────
   選擇器比對的是「物件叫什麼名字」。所以任何模組只要把 Media 換個名字持有，
   就自動免疫：`src/loaders/media-loader.js` 收下的參數叫 `ctx`，
   於是它存取 Media 的 17 個私有欄位、共 40 處，lint 從頭到尾看不到。

   兩件事要分開看：
   1) media-loader.js 觸及那些欄位【本身是可以的】——它是 Media 實作的一部分
      （media.js 把它再包成方法：`loadDesktopMedia(p){ return loadDesktopMedia(this,p) }`），
      屬於 Media 的【內部接縫】而非外部接縫。問題在於這件事從來沒有被寫下來，
      而是靠圍籬的一個漏洞默許的。現在明確列進 MEDIA_INTERNAL_FILES。
   2) 其他檔案若也用別名持有 Media，同樣會靜默穿過。因此把已知別名納入比對。
      **新增別名時要回來加**——沒有純靜態的方法能認出「這個參數其實就是 Media」，
      這是本規則的維護成本，寫在這裡以免下一個人以為它是萬全的。 */
const mediaPrivateFence = {
  selector: "MemberExpression[object.name=/^(Media|ctx)$/][property.name=/^_/]",
  message: 'Media 的底線名稱是內部欄位，請改用它的公開入口（activeClip／inGap／sourceLocalTime／mpvPresenting／webCodecsTakeover…）。若你的模組確實屬於 Media 的實作，請列進 eslint.config.mjs 的 MEDIA_INTERNAL_FILES，並在該檔案標明。',
};

/* Media 實作的一部分——可以碰 Media 的私有欄位。
   清單刻意短：每多一個，就代表 Media 的實作又散到一個檔案。 */
const MEDIA_INTERNAL_FILES = ['src/media.js', 'src/loaders/media-loader.js'];

const encapsulationFences = [selectionFence, mediaPrivateFence];

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
  /* 選取狀態的唯一入口。三種選取（字幕／視訊片段／音訊片段）互斥、
     activeTrackKind 必須與被選中的 id 同類——這兩條不變量寫在 state.js 的
     setSelection() 裡，違反時【不會報錯】，只會讓 Delete／Ctrl+K／↑↓
     作用在使用者以為沒選中的東西上。

     這條規則就是那個接縫的圍籬：state.js 以外一律不准直接寫這五個欄位，
     要改就走 setSelection / deselect / pruneSelection / focusTrackKind。 */
  /* ── 模組內部狀態的圍籬 ──────────────────────────────────────────────
     `no-restricted-syntax` 的設定在 flat config 裡是【整組取代】而非累加，
     所以兩條圍籬不能各寫一個 block（後者會把前者關掉，而且不會有任何警告）。
     這裡集中成一份清單，再依「自己人不受自己那條限制」拆成三個 block。 */
  {
    files: ['src/**/*.js'],
    ignores: ['src/state.js', ...MEDIA_INTERNAL_FILES],
    rules: { 'no-restricted-syntax': ['error', ...encapsulationFences] },
  },
  { files: ['src/state.js'], rules: { 'no-restricted-syntax': ['error', mediaPrivateFence] } },
  /* Media 實作的檔案不受 mediaPrivateFence 限制，但仍受 selectionFence 限制。 */
  { files: MEDIA_INTERNAL_FILES, rules: { 'no-restricted-syntax': ['error', selectionFence] } },
];

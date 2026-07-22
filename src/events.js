/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/events.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — 極簡同步事件匯流排（葉模組，零相依）
   目的：讓低階模組只發送事件、不反向 import app.js 的渲染函式，
   由 app.js 訂閱並呼叫對應函式，藉此切斷與協調層的雙向相依。
   emit 為同步呼叫，語意等同直接呼叫原函式（順序、回傳時機不變）。 */
const _handlers = new Map();

function on(evt, fn){
  let a = _handlers.get(evt);
  if(!a){ a = []; _handlers.set(evt, a); }
  a.push(fn);
}
function emit(evt, ...args){
  const a = _handlers.get(evt);
  if(a) for(const fn of a) fn(...args);
}

export { on, emit };


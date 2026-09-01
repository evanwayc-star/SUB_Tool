/* ==============================================================================
   SUB Tool — 同步事件匯流排 (Synchronous Event Bus)
   ==============================================================================
   【架構與職責】
   提供底層渲染與互動模組透過事件解耦（切斷對 `app.js` 的直接反向 import）。
   
   【不變量】
   1. `emit` 為同步派發：派發順序與原直接函式呼叫完全一致。
   2. 任何模組嚴禁反向依賴 `app.js`（由 lint 靜態圍籬強制阻擋）。
   ============================================================================== */

/** @type {Map<string, Array<Function>>} */
const _handlers = new Map();

/**
 * 註冊事件監聽處理器。
 * 
 * @param {string} evt 事件名稱
 * @param {Function} fn 事件處理函式
 */
function on(evt, fn) {
  if (typeof fn !== 'function') return;
  let a = _handlers.get(evt);
  if (!a) {
    a = [];
    _handlers.set(evt, a);
  }
  a.push(fn);
}

/**
 * 同步派發事件至所有已註冊之處理器。
 * 
 * @param {string} evt 事件名稱
 * @param {...any} args 傳遞給處理器之參數
 */
function emit(evt, ...args) {
  const a = _handlers.get(evt);
  if (a && a.length > 0) {
    const listeners = a.slice();
    for (const fn of listeners) {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[EventBus] 處理事件 "${evt}" 發生未攔截錯誤:`, error);
      }
    }
  }
}

export { on, emit };

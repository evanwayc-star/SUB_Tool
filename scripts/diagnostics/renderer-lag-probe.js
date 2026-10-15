/* Renderer 延遲探針共用實作；由三支診斷工具注入，無須直接執行。
   用法：node scripts/diagnostics/watch-cpu-and-lag.js
   可見區間的延遲只是採樣證據；背景節流與可見性切換不能當作執行緒阻塞。 */
'use strict';

function rendererLagProbe({ timerKey, totalKey = null, recordsKey = null }) {
  return `(() => {
    const timerKey = ${JSON.stringify(timerKey)};
    const totalKey = ${JSON.stringify(totalKey)};
    const recordsKey = ${JSON.stringify(recordsKey)};
    const cleanupKey = timerKey + '_cleanup';
    if (window[cleanupKey]) window[cleanupKey]();
    else if (window[timerKey]) clearInterval(window[timerKey]);
    if (totalKey) window[totalKey] = 0;
    if (recordsKey) {
      window[recordsKey] = [];
      window[recordsKey + 'Dropped'] = 0;
    }
    let last = performance.now();
    let visible = document.visibilityState === 'visible';
    const reset = () => {
      last = performance.now();
      visible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', reset);
    window[timerKey] = setInterval(() => {
      const now = performance.now();
      const currentVisible = document.visibilityState === 'visible';
      const drift = now - last - 100;
      if (visible && currentVisible && drift > 200) {
        if (totalKey) window[totalKey] += drift;
        if (recordsKey) {
          const records = window[recordsKey];
          records.push({ t: Date.now(), blocked: drift });
          if (records.length > 600) {
            records.shift();
            window[recordsKey + 'Dropped']++;
          }
        }
      }
      last = now;
      visible = currentVisible;
    }, 100);
    window[cleanupKey] = () => {
      clearInterval(window[timerKey]);
      document.removeEventListener('visibilitychange', reset);
      delete window[cleanupKey];
    };
    return true;
  })()`;
}

module.exports = { rendererLagProbe };

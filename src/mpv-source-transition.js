// mpv 換母素材／短 GOP Proxy 時，loadfile 的初始 0 秒不能取得播放點權威。
// seek 目標的 time-pos 或目前呈現請求的實際畫格可完成切換；逾時與失敗都要釋放狀態。
export function createMpvSourceTransition({ timeoutMs = 5000, onTimeout = () => {}, onComplete = () => {}, onDiscard = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let generation = 0;
  let pending = null;
  const clear = (completed = false) => {
    const token = pending?.token;
    if (pending?.timer != null) clearTimer(pending.timer);
    pending = null;
    if (token != null) (completed ? onComplete : onDiscard)(token);
  };
  return {
    pending: () => !!pending,
    begin() {
      clear();
      const token = ++generation;
      pending = { token, target: null, timer: setTimer(() => {
        if (pending?.token !== token) return;
        clear();
        onTimeout();
      }, timeoutMs) };
      return token;
    },
    ready(token, target) {
      if (pending?.token !== token) return false;
      pending.target = Number(target);
      return true;
    },
    observe(sourceTime, tolerance) {
      if (!pending) return true;
      if (pending.target == null || !Number.isFinite(Number(sourceTime))
        || Math.abs(Number(sourceTime) - pending.target) > tolerance) return false;
      clear(true);
      return true;
    },
    presented(sourceTime) {
      // 只由已核對最新請求／來源及畫格的呈現提交呼叫。後續定位可取代
      // ready 的舊目標，不必等待已被 mpv 合併的中間 time-pos；尚未載妥仍拒絕。
      if (!pending || pending.target == null || !Number.isFinite(Number(sourceTime))) return false;
      clear(true);
      return true;
    },
    fail(token) {
      if (pending?.token === token) clear();
    },
    reset() { generation += 1; clear(); },
  };
}

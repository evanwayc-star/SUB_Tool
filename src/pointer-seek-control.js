/* ==============================================================================
   SUB Tool — 滑鼠跳轉播放策略與工具列控制
   ============================================================================== */
import { emit } from './events.js';
import { Media } from './media.js';
import { State, saveConfig } from './state.js';
import { setStatus } from './ui.js';

function renderPointerSeekControl() {
  const pauses = !!State.pointerSeekPauses;
  const label = pauses ? '跳轉暫停' : '跳轉繼續';
  const title = pauses
    ? '滑鼠跳到其他時間點時暫停播放；按下切換為跳轉後繼續播放'
    : '滑鼠跳到其他時間點後繼續播放；按下切換為跳轉後暫停';
  document.querySelectorAll('.pointer-seek-btn').forEach(btn => {
    btn.textContent = label;
    btn.classList.toggle('pause', pauses);
    btn.setAttribute('aria-pressed', String(pauses));
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
  });
}

function togglePointerSeekMode() {
  State.pointerSeekPauses = !State.pointerSeekPauses;
  renderPointerSeekControl();
  setStatus(State.pointerSeekPauses
    ? '滑鼠跳轉：定位後暫停'
    : '滑鼠跳轉：定位後繼續播放', 'ok');
  void saveConfig();
}

/* FPS-SYNC：參數永遠是時間軸時間；Media.seek() 負責吸附專案影格格網。
   播放狀態由 transport-controller 同步事件先行處理，再執行 seek。 */
function requestPointerSeek(timelineTime) {
  if (State.pointerSeekPauses) emit('transport:pointerSeekPause');
  Media.seek(timelineTime);
}

export { renderPointerSeekControl, togglePointerSeekMode, requestPointerSeek };

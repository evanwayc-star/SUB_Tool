/* 播放器 seek bar 的值仍是「時間軸毫秒」；本模組只同步原生 range 與其視覺填色，
   不做來源時間轉換，也不自行改變影格格網。 */
export function renderSeekBar(bar, timelineSeconds) {
  if (!bar) return 0;

  if (Number.isFinite(timelineSeconds)) {
    bar.value = String(Math.round(Math.max(0, timelineSeconds) * 1000));
  }

  const min = Number(bar.min);
  const max = Number(bar.max);
  const value = Number(bar.value);
  const span = max - min;
  const ratio = Number.isFinite(span) && span > 0 && Number.isFinite(value)
    ? Math.max(0, Math.min(1, (value - min) / span))
    : 0;
  const percent = ratio * 100;
  bar.style.setProperty('--seek-progress', `${percent}%`);
  return percent;
}

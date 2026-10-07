/* 固定影片只改視覺來源；片段的剪輯時間映射仍保留原本的 in/out/speed。 */
function fixedFrameTime(clip) {
  if (clip?.freezeTime == null) return null;
  const time = Number(clip.freezeTime);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function isStillClip(clip) {
  return clip?.type === 'image' || fixedFrameTime(clip) != null;
}

function lastSourceFrameIndex(duration, fps) {
  // ffprobe 時長以微秒捨入；容許千分之一格誤差，避免末格被誤算成 EOF 後一格。
  return Math.max(0, Math.ceil(duration * fps - 1e-3) - 1);
}

module.exports = { fixedFrameTime, isStillClip, lastSourceFrameIndex };

/* 序列層的純時間映射。影片與獨立音訊共用母素材座標，不依賴 State。 */
const speedOf = clip => Number(clip.speed)>0 ? Number(clip.speed) : 1;

export function sourceTime(t, clip) {
  const elapsed=(t-clip.offset)*speedOf(clip);
  return clip.reverse ? clip.out-elapsed : clip.in+elapsed;
}

export function timelineTime(s, clip) {
  const elapsed=clip.reverse ? clip.out-s : s-clip.in;
  return clip.offset+elapsed/speedOf(clip);
}

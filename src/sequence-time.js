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

// A private mpv ASS clock puts each project frame on four centiseconds.
// Both edges of the nearest-frame interval then fall on exact ASS timestamps.
// sub-speed converts these units back to source seconds during playback.
export function mpvSubtitleTiming(clip, exactFps) {
  const frame = (clip ? speedOf(clip) : 1) / exactFps;
  const reverse = !!clip?.reverse;
  const lowSourceTime = reverse ? timelineTime(clip.in, clip) : clip?.offset || 0;
  const anchor = (reverse ? Math.ceil(lowSourceTime * exactFps) : Math.floor(lowSourceTime * exactFps)) / exactFps;
  const origin = (clip ? sourceTime(anchor, clip) : anchor) - frame;
  // At a half-frame tie Math.round selects the higher timeline frame. Reversal
  // swaps which side includes the boundary. Keep the bias below one PTS tick.
  const clock = { origin: origin + (reverse ? 2e-7 : -2e-7), speed: frame / 0.04 };
  const edge = time => (Math.round((time - origin) / frame) + (reverse ? 0.5 : -0.5)) * 0.04;
  return { clock, range: cue => cue.timed === false ? cue : { ...cue, start: edge(cue.start), end: edge(cue.end) } };
}

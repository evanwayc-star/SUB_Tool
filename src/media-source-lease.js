/*
 * A video clip is a timeline placement, not the underlying media source.
 * Split placements deliberately share audioSourceId/audioSrc and the same
 * path/object URL.  Async probe/ingest/wave work therefore belongs to this
 * stable fingerprint instead of one transient clip object or id.
 */
function clipSourceFingerprint(clip) {
  if (!clip || typeof clip !== 'object') return '';
  const sourceId = clip.audioSourceId ?? clip.audioSrc ?? (clip.primary ? 'video' : `clip:${clip.id ?? ''}`);
  const locator = clip.path ?? clip.web?.url ?? '';
  return `${String(sourceId ?? '')}\u0000${String(locator)}`;
}

function liveClipForSource(clips, sourceClip) {
  const fingerprint = clipSourceFingerprint(sourceClip);
  if (!fingerprint || !Array.isArray(clips)) return null;
  return clips.find(clip => clipSourceFingerprint(clip) === fingerprint) || null;
}

function clipSourceStillReferenced(clips, sourceClip) {
  return !!liveClipForSource(clips, sourceClip);
}

export { clipSourceFingerprint, clipSourceStillReferenced, liveClipForSource };

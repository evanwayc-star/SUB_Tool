/* Visible subtitle-track labels are needed by both renderer UI and frozen
   delivery payloads.  Keep the rule independent from editing/runtime modules. */
export function burnedSubtitleTrackNames(tracks, cues = null) {
  const list = Array.isArray(tracks) ? tracks : [];
  const includedTracks = Array.isArray(cues)
    ? new Set(cues.map(cue => Number.isInteger(cue?.track) ? cue.track : 0))
    : null;
  const lastTrack = includedTracks?.size ? Math.max(...includedTracks) : list.length - 1;

  return Array.from({ length: Math.max(list.length, lastTrack + 1) }, (_, index) => {
    if (includedTracks && !includedTracks.has(index)) return null;
    const track = list[index];
    return (!track || track.visible !== false) ? (track?.name || `軌道 ${index + 1}`) : null;
  }).filter(Boolean);
}

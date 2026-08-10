/*
  ASS rendering from an explicit subtitle snapshot.  This deliberately does
  not read State: delivery work, comparison, and any future background export
  must render the tracks that were supplied at their own boundary.
*/
import { SubFormats } from './formats.js';
import { ASS_PLAY_RES } from './substyle.js';

export function renderASS(cues, { fps, tracks = [], dropFrame = false, ...options } = {}) {
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(Array.isArray(cues) ? cues : [], fps, tracks, RX, RY, {
    ...options,
    dropFrame,
  });
}

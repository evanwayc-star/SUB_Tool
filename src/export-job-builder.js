import { renderASS } from './ass-render.js';
import { secToEncore } from './time.js';
import { composeDeliveryAudioPlan } from './delivery-audio.js';
import { burnedSubtitleTrackNames } from './subtitle-track-names.js';

/* A submitted delivery must never look back into State.  The caller captures
   these fields together with the already-sliced media/audio snapshot, then all
   queue jobs derive their ASS, labels, and timecode from this immutable copy. */
export function freezeExportSubmission(snapshot, {
  cues = [], tracks = [], fps = 25, dropFrame = false,
  backgroundLayouts = {},
  mediaName = '', canvasW = 1920, canvasH = 1080,
  audioProject = null, defaultAudioLayout = {}, hasCustomRange = false,
} = {}) {
  if (!snapshot) return null;
  return structuredClone({
    ...snapshot,
    cues,
    tracks,
    backgroundLayouts,
    fps,
    dropFrame,
    mediaName,
    canvasW,
    canvasH,
    audioProject,
    defaultAudioLayout,
    hasCustomRange,
  });
}

export function subtitleCuesForSubmission(submission) {
  if (submission?.audioOnly) return [];
  const expIn = submission?.timelineStart != null ? submission.timelineStart : 0;
  const duration = Number(submission?.duration);
  const clipDuration = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
  const expOut = expIn + clipDuration;
  const tracks = Array.isArray(submission?.tracks) ? submission.tracks : [];
  return (Array.isArray(submission?.cues) ? submission.cues : [])
    .filter(cue => {
      if (!cue || cue.timed === false) return false;
      const trackIndex = Number.isInteger(cue.track) ? cue.track : 0;
      if (tracks[trackIndex]?.visible === false) return false;
      return Number(cue.end) > expIn && Number(cue.start) < expOut;
    })
    .map(cue => ({
      ...cue,
      start: Math.max(0, Number(cue.start) - expIn),
      end: Math.min(clipDuration, Number(cue.end) - expIn),
    }))
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start);
}

function subtitlePayloadForSubmission(submission) {
  const cues = subtitleCuesForSubmission(submission);
  if (!cues.length) return { assText: null, cues };
  const assText = renderASS(cues, {
    fps: submission?.fps,
    tracks: submission?.tracks,
    dropFrame: submission?.dropFrame,
    backgroundLayouts: submission?.backgroundLayouts,
  });
  return { assText: /\nDialogue:/.test(assText) ? assText : null, cues };
}

/**
 * Builds raw ExportJobs from a frozen submission and a DeliveryList.
 * This is a pure function and represents the boundary between domain logic 
 * and side effects (Electron/FFmpeg).
 */
export function buildExportJobs(submission, list) {
  const expIn = submission.timelineStart != null ? submission.timelineStart : 0;
  const subtitlePayload = subtitlePayloadForSubmission(submission);

  return list.toJobs({
    clips: submission.clips,
    videoTracks: submission.videoTracks,
    duration: submission.duration,
    assText: subtitlePayload.assText,
    /* 帶進 payload 供匯出佇列監控顯示。與 assText 出自同一份 frozen tracks，
       所以「說會燒哪幾軌」與「實際燒進 ASS 的」不會分岔。 */
    subtitleTracks: burnedSubtitleTrackNames(submission.tracks, subtitlePayload.cues),
    timelineStartTimecode: secToEncore(expIn, submission.fps, submission.dropFrame),
    composeAudioPlan: composeDeliveryAudioPlan,
    compiledAudioPlan: submission.audioPlan,
  });
}

import { toASSFromState } from './ffmpeg-export.js';
import { secToEncore } from './time.js';
import { composeDeliveryAudioPlan } from './delivery-audio.js';
import { burnedSubtitleTrackNames } from './subtitle-model.js';

/**
 * Builds raw ExportJobs from a project snapshot and a DeliveryList.
 * This is a pure function and represents the boundary between domain logic 
 * and side effects (Electron/FFmpeg).
 */
export function buildExportJobs(snapshot, list, stateInfo) {
  const { cues, fps, dropFrame, exportIn } = stateInfo;
  const audioOnly = !!snapshot.audioOnly;
  
  const expIn = snapshot.timelineStart != null ? snapshot.timelineStart : (exportIn != null ? exportIn : 0);
  
  const assText = !audioOnly && /\nDialogue:/.test(toASSFromState(cues))
    ? toASSFromState(cues.map(c => ({
        ...c, 
        start: Math.max(0, (c.start || 0) - expIn), 
        end: Math.max(0, (c.end || 0) - expIn)
      })))
    : null;

  return list.toJobs({
    clips: snapshot.clips,
    videoTracks: snapshot.videoTracks,
    duration: snapshot.duration,
    assText,
    /* 帶進 payload 供匯出佇列監控顯示。與 assText 出自同一份 State.tracks，
       所以「說會燒哪幾軌」與「實際燒進 ASS 的」不會分岔。 */
    subtitleTracks: burnedSubtitleTrackNames(stateInfo.tracks),
    timelineStartTimecode: secToEncore(expIn, fps, dropFrame),
    composeAudioPlan: composeDeliveryAudioPlan,
    compiledAudioPlan: snapshot.audioPlan,
  });
}

/**
 * Prepares parameters specifically for Web Export.
 */
export function buildWebExportParams(snapshot, stateInfo) {
  const { cues, exportIn } = stateInfo;
  const audioOnly = !!snapshot.audioOnly;
  const expIn = snapshot.timelineStart != null ? snapshot.timelineStart : (exportIn != null ? exportIn : 0);
  const assText = !audioOnly && /\nDialogue:/.test(toASSFromState(cues))
    ? toASSFromState(cues.map(c => ({
        ...c, 
        start: Math.max(0, (c.start || 0) - expIn), 
        end: Math.max(0, (c.end || 0) - expIn)
      })))
    : null;
  return { expIn, assText };
}

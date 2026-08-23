/* ==============================================================================
   SUB Tool — Export Delivery Engine ("src/export-delivery-engine.js")
   ==============================================================================
   深層匯出交付引擎 (Deep Export Delivery Engine)。
   提供交付工作構建、時間切片對齊、不可變快照凍結與送出交易防護：
   1. 同步快照凍結 (Freeze Submission Snapshot)
   2. 時間軸字幕切片、可見性過濾與 ASS 格式生成 (Subtitle Slicing & ASS Render)
   3. 交付工作編譯 (Build Export Jobs)
   4. 凍結事務防護與衝突檢查邊界 (Run Frozen Export Submission)
   ============================================================================== */

import { renderASS } from './ass-render.js';
import { secToEncore } from './time.js';
import { composeDeliveryAudioPlan } from './delivery-audio.js';
import { burnedSubtitleTrackNames } from './subtitle-track-names.js';

/**
 * 凍結當前專案與匯出範圍快照。
 * 匯出的 DeliveryJob 絕不可往回讀取可變的 State。
 */
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

/**
 * 依據匯出時間範圍切片並過濾出可見字幕軌。
 */
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

/**
 * 產出符合匯出範圍之 ASS 字串與字幕陣列。
 */
export function subtitlePayloadForSubmission(submission) {
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
 * 依據凍結快照與 DeliveryList 編譯產出純淨的 ExportJob 清單。
 */
export function buildExportJobs(submission, list) {
  const expIn = submission.timelineStart != null ? submission.timelineStart : 0;
  const subtitlePayload = subtitlePayloadForSubmission(submission);

  return list.toJobs({
    clips: submission.clips,
    videoTracks: submission.videoTracks,
    duration: submission.duration,
    assText: subtitlePayload.assText,
    subtitleTracks: burnedSubtitleTrackNames(submission.tracks, subtitlePayload.cues),
    timelineStartTimecode: secToEncore(expIn, submission.fps, submission.dropFrame),
    composeAudioPlan: composeDeliveryAudioPlan,
    compiledAudioPlan: submission.audioPlan,
  });
}

/**
 * 執行凍結狀態的匯出送交事務流程。
 */
export async function runFrozenExportSubmission({
  capture,
  validate = () => null,
  checkConflicts = () => true,
  dispatch,
} = {}) {
  if (typeof capture !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('capture and dispatch are required');
  }

  const frozen = capture();
  if (!frozen) {
    return { status: 'invalid', reason: '目前沒有可匯出的影片或外部音訊' };
  }

  const invalidReason = validate(frozen);
  if (invalidReason) {
    return { status: 'invalid', reason: invalidReason };
  }

  if (!(await checkConflicts(frozen))) {
    return { status: 'cancelled' };
  }

  return { status: 'submitted', value: await dispatch(frozen) };
}

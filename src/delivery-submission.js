import { createDeliveryList, projectTagFrom } from './delivery-list.js';
import { composeDeliveryAudioPlan } from './export-job-engine.js';
import { renderASS } from './formats.js';
import { secToEncore } from './time.js';

/* A delivery submission owns the whole asynchronous attempt. The dialog edits
   the existing DeliveryList, but never implements snapshot, conflict, receipt
   or ACK ordering. Directory/queue effects are the desktop adapter; tests use
   the same interface with deferred local adapters. */

export function freezeExportSubmission(snapshot, {
  cues = [], tracks = [], fps = 25, dropFrame = false,
  backgroundLayouts = {},
  mediaName = '', canvasW = 1920, canvasH = 1080,
  audioProject = null, defaultAudioLayout = {}, hasCustomRange = false,
} = {}) {
  if (!snapshot) return null;
  return structuredClone({
    ...snapshot, cues, tracks, backgroundLayouts, fps, dropFrame, mediaName,
    canvasW, canvasH, audioProject, defaultAudioLayout, hasCustomRange,
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

function subtitlePayloadForSubmission(submission) {
  const cues = subtitleCuesForSubmission(submission);
  if (!cues.length) return { assText: null, cues };
  const assText = renderASS(cues, {
    fps: submission?.fps, tracks: submission?.tracks,
    dropFrame: submission?.dropFrame, backgroundLayouts: submission?.backgroundLayouts,
  });
  return { assText: /\nDialogue:/.test(assText) ? assText : null, cues };
}

function buildExportJobs(submission, list) {
  const expIn = submission.timelineStart != null ? submission.timelineStart : 0;
  const subtitlePayload = subtitlePayloadForSubmission(submission);
  return list.toJobs({
    clips: submission.clips, videoTracks: submission.videoTracks, duration: submission.duration,
    assText: subtitlePayload.assText,
    subtitleTracks: burnedSubtitleTrackNames(submission.tracks, subtitlePayload.cues),
    timelineStartTimecode: secToEncore(expIn, submission.fps, submission.dropFrame),
    // FPS-SYNC: output FPS changes the TC spelling, never timeline seconds.
    timecodeForFps: fps => secToEncore(expIn, fps, submission.dropFrame),
    composeAudioPlan: composeDeliveryAudioPlan, compiledAudioPlan: submission.audioPlan,
  });
}

export function createDeliverySubmission({
  list, initialProject, readProject, isCurrent,
  desktop, confirmOverwrite, onChanged = () => {},
}) {
  if (!list || typeof list.captureSubmissionRows !== 'function') throw new TypeError('交付提交缺少清單');
  if (typeof readProject !== 'function' || typeof isCurrent !== 'function') throw new TypeError('交付提交缺少專案 adapter');
  if (typeof desktop?.listDir !== 'function' || typeof desktop?.exportVideo !== 'function') {
    throw new TypeError('交付提交缺少桌面 adapter');
  }
  if (typeof confirmOverwrite !== 'function') throw new TypeError('交付提交缺少覆寫確認 adapter');
  const audioOnly = !!initialProject?.audioOnly;
  let busy = false;
  let warning = null;
  let conflictGeneration = 0;

  const state = () => ({ busy, warning: warning ? structuredClone(warning) : null });
  const publish = accepted => {
    if (isCurrent()) onChanged({ ...state(), ...(accepted ? { accepted } : {}) });
  };
  const setWarning = (next, generation) => {
    if (!isCurrent() || generation !== conflictGeneration) return;
    warning = next;
    publish();
  };
  const frozenList = (project, rows) => createDeliveryList({
    projectTag: projectTagFrom(project.mediaName), fps: project.fps || 25,
    canvasW: project.canvasW || 1920, canvasH: project.canvasH || 1080,
    audioOnly: !!project.audioOnly, defaultAudioLayout: project.defaultAudioLayout || {},
    desktop: true, initial: rows,
  });

  async function conflicts(candidate, owns) {
    const blocking = candidate.problems().find(problem => problem.kind === 'blocking');
    if (blocking) return blocking;
    // Freeze paths before the first directory read, even for a live preview.
    const paths = candidate.outPaths();
    const names = [];
    try {
      for (const { dir, name } of paths) {
        if (!dir) continue;
        const files = await desktop.listDir(dir);
        if (!owns()) return null;
        const existing = files.map(file => (typeof file === 'string' ? file : file.name).toLowerCase());
        if (existing.includes(name.toLowerCase())) names.push(name);
      }
    } catch (error) {
      // Directory preview is advisory. Native admission remains authoritative.
    }
    return names.length ? {
      kind: 'overwrite', names,
      message: `警告：硬碟上已存在同名檔案 (${names.join(', ')})，匯出將會直接覆蓋。`,
    } : null;
  }

  async function previewConflicts() {
    const generation = ++conflictGeneration;
    const owns = () => isCurrent() && generation === conflictGeneration;
    if (!owns()) return state();
    const blocking = list.problems().find(problem => problem.kind === 'blocking');
    if (blocking) {
      setWarning(blocking, generation);
      return state();
    }
    const next = await conflicts(list, owns);
    if (owns()) setWarning(next, generation);
    return state();
  }

  async function submit() {
    if (!isCurrent()) return { status: 'cancelled', accepted: 0 };
    if (busy) return { status: 'busy', accepted: 0 };
    busy = true;
    const generation = ++conflictGeneration;
    let accepted = 0;
    publish();
    try {
      // No I/O may precede capture of both the project and original row receipt.
      const source = readProject();
      const project = source ? structuredClone(source) : null;
      const receipt = list.captureSubmissionRows();
      let reason = null;
      if (!project) reason = '目前沒有可匯出的影片或外部音訊';
      else if (project.audioOnly && !project.audioPlan) reason = '純音訊 WAV 匯出需要專案音軌路由';
      else if (project.audioPlan?.unresolvedSources?.length) {
        reason = `找不到可供匯出的音訊母素材：${project.audioPlan.unresolvedSources.map(item => item.name).join('、')}。請重新連結來源檔。`;
      } else if (!!project.audioOnly !== audioOnly) {
        reason = '匯出素材在交付清單開啟後已變更，請重新開啟清單確認交付格式。';
      } else if (!receipt.rows.length) reason = '清單不能為空';
      if (reason) return { status: 'invalid', reason, accepted };
      if (!isCurrent()) return { status: 'cancelled', accepted };
      const candidate = frozenList(project, receipt.rows);
      const issue = await conflicts(candidate, isCurrent);
      if (!isCurrent()) return { status: 'cancelled', accepted };
      setWarning(issue, generation);
      if (issue?.kind === 'blocking') return { status: 'invalid', reason: issue.submitMessage || issue.message, accepted };
      if (issue?.kind === 'overwrite') {
        const approved = await confirmOverwrite(issue.names.slice());
        if (!approved || !isCurrent()) return { status: 'cancelled', accepted };
      }
      const jobs = buildExportJobs(project, candidate);
      for (let index = 0; index < jobs.length; index++) {
        if (!isCurrent()) return { status: 'cancelled', accepted };
        if (!receipt.matches(index)) continue;
        const job = jobs[index];
        const jobId = await desktop.exportVideo(job);
        if (!jobId) return { status: 'cancelled', accepted };
        accepted++;
        if (!isCurrent()) return { status: 'cancelled', accepted };
        receipt.removeAccepted(index);
        publish({ jobId, name: job.defaultName });
      }
      return { status: 'submitted', accepted, complete: list.count() === 0 };
    } catch (error) {
      return { status: 'failed', accepted, error };
    } finally {
      busy = false;
      publish();
    }
  }

  return Object.freeze({ state, previewConflicts, submit });
}

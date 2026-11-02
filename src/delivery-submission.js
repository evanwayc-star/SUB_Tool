import { createDeliveryList, projectTagFrom } from './delivery-list.js';
import { composeDeliveryAudioPlan } from './export-job-engine.js';
import { renderASS } from './formats.js';
import { secToEncore } from './time.js';

let nextDeliveryRequest = 0;
const deliveryRequestId = () => `delivery-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++nextDeliveryRequest}`}`;

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

export function formatOverwriteConfirmation(paths) {
  return `硬碟上已存在同名檔案：\n${paths.join('\n')}\n\n確定要直接覆蓋並繼續匯出嗎？`;
}

export function exportSourceError(project) {
  if (project?.unresolvedClips?.length) return `尚有未完成復原的影片或圖片：${project.unresolvedClips.map(item => item.name).join('、')}。請等待復原完成或重新連結來源檔。`;
  if (project?.audioPlan?.unresolvedSources?.length) return `找不到可供匯出的音訊母素材：${project.audioPlan.unresolvedSources.map(item => item.name).join('、')}。請重新連結來源檔。`;
  return null;
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
  desktop, confirmOverwrite, onChanged = () => {}, subscribeInvalidation = null,
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
  let cancelled = false;
  let activeRequest = null;

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    if (activeRequest?.ticket && typeof desktop.cancelDeliveryTargetRequest === 'function') {
      try { Promise.resolve(desktop.cancelDeliveryTargetRequest(activeRequest.id,activeRequest.ticket)).catch(() => {}); } catch (_) {}
    }
  }

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
    const names = [], outputPaths = [];
    for (const { dir, name, path } of paths) {
      if (!dir) continue;
      try {
        const files = await desktop.listDir(dir);
        if (!owns()) return null;
        const existing = files.map(file => (typeof file === 'string' ? file : file.name).toLowerCase());
        if (existing.includes(name.toLowerCase())) { names.push(name); outputPaths.push(path); }
      } catch {
        if (!owns()) return null;
        return {
          kind: 'blocking',
          message: `無法檢查輸出資料夾「${dir}」是否有同名檔案，請確認資料夾可讀取後重試。`,
        };
      }
    }
    return names.length ? {
      kind: 'overwrite', names, paths: outputPaths,
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

  function invalidatePreview() {
    const generation = ++conflictGeneration;
    setWarning(null, generation);
  }

  async function submit() {
    if (cancelled || !isCurrent()) return { status: 'cancelled', accepted: 0 };
    if (busy) return { status: 'busy', accepted: 0 };
    busy = true;
    const generation = ++conflictGeneration;
    let accepted = 0;
    let targetReceipt = null;
    let requestId = null;
    let requestTicket = null;
    const owns = () => !cancelled && isCurrent();
    let unsubscribe = () => {};
    publish();
    try {
      if (typeof subscribeInvalidation === 'function') unsubscribe = subscribeInvalidation(cancel) || unsubscribe;
      // No I/O may precede capture of both the project and original row receipt.
      const source = readProject();
      const project = source ? structuredClone(source) : null;
      const receipt = list.captureSubmissionRows();
      const sourceError = exportSourceError(project);
      let reason = null;
      if (!project) reason = '目前沒有可匯出的影片或外部音訊';
      else if (sourceError) reason = sourceError;
      else if (project.audioOnly && !project.audioPlan) reason = '純音訊 WAV 匯出需要專案音軌路由';
      else if (!!project.audioOnly !== audioOnly) {
        reason = '匯出素材在交付清單開啟後已變更，請重新開啟清單確認交付格式。';
      } else if (!receipt.rows.length) reason = '清單不能為空';
      if (reason) return { status: 'invalid', reason, accepted };
      if (!owns()) return { status: 'cancelled', accepted };
      const candidate = frozenList(project, receipt.rows);
      let issue = await conflicts(candidate, owns);
      if (!owns()) return { status: 'cancelled', accepted };
      if (issue?.kind === 'blocking') {
        setWarning(issue, generation);
        return { status: 'invalid', reason: issue.submitMessage || issue.message, accepted };
      }
      if (typeof desktop.prepareDeliveryTargets === 'function') {
        if (typeof desktop.beginDeliveryTargetRequest !== 'function') throw new Error('無法建立交付確認工作，請重新啟動程式');
        requestId = deliveryRequestId();
        activeRequest = { id:requestId, ticket:null };
        requestTicket = await desktop.beginDeliveryTargetRequest(requestId);
        if (typeof requestTicket !== 'string' || !requestTicket) throw new Error('無法建立交付確認工作');
        activeRequest.ticket = requestTicket;
        if (!owns()) return { status:'cancelled', accepted };
        targetReceipt = await desktop.prepareDeliveryTargets(candidate.outPaths().map(item => item.path), requestId, requestTicket);
        if (!targetReceipt || typeof targetReceipt.id !== 'string' || !Array.isArray(targetReceipt.existing)) throw new Error('無法確認交付目標，請重新送出');
        if (!owns()) return { status: 'cancelled', accepted };
        const names = targetReceipt.existing.map(file => String(file).replaceAll('\\','/').split('/').pop());
        issue = names.length ? { kind:'overwrite', names, paths: targetReceipt.existing.slice(),
          message:`警告：硬碟上已存在同名檔案 (${names.join(', ')})，匯出將會直接覆蓋。` } : null;
      }
      setWarning(issue, generation);
      if (issue?.kind === 'overwrite') {
        const approved = await confirmOverwrite(issue.paths.slice());
        if (!approved || !owns()) return { status: 'cancelled', accepted };
      }
      const jobs = buildExportJobs(project, candidate);
      for (let index = 0; index < jobs.length; index++) {
        if (!owns()) return { status: 'cancelled', accepted };
        if (!receipt.matches(index)) continue;
        const job = jobs[index];
        const jobId = await desktop.exportVideo(targetReceipt ? { ...job, deliveryReceipt: targetReceipt.id, deliveryRequestId: requestId, deliveryRequestTicket:requestTicket } : job);
        if (!jobId) return { status: 'cancelled', accepted };
        accepted++;
        if (!owns()) return { status: 'cancelled', accepted };
        receipt.removeAccepted(index);
        publish({ jobId, name: job.defaultName });
      }
      return { status: 'submitted', accepted, complete: list.count() === 0 };
    } catch (error) {
      if (!owns()) return { status: 'cancelled', accepted };
      return { status: 'failed', accepted, error };
    } finally {
      unsubscribe();
      if (targetReceipt?.id && typeof desktop.releaseDeliveryTargets === 'function') {
        try { await desktop.releaseDeliveryTargets(targetReceipt.id); } catch (_) { /* 視窗關閉時由 main 清理。 */ }
      }
      if (requestId && requestTicket && typeof desktop.finishDeliveryTargetRequest === 'function') {
        try { await desktop.finishDeliveryTargetRequest(requestId,requestTicket); } catch (_) { /* sender 銷毀時由 main 清理。 */ }
      }
      if (activeRequest?.id === requestId && activeRequest?.ticket === requestTicket) activeRequest = null;
      busy = false;
      publish();
    }
  }

  return Object.freeze({ state, previewConflicts, invalidatePreview, submit, cancel });
}

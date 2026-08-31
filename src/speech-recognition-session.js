/* ==============================================================================
   SUB Tool — 語音辨識工作階段 (Speech Recognition Work Session)
   ==============================================================================
   這個 deep module 擁有單一辨識工作的 identity、取消／替換、合法狀態、
   多素材進度、文本匹配降級與 exactly-once 時間軸提交。UI 只觀察不可變快照。
   ============================================================================== */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'replaced']);
const listeners = new Set();
let activeRun = null;
let currentSnapshot = null;
let nextId = 1;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = clonePlain(nested);
  return copy;
}

function collectPrivateStrings(value, output, depth = 0) {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    if (value.length >= 4) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPrivateStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectPrivateStrings(nested, output, depth + 1);
  }
}

function redactPublicText(value, run) {
  let text = String(value ?? '');
  const marker = '[已隱藏敏感資訊]';
  const privateStrings = new Set();
  collectPrivateStrings(run?.spec?.apiKey, privateStrings);
  collectPrivateStrings(run?.spec?.transcript, privateStrings);
  collectPrivateStrings(run?.spec?.transcriptLines, privateStrings);
  collectPrivateStrings(run?.spec?.guidance, privateStrings);
  for (const clip of run?.spec?.clips || []) {
    collectPrivateStrings(clip?.path, privateStrings);
    collectPrivateStrings(clip?.web?.url, privateStrings);
    collectPrivateStrings(clip?.file?.path, privateStrings);
  }
  for (const secret of [...privateStrings].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(marker);
  }
  return text
    .replace(/\b[a-z]:[\\/][^\r\n"'<>|]*/giu, marker)
    .replace(/\\\\[^\\\s]+\\[^\r\n"'<>|]*/gu, marker)
    .replace(/https?:\/\/[^\s"'<>]+/giu, marker)
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|token|secret|authorization|bearer)[\s:=_-]*[a-z0-9][a-z0-9._~+/=-]{2,}/giu, marker);
}

function publicClip(clip = {}, run = null) {
  const result = {};
  for (const key of ['id', 'name', 'type', 'offset', 'start', 'in', 'out', 'dur', 'duration']) {
    if (clip[key] !== undefined) result[key] = key === 'name'
      ? redactPublicText(clip[key], run)
      : clip[key];
  }
  return deepFreeze(result);
}

function privateClip(clip = {}) {
  const copy = {
    ...clip,
    ...(clip.web ? { web: { ...clip.web } } : {}),
    ...(Array.isArray(clip.recognitionTracks)
      ? { recognitionTracks: clip.recognitionTracks.map(track => ({ ...track })) }
      : {})
  };
  return Object.freeze(copy);
}

function freezeWorkSpec(initData = {}) {
  const clips = Object.freeze((Array.isArray(initData.clips) ? initData.clips : []).map(privateClip));
  return Object.freeze({
    taskMode: initData.taskMode === 'align' ? 'align' : 'transcribe',
    provider: initData.provider || 'builtin',
    builtinModel: initData.builtinModel || '',
    language: initData.language || 'zh',
    timelineFps: Number(initData.timelineFps) || 24,
    timelineDropFrame: !!initData.timelineDropFrame,
    apiKey: typeof initData.apiKey === 'string' ? initData.apiKey : '',
    azureRegion: typeof initData.azureRegion === 'string' ? initData.azureRegion : '',
    clips,
    transcript: typeof initData.transcript === 'string' ? initData.transcript : '',
    transcriptLines: Object.freeze(Array.isArray(initData.transcriptLines) ? [...initData.transcriptLines] : []),
    recognitionSelection: deepFreeze(clonePlain(initData.recognitionSelection || 'all')),
    guidance: deepFreeze(clonePlain(initData.guidance || {}))
  });
}

function publicError(error, run) {
  if (!error) return null;
  return deepFreeze({
    name: redactPublicText(error.name || 'Error', run),
    message: redactPublicText(error.message || error, run)
  });
}

function makeSnapshot(run) {
  if (!run) return null;
  return deepFreeze({
    id: run.id,
    taskMode: run.spec.taskMode,
    provider: run.spec.provider,
    builtinModel: run.spec.builtinModel,
    language: run.spec.language,
    timelineFps: run.spec.timelineFps,
    timelineDropFrame: run.spec.timelineDropFrame,
    clips: Object.freeze(run.spec.clips.map(clip => publicClip(clip, run))),
    currentClipIndex: run.currentClipIndex,
    totalClips: run.spec.clips.length || 1,
    recognitionSelection: deepFreeze(clonePlain(run.spec.recognitionSelection)),
    progress: deepFreeze({
      ...run.progress,
      message: redactPublicText(run.progress.message, run),
      file: redactPublicText(run.progress.file, run)
    }),
    statusText: redactPublicText(run.statusText, run),
    error: publicError(run.error, run),
    dialogOpen: run.dialogOpen,
    diagnostic: run.diagnostic ? deepFreeze(clonePlain(run.diagnostic)) : null,
    recoveredAlignmentLineNumbers: Object.freeze([...run.quality.recoveredLineNumbers]),
    failedAlignmentLineNumbers: Object.freeze([...run.quality.untimedLineNumbers]),
    recoveredEstimatedLineCount: run.quality.estimatedLineCount,
    alignmentReviewCount: run.quality.reviewCount,
    alignmentProviderFailure: run.quality.providerFailure,
    alignmentQuality: run.quality.level,
    result: run.result ? deepFreeze(clonePlain(run.result)) : null,
    startTime: run.startTime
  });
}

function publish(run = activeRun) {
  currentSnapshot = makeSnapshot(run);
  for (const listener of listeners) {
    try {
      listener(currentSnapshot);
    } catch (error) {
      console.error('[ASR Session] Listener error:', error);
    }
  }
  return currentSnapshot;
}

function publishCleared() {
  currentSnapshot = null;
  for (const listener of listeners) {
    try {
      listener(null);
    } catch (error) {
      console.error('[ASR Session] Listener error:', error);
    }
  }
}

function isRunActive(id) {
  return !!(
    activeRun &&
    activeRun.id === id &&
    !activeRun.controller.signal.aborted &&
    !TERMINAL_STATUSES.has(activeRun.progress.status)
  );
}

function patchRun(id, patch) {
  if (!isRunActive(id)) return false;
  patch(activeRun);
  publish(activeRun);
  return true;
}

function setProgress(id, patch = {}) {
  return patchRun(id, run => {
    const previousPercent = Number.isFinite(run.progress.percent) ? run.progress.percent : null;
    const requestedPercent = Number.isFinite(patch.percent)
      ? Math.max(0, Math.min(100, patch.percent))
      : patch.percent;
    const percent = Number.isFinite(requestedPercent) && Number.isFinite(previousPercent)
      ? Math.max(previousPercent, requestedPercent)
      : requestedPercent;
    run.progress = {
      ...run.progress,
      ...patch,
      ...(percent !== undefined ? { percent } : {})
    };
    if (patch.message && !run.statusText) run.statusText = patch.message;
  });
}

function setStatus(id, statusText) {
  return patchRun(id, run => {
    run.statusText = String(statusText || '');
  });
}

function throwIfInactive(run) {
  if (!isRunActive(run.id)) {
    throw new DOMException('辨識工作已取消或被新工作取代', 'AbortError');
  }
}

function completeRun(id, result = {}) {
  if (!isRunActive(id)) return false;
  activeRun.result = {
    count: Number(result.count) || 0,
    quality: result.quality || activeRun.quality.level
  };
  activeRun.progress = {
    ...activeRun.progress,
    status: 'completed',
    percent: 100,
    indeterminate: false,
    message: '辨識完成'
  };
  activeRun.statusText = result.statusText || activeRun.statusText || '辨識完成';
  publish(activeRun);
  return true;
}

function failRun(id, error) {
  if (!isRunActive(id)) return false;
  activeRun.error = error;
  activeRun.progress = {
    ...activeRun.progress,
    status: 'failed',
    indeterminate: false,
    message: error?.message || '辨識失敗'
  };
  activeRun.statusText = `❌ 辨識失敗：${error?.message || String(error)}`;
  publish(activeRun);
  return true;
}

function providerProgress(run, clipIndex, info = {}) {
  if (!isRunActive(run.id)) return;
  const total = Math.max(1, run.spec.clips.length);
  const localRaw = Number.isFinite(info.percent)
    ? info.percent
    : (Number.isFinite(info.progress) ? info.progress : null);
  const local = localRaw == null ? null : Math.max(0, Math.min(100, localRaw));
  const measured = local != null && info.indeterminate !== true;
  const overall = measured ? Math.round(((clipIndex + (local / 100)) / total) * 90) : undefined;
  const message = info.message || (
    info.status === 'progress'
      ? `正在下載 AI 模型檔案 (${info.file || ''})…`
      : '本機 AI 正在推論…'
  );
  const status = info.status === 'progress' || info.status === 'loading'
    ? 'loading'
    : (info.status === 'transcribing' ? 'transcribing' : 'preparing');
  setProgress(run.id, {
    status,
    ...(overall !== undefined ? { percent: overall } : {}),
    indeterminate: overall === undefined,
    message,
    file: info.file || ''
  });
  setStatus(run.id, `[${clipIndex + 1}/${total}] ${message}`);
}

function alignmentLineNumbers(alignment, diagnostic) {
  if (Array.isArray(diagnostic?.unreliableLines)) {
    return diagnostic.unreliableLines
      .map(line => Number(line?.lineNumber))
      .filter(Number.isInteger);
  }
  const indexes = new Set([
    ...(alignment?.summary?.unmatchedLines || []),
    ...(alignment?.summary?.ambiguousLines || []),
    ...(alignment?.summary?.lowCoverageLines || [])
  ]);
  return [...indexes].filter(Number.isInteger).map(index => index + 1).sort((a, b) => a - b);
}

function recoveredLineNumbers(alignment) {
  return [...new Set([
    ...(alignment?.segments || []).flatMap((segment, index) => (
      segment?.alignment?.status === 'review' ? [index] : []
    )),
    ...(alignment?.summary?.estimatedLines || []),
    ...(alignment?.summary?.partialEvidenceLines || []),
    ...(alignment?.summary?.discontinuousEvidenceLines || [])
  ])].filter(Number.isInteger).sort((a, b) => a - b).map(index => index + 1);
}

function completionStatusText(spec, count, quality) {
  if (spec.taskMode !== 'align') return `語音辨識完成，已生成 ${count} 句字幕。`;
  if (quality.untimedLineNumbers.length) {
    const prefix = quality.providerFailure ? '聲音分析失敗，但' : '';
    return `${prefix}已建立 ${count} 句完整原稿；其中 ${quality.untimedLineNumbers.length} 句無時間碼。`;
  }
  if (quality.recoveredLineNumbers.length) {
    const estimate = quality.estimatedLineCount > 0
      ? `${quality.estimatedLineCount} 行使用推估時間`
      : '沒有整行使用推估時間';
    return `已建立 ${count} 句完整初稿；${estimate}，共 ${quality.recoveredLineNumbers.length} 行需人工校對。`;
  }
  return `文本匹配完成，已保留逐行文字稿並生成 ${count} 句時間碼。`;
}

async function executeAsrWork(run, adapters) {
  const results = [];
  try {
    if (typeof adapters.extractAudio !== 'function' || typeof adapters.transcribe !== 'function' || typeof adapters.commit !== 'function') {
      throw new TypeError('辨識工作缺少 extractAudio、transcribe 或 commit adapter');
    }
    if (run.spec.taskMode === 'align' && run.spec.clips.length !== 1) {
      throw new TypeError('文本匹配目前一次只能處理一個音訊來源');
    }

    for (let index = 0; index < run.spec.clips.length; index++) {
      throwIfInactive(run);
      const clip = run.spec.clips[index];
      patchRun(run.id, current => { current.currentClipIndex = index; });
      const extractMessage = `[${index + 1}/${run.spec.clips.length}] 正在萃取「${clip.name || '音訊素材'}」之音訊資料…`;
      setProgress(run.id, {
        status: 'extracting',
        indeterminate: true,
        message: extractMessage
      });
      setStatus(run.id, extractMessage);

      const audioBuffer = await adapters.extractAudio(clip, {
        signal: run.controller.signal,
        recognitionSelection: run.spec.recognitionSelection
      });
      throwIfInactive(run);
      const inT = Number(clip.in) || 0;
      const outT = (clip.out && clip.out > inT)
        ? clip.out
        : (inT + (Number(clip.dur ?? clip.duration) || Number(audioBuffer?.duration) || 0));

      let evidenceSegments;
      try {
        setProgress(run.id, {
          status: 'transcribing',
          indeterminate: true,
          message: '本機 AI 正在推論…'
        });
        setStatus(run.id, `[${index + 1}/${run.spec.clips.length}] 本機 AI 正在推論…`);
        evidenceSegments = await adapters.transcribe({
          clip,
          audioBuffer,
          inT,
          outT,
          spec: run.spec,
          signal: run.controller.signal,
          onProgress: info => providerProgress(run, index, info)
        });
      } catch (error) {
        if (run.spec.taskMode !== 'align' || run.controller.signal.aborted || error?.name === 'AbortError') throw error;
        console.error('文本匹配的聲音分析失敗，改建完整未定時原稿：', error);
        run.quality.providerFailure = true;
        evidenceSegments = [];
      }
      throwIfInactive(run);

      let segments = Array.isArray(evidenceSegments) ? evidenceSegments : [];
      if (run.spec.taskMode === 'align') {
        setProgress(run.id, {
          status: 'aligning',
          percent: Math.round(((index + 0.95) / Math.max(1, run.spec.clips.length)) * 90),
          indeterminate: false,
          message: '聲音分析完成，正在逐行匹配文字稿時間…'
        });
        setStatus(run.id, '聲音分析完成，正在逐行匹配文字稿時間…');
        const resolved = await adapters.resolveAlignment?.({
          taskMode: run.spec.taskMode,
          transcript: run.spec.transcript,
          evidenceSegments: segments
        });
        throwIfInactive(run);
        const alignment = resolved?.alignment || null;
        segments = resolved?.segments || segments;
        if (alignment) {
          let diagnostic = null;
          if (alignment.status === 'failed' || alignment.status === 'recovered') {
            diagnostic = await adapters.buildDiagnostic?.({
              provider: run.spec.provider,
              language: run.spec.language,
              audioSelection: run.spec.recognitionSelection,
              transcript: run.spec.transcript,
              evidenceSegments,
              alignmentResult: alignment
            }) || null;
            throwIfInactive(run);
            run.diagnostic = diagnostic;
          }
          if (alignment.status === 'failed') {
            run.quality.untimedLineNumbers = alignmentLineNumbers(alignment, diagnostic);
            run.quality.level = 'untimed';
          } else if (alignment.status === 'recovered') {
            run.quality.recoveredLineNumbers = recoveredLineNumbers(alignment);
            run.quality.estimatedLineCount = (alignment.summary?.estimatedLines || []).length;
            run.quality.level = 'review';
          }
          run.quality.reviewCount += Number(alignment.summary?.reviewCount) || 0;
          segments = alignment.completeSegments || alignment.segments || segments;
          publish(run);
        }
      }

      results.push({ clip, segments });
      setProgress(run.id, {
        status: 'transcribing',
        percent: Math.round(((index + 1) / Math.max(1, run.spec.clips.length)) * 90),
        indeterminate: false,
        message: `[${index + 1}/${run.spec.clips.length}] 音訊分析完成`
      });
    }

    throwIfInactive(run);
    const commitMessage = run.spec.taskMode === 'align'
      ? '文本匹配完成，正在寫入專屬字幕軌…'
      : '辨識完成，正在寫入專屬字幕軌…';
    setProgress(run.id, {
      status: 'committing',
      percent: 95,
      indeterminate: false,
      message: commitMessage
    });
    setStatus(run.id, commitMessage);
    throwIfInactive(run);
    const committed = await adapters.commit(results, {
      signal: run.controller.signal,
      taskMode: run.spec.taskMode,
      timelineFps: run.spec.timelineFps,
      timelineDropFrame: run.spec.timelineDropFrame,
      quality: clonePlain(run.quality),
      diagnostic: run.diagnostic
    });
    throwIfInactive(run);

    const commitResult = typeof committed === 'number' ? { count: committed } : (committed || {});
    if (Array.isArray(commitResult.timelineRejectedLineNumbers) && commitResult.timelineRejectedLineNumbers.length) {
      run.quality.untimedLineNumbers = [...new Set([
        ...run.quality.untimedLineNumbers,
        ...commitResult.timelineRejectedLineNumbers
      ])].sort((a, b) => a - b);
      run.quality.level = 'untimed';
    }
    const outcome = {
      status: 'completed',
      count: Number(commitResult.count) || 0,
      results,
      diagnostic: run.diagnostic,
      quality: clonePlain(run.quality)
    };
    completeRun(run.id, {
      ...outcome,
      statusText: completionStatusText(run.spec, outcome.count, run.quality)
    });
    return outcome;
  } catch (error) {
    if (run.controller.signal.aborted || error?.name === 'AbortError' || activeRun?.id !== run.id) {
      return { status: run.cancelReason || (activeRun?.id === run.id ? 'cancelled' : 'replaced'), count: 0 };
    }
    failRun(run.id, error);
    throw error;
  }
}

/** 取得目前工作的不可變且已去敏快照。 */
export function getAsrSession() {
  return currentSnapshot;
}

/** 訂閱快照；listener 永遠不會拿到 controller、API key 或素材路徑。 */
export function onAsrSessionChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 建立工作 identity；只供完整 startAsrWork 入口使用。 */
function startAsrSession(initData = {}) {
  if (activeRun && !activeRun.controller.signal.aborted && !TERMINAL_STATUSES.has(activeRun.progress.status)) {
    activeRun.cancelReason = 'replaced';
    activeRun.controller.abort();
  }
  const controller = initData.controller || new AbortController();
  const spec = freezeWorkSpec(initData);
  activeRun = {
    id: `asr-${Date.now()}-${nextId++}`,
    controller,
    spec,
    currentClipIndex: 0,
    progress: {
      status: 'preparing',
      percent: null,
      indeterminate: true,
      message: '正在準備音訊並進行分析…',
      file: ''
    },
    statusText: '正在準備音訊並進行分析…',
    error: null,
    dialogOpen: initData.dialogOpen !== false,
    diagnostic: null,
    quality: {
      level: 'reliable',
      recoveredLineNumbers: [],
      untimedLineNumbers: [],
      estimatedLineCount: 0,
      reviewCount: 0,
      providerFailure: false
    },
    result: null,
    cancelReason: null,
    startTime: Date.now()
  };
  return publish(activeRun);
}

/** 啟動完整辨識工作；module 擁有 orchestration、取消與 exactly-once commit。 */
export function startAsrWork(initData = {}, adapters = {}) {
  const snapshot = startAsrSession(initData);
  const run = activeRun;
  const promise = executeAsrWork(run, adapters);
  return Object.freeze({
    id: snapshot.id,
    promise,
    cancel: () => cancelActiveAsrSession(snapshot.id)
  });
}

export function setAsrSessionDialogOpen(dialogOpen, expectedId = null) {
  if (!activeRun || (expectedId && activeRun.id !== expectedId)) return false;
  activeRun.dialogOpen = !!dialogOpen;
  publish(activeRun);
  return true;
}

export function cancelActiveAsrSession(expectedId = null) {
  if (!activeRun || (expectedId && activeRun.id !== expectedId)) return null;
  const run = activeRun;
  run.cancelReason = 'cancelled';
  if (!run.controller.signal.aborted) run.controller.abort();
  run.progress = {
    ...run.progress,
    status: 'cancelled',
    indeterminate: false,
    message: '辨識已取消'
  };
  run.statusText = '辨識已取消';
  const cancelled = publish(run);
  activeRun = null;
  publishCleared();
  return cancelled;
}

export function clearAsrSession(expectedId = null) {
  if (expectedId && activeRun?.id !== expectedId) return false;
  if (activeRun && !activeRun.controller.signal.aborted && !TERMINAL_STATUSES.has(activeRun.progress.status)) {
    activeRun.cancelReason = 'cancelled';
    activeRun.controller.abort();
  }
  activeRun = null;
  publishCleared();
  return true;
}

/* ==============================================================================
   SUB Tool — Media Intake Engine ("src/media-intake-engine.js")
   ==============================================================================
   深層媒體素材導入與工作階段引擎 (Media Intake Engine)。
   負責母素材載入工作階段、所有權追蹤與來源指紋租約管理：
   1. 素材來源指紋與存續追蹤 (clipSourceFingerprint / liveClipForSource / clipSourceStillReferenced)
   2. 媒體工作階段與排他性執行緒控制 (MediaIntakeSession)
   3. 異步中繼資料就緒輪詢與競態取消 (waitForOwnedMediaMetadata)
   ============================================================================== */

/**
 * 根據素材片段計算穩定的來源指紋（Fingerprint）。
 * 分割後的片段共享相同的音訊來源與定位位址。
 */
export function clipSourceFingerprint(clip) {
  if (!clip || typeof clip !== 'object') return '';
  const sourceId = clip.audioSourceId ?? clip.audioSrc ?? (clip.primary ? 'video' : `clip:${clip.id ?? ''}`);
  const locator = clip.path ?? clip.web?.url ?? '';
  return `${String(sourceId ?? '')}\u0000${String(locator)}`;
}

/**
 * 依據來源指紋找出目前專案中存活的素材實體。
 */
export function liveClipForSource(clips, sourceClip) {
  const fingerprint = clipSourceFingerprint(sourceClip);
  if (!fingerprint || !Array.isArray(clips)) return null;
  return clips.find(clip => clipSourceFingerprint(clip) === fingerprint) || null;
}

/**
 * 檢查該來源指紋是否仍被任何時間軸素材引用。
 */
export function clipSourceStillReferenced(clips, sourceClip) {
  return !!liveClipForSource(clips, sourceClip);
}

function disposeAudioElements(elements) {
  for (const element of (Array.isArray(elements) ? elements : [])) {
    if (!element) continue;
    try { element.pause?.(); } catch { /* 已失效的 element 不影響清理 */ }
    try { element.src = ''; } catch { /* 同上 */ }
  }
}

function waitForMetadata(element, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(element);
    };
    const timer = setTimeout(finish, timeoutMs);
    element.onloadedmetadata = finish;
    element.onerror = finish;
    if (element.readyState >= 1) finish();
  });
}

/**
 * 等待媒體元素載入中繼資料，並在工作階段失去所有權時安全取消。
 */
export function waitForOwnedMediaMetadata(element, {
  owns = () => true,
  timeoutMs = 10000,
  pollMs = 25,
} = {}) {
  const stillOwns = typeof owns === 'function' ? owns : () => true;
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let poll = null;
    const remove = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      element?.removeEventListener?.('loadedmetadata', onMetadata);
      element?.removeEventListener?.('error', onError);
    };
    const finish = outcome => {
      if (settled) return;
      settled = true;
      remove();
      resolve(outcome);
    };
    const check = () => {
      if (!stillOwns()) finish('cancelled');
      else if (Number(element?.readyState) >= 1) finish('ready');
    };
    const onMetadata = () => finish(stillOwns() ? 'ready' : 'cancelled');
    const onError = () => finish(stillOwns() ? 'error' : 'cancelled');

    element?.addEventListener?.('loadedmetadata', onMetadata, { once: true });
    element?.addEventListener?.('error', onError, { once: true });
    timer = setTimeout(() => finish(stillOwns() ? 'timeout' : 'cancelled'), Math.max(1, timeoutMs));
    poll = setInterval(check, Math.max(1, pollMs));
    check();
  });
}

export class MediaIntakeSession {
  constructor() {
    this.generation = 0;
    this.current = null;
    this._exclusiveTail = Promise.resolve();
  }

  begin(identity = null) {
    const token = Object.freeze({ generation: ++this.generation, identity });
    this.current = token;
    return token;
  }

  invalidate() {
    this.generation++;
    this.current = null;
  }

  owns(token) {
    return !!token && this.current === token && token.generation === this.generation;
  }

  queueExclusive(work) {
    const run = () => work();
    const result = this._exclusiveTail.then(run, run);
    this._exclusiveTail = result.then(() => undefined, () => undefined);
    return result;
  }

  runExclusive(token, work) {
    return this.queueExclusive(() => this.owns(token) ? work() : null);
  }

  async materializeAudioElements(channels, {
    token = null,
    owns = token ? () => this.owns(token) : () => true,
    resolveFileURL,
    createAudio,
    timeoutMs = 10000,
  } = {}) {
    const list = Array.isArray(channels) ? channels : [];
    if (!owns()) return null;

    const outcomes = await Promise.all(list.map(async channel => {
      try {
        const url = await resolveFileURL(channel.file);
        if (!owns()) return { element: null, error: null };
        const element = createAudio();
        element.src = url;
        element.preload = 'auto';
        return { element: await waitForMetadata(element, timeoutMs), error: null };
      } catch (error) {
        return { element: null, error };
      }
    }));
    const elements = outcomes.map(outcome => outcome.element);
    const failure = outcomes.find(outcome => outcome.error)?.error;
    if (failure || !owns()) {
      disposeAudioElements(elements);
      if (failure) throw failure;
      return null;
    }
    return elements;
  }
}

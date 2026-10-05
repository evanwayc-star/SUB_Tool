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

/** ffprobe 的 stream/channel 清單轉為來源聲道座標，供所有載入路徑共用。 */
export function probeAudioChannelDescriptors(audio) {
  const out = [];
  (audio || []).forEach((stream, sourceStream) => {
    const count = Math.max(0, Math.floor(Number(stream?.channels) || 0));
    for (let sourceChannel = 0; sourceChannel < count; sourceChannel++) {
      out.push({ sourceStream, sourceChannel });
    }
  });
  return out;
}

// 母素材的完整長度不能被尚在生成中的 Proxy 或播放器暫時 metadata 縮短。
export function maxKnownSourceDuration(...durations) {
  return Math.max(0, ...durations.map(value => {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }));
}

function disposeAudioElements(elements) {
  for (const element of (Array.isArray(elements) ? elements : [])) {
    if (!element) continue;
    try { element.pause?.(); } catch { /* 已失效的 element 不影響清理 */ }
    try { element.src = ''; } catch { /* 同上 */ }
  }
}

/**
 * 等待媒體元素載入中繼資料，並在工作階段失去所有權時安全取消。
 */
export function waitForOwnedMediaMetadata(element, {
  owns = () => true,
  timeoutMs = 10000,
  pollMs = 25,
  signal = null,
} = {}) {
  const stillOwns = typeof owns === 'function' ? owns : () => true;
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let poll = null;
    const eventAdapter=typeof element?.addEventListener==='function';
    const previousMetadata=element?.onloadedmetadata;
    const previousError=element?.onerror;
    const remove = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      signal?.removeEventListener('abort',onAbort);
      if(eventAdapter){
        element.removeEventListener?.('loadedmetadata',onMetadata);
        element.removeEventListener?.('error',onError);
      }else if(element){
        if(element.onloadedmetadata===onMetadata) element.onloadedmetadata=previousMetadata;
        if(element.onerror===onError) element.onerror=previousError;
      }
    };
    const finish = outcome => {
      if (settled) return;
      settled = true;
      remove();
      resolve(outcome);
    };
    const check = () => {
      if (signal?.aborted||!stillOwns()) finish('cancelled');
      else if (Number(element?.readyState) >= 1) finish('ready');
    };
    const onMetadata = () => finish(stillOwns() ? (Number(element?.readyState)>=1?'ready':'error') : 'cancelled');
    const onError = () => finish(stillOwns() ? 'error' : 'cancelled');
    const onAbort=()=>finish('cancelled');

    if(eventAdapter){
      element.addEventListener('loadedmetadata',onMetadata,{once:true});
      element.addEventListener('error',onError,{once:true});
    }else if(element){
      element.onloadedmetadata=onMetadata;
      element.onerror=onError;
    }
    signal?.addEventListener('abort',onAbort,{once:true});
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
    const controller = new AbortController();
    const created = [];
    let failure = null;
    let resolveCancellation;
    const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
    const stillOwns = () => owns() && !controller.signal.aborted;
    const cancel = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      disposeAudioElements(created);
      resolveCancellation(null);
    };
    // The group owns URL resolution as well as metadata. A channel still waiting
    // for IPC must not keep ready siblings alive after replacement or failure.
    const poll = setInterval(() => { if (!owns()) cancel(); }, 25);
    const timer = setTimeout(() => {
      if (owns()) failure = new Error('音訊 metadata 讀取逾時');
      cancel();
    }, Math.max(1, timeoutMs));
    const materializing = Promise.all(list.map(async channel => {
      let element = null;
      try {
        const url = await resolveFileURL(channel.file);
        if (!stillOwns()) return { element: null, error: null };
        element = createAudio();
        created.push(element);
        element.src = url;
        element.preload = 'auto';
        const outcome=await waitForOwnedMediaMetadata(element,{owns:stillOwns,timeoutMs,signal:controller.signal});
        if(outcome==='cancelled'){cancel();return {element:null,error:null};}
        if(outcome!=='ready') throw new Error(outcome==='timeout'?'音訊 metadata 讀取逾時':'音訊 metadata 讀取失敗');
        return { element, error: null };
      } catch (error) {
        if(owns()&&!controller.signal.aborted) failure=error;
        cancel();
        return { element: null, error };
      }
    }));
    const outcomes = await Promise.race([materializing, cancellation]);
    clearInterval(poll);
    clearTimeout(timer);
    if (!outcomes) {
      if (failure && owns()) throw failure;
      return null;
    }
    const elements = outcomes.map(outcome => outcome.element);
    if (failure || !owns() || controller.signal.aborted) {
      cancel();
      if (failure&&owns()) throw failure;
      return null;
    }
    return elements;
  }
}

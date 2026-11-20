/* 音訊效果工作：來源身分、最後操作優先、準備／提交及重建共用同一個生命週期。
   不持有 DOM 或播放器；正式與測試呼叫端跨相同 interface。 */
import { audioLimiterSnapshot, audioMotherPath, normalizeAudioLimiterSpec, restoreAudioLimiterState } from '../shared/audio-loudness.cjs';

const keyOf = source => source?.audioSourceId || source?.audioSrc || source?.id || audioMotherPath(source);
const fingerprint = (source, spec, layout) => JSON.stringify([audioMotherPath(source), spec, layout]);
let nextWorkId = 0;

export function createAudioEffects({ sources, process, prepare, install, fingerprintSource, sourceLayout = () => '', discardResult = () => {}, isInstalled = () => true, changed = () => {}, record = () => {}, failed = () => {} }) {
  const jobs = new Map();
  const installed = new Map();
  const retainedPreviews = new Map();
  const cache = new Map();
  const failures = new Map();
  const intents = new Map();
  let epoch = 0;
  function releasePreview(key){
    const result=retainedPreviews.get(key);
    if(!result)return;
    retainedPreviews.delete(key);
    Promise.resolve(discardResult(result)).catch(()=>{});
  }

  function publish(change = {}) {
    const active = [...jobs.values()].filter(job => job.progress).map(job => ({ ...job.progress }));
    changed({ active, ...change });
  }

  function targets(input) {
    const all = sources();
    const raw = input?.target || input?.asset || input?.source || input;
    const id = input?.audioSourceId || input?.id || input?.assetId || input?.sourceId;
    const source = all.find(s => s === raw)
      || all.find(s => [s.audioSourceId, s.id, s.audioSrc, s.source].filter(Boolean).includes(id))
      || ((input?.isPrimary || id === 'video') ? all.find(s => s.primary) : null)
      || (!id ? all.find(s => audioMotherPath(s) === audioMotherPath(raw)) : null);
    return source ? all.filter(s => keyOf(s) === keyOf(source)) : [];
  }

  function pendingSettings(input) {
    const job = jobs.get(keyOf(targets(input)[0]));
    return job?.owns() ? structuredClone(job.settings) : undefined;
  }

  function cancel(key, expected = null) {
    const job = jobs.get(key);
    if (!job || (expected && job !== expected)) return;
    jobs.delete(key);
    // 運算期間切分出的片段也會收到進度；即使隨後移除，仍由原工作清理。
    for (const target of job.progressTargets) {
      delete target.audioNormalizing;
      delete target.audioNormalizeProgress;
      delete target.audioNormalizeLabel;
    }
    job.controller.abort();
  }

  function apply(input, options, flags) {
    // 第一次進度通知會同步呼叫訂閱者；先建立可共用的 Promise 再啟動工作。
    const completion = Promise.withResolvers();
    completion.resolve(startOrJoin(input, options, flags, completion.promise));
    return completion.promise;
  }

  async function startOrJoin(input, options, { remember = true } = {}, completion) {
    const initial = targets(input);
    const source = initial[0];
    if (!source || !audioMotherPath(source)) return { status: 'replaced' };
    const key = keyOf(source);
    const motherPath = audioMotherPath(source);
    const name = source.name || motherPath.split(/[\\/]/).pop() || '音訊素材';
    const spec = normalizeAudioLimiterSpec(options);
    const layout = sourceLayout(source);
    const stamp = fingerprint(source, spec, layout);
    const previous = jobs.get(key);
    if (previous?.stamp === stamp && previous.owns()) {
      previous.remember ||= remember;
      return previous.completion;
    }
    const intent = ++nextWorkId, startEpoch = epoch;
    intents.set(key, intent);
    cancel(key);
    if (intents.get(key) !== intent || epoch !== startEpoch) {
      if (intents.get(key) === intent) intents.delete(key);
      return { status: 'replaced' };
    }
    failures.delete(key);
    const job = { id: `audiofx-${Date.now()}-${intent}`, controller: new AbortController(), progressTargets: new Set(initial),
      epoch, intent, source, spec, remember, layout, stamp, completion, settings: structuredClone(options ?? null) };
    jobs.set(key, job);
    const ownsSource = () => jobs.get(key) === job && job.epoch === epoch && !job.controller.signal.aborted
      && sources().some(s => initial.includes(s) && keyOf(s) === key && audioMotherPath(s) === motherPath);
    const owns = () => ownsSource() && sourceLayout(source) === layout;
    job.owns = owns;
    job.ownsSource = ownsSource;
    const progress = data => {
      if (!owns()) return;
      const pct = Math.max(0, Math.min(99, Math.round(Number(data.pct) || 0)));
      const label = String(data.label || '音訊平衡');
      let needsUpdate = job.progress?.pct !== pct || job.progress?.label !== label;
      job.progress = { sourceId: key, name, pct, label };
      for (const target of targets(source)) {
        if (!target.audioNormalizing) needsUpdate = true;
        job.progressTargets.add(target);
        target.audioNormalizing = true;
        target.audioNormalizeProgress = pct;
        target.audioNormalizeLabel = label;
      }
      if (needsUpdate) publish();
    };
    progress({ pct: 0, label: spec ? '準備運算…' : '還原原音…' });
    let prepared, result, outcome, discardable = false;
    const preparePlayback = () => {
      progress({ pct: spec ? 90 : 0, label: spec ? '準備預聽與波形' : '還原原音' });
      return owns() ? prepare(source, result, owns, progress) : null;
    };
    try {
      if (!owns()) return { status: 'replaced' };
      const work = { id: job.id, signal: job.controller.signal, progress, owns };
      let cached = spec && typeof fingerprintSource === 'function' ? cache.get(stamp) : null;
      if (cached) {
        let evidence;
        try { evidence = await fingerprintSource(motherPath); } catch { /* 無法核對時以母素材重建。 */ }
        if (!owns()) return { status: 'replaced' };
        if (evidence !== cached.sourceFingerprint) cached = null;
      }
      if (spec && cached) result = cached.result;
      else if (spec) { result = await process(source, spec, work); discardable = !!result; }
      else result = null;
      if (!owns()) return { status: 'replaced' };
      try { prepared = await preparePlayback(); }
      catch (error) {
        if (!cached || !owns()) throw error;
        // 快取可被清理；Redo 仍以母素材重建，不能把失效路徑當成專案內容。
        cache.delete(stamp);
        cached = null;
        result = await process(source, spec, work);
        discardable = !!result;
        if (!owns()) return { status: 'replaced' };
        prepared = await preparePlayback();
      }
      const finalSpec = result?.spec || spec;
      if (!owns()) { prepared?.dispose?.(); return { status: 'replaced' }; }
      const sourceFingerprint = cached?.sourceFingerprint || result?.sourceFingerprint;
      if (sourceFingerprint && typeof fingerprintSource === 'function') {
        const evidence = await fingerprintSource(motherPath);
        if (!owns()) { prepared?.dispose?.(); return { status: 'replaced' }; }
        if (evidence !== sourceFingerprint) throw new Error('母素材已變更，請重新執行音訊平衡');
      }
      // 從安裝開始，播放端可能同步接手輸出，不再由未交接工作清理。
      install(source, prepared, finalSpec);
      discardable = false;
      releasePreview(key);
      if(result?.persistent)retainedPreviews.set(key,result);
      if (!owns()) return { status: 'replaced' };
      for (const target of targets(source)) {
        // 舊版外部素材曾以快取覆寫 path；母素材永遠保留在正式欄位。
        target.path = audioMotherPath(target);
        delete target._originalPath;
        restoreAudioLimiterState(target, finalSpec ? { audioLimiterSpec: finalSpec } : null);
        if (result?.outputPath) target.normalizedAudioPath = result.outputPath;
        else delete target.normalizedAudioPath;
      }
      if (result && !result.persistent && sourceFingerprint && typeof fingerprintSource === 'function') {
        const entry = { result, sourceFingerprint };
        cache.set(stamp, entry);
        cache.set(fingerprint(source, finalSpec, layout), entry);
      }
      installed.set(key, fingerprint(source, finalSpec, layout));
      publish({ committed: true });
      if (job.remember && owns()) record(spec ? `音訊平衡：${finalSpec.max} dB` : '還原原始音訊');
      outcome = { status: spec ? 'completed' : 'restored', name };
      return { status: 'completed' };
    } catch (error) {
      prepared?.dispose?.();
      if (!owns()) return { status: 'replaced' };
      failures.set(key, stamp);
      outcome = { status: 'failed', name, detail: error?.message || String(error) };
      failed(error);
      return { status: 'failed', error };
    } finally {
      if (jobs.get(key) === job) { cancel(key); publish(outcome ? { result: outcome } : {}); }
      if (intents.get(key) === intent) intents.delete(key);
      if (discardable) { try { await discardResult(result); } catch (_) {} }
    }
  }

  function sync() {
    const live = new Map(sources().map(s => [keyOf(s), s]));
    for(const key of retainedPreviews.keys())if(!live.has(key))releasePreview(key);
    for (const [key, job] of [...jobs]) {
      if (live.has(key) && job.owns()) continue;
      const restart=live.has(key) && job.ownsSource() && sourceLayout(job.source)!==job.layout;
      cancel(key,job);
      if(restart && !jobs.has(key) && intents.get(key)===job.intent && sources().includes(job.source)) {
        void apply(job.source,job.spec,{remember:job.remember});
      } else publish();
    }
    for (const [key, source] of live) {
      const current = () => sources().includes(source) && keyOf(source) === key;
      if (!current()) continue;
      if (jobs.has(key)) continue;
      const spec = audioLimiterSnapshot(source).audioLimiterSpec || null;
      const stamp = fingerprint(source, spec, sourceLayout(source));
      if (failures.get(key) === stamp) continue;
      if (((spec && (installed.get(key) !== stamp || !isInstalled(source))) || (!spec && installed.has(key) && installed.get(key) !== stamp)) && current()) {
        void apply(source, spec, { remember: false });
      }
    }
  }

  function invalidate({ clear = false } = {}) {
    epoch++;
    failures.clear();
    if (clear) {
      for(const key of retainedPreviews.keys())releasePreview(key);
      installed.clear(); cache.clear();
    }
    const previousJobs = [...jobs];
    for (const [key, job] of previousJobs) cancel(key, job);
    if (previousJobs.length) publish();
  }
  return { targets, pendingSettings, apply, sync, invalidate };
}

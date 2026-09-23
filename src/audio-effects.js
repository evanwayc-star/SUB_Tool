/* 音訊效果工作：來源身分、最後操作優先、準備／提交及重建共用同一個生命週期。
   不持有 DOM 或播放器；正式與測試呼叫端跨相同 interface。 */
import { audioLimiterSnapshot, audioMotherPath, normalizeAudioLimiterSpec, restoreAudioLimiterState } from '../shared/audio-loudness.cjs';

const keyOf = source => source?.audioSourceId || source?.audioSrc || source?.id || audioMotherPath(source);
const fingerprint = (source, spec) => JSON.stringify([audioMotherPath(source), spec]);
let nextWorkId = 0;

export function createAudioEffects({ sources, process, prepare, install, isInstalled = () => true, changed = () => {}, record = () => {}, failed = () => {} }) {
  const jobs = new Map();
  const installed = new Map();
  const cache = new Map();
  const failures = new Map();
  let epoch = 0;

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

  function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    jobs.delete(key);
    job.controller.abort();
    for (const target of job.targets) {
      delete target.audioNormalizing;
      delete target.audioNormalizeProgress;
      delete target.audioNormalizeLabel;
    }
  }

  async function apply(input, options, { remember = true } = {}) {
    const initial = targets(input);
    const source = initial[0];
    if (!source || !audioMotherPath(source)) return { status: 'replaced' };
    const key = keyOf(source);
    const motherPath = audioMotherPath(source);
    cancel(key);
    failures.delete(key);
    const spec = normalizeAudioLimiterSpec(options);
    const stamp = fingerprint(source, spec);
    const job = { id: `audiofx-${Date.now()}-${++nextWorkId}`, controller: new AbortController(), targets: initial, epoch };
    jobs.set(key, job);
    const owns = () => jobs.get(key) === job && job.epoch === epoch && !job.controller.signal.aborted
      && sources().some(s => initial.includes(s) && keyOf(s) === key && audioMotherPath(s) === motherPath);
    const progress = data => {
      if (!owns()) return;
      for (const target of targets(source)) {
        target.audioNormalizing = true;
        target.audioNormalizeProgress = Math.max(0, Math.min(100, Number(data.pct) || 0));
        target.audioNormalizeLabel = String(data.label || '音訊平衡');
      }
      changed();
    };
    progress({ pct: 0, label: spec ? '準備運算…' : '還原原音…' });
    let prepared;
    try {
      const work = { id: job.id, signal: job.controller.signal, progress };
      const cached = spec && cache.get(stamp);
      let result = spec ? (cached || await process(source, spec, work)) : null;
      if (!owns()) return { status: 'replaced' };
      try { prepared = await prepare(source, result, owns); }
      catch (error) {
        if (!cached || !owns()) throw error;
        // 快取可被清理；Redo 仍以母素材重建，不能把失效路徑當成專案內容。
        cache.delete(stamp);
        result = await process(source, spec, work);
        if (!owns()) return { status: 'replaced' };
        prepared = await prepare(source, result, owns);
      }
      const finalSpec = result?.spec || spec;
      if (!owns()) { prepared?.dispose?.(); return { status: 'replaced' }; }
      install(source, prepared, finalSpec);
      for (const target of targets(source)) {
        // 舊版外部素材曾以快取覆寫 path；母素材永遠保留在正式欄位。
        target.path = audioMotherPath(target);
        delete target._originalPath;
        restoreAudioLimiterState(target, finalSpec ? { audioLimiterSpec: finalSpec } : null);
        if (result?.outputPath) target.normalizedAudioPath = result.outputPath;
        else delete target.normalizedAudioPath;
      }
      if (result) {
        cache.set(stamp, result);
        cache.set(fingerprint(source, finalSpec), result);
      }
      installed.set(key, fingerprint(source, finalSpec));
      changed({ committed: true });
      if (remember) record(spec ? `音訊平衡：${finalSpec.max} dB` : '還原原始音訊');
      return { status: 'completed' };
    } catch (error) {
      prepared?.dispose?.();
      if (!owns()) return { status: 'replaced' };
      failures.set(key, stamp);
      failed(error);
      return { status: 'failed', error };
    } finally {
      if (jobs.get(key) === job) { cancel(key); changed(); }
    }
  }

  function sync() {
    const live = new Map(sources().map(s => [keyOf(s), s]));
    for (const key of jobs.keys()) if (!live.has(key)) cancel(key);
    for (const [key, source] of live) {
      if (jobs.has(key)) continue;
      const spec = audioLimiterSnapshot(source).audioLimiterSpec || null;
      const stamp = fingerprint(source, spec);
      if (failures.get(key) === stamp) continue;
      if ((spec && (installed.get(key) !== stamp || !isInstalled(source))) || (!spec && installed.has(key) && installed.get(key) !== stamp)) {
        void apply(source, spec, { remember: false });
      }
    }
  }

  function invalidate({ clear = false } = {}) {
    epoch++;
    for (const key of [...jobs.keys()]) cancel(key);
    failures.clear();
    if (clear) { installed.clear(); cache.clear(); }
  }
  return { targets, apply, sync, invalidate };
}

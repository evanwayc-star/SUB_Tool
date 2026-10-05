import { afterEach, expect, it, vi } from 'vitest';
import { VocalWaveformCache, vocalCacheDescriptor, vocalPeakLength } from '../src/vocal-waveform-cache.js';

const descriptor = (id = 1, duration = 1, streams = [0]) => vocalCacheDescriptor(id.toString(16).padStart(64, '0'), duration, streams);
const peaks = (duration = 1) => {
  const result = new Float32Array(vocalPeakLength(duration));
  for (let i = 0; i < result.length; i += 2) { result[i] = -.25; result[i + 1] = .5; }
  return result;
};

// Exercise the production cache policy with independently owned persisted records.
function memoryCache(options = {}, records = new Map()) {
  const cache = new VocalWaveformCache(options);
  cache.transaction = async (_mode, run) => new Promise((resolve, reject) => {
    let pending = 0, result = null;
    const request = value => {
      const operation = { result: structuredClone(value) }; pending++;
      queueMicrotask(() => {
        try { operation.onsuccess?.(); }
        catch (error) { reject(error); }
        finally { if (!--pending) resolve(result); }
      });
      return operation;
    };
    const store = {
      get: key => request(records.get(key)), getAll: () => request([...records.values()]),
      put: record => records.set(record.key, structuredClone(record)), delete: key => records.delete(key),
    };
    run(store, value => { result = value; });
    if (!pending) resolve(result);
  });
  return { cache, records };
}

function preferencesStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), values };
}

afterEach(() => vi.restoreAllMocks());

it('完整峰值校驗後持久保存，重建cache instance及重新選擇不需要分析', async () => {
  const { cache, records } = memoryCache();
  const original = peaks(); expect(await cache.write(descriptor(), 1, original)).toBe(true);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toBeNull();
  expect(await cache.select(descriptor(), true)).toBe(true);
  original[0] = -5;
  const reopened = memoryCache({}, records).cache;
  const restored = await reopened.read(descriptor(), 1, { selectedOnly: true });
  expect(restored[0]).toBe(-.25); expect(restored[1]).toBe(.5);
  restored[0] = -6; expect((await reopened.read(descriptor(), 1))[0]).toBe(-.25);
  await reopened.select(descriptor(), false);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toBeNull();
  expect(await cache.read(descriptor(), 1)).toHaveLength(200);
});

it.each(['hash', 'nan', 'length', 'range', 'descriptor'])('毀損的 %s cache不能恢復有效人聲結果', async corruption => {
  const { cache, records } = memoryCache();
  await cache.write(descriptor(), 1, peaks()); await cache.select(descriptor(), true);
  const record = [...records.values()][0];
  if (corruption === 'hash') new Float32Array(record.bytes)[0] = -.125;
  if (corruption === 'nan') new Float32Array(record.bytes)[0] = NaN;
  if (corruption === 'length') record.bytes = record.bytes.slice(0, 4);
  if (corruption === 'range') new Float32Array(record.bytes)[0] = 999;
  if (corruption === 'descriptor') record.descriptor = descriptor(2);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toBeNull();
});

it('拒絕半成品、非有限、顛倒範圍與異常振幅，無cache不創造假偏好', async () => {
  const { cache, records } = memoryCache();
  for (const bad of [new Float32Array(2), new Float32Array(200).fill(NaN), new Float32Array(200).fill(1), new Float32Array(200).fill(-99)])
    expect(await cache.write(descriptor(), 1, bad)).toBe(false);
  expect(await cache.select(descriptor(), true)).toBe(false); expect(records.size).toBe(0);
});

it('模型算法時長與streams均在descriptor中；fractional seconds沿用實際sample格網', () => {
  expect(new Set([descriptor(), descriptor(2), descriptor(1, 2), descriptor(1, 1, [1])]).size).toBe(4);
  expect(descriptor(1, 1, [2, 0, 2])).toBe(descriptor(1, 1, [0, 2]));
  expect(vocalCacheDescriptor('path-only', 1, [0])).toBeNull();
  expect(vocalCacheDescriptor('a'.repeat(64), Infinity, [0])).toBeNull();
  expect(vocalCacheDescriptor('a'.repeat(64), 1, [256])).toBeNull();
  expect(vocalPeakLength(30.07)).toBe(6014);
});

it('讀取更新最近存取，超過entry數淘汰最久未用且受bytes限額控制', async () => {
  let timestamp = 1; vi.spyOn(Date, 'now').mockImplementation(() => timestamp++);
  const { cache, records } = memoryCache({ maxEntries: 2, maxBytes: 1600 });
  await cache.write(descriptor(1), 1, peaks()); await cache.write(descriptor(2), 1, peaks());
  await cache.read(descriptor(1), 1); await cache.write(descriptor(3), 1, peaks());
  expect(records.size).toBe(2); expect(await cache.read(descriptor(2), 1)).toBeNull();
  expect(await cache.read(descriptor(1), 1)).toHaveLength(200); expect(await cache.read(descriptor(3), 1)).toHaveLength(200);
  const limited = memoryCache({ maxBytes: 800 }).cache;
  await limited.write(descriptor(1), 1, peaks()); await limited.write(descriptor(2), 1, peaks());
  expect(await limited.read(descriptor(1), 1)).toBeNull();
  expect(await limited.write(descriptor(3, 2), 2, peaks(2))).toBe(false);
});

it('已被後續偏好撤銷的記憶工作，在IDB讀取後不寫入', async () => {
  const { cache } = memoryCache(); await cache.write(descriptor(), 1, peaks());
  let current = true;
  const pending = cache.select(descriptor(), true, { isCurrent: () => current });
  current = false; expect(await pending).toBe(false);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toBeNull();
});

it('不同runtime alias解析同一persistent key時仍按呼叫意圖次序拒絕晚到舊偏好', async () => {
  const { cache } = memoryCache(); await cache.write(descriptor(), 1, peaks());
  // A later original-waveform choice fingerprints faster than an earlier vocal choice.
  expect(await cache.select(descriptor(), false, { order: 2 })).toBe(true);
  expect(await cache.select(descriptor(), true, { order: 1 })).toBe(false);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toBeNull();
  const original = cache.select(descriptor(), false, { order: 3 });
  const newer = cache.select(descriptor(), true, { order: 4 });
  expect(await original).toBe(false); expect(await newer).toBe(true);
  expect(await cache.read(descriptor(), 1, { selectedOnly: true })).toHaveLength(200);
});

it('同步顯示意圖在立即重開仍優先於尚未更新的IDB，但不能略過峰值完整性', async () => {
  const storage = preferencesStorage();
  const { cache, records } = memoryCache({ localStorage: storage });
  await cache.write(descriptor(), 1, peaks()); await cache.select(descriptor(), true);
  cache.rememberPreference('mother-key', false);
  const reopened = memoryCache({ localStorage: storage }, records).cache;
  expect(await reopened.read(descriptor(), 1, { selectedOnly: true, preferenceKey: 'mother-key' })).toBeNull();
  expect(await reopened.read(descriptor(), 1, { selectedOnly: true, preferenceKey: 'other-source' })).toHaveLength(200);
  reopened.rememberPreference('mother-key', true);
  new Float32Array([...records.values()][0].bytes)[0] = -.125;
  expect(await reopened.read(descriptor(), 1, { selectedOnly: true, preferenceKey: 'mother-key' })).toBeNull();
});

it('同步偏好有entries及bytes上限，storage拒絕或毀損不阻擋選擇', () => {
  const storage = preferencesStorage(), cache = new VocalWaveformCache({ indexedDB: null, localStorage: storage });
  for (let i = 0; i < 205; i++) expect(cache.rememberPreference(`mother-${i}`, false)).toBe(true);
  expect(cache.preferences()).toHaveLength(200); expect(cache.preferences().some(item => item.key === 'mother-0')).toBe(false);
  cache.rememberPreference('mother-5', true); expect(cache.preferences()[0].key).toBe('mother-5');
  for (let i = 0; i < 20; i++) cache.rememberPreference(`${i}-${'x'.repeat(32767)}`, true);
  expect([...storage.values.values()][0].length).toBeLessThanOrEqual(256 * 1024);
  const denied = new VocalWaveformCache({ localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } } });
  expect(denied.rememberPreference('mother', true)).toBe(false); expect(denied.preferences()).toEqual([]);
});

it('無IDB、被拒絕、blocked或永不完成都快速回cache miss，不阻擋正常分析', async () => {
  const missing = new VocalWaveformCache({ indexedDB: null });
  expect(await missing.read(descriptor(), 1)).toBeNull(); expect(await missing.write(descriptor(), 1, peaks())).toBe(false);
  const denied = new VocalWaveformCache({ indexedDB: { open() { throw new Error('denied'); } } });
  expect(await denied.read(descriptor(), 1)).toBeNull();
  const blocked = new VocalWaveformCache({ indexedDB: { open() { const request = {}; queueMicrotask(() => request.onblocked()); return request; } } });
  expect(await blocked.read(descriptor(), 1)).toBeNull();
  const stalled = new VocalWaveformCache({ indexedDB: { open: () => ({}) }, timeoutMs: 20 });
  const began = Date.now(); expect(await stalled.read(descriptor(), 1)).toBeNull(); expect(Date.now() - began).toBeLessThan(500);
});

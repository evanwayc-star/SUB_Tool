import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifiedModel } from '../src/vocal-waveform-models.js';

const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
const model = {
  name: 'test model', bytes: 4, url: 'https://example.invalid/vocal-model',
  sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
};

function database({ cached = null, stall = false, failWrite = false } = {}) {
  const transactions = [];
  const db = {
    close: vi.fn(), createObjectStore: vi.fn(),
    transaction: vi.fn((_store, mode) => {
      const request = { result: mode === 'readonly' ? cached : model.sha256 };
      const tx = {
        abort: vi.fn(() => tx.onabort?.()),
        objectStore: () => ({ get: () => request, put: () => request }),
      };
      transactions.push(tx);
      if (!stall) queueMicrotask(() => {
        if (failWrite && mode === 'readwrite') tx.onerror?.();
        else tx.oncomplete?.();
      });
      return tx;
    }),
  };
  return { db, transactions };
}

function indexedDatabase(options = {}) {
  const requests = [], databases = [];
  const idb = { open: vi.fn(() => {
    const request = {};
    requests.push(request);
    if (options.open === 'stalled') return request;
    queueMicrotask(() => {
      if (options.open === 'blocked') { request.onblocked?.(); return; }
      if (options.open === 'error') { request.onerror?.(); return; }
      const entry = database(options);
      databases.push(entry);
      request.result = entry.db;
      request.onsuccess?.();
    });
    return request;
  }) };
  vi.stubGlobal('indexedDB', idb);
  return { idb, requests, databases };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it.each(['blocked', 'stalled', 'error'])('模型 cache open %s 不會攔住完整模型下載與分析', async open => {
  const { requests } = indexedDatabase({ open });
  const pending = verifiedModel(model);
  await vi.advanceTimersByTimeAsync(1600);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(1600);
  expect(await pending).toEqual(bytes);
  // IndexedDB open cannot be cancelled. A connection that arrives after the
  // deadline must close without starting a transaction or blocking other users.
  if (open !== 'error') {
    const late = database(); requests[0].result = late.db;
    requests[0].onsuccess();
    expect(late.db.close).toHaveBeenCalledTimes(1);
    expect(late.db.transaction).not.toHaveBeenCalled();
  }
});

it('模型 cache 讀寫 transaction 逾時都 abort 並關閉，下載完成仍可使用', async () => {
  const { databases } = indexedDatabase({ stall: true });
  const pending = verifiedModel(model);
  await vi.advanceTimersByTimeAsync(1600);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(databases).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(1600);
  expect(await pending).toEqual(bytes);
  expect(databases).toHaveLength(2);
  for (const entry of databases) {
    expect(entry.transactions[0].abort).toHaveBeenCalledTimes(1);
    expect(entry.db.close).toHaveBeenCalledTimes(1);
  }
});

it.each(['late', 'stalled'])('模型 cache %s schema upgrade 不留下佔用 connection 的 transaction', async phase => {
  const { requests } = indexedDatabase({ open: 'stalled' });
  const pending = verifiedModel(model);
  if (phase === 'late') await vi.advanceTimersByTimeAsync(1600);
  const entry = database();
  const upgrade = { abort: vi.fn(() => requests[0].onerror?.()) };
  requests[0].result = entry.db; requests[0].transaction = upgrade;
  requests[0].onupgradeneeded();
  await vi.advanceTimersByTimeAsync(1600);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(1600);
  expect(await pending).toEqual(bytes);
  expect(upgrade.abort).toHaveBeenCalledTimes(1);
  expect(entry.db.close).toHaveBeenCalledTimes(1);
  expect(entry.db.createObjectStore).toHaveBeenCalledTimes(phase === 'late' ? 0 : 1);
});

it.each(['missing', 'denied'])('模型 cache %s 仍能下載有效模型', async storage => {
  vi.stubGlobal('indexedDB', storage === 'missing' ? undefined : { open() { throw new Error('denied'); } });
  expect(await verifiedModel(model)).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('模型 cache 命中仍核對 SHA-256 且釋放 connection', async () => {
  const { databases } = indexedDatabase({ cached: bytes });
  const progress = vi.fn();
  expect(await verifiedModel(model, progress)).toEqual(bytes);
  expect(fetch).not.toHaveBeenCalled();
  expect(progress).toHaveBeenCalledWith({ label: 'test model 已快取', percent: 0 });
  expect(databases[0].db.close).toHaveBeenCalledTimes(1);
});

it('毀損 cache 不略過模型校驗；下載成功但 cache 寫入失敗仍可使用', async () => {
  const { idb } = indexedDatabase({ cached: new Uint8Array([4, 3, 2, 1]).buffer, failWrite: true });
  expect(await verifiedModel(model)).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(idb.open).toHaveBeenCalledTimes(2);
});

it('下載內容雜湊失敗不儲存半成品，下一次能重新下載', async () => {
  const { idb } = indexedDatabase();
  fetch.mockResolvedValueOnce(new Response(new Uint8Array([4, 3, 2, 1])));
  await expect(verifiedModel(model)).rejects.toThrow('完整性');
  expect(idb.open).toHaveBeenCalledTimes(1);
  expect(await verifiedModel(model)).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(idb.open).toHaveBeenCalledTimes(3);
});

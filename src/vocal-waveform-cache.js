import { VOCAL_MODELS } from './vocal-waveform-models.js';
import { VOCAL_SAMPLE_RATE, VOCAL_RESOLUTION } from './vocal-waveform-engine.js';

const DATABASE = 'subtool-vocal-waveforms';
const STORE = 'waveforms';
const TIMEOUT_MS = 1500;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 200;
const PREFERENCE_KEY = 'subtool-vocal-waveform-choices-v1';
const MAX_PREFERENCE_CHARS = 256 * 1024;
// Increment when separation, speech gating, or waveform coordinate rules change.
const ALGORITHM_VERSION = 1;
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');

export function vocalCacheDescriptor(fingerprint, duration, streams) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
      || !Number.isFinite(duration) || duration <= 0 || duration > 86400
      || !Array.isArray(streams) || !streams.length || streams.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return JSON.stringify([ALGORITHM_VERSION, VOCAL_MODELS.vocals.sha256, VOCAL_MODELS.speech.sha256,
    VOCAL_SAMPLE_RATE, VOCAL_RESOLUTION, fingerprint, duration, [...new Set(streams)].sort((a, b) => a - b)]);
}

export function vocalPeakLength(duration) {
  return Math.ceil(Math.round(duration * VOCAL_SAMPLE_RATE) / (VOCAL_SAMPLE_RATE / VOCAL_RESOLUTION)) * 2;
}

function validPeaks(peaks, duration) {
  if (!(peaks instanceof Float32Array) || peaks.length !== vocalPeakLength(duration) || peaks.byteLength > MAX_BYTES) return false;
  for (let i = 0; i < peaks.length; i += 2) {
    if (!Number.isFinite(peaks[i]) || !Number.isFinite(peaks[i + 1]) || peaks[i] > 0 || peaks[i + 1] < 0
        || peaks[i] < -16 || peaks[i + 1] > 16) return false;
  }
  return true;
}

/** Bounded IDB operations: denied, blocked, or full storage never stalls editing. */
export class VocalWaveformCache {
  constructor({ indexedDB, localStorage, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
    try { this.indexedDB = indexedDB === undefined ? globalThis.indexedDB : indexedDB; } catch (_) { this.indexedDB = null; }
    try { this.localStorage = localStorage === undefined ? globalThis.localStorage : localStorage; } catch (_) { this.localStorage = null; }
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes; this.maxEntries = maxEntries;
    this.selectionOrders = new Map();
    this.preferenceClock = 0;
  }
  preferences() {
    try {
      const raw = this.localStorage?.getItem(PREFERENCE_KEY);
      if (!raw || raw.length > MAX_PREFERENCE_CHARS) return [];
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > MAX_ENTRIES) return [];
      return records.filter(record => typeof record.key === 'string' && typeof record.selected === 'boolean' && Number.isFinite(record.accessed));
    } catch (_) { return []; }
  }
  /** Persist explicit display intent synchronously, including while fingerprinting is pending. */
  rememberPreference(key, selected) {
    if (!key || !this.localStorage) return false;
    try {
      const records = this.preferences().filter(record => record.key !== key).sort((a, b) => b.accessed - a.accessed);
      this.preferenceClock = Math.max(this.preferenceClock + 1, Date.now(), (records[0]?.accessed || 0) + 1);
      records.unshift({ key, selected: !!selected, accessed: this.preferenceClock });
      records.splice(MAX_ENTRIES);
      let raw = JSON.stringify(records);
      while (raw.length > MAX_PREFERENCE_CHARS && records.length) { records.pop(); raw = JSON.stringify(records); }
      this.localStorage.setItem(PREFERENCE_KEY, raw); return true;
    } catch (_) { return false; }
  }
  async transaction(mode, run) {
    if (!this.indexedDB) return null;
    return new Promise(resolve => {
      let database = null, transaction = null, settled = false, result = null;
      const finish = value => {
        if (settled) return; settled = true; clearTimeout(timer);
        database?.close(); resolve(value);
      };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch (_) {} finish(null); }, this.timeoutMs);
      let request;
      try { request = this.indexedDB.open(DATABASE, 1); } catch (_) { finish(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onerror = request.onblocked = () => finish(null);
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        try {
          transaction = database.transaction(STORE, mode);
          transaction.oncomplete = () => finish(result);
          transaction.onerror = transaction.onabort = () => finish(null);
          run(transaction.objectStore(STORE), value => { result = value; });
        } catch (_) { try { transaction?.abort(); } catch (_) {} finish(null); }
      };
    });
  }
  async read(descriptor, duration, { selectedOnly = false, preferenceKey = null } = {}) {
    if (!descriptor) return null;
    try {
      const key = await hash(new TextEncoder().encode(descriptor));
      const record = await this.transaction('readonly', (store, result) => {
        const request = store.get(key); request.onsuccess = () => result(request.result || null);
      });
      if (!record || record.descriptor !== descriptor || !(record.bytes instanceof ArrayBuffer) || typeof record.selected !== 'boolean') return null;
      const peaks = new Float32Array(record.bytes);
      if (!validPeaks(peaks, duration) || await hash(record.bytes) !== record.sha256) {
        await this.transaction('readwrite', store => store.delete(key)); return null;
      }
      await this.transaction('readwrite', store => {
        const request = store.get(key); request.onsuccess = () => {
          if (request.result?.sha256 === record.sha256) store.put({ ...request.result, accessed: Date.now() });
        };
      });
      const preference = preferenceKey ? this.preferences().find(item => item.key === preferenceKey) : null;
      return selectedOnly && !(preference?.selected ?? record.selected) ? null : peaks;
    } catch (_) { return null; }
  }
  async write(descriptor, duration, peaks) {
    if (!descriptor || !validPeaks(peaks, duration) || peaks.byteLength > this.maxBytes) return false;
    try {
      const key = await hash(new TextEncoder().encode(descriptor));
      const bytes = peaks.slice().buffer, sha256 = await hash(bytes);
      return !!await this.transaction('readwrite', (store, result) => {
        const all = store.getAll();
        all.onsuccess = () => {
          const records = all.result || [], prior = records.find(record => record.key === key);
          const record = { key, descriptor, bytes, sha256, selected: prior?.selected === true, accessed: Date.now() };
          const retained = records.filter(item => item.key !== key).sort((a, b) => (b.accessed || 0) - (a.accessed || 0));
          let total = bytes.byteLength, count = 1;
          for (const item of retained) {
            const size = item.bytes?.byteLength || 0;
            if (size <= 0 || count >= this.maxEntries || total + size > this.maxBytes) store.delete(item.key);
            else { total += size; count++; }
          }
          store.put(record); result(true);
        };
      });
    } catch (_) { return false; }
  }
  async select(descriptor, selected, { isCurrent = () => true, order = null } = {}) {
    if (!descriptor) return false;
    // Distinct runtime aliases can resolve the same persistent mother key out of order.
    if (order !== null) {
      if (!Number.isSafeInteger(order) || order <= 0 || (this.selectionOrders.get(descriptor) || 0) > order) return false;
      this.selectionOrders.set(descriptor, order);
    }
    const owns = () => isCurrent() && (order === null || this.selectionOrders.get(descriptor) === order);
    try {
      const key = await hash(new TextEncoder().encode(descriptor));
      if (!owns()) return false;
      return !!await this.transaction('readwrite', (store, result) => {
        const request = store.get(key); request.onsuccess = () => {
          if (!owns() || !request.result || request.result.descriptor !== descriptor) return;
          store.put({ ...request.result, selected: !!selected, accessed: Date.now() }); result(true);
        };
      });
    } catch (_) { return false; }
  }
}

export const vocalWaveformCache = new VocalWaveformCache();

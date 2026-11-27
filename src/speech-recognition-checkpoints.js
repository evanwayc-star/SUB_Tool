import { cacheTransaction } from './cache-transaction.js';

// Bump when request models, audio preprocessing, or the returned word schema change.
const SCHEMA = 2;
const MAX_RECORDS = 160;
const MAX_AGE = 30 * 86400000;
const hex = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');

export async function recognitionCheckpointKey(samples, chunk, options) {
  try {
    const pcm = await hex(samples);
    const descriptor = [
      SCHEMA,
      options.provider,
      options.taskMode,
      options.builtinModel,
      options.language,
      options.prompt,
      options.temperature,
      options.vocalFilter,
      options.azureRegion,
      options.azurePhrases,
      options.azureProfanity,
      options.keyterms,
      options.elevenlabsNumSpeakers,
      options.elevenlabsTagAudioEvents,
      options.channelSelection,
      options.projectTerms,
      options.openaiTiming,
      Math.round(chunk.start * 16000),
      samples.length,
      pcm
    ];
    return await hex(new TextEncoder().encode(JSON.stringify(descriptor)));
  } catch {
    return null;
  }
}

function transaction(mode, run) {
  try {
    return cacheTransaction(
      globalThis.indexedDB,
      'subtool-speech-checkpoints',
      'segments',
      mode,
      run,
      1500,
      (store) => store.createIndex('savedAt', 'savedAt')
    );
  } catch {
    return Promise.resolve(null);
  }
}

export const recognitionCheckpoints = {
  async read(key) {
    const record = await transaction('readonly', (store, result) => {
      const read = store.get(key);
      read.onsuccess = () => result(read.result);
    });
    if (!record || Date.now() - record.savedAt > MAX_AGE || !Array.isArray(record.segments)) return null;
    return record.segments;
  },
  async write(key, segments) {
    if (JSON.stringify(segments).length > 512 * 1024) return false;
    return transaction('readwrite', (store, result) => {
      const savedAt = Date.now();
      store.put({ key, segments, savedAt });
      const keys = store.index('savedAt').openKeyCursor(null, 'prev');
      let count = 0;
      keys.onsuccess = () => {
        const cursor = keys.result;
        if (!cursor) {
          result(true);
          return;
        }
        if (++count > MAX_RECORDS || savedAt - cursor.key > MAX_AGE) store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }
};

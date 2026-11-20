'use strict';

const crypto = require('node:crypto');
const { createClipCacheArtifact } = require('./clip-cache-artifact');
const { readRecord, writeRecord } = require('./audio-effect-cache');
const { vocalSourceFingerprint } = require('./vocal-waveform-fingerprint');

const hexDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// The renderer descriptor includes its local source fingerprint. Only the main
// process can replace it with proven shared-file identity for a NAS record.
async function accessVocalPeaks({ path: source, descriptor, peaks }, withCache, fingerprint = vocalSourceFingerprint) {
  if (typeof descriptor !== 'string' || descriptor.length > 2048) throw new TypeError('人聲波形配方無效');
  const fields = JSON.parse(descriptor);
  if (!Array.isArray(fields) || fields.length !== 8) throw new TypeError('人聲波形配方無效');
  const [version, vocals, speech, rate, resolution, localKey, duration, streams] = fields;
  if (!Number.isSafeInteger(version) || version < 1 || !hexDigest(vocals) || !hexDigest(speech) || !hexDigest(localKey)
    || rate !== 44100 || resolution !== 100 || !Number.isFinite(duration) || duration <= 0 || duration > 86400
    || !Array.isArray(streams) || !streams.length || streams.length > 256
    || streams.some((stream, i) => !Number.isInteger(stream) || stream < 0 || stream > 255 || (i && stream <= streams[i - 1])))
    throw new TypeError('人聲波形配方無效');
  const count = Math.ceil(Math.round(duration * rate) / (rate / resolution)) * 2;
  if (peaks !== undefined && (!(peaks instanceof Float32Array) || peaks.length !== count)) throw new TypeError('人聲波形長度無效');
  return withCache(source, async ({ directory, sharedSourceKey, verify }) => {
    if (!hexDigest(sharedSourceKey)) return null;
    if (await fingerprint(source) !== localKey) throw new Error('人聲波形母素材已變更');
    const recipe = ['nas-vocal-peaks-v1', version, vocals, speech, rate, resolution, sharedSourceKey, duration, streams];
    const key = crypto.createHash('sha256').update(JSON.stringify(recipe)).digest();
    verify();
    const store = createClipCacheArtifact(directory, key.toString('hex'), 'peaks');
    const stored = await readRecord(store, key.length + count * 4, verify);
    if (stored?.length === key.length + count * 4 && key.equals(stored.subarray(0, key.length))) {
      if (await fingerprint(source) !== localKey) throw new Error('人聲波形母素材已變更');
      verify();
      return peaks ? true : new Float32Array(stored.buffer.slice(stored.byteOffset + key.length, stored.byteOffset + stored.length));
    }
    if (!peaks) return null;
    for (let i = 0; i < count; i += 2) {
      if (!(peaks[i] >= -16 && peaks[i] <= 0 && peaks[i+1] >= 0 && peaks[i+1] <= 16)) throw new TypeError('人聲峰值無效');
    }
    const content = Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength);
    await writeRecord(store, Buffer.concat([key, content]), verify);
    return true;
  }, { sharedOnly:true });
}

module.exports = { accessVocalPeaks };

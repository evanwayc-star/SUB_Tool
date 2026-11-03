'use strict';

const { sourceClockSeek, timestampOffset } = require('./media-source-clock');

const SAMPLE_RATE = 4000, RESOLUTION = 100, BUCKET_SAMPLES = SAMPLE_RATE / RESOLUTION;
const CHECKPOINT_SAMPLES = SAMPLE_RATE * 5;

function peaksForPCM(bytes) {
  const samples = bytes.length / 2, peaks = new Float32Array(Math.ceil(samples / BUCKET_SAMPLES) * 2);
  for (let sample = 0; sample < samples; sample++) {
    const value = bytes.readInt16LE(sample * 2) / 32768, bucket = Math.floor(sample / BUCKET_SAMPLES) * 2;
    if (value < peaks[bucket]) peaks[bucket] = value;
    if (value > peaks[bucket + 1]) peaks[bucket + 1] = value;
  }
  return peaks;
}

// The store and all PCM work live in the background worker. The parent retains
// the native process owner; a checkpoint is published only after durable write.
async function runContinuousSourceWaveform({ src, duration, audio, sourceKey, store, verify,
  execute, buildPlan, ownProcess, progress }) {
  const totalSamples = Math.round(duration * SAMPLE_RATE);
  const initiallyComplete = store.isComplete, resumedSamples = store.completedSamples;
  let publishedSamples = 0;
  const publish = completedSamples => {
    while (publishedSamples < completedSamples) {
      verify();
      const count = Math.min(CHECKPOINT_SAMPLES, completedSamples - publishedSamples);
      const pcm = store.readPCM(publishedSamples, count);
      const waveform = { sourceKey, startSample: publishedSamples, sampleRate: SAMPLE_RATE, resolution: RESOLUTION,
        peaks: peaksForPCM(pcm), completedSamples: publishedSamples + count, totalSamples };
      publishedSamples += count;
      progress({ pct: publishedSamples / totalSamples * 100, waveform });
    }
  };
  try {
    verify(true);
    if (initiallyComplete) return { wave: store.wavePath, cached: true, temporary: false, complete: true,
      start: 0, duration, sourceKey, resumedSamples };
    publish(resumedSamples);

    const decode = async (startSample, compareFrom) => {
      const sourceStart = startSample / SAMPLE_RATE, seek = sourceClockSeek(sourceStart, audio[0]);
      const clocks = audio.map(stream => ({ ...stream, timestampOffset: timestampOffset(stream) + seek.seek - sourceStart }));
      const plan = buildPlan(clocks, { waveOnly: true }), remainingSamples = totalSamples - startSample;
      const filters = [...plan.filters,
        `${plan.waveLabel}aresample=${SAMPLE_RATE},apad=whole_len=${remainingSamples},atrim=end_sample=${remainingSamples},asetpts=N/SR/TB[sourcewave]`];
      const args = ['-y', '-threads', '1', '-filter_complex_threads', '1', '-ss', String(seek.seek), '-i', src,
        '-vn', '-sn', '-dn', '-filter_complex', filters.join(';'), '-map', '[sourcewave]',
        '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
      let decodedSamples = startSample, carry = Buffer.alloc(0), failure, child;
      const receive = bytes => {
        if (failure) throw failure;
        try {
          verify();
          const combined = carry.length ? Buffer.concat([carry, Buffer.from(bytes)]) : Buffer.from(bytes);
          const length = combined.length - combined.length % 2;
          carry = combined.subarray(length);
          const data = combined.subarray(0, length), samples = data.length / 2;
          if (decodedSamples + samples > totalSamples) throw new Error('連續波形超出來源 sample 範圍');
          const checkFrom = Math.max(decodedSamples, compareFrom), checkTo = Math.min(decodedSamples + samples, resumedSamples);
          if (checkTo > checkFrom) {
            const expected = store.readPCM(checkFrom, checkTo - checkFrom);
            if (!data.subarray((checkFrom - decodedSamples) * 2, (checkTo - decodedSamples) * 2).equals(expected))
              throw Object.assign(new Error('續算波形與已保存 PCM 不一致'), { code: 'SOURCE_WAVE_RESUME_MISMATCH' });
          }
          let offset = Math.max(0, resumedSamples - decodedSamples) * 2;
          while (offset < data.length) {
            const boundary = Math.min(totalSamples, (Math.floor(store.writtenSamples / CHECKPOINT_SAMPLES) + 1) * CHECKPOINT_SAMPLES);
            const count = Math.min(data.length - offset, (boundary - store.writtenSamples) * 2);
            store.appendPCM(data.subarray(offset, offset + count)); offset += count;
            if (store.writtenSamples === boundary) { verify(); store.checkpoint(); publish(store.completedSamples); }
          }
          decodedSamples += samples;
        } catch (error) { failure = error; try { child?.kill(); } catch (_) {} throw error; }
      };
      try {
        await execute(args, { executionKind: 'direct', deferTerminal: true, streamPcm: true,
          duration: remainingSamples / SAMPLE_RATE, jobId: 'source-wave', label: '優先產生波形', onPcm: receive,
          onProcess: process => {
            child = process; ownProcess?.(process);
            process.stdout?.on('data', bytes => { try { receive(bytes); } catch (_) {} });
          } });
      } catch (error) { throw failure || error; }
      if (failure) throw failure;
      verify();
      if (carry.length || decodedSamples !== totalSamples || store.writtenSamples !== totalSamples)
        throw new Error('連續波形 PCM 未完整到達');
    };
    const restartSample = Math.max(0, Math.floor(resumedSamples / SAMPLE_RATE) - 3) * SAMPLE_RATE;
    try { await decode(restartSample, Math.max(restartSample, resumedSamples - SAMPLE_RATE)); }
    catch (error) {
      // Decoder/resampler history can differ after a seek (AAC/44.1 kHz). A
      // bounded overlap mismatch must never splice shifted samples into cache.
      // Retry once from origin and verify every saved sample before appending.
      if (!resumedSamples || error.code !== 'SOURCE_WAVE_RESUME_MISMATCH') throw error;
      verify(); await decode(0, 0);
    }
    verify(true);
    const wave = store.complete(); publish(totalSamples); verify();
    return { wave, cached: false, temporary: false, complete: true, start: 0, duration, sourceKey, resumedSamples };
  } finally { store.close(); }
}

module.exports = { runContinuousSourceWaveform, peaksForPCM, SAMPLE_RATE, CHECKPOINT_SAMPLES };

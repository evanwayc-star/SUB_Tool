'use strict';

const { sourceClockSeek, sourceAudioClockFilter, timestampOffset } = require('./media-source-clock');
const { peaksForPCM, fitsDisplayPeaks, peakCount } = require('./waveform-display-peaks');

const SAMPLE_RATE = 4000, RESOLUTION = 100, BUCKET_SAMPLES = SAMPLE_RATE / RESOLUTION;
const CHECKPOINT_SAMPLES = SAMPLE_RATE * 5;

// The store and all PCM work live in the background worker. The parent retains
// the native process owner; a checkpoint is published only after durable write.
async function runContinuousSourceWaveform({ src, duration, audio, channel, sourceKey, store, verify, displayPeaks = false,
  execute, buildPlan, ownProcess, progress }) {
  const totalSamples = Math.round(duration * SAMPLE_RATE);
  const initiallyComplete = store.isComplete, resumedSamples = store.completedSamples;
  const display = !initiallyComplete && displayPeaks && fitsDisplayPeaks(totalSamples)
    ? new Float32Array(peakCount(totalSamples)) : null;
  let publishedSamples = 0, phase = 'reading';
  const publish = (completedSamples, newPcm) => {
    if (channel && !display) {
      // Channel display reads the verified WAV once ready. Only the MIX uses
      // progressive PCM peaks; avoid reading the NAS file back at every step.
      if (completedSamples > publishedSamples) progress({ pct: completedSamples / totalSamples * 100 });
      publishedSamples = completedSamples;
      return;
    }
    while (publishedSamples < completedSamples) {
      verify();
      const count = Math.min(CHECKPOINT_SAMPLES, completedSamples - publishedSamples);
      const offset = newPcm ? (publishedSamples - completedSamples) * 2 + newPcm.length : -1;
      const pcm = offset >= 0 ? newPcm.subarray(offset,offset+count*2) : store.readPCM(publishedSamples,count);
      const waveform = { sourceKey, startSample: publishedSamples, sampleRate: SAMPLE_RATE, resolution: RESOLUTION,
        peaks: peaksForPCM(pcm), completedSamples: publishedSamples + count, totalSamples };
      if (display) display.set(waveform.peaks, publishedSamples / BUCKET_SAMPLES * 2);
      publishedSamples += count;
      progress({ pct: publishedSamples / totalSamples * 100, ...(displayPeaks ? {phase} : {}), ...(channel ? {} : { waveform }) });
    }
  };
  try {
    verify(true);
    if (initiallyComplete) return { wave: store.wavePath, cached: true, temporary: false, complete: true,
      start: 0, duration, sourceKey, resumedSamples };
    publish(resumedSamples);

    const decode = async (startSample, compareFrom) => {
      phase = 'generating';
      if (displayPeaks) progress({ phase, pct:resumedSamples/totalSamples*100 });
      const sourceStart = startSample / SAMPLE_RATE, seek = sourceClockSeek(sourceStart, audio[channel?.sourceStream ?? 0]);
      const clocks = audio.map(stream => ({ ...stream, timestampOffset: timestampOffset(stream) + seek.seek - sourceStart }));
      const plan = channel ? {
        filters: [`[0:a:${channel.sourceStream}]${sourceAudioClockFilter(clocks[channel.sourceStream])},pan=mono|c0=c${channel.sourceChannel}[selected]`],
        waveLabel: '[selected]',
      } : buildPlan(clocks, { waveOnly: true });
      const remainingSamples = totalSamples - startSample;
      const filters = [...plan.filters,
        `${plan.waveLabel}aresample=${SAMPLE_RATE},apad=whole_len=${remainingSamples},atrim=end_sample=${remainingSamples},asetpts=N/SR/TB[sourcewave]`];
      const args = ['-y', '-threads', '1', '-filter_complex_threads', '1', '-ss', String(seek.seek), '-i', src,
        '-vn', '-sn', '-dn', '-filter_complex', filters.join(';'), '-map', '[sourcewave]',
        '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
      let decodedSamples = startSample, receivedBytes = 0, pendingLength = 0, failure, child;
      // Pipe chunks can be only a few samples. Keep at most one checkpoint in
      // memory so source/directory checks and durable writes do not turn each
      // tiny chunk into several synchronous NAS round trips.
      // Keep the first four rapid previews. After that, a long film commits
      // at most 30 seconds of new audio per checkpoint instead of repeatedly
      // flushing the two NAS files and replacing the receipt every five seconds.
      const longCheckpoint = totalSamples >= 120*SAMPLE_RATE ? 6*CHECKPOINT_SAMPLES : CHECKPOINT_SAMPLES;
      const nextBoundary = sample => {
        const firstWindow=4*CHECKPOINT_SAMPLES;
        if(sample<firstWindow)return (Math.floor(sample/CHECKPOINT_SAMPLES)+1)*CHECKPOINT_SAMPLES;
        return firstWindow+(Math.floor((sample-firstWindow)/longCheckpoint)+1)*longCheckpoint;
      };
      const pending = Buffer.alloc(longCheckpoint * 2);
      const consume = data => {
        verify();
        const samples = data.length / 2;
        const checkFrom = Math.max(decodedSamples, compareFrom), checkTo = Math.min(decodedSamples + samples, resumedSamples);
        if (checkTo > checkFrom) {
          const expected = store.readPCM(checkFrom, checkTo - checkFrom);
          if (!data.subarray((checkFrom - decodedSamples) * 2, (checkTo - decodedSamples) * 2).equals(expected))
            throw Object.assign(new Error('續算波形與已保存 PCM 不一致'), { code: 'SOURCE_WAVE_RESUME_MISMATCH' });
        }
        let offset = Math.max(0, resumedSamples - decodedSamples) * 2;
        while (offset < data.length) {
          const boundary = Math.min(totalSamples, nextBoundary(store.writtenSamples));
          const count = Math.min(data.length - offset, (boundary - store.writtenSamples) * 2);
          const fresh = data.subarray(offset, offset + count);
          store.appendPCM(fresh); offset += count;
          if (store.writtenSamples === boundary) { verify(); store.checkpoint(); publish(store.completedSamples, fresh); }
        }
        decodedSamples += samples;
      };
      const receive = bytes => {
        if (failure) throw failure;
        try {
          const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          if (receivedBytes + data.length > remainingSamples * 2) throw new Error('連續波形超出來源 sample 範圍');
          receivedBytes += data.length;
          let offset = 0;
          while (offset < data.length) {
            const boundaryBytes = (nextBoundary(decodedSamples) - decodedSamples) * 2;
            const count = Math.min(data.length - offset, boundaryBytes - pendingLength);
            data.copy(pending, pendingLength, offset, offset + count); pendingLength += count; offset += count;
            if (pendingLength === boundaryBytes) { consume(pending.subarray(0, pendingLength)); pendingLength = 0; }
          }
        } catch (error) { failure = error; try { child?.kill(); } catch (_) {} throw error; }
      };
      try {
        await execute(args, { executionKind: 'direct', deferTerminal: true, streamPcm: true,
          duration: remainingSamples / SAMPLE_RATE, jobId: channel ? 'source-channel-wave' : 'source-wave',
          label: channel ? '產生原音聲道波形' : '優先產生波形', onPcm: receive,
          onProcess: process => {
            child = process; ownProcess?.(process);
            process.stdout?.on('data', bytes => { try { receive(bytes); } catch (_) {} });
          } });
      } catch (error) { throw failure || error; }
      if (failure) throw failure;
      verify();
      if (receivedBytes !== remainingSamples * 2 || pendingLength % 2)
        throw new Error('連續波形 PCM 未完整到達');
      // A short final block is accepted only after successful decoder EOF.
      if (pendingLength) consume(pending.subarray(0, pendingLength));
      if (decodedSamples !== totalSamples || store.writtenSamples !== totalSamples)
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
    return { wave, cached: false, temporary: false, complete: true, start: 0, duration, sourceKey, resumedSamples,
      ...(display ? { displayPeaks: display } : {}) };
  } finally { store.close(); }
}

module.exports = { runContinuousSourceWaveform, peaksForPCM, SAMPLE_RATE, CHECKPOINT_SAMPLES };

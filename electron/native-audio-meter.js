/* mpv 直接播放時的只讀音量取樣。只在面板輪詢期間解碼，不播放、不落檔。 */
'use strict';

const { sourceClockSeek, sourceAudioClockFilter, timestampOffset } = require('./media-source-clock');
const SAMPLE_RATE = 48000, WINDOW_FRAMES = 2400, WINDOW_SECONDS = WINDOW_FRAMES / SAMPLE_RATE;
const HISTORY_WINDOWS = 32, IDLE_MS = 1000, FRESH_MS = 500, SEEK_TOLERANCE = 0.5;
const LOOK_AHEAD_SECONDS = 0.2;
// Imported projects permit 1024 buses. Bound aggregate work independently of
// that count: never accept a filtergraph or an unbounded bus/channel product.
const MAX_MIXES = 1024, MAX_MIX_INPUTS = 8192;

function validatedMixes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MIXES) return null;
  const ids = new Set();
  let count = 0;
  const result = [];
  for (const mix of value) {
    if (typeof mix?.busId !== 'string' || !mix.busId || mix.busId.length > 256 || ids.has(mix.busId)
      || !Array.isArray(mix.inputs) || mix.inputs.length > 128
      || (count += mix.inputs.length) > MAX_MIX_INPUTS) return null;
    ids.add(mix.busId);
    const inputs = [];
    for (const input of mix.inputs) {
      if (!Number.isInteger(input?.sourceStream) || input.sourceStream < 0 || input.sourceStream >= 32
        || !Number.isInteger(input.sourceChannel) || input.sourceChannel < 0 || input.sourceChannel >= 64
        || !Number.isFinite(input.gain) || input.gain < 0) return null;
      inputs.push({ sourceStream: input.sourceStream, sourceChannel: input.sourceChannel, gain: input.gain });
    }
    result.push({ busId: mix.busId, inputs });
  }
  return result;
}

function createNativeAudioMeter({ spawn, ffmpeg, describeSource, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null, disposed = false, closing = Promise.resolve();
  const owns = session => !disposed && current === session && !session.cancelled;
  const timer = (run, ms) => { const id = setTimer(run, ms); id?.unref?.(); return id; };

  function release(session) {
    if (!session || session.cancelled) return;
    session.cancelled = true;
    clearTimer(session.idleTimer);
    session.cancel();
    session.mixScratch = null;
    // Drop all PCM evidence immediately, before the child can deliver late data.
    for (const stream of session.streams || []) {
      stream.history = []; stream.pcm = null; stream.carry = Buffer.alloc(0);
      // A paused readable pipe may still contain buffered output when killed.
      // Close our ends so ChildProcess close cannot wait forever for a consumer
      // that has already relinquished ownership.
      stream.pipe?.destroy?.();
    }
  }

  function stop() {
    const session = current;
    current = null;
    release(session);
    if (session?.child && !session.closed && !session.stopping) {
      session.stopping = true;
      // Attach close before kill; injected/failed processes may close synchronously.
      session.killTimer = timer(() => {
        if (!session.closed) { try { session.child.kill('SIGKILL'); } catch (_) {} }
      }, 250);
      try { session.child.kill('SIGTERM'); } catch (_) {}
      closing = Promise.all([closing, session.finished]).then(() => undefined);
    }
    return closing;
  }

  function armIdle(session) {
    clearTimer(session.idleTimer);
    session.idleTimer = timer(() => {
      if (!owns(session)) return;
      if (now() - session.lastReadAt < IDLE_MS) { armIdle(session); return; }
      void stop();
    }, Math.max(1, IDLE_MS - (now() - session.lastReadAt)));
  }

  function receive(session, stream, chunk) {
    if (!owns(session) || !Buffer.isBuffer(chunk) || !chunk.length) return;
    const bytes = stream.carry.length ? Buffer.concat([stream.carry, chunk]) : chunk;
    const end = bytes.length - bytes.length % 4;
    // Copy the at-most-three-byte tail so it cannot retain a large pipe buffer.
    stream.carry = Buffer.from(bytes.subarray(end));
    for (let offset = 0; offset < end; offset += 4) {
      const raw = bytes.readFloatLE(offset);
      const sample = Number.isFinite(raw) ? raw : 0;
      stream.pcm[(stream.frames % WINDOW_FRAMES) * stream.channels + stream.channel] = sample;
      stream.peaks[stream.channel] = Math.max(stream.peaks[stream.channel], Math.abs(sample));
      if (++stream.channel < stream.channels) continue;
      stream.channel = 0;
      if (++stream.frames % WINDOW_FRAMES !== 0) continue;
      const index = stream.frames / WINDOW_FRAMES - 1;
      stream.history.push({ index, receivedAt: now(), peaks: stream.peaks, pcm: stream.pcm });
      if (stream.history.length > HISTORY_WINDOWS) stream.history.shift();
      stream.peaks = new Array(stream.channels).fill(0);
      stream.pcm = new Float32Array(WINDOW_FRAMES * stream.channels);
    }
  }

  function pump(session, stream) {
    if (!owns(session) || !stream.pipe || stream.pumping) return;
    stream.pumping = true;
    try {
      // A slow playback rate must not decode future windows so early that their
      // wall-clock freshness expires before the playhead reaches them.
      const lookAhead = LOOK_AHEAD_SECONDS * Math.min(1, session.rate);
      const targetFrames = Math.floor(Math.max(0, session.lastTime - session.startTime + lookAhead) * SAMPLE_RATE);
      while (owns(session) && stream.frames < targetFrames) {
        const frames = Math.min(WINDOW_FRAMES, targetFrames - stream.frames);
        const bytes = stream.pipe.read((frames * stream.channels - stream.channel) * 4 - stream.carry.length);
        if (!bytes?.length) break;
        receive(session, stream, bytes);
      }
    } catch (_) {
      if (current === session) void stop();
    } finally { stream.pumping = false; }
  }

  async function start(session) {
    try {
      // Replacement cannot overlap an old decoder, including slow SIGTERM exits.
      await closing;
      if (!owns(session)) return;
      const info = await describeSource(session.path);
      if (!owns(session)) return;
      const audio = info?.audio;
      if (!Array.isArray(audio) || !audio.length || audio.length > 32
        || audio.some(stream => !Number.isInteger(stream?.channels) || stream.channels < 1 || stream.channels > 64)
        || audio.reduce((sum, stream) => sum + stream.channels, 0) > 128) {
        if (owns(session)) { current = null; release(session); }
        return;
      }
      const executable = typeof ffmpeg === 'function' ? ffmpeg() : ffmpeg;
      if (!executable) { if (owns(session)) { current = null; release(session); } return; }
      // Probing may take time. Begin at the still-current playback position, not
      // the stale first request, without treating decoder startup lag as a seek.
      session.startTime = session.lastTime + Math.max(0, now() - session.lastReadAt) / 1000 * session.rate;
      const seek = sourceClockSeek(session.startTime, info.video || audio[0]);
      // Input -readrate also throttles discarded seek pre-roll. Starting at a
      // nonzero source time can leave every sample permanently behind playback.
      // Pull only a bounded PCM horizon instead; pipe backpressure pauses FFmpeg
      // while allowing startup/seek decoding to catch up at full speed.
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-ss', String(seek.seek), '-i', session.path];
      session.streams = audio.map((source, sourceStream) => {
        const clock = { timestampOffset: timestampOffset(source) + seek.seek - session.startTime };
        args.push('-map', `0:a:${sourceStream}`, '-vn', '-sn', '-dn',
          '-af', sourceAudioClockFilter(clock, SAMPLE_RATE), '-ar', String(SAMPLE_RATE),
          '-c:a', 'pcm_f32le', '-f', 'f32le', `pipe:${sourceStream + 3}`);
        return { sourceStream, channels: source.channels, frames: 0, channel: 0,
          peaks: new Array(source.channels).fill(0), pcm: new Float32Array(WINDOW_FRAMES * source.channels),
          carry: Buffer.alloc(0), history: [] };
      });
      if (!owns(session)) return;
      const child = spawn(executable, args, { windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', ...audio.map(() => 'pipe')] });
      session.child = child;
      session.finished = new Promise(resolve => {
        child.once('close', () => {
          session.closed = true;
          clearTimer(session.killTimer);
          if (current === session) current = null;
          release(session);
          resolve();
        });
      });
      const failed = () => { if (current === session) void stop(); };
      child.on('error', failed);
      child.stderr?.on('data', () => {}); // Always drain; error text is not PCM.
      child.stderr?.on('error', failed);
      for (const stream of session.streams) {
        const pipe = child.stdio?.[stream.sourceStream + 3];
        if (!pipe?.on || typeof pipe.read !== 'function') { failed(); return; }
        stream.pipe = pipe;
        pipe.on('readable', () => pump(session, stream));
        pipe.on('error', failed);
        pump(session, stream);
      }
    } catch (_) {
      if (current === session) void stop();
    }
  }

  function snapshot(session, time, mixes) {
    if (!owns(session) || !session.streams?.length || session.streams.some(stream => !stream.history.length)) return null;
    // Every stream must describe the same 50 ms source interval. Different pipe
    // scheduling must never mix current dialogue with an older music interval.
    const latest = Math.min(...session.streams.map(stream => stream.history.at(-1).index));
    const requested = Math.max(0, Math.round((time - session.startTime) / WINDOW_SECONDS - 0.5));
    const index = Math.min(latest, requested);
    const sampleTime = session.startTime + (index + 0.5) * WINDOW_SECONDS;
    if (Math.abs(time - sampleTime) > SEEK_TOLERANCE) return null;
    const levels = [];
    const buckets = [];
    for (const stream of session.streams) {
      const bucket = stream.history.find(item => item.index === index);
      if (!bucket || now() - bucket.receivedAt > FRESH_MS) return null;
      buckets.push(bucket);
      for (let sourceChannel = 0; sourceChannel < stream.channels; sourceChannel++) {
        levels.push({ sourceStream: stream.sourceStream, sourceChannel, level: bucket.peaks[sourceChannel] });
      }
    }
    const result = { time: sampleTime, levels };
    if (mixes !== undefined) {
      result.busLevels = [];
      for (const mix of mixes) {
        let level = 0;
        if (mix.inputs.length === 1) {
          const input = mix.inputs[0];
          const stream = session.streams[input.sourceStream], bucket = buckets[input.sourceStream];
          if (!stream || input.sourceChannel >= stream.channels) return null;
          // Nonnegative scalar gain commutes with peak detection. A single
          // routed channel needs no second scan of the same signed samples.
          level = Math.max(0, bucket.peaks[input.sourceChannel] * input.gain);
        } else if (mix.inputs.length > 1) {
          // Keep signed PCM for phase cancellation. snapshot is synchronous,
          // so one cleared workspace can serve every bus and later reads.
          const summed = session.mixScratch ||= new Float64Array(WINDOW_FRAMES);
          summed.fill(0);
          for (const input of mix.inputs) {
            const stream = session.streams[input.sourceStream], bucket = buckets[input.sourceStream];
            if (!stream || input.sourceChannel >= stream.channels) return null;
            for (let frame = 0; frame < WINDOW_FRAMES; frame++) {
              summed[frame] += bucket.pcm[frame * stream.channels + input.sourceChannel] * input.gain;
            }
          }
          for (const sample of summed) level = Math.max(level, Math.abs(sample));
        }
        if (!Number.isFinite(level)) return null;
        result.busLevels.push({ busId: mix.busId, level });
      }
    }
    return result;
  }

  async function read(request = {}) {
    const { path, time, rate = 1 } = request || {};
    const mixes = validatedMixes(request?.mixes);
    if (disposed || typeof path !== 'string' || !path.trim() || path.includes('\0') || path.length > 32767
      || typeof time !== 'number' || !Number.isFinite(time) || time < 0
      || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 16 || mixes === null) return null;
    const at = now();
    let session = current;
    if (session && (session.path !== path || session.rate !== rate
      || Math.abs(time - (session.anchorTime + (at - session.anchorAt) / 1000 * rate)) > SEEK_TOLERANCE)) {
      void stop(); session = null;
    }
    if (!session) {
      session = { path, rate, anchorTime: time, anchorAt: at, lastTime: time, lastReadAt: at,
        streams: [], child: null, closed: false, cancelled: false };
      session.cancellation = new Promise(resolve => { session.cancel = resolve; });
      current = session;
      armIdle(session);
      session.ready = start(session);
    } else {
      session.lastTime = time; session.lastReadAt = at; armIdle(session);
    }
    await Promise.race([session.ready, session.cancellation]);
    for (const stream of session.streams) pump(session, stream);
    return snapshot(session, time, mixes);
  }

  return { read, stop, dispose() { disposed = true; return stop(); } };
}

module.exports = { createNativeAudioMeter };

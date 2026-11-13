// A recognition source keeps accepted inputs, never a whole decoded movie.
// Only one 16 kHz window and one native response are resident while mixing.
const SAMPLE_RATE = 16000;
let nextRequest = 0;
const abortError = () => new DOMException('語音辨識已取消', 'AbortError');
// Cancel IPC only requests shutdown. The read settles after native child-close;
// replacement sessions must wait for that evidence before reusing the sender.
const cancelledReads = new WeakMap();
function retainCancelledRead(bridge, promise) {
  let pending = cancelledReads.get(bridge);
  if (!pending) { pending = new Set(); cancelledReads.set(bridge, pending); }
  const settled = promise.then(() => {}, () => {});
  pending.add(settled);
  settled.then(() => {
    pending.delete(settled);
    if (!pending.size && cancelledReads.get(bridge) === pending) cancelledReads.delete(bridge);
  });
}

export function createRecognitionRangeSource({ duration, inputs, bridge, signal, owns = () => true }) {
  let closed = false, reading = false, activeRequest = null;
  const cancelRequest = () => {
    if (!activeRequest || activeRequest.cancelled) return;
    activeRequest.cancelled = true;
    retainCancelledRead(bridge, activeRequest.promise);
    try { Promise.resolve(bridge.speechAudioCancel(activeRequest.id)).catch(() => {}); } catch (_) { /* already closed */ }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    cancelRequest();
    inputs = [];
  };
  const assertCurrent = rangeSignal => {
    if (closed || signal?.aborted || rangeSignal?.aborted || !owns()) {
      cancelRequest();
      throw abortError();
    }
  };
  signal?.addEventListener('abort', close, { once: true });
  const totalWeight = inputs.reduce((sum, input) => sum + (input.weight || 1), 0);
  return {
    duration,
    close,
    async readRange(start, end, { signal: rangeSignal } = {}) {
      assertCurrent(rangeSignal);
      if (reading) throw new Error('辨識音訊已有讀取工作');
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 1e-8 || end - start > 600) {
        throw new RangeError('辨識音訊範圍必須在來源內且不超過 600 秒');
      }
      const frames = Math.round((end - start) * SAMPLE_RATE);
      if (!frames) throw new RangeError('辨識音訊範圍不足一個 sample');
      reading = true;
      let rangeAborted = false;
      const cancelRange = () => { rangeAborted = true; cancelRequest(); };
      rangeSignal?.addEventListener('abort', cancelRange, { once: true });
      try {
        const mixed = new Float32Array(frames);
        for (const input of inputs) {
          assertCurrent(rangeSignal);
          if (rangeAborted) throw abortError();
          const weight = (input.weight || 1) / totalWeight;
          if (input.buffer) {
            const buffer = input.buffer;
            const data = buffer.getChannelData(input.channel);
            const sourceLength = input.clock.length;
            const shift = input.clock.shiftSamples;
            // Apply whole-buffer clock normalization to requested indices only.
            const sample = index => index < 0 || index >= sourceLength || index + shift < 0 || index + shift >= buffer.length
              ? 0 : data[index + shift];
            for (let index = 0; index < frames; index++) {
              const position = (start + index / SAMPLE_RATE) * buffer.sampleRate;
              const left = Math.floor(position), fraction = position - left;
              mixed[index] += (sample(left) * (1 - fraction) + sample(left + 1) * fraction) * weight;
            }
          } else {
            let draining = cancelledReads.get(bridge);
            while (draining?.size) {
              await Promise.all([...draining]);
              assertCurrent(rangeSignal);
              if (rangeAborted) throw abortError();
              draining = cancelledReads.get(bridge);
            }
            const request = { id: `asr-pcm-${Date.now()}-${++nextRequest}`, cancelled: false };
            activeRequest = request;
            let response;
            try {
              // Assign the promise before invoking the bridge, including mocks
              // or adapters which synchronously trigger owner cancellation.
              request.promise = Promise.resolve().then(() => {
                assertCurrent(rangeSignal);
                return bridge.speechAudioRead({ ...input.request, start, duration: end - start, requestId: request.id });
              });
              response = await request.promise;
              assertCurrent(rangeSignal);
              if (request.cancelled || rangeAborted) throw abortError();
            } finally { if (activeRequest === request) activeRequest = null; }
            if (response?.sampleRate !== SAMPLE_RATE || response.numberOfChannels !== 1 || response.frames !== frames
              || !(response.pcm instanceof ArrayBuffer) || response.pcm.byteLength !== frames * Float32Array.BYTES_PER_ELEMENT) {
              throw new Error('辨識音訊 PCM 回傳格式或長度不符');
            }
            const data = new Float32Array(response.pcm);
            for (let index = 0; index < frames; index++) {
              if (!Number.isFinite(data[index])) throw new Error('辨識音訊 PCM 包含無效 sample');
              mixed[index] += data[index] * weight;
            }
          }
        }
        assertCurrent(rangeSignal);
        return { sampleRate: SAMPLE_RATE, numberOfChannels: 1, length: frames, duration: frames / SAMPLE_RATE,
          getChannelData(channel) {
            if (channel !== 0) throw new RangeError('辨識音訊只有一個聲道');
            return mixed;
          } };
      } finally {
        reading = false;
        rangeSignal?.removeEventListener('abort', cancelRange);
      }
    }
  };
}

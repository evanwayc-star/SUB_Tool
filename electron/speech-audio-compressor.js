/* ==============================================================================
   SUB Tool — Recognition-only speech audio compression
   ============================================================================== */
const MAX_SPEECH_WAV_BYTES = 20_000_000;
const SPEECH_COMPRESSION_REQUEST_ID = /^speech-[A-Za-z0-9_-]{1,96}$/;

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function inspectMono16kPcmWav(value) {
  const bytes = toBuffer(value);
  if (!bytes || bytes.length < 44 || bytes.length > MAX_SPEECH_WAV_BYTES) {
    throw new Error('辨識壓縮只接受不超過 20 MB 的標準 WAV');
  }
  const validHeader = bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString('ascii', 8, 12) === 'WAVE' &&
    bytes.toString('ascii', 12, 16) === 'fmt ' &&
    bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === 16_000 &&
    bytes.readUInt32LE(28) === 32_000 &&
    bytes.readUInt16LE(32) === 2 &&
    bytes.readUInt16LE(34) === 16 &&
    bytes.toString('ascii', 36, 40) === 'data';
  const dataBytes = bytes.readUInt32LE(40);
  if (!validHeader || dataBytes !== bytes.length - 44) {
    throw new Error('辨識壓縮只接受 16 kHz mono PCM16 WAV');
  }
  return { bytes, duration: dataBytes / 32_000 };
}

function createSpeechAudioCompressor({
  createTempPath,
  writeFile,
  readFile,
  removeFile,
  execute
} = {}) {
  if ([createTempPath, writeFile, readFile, removeFile, execute].some(fn => typeof fn !== 'function')) {
    throw new TypeError('語音壓縮器缺少必要 adapter');
  }

  return {
    async compress(wavBytes, { onProcess = null } = {}) {
      const inspected = inspectMono16kPcmWav(wavBytes);
      const inputPath = createTempPath('wav');
      const outputPath = createTempPath('mp3');
      try {
        await writeFile(inputPath, inspected.bytes);
        await execute([
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-i', inputPath,
          '-map', '0:a:0',
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-c:a', 'libmp3lame',
          '-b:a', '64k',
          '-map_metadata', '-1',
          outputPath
        ], {
          duration: inspected.duration,
          jobId: 'speech-compress',
          label: '準備辨識用 MP3',
          ...(typeof onProcess === 'function' ? { onProcess } : {})
        });
        const output = toBuffer(await readFile(outputPath));
        if (!output?.length) throw new Error('ffmpeg 沒有產生辨識用 MP3');
        return {
          b64: output.toString('base64'),
          type: 'audio/mpeg',
          name: 'audio.mp3',
          size: output.length
        };
      } finally {
        await Promise.allSettled([
          Promise.resolve(removeFile(inputPath)),
          Promise.resolve(removeFile(outputPath))
        ]);
      }
    }
  };
}

function createSpeechCompressionRuntime({ compressor } = {}) {
  if (!compressor || typeof compressor.compress !== 'function') {
    throw new TypeError('語音壓縮 runtime 缺少 compressor');
  }
  const active = new Map();
  let closing = false, resumeWhenIdle = false;
  const cancelledError = () => Object.assign(new Error('辨識壓縮已取消'), {
    name: 'AbortError', code: 'ABORT_ERR',
  });
  const resume = () => {
    resumeWhenIdle = true;
    if (active.size) return false;
    closing = false;
    resumeWhenIdle = false;
    return true;
  };

  const requireRequestId = requestId => {
    if (typeof requestId !== 'string' || !SPEECH_COMPRESSION_REQUEST_ID.test(requestId)) {
      throw new TypeError('辨識壓縮 requestId 格式不正確');
    }
    return requestId;
  };

  const cancel = requestId => {
    const id = requireRequestId(requestId);
    const entry = active.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    if (entry.process && typeof entry.process.kill === 'function' && !entry.process.killed) {
      try { entry.process.kill(); } catch (error) {}
    }
    return true;
  };

  const compress = (wavBytes, requestId) => {
    const id = requireRequestId(requestId);
    if (closing) return Promise.reject(cancelledError());
    if (active.has(id)) throw new Error('辨識壓縮 requestId 重複');
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const entry = { process: null, cancelled: false, finished };
    active.set(id, entry);

    return Promise.resolve().then(async () => {
      if (entry.cancelled) throw cancelledError();
      const result = await compressor.compress(wavBytes, {
        onProcess: process => {
          entry.process = process;
          if (entry.cancelled && typeof process?.kill === 'function' && !process.killed) {
            try { process.kill(); } catch (error) {}
          }
        }
      });
      // Native close is only one stage: reading the MP3 and clearing private
      // files still belong to this request, and cancellation revokes its result.
      if (entry.cancelled) throw cancelledError();
      return result;
    }).finally(() => {
      active.delete(id);
      finish();
      if (resumeWhenIdle && !active.size) resume();
    });
  };

  const cancelAllAndWait = async () => {
    closing = true;
    resumeWhenIdle = false;
    // Closed admission makes this a complete owner snapshot. A later explicit
    // resume may admit a new generation; this shutdown must not cancel it.
    const entries = [...active.entries()];
    for (const [requestId] of entries) cancel(requestId);
    await Promise.allSettled(entries.map(([, entry]) => entry.finished));
  };

  return Object.freeze({
    compress,
    cancel,
    cancelAllAndWait,
    resume,
    activeCount: () => active.size
  });
}

module.exports = {
  createSpeechCompressionRuntime,
  createSpeechAudioCompressor,
  inspectMono16kPcmWav,
  MAX_SPEECH_WAV_BYTES
};

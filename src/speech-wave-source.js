import { addSpeechChannel, speechFilterRadius } from './speech-resampler.js';

// RIFF chunks are seekable. Read only their headers and the selected PCM,
// retaining the filter halo so adjacent excerpts equal a continuous decode.
export async function openSpeechWaveSource(file, { signal, owns = () => true, recognitionSelection } = {}) {
  if (!Number.isSafeInteger(file?.size) || file.size < 44 || typeof file.slice !== 'function') return null;
  let closed = false;
  const check = (extra) => {
    if (closed || signal?.aborted || extra?.aborted || !owns())
      throw new DOMException('語音辨識已取消', 'AbortError');
  };
  const read = async (start, end, extra) => {
    check(extra);
    const bytes = await file.slice(start, end).arrayBuffer();
    check(extra);
    if (bytes.byteLength !== end - start) throw new Error('WAV 聲音資料截斷');
    return new DataView(bytes);
  };
  const header = await read(0, 12);
  if (header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) return null;
  const limit = Math.min(file.size, header.getUint32(4, true) + 8);
  let fmt;
  for (let offset = 12, count = 0; offset + 8 <= limit && count < 1024; count++) {
    const chunk = await read(offset, offset + 8);
    const id = chunk.getUint32(0),
      size = chunk.getUint32(4, true),
      start = offset + 8;
    if (start + size > limit) return null;
    if (id === 0x666d7420 && size >= 16) {
      const f = await read(start, start + Math.min(size, 40));
      let type = f.getUint16(0, true);
      const channels = f.getUint16(2, true),
        rate = f.getUint32(4, true),
        stride = f.getUint16(12, true),
        bits = f.getUint16(14, true);
      if (
        type === 0xfffe &&
        size >= 40 &&
        f.getUint16(16, true) >= 22 &&
        f.getUint16(18, true) === bits &&
        f.getUint32(28) === 0x00001000 &&
        f.getUint32(32) === 0x800000aa &&
        f.getUint32(36) === 0x00389b71
      )
        type = f.getUint32(24, true);
      if (
        !((type === 1 && [8, 16, 24, 32].includes(bits)) || (type === 3 && bits === 32)) ||
        channels < 1 ||
        channels > 128 ||
        rate < 1 ||
        rate > 384000 ||
        stride !== (channels * bits) / 8
      )
        return null;
      fmt = { type, channels, rate, stride, bits };
    }
    if (id === 0x64617461 && fmt && size > 0 && size % fmt.stride === 0) {
      const { type, channels, rate, stride, bits } = fmt,
        frames = size / stride,
        duration = frames / rate;
      const selected =
        recognitionSelection?.mode === 'source-channels'
          ? [
              ...new Set(
                recognitionSelection.channels.map((ch) => (ch.sourceStream === 0 ? ch.sourceChannel : -1))
              )
            ]
          : Array.from({ length: channels }, (_, i) => i);
      if (!selected.length || selected.some((ch) => !Number.isInteger(ch) || ch < 0 || ch >= channels))
        throw new Error('選取的 WAV 來源聲道不存在');
      function sample(view, at) {
        if (type === 3) return view.getFloat32(at, true);
        if (bits === 8) return (view.getUint8(at) - 128) / 128;
        if (bits === 16) return view.getInt16(at, true) / 32768;
        if (bits === 24)
          return (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608;
        return view.getInt32(at, true) / 2147483648;
      }
      return {
        duration,
        close() {
          closed = true;
        },
        async readRange(from, to, { signal: extra } = {}) {
          check(extra);
          if (!(from >= 0 && to > from && to <= duration + 1e-8 && to - from <= 600))
            throw new RangeError('WAV 辨識區間無效');
          const output = new Float32Array(Math.round((to - from) * 16000)),
            radius = speechFilterRadius(rate);
          const block = Math.max(1, Math.min(16000, Math.floor(((1024 * 1024) / stride / rate) * 16000)));
          for (let i = 0; i < output.length; i += block) {
            const last = Math.min(i + block, output.length);
            const firstSample = (from + i / 16000) * rate;
            const left = Math.max(0, Math.floor(firstSample) - radius),
              right = Math.min(frames, Math.ceil((from + last / 16000) * rate) + radius);
            const view = await read(start + left * stride, start + right * stride, extra);
            const mono = new Float32Array(right - left);
            for (let j = 0; j < mono.length; j++) {
              let value = 0;
              for (const ch of selected) value += sample(view, j * stride + (ch * bits) / 8);
              if (!Number.isFinite(value)) throw new Error('WAV 包含無效的浮點音訊');
              mono[j] = value / selected.length;
            }
            addSpeechChannel(output.subarray(i, last), mono, rate, firstSample - left);
          }
          return {
            sampleRate: 16000,
            numberOfChannels: 1,
            length: output.length,
            duration: output.length / 16000,
            getChannelData: () => output
          };
        }
      };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

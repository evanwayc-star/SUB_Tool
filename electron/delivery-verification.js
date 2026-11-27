'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { exactDeliveryFrameRate, deliveryFrameRateRatio } = require('../shared/delivery-frame-rate.cjs');
const probe = promisify(execFile);
const invalid = detail => Object.assign(new Error(`交付成品驗證失敗：${detail}`), { code: 'INVALID_DELIVERY_CONTENT' });

async function readAt(file, position, length) {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await file.read(bytes, read, length - read, position + read);
    if (!part.bytesRead) throw invalid('容器表頭遭截斷');
    read += part.bytesRead;
  }
  return bytes;
}

async function verifyWave(file, length, channels, duration, signal) {
  const header = await readAt(file, 0, 12);
  const kind = header.toString('ascii', 0, 4);
  if (!['RIFF', 'RF64'].includes(kind) || header.toString('ascii', 8, 12) !== 'WAVE') throw invalid('缺少 WAV 表頭');
  const rf = kind === 'RF64';
  if (header.readUInt32LE(4) !== (rf ? 0xffffffff : length - 8)) throw invalid('RIFF 長度與實際成品不同');
  let dataBytes, samples;
  for (let pos = 12; pos + 8 <= length;) {
    signal?.throwIfAborted();
    const chunk = await readAt(file, pos, 8);
    const name = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4);
    if (name === 'ds64' && rf) {
      if (pos !== 12 || size < 28) throw invalid('無效的 RF64 ds64 表頭');
      const ext = await readAt(file, pos + 8, 28);
      if (ext.readBigUInt64LE(0) !== BigInt(length - 8)) throw invalid('RF64 長度與實際成品不同');
      dataBytes = Number(ext.readBigUInt64LE(8));
      samples = Number(ext.readBigUInt64LE(16));
    }
    if (name === 'data') {
      const bytes = rf ? dataBytes : size;
      const frames = bytes / (channels * 3);
      if (!Number.isSafeInteger(frames) || (rf && (samples !== frames || size !== 0xffffffff))
        || pos + 8 + bytes + (bytes % 2) !== length || Math.abs(frames - duration * 48000) > 1)
        throw invalid('WAV 聲道取樣數、data 長度與交付範圍不符');
      return;
    }
    pos += 8 + size + size % 2;
  }
  throw invalid('WAV 缺少 PCM 資料');
}

// ffprobe can read a complete faststart moov even when the tail of mdat is missing.
async function verifyMovBoxes(file, length, signal) {
  let position = 0, media = false, metadata = false;
  while (position < length) {
    signal?.throwIfAborted();
    const header = await readAt(file, position, 8);
    const name = header.toString('ascii', 4), size = header.readUInt32BE(0);
    const bytes = size === 1 ? Number((await readAt(file, position + 8, 8)).readBigUInt64BE()) : size || length - position;
    if (!Number.isSafeInteger(bytes) || bytes < (size === 1 ? 16 : 8) || position + bytes > length)
      throw invalid(`MOV/MP4 的 ${name} 區塊遭截斷`);
    media ||= name === 'mdat'; metadata ||= name === 'moov';
    position += bytes;
  }
  if (!media || !metadata) throw invalid('MOV/MP4 缺少媒體或索引');
}

async function verifyDeliveryMedia(filePath, { format, duration, fps, channels }, executable, signal) {
  signal?.throwIfAborted();
  if (!executable) throw invalid('找不到 ffprobe');
  const { stdout } = await probe(executable, ['-v', 'error', '-of', 'json',
    '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,channels,bits_per_sample,sample_rate,pix_fmt,duration,nb_frames',
    filePath], { windowsHide: true, signal, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  const descriptor = JSON.parse(stdout);
  const movie = format === 'prores' || format === 'h264';
  const container = movie ? 'mov' : format;
  if (!descriptor.format?.format_name?.split(',').includes(container)) throw invalid('容器格式與交付設定不同');
  const videos = descriptor.streams?.filter(stream => stream.codec_type === 'video') || [];
  const audio = descriptor.streams?.filter(stream => stream.codec_type === 'audio') || [];
  if (videos.length !== Number(movie) || (movie && videos[0].codec_name !== (format === 'prores' ? 'prores' : 'h264'))
    || (format === 'prores' && videos[0].pix_fmt !== 'yuv422p10le')) throw invalid('影片格式與交付設定不同');
  const audioCodec = { wav: 'pcm_s24le', prores: 'pcm_s24le', h264: 'aac', mp3: 'mp3' }[format];
  if (audio.length !== channels.length || audio.some((stream, i) =>
    stream.channels !== channels[i] || stream.codec_name !== audioCodec || Number(stream.sample_rate) !== 48000))
    throw invalid('音軌數、聲道、取樣率或編碼與交付設定不同');
  // Integer-frame output may extend past a non-grid audio tail by one frame;
  // MP3 headers include encoder priming and a final padded packet.
  const rate = exactDeliveryFrameRate(deliveryFrameRateRatio(fps));
  if (movie && Number(videos[0].nb_frames) !== Math.max(1, Math.ceil(duration * rate - 1e-6)))
    throw invalid('影片畫格數與交付格網不同');
  const tolerance = movie ? 1 / rate + .002 : format === 'mp3' ? .05 : .001;
  const actualDuration = Number(descriptor.format.duration);
  if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - duration) > tolerance) throw invalid('成品片長與交付範圍不同');
  if (movie || format === 'wav') {
    const file = await fs.open(filePath, 'r');
    try {
      const { size } = await file.stat();
      if (movie) await verifyMovBoxes(file, size, signal);
      else await verifyWave(file, size, channels[0], duration, signal);
    } finally { await file.close(); }
  }
}

module.exports = { verifyDeliveryMedia };

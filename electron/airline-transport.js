'use strict';

const { open, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { airlineTransportProfile } = require('./airline-encoding');
const PACKET = 188;
const CHUNK = PACKET * 1024;
const CLOCK = 27000000;

function invalid(message) {
  const error = new Error(`航空 MPG 排程失敗：${message}`);
  error.code = 'INVALID_AIRLINE_TRANSPORT';
  return error;
}
function timestamp(bytes, offset) {
  return (bytes[offset] & 14) * 536870912 + bytes[offset + 1] * 4194304
    + (bytes[offset + 2] & 254) * 16384 + bytes[offset + 3] * 128 + (bytes[offset + 4] >> 1);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc >>> 31) ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}
function table(pid, s3k) {
  const section = pid === 0 ? Buffer.from('00b00d0001c100000001e03f00000000', 'hex')
    : Buffer.from(`02b0170001c10000e030f000${s3k ? '01' : '1b'}e030f000${s3k ? '03' : '0f'}e031f00000000000`, 'hex');
  section.writeUInt32BE(crc32(section.subarray(0, -4)), section.length - 4);
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes.set([0x47, 0x40 | (pid === 63 ? 0x20 : 0), pid, 0x10, 0]);
  section.copy(bytes, 5);
  return bytes;
}

// Two independent sequential readers retain one PES each, regardless of movie
// length. No elementary sidecars or whole-movie packet index are created.
async function* elementaryPackets(file, pid, signal, s3k) {
  const read = Buffer.allocUnsafe(CHUNK);
  let position = 0, parts = [], size = 0, randomAccess = false;
  const make = (last = false) => {
    let bytes = Buffer.concat(parts, size);
    if (bytes.length < 14 || bytes.readUIntBE(0, 3) !== 1 || (bytes[6] & 0xc0) !== 0x80) throw invalid(`PID ${pid} 的 PES 標頭無效`);
    const flags = bytes[7] >> 6;
    if (![2, 3].includes(flags) || 9 + bytes[8] > bytes.length) throw invalid(`PID ${pid} 缺少完整 PTS／DTS`);
    const pts = timestamp(bytes, 9) / 90000;
    const dts = flags === 3 ? timestamp(bytes, 14) / 90000 : pts;
    // End-of-sequence and end-of-stream NALs belong to the final video PES.
    // Appending a timestamp-less PES would invent an extra packet/frame.
    const end = s3k ? Buffer.from([0, 0, 1, 0xb7]) : Buffer.from([0, 0, 1, 11, 128]);
    if (last && pid === 48 && !bytes.subarray(-end.length).equals(end)) {
      bytes = Buffer.concat([bytes, s3k ? end : Buffer.from([0, 0, 1, 10, 128, 0, 0, 1, 11, 128])]);
      if (bytes.readUInt16BE(4)) bytes.writeUInt16BE(bytes.length - 6, 4);
    }
    return { bytes, pts, dts, randomAccess, offset: 0, header: 9 + bytes[8], retained: 0 };
  };
  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(read, 0, CHUNK, position);
    if (!bytesRead) break;
    if (bytesRead % PACKET) throw invalid('TS 讀取不完整');
    position += bytesRead;
    for (let offset = 0; offset < bytesRead; offset += PACKET) {
      const packet = read.subarray(offset, offset + PACKET);
      if ((((packet[1] & 31) << 8) | packet[2]) !== pid || !(packet[3] & 16)) continue;
      const control = (packet[3] >> 4) & 3;
      const begin = control & 2 ? 5 + packet[4] : 4;
      if (packet[1] & 64) {
        if (size) yield make();
        parts = []; size = 0;
        randomAccess = !!((control & 2) && packet[4] && (packet[5] & 64));
      } else if (!size) throw invalid(`PID ${pid} 缺少 PES 起點`);
      parts.push(Buffer.from(packet.subarray(begin)));
      size += PACKET - begin;
      if (size > 8 * 1024 * 1024) throw invalid('單一 PES 超過 8 MiB');
    }
  }
  if (size) yield make(pid === 48);
}

function pcrPacket(ticks) {
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes.set([0x47, 0x20, 48, 0x20, 183, 0x10]);
  const wrapped = ((ticks % (8589934592 * 300)) + 8589934592 * 300) % (8589934592 * 300);
  const base = Math.floor(wrapped / 300), extension = wrapped % 300;
  bytes[6] = Math.floor(base / 33554432); bytes[7] = Math.floor(base / 131072) & 255;
  bytes[8] = Math.floor(base / 512) & 255; bytes[9] = Math.floor(base / 2) & 255;
  bytes[10] = (base % 2) * 128 + 126 + (extension >> 8); bytes[11] = extension & 255;
  return bytes;
}
function mediaPacket(frame, pid) {
  const first = frame.offset === 0;
  const random = first && frame.randomAccess;
  const count = Math.min(random ? 182 : 184, frame.bytes.length - frame.offset);
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes.set([0x47, 0x20 | (first ? 64 : 0), pid, count === 184 ? 0x10 : 0x30]);
  if (count < 184) {
    bytes[4] = 183 - count;
    if (bytes[4]) bytes[5] = random ? 64 : 0;
  }
  frame.bytes.copy(bytes, PACKET - count, frame.offset, frame.offset + count);
  const elementary = Math.max(0, frame.offset + count - Math.max(frame.offset, frame.header));
  frame.offset += count;
  frame.retained += elementary;
  return { bytes, elementary };
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw invalid('無法寫入傳輸串流');
    offset += bytesWritten;
  }
}

// A lease directory can live on another volume. Copy in bounded chunks while
// the caller retains the output lease; cancellation leaves cleanup to that owner.
async function publishFromLease(temporary, output, signal) {
  signal?.throwIfAborted();
  const input = await open(temporary, 'r');
  let destination;
  try {
    destination = await open(output, 'w');
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(chunk);
      if (!bytesRead) break;
      await writeAll(destination, chunk.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    await destination.sync();
  } finally {
    await input.close();
    await destination?.close();
  }
}

/** Constant-rate T-STD packet scheduling. PES order and timestamps never change. */
async function reshapeAirlineTransport(format, output, { signal, tempDir } = {}) {
  signal?.throwIfAborted();
  const profile = airlineTransportProfile(format);
  const temporary = tempDir ? path.join(tempDir, `airline-${randomUUID()}.mux.tmp`)
    : `${output}.${randomUUID()}.mux.tmp`;
  const source = await open(output, 'r');
  let destination;
  try {
    const videoReader = elementaryPackets(source, 48, signal, format === 'airline-s3k');
    const audioReader = elementaryPackets(source, 49, signal);
    let video = (await videoReader.next()).value;
    let audio = (await audioReader.next()).value;
    if (!video || !audio) throw invalid('缺少影音 PES');
    // MPEG-1 uses a different sequence terminator; do not add AVC NALs.
    const s3k = format === 'airline-s3k';
    const origin = Math.min(video.dts - profile.initialLead, audio.dts - 0.12);
    if (origin < 0) throw invalid('解碼時間沒有足夠的初始預載區間');
    destination = await open(temporary, 'wx');
    const chunk = Buffer.allocUnsafe(CHUNK), counters = new Map();
    const queues = { 48: [], 49: [] }, retained = { 48: 0, 49: 0 };
    const stats = { transportPackets: 0, maximumVideoTb: 0, maximumVideoBuffer: 0,
      maximumAudioBuffer: 0, minimumDecodeLead: Infinity, muxRate: profile.muxRate };
    let buffered = 0, lastTbTime = origin, tb = 0, nextPcr = origin, nextPat = origin, nextPmt = origin;
    const step = PACKET * 8 / profile.muxRate;
    const enqueue = async bytes => {
      const pid = ((bytes[1] & 31) << 8) | bytes[2];
      const payload = !!(bytes[3] & 16);
      const cc = counters.has(pid) ? (counters.get(pid) + (payload ? 1 : 0)) & 15 : 0;
      counters.set(pid, cc); bytes[3] |= cc;
      bytes.copy(chunk, buffered); buffered += PACKET; stats.transportPackets++;
      if (buffered === CHUNK) { signal?.throwIfAborted(); await writeAll(destination, chunk); buffered = 0; }
    };
    while (video || audio) {
      const time = origin + stats.transportPackets * step;
      const arrival = time + step;
      tb = Math.max(0, tb - (arrival - lastTbTime) * profile.videoDrain / 8); lastTbTime = arrival;
      for (const pid of [48, 49]) {
        while (queues[pid].length && queues[pid][0].dts <= arrival) retained[pid] -= queues[pid].shift().retained;
      }
      if ((video && video.dts <= arrival) || (audio && audio.dts <= arrival)) throw invalid('影音封包超過 DTS 解碼期限');
      if (time >= nextPat) { await enqueue(table(0, s3k)); nextPat = time + 0.09; continue; }
      if (time >= nextPmt) { await enqueue(table(63, s3k)); nextPmt = time + 0.09; continue; }
      if (time >= nextPcr && tb + PACKET <= 400) {
        await enqueue(pcrPacket(Math.round((time + 12 * 8 / profile.muxRate) * CLOCK)));
        tb += PACKET; stats.maximumVideoTb = Math.max(stats.maximumVideoTb, tb); nextPcr = time + 0.05; continue;
      }
      const audioReady = audio && audio.dts - arrival <= 0.1 && retained[49] + 184 <= 3000;
      const videoReady = video && tb + PACKET <= 400 && retained[48] + 184 <= profile.videoBuffer - 2048;
      let frame, pid;
      if (audioReady) { frame = audio; pid = 49; }
      else if (videoReady) { frame = video; pid = 48; }
      if (!frame) {
        const bytes = Buffer.alloc(PACKET, 0xff); bytes.set([0x47, 0x1f, 0xff, 0x10]); await enqueue(bytes); continue;
      }
      if (!frame.offset) queues[pid].push(frame);
      const packet = mediaPacket(frame, pid);
      retained[pid] += packet.elementary;
      await enqueue(packet.bytes);
      if (pid === 48) { tb += PACKET; stats.maximumVideoTb = Math.max(stats.maximumVideoTb, tb); }
      stats.maximumVideoBuffer = Math.max(stats.maximumVideoBuffer, retained[48]);
      stats.maximumAudioBuffer = Math.max(stats.maximumAudioBuffer, retained[49]);
      stats.minimumDecodeLead = Math.min(stats.minimumDecodeLead, frame.dts - arrival);
      if (frame.offset === frame.bytes.length) {
        if (pid === 48) {
          video = (await videoReader.next()).value;
        } else audio = (await audioReader.next()).value;
      }
    }
    signal?.throwIfAborted();
    if (buffered) await writeAll(destination, chunk.subarray(0, buffered));
    await destination.sync(); await destination.close(); destination = null;
    await source.close();
    signal?.throwIfAborted();
    if (tempDir) await publishFromLease(temporary, output, signal);
    else await rename(temporary, output);
    return { ...stats, bytes: stats.transportPackets * PACKET };
  } finally {
    await source.close().catch(() => {});
    await destination?.close();
    await rm(temporary, { force: true });
  }
}

module.exports = { reshapeAirlineTransport };

'use strict';

const { open, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { airlineTransportProfile } = require('./airline-encoding');
const PACKET = 188;
const CHUNK = PACKET * 1024;
const CLOCK = 27000000;
// SCTE 128-1 / DVB AFD: registered T.35 user data, DTG1, active_format 10
// (full 16:9). Keep AUD first in each access unit, then insert this SEI.
const EXW_AFD_SEI = Buffer.from('000001060409b500314454473141fa80', 'hex');

function invalid(message) {
  const error = new Error(`航空 MPG 排程失敗：${message}`);
  error.code = 'INVALID_AIRLINE_TRANSPORT';
  return error;
}
function timestamp(bytes, offset) {
  return (bytes[offset] & 14) * 536870912 + bytes[offset + 1] * 4194304
    + (bytes[offset + 2] & 254) * 16384 + bytes[offset + 3] * 128 + (bytes[offset + 4] >> 1);
}
function writeTimestamp(bytes, offset, value) {
  const ticks = ((value % 8589934592) + 8589934592) % 8589934592;
  bytes[offset] = (bytes[offset] & 0xf0) | (Math.floor(ticks / 1073741824) & 7) * 2 | 1;
  bytes[offset + 1] = Math.floor(ticks / 4194304) & 255;
  bytes[offset + 2] = (Math.floor(ticks / 32768) & 127) * 2 | 1;
  bytes[offset + 3] = Math.floor(ticks / 128) & 255;
  bytes[offset + 4] = (ticks & 127) * 2 | 1;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc >>> 31) ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}
function table(pid) {
  const section = pid === 0 ? Buffer.from('00b00d0001c100000001e03f00000000', 'hex')
    : Buffer.from('02b0170001c10000e030f0001be030f0000fe031f00000000000', 'hex');
  section.writeUInt32BE(crc32(section.subarray(0, -4)), section.length - 4);
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes.set([0x47, 0x40 | (pid === 63 ? 0x20 : 0), pid, 0x10, 0]);
  section.copy(bytes, 5);
  return bytes;
}

function withExwAfd(bytes, header) {
  const prefix = bytes[header + 2] === 1 ? 3 : bytes[header + 2] === 0 && bytes[header + 3] === 1 ? 4 : 0;
  if (!prefix || (bytes[header + prefix] & 31) !== 9) throw invalid('exW 視訊缺少 Access Unit Delimiter');
  let next = -1;
  for (let i = header + prefix + 1; i < bytes.length - 3; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1
      || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) { next = i; break; }
  }
  if (next < 0) throw invalid('exW 視訊 Access Unit 缺少後續 NAL');
  const result = Buffer.concat([bytes.subarray(0, next), EXW_AFD_SEI, bytes.subarray(next)]);
  if (result.readUInt16BE(4)) result.writeUInt16BE(result.length - 6, 4);
  return result;
}

// Two independent sequential readers retain one PES each, regardless of movie
// length. No elementary sidecars or whole-movie packet index are created.
async function* elementaryPackets(file, pid, signal, exwAfd = false) {
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
    const end = Buffer.from([0, 0, 1, 11, 128]);
    if (last && pid === 48 && !bytes.subarray(-end.length).equals(end)) {
      bytes = Buffer.concat([bytes, Buffer.from([0, 0, 1, 10, 128, 0, 0, 1, 11, 128])]);
      if (bytes.readUInt16BE(4)) bytes.writeUInt16BE(bytes.length - 6, 4);
    }
    const header = 9 + bytes[8];
    if (pid === 48 && exwAfd) bytes = withExwAfd(bytes, header);
    return { bytes, pts, dts, randomAccess, offset: 0, header, retained: 0 };
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
function mediaPacket(frame, pid, randomPcrTicks = null) {
  const first = frame.offset === 0;
  const random = first && frame.randomAccess;
  const videoRandom = random && pid === 48;
  // TSA requires PCR in the same video packet that marks random access.
  // Seven adaptation bytes hold the flags and PCR, leaving 176 payload bytes.
  const count = Math.min(videoRandom ? 176 : random ? 182 : 184, frame.bytes.length - frame.offset);
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes.set([0x47, 0x20 | (first ? 64 : 0), pid, count === 184 ? 0x10 : 0x30]);
  if (count < 184) {
    bytes[4] = 183 - count;
    if (bytes[4]) bytes[5] = videoRandom ? 0x50 : random ? 0x40 : 0;
    if (videoRandom) pcrPacket(randomPcrTicks).copy(bytes, 6, 6, 12);
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

/** T-STD packet scheduling; exW omits idle null packets for VBR transport. */
async function reshapeAirlineTransport(format, output, { signal, tempDir } = {}) {
  signal?.throwIfAborted();
  const profile = airlineTransportProfile(format);
  const temporary = tempDir ? path.join(tempDir, `airline-${randomUUID()}.mux.tmp`)
    : `${output}.${randomUUID()}.mux.tmp`;
  const source = await open(output, 'r');
  let destination;
  try {
    const videoReader = elementaryPackets(source, 48, signal, format === 'airline-exw');
    const audioReader = elementaryPackets(source, 49, signal);
    let video = (await videoReader.next()).value;
    let audio = (await audioReader.next()).value;
    if (!video || !audio) throw invalid('缺少影音 PES');
    if (format === 'airline-exw') {
      // FFmpeg's native AAC-LC encoder emits one 1024-sample primer at -21.33 ms.
      // A PES may contain several ADTS frames (notably for quiet short clips).
      // Remove only the primer frame, retaining any programme frames in the
      // same PES, then move that PES's PTS to the first programme sample.
      if (Math.abs((video.pts - audio.pts) - 1024 / 48000) > 1 / 90000) {
        throw invalid('exW AAC 前導影格與影片起點不符');
      }
      const at = audio.header, bytes = audio.bytes;
      if (bytes.length - at < 7 || bytes[at] !== 0xff || (bytes[at + 1] & 0xf6) !== 0xf0) {
        throw invalid('exW AAC 前導不是 ADTS 影格');
      }
      const firstLength = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
      if (firstLength < 7 || at + firstLength > bytes.length) throw invalid('exW AAC 前導影格長度無效');
      if (at + firstLength === bytes.length) audio = (await audioReader.next()).value;
      else {
        audio.bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + firstLength)]);
        if (audio.bytes.readUInt16BE(4)) audio.bytes.writeUInt16BE(audio.bytes.length - 6, 4);
        writeTimestamp(audio.bytes, 9, timestamp(audio.bytes, 9) + 1920);
        audio.pts += 1024 / 48000;
        audio.dts += 1024 / 48000;
      }
      if (!audio || Math.abs(audio.pts - video.pts) > 1 / 90000) {
        throw invalid('exW AAC 正式音訊與影片起點不符');
      }
    }
    const origin = Math.min(video.dts - profile.initialLead, audio.dts - 0.12);
    if (origin < 0) throw invalid('解碼時間沒有足夠的初始預載區間');
    destination = await open(temporary, 'wx');
    const chunk = Buffer.allocUnsafe(CHUNK), counters = new Map();
    const queues = { 48: [], 49: [] }, retained = { 48: 0, 49: 0 };
    const stats = { transportPackets: 0, maximumVideoTb: 0, maximumVideoBuffer: 0,
      maximumAudioBuffer: 0, minimumDecodeLead: Infinity, muxRate: profile.muxRate };
    let buffered = 0, lastTbTime = origin, tb = 0, nextPcr = origin, nextPat = origin, nextPmt = origin, slots = 0;
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
      const time = origin + slots++ * step;
      const arrival = time + step;
      tb = Math.max(0, tb - (arrival - lastTbTime) * profile.videoDrain / 8); lastTbTime = arrival;
      for (const pid of [48, 49]) {
        while (queues[pid].length && queues[pid][0].dts <= arrival) retained[pid] -= queues[pid].shift().retained;
      }
      if ((video && video.dts <= arrival) || (audio && audio.dts <= arrival)) throw invalid('影音封包超過 DTS 解碼期限');
      if (time >= nextPat) { await enqueue(table(0)); nextPat = time + 0.09; continue; }
      if (time >= nextPmt) { await enqueue(table(63)); nextPmt = time + 0.09; continue; }
      if (time >= nextPcr && tb + PACKET <= 400) {
        await enqueue(pcrPacket(Math.round((time + 12 * 8 / profile.muxRate) * CLOCK)));
        tb += PACKET; stats.maximumVideoTb = Math.max(stats.maximumVideoTb, tb); nextPcr = time + 0.05; continue;
      }
      const audioReady = audio && audio.dts - arrival <= profile.audioLead && retained[49] + 184 <= 3000;
      const videoReady = video && tb + PACKET <= 400
        && retained[48] + 184 <= profile.videoBuffer - 2048;
      let frame, pid;
      if (audioReady) { frame = audio; pid = 49; }
      else if (videoReady) { frame = video; pid = 48; }
      if (!frame) {
        if (!profile.variableRate) {
          const bytes = Buffer.alloc(PACKET, 0xff); bytes.set([0x47, 0x1f, 0xff, 0x10]); await enqueue(bytes);
        }
        continue;
      }
      if (!frame.offset) queues[pid].push(frame);
      const random = pid === 48 && !frame.offset && frame.randomAccess;
      const packet = mediaPacket(frame, pid,
        random ? Math.round((time + 12 * 8 / profile.muxRate) * CLOCK) : null);
      retained[pid] += packet.elementary;
      await enqueue(packet.bytes);
      if (pid === 48) {
        tb += PACKET; stats.maximumVideoTb = Math.max(stats.maximumVideoTb, tb);
        if (random) nextPcr = time + 0.05;
      }
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

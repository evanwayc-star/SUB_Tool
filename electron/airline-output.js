'use strict';

const { open } = require('node:fs/promises');
const path = require('path');
const { getDeliveryFormatPreset } = require('../shared/delivery-formats.cjs');
const { reshapeAirlineTransport } = require('./airline-transport');

const TS_SIZE = 188;
const READ_SIZE = TS_SIZE * 1024;
const VIDEO_PID = 48;
const AUDIO_PID = 49;
const PMT_PID = 63;

function isAirlineOutput(format) {
  return getDeliveryFormatPreset(format)?.transport === 'airline';
}

function invalid(reason) {
  const error = new Error(`航空 MPG 傳輸串流無效：${reason}`);
  error.code = 'INVALID_AIRLINE_TRANSPORT';
  return error;
}

// MPEG-2 PSI CRC: non-reflected polynomial, initial 0xffffffff, no final xor.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc >>> 31) ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

// PSI may span TS packets and file-read chunks. Retain at most one 1024-byte
// section per PID, including the original file position of every section byte.
function sectionReader(tableId, onSection) {
  let bytes = [];
  let positions = [];
  let total = 0;
  function append(byte, position) {
    bytes.push(byte);
    positions.push(position);
    if (bytes.length === 3) {
      const length = ((bytes[1] & 15) << 8) | bytes[2];
      if (bytes[0] !== tableId || (bytes[1] & 0xf0) !== 0xb0 || length < 9 || length > 1021) {
        throw invalid('PAT／PMT section 標頭或長度錯誤');
      }
      total = length + 3;
    }
    if (total && bytes.length === total) {
      const section = Buffer.from(bytes);
      if (crc32(section) !== 0) throw invalid('PAT／PMT CRC 錯誤');
      if (!(section[5] & 1) || section[6] !== 0 || section[7] !== 0) throw invalid('PAT／PMT 必須是目前的單一 section');
      onSection(section, positions);
      bytes = [];
      positions = [];
      total = 0;
    }
  }
  function stuffing(payload, begin, end) {
    for (let index = begin; index < end; index++) {
      if (payload[index] !== 0xff) throw invalid('PSI section 後有非 stuffing 資料');
    }
  }
  return {
    payload(payload, position, start) {
      let index = 0;
      if (start) {
        const nextSection = 1 + payload[0];
        if (nextSection >= payload.length) throw invalid('PSI pointer 超出 payload');
        index = 1;
        while (index < nextSection && bytes.length) {
          append(payload[index], position + index);
          index++;
        }
        stuffing(payload, index, nextSection);
        if (bytes.length) throw invalid('PSI 新 section 起點前的 section 被截斷');
        index = nextSection;
      } else if (!bytes.length) throw invalid('PSI 缺少 section 起點');
      while (index < payload.length) {
        if (!bytes.length && (!start || payload[index] === 0xff)) {
          stuffing(payload, index, payload.length);
          break;
        }
        append(payload[index], position + index);
        index++;
      }
    },
    finish() { if (bytes.length) throw invalid('PAT／PMT section 被截斷'); },
  };
}

function createParser(format, patch) {
  const s3k = format === 'airline-s3k';
  const stats = { transportPackets: 0, patSections: 0, pmtSections: 0,
    videoPackets: 0, audioPackets: 0, pcrPackets: 0,
    priorityPackets: 0, replacedSdtPackets: 0, patchedPmtSections: 0 };
  const counters = new Map();
  const pat = sectionReader(0, section => {
    if (section.length !== 16 || section.readUInt16BE(3) !== 1
      || section.readUInt16BE(8) !== 1 || (section.readUInt16BE(10) & 8191) !== PMT_PID) {
      throw invalid('PAT 必須指定 Transport Stream 1、Program 1、PMT PID 63');
    }
    stats.patSections++;
  });
  const pmt = sectionReader(2, (section, positions) => {
    if (section.length < 26 || section.readUInt16BE(3) !== 1
      || (section.readUInt16BE(8) & 8191) !== VIDEO_PID) throw invalid('PMT 必須指定 Program 1 與 PCR PID 48');
    const end = section.length - 4;
    let index = 12 + (section.readUInt16BE(10) & 4095);
    const streams = new Map();
    while (index < end) {
      if (index + 5 > end) throw invalid('PMT stream 標頭被截斷');
      const pid = section.readUInt16BE(index + 1) & 8191;
      if (streams.has(pid)) throw invalid('PMT stream PID 重複');
      streams.set(pid, { type: section[index], offset: index });
      index += 5 + (section.readUInt16BE(index + 3) & 4095);
    }
    if (index !== end || streams.size !== 2
      || !streams.has(VIDEO_PID) || !streams.has(AUDIO_PID)) throw invalid('PMT 必須只有 PID 48 影片與 PID 49 音訊');
    const video = streams.get(VIDEO_PID);
    const audio = streams.get(AUDIO_PID);
    if (!(s3k ? [1, 2].includes(video.type) && audio.type === 3 : video.type === 0x1b && audio.type === 0x0f)) {
      throw invalid('PMT 影音 stream_type 與航空格式不符');
    }
    stats.pmtSections++;
    // FFmpeg labels MPEG-1 and MPEG-2 video as 0x02. S3K is MPEG-1; correct
    // only its PMT declaration and CRC, preserving every elementary byte.
    if (s3k && video.type === 2) {
      section[video.offset] = 1;
      section.writeUInt32BE(crc32(section.subarray(0, end)), end);
      patch?.(positions[video.offset], Buffer.from([1]));
      for (let i = end; i < section.length; i++) patch?.(positions[i], section.subarray(i, i + 1));
      stats.patchedPmtSections++;
    }
  });
  return {
    packet(packet, position) {
      stats.transportPackets++;
      if (packet[0] !== 0x47) throw invalid('TS 同步碼錯誤');
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (![0, 17, VIDEO_PID, AUDIO_PID, PMT_PID, 8191].includes(pid)) throw invalid(`不支援的 PID ${pid}`);
      if (packet[1] & 0x80) throw invalid('TS 封包標示傳輸錯誤');
      if (packet[3] & 0xc0) throw invalid('TS 封包已加密');
      const control = (packet[3] >> 4) & 3;
      if (!control) throw invalid('TS adaptation control 錯誤');
      let payload = 4;
      if (control & 2) {
        payload += 1 + packet[4];
        if (payload > TS_SIZE || ((control & 1) && payload === TS_SIZE)
          || (!(control & 1) && payload !== TS_SIZE)) throw invalid('TS adaptation field 長度錯誤');
        if (packet[4] && (packet[5] & 0x10)) {
          if (packet[4] < 7 || pid !== VIDEO_PID) throw invalid('PCR 必須位於 PID 48 的完整 adaptation field');
          stats.pcrPackets++;
        }
        if (packet[4] && (packet[5] & 0x80) && counters.has(pid)) throw invalid('TS 串流不連續');
      }
      if (pid === 17) {
        // Preserve its packet slot, PCR timing and mux rate while removing DVB SDT.
        const nullPacket = Buffer.alloc(TS_SIZE, 0xff);
        nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
        patch?.(position, nullPacket);
        stats.replacedSdtPackets++;
        return;
      }
      if (pid === 8191) return;
      const counter = packet[3] & 15;
      if (counters.has(pid) && counter !== ((counters.get(pid) + ((control & 1) ? 1 : 0)) & 15)) {
        throw invalid(`PID ${pid} continuity counter 錯誤`);
      }
      counters.set(pid, counter);
      if ([VIDEO_PID, AUDIO_PID, PMT_PID].includes(pid) && !(packet[1] & 0x20)) {
        patch?.(position + 1, Buffer.from([packet[1] | 0x20]));
        stats.priorityPackets++;
      }
      if (!(control & 1)) return;
      if (pid === VIDEO_PID) stats.videoPackets++;
      if (pid === AUDIO_PID) stats.audioPackets++;
      if (pid === 0 || pid === PMT_PID) {
        (pid === 0 ? pat : pmt).payload(packet.subarray(payload), position + payload, !!(packet[1] & 0x40));
      }
    },
    finish() {
      pat.finish();
      pmt.finish();
      if (!stats.patSections || !stats.pmtSections || !stats.videoPackets || !stats.audioPackets || !stats.pcrPackets) {
        throw invalid('缺少 PAT、PMT、影片、音訊或 PCR');
      }
      return stats;
    },
  };
}

async function readExact(file, buffer, length, position) {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw invalid('讀取時檔案被截斷');
    offset += bytesRead;
  }
}

async function writeExact(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw invalid('無法寫入封裝修正');
    offset += bytesWritten;
  }
}

/** Validate before writing; caller retains the output lease and owns cleanup. */
async function validateAndPatchAirlineOutput(format, outPath, { signal } = {}) {
  if (!isAirlineOutput(format)) return null;
  signal?.throwIfAborted();
  const file = await open(outPath, 'r+');
  try {
    const original = await file.stat();
    if (!original.isFile() || !original.size || original.size % TS_SIZE) throw invalid('檔案必須由完整的 188-byte TS 封包組成');
    const buffer = Buffer.allocUnsafe(READ_SIZE);
    let result;
    for (let pass = 0; pass < 2; pass++) {
      let chunkStart = 0;
      let modified = false;
      let earlier = [];
      const parser = createParser(format, pass === 0 ? null : (offset, bytes) => {
        if (offset < chunkStart) earlier.push({ offset, bytes: Buffer.from(bytes) });
        else { bytes.copy(buffer, offset - chunkStart); modified = true; }
      });
      for (chunkStart = 0; chunkStart < original.size; chunkStart += READ_SIZE) {
        signal?.throwIfAborted();
        const length = Math.min(READ_SIZE, original.size - chunkStart);
        await readExact(file, buffer, length, chunkStart);
        modified = false;
        earlier = [];
        for (let offset = 0; offset < length; offset += TS_SIZE) parser.packet(buffer.subarray(offset, offset + TS_SIZE), chunkStart + offset);
        signal?.throwIfAborted();
        if (pass === 1) {
          for (const change of earlier) await writeExact(file, change.bytes, change.offset);
          if (modified) await writeExact(file, buffer.subarray(0, length), chunkStart);
        }
      }
      result = parser.finish();
      if (pass === 0) {
        const current = await file.stat();
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw invalid('驗證期間檔案被修改');
        if (!result.priorityPackets && !result.replacedSdtPackets && !result.patchedPmtSections) break;
      }
    }
    signal?.throwIfAborted();
    await file.sync();
    return { ...result, bytes: original.size, outPath, requiresManzanita: false };
  } finally {
    await file.close();
  }
}

async function finalizeAirlineOutput(format, outPath, options = {}) {
  const validation = await validateAndPatchAirlineOutput(format, outPath, options);
  if (!validation) return null;
  const schedule = await reshapeAirlineTransport(format, outPath, options);
  return { ...validation, ...schedule };
}

module.exports = { isAirlineOutput, finalizeAirlineOutput, validateAndPatchAirlineOutput };

'use strict';

const { open } = require('node:fs/promises');

const TS_PACKET_SIZE = 188;
const READ_SIZE = TS_PACKET_SIZE * 1024;

function invalid(reason) {
  const error = new Error(`MOD-FHD 傳輸串流無效：${reason}`);
  error.code = 'INVALID_MOD_FHD_TRANSPORT';
  return error;
}

function checkCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('MOD-FHD 封裝已取消');
  error.name = 'AbortError';
  throw error;
}

// Parse framed elementary-stream bytes, never search compressed audio for sync words.
// Only the MPEG version bit changes; FFmpeg must encode AAC-LC with aac_pns=0.
function createParser(audioPid, onMpeg4Header) {
  const stats = { audioPid, transportPackets: 0, audioPackets: 0, audioFrames: 0,
    patchedFrames: 0, alreadyMpeg2Frames: 0 };
  let continuity = null;
  let pesHeader = null;
  let pesHeaderSize = 9;
  let pesRemaining = 0;
  let sawPes = false;
  const adts = [];
  let idOffset = 0;
  let frameRemaining = 0;

  function audioByte(byte, offset) {
    if (frameRemaining) { frameRemaining--; return; }
    if (adts.length === 1) idOffset = offset;
    adts.push(byte);
    if (adts.length !== 7) return;
    if (adts[0] !== 0xff || (adts[1] & 0xf6) !== 0xf0) throw invalid('ADTS 同步碼或 layer 錯誤');
    if (!(adts[1] & 1)) throw invalid('不支援含 CRC 的 ADTS');
    if ((adts[2] >> 6) !== 1) throw invalid('音訊必須是 AAC-LC');
    if (((adts[2] >> 2) & 15) !== 3) throw invalid('音訊必須是 48 kHz');
    if ((((adts[2] & 1) << 2) | (adts[3] >> 6)) !== 2) throw invalid('音訊必須是雙聲道');
    if (adts[6] & 3) throw invalid('每個 ADTS frame 必須只有一個 raw data block');
    const length = ((adts[3] & 3) << 11) | (adts[4] << 3) | (adts[5] >> 5);
    if (length <= 7) throw invalid('ADTS frame 長度錯誤');
    stats.audioFrames++;
    if (adts[1] & 8) stats.alreadyMpeg2Frames++;
    else {
      stats.patchedFrames++;
      onMpeg4Header?.(idOffset, adts[1] | 8);
    }
    frameRemaining = length - 7;
    adts.length = 0;
  }

  function pesByte(byte, offset) {
    if (pesHeader) {
      pesHeader.push(byte);
      if (pesHeader.length === 9) {
        if (pesHeader[0] !== 0 || pesHeader[1] !== 0 || pesHeader[2] !== 1 ||
            pesHeader[3] < 0xc0 || pesHeader[3] > 0xdf || (pesHeader[6] & 0xc0) !== 0x80) {
          throw invalid('音訊 PES 標頭錯誤');
        }
        pesHeaderSize = 9 + pesHeader[8];
        pesRemaining = ((pesHeader[4] << 8) | pesHeader[5]) - 3 - pesHeader[8];
        if (pesRemaining <= 0) throw invalid('音訊 PES 長度錯誤');
      }
      if (pesHeader.length === pesHeaderSize) pesHeader = null;
      return;
    }
    if (pesRemaining <= 0) throw invalid('PES payload 超出宣告長度');
    pesRemaining--;
    audioByte(byte, offset);
  }

  return {
    packet(packet, position) {
      stats.transportPackets++;
      if (packet[0] !== 0x47) throw invalid('TS 同步碼錯誤');
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (pid !== audioPid) return;
      if (packet[1] & 0x80) throw invalid('音訊 TS 封包標示傳輸錯誤');
      if (packet[3] & 0xc0) throw invalid('音訊 TS 封包已加密');
      const control = (packet[3] >> 4) & 3;
      if (!control) throw invalid('TS adaptation control 錯誤');
      let payload = 4;
      if (control & 2) {
        payload += 1 + packet[4];
        if (payload > TS_PACKET_SIZE || ((control & 1) && payload === TS_PACKET_SIZE)) {
          throw invalid('TS adaptation field 長度錯誤');
        }
        if (packet[4] && (packet[5] & 0x80) && continuity !== null) {
          throw invalid('音訊 TS 串流不連續');
        }
      }
      if (!(control & 1)) return;
      const counter = packet[3] & 15;
      if (continuity !== null && counter !== ((continuity + 1) & 15)) {
        throw invalid('音訊 TS continuity counter 錯誤');
      }
      continuity = counter;
      stats.audioPackets++;
      if (packet[1] & 0x40) {
        if (pesHeader || pesRemaining) throw invalid('前一個 PES 尚未結束');
        sawPes = true;
        pesHeader = [];
        pesHeaderSize = 9;
      } else if (!sawPes) throw invalid('音訊串流缺少 PES 起點');
      for (let i = payload; i < TS_PACKET_SIZE; i++) pesByte(packet[i], position + i);
    },
    finish() {
      if (!stats.audioFrames) throw invalid(`找不到 PID ${audioPid} 的 AAC 音訊`);
      if (pesHeader || pesRemaining || adts.length || frameRemaining) throw invalid('音訊 PES 或 ADTS frame 被截斷');
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

async function writeExact(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('無法寫入 MOD-FHD 封裝');
    offset += bytesWritten;
  }
}

/**
 * Set the ADTS MPEG-2 ID in a completed, exclusively leased FFmpeg TS output.
 * Validate the whole file before writing, then patch with bounded memory. The
 * caller owns failed/cancelled-output cleanup and must retain its output lease.
 */
async function finalizeModFhdTransport(outPath, { audioPid = 4130, signal } = {}) {
  if (!Number.isInteger(audioPid) || audioPid < 32 || audioPid >= 8191) throw new TypeError('MOD-FHD 音訊 PID 無效');
  checkCancelled(signal);
  const file = await open(outPath, 'r+');
  try {
    const original = await file.stat();
    if (!original.isFile() || !original.size || original.size % TS_PACKET_SIZE) throw invalid('檔案必須由完整的 188-byte TS 封包組成');
    const buffer = Buffer.allocUnsafe(READ_SIZE);
    let result;
    for (let pass = 0; pass < 2; pass++) {
      let chunkStart = 0;
      let modified = false;
      let earlier = [];
      const parser = createParser(audioPid, pass === 0 ? null : (offset, byte) => {
        if (offset < chunkStart) earlier.push({ offset, byte });
        else { buffer[offset - chunkStart] = byte; modified = true; }
      });
      for (chunkStart = 0; chunkStart < original.size; chunkStart += READ_SIZE) {
        checkCancelled(signal);
        const length = Math.min(READ_SIZE, original.size - chunkStart);
        await readExact(file, buffer, length, chunkStart);
        modified = false;
        earlier = [];
        for (let offset = 0; offset < length; offset += TS_PACKET_SIZE) {
          parser.packet(buffer.subarray(offset, offset + TS_PACKET_SIZE), chunkStart + offset);
        }
        checkCancelled(signal);
        if (pass === 1) {
          for (const patch of earlier) await writeExact(file, Buffer.from([patch.byte]), patch.offset);
          if (modified) await writeExact(file, buffer.subarray(0, length), chunkStart);
        }
      }
      result = parser.finish();
      if (pass === 0) {
        const current = await file.stat();
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw invalid('驗證期間檔案被修改');
        if (!result.patchedFrames) break;
      }
    }
    checkCancelled(signal);
    await file.sync();
    return { ...result, bytes: original.size };
  } finally {
    await file.close();
  }
}

module.exports = { finalizeModFhdTransport };

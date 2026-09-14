import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalizeAirlineOutput } from '../electron/airline-output.js';

const PAT = Buffer.from('00b00d0001c100000001e03fd69d4f8c', 'hex');
const PMT_S3K = Buffer.from('02b0170001c10000e030f00002e030f00003e031f000947a0d66', 'hex');
const PMT_S3K_FIXED = Buffer.from('02b0170001c10000e030f00001e030f00003e031f000110af078', 'hex');
const PMT_DMPES = Buffer.from('02b0170001c10000e030f0001be030f0000fe031f0004d74b7a8', 'hex');
let directory;
let output;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'subtool-airline-output-'));
  output = path.join(directory, 'output.mpg');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function packet(pid, payload, { start = false, counter = 0, pcr = false } = {}) {
  const bytes = Buffer.alloc(188, 0xff);
  bytes.set([0x47, (pid >> 8) | (start ? 0x40 : 0), pid & 255, counter | (payload.length === 184 ? 0x10 : 0x30)]);
  if (payload.length < 184) {
    bytes[4] = 183 - payload.length;
    if (bytes[4]) bytes[5] = pcr ? 0x10 : 0;
    if (pcr) bytes.set([0, 0, 0, 0, 0x7e, 0], 6);
  }
  payload.copy(bytes, 188 - payload.length);
  return bytes;
}

function psi(pid, section, { sizes = [], counter = 0 } = {}) {
  const payload = Buffer.concat([Buffer.from([0]), section]);
  const packets = [];
  for (let offset = 0; offset < payload.length;) {
    const size = Math.min(sizes[packets.length] || 184, payload.length - offset);
    packets.push(packet(pid, payload.subarray(offset, offset + size), { start: offset === 0, counter: (counter + packets.length) & 15 }));
    offset += size;
  }
  return packets;
}

const nullPacket = () => packet(8191, Buffer.alloc(184, 0xff));
function media() {
  return [packet(48, Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 1, 2, 3]), { start: true, pcr: true }),
    packet(49, Buffer.from([0, 0, 1, 0xc0, 0, 8, 0x80, 0, 0, 1, 2, 3, 4, 5]), { start: true })];
}
function fixture(format = 'airline-s3k') {
  return [...psi(0, PAT), ...psi(63, format === 'airline-s3k' ? PMT_S3K : PMT_DMPES), ...media(),
    packet(17, Buffer.alloc(184, 0xaa), { start: true }), nullPacket()];
}
async function convert(packets, format = 'airline-s3k', options) {
  await writeFile(output, Buffer.concat(packets));
  return finalizeAirlineOutput(format, output, options);
}

describe('航空內建 MPG 傳輸串流完成檢查', () => {
  it.each(['airline-s3k', 'airline-dmpes'])('%s 保留影音、PCR、PTS 與 packet 位置，完成 priority／SDT／PMT 修正', async format => {
    const packets = fixture(format);
    const expected = packets.map(bytes => Buffer.from(bytes));
    for (const index of [1, 2, 3]) expected[index][1] |= 0x20;
    if (format === 'airline-s3k') PMT_S3K_FIXED.copy(expected[1], 188 - PMT_S3K_FIXED.length);
    expected[4] = nullPacket();
    expect(await convert(packets, format)).toMatchObject({ outputPaths: [output], requiresManzanita: false,
      transportPackets: 6, patSections: 1, pmtSections: 1, videoPackets: 1, audioPackets: 1, pcrPackets: 1,
      priorityPackets: 3, replacedSdtPackets: 1, patchedPmtSections: format === 'airline-s3k' ? 1 : 0 });
    expect(await readFile(output)).toEqual(Buffer.concat(expected));
    expect(await finalizeAirlineOutput(format, output)).toMatchObject({ priorityPackets: 0, replacedSdtPackets: 0, patchedPmtSections: 0 });
    expect(await readFile(output)).toEqual(Buffer.concat(expected));
  });

  it.each([[3, 1, 4, 6, 9], [14, 10, 1, 1, 1]])('PMT 與 CRC 可跨多個 TS packet %j', async (...sizes) => {
    const first = psi(63, PMT_S3K, { sizes, counter: 14 });
    const expected = psi(63, PMT_S3K_FIXED, { sizes, counter: 14 });
    expected.forEach(bytes => { bytes[1] |= 0x20; });
    await convert([...psi(0, PAT), ...first, ...media()]);
    const result = await readFile(output);
    expect(result.subarray(188, 188 * (first.length + 1))).toEqual(Buffer.concat(expected));
  });

  it('PMT 修正的 stream_type 和 CRC 跨讀取區塊仍寫回正確位置', async () => {
    const fragments = psi(63, PMT_S3K, { sizes: [25] });
    const prefix = [...psi(0, PAT), ...Array.from({ length: 1022 }, nullPacket)];
    await convert([...prefix, ...fragments, ...media()]);
    const expected = psi(63, PMT_S3K_FIXED, { sizes: [25] });
    expected.forEach(bytes => { bytes[1] |= 0x20; });
    const result = await readFile(output);
    expect(result.subarray(188 * 1023, 188 * 1025)).toEqual(Buffer.concat(expected));
  });

  it('PUSI pointer 可先完成前一 section，再處理同一 payload 的新 section', async () => {
    const beginning = packet(63, Buffer.concat([Buffer.from([0]), PMT_S3K.subarray(0, 10)]), { start: true, counter: 15 });
    const continuation = packet(63, Buffer.concat([Buffer.from([16]), PMT_S3K.subarray(10), PMT_S3K]), { start: true });
    const result = await convert([...psi(0, PAT), beginning, continuation, ...media()]);
    expect(result).toMatchObject({ pmtSections: 2, patchedPmtSections: 2 });
    const fixed = await readFile(output);
    expect(fixed.subarray(188 * 3 - 26, 188 * 3)).toEqual(PMT_S3K_FIXED);
  });

  it('接受參考 DMPES PMT 的 AVC descriptors，保留 descriptor 原文', async () => {
    const reference = Buffer.from('02b02e0001c10000e030f0001be030f01728044d401e3f2a0f7f7f0000ea60019bfcc0000003e9bf0fe031f000324e45da', 'hex');
    await convert([...psi(0, PAT), ...psi(63, reference), ...media()], 'airline-dmpes');
    expect((await readFile(output)).subarray(188 * 2 - reference.length, 188 * 2)).toEqual(reference);
  });

  it.each(['sync', 'transport-error', 'scrambled', 'adaptation', 'continuity', 'unexpected-pid', 'crc', 'pointer', 'no-section-start', 'truncated-section', 'missing-audio', 'missing-pcr', 'wrong-codec'])('拒絕 %s，第一遍驗證失敗不得修改檔案', async fault => {
    const packets = fixture();
    if (fault === 'sync') packets[3][0] = 0;
    if (fault === 'transport-error') packets[3][1] |= 0x80;
    if (fault === 'scrambled') packets[3][3] |= 0x80;
    if (fault === 'adaptation') packets[3][4] = 255;
    if (fault === 'continuity') packets.push(Buffer.from(packets[0]));
    if (fault === 'unexpected-pid') packets[3][2] = 50;
    if (fault === 'crc') packets[1][187] ^= 1;
    if (fault === 'pointer') packets[1][188 - 27] = 27;
    if (fault === 'no-section-start') packets[1][1] &= 0xbf;
    if (fault === 'truncated-section') packets[1] = psi(63, PMT_S3K, { sizes: [10] })[0];
    if (fault === 'missing-audio') packets.splice(3, 1);
    if (fault === 'missing-pcr') packets[2][5] = 0;
    if (fault === 'wrong-codec') packets[1] = psi(63, PMT_DMPES)[0];
    const source = Buffer.concat(packets);
    await writeFile(output, source);
    await expect(finalizeAirlineOutput('airline-s3k', output)).rejects.toMatchObject({ code: 'INVALID_AIRLINE_TRANSPORT' });
    expect(await readFile(output)).toEqual(source);
  });

  it.each([0, 187, 189])('拒絕 %s bytes 的空白或不完整 TS', async length => {
    await writeFile(output, Buffer.alloc(length));
    await expect(finalizeAirlineOutput('airline-dmpes', output)).rejects.toThrow('188-byte');
  });

  it('取消會中止分塊驗證且釋放 handle，cleanup owner 能立刻刪除檔案', async () => {
    const source = Buffer.concat([...fixture(), ...Array.from({ length: 8192 }, nullPacket)]);
    await writeFile(output, source);
    const controller = new AbortController();
    const promise = finalizeAirlineOutput('airline-s3k', output, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(output)).toEqual(source);
    await rm(output);
  });

  it('取消在開檔前即拒絕，非航空格式不觸碰檔案', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(finalizeAirlineOutput('airline-dmpes', output, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await finalizeAirlineOutput('h264', output)).toBeNull();
  });
});

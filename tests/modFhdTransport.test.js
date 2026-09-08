import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalizeModFhdTransport } from '../electron/mod-fhd-transport.js';

let directory;
let output;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'subtool-mod-transport-test-'));
  output = path.join(directory, 'output.ts');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function adts(payload = Buffer.from([1, 2, 0xff, 0xf1, 0, 3]), mpeg2 = false) {
  const length = payload.length + 7;
  const header = Buffer.from([0xff, mpeg2 ? 0xf9 : 0xf1, 0x4c,
    0x80 | (length >> 11), (length >> 3) & 255, ((length & 7) << 5) | 31, 0xfc]);
  return Buffer.concat([header, payload]);
}

function packet(payload, { pid = 4130, start = false, counter = 0 } = {}) {
  const result = Buffer.alloc(188, 0xff);
  result[0] = 0x47;
  result[1] = (pid >> 8) | (start ? 0x40 : 0);
  result[2] = pid & 255;
  result[3] = (payload.length === 184 ? 0x10 : 0x30) | counter;
  if (payload.length < 184) {
    result[4] = 183 - payload.length;
    if (result[4]) result[5] = 0;
  }
  payload.copy(result, 188 - payload.length);
  return result;
}

function pes(frames, { sizes = [], counter = 0, pid = 4130 } = {}) {
  const body = Buffer.concat(frames);
  const length = body.length + 8;
  const bytes = Buffer.concat([Buffer.from([0, 0, 1, 0xc0, length >> 8, length & 255,
    0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), body]);
  const packets = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = Math.min(sizes[packets.length] || 184, bytes.length - offset);
    packets.push(packet(bytes.subarray(offset, offset + size), {
      pid, start: offset === 0, counter: (counter + packets.length) & 15,
    }));
    offset += size;
  }
  return packets;
}

const nullPacket = () => packet(Buffer.alloc(184, 0xff), { pid: 8191 });

async function convert(packets, options) {
  await writeFile(output, Buffer.concat(packets));
  return finalizeModFhdTransport(output, options);
}

function changes(before, after) {
  expect(after.length).toBe(before.length);
  return [...before.keys()].filter(index => before[index] !== after[index]);
}

describe('MOD-FHD MPEG-2 AAC transport finalization', () => {
  it('只修改 framed ADTS MPEG ID，保留 AAC payload、PID、PTS、PCR 與無關串流位元組', async () => {
    const source = Buffer.concat([nullPacket(), ...pes([adts(), adts()]),
      packet(Buffer.alloc(100, 0xf1), { pid: 4131, start: true }), nullPacket()]);
    await writeFile(output, source);
    const result = await finalizeModFhdTransport(output);
    const encoded = await readFile(output);
    expect(result).toMatchObject({ audioPid: 4130, audioFrames: 2, patchedFrames: 2, bytes: source.length });
    const modified = changes(source, encoded);
    expect(modified).toHaveLength(2);
    for (const index of modified) {
      expect(source[index]).toBe(0xf1);
      expect(encoded[index]).toBe(0xf9);
    }
  });

  it.each([[2, 3, 8, 3], [16, 1, 1, 1, 1, 1]])('接受跨 TS 封包的 PES 與 ADTS 標頭 %j', async (...sizes) => {
    const result = await convert(pes([adts()], { sizes }));
    expect(result).toMatchObject({ audioFrames: 1, patchedFrames: 1 });
  });

  it('ADTS ID 位元位於前一個讀取區塊時也能完成修正', async () => {
    const audio = pes([adts()], { sizes: [16] });
    const source = Buffer.concat([...Array.from({ length: 1023 }, nullPacket), ...audio]);
    await writeFile(output, source);
    expect(await finalizeModFhdTransport(output)).toMatchObject({ audioFrames: 1, patchedFrames: 1 });
    const modified = changes(source, await readFile(output));
    expect(modified).toHaveLength(1);
    expect(modified[0]).toBe(188 * 1024 - 1);
  });

  it('依 frame 長度跳過 payload 內的假同步碼，支援多個 AU 與 continuity wrap', async () => {
    const payload = Buffer.alloc(1200, 0xf1);
    adts().copy(payload, 50);
    const first = pes([adts(payload), adts()], { counter: 14 });
    const second = pes([adts()], { counter: (14 + first.length) & 15 });
    const result = await convert([...first, nullPacket(), ...second]);
    expect(result).toMatchObject({ audioFrames: 3, patchedFrames: 3 });
  });

  it('已是 MPEG-2 時不重複修改，重跑結果保持一致', async () => {
    await convert(pes([adts(), adts(undefined, true)]));
    const before = await readFile(output);
    expect(await finalizeModFhdTransport(output)).toMatchObject({ audioFrames: 2, patchedFrames: 0, alreadyMpeg2Frames: 2 });
    expect(await readFile(output)).toEqual(before);
  });

  it.each([
    ['非 LC', frame => { frame[2] &= 63; }],
    ['非 48 kHz', frame => { frame[2] = 0x50; }],
    ['非 stereo', frame => { frame[3] &= 63; }],
    ['含 CRC', frame => { frame[1] &= 0xfe; }],
    ['多個 raw block', frame => { frame[6] |= 1; }],
    ['ADTS layer', frame => { frame[1] |= 2; }],
    ['ADTS sync', frame => { frame[0] = 0xfe; }],
    ['超出 PES 的 frame 長度', frame => { frame[4] = 0xff; }],
    ['只有 ADTS header', frame => { frame[3] &= 0xfc; frame[4] = 0; frame[5] = 0xff; }],
  ])('拒絕 %s 且驗證失敗前不修改任何位元組', async (_label, corrupt) => {
    const bad = adts();
    corrupt(bad);
    const source = Buffer.concat(pes([adts(), bad]));
    await writeFile(output, source);
    await expect(finalizeModFhdTransport(output)).rejects.toMatchObject({ code: 'INVALID_MOD_FHD_TRANSPORT' });
    expect(await readFile(output)).toEqual(source);
  });

  it('PID 錯誤或缺少音訊時拒絕，不搜尋其他串流', async () => {
    await writeFile(output, Buffer.concat(pes([adts()])));
    await expect(finalizeModFhdTransport(output, { audioPid: 4131 })).rejects.toThrow('找不到 PID');
    await writeFile(output, nullPacket());
    await expect(finalizeModFhdTransport(output)).rejects.toThrow('找不到 PID');
  });

  it('明確指定其他音訊 PID 時只處理該 PID', async () => {
    expect(await convert(pes([adts()], { pid: 4100 }), { audioPid: 4100 }))
      .toMatchObject({ audioPid: 4100, audioFrames: 1, patchedFrames: 1 });
  });

  it.each(['sync', 'continuity', 'pes-length', 'pes-prefix', 'adaptation', 'scrambled', 'transport-error', 'no-pes-start'])('拒絕 %s 封包破損', async fault => {
    const packets = pes([adts(Buffer.alloc(500))]);
    if (fault === 'sync') packets[0][0] = 0;
    if (fault === 'continuity') packets[1][3] ^= 2;
    if (fault === 'pes-length') packets[0][8] = 0;
    if (fault === 'pes-prefix') packets[0][4] = 1;
    if (fault === 'adaptation') { packets[0][3] |= 0x20; packets[0][4] = 255; }
    if (fault === 'scrambled') packets[0][3] |= 0x80;
    if (fault === 'transport-error') packets[0][1] |= 0x80;
    if (fault === 'no-pes-start') packets[0][1] &= 0xbf;
    await expect(convert(packets)).rejects.toMatchObject({ code: 'INVALID_MOD_FHD_TRANSPORT' });
  });

  it('拒絕不完整 TS packet 與截斷的 PES', async () => {
    await writeFile(output, Buffer.alloc(187));
    await expect(finalizeModFhdTransport(output)).rejects.toThrow('188-byte');
    const packets = pes([adts(Buffer.alloc(500))]);
    await writeFile(output, Buffer.concat(packets.slice(0, -1)));
    await expect(finalizeModFhdTransport(output)).rejects.toThrow('截斷');
  });

  it('取消先於檔案讀寫，錯誤 PID 在開檔前拒絕', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(finalizeModFhdTransport(output, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(finalizeModFhdTransport(output, { audioPid: 8191 })).rejects.toBeInstanceOf(TypeError);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { validateAndPatchAirlineOutput, finalizeAirlineOutput } from '../electron/airline-output.js';
import { captureOutputAuthority, captureOutputDirectory, assertOutputAuthority } from '../electron/export-lease.js';

const PAT = Buffer.from('00b00d0001c100000001e03fd69d4f8c', 'hex');
const PMT_S3K = Buffer.from('02b0170001c10000e030f00002e030f00003e031f000947a0d66', 'hex');
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
function fixture() {
  return [...psi(0, PAT), ...psi(63, PMT_DMPES), ...media(),
    packet(17, Buffer.alloc(184, 0xaa), { start: true }), nullPacket()];
}
function muxFixture() {
  // One video/audio PES at 1 second leaves a real positive decode lead for the scheduler.
  const header = [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 5, 0xbf, 0x21];
  const audio = [...header]; audio[3] = 0xc0;
  return Buffer.concat([...psi(0, PAT), ...psi(63, PMT_DMPES),
    packet(48, Buffer.from([...header, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x80]), { start: true, pcr: true }),
    packet(49, Buffer.from([...audio, 0xff, 0xf1, 0x4c, 0x80, 1, 0x1f, 0xfc, 0]), { start: true })]);
}
async function convert(packets, format = 'airline-exw', options) {
  await writeFile(output, Buffer.concat(packets));
  return validateAndPatchAirlineOutput(format, output, options);
}

describe('航空內建 MPG 傳輸串流完成檢查', () => {
  it('private mux 的 wx 建立失敗不刪除原有同名檔案', async () => {
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    const occupied = path.join(lease, 'airline-collision.mux.tmp');
    fs.writeFileSync(occupied, 'foreign private-work bytes');
    const source = muxFixture(); fs.writeFileSync(output, source);
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer,
      require: name => name === 'node:crypto' ? { randomUUID: () => 'collision' } : require(name),
    });
    await expect(module.exports.reshapeAirlineTransport('airline-dmpes', output, { tempDir: lease }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.existsSync(occupied)).toBe(true);
    expect(fs.readFileSync(occupied, 'utf8')).toBe('foreign private-work bytes');
    expect(fs.readFileSync(output)).toEqual(source);
  });

  it('父目錄換成 junction 時不修改外來同名有效 TS', async () => {
    const picked = path.join(directory, 'picked'), outside = path.join(directory, 'outside');
    fs.mkdirSync(picked); fs.mkdirSync(outside);
    const stage = path.join(picked, '.delivery.stage.mpg');
    const source = Buffer.concat(fixture());
    fs.writeFileSync(stage, source);
    const authority = captureOutputAuthority(stage, captureOutputDirectory(picked));
    fs.renameSync(picked, path.join(directory, 'original'));
    fs.symlinkSync(outside, picked, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(outside, path.basename(stage)), source);
    await expect(finalizeAirlineOutput('airline-dmpes', stage, {
      tempDir: directory, assertOutput: () => assertOutputAuthority(authority, stage),
    })).rejects.toMatchObject({ code: 'UNSAFE_DELIVERY_OUTPUT' });
    expect(fs.readFileSync(stage)).toEqual(source);
    expect(fs.readFileSync(path.join(directory, 'original', path.basename(stage)))).toEqual(source);
  });

  it('開檔等待中 stage 被替換時不修改任一份，且釋放檔案 handle', async () => {
    const source = Buffer.concat(fixture());
    const foreign = Buffer.from(source); foreign[foreign.length - 1] ^= 1;
    fs.writeFileSync(output, source);
    const identity = fs.statSync(output, { bigint: true });
    const failure = Object.assign(new Error('stage 已換檔'), { code: 'UNSAFE_DELIVERY_STAGE' });
    const assertOutput = () => {
      if (fs.lstatSync(output, { bigint: true }).ino !== identity.ino) throw failure;
    };
    const moved = path.join(directory, 'original.mpg');
    const filename = new URL('../electron/airline-output.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), helper = { exports: {} }, module = { exports: {} };
    let handle;
    const open = async (file, flags, ...args) => {
      expect(file).toBe(output); expect(flags).toBe('r+');
      fs.renameSync(output, moved); fs.writeFileSync(output, foreign);
      handle = await promises.open(file, flags, ...args);
      return handle;
    };
    vm.runInNewContext(fs.readFileSync(new URL('../electron/owned-output-handle.js', import.meta.url), 'utf8'), {
      module: helper, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, require: name => name === './owned-output-handle' ? helper.exports : require(name),
    });
    await expect(module.exports.validateAndPatchAirlineOutput('airline-dmpes', output, { assertOutput })).rejects.toBe(failure);
    expect(handle?.fd).toBe(-1);
    expect(fs.readFileSync(output)).toEqual(foreign);
    expect(fs.readFileSync(moved)).toEqual(source);
    fs.unlinkSync(output); fs.unlinkSync(moved);
  });

  it('航空 patch 完成後 fd 實際關閉失敗必須回報可保留 stage 的錯誤', async () => {
    fs.writeFileSync(output, Buffer.concat(fixture()));
    const filename = new URL('../electron/airline-output.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), helper = { exports: {} }, module = { exports: {} };
    let handle, close;
    const open = async (...args) => {
      handle = await promises.open(...args); close = handle.close.bind(handle);
      handle.close = async () => { throw Object.assign(new Error('patch handle remains open'), { code: 'EBUSY' }); };
      return handle;
    };
    vm.runInNewContext(fs.readFileSync(new URL('../electron/owned-output-handle.js', import.meta.url), 'utf8'), {
      module: helper, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, require: name => name === './owned-output-handle' ? helper.exports : require(name),
    });
    try {
      const error = await module.exports.validateAndPatchAirlineOutput('airline-dmpes', output).catch(value => value);
      expect(error).toMatchObject({ code: 'OUTPUT_HANDLE_CLOSE_FAILED' });
      expect(error.message).toContain('patch handle remains open');
      expect(handle.fd).toBeGreaterThanOrEqual(0);
    } finally { await close?.(); }
  });

  it.each(['patch', 'publish', 'source'])('%s 開啟外來檔後原 stage 回復，仍拒絕使用外來 handle', async operation => {
    const source = operation === 'patch' ? Buffer.concat(fixture()) : muxFixture();
    const foreign = path.join(directory, 'foreign.mpg'), saved = path.join(directory, 'saved.mpg');
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    fs.writeFileSync(output, source); fs.writeFileSync(foreign, source);
    const identity = fs.lstatSync(output, { bigint: true });
    const assertOutput = () => {
      const now = fs.lstatSync(output, { bigint: true });
      if (now.dev !== identity.dev || now.ino !== identity.ino) throw new Error('stage 已換檔');
    };
    const filename = new URL(operation === 'patch' ? '../electron/airline-output.js' : '../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
    let replaced = false;
    const open = async (file, flags, ...args) => {
      if (file !== output || flags !== (operation === 'source' ? 'r' : 'r+') || replaced) return promises.open(file, flags, ...args);
      replaced = true;
      fs.renameSync(output, saved); fs.renameSync(foreign, output);
      const handle = await promises.open(file, flags, ...args);
      fs.renameSync(output, foreign); fs.renameSync(saved, output);
      return handle;
    };
    const helper = { exports: {} };
    vm.runInNewContext(fs.readFileSync(new URL('../electron/owned-output-handle.js', import.meta.url), 'utf8'), {
      module: helper, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, process, require: name => name === './owned-output-handle' ? helper.exports : require(name),
    });
    const run = operation === 'patch' ? module.exports.validateAndPatchAirlineOutput
      : module.exports.reshapeAirlineTransport;
    await expect(run('airline-dmpes', output, { tempDir: lease, assertOutput })).rejects.toMatchObject({ code: 'UNSAFE_DELIVERY_STAGE' });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(output)).toEqual(source);
    expect(fs.readFileSync(foreign)).toEqual(source);
    fs.unlinkSync(output); fs.unlinkSync(foreign); // 兩個 handle 必須已關閉
  });

  it('stage 在核對 handle 後、truncate 前換檔，不修改原 stage 與替代檔', async () => {
    const temporary = path.join(directory, 'mux.tmp'), original = path.join(directory, 'saved-stage.mpg');
    fs.writeFileSync(output, 'original stage'); fs.writeFileSync(temporary, 'new transport');
    const identity = fs.lstatSync(output, { bigint: true });
    const assertOutput = () => {
      const now = fs.lstatSync(output, { bigint: true });
      if (now.dev !== identity.dev || now.ino !== identity.ino) throw Object.assign(new Error('stage 已換檔'), { code: 'UNSAFE_DELIVERY_STAGE' });
    };
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), actual = require('./owned-output-handle'), module = { exports: {} };
    let replaced = false;
    const helper = { ...actual, async openOwnedOutput(file, flags, owner) {
      const handle = await actual.openOwnedOutput(file, flags, owner);
      if (file === output && flags === 'r+') queueMicrotask(() => {
        fs.renameSync(output, original); fs.writeFileSync(output, 'foreign stage'); replaced = true;
      });
      return handle;
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testPublish=publishFromLease;', {
      module, Buffer, process, require: name => name === './owned-output-handle' ? helper : require(name),
    });
    await expect(module.exports.testPublish(temporary, output, null, assertOutput)).rejects.toMatchObject({ code: 'UNSAFE_DELIVERY_STAGE' });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(original, 'utf8')).toBe('original stage');
    expect(fs.readFileSync(output, 'utf8')).toBe('foreign stage');
    expect(fs.readFileSync(temporary, 'utf8')).toBe('new transport');
  });

  it('航空重封裝發布前父目錄改向時保留 foreign stage，仍清除私有 mux 暫存', async () => {
    const picked = path.join(directory, 'picked'), outside = path.join(directory, 'outside'), lease = path.join(directory, 'lease');
    fs.mkdirSync(picked); fs.mkdirSync(outside); fs.mkdirSync(lease);
    const stage = path.join(picked, '.delivery.stage.mpg'), source = muxFixture();
    fs.writeFileSync(stage, source);
    const authority = captureOutputAuthority(stage, captureOutputDirectory(picked));
    let replaced = false;
    const signal = { throwIfAborted() {
      if (replaced || !fs.readdirSync(lease).some(name => fs.statSync(path.join(lease, name)).size > 0)) return;
      replaced = true;
      fs.renameSync(picked, path.join(directory, 'original'));
      fs.symlinkSync(outside, picked, process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(path.join(outside, path.basename(stage)), source);
    } };
    await expect(finalizeAirlineOutput('airline-dmpes', stage, {
      tempDir: lease, signal, assertOutput: () => assertOutputAuthority(authority, stage),
    })).rejects.toMatchObject({ code: 'UNSAFE_DELIVERY_OUTPUT' });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(stage)).toEqual(source);
    expect(fs.readdirSync(lease)).toEqual([]);
  });

  it('私有 mux 關閉後被替換時保留替代檔與原 mux，拒絕發佈並回報清理錯誤', async () => {
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    const source = muxFixture(); fs.writeFileSync(output, source);
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
    let foreign, original;
    const open = async (file, flags, ...args) => {
      const handle = await promises.open(file, flags, ...args);
      if (flags === 'wx' && path.dirname(file) === lease) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          foreign = file; original = file + '.original';
          fs.renameSync(file, original); fs.writeFileSync(file, 'foreign replacement data');
        };
      }
      return handle;
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, process, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    const result = await module.exports.reshapeAirlineTransport('airline-dmpes', output, { tempDir: lease }).catch(error => error);
    expect(result).toMatchObject({ code: 'AIRLINE_TEMP_CLEANUP_FAILED' });
    expect(fs.readFileSync(output)).toEqual(source);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign replacement data');
    expect(fs.statSync(original).size).toBeGreaterThan(0);
  });

  it('私有 mux 在已驗證父目錄中消失時視為已清理', async () => {
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    fs.writeFileSync(output, muxFixture());
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
    let removed;
    const open = async (file, flags, ...args) => {
      const handle = await promises.open(file, flags, ...args);
      if (flags === 'r' && path.dirname(file) === lease) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); removed = file; fs.unlinkSync(file); };
      }
      return handle;
    };
    const helper = { exports: {} };
    vm.runInNewContext(fs.readFileSync(new URL('../electron/owned-output-handle.js', import.meta.url), 'utf8'), {
      module: helper, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, process, require: name => name === 'node:fs/promises' ? { ...promises, open }
        : name === './owned-output-handle' ? helper.exports : require(name),
    });
    await expect(module.exports.reshapeAirlineTransport('airline-dmpes', output, { tempDir: lease })).resolves.toMatchObject({ bytes: expect.any(Number) });
    expect(removed).toBeTruthy();
    expect(fs.existsSync(removed)).toBe(false);
    expect(fs.readdirSync(lease)).toEqual([]);
  });

  it('mux 父目錄換成同名新目錄後，即使新目錄中沒有 mux 也不得視為已清理', async () => {
    const lease = path.join(directory, 'lease'), moved = path.join(directory, 'original-lease'); fs.mkdirSync(lease);
    const source = muxFixture(); fs.writeFileSync(output, source);
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
    let replaced = false;
    const open = async (file, flags, ...args) => {
      const handle = await promises.open(file, flags, ...args);
      if (flags === 'wx' && path.dirname(file) === lease) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); fs.renameSync(lease, moved); fs.mkdirSync(lease); replaced = true; };
      }
      return handle;
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, process, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    const error = await module.exports.reshapeAirlineTransport('airline-dmpes', output, { tempDir: lease }).catch(value => value);
    expect(error).toMatchObject({ code: 'AIRLINE_TEMP_CLEANUP_FAILED' });
    expect(replaced).toBe(true);
    expect(fs.readdirSync(lease)).toEqual([]);
    expect(fs.readdirSync(moved)).toHaveLength(1);
    expect(fs.readFileSync(output)).toEqual(source);
  });

  it('私有 mux handle 實際未關閉時保留檔案並回報清理失敗', async () => {
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    const source = muxFixture(); fs.writeFileSync(output, source);
    const filename = new URL('../electron/airline-transport.js', import.meta.url);
    const require = createRequire(filename), promises = require('node:fs/promises'), module = { exports: {} };
    let handle, close, temporary;
    const open = async (file, flags, ...args) => {
      const result = await promises.open(file, flags, ...args);
      if (flags === 'wx' && path.dirname(file) === lease) {
        handle = result; temporary = file; close = result.close.bind(result);
        result.close = async () => { throw Object.assign(new Error('injected close failure'), { code: 'EBUSY' }); };
      }
      return result;
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, Buffer, process, require: name => name === 'node:fs/promises' ? { ...promises, open } : require(name),
    });
    try {
      const error = await module.exports.reshapeAirlineTransport('airline-dmpes', output, { tempDir: lease }).catch(value => value);
      expect(error).toMatchObject({ code: 'AIRLINE_TEMP_HANDLE_CLOSE_FAILED' });
      expect(error.message).toContain('injected close failure');
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect(fs.statSync(temporary).size).toBeGreaterThan(0);
      expect(fs.readFileSync(output)).toEqual(source);
    } finally { await close?.(); }
  });

  it('有 owner 的航空重封裝成功保留 stage inode，內容確實重新排程且清掉 mux 暫存', async () => {
    const lease = path.join(directory, 'lease'); fs.mkdirSync(lease);
    const source = muxFixture(); fs.writeFileSync(output, source);
    const identity = fs.statSync(output, { bigint: true });
    const assertOutput = () => expect(fs.lstatSync(output, { bigint: true }).ino).toBe(identity.ino);
    const result = await finalizeAirlineOutput('airline-dmpes', output, { tempDir: lease, assertOutput });
    const bytes = fs.readFileSync(output);
    expect(result.bytes).toBe(bytes.length);
    expect(bytes.length % 188).toBe(0);
    expect(bytes.equals(source)).toBe(false);
    expect(result.minimumDecodeLead).toBeGreaterThan(0);
    expect(result.maximumAudioBuffer).toBeGreaterThan(0);
    expect(fs.readdirSync(lease)).toEqual([]);
    assertOutput();
  });

  it.each(['airline-exw', 'airline-dmpes'])('%s 保留影音、PCR、PTS 與 packet 位置，完成 priority／SDT 修正', async format => {
    const packets = fixture();
    const expected = packets.map(bytes => Buffer.from(bytes));
    for (const index of [1, 2, 3]) expected[index][1] |= 0x20;
    expected[4] = nullPacket();
    expect(await convert(packets, format)).toMatchObject({ outPath: output, requiresManzanita: false,
      transportPackets: 6, patSections: 1, pmtSections: 1, videoPackets: 1, audioPackets: 1, pcrPackets: 1,
      priorityPackets: 3, replacedSdtPackets: 1, patchedPmtSections: 0 });
    expect(await readFile(output)).toEqual(Buffer.concat(expected));
    expect(await validateAndPatchAirlineOutput(format, output)).toMatchObject({ priorityPackets: 0, replacedSdtPackets: 0, patchedPmtSections: 0 });
    expect(await readFile(output)).toEqual(Buffer.concat(expected));
  });

  it.each([[3, 1, 4, 6, 9], [14, 10, 1, 1, 1]])('PMT 與 CRC 可跨多個 TS packet %j', async (...sizes) => {
    const first = psi(63, PMT_DMPES, { sizes, counter: 14 });
    const expected = psi(63, PMT_DMPES, { sizes, counter: 14 });
    expected.forEach(bytes => { bytes[1] |= 0x20; });
    await convert([...psi(0, PAT), ...first, ...media()]);
    const result = await readFile(output);
    expect(result.subarray(188, 188 * (first.length + 1))).toEqual(Buffer.concat(expected));
  });

  it('PMT 與 CRC 跨讀取區塊仍維持正確位置', async () => {
    const fragments = psi(63, PMT_DMPES, { sizes: [25] });
    const prefix = [...psi(0, PAT), ...Array.from({ length: 1022 }, nullPacket)];
    await convert([...prefix, ...fragments, ...media()]);
    const expected = psi(63, PMT_DMPES, { sizes: [25] });
    expected.forEach(bytes => { bytes[1] |= 0x20; });
    const result = await readFile(output);
    expect(result.subarray(188 * 1023, 188 * 1025)).toEqual(Buffer.concat(expected));
  });

  it('PUSI pointer 可先完成前一 section，再處理同一 payload 的新 section', async () => {
    const beginning = packet(63, Buffer.concat([Buffer.from([0]), PMT_DMPES.subarray(0, 10)]), { start: true, counter: 15 });
    const continuation = packet(63, Buffer.concat([Buffer.from([16]), PMT_DMPES.subarray(10), PMT_DMPES]), { start: true });
    const result = await convert([...psi(0, PAT), beginning, continuation, ...media()]);
    expect(result).toMatchObject({ pmtSections: 2, patchedPmtSections: 0 });
    const fixed = await readFile(output);
    expect(fixed.subarray(188 * 3 - 26, 188 * 3)).toEqual(PMT_DMPES);
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
    if (fault === 'truncated-section') packets[1] = psi(63, PMT_DMPES, { sizes: [10] })[0];
    if (fault === 'missing-audio') packets.splice(3, 1);
    if (fault === 'missing-pcr') packets[2][5] = 0;
    if (fault === 'wrong-codec') packets[1] = psi(63, PMT_S3K)[0];
    const source = Buffer.concat(packets);
    await writeFile(output, source);
    await expect(validateAndPatchAirlineOutput('airline-exw', output)).rejects.toMatchObject({ code: 'INVALID_AIRLINE_TRANSPORT' });
    expect(await readFile(output)).toEqual(source);
  });

  it.each([0, 187, 189])('拒絕 %s bytes 的空白或不完整 TS', async length => {
    await writeFile(output, Buffer.alloc(length));
    await expect(validateAndPatchAirlineOutput('airline-dmpes', output)).rejects.toThrow('188-byte');
  });

  it('取消會中止分塊驗證且釋放 handle，cleanup owner 能立刻刪除檔案', async () => {
    const source = Buffer.concat([...fixture(), ...Array.from({ length: 8192 }, nullPacket)]);
    await writeFile(output, source);
    const controller = new AbortController();
    const promise = validateAndPatchAirlineOutput('airline-exw', output, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(output)).toEqual(source);
    await rm(output);
  });

  it('取消在開檔前即拒絕，非航空格式不觸碰檔案', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(validateAndPatchAirlineOutput('airline-dmpes', output, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await validateAndPatchAirlineOutput('h264', output)).toBeNull();
  });
});

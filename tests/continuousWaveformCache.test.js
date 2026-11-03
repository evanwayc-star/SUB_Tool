import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { openContinuousWaveformCache, readCompleteContinuousWaveformCache, inspectContinuousWaveformCache,
  isContinuousWaveformCachePath, MAX_TOTAL_SAMPLES, MAX_TRANSFER_BYTES } = require('../electron/continuous-waveform-cache');
const roots = [], writers = [];
function fixture(totalSamples = 120000) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-continuous-wave-test-')); roots.push(root);
  const spec = { version: 1, sharedSourceKey: 'a'.repeat(64), audio: [{ channels: 2, timestampOffset: 0 }], totalSamples };
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let index = 0; index < totalSamples; index++) pcm.writeInt16LE((index * 97) % 20000 - 10000, index * 2);
  const generations = () => fs.existsSync(path.join(root, 'continuous-waveforms'))
    ? fs.readdirSync(path.join(root, 'continuous-waveforms')).map(name => path.join(root, 'continuous-waveforms', name)) : [];
  const open = options => { const writer = openContinuousWaveformCache(root, spec, options); writers.push(writer); return writer; };
  return { root, spec, pcm, generations, open };
}
afterEach(() => {
  for (const writer of writers.splice(0)) { try { writer.close(); } catch (_) {} }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const actual = fs.realpathSync(root);
    if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('subtool-continuous-wave-test-')) throw new Error('拒絕清理外部路徑');
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

describe('單檔連續波形的持久進度與所有權', () => {
  it('真子程序未呼叫 close 就退出，另一程序 owner 僅恢復 checkpoint 而忽略較長檔尾', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, 'input.pcm'), f.pcm);
    const script = `const fs=require('node:fs'),path=require('node:path');
      const {openContinuousWaveformCache}=require(${JSON.stringify(path.resolve('electron/continuous-waveform-cache.js'))});
      const root=process.argv[1],pcm=fs.readFileSync(path.join(root,'input.pcm'));
      const writer=openContinuousWaveformCache(root,${JSON.stringify(f.spec)});
      writer.appendPCM(pcm.subarray(0,80000));writer.checkpoint();writer.appendPCM(pcm.subarray(80000,82000));
      process.exit(0);`;
    const child = spawnSync(process.execPath, ['-e', script, f.root], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const original = path.join(f.generations()[0], 'partial.wav'), before = fs.readFileSync(original);
    expect(before.length).toBe(82044);
    const resumed = f.open(); expect(resumed.completedSamples).toBe(40000); expect(resumed.writtenSamples).toBe(40000);
    resumed.appendPCM(f.pcm.subarray(80000)); expect(fs.readFileSync(resumed.complete()).subarray(44)).toEqual(f.pcm);
    expect(fs.readFileSync(original)).toEqual(before);
  });

  it('崩潰後忽略未 checkpoint 尾端，新 writer 僅複製已確認 PCM 並完成逐 sample 相同的 WAV', () => {
    const f = fixture(), first = f.open();
    first.appendPCM(f.pcm.subarray(0, 80000)); expect(first.checkpoint()).toBe(40000);
    first.appendPCM(f.pcm.subarray(80000, 82000));
    const original = path.join(f.generations()[0], 'partial.wav');
    first.close(); const retained = fs.readFileSync(original);
    expect(inspectContinuousWaveformCache(f.root, { spec: f.spec })).toMatchObject({ retained: true, completedSamples: 40000, isComplete: false });
    const resumed = f.open();
    expect(resumed.writtenSamples).toBe(40000); expect(resumed.completedSamples).toBe(40000);
    expect(resumed.readPCM(32000, 8000)).toEqual(f.pcm.subarray(64000, 80000));
    expect(() => resumed.readPCM(40000, 1)).toThrow('已確認範圍');
    resumed.appendPCM(f.pcm.subarray(80000)); const wave = resumed.complete();
    const bytes = fs.readFileSync(wave);
    expect(bytes.length).toBe(44 + f.pcm.length); expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.readUInt16LE(22)).toBe(1); expect(bytes.readUInt32LE(24)).toBe(4000);
    expect(bytes.readUInt16LE(34)).toBe(16); expect(bytes.readUInt32LE(40)).toBe(f.pcm.length);
    expect(bytes.subarray(44)).toEqual(f.pcm); expect(fs.readFileSync(original)).toEqual(retained);
    expect(resumed.isComplete).toBe(true); expect(resumed.wavePath).toBe(wave);
    expect(fs.readdirSync(path.dirname(wave)).sort()).toEqual(['checkpoint.json', 'wave.wav']);
  });

  it('兩個仍存活的 writer 各自累積與發布，不改寫另一個 writer 的 prefix 或完成檔', () => {
    const f = fixture(), first = f.open(); first.appendPCM(f.pcm.subarray(0, 40000)); first.checkpoint();
    const firstPartial = path.join(f.generations()[0], 'partial.wav');
    const second = f.open(); expect(second.completedSamples).toBe(20000);
    first.appendPCM(f.pcm.subarray(40000, 60000)); first.checkpoint();
    const held = fs.readFileSync(firstPartial);
    second.appendPCM(f.pcm.subarray(40000)); const secondWave = second.complete();
    expect(fs.readFileSync(firstPartial)).toEqual(held);
    first.appendPCM(f.pcm.subarray(60000)); const firstWave = first.complete();
    expect(firstWave).not.toBe(secondWave);
    expect(fs.readFileSync(firstWave).subarray(44)).toEqual(f.pcm);
    expect(fs.readFileSync(secondWave).subarray(44)).toEqual(f.pcm);
  });

  it('完整產物優先於更晚 partial，warm 讀取不建立新 generation 並保持唯讀', () => {
    const f = fixture(), first = f.open(), second = f.open();
    first.appendPCM(f.pcm); const wave = first.complete();
    second.appendPCM(f.pcm.subarray(0, 20000)); second.checkpoint(); second.close();
    const before = f.generations();
    const hit = f.open(); expect(hit.isComplete).toBe(true); expect(hit.wavePath).toBe(wave);
    expect(hit.completedSamples).toBe(f.spec.totalSamples); expect(hit.totalSamples).toBe(f.spec.totalSamples);
    expect(hit.readPCM(0, 1000)).toEqual(f.pcm.subarray(0, 2000));
    expect(() => hit.appendPCM(Buffer.alloc(2))).toThrow('唯讀'); expect(f.generations()).toEqual(before);
    const complete = readCompleteContinuousWaveformCache(f.root, f.spec);
    expect(complete.wavePath).toBe(wave); expect(() => complete.verify()).not.toThrow();
    expect(f.generations()).toEqual(before); expect(isContinuousWaveformCachePath(wave)).toBe(true);
  });

  it('ignoreCached 強制開全新 writer，不沿用完整或 partial 且保留原檔內容', () => {
    const f = fixture(), partial = f.open();
    partial.appendPCM(f.pcm.subarray(0, 40000)); partial.checkpoint(); partial.close();
    const partialPath = path.join(f.generations()[0], 'partial.wav'), partialBytes = fs.readFileSync(partialPath);
    const first = f.open(); first.appendPCM(f.pcm.subarray(40000));
    const originalWave = first.complete(), originalBytes = fs.readFileSync(originalWave), count = f.generations().length;
    const fresh = f.open({ ignoreCached: true });
    expect(fresh.isComplete).toBe(false); expect(fresh.completedSamples).toBe(0); expect(fresh.writtenSamples).toBe(0);
    expect(f.generations()).toHaveLength(count + 1);
    fresh.appendPCM(f.pcm); const newWave = fresh.complete();
    expect(newWave).not.toBe(originalWave); expect(fs.readFileSync(newWave).subarray(44)).toEqual(f.pcm);
    expect(fs.readFileSync(originalWave)).toEqual(originalBytes); expect(fs.readFileSync(partialPath)).toEqual(partialBytes);
  });

  it('來源證據、聲道配置、來源 offset 或總 sample 數不同均不可接續舊 prefix', () => {
    const f = fixture(), first = f.open(); first.appendPCM(f.pcm.subarray(0, 20000)); first.checkpoint(); first.close();
    for (const spec of [{ ...f.spec, sharedSourceKey: 'b'.repeat(64) }, { ...f.spec, audio: [{ channels: 1 }] },
      { ...f.spec, audio: [{ channels: 2, timestampOffset: .25 }] }, { ...f.spec, totalSamples: f.spec.totalSamples + 1 }]) {
      expect(inspectContinuousWaveformCache(f.root, { spec })).toMatchObject({ retained: false, completedSamples: 0 });
      const next = openContinuousWaveformCache(f.root, spec); writers.push(next); expect(next.completedSamples).toBe(0);
    }
  });

  it('同 inode 等長破壞已確認 prefix，重開不認領且保留損壞現場', () => {
    const f = fixture(), first = f.open(); first.appendPCM(f.pcm.subarray(0, 80000)); first.checkpoint(); first.close();
    const partial = path.join(f.generations()[0], 'partial.wav'), original = fs.statSync(partial, { bigint: true });
    const bytes = fs.readFileSync(partial); bytes[45] ^= 127; fs.writeFileSync(partial, bytes);
    expect(fs.statSync(partial, { bigint: true }).ino).toBe(original.ino);
    expect(inspectContinuousWaveformCache(f.root, { spec: f.spec })).toMatchObject({ retained: false, uncertain: true });
    expect(f.open().completedSamples).toBe(0); expect(fs.readFileSync(partial)).toEqual(bytes);
  });

  it('來源撤銷後不再 append 或發布新 checkpoint，先前已確認資料仍可供新工作使用', () => {
    const f = fixture(); let valid = true;
    const writer = f.open({ verify: () => { if (!valid) throw new Error('source changed'); } });
    writer.appendPCM(f.pcm.subarray(0, 20000)); writer.checkpoint(); valid = false;
    expect(() => writer.appendPCM(f.pcm.subarray(20000, 22000))).toThrow('source changed');
    expect(() => writer.checkpoint()).toThrow('source changed'); writer.close();
    expect(inspectContinuousWaveformCache(f.root, { spec: f.spec })).toMatchObject({ retained: true, completedSamples: 10000 });
  });

  it('checkpoint 寫好後取消，不替取消工作更新進度且清除自身 metadata 暫存', () => {
    const f = fixture(); let cancelling = false;
    const writer = f.open({ verify: () => {
      if (cancelling && f.generations().some(dir => fs.readdirSync(dir).some(name => name.startsWith('.checkpoint-')))) throw new Error('cancelled');
    } });
    writer.appendPCM(f.pcm.subarray(0, 20000)); writer.checkpoint();
    const generation = f.generations()[0], before = fs.readFileSync(path.join(generation, 'checkpoint.json'));
    writer.appendPCM(f.pcm.subarray(20000, 22000)); cancelling = true;
    expect(() => writer.checkpoint()).toThrow('cancelled'); writer.close();
    expect(fs.readFileSync(path.join(generation, 'checkpoint.json'))).toEqual(before);
    expect(fs.readdirSync(generation).sort()).toEqual(['checkpoint.json', 'partial.wav']);
  });

  it('writer 關檔後父目錄被替換，不發布或清理替代目錄', () => {
    const f = fixture(), nativeOpen = fs.openSync.bind(fs), nativeClose = fs.closeSync.bind(fs);
    const namespace = path.join(f.root, 'continuous-waveforms'), retained = path.join(f.root, 'retained');
    let ownedFd;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const fd = nativeOpen(file, flags, ...args); if (flags === 'wx+') ownedFd = fd; return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      nativeClose(fd); if (fd !== ownedFd) return; ownedFd = undefined;
      fs.renameSync(namespace, retained); fs.mkdirSync(namespace); fs.writeFileSync(path.join(namespace, 'foreign'), 'FOREIGN');
    });
    const writer = f.open(); writer.appendPCM(f.pcm); writer.checkpoint();
    const generation = path.basename(f.generations()[0]), before = fs.readFileSync(path.join(namespace, generation, 'partial.wav'));
    expect(() => writer.complete()).toThrow(); writer.close();
    expect(fs.readFileSync(path.join(retained, generation, 'partial.wav'))).toEqual(before);
    expect(fs.readFileSync(path.join(namespace, 'foreign'), 'utf8')).toBe('FOREIGN');
  });

  it.each(['timestamp', 'content'])('writer close 更新 %s 時，只接受相同 PCM 的正常 NAS 時間更新', mode => {
    const f = fixture(), nativeOpen = fs.openSync.bind(fs), nativeClose = fs.closeSync.bind(fs);
    let ownedFd, partial;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const fd = nativeOpen(file, flags, ...args);
      if (flags === 'wx+' && path.basename(file) === 'partial.wav') { ownedFd = fd; partial = file; }
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      nativeClose(fd);
      if (fd !== ownedFd) return;
      ownedFd = undefined;
      if (mode === 'timestamp') { const before = fs.statSync(partial); fs.utimesSync(partial, before.atime, new Date(before.mtimeMs + 2000)); }
      else { const bytes = fs.readFileSync(partial); bytes[44] ^= 127; fs.writeFileSync(partial, bytes); }
    });
    const writer = f.open(); writer.appendPCM(f.pcm);
    if (mode === 'timestamp') expect(fs.readFileSync(writer.complete()).subarray(44)).toEqual(f.pcm);
    else { expect(() => writer.complete()).toThrow(); expect(fs.existsSync(partial)).toBe(true); expect(readCompleteContinuousWaveformCache(f.root, f.spec)).toBeNull(); }
  });

  it('完整 rename 後完成 receipt 失敗，另一 writer 可恢復 full prefix 而不重新解碼', () => {
    const f = fixture(), writer = f.open(); writer.appendPCM(f.pcm);
    const nativeRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(to) === 'checkpoint.json' && fs.existsSync(path.join(path.dirname(to), 'wave.wav'))) throw new Error('receipt failure');
      return nativeRename(from, to);
    });
    expect(() => writer.complete()).toThrow('receipt failure'); writer.close(); vi.restoreAllMocks();
    expect(readCompleteContinuousWaveformCache(f.root, f.spec)).toBeNull();
    const resumed = f.open(); expect(resumed.completedSamples).toBe(f.spec.totalSamples); expect(resumed.isComplete).toBe(false);
    expect(fs.readFileSync(resumed.complete()).subarray(44)).toEqual(f.pcm);
  });

  it('外部替換 checkpoint 後不覆寫其內容', () => {
    const f = fixture(), writer = f.open(), record = path.join(f.generations()[0], 'checkpoint.json');
    fs.writeFileSync(record, '{"foreign":true}'); writer.appendPCM(f.pcm.subarray(0, 20000));
    expect(() => writer.checkpoint()).toThrow(); writer.close();
    expect(fs.readFileSync(record, 'utf8')).toBe('{"foreign":true}');
  });

  it('只讀查詢不建立任何目錄，長片上限使用 RIFF 界線並限制單次 buffer', () => {
    const f = fixture(1);
    expect(readCompleteContinuousWaveformCache(f.root, f.spec)).toBeNull();
    expect(inspectContinuousWaveformCache(f.root)).toMatchObject({ retained: false, uncertain: false });
    expect(fs.readdirSync(f.root)).toEqual([]);
    const long = openContinuousWaveformCache(f.root, { ...f.spec, totalSamples: MAX_TOTAL_SAMPLES }); writers.push(long);
    expect(long.totalSamples / 4000).toBeGreaterThan(149 * 3600);
    expect(() => long.appendPCM(Buffer.alloc(1))).toThrow();
    expect(() => long.appendPCM(Buffer.alloc(MAX_TRANSFER_BYTES + 2))).toThrow();
    expect(() => long.complete()).toThrow('尚未完整');
    expect(() => openContinuousWaveformCache(f.root, { ...f.spec, totalSamples: MAX_TOTAL_SAMPLES + 1 })).toThrow('規格無效');
  });

  it('不規則 pipe 塊跨越 SHA block 邊界，checkpoint range 仍逐 sample 正確', () => {
    const f = fixture(), writer = f.open(); let offset = 0, index = 0;
    const lengths = [2, 1022, 65534, 100, 8190, 65536];
    while (offset < f.pcm.length) {
      const end = Math.min(f.pcm.length, offset + lengths[index++ % lengths.length]);
      writer.appendPCM(f.pcm.subarray(offset, end)); writer.checkpoint(); offset = end;
      const count = Math.min(writer.completedSamples, 10000), start = writer.completedSamples - count;
      expect(writer.readPCM(start, count)).toEqual(f.pcm.subarray(start * 2, (start + count) * 2));
    }
    expect(fs.readFileSync(writer.complete()).subarray(44)).toEqual(f.pcm);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { readSourceWaveformChunk, saveSourceWaveformChunk, inspectSourceWaveformCache,
  isSourceWaveformCachePath, validSourceWaveformPcm, MAX_SOURCE_WAVEFORM_BYTES } = require('../electron/source-waveform-cache.js');
const roots = [];
const sourceKey = '1234567890abcdef';
const sharedSourceKey = '1234567890abcdef'.repeat(4);
const spec = (changes = {}) => ({ version: 1, sharedSourceKey, start: 0, length: 1, samples: 4000,
  audio: [{ channels: 2, timestampOffset: 0 }], ...changes });
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-wave-cache-'));
  roots.push(root);
  const directory = path.join(root, sourceKey); fs.mkdirSync(directory);
  return { root, directory, folder: path.join(directory, 'source-waveforms') };
}
function wav(samples = 4000, extra = false) {
  const start = extra ? 56 : 44, bytes = Buffer.alloc(start + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(4000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  if (extra) { bytes.write('JUNK', 36); bytes.writeUInt32LE(3, 40); bytes.write('abc', 44); }
  bytes.write('data', start - 8); bytes.writeUInt32LE(samples * 2, start - 4);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(index % 2 ? 8192 : -16384, start + index * 2);
  return bytes;
}
const completed = folder => fs.readdirSync(folder).filter(name => name.endsWith('.swc')).map(name => path.join(folder, name));
function afterWriterClose(change) {
  const open = fs.openSync, close = fs.closeSync;
  let writer, output;
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
    const fd = open(file, flags, ...args);
    if (flags === 'wx' && path.basename(String(file)).startsWith('.partial-')) { writer = fd; output = file; }
    return fd;
  });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    const completing = fd === writer;
    if (completing) writer = undefined;
    const result = close(fd);
    if (completing) change(output);
    return result;
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-wave-cache-'))
      throw new Error('拒絕清除測試目錄以外的資料');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('完成來源波形片段的持久快取', () => {
  it('完整 PCM 與來源紀錄一次發布，獨立 reader 取得完全相同 samples', () => {
    const f = fixture(), bytes = wav(4000, true), verify = vi.fn();
    expect(readSourceWaveformChunk(f.directory, spec())).toBeNull();
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: false, uncertain: false });
    expect(saveSourceWaveformChunk(f.directory, spec(), bytes, { verify })).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(f.directory)).toEqual(['source-waveforms']);
    expect(completed(f.folder)).toHaveLength(1);
    const reread = vi.fn();
    expect(readSourceWaveformChunk(f.directory, spec(), { verify: reread })).toEqual(bytes);
    expect(reread).toHaveBeenCalledTimes(2);
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: true, uncertain: false });
    expect(fs.existsSync(path.join(f.directory, 'meta.json'))).toBe(false);
  });

  it('未傳分段長度的舊 caller 可保存超過 60 秒的完整波形', () => {
    const f = fixture(), input = spec({ length: 61, samples: 244000 }), bytes = wav(input.samples);
    expect(MAX_SOURCE_WAVEFORM_BYTES).toBe(64 * 1024 * 1024);
    expect(saveSourceWaveformChunk(f.directory, input, bytes)).toBe(true);
    expect(readSourceWaveformChunk(f.directory, input)).toEqual(bytes);
  });

  it.each([
    ['短 PCM', bytes => bytes.subarray(0, bytes.length - 2)],
    ['錯誤取樣率', bytes => { bytes.writeUInt32LE(48000, 24); return bytes; }],
    ['錯誤聲道', bytes => { bytes.writeUInt16LE(2, 22); return bytes; }],
    ['錯誤位元深度', bytes => { bytes.writeUInt16LE(24, 34); return bytes; }],
    ['錯誤 byte rate', bytes => { bytes.writeUInt32LE(16000, 28); return bytes; }],
    ['錯誤 data 長度', bytes => { bytes.writeUInt32LE(7998, 40); return bytes; }],
    ['未知音訊編碼', bytes => { bytes.writeUInt16LE(3, 20); return bytes; }],
    ['錯誤 RIFF 長度', bytes => { bytes.writeUInt32LE(100, 4); return bytes; }],
  ])('%s 不建立可重用檔案或 namespace', (_name, change) => {
    const f = fixture(), bytes = change(wav());
    expect(validSourceWaveformPcm(bytes, 4000)).toBe(false);
    expect(saveSourceWaveformChunk(f.directory, spec(), bytes)).toBe(false);
    expect(fs.readdirSync(f.directory)).toEqual([]);
  });

  it('完整但長度不符或非 Buffer 的內容不可當成完成波形', () => {
    expect(validSourceWaveformPcm(wav(2000), 4000)).toBe(false);
    expect(validSourceWaveformPcm(new Uint8Array(wav()), 4000)).toBe(false);
    expect(validSourceWaveformPcm(wav(), NaN)).toBe(false);
  });

  it.each([
    { sharedSourceKey: 'fedcba0987654321'.repeat(4) }, { start: 60 }, { length: 0.5, samples: 2000 },
    { audio: [{ channels: 1, timestampOffset: 0 }] },
    { audio: [{ channels: 2, timestampOffset: 1 }] },
    { audio: [{ channels: 1 }, { channels: 1 }] },
    { version: 2 },
  ])('來源、範圍、layout、clock 與版本改變後不可猜用既有片段：%j', changes => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav());
    expect(readSourceWaveformChunk(f.directory, spec(changes))).toBeNull();
  });

  it('recipe 只保留決定 PCM 的來源欄位，省略的零 offset 一致', () => {
    const f = fixture(), bytes = wav();
    saveSourceWaveformChunk(f.directory, spec({ audio: [{ channels: 2, title: '名稱 A' }] }), bytes);
    expect(readSourceWaveformChunk(f.directory, spec({ audio: [{ title: '名稱 B', timestampOffset: 0, channels: 2 }] }))).toEqual(bytes);
  });

  it('工作本機 strict key 不影響同 shared evidence 的波形 recipe', () => {
    const f = fixture(), bytes = wav();
    saveSourceWaveformChunk(f.directory, spec({ sourceKey }), bytes);
    expect(readSourceWaveformChunk(f.directory, spec({ sourceKey: 'fedcba0987654321' }))).toEqual(bytes);
    expect(readSourceWaveformChunk(f.directory, spec({ sourceKey, sharedSourceKey: undefined }))).toBeNull();
    expect(saveSourceWaveformChunk(f.directory, spec({ sharedSourceKey: sourceKey }), bytes)).toBe(false);
  });

  it('同 recipe 的不同 writer 不覆寫先完成的檔案', () => {
    const f = fixture(), bytes = wav();
    saveSourceWaveformChunk(f.directory, spec(), bytes);
    const first = completed(f.folder)[0], before = fs.readFileSync(first);
    saveSourceWaveformChunk(f.directory, spec(), bytes);
    expect(completed(f.folder)).toHaveLength(2);
    expect(fs.readFileSync(first)).toEqual(before);
    expect(readSourceWaveformChunk(f.directory, spec())).toEqual(bytes);
  });

  it('SMB 在 writer 關閉時才更新時間戳，仍驗完整內容並發布完成波形', () => {
    const f = fixture(), bytes = wav(); let before, after;
    afterWriterClose(file => {
      before = fs.statSync(file, { bigint: true });
      fs.utimesSync(file, new Date(1234000), new Date(1234000));
      after = fs.statSync(file, { bigint: true });
    });
    expect(saveSourceWaveformChunk(f.directory, spec(), bytes)).toBe(true);
    expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(readSourceWaveformChunk(f.directory, spec())).toEqual(bytes);
    expect(completed(f.folder)).toHaveLength(1);
  });

  it.each([false, true])('writer 關閉後同 inode 等長改寫不可被當成 SMB 時間戳更新，重算內部hash=%s', rehash => {
    const f = fixture(); let output, changedBytes;
    afterWriterClose(file => {
      output = file; changedBytes = fs.readFileSync(file);
      changedBytes[changedBytes.length - 1] ^= 0x40;
      if (rehash) {
        const length = changedBytes.readUInt32LE(8);
        const record = JSON.parse(changedBytes.toString('utf8', 12, 12 + length));
        record.sha256 = createHash('sha256').update(changedBytes.subarray(12 + length)).digest('hex');
        const metadata = Buffer.from(JSON.stringify(record));
        expect(metadata.length).toBe(length); metadata.copy(changedBytes, 12);
      }
      fs.writeFileSync(file, changedBytes);
    });
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav())).toThrow();
    expect(completed(f.folder)).toEqual([]);
    expect(fs.readFileSync(output)).toEqual(changedBytes);
  });

  it('writer 關閉後附加資料不可只因原封裝前綴正確就發布', () => {
    const f = fixture(); let output;
    afterWriterClose(file => { output = file; fs.appendFileSync(file, 'foreign tail'); });
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav())).toThrow();
    expect(completed(f.folder)).toEqual([]);
    expect(fs.readFileSync(output).subarray(-12).toString()).toBe('foreign tail');
  });

  it.each(['same-size-content', 'truncated', 'oversized-metadata', 'wrong-recipe'])('毀損的完成檔不成為快取命中：%s', mode => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav());
    const file = completed(f.folder)[0], bytes = fs.readFileSync(file);
    if (mode === 'same-size-content') bytes[bytes.length - 1] ^= 0x10;
    if (mode === 'oversized-metadata') bytes.writeUInt32LE(0x7fffffff, 8);
    if (mode === 'wrong-recipe') {
      const start = bytes.indexOf(Buffer.from(sharedSourceKey)); bytes[start] = 'f'.charCodeAt(0);
    }
    fs.writeFileSync(file, mode === 'truncated' ? bytes.subarray(0, bytes.length - 2) : bytes);
    expect(readSourceWaveformChunk(f.directory, spec())).toBeNull();
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: false, uncertain: false });
  });

  it('私有未完成檔與缺少 namespace 都不被當成完成紀錄', () => {
    const f = fixture(); fs.mkdirSync(f.folder); fs.writeFileSync(path.join(f.folder, '.partial-unfinished'), wav());
    expect(readSourceWaveformChunk(f.directory, spec())).toBeNull();
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: false, uncertain: false });
  });

  it('入場已失權時不建立目錄，發布前失權時只清本次私有檔', () => {
    const f = fixture();
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav(), { verify: () => { throw new Error('cancelled'); } })).toThrow('cancelled');
    expect(fs.readdirSync(f.directory)).toEqual([]);
    let calls = 0;
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav(), { verify: () => {
      if (++calls === 2) throw new Error('source changed');
    } })).toThrow('source changed');
    expect(fs.readdirSync(f.folder)).toEqual([]);
  });

  it.each(['namespace', 'source-directory'])('發布前 %s 被替換時不發布，也不刪新目錄的物件', target => {
    const f = fixture(); let calls = 0, moved;
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav(), { verify: () => {
      if (++calls !== 2) return;
      const current = target === 'namespace' ? f.folder : f.directory;
      moved = current + '.old'; fs.renameSync(current, moved); fs.mkdirSync(current);
      fs.writeFileSync(path.join(current, 'foreign'), 'keep me');
    } })).toThrow();
    const current = target === 'namespace' ? f.folder : f.directory;
    expect(fs.readFileSync(path.join(current, 'foreign'), 'utf8')).toBe('keep me');
    expect(fs.readdirSync(current)).toEqual(['foreign']);
    const privateFolder = target === 'namespace' ? moved : path.join(moved, 'source-waveforms');
    expect(fs.readdirSync(privateFolder).every(name => name.startsWith('.partial-'))).toBe(true);
  });

  it('發布前私有路徑被外來同名檔取代時保留兩者，不發布 foreign bytes', () => {
    const f = fixture(); let calls = 0, partial, moved;
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav(), { verify: () => {
      if (++calls !== 2) return;
      partial = path.join(f.folder, fs.readdirSync(f.folder)[0]); moved = partial + '.owned';
      fs.renameSync(partial, moved); fs.writeFileSync(partial, 'foreign bytes');
    } })).toThrow();
    expect(fs.readFileSync(partial, 'utf8')).toBe('foreign bytes');
    expect(fs.statSync(moved).size).toBeGreaterThan(8000);
    expect(completed(f.folder)).toEqual([]);
  });

  it('read 的 open 期間路徑被換入同大小檔案，拒絕交付舊 handle', () => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav());
    const file = completed(f.folder)[0], original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const fd = original(target, ...args);
      if (target === file && args[0] === 'r') {
        const bytes = fs.readFileSync(fd); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes);
      }
      return fd;
    });
    expect(() => readSourceWaveformChunk(f.directory, spec())).toThrow();
  });

  it('read 交付前 callback 更換 namespace 時拒絕回傳已讀的內容', () => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav()); let calls = 0;
    expect(() => readSourceWaveformChunk(f.directory, spec(), { verify: () => {
      if (++calls === 2) { fs.renameSync(f.folder, f.folder + '.old'); fs.mkdirSync(f.folder); }
    } })).toThrow();
  });

  it('建立 namespace 時來源目錄被替換，不重新採信新路徑', () => {
    const f = fixture(), original = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((target, ...args) => {
      const result = original(target, ...args);
      if (target === f.folder) {
        fs.renameSync(f.directory, f.directory + '.old'); original(f.directory); original(f.folder);
        fs.writeFileSync(path.join(f.folder, 'foreign'), 'keep me');
      }
      return result;
    });
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav())).toThrow();
    expect(fs.readdirSync(f.folder)).toEqual(['foreign']);
    expect(fs.readFileSync(path.join(f.folder, 'foreign'), 'utf8')).toBe('keep me');
  });

  it('同 inode 的完成前內容被改寫也不能發布', () => {
    const f = fixture(); let calls = 0;
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav(), { verify: () => {
      if (++calls !== 2) return;
      const file = path.join(f.folder, fs.readdirSync(f.folder)[0]);
      const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 0x40;
      fs.writeFileSync(file, bytes);
      fs.utimesSync(file, new Date(0), new Date(0));
    } })).toThrow();
    expect(completed(f.folder)).toEqual([]);
  });

  it('namespace junction/symlink 不取得讀寫能力', () => {
    const f = fixture(), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => saveSourceWaveformChunk(f.directory, spec(), wav())).toThrow();
    expect(() => readSourceWaveformChunk(f.directory, spec())).toThrow();
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: false, uncertain: true });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('唯讀位置仍可讀完成波形，不能寫時不影響既有完成檔', () => {
    const f = fixture(), bytes = wav(); saveSourceWaveformChunk(f.directory, spec(), bytes);
    const before = completed(f.folder), original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
      if (flags === 'wx' && String(target).startsWith(f.folder + path.sep)) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
      return original(target, flags, ...args);
    });
    expect(() => saveSourceWaveformChunk(f.directory, spec(), bytes)).toThrow('read-only');
    expect(completed(f.folder)).toEqual(before);
    expect(readSourceWaveformChunk(f.directory, spec())).toEqual(bytes);
  });

  it('無法讀取完成檔時回報 uncertain，不能把未知 I/O 當成可刪孤兒', () => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav());
    const file = completed(f.folder)[0], original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      if (target === file) throw Object.assign(new Error('temporarily inaccessible'), { code: 'EACCES' });
      return original(target, ...args);
    });
    expect(inspectSourceWaveformCache(f.directory)).toEqual({ retained: false, uncertain: true });
  });

  it('公開 cleanup 可辨識 namespace 內檔案與別名，而不攔一般暫存波形', () => {
    const f = fixture(); saveSourceWaveformChunk(f.directory, spec(), wav());
    expect(isSourceWaveformCachePath(completed(f.folder)[0])).toBe(true);
    expect(isSourceWaveformCachePath(path.join(f.folder, 'missing.swc'))).toBe(true);
    expect(isSourceWaveformCachePath(path.join(f.root, 'source-wave.wav'))).toBe(false);
    expect(isSourceWaveformCachePath(null)).toBe(false);
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isSourceWaveformCachePath(path.join(alias, path.basename(completed(f.folder)[0])))).toBe(true);
  });
});

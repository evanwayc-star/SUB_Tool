import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createMediaIntakeRuntime, sourceAudioClockFilter } = require('../electron/media-intake-runtime.js');
const { buildIngestArgs } = require('../electron/ffmpeg-execution-engine.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(path.dirname(fs.realpathSync(root))).toBe(fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(channel, execute) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-temporary-media-')); roots.push(root);
  const tempRoot = path.join(root, 'temp'); fs.mkdirSync(tempRoot);
  const mother = path.join(root, 'mother.mov'); fs.writeFileSync(mother, 'mother bytes');
  const fileAuthority = new FileAuthority({ internalDirectories: [tempRoot] });
  fileAuthority.grantTrustedFile(mother);
  const registered = new Set(), allocated = [];
  const runtime = createMediaIntakeRuntime({ tempRoot, cacheRoot: path.join(root, 'cache'), fileAuthority,
    forgetTemporaryFile: file => registered.delete(file) });
  const runFF = vi.fn((args, options) => execute(args.at(-1), args, options));
  const mediaProbe = { describe: vi.fn(async () => ({ video: { width: 16, height: 16, fps: 25 }, audio: [{}] })) };
  const call = tree.body.map(node => node.expression).find(node =>
    node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle'
    && node.arguments?.[0]?.value === channel);
  let handler;
  vm.runInNewContext(source.slice(call.start, call.end), {
    ipcMain: { handle: (_, value) => { handler = value; } },
    requireReadablePath: createIpcGuards(fileAuthority).requireReadablePath,
    tmpPath(ext) {
      const file = path.join(tempRoot, `${allocated.length}.${ext}`);
      registered.add(file); allocated.push(file); return file;
    },
    runFF, mediaProbe, mediaIntakeRuntime: runtime, buildIngestArgs, sourceAudioClockFilter, VENC: 'libx264',
  });
  return { root, tempRoot, mother, registered, allocated, runFF, mediaProbe, runtime,
    invoke: overrides => handler({ sender: {} }, { path: mother, duration: 1, idx: 0, codec: 'pcm_s16le', ...overrides }) };
}

describe('未交接媒體暫存的正式 IPC 交易', () => {
  it.each(['ffmpeg:proxy', 'ffmpeg:waveAudio', 'ffmpeg:extractAudio'])('%s 失敗清除自己的部分檔並保留原始錯誤', async channel => {
    const failure = new Error('encoder failed after writing partial bytes');
    const f = fixture(channel, async out => { fs.writeFileSync(out, 'partial output'); throw failure; });
    await expect(f.invoke()).rejects.toBe(failure);
    expect(f.runFF).toHaveBeenCalledOnce();
    expect(f.allocated).toHaveLength(1);
    expect(fs.existsSync(f.allocated[0])).toBe(false);
    expect(f.registered.size).toBe(0);
    expect(fs.readFileSync(f.mother, 'utf8')).toBe('mother bytes');
  });

  it('extract copy 與 AAC 都失敗才清除部分檔，回報最後的真實錯誤', async () => {
    const failure = new Error('AAC fallback failed');
    const f = fixture('ffmpeg:extractAudio', async (out, args) => {
      fs.writeFileSync(out, args[args.indexOf('-c:a') + 1]);
      throw args.includes('copy') ? new Error('container rejects copy') : failure;
    });
    await expect(f.invoke({ codec: 'flac' })).rejects.toBe(failure);
    expect(f.runFF).toHaveBeenCalledTimes(2);
    expect(f.allocated).toHaveLength(1);
    expect(fs.existsSync(f.allocated[0])).toBe(false);
    expect(f.registered.size).toBe(0);
  });

  it('extract copy 失敗後成功 AAC 沿同一檔案交接，不能在中間失敗時清除', async () => {
    let identity;
    const f = fixture('ffmpeg:extractAudio', async (out, args) => {
      if (args.includes('copy')) {
        fs.writeFileSync(out, 'partial copy'); identity = fs.statSync(out, { bigint: true });
        throw new Error('copy failed');
      }
      expect(fs.readFileSync(out, 'utf8')).toBe('partial copy');
      expect(fs.statSync(out, { bigint: true }).ino).toBe(identity.ino);
      fs.writeFileSync(out, 'complete AAC bytes');
    });
    const result = await f.invoke({ codec: 'flac' });
    expect(result).toBe(f.allocated[0]); expect(f.runFF).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(result, 'utf8')).toBe('complete AAC bytes');
    expect(f.registered.has(result)).toBe(true);
    expect(f.runtime.cleanupGeneratedFile(result)).toBe(true);
    expect(f.registered.size).toBe(0);
  });

  it.each(['ffmpeg:proxy', 'ffmpeg:waveAudio', 'ffmpeg:extractAudio'])('%s 成功保留同一預留檔並交給 caller 清理', async channel => {
    let identity;
    const f = fixture(channel, async out => {
      identity = fs.statSync(out, { bigint: true });
      expect(identity.size).toBe(0n);
      fs.writeFileSync(out, 'complete generated bytes');
    });
    const out = await f.invoke();
    expect(fs.readFileSync(out, 'utf8')).toBe('complete generated bytes');
    expect(fs.statSync(out, { bigint: true }).ino).toBe(identity.ino);
    expect(f.registered.has(out)).toBe(true);
    expect(f.runtime.cleanupGeneratedFile(out)).toBe(true);
    expect(f.registered.size).toBe(0);
  });

  it('同名外來檔已存在時拒絕啟動 writer，不能清除或覆寫外來內容', async () => {
    const f = fixture('ffmpeg:waveAudio', vi.fn());
    const foreign = path.join(f.tempRoot, '0.wav'); fs.writeFileSync(foreign, 'existing foreign bytes');
    await expect(f.invoke()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(f.runFF).not.toHaveBeenCalled();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('existing foreign bytes');
    expect(f.registered.size).toBe(0);
  });

  it('writer 失敗前路徑被外來檔替換時不刪除新的檔案物件', async () => {
    const failure = new Error('native failed'), foreignBytes = 'new foreign output';
    let moved;
    const f = fixture('ffmpeg:waveAudio', async out => {
      fs.writeFileSync(out, 'owned partial output');
      moved = out + '.moved'; fs.renameSync(out, moved);
      fs.writeFileSync(out, foreignBytes);
      expect(fs.statSync(out, { bigint: true }).ino).not.toBe(fs.statSync(moved, { bigint: true }).ino);
      throw failure;
    });
    await expect(f.invoke()).rejects.toBe(failure);
    expect(fs.readFileSync(f.allocated[0], 'utf8')).toBe(foreignBytes);
    expect(fs.readFileSync(moved, 'utf8')).toBe('owned partial output');
    expect(f.registered.size).toBe(0);
  });

  it('清理失敗不遮蔽原生錯誤，保留 quit 清理登記', async () => {
    const failure = new Error('native failed');
    const f = fixture('ffmpeg:waveAudio', async out => { fs.writeFileSync(out, 'partial'); throw failure; });
    const unlink = fs.unlinkSync;
    let cleanupFailures = 0;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...args) => {
      if (file === f.allocated[0]) { cleanupFailures++; throw Object.assign(new Error('file busy'), { code: 'EPERM' }); }
      return unlink(file, ...args);
    });
    await expect(f.invoke()).rejects.toBe(failure);
    expect(cleanupFailures).toBe(1);
    expect(fs.readFileSync(f.allocated[0], 'utf8')).toBe('partial');
    expect(f.registered.has(f.allocated[0])).toBe(true);
  });

  it('probe 失敗清除尚未寫入的 reservation，未授權母素材不建立輸出', async () => {
    const f = fixture('ffmpeg:proxy', vi.fn());
    const failure = new Error('probe failed'); f.mediaProbe.describe.mockRejectedValueOnce(failure);
    await expect(f.invoke()).rejects.toBe(failure);
    expect(f.runFF).not.toHaveBeenCalled();
    expect(fs.existsSync(f.allocated[0])).toBe(false); expect(f.registered.size).toBe(0);
    await expect(f.invoke({ path: path.join(f.root, 'not-authorized.mov') })).rejects.toThrow(/授權/);
    expect(f.allocated).toHaveLength(1);
  });
});

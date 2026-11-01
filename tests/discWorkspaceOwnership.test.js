import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExportArtifact } = require('../electron/export-artifact.js');
const { acquireLease, prepareNativeWorkspace, releaseLease, updateLease } = require('../electron/export-lease.js');
const disc = require('../electron/disc-authoring.js');
const { prepareDiscOutput } = disc;
const { recoverExportLeases } = require('../electron/export-watchdog.js');
const fixtures = [];
const aliasRoots = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-disc-owner-test-'));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of aliasRoots.splice(0)) {
    if (!fs.existsSync(root)) continue;
    if (fs.lstatSync(root).isSymbolicLink()) fs.unlinkSync(root);
    else fs.rmSync(root, { recursive: true, force: true });
  }
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function leaseFixture(root, name, extra = {}) {
  const token = crypto.randomUUID(), outPath = path.join(root, `${name}.iso`);
  const lease = acquireLease({ queueDir: root, outPath, jobId: token, token, outputStarted: false, ...extra });
  const options = { queueDir: root, outPath, token, leaseKey: lease.key };
  const aliasName = `sd-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 20)}`;
  const aliasRoot = path.join(fs.realpathSync.native(os.tmpdir()), aliasName);
  expect(fs.existsSync(aliasRoot)).toBe(false);
  aliasRoots.push(aliasRoot);
  return { lease, options, aliasRoot };
}

describe('光碟工作資料夾的實體所有權', () => {
  it.each(['parent', 'work'])('正式 artifact 收尾拒絕刪除被取代的 %s', async replaced => {
    const root = fixture();
    const parent = path.join(root, 'lease');
    fs.mkdirSync(parent);
    const artifact = createExportArtifact({ outputFormat: 'dvd-iso', outPath: path.join(root, 'out.iso'), args: ['out.iso'] });
    const input = (await artifact.prepare({ tempDir: parent })).at(-1);
    fs.writeFileSync(input, 'original encoded content');
    const work = path.dirname(input);
    if (replaced === 'parent') {
      fs.renameSync(parent, path.join(root, 'original-lease'));
      fs.mkdirSync(work, { recursive: true });
    } else {
      fs.renameSync(work, path.join(root, 'original-work'));
      fs.mkdirSync(work);
    }
    const foreign = path.join(work, 'foreign.txt');
    fs.writeFileSync(foreign, 'foreign content');

    const result = await artifact.settle({ encoded: false });
    expect(result.cleanupError).toMatchObject({ code: 'INVALID_DISC_TEMP' });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
    const original = replaced === 'parent'
      ? path.join(root, 'original-lease', path.basename(work), path.basename(input))
      : path.join(root, 'original-work', path.basename(input));
    expect(fs.readFileSync(original, 'utf8')).toBe('original encoded content');
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 在封裝前拒絕向替代 work 寫入設定', async format => {
    const root = fixture(), parent = path.join(root, 'lease');
    fs.mkdirSync(parent);
    const missing = path.join(root, 'missing-native.exe');
    const nativePaths = { dvdauthor: missing, mkisofs: missing, tsmuxer: missing };
    const adapter = { ...disc, finalizeDiscOutput: (kind, input, output, options) =>
      disc.finalizeDiscOutput(kind, input, output, { ...options, nativePaths }) };
    const artifact = createExportArtifact({ outputFormat: format, outPath: path.join(root, 'out.iso'),
      args: ['out.iso'], discVideoFps: 24 }, { assertOutput() {} }, { disc: adapter });
    const input = (await artifact.prepare({ tempDir: parent })).at(-1), work = path.dirname(input);
    fs.writeFileSync(input, 'original encode');
    fs.renameSync(work, path.join(root, 'original-work'));
    fs.mkdirSync(work);
    const foreign = path.join(work, format === 'dvd-iso' ? 'disc.xml' : 'disc.meta');
    fs.writeFileSync(foreign, 'foreign content');
    const result = await artifact.settle({ encoded: true });
    expect(result.error).toMatchObject({ code: 'INVALID_DISC_TEMP' });
    expect(result.cleanupError).toMatchObject({ code: 'INVALID_DISC_TEMP' });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
    expect(fs.readFileSync(path.join(root, 'original-work', path.basename(input)), 'utf8')).toBe('original encode');
  });

  it.each(['dvd-iso', 'bd-iso'])('%s 拒絕覆寫工作目錄內已存在的設定檔硬連結', async format => {
    const root = fixture(), parent = path.join(root, 'lease');
    fs.mkdirSync(parent);
    const missing = path.join(root, 'missing-native.exe');
    const nativePaths = { dvdauthor: missing, mkisofs: missing, tsmuxer: missing };
    const adapter = { ...disc, finalizeDiscOutput: (kind, input, output, options) =>
      disc.finalizeDiscOutput(kind, input, output, { ...options, nativePaths }) };
    const artifact = createExportArtifact({ outputFormat: format, outPath: path.join(root, 'out.iso'),
      args: ['out.iso'], discVideoFps: 24 }, { assertOutput() {} }, { disc: adapter });
    const input = (await artifact.prepare({ tempDir: parent })).at(-1), work = path.dirname(input);
    fs.writeFileSync(input, 'original encode');
    const foreign = path.join(root, 'outside.txt');
    fs.writeFileSync(foreign, 'foreign content');
    fs.linkSync(foreign, path.join(work, format === 'dvd-iso' ? 'disc.xml' : 'disc.meta'));
    const result = await artifact.settle({ encoded: true });
    expect(result.error).toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
  });

  it('短別名消失且 lease 同名被取代時，不刪除替代目錄', () => {
    const root = fixture();
    const token = crypto.randomUUID();
    const outPath = path.join(root, 'out.iso');
    const lease = acquireLease({ queueDir: root, outPath, jobId: token, token });
    const options = { queueDir: root, outPath, token, leaseKey: lease.key };
    const workspace = prepareNativeWorkspace(options);
    const aliasRoot = path.dirname(workspace.path);
    fs.unlinkSync(workspace.path);
    fs.rmdirSync(aliasRoot);
    fs.renameSync(lease.lockPath, path.join(root, 'original-lock'));
    fs.mkdirSync(lease.lockPath);
    fs.copyFileSync(path.join(root, 'original-lock', 'owner.json'), path.join(lease.lockPath, 'owner.json'));
    const foreign = path.join(lease.lockPath, 'foreign.txt');
    fs.writeFileSync(foreign, 'foreign content');

    expect(() => releaseLease(options)).toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
    expect(fs.existsSync(path.join(root, 'original-lock', 'owner.json'))).toBe(true);
  });

  it('死程序復原不得遞迴刪除被取代的光碟工作資料夾', async () => {
    const root = fixture();
    const token = crypto.randomUUID();
    const outPath = path.join(root, 'out.iso');
    const lease = acquireLease({ queueDir: root, outPath, jobId: token, token, outputStarted: false });
    const options = { queueDir: root, outPath, token, leaseKey: lease.key };
    const work = await prepareDiscOutput('dvd-iso', { tempDir: lease.lockPath });
    fs.writeFileSync(work.encodedPath, 'original encoded content');
    updateLease({ ...options, discWorkspace: work });
    fs.renameSync(work.workDir, path.join(root, 'original-work'));
    fs.mkdirSync(work.workDir);
    const foreign = path.join(work.workDir, 'foreign.txt');
    fs.writeFileSync(foreign, 'foreign content');

    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign content');
    expect(fs.existsSync(path.join(lease.lockPath, 'owner.json'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'original-work', path.basename(work.encodedPath)), 'utf8')).toBe('original encoded content');
  });

  it('本工作尚未取得輸出 junction 時，收尾不得刪除同名外來連結', async () => {
    const root = fixture(), parent = path.join(root, 'lease'), outside = path.join(root, 'outside');
    fs.mkdirSync(parent); fs.mkdirSync(outside);
    const work = await prepareDiscOutput('bd-iso', { tempDir: parent });
    const link = path.join(work.workDir, 'out');
    fs.writeFileSync(path.join(outside, 'foreign.txt'), 'foreign');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(disc.cleanupDiscOutput(work, { tempDir: parent })).rejects.toMatchObject({ code: 'INVALID_DISC_TEMP' });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'foreign.txt'), 'utf8')).toBe('foreign');
  });

  it('死程序復原不刪除未持久化身分的輸出 junction', async () => {
    const root = fixture(), token = crypto.randomUUID(), outPath = path.join(root, 'out.iso');
    const lease = acquireLease({ queueDir: root, outPath, jobId: token, token, outputStarted: false });
    const work = await prepareDiscOutput('bd-iso', { tempDir: lease.lockPath });
    updateLease({ queueDir: root, outPath, token, leaseKey: lease.key, discWorkspace: work });
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'foreign.txt'), 'foreign');
    const link = path.join(work.workDir, 'out');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(fs.existsSync(path.join(lease.lockPath, 'owner.json'))).toBe(true);
  });

  it.each(['same-target', 'other-target'])('輸出 junction 被同名替換（%s）時復原保留連結', async kind => {
    const root = fixture(), token = crypto.randomUUID(), outPath = path.join(root, 'out.iso');
    const lease = acquireLease({ queueDir: root, outPath, jobId: token, token, outputStarted: false });
    const work = await prepareDiscOutput('bd-iso', { tempDir: lease.lockPath });
    const outside = path.join(root, 'outside'), other = path.join(root, 'other');
    fs.mkdirSync(outside); fs.mkdirSync(other);
    fs.writeFileSync(path.join(outside, 'foreign.txt'), 'foreign');
    fs.writeFileSync(path.join(other, 'foreign.txt'), 'other');
    const link = path.join(work.workDir, 'out');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const stat = fs.lstatSync(link, { bigint: true }), target = fs.lstatSync(outside, { bigint: true });
    work.outputLink = { dev: String(stat.dev), ino: String(stat.ino), target: { path: fs.realpathSync.native(outside),
      identity: { dev: String(target.dev), ino: String(target.ino), realpath: fs.realpathSync.native(outside) } } };
    updateLease({ queueDir: root, outPath, token, leaseKey: lease.key, discWorkspace: work });
    fs.renameSync(link, path.join(root, 'original-link'));
    fs.symlinkSync(kind === 'same-target' ? outside : other, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(fs.readFileSync(path.join(other, 'foreign.txt'), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(lease.lockPath, 'owner.json'))).toBe(true);
  });

  it.each(['legacy', 'pending'])('復原 %s 光碟工作缺乏身分時保留資料與 lease', async state => {
    const root = fixture(), token = crypto.randomUUID(), outPath = path.join(root, 'out.iso');
    const lease = acquireLease({ queueDir: root, outPath, jobId: token, token, outputStarted: false });
    const options = { queueDir: root, outPath, token, leaseKey: lease.key };
    if (state === 'pending') updateLease({ ...options, discWorkspacePending: true });
    const unknownWork = path.join(lease.lockPath, 'subtool-disc-foreign');
    fs.mkdirSync(unknownWork);
    fs.writeFileSync(path.join(unknownWork, 'foreign.txt'), 'unverified');
    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(fs.readFileSync(path.join(unknownWork, 'foreign.txt'), 'utf8')).toBe('unverified');
    expect(fs.existsSync(path.join(lease.lockPath, 'owner.json'))).toBe(true);
  });

  it('兩個獨立工作取得不同短別名，清除第一個不影響第二個', () => {
    const root = fixture(), first = leaseFixture(root, 'first'), second = leaseFixture(root, 'second');
    const a = prepareNativeWorkspace(first.options), b = prepareNativeWorkspace(second.options);
    fs.writeFileSync(path.join(first.lease.lockPath, 'a.txt'), 'A');
    fs.writeFileSync(path.join(second.lease.lockPath, 'b.txt'), 'B');
    expect(a.path).not.toBe(b.path);
    expect(fs.realpathSync.native(a.path)).toBe(fs.realpathSync.native(first.lease.lockPath));
    fs.unlinkSync(path.join(first.lease.lockPath, 'a.txt'));
    expect(releaseLease(first.options)).toBe(true);
    expect(fs.existsSync(first.aliasRoot)).toBe(false);
    b.assertCurrent();
    expect(fs.readFileSync(path.join(b.path, 'b.txt'), 'utf8')).toBe('B');
    fs.unlinkSync(path.join(second.lease.lockPath, 'b.txt'));
    expect(releaseLease(second.options)).toBe(true);
  });

  it('已存在的同名 alias 根不授權，不刪除其內容', () => {
    const root = fixture(), f = leaseFixture(root, 'collision');
    fs.mkdirSync(f.aliasRoot);
    const foreign = path.join(f.aliasRoot, 'foreign.txt');
    fs.writeFileSync(foreign, 'do not delete');
    expect(() => prepareNativeWorkspace(f.options)).toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('do not delete');
    expect(releaseLease(f.options)).toBe(true);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('do not delete');
  });

  it('建立 junction 失敗後只釋放已記錄的空 alias 根', () => {
    const root = fixture(), f = leaseFixture(root, 'symlink-fail');
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() => prepareNativeWorkspace(f.options)).toThrow(/denied/);
    spy.mockRestore();
    expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
    expect(releaseLease(f.options)).toBe(true);
    expect(fs.existsSync(f.aliasRoot)).toBe(false);
  });

  it('junction 已建立但身分尚未持久化時保留 alias 與 owner', async () => {
    const root = fixture(), f = leaseFixture(root, 'persist-fail');
    const rename = fs.renameSync.bind(fs);
    let updates = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('owner.json') && ++updates === 2) throw Object.assign(new Error('persist failed'), { code: 'EIO' });
      return rename(from, to);
    });
    expect(() => prepareNativeWorkspace(f.options)).toThrow(/persist failed/);
    spy.mockRestore();
    const link = path.join(f.aliasRoot, 'work');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('alias 被改指向外部時不得使用或清除', () => {
    const root = fixture(), f = leaseFixture(root, 'replacement');
    const workspace = prepareNativeWorkspace(f.options), foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'data.txt'), 'outside');
    fs.unlinkSync(workspace.path);
    fs.symlinkSync(foreign, workspace.path, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => workspace.assertCurrent()).toThrow();
    expect(() => releaseLease(f.options)).toThrow();
    expect(fs.readFileSync(path.join(foreign, 'data.txt'), 'utf8')).toBe('outside');
    expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
  });

  it('移除 alias 失敗時保留 owner，解除失敗後可重試', () => {
    const root = fixture(), f = leaseFixture(root, 'unlink-error');
    const workspace = prepareNativeWorkspace(f.options);
    const unlink = fs.unlinkSync.bind(fs);
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === workspace.path) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return unlink(file);
    });
    expect(() => releaseLease(f.options)).toThrow(/busy/);
    expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
    workspace.assertCurrent();
    spy.mockRestore();
    expect(releaseLease(f.options)).toBe(true);
    expect(fs.existsSync(f.aliasRoot)).toBe(false);
  });

  it('沒有存活程序的復原會清除有身分證據的 alias 與私有資料', async () => {
    const root = fixture(), f = leaseFixture(root, 'recover');
    const workspace = prepareNativeWorkspace(f.options);
    const work = await prepareDiscOutput('dvd-iso', { tempDir: f.lease.lockPath });
    fs.writeFileSync(work.encodedPath, 'partial');
    updateLease({ ...f.options, discWorkspace: work });
    expect(fs.existsSync(workspace.path)).toBe(true);
    const result = await recoverExportLeases(root);
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toHaveLength(1);
    expect(fs.existsSync(f.lease.lockPath)).toBe(false);
    expect(fs.existsSync(f.aliasRoot)).toBe(false);
  });

  it('準備記錄尚未完成但確定沒有工作目錄時可回收保留鎖', async () => {
    const root = fixture(), f = leaseFixture(root, 'pending-empty');
    prepareNativeWorkspace(f.options);
    updateLease({ ...f.options, discWorkspacePending: true });
    const result = await recoverExportLeases(root);
    expect(result.warnings).toEqual([]);
    expect(result.recovered).toHaveLength(1);
    expect(fs.existsSync(f.aliasRoot)).toBe(false);
    expect(fs.existsSync(f.lease.lockPath)).toBe(false);
  });

  it('writer PID 仍存活時復原不得拆除 alias 或私有資料', async () => {
    const root = fixture(), f = leaseFixture(root, 'live', { watchdogPid: process.pid });
    const workspace = prepareNativeWorkspace(f.options);
    fs.writeFileSync(path.join(f.lease.lockPath, 'private.txt'), 'keep');
    const result = await recoverExportLeases(root);
    expect(result.recovered).toHaveLength(0);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'EXPORT_PROCESS_RUNNING' })]);
    workspace.assertCurrent();
    expect(fs.readFileSync(path.join(f.lease.lockPath, 'private.txt'), 'utf8')).toBe('keep');
    fs.unlinkSync(path.join(f.lease.lockPath, 'private.txt'));
    expect(releaseLease(f.options)).toBe(true);
  });

  it.each(['airline-foreign.mux.tmp', '.owner.foreign.tmp', 'other-directory'])
  ('未登記的 %s 阻止釋放與重啟復原，已驗證的 work 與短入口也保持', async name => {
    const root = fixture(), f = leaseFixture(root, 'unknown-entry');
    const workspace = prepareNativeWorkspace(f.options);
    const work = await prepareDiscOutput('dvd-iso', { tempDir: f.lease.lockPath });
    fs.writeFileSync(work.encodedPath, 'owned encoded content');
    updateLease({ ...f.options, discWorkspace: work });
    const foreign = path.join(f.lease.lockPath, name);
    if (name === 'other-directory') { fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign content'); }
    else fs.writeFileSync(foreign, 'foreign content');
    const foreignFile = name === 'other-directory' ? path.join(foreign, 'foreign.txt') : foreign;
    expect(() => releaseLease(f.options)).toThrow(expect.objectContaining({ code: 'LEASE_UNVERIFIED_ENTRY' }));
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('foreign content');
    expect(fs.readFileSync(work.encodedPath, 'utf8')).toBe('owned encoded content');
    workspace.assertCurrent();
    const result = await recoverExportLeases(root);
    expect(result.recovered).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'LEASE_UNVERIFIED_ENTRY' })]);
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('foreign content');
    expect(fs.readFileSync(work.encodedPath, 'utf8')).toBe('owned encoded content');
    workspace.assertCurrent();
    if (name === 'other-directory') { fs.unlinkSync(foreignFile); fs.rmdirSync(foreign); }
    else fs.unlinkSync(foreign);
    const retried = await recoverExportLeases(root);
    expect(retried.warnings).toEqual([]);
    expect(retried.recovered).toHaveLength(1);
    expect(fs.existsSync(f.lease.lockPath)).toBe(false);
    expect(fs.existsSync(f.aliasRoot)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('Windows 極長 queue 仍可取得、持久化、獨立釋放真實工作資料', async () => {
    const root = fixture();
    const queueDir = path.join(root, 'q'.repeat(65), 'r'.repeat(65), 's'.repeat(65), 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    const outPath = path.join(root, 'long-a.iso'), token = crypto.randomUUID();
    const first = acquireLease({ queueDir, outPath, jobId: token, token, outputStarted: false });
    expect(first.lockPath.length).toBeGreaterThan(300);
    const work = await prepareDiscOutput('dvd-iso', { tempDir: first.lockPath });
    fs.writeFileSync(work.encodedPath, 'long-path encoded content');
    const owner = updateLease({ queueDir, outPath, token, leaseKey: first.key, discWorkspace: work });
    expect(JSON.parse(fs.readFileSync(path.join(first.lockPath, 'owner.json'), 'utf8'))).toEqual(owner.owner);
    expect(() => acquireLease({ queueDir, outPath, jobId: 'duplicate' })).toThrow(expect.objectContaining({ code: 'OUTPUT_BUSY' }));
    const otherPath = path.join(root, 'long-b.iso'), otherToken = crypto.randomUUID();
    const second = acquireLease({ queueDir, outPath: otherPath, jobId: otherToken, token: otherToken });
    expect(releaseLease({ queueDir, outPath, token, leaseKey: first.key })).toBe(true);
    expect(fs.existsSync(path.join(second.lockPath, 'owner.json'))).toBe(true);
    expect(releaseLease({ queueDir, outPath: otherPath, token: otherToken, leaseKey: second.key })).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('TEMP 過長時改用可寫的本機個人暫存根，仍能安全復原', async () => {
    const root = fixture(), f = leaseFixture(root, 'long-temp');
    const longTemp = path.join(root, 't'.repeat(65), 'u'.repeat(65), 'v'.repeat(65));
    const local = path.join(root, 'local'), fallback = path.join(local, 'Temp');
    fs.mkdirSync(longTemp, { recursive: true });
    fs.mkdirSync(fallback, { recursive: true });
    const saved = Object.fromEntries(['TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE'].map(key => [key, process.env[key]]));
    try {
      process.env.TEMP = process.env.TMP = longTemp;
      process.env.LOCALAPPDATA = local;
      process.env.USERPROFILE = path.join(root, 'missing-user-profile');
      const workspace = prepareNativeWorkspace(f.options);
      const nativeCwd = path.join(workspace.path, 'subtool-disc-XXXXXX', 'dvd', 'VIDEO_TS', 'VTS_01_1.VOB');
      expect(nativeCwd.length).toBeLessThan(260);
      const nativeStage = path.join(workspace.path, 'subtool-disc-XXXXXX', 'out',
        `.subtool-${'0'.repeat(16)}-${'0'.repeat(32)}.stage.iso`);
      expect(nativeStage.length).toBeLessThan(260);
      expect(fs.realpathSync.native(path.dirname(path.dirname(workspace.path))).toLowerCase())
        .toBe(fs.realpathSync.native(fallback).toLowerCase());
      const result = await recoverExportLeases(root);
      expect(result.warnings).toEqual([]);
      expect(result.recovered).toHaveLength(1);
      expect(fs.existsSync(f.lease.lockPath)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it.skipIf(process.platform !== 'win32')('TEMP 只容得下 DVD 而容不下 BD stage 時改用短根', () => {
    const root = fixture(), f = leaseFixture(root, 'bd-boundary');
    const temp = path.join(root, 'p'.repeat(165 - root.length - 1));
    const local = path.join(root, 'local');
    fs.mkdirSync(temp); fs.mkdirSync(path.join(local, 'Temp'), { recursive: true });
    const rootName = `sd-${crypto.createHash('sha256').update(f.options.token).digest('hex').slice(0, 20)}`;
    const candidate = path.join(temp, rootName, 'work', 'subtool-disc-XXXXXX');
    expect(path.join(candidate, 'dvd', 'VIDEO_TS', 'VTS_01_1.VOB').length).toBeLessThan(260);
    expect(path.join(candidate, 'out', `.subtool-${'0'.repeat(16)}-${'0'.repeat(32)}.stage.iso`).length).toBeGreaterThanOrEqual(260);
    const saved = Object.fromEntries(['TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE'].map(key => [key, process.env[key]]));
    try {
      process.env.TEMP = process.env.TMP = temp;
      process.env.LOCALAPPDATA = local;
      process.env.USERPROFILE = path.join(root, 'missing-user-profile');
      const workspace = prepareNativeWorkspace(f.options);
      expect(fs.realpathSync.native(path.dirname(path.dirname(workspace.path))).toLowerCase())
        .toBe(fs.realpathSync.native(path.join(local, 'Temp')).toLowerCase());
      expect(releaseLease(f.options)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it.skipIf(process.platform !== 'win32')('所有個人暫存根均過長時明確失敗並保留 lease', () => {
    const root = fixture(), f = leaseFixture(root, 'no-short-root');
    const longTemp = path.join(root, 't'.repeat(65), 'u'.repeat(65), 'v'.repeat(65));
    fs.mkdirSync(path.join(longTemp, 'Temp'), { recursive: true });
    const saved = Object.fromEntries(['TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE'].map(key => [key, process.env[key]]));
    try {
      process.env.TEMP = process.env.TMP = longTemp;
      process.env.LOCALAPPDATA = process.env.USERPROFILE = longTemp;
      expect(() => prepareNativeWorkspace(f.options)).toThrow(expect.objectContaining({ code: 'DISC_TEMP_PATH_TOO_LONG' }));
      expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it.skipIf(process.platform !== 'win32')('TEMP 無寫入權時可改用另一個個人暫存根', () => {
    const root = fixture(), f = leaseFixture(root, 'unwritable-temp');
    const temp = path.join(root, 'first'), local = path.join(root, 'local');
    fs.mkdirSync(temp); fs.mkdirSync(path.join(local, 'Temp'), { recursive: true });
    const saved = Object.fromEntries(['TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE'].map(key => [key, process.env[key]]));
    try {
      process.env.TEMP = process.env.TMP = temp;
      process.env.LOCALAPPDATA = local;
      process.env.USERPROFILE = path.join(root, 'missing-user-profile');
      const mkdir = fs.mkdirSync.bind(fs);
      const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dir, options) => {
        if (path.dirname(dir) === temp) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return mkdir(dir, options);
      });
      const workspace = prepareNativeWorkspace(f.options);
      spy.mockRestore();
      expect(fs.realpathSync.native(path.dirname(path.dirname(workspace.path))).toLowerCase())
        .toBe(fs.realpathSync.native(path.join(local, 'Temp')).toLowerCase());
      expect(releaseLease(f.options)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it.skipIf(process.platform !== 'win32')('TEMP 變更後不憑舊路徑清除 alias，原根恢復後可重試', async () => {
    const root = fixture(), f = leaseFixture(root, 'temp-changed');
    const first = path.join(root, 'first'), second = path.join(root, 'second');
    fs.mkdirSync(first); fs.mkdirSync(second);
    const saved = Object.fromEntries(['TEMP', 'TMP'].map(key => [key, process.env[key]]));
    try {
      process.env.TEMP = process.env.TMP = first;
      const workspace = prepareNativeWorkspace(f.options);
      process.env.TEMP = process.env.TMP = second;
      const firstResult = await recoverExportLeases(root);
      expect(firstResult.recovered).toHaveLength(0);
      expect(firstResult.warnings).toHaveLength(1);
      expect(fs.existsSync(workspace.path)).toBe(true);
      expect(fs.existsSync(path.join(f.lease.lockPath, 'owner.json'))).toBe(true);
      process.env.TEMP = process.env.TMP = first;
      const retry = await recoverExportLeases(root);
      expect(retry.warnings).toEqual([]);
      expect(retry.recovered).toHaveLength(1);
      expect(fs.existsSync(workspace.path)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

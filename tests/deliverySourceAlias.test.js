import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createExportAdmission, createExportQueue } = require('../electron/export-queue');
const { outputKey, assertDistinctSourceEntries } = require('../electron/export-lease');
const QueueStore = require('../electron/queue-store');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-source-alias-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-source-alias-'));
  roots.push(root);
  const source = path.join(root, 'A Very Long Original Source Filename.mp4');
  fs.writeFileSync(source, 'original source bytes');
  const authority = new FileAuthority();
  authority.grantTrustedFile(source);
  authority.grantDeliveryDirectory(root);
  let queue;
  const admission = createExportAdmission({
    expectedExtensionFor: () => 'mp4', outputKeyFor: outputKey,
    mergeSourcePaths: QueueStore.mergeSourcePaths, currentJobs: () => queue?.jobs() || [],
    canReadSource: file => authority.canRead(file), canWriteDelivery: file => authority.canWriteDelivery(file),
    isPreviewCacheMedia: () => false,
  });
  queue = createExportQueue({ dir: () => path.join(root, 'queue'), store: QueueStore, history: QueueStore.QueueHistory,
    admission, canReadSource: file => authority.canRead(file), canWriteDelivery: file => authority.canWriteDelivery(file),
    isFile: file => fs.statSync(file).isFile(), captureOutputAuthority: file => authority.captureDeliveryOutput(file),
    runJob: vi.fn(), onChanged() {} });
  queue.setPaused(true);
  const job = outPath => ({ id: 'source-alias', status: 'queued', createdAt: 1,
    payload: { format: 'h264', outPath, clips: [{ path: source, in: 0, out: 1, offset: 0 }] } });
  return { root, source, authority, admission, queue, job };
}

it.runIf(process.platform === 'win32')('真實 8.3 別名指向母素材時，公開 queue 入列不允許覆蓋母素材', context => {
  const f = fixture();
  const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_SOURCE).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_SOURCE: f.source },
  }).trim();
  // Keep the user-authorized parent spelling; only the final entry uses 8.3.
  const short = path.join(path.dirname(f.source), path.basename(shortPath));
  if (outputKey(short) === outputKey(f.source)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(f.source).toLowerCase());
  expect(() => f.queue.addJob(f.job(short))).toThrow(/不可覆蓋母素材/);
  expect(f.queue.jobs()).toEqual([]);
  expect(fs.readFileSync(f.source, 'utf8')).toBe('original source bytes');
});

it('不同硬連結是不同目錄項目，不能因共用 inode 阻止原本合法的入列', () => {
  const f = fixture(), target = path.join(f.root, 'different-entry.mp4');
  fs.linkSync(f.source, target);
  expect(fs.statSync(f.source).ino).toBe(fs.statSync(target).ino);
  expect(() => f.queue.addJob(f.job(target))).not.toThrow();
  expect(f.queue.jobs()).toHaveLength(1);
  expect(fs.readFileSync(f.source, 'utf8')).toBe('original source bytes');
});

it('新目的檔出現前後 reservation key 不變', () => {
  const f = fixture(), target = path.join(f.root, 'new output.mp4');
  const original = outputKey(target);
  f.queue.addJob(f.job(target));
  fs.writeFileSync(target, 'external new file');
  expect(outputKey(target)).toBe(original);
  expect(f.queue.jobs()).toHaveLength(1);
  expect(fs.readFileSync(f.source, 'utf8')).toBe('original source bytes');
});

it('目的檔或已存在的來源無法核對時拒絕，而非假裝不存在', () => {
  const f = fixture(), target = path.join(f.root, 'delivery.mp4');
  fs.writeFileSync(target, 'existing output');
  for (const denied of [target, f.source]) {
    const io = {
      lstatSync(file) { if (file === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.lstatSync(file); },
      realpathSync: { native: file => fs.realpathSync.native(file) },
    };
    expect(() => assertDistinctSourceEntries([f.source], target, io))
      .toThrow(expect.objectContaining({ code: 'DELIVERY_DESTINATION_UNVERIFIABLE' }));
  }
  const unresolved = { lstatSync: file => fs.lstatSync(file), realpathSync: { native(file) {
    if (file === f.source) throw Object.assign(new Error('target vanished'), { code: 'ENOENT' });
    return fs.realpathSync.native(file);
  } } };
  expect(() => assertDistinctSourceEntries([f.source], target, unresolved))
    .toThrow(expect.objectContaining({ code: 'DELIVERY_DESTINATION_UNVERIFIABLE' }));
});

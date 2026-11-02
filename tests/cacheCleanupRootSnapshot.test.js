import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
let root;
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-cache-root-snapshot-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it('清除中央根時，前一項完成後其他同層項目被更新不可刪除新內容', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-root-snapshot-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const files = ['first.bin', 'second.bin'].map(name => path.join(cacheRoot, name));
  for (const file of files) fs.writeFileSync(file, 'old bytes');
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const remove = fs.unlinkSync; let changed;
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...options) => {
    const result = remove(target, ...options);
    if (!changed && path.basename(String(target)) === 'entry') {
      changed = files.find(file => fs.existsSync(file));
      if (changed) fs.writeFileSync(changed, 'new bytes');
    }
    return result;
  });
  let result;
  try { result = await runtime.clearAll(); } finally { spy.mockRestore(); }
  expect(changed).toBeTruthy();
  expect(fs.readFileSync(changed, 'utf8')).toBe('new bytes');
  expect(result.incomplete).toBe(true);
});

it('清理孤兒時，前一項完成後其他同層目錄新增內容不可刪除新內容', async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-root-snapshot-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const dirs = ['first', 'second'].map(name => path.join(cacheRoot, name));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'old.bin'), 'old bytes'); }
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const remove = fs.rmdirSync; let changed;
  const spy = vi.spyOn(fs, 'rmdirSync').mockImplementation((target, ...options) => {
    const result = remove(target, ...options);
    if (!changed && path.basename(String(target)) === 'entry') {
      changed = dirs.find(dir => fs.existsSync(dir));
      if (changed) fs.writeFileSync(path.join(changed, 'new.bin'), 'new bytes');
    }
    return result;
  });
  let result;
  try { result = await runtime.cleanOrphans(); } finally { spy.mockRestore(); }
  expect(changed).toBeTruthy();
  expect(fs.readFileSync(path.join(changed, 'new.bin'), 'utf8')).toBe('new bytes');
  expect(result.incomplete).toBe(true);
});

it.each(['clearAll', 'cleanOrphans'])('%s 可正常清理多筆互不變動的候選', async operation => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-root-snapshot-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const dirs = ['first', 'second'].map(name => path.join(cacheRoot, name));
  for (const dir of dirs) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'old.bin'), 'old bytes'); }
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const result = await runtime[operation]();
  expect(result).toMatchObject({ bytes: 18, incomplete: false });
  if (operation === 'cleanOrphans') expect(result.removed).toBe(2);
  for (const dir of dirs) expect(fs.existsSync(dir)).toBe(false);
});

it.each(['clearAll', 'cleanOrphans'])('%s 單筆讀取失敗時保留原內容並明確回報部分清理', async operation => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-root-snapshot-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const inaccessible = path.join(cacheRoot, 'inaccessible'), valid = path.join(cacheRoot, 'valid');
  for (const dir of [inaccessible, valid]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'old.bin'), 'old bytes'); }
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const stat = fs.lstatSync;
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...options) => {
    if (path.resolve(String(target)) === inaccessible) throw Object.assign(new Error('拒絕讀取'), { code: 'EACCES' });
    return stat(target, ...options);
  });
  let result;
  try { result = await runtime[operation](); } finally { spy.mockRestore(); }
  expect(result).toMatchObject({ bytes: 9, incomplete: true });
  if (operation === 'cleanOrphans') expect(result.removed).toBe(1);
  expect(fs.readFileSync(path.join(inaccessible, 'old.bin'), 'utf8')).toBe('old bytes');
  expect(fs.existsSync(valid)).toBe(false);
});

it.each(['clearAll', 'cleanOrphans'])('%s 同層候選共用有界快照預算，超限項保留並回報', async operation => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-root-snapshot-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  fs.mkdirSync(cacheRoot); fs.mkdirSync(tempRoot);
  const dirs = ['first', 'second'].map(name => path.join(cacheRoot, name));
  for (const dir of dirs) {
    fs.mkdirSync(dir);
    for (let index = 0; index < 10000; index++) fs.writeFileSync(path.join(dir, `${index}.bin`), 'x');
  }
  const runtime = createMediaIntakeRuntime({
    cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] }),
    ffmpegExecution: { async execute() {} },
  });
  const result = await runtime[operation]();
  expect(result).toMatchObject({ bytes: 10000, incomplete: true });
  if (operation === 'cleanOrphans') expect(result.removed).toBe(1);
  const remaining = dirs.filter(dir => fs.existsSync(dir));
  expect(remaining).toHaveLength(1);
  expect(fs.readdirSync(remaining[0])).toHaveLength(10000);
// 此案例建立 20,000 個實體檔並驗證全文清理；60 秒只作防掛上限，
// 不取代內容、身分、部分完成與關閉生命週期的獨立斷言。
}, 60000);

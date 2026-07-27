import { afterEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  acquireLease,
  leaseRoot,
  listLeases,
  normalizeOutputPath,
  outputKey,
  releaseLease,
  updateLease,
} = require('../electron/export-lease.js');

const tempDirs = new Set();

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-export-lease-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('匯出檔案鎖路徑', () => {
  test('正規化絕對路徑並在父目錄存在時採用實體路徑', () => {
    const queueDir = makeTempDir();
    const realParent = path.join(queueDir, 'exports');
    mkdirSync(realParent);

    const actual = normalizeOutputPath(
      path.join(realParent, 'nested', '..', 'movie.mp4'),
    );
    const canonical = path.join(realpathSync.native(realParent), 'movie.mp4');
    const expected = process.platform === 'win32'
      ? canonical.toLowerCase()
      : canonical;

    expect(actual).toBe(expected);
    expect(leaseRoot(queueDir)).toBe(path.join(path.resolve(queueDir), 'output-leases'));
  });

  test('相同正規化路徑得到同一個 SHA-256 key，不同輸出得到不同 key', () => {
    const queueDir = makeTempDir();
    const exportsDir = path.join(queueDir, 'exports');
    mkdirSync(exportsDir);

    const direct = path.join(exportsDir, 'movie.mp4');
    const aliased = path.join(exportsDir, '.', 'movie.mp4');
    const other = path.join(exportsDir, 'other.mp4');

    expect(outputKey(direct)).toBe(outputKey(aliased));
    expect(outputKey(direct)).not.toBe(outputKey(other));
    expect(outputKey(direct)).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform === 'win32') {
      expect(outputKey('C:\\Exports\\Movie.mp4')).toBe(
        '6b06a4f9d42bad1a6f97dba8855e6bdcb606567071a2f344e86148240a8ed741',
      );
    }
  });
});

describe('取得匯出檔案鎖', () => {
  test('以 owner 暫存目錄取得鎖，並記錄啟動 watchdog 所需欄位', () => {
    const queueDir = makeTempDir();
    const outPath = path.join(queueDir, 'exports', 'movie.mp4');
    mkdirSync(path.dirname(outPath));

    const lease = acquireLease({
      queueDir,
      outPath,
      jobId: 'job-1',
      token: 'token-1',
      watchdogPid: 1234,
      pipeName: '\\\\.\\pipe\\subtool-job-1',
    });

    expect(lease.key).toBe(outputKey(outPath));
    expect(lease.lockPath).toBe(
      path.join(leaseRoot(queueDir), `${outputKey(outPath)}.lock`),
    );
    expect(lease.owner).toEqual({
      token: 'token-1',
      jobId: 'job-1',
      outPath: normalizeOutputPath(outPath),
      watchdogPid: 1234,
      ffmpegPid: null,
      pipeName: '\\\\.\\pipe\\subtool-job-1',
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(lease.owner.createdAt))).toBe(false);
    expect(JSON.parse(
      readFileSync(path.join(lease.lockPath, 'owner.json'), 'utf8'),
    )).toEqual(lease.owner);
    expect(readdirSync(leaseRoot(queueDir))).toEqual([`${lease.key}.lock`]);
  });

  test('同一輸出第二次取得會回報 OUTPUT_BUSY，且不破壞原 owner', () => {
    const queueDir = makeTempDir();
    const outPath = path.join(queueDir, 'movie.mp4');
    const first = acquireLease({
      queueDir,
      outPath,
      jobId: 'job-1',
      token: 'token-1',
    });
    const before = readFileSync(path.join(first.lockPath, 'owner.json'), 'utf8');

    let caught;
    try {
      acquireLease({
        queueDir,
        outPath: path.join(queueDir, '.', 'movie.mp4'),
        jobId: 'job-2',
        token: 'token-2',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'OUTPUT_BUSY',
      lockPath: first.lockPath,
      outPath: normalizeOutputPath(outPath),
    });
    expect(readFileSync(path.join(first.lockPath, 'owner.json'), 'utf8')).toBe(before);
    expect(readdirSync(leaseRoot(queueDir))).toEqual([`${first.key}.lock`]);
  });

  test('不同輸出路徑可同時各自取得鎖', () => {
    const queueDir = makeTempDir();
    const first = acquireLease({
      queueDir,
      outPath: path.join(queueDir, 'first.mp4'),
      jobId: 'job-1',
    });
    const second = acquireLease({
      queueDir,
      outPath: path.join(queueDir, 'second.mp4'),
      jobId: 'job-2',
    });

    expect(first.key).not.toBe(second.key);
    expect(first.owner.token).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.owner.token).toMatch(/^[a-f0-9-]{36}$/);
    expect(readdirSync(leaseRoot(queueDir)).sort()).toEqual(
      [`${first.key}.lock`, `${second.key}.lock`].sort(),
    );
  });
});

describe('更新與釋放匯出檔案鎖', () => {
  test('持有者可補上 ffmpeg PID，且 owner 的識別欄位保持不變', () => {
    const queueDir = makeTempDir();
    const outPath = path.join(queueDir, 'movie.mp4');
    const lease = acquireLease({
      queueDir,
      outPath,
      jobId: 'job-1',
      token: 'token-1',
      watchdogPid: 1234,
      pipeName: '\\\\.\\pipe\\subtool-job-1',
    });

    const updated = updateLease({
      queueDir,
      outPath,
      token: 'token-1',
      ffmpegPid: 5678,
    });

    expect(updated).toEqual({
      ...lease,
      owner: {
        ...lease.owner,
        ffmpegPid: 5678,
      },
    });
    expect(JSON.parse(
      readFileSync(path.join(lease.lockPath, 'owner.json'), 'utf8'),
    )).toEqual(updated.owner);
  });

  test('錯誤 token 無法修改 owner，也無法刪除鎖', () => {
    const queueDir = makeTempDir();
    const outPath = path.join(queueDir, 'movie.mp4');
    const lease = acquireLease({
      queueDir,
      outPath,
      jobId: 'job-1',
      token: 'token-1',
    });
    const ownerPath = path.join(lease.lockPath, 'owner.json');
    const before = readFileSync(ownerPath, 'utf8');

    expect(() => updateLease({
      queueDir,
      outPath,
      token: 'wrong-token',
      ffmpegPid: 5678,
    })).toThrow(expect.objectContaining({ code: 'LEASE_TOKEN_MISMATCH' }));
    expect(readFileSync(ownerPath, 'utf8')).toBe(before);

    expect(() => releaseLease({
      queueDir,
      outPath,
      token: 'wrong-token',
    })).toThrow(expect.objectContaining({ code: 'LEASE_TOKEN_MISMATCH' }));
    expect(existsSync(lease.lockPath)).toBe(true);
    expect(readFileSync(ownerPath, 'utf8')).toBe(before);
  });

  test('正確 token 可釋放鎖，重複釋放安全地回傳 false', () => {
    const queueDir = makeTempDir();
    const outPath = path.join(queueDir, 'movie.mp4');
    const lease = acquireLease({
      queueDir,
      outPath,
      jobId: 'job-1',
      token: 'token-1',
    });

    expect(releaseLease({ queueDir, outPath, token: 'token-1' })).toBe(true);
    expect(existsSync(lease.lockPath)).toBe(false);
    expect(releaseLease({ queueDir, outPath, token: 'token-1' })).toBe(false);
  });
});

describe('啟動時列出匯出檔案鎖', () => {
  test('同時列出有效與損壞鎖，損壞 owner 一律 fail closed', () => {
    const queueDir = makeTempDir();
    const validOutPath = path.join(queueDir, 'valid.mp4');
    const validLease = acquireLease({
      queueDir,
      outPath: validOutPath,
      jobId: 'job-valid',
      token: 'token-valid',
    });

    const corruptOutPath = path.join(queueDir, 'corrupt.mp4');
    const corruptKey = outputKey(corruptOutPath);
    const corruptLockPath = path.join(leaseRoot(queueDir), `${corruptKey}.lock`);
    mkdirSync(corruptLockPath);
    const corruptOwnerPath = path.join(corruptLockPath, 'owner.json');
    writeFileSync(corruptOwnerPath, '{"token":', 'utf8');
    const corruptBefore = readFileSync(corruptOwnerPath, 'utf8');

    expect(listLeases(queueDir)).toEqual([
      {
        valid: true,
        key: validLease.key,
        lockPath: validLease.lockPath,
        owner: validLease.owner,
      },
      {
        valid: false,
        key: corruptKey,
        lockPath: corruptLockPath,
        error: {
          code: 'LEASE_CORRUPT',
          message: expect.stringContaining('owner.json cannot be read'),
          reason: expect.stringContaining('owner.json cannot be read'),
        },
      },
    ].sort((a, b) => a.key.localeCompare(b.key)));

    expect(() => acquireLease({
      queueDir,
      outPath: corruptOutPath,
      jobId: 'job-replacement',
      token: 'replacement-token',
    })).toThrow(expect.objectContaining({ code: 'OUTPUT_BUSY' }));
    expect(() => updateLease({
      queueDir,
      outPath: corruptOutPath,
      token: 'replacement-token',
      ffmpegPid: 5678,
    })).toThrow(expect.objectContaining({ code: 'LEASE_CORRUPT' }));
    expect(() => releaseLease({
      queueDir,
      outPath: corruptOutPath,
      token: 'replacement-token',
    })).toThrow(expect.objectContaining({ code: 'LEASE_CORRUPT' }));
    expect(existsSync(corruptLockPath)).toBe(true);
    expect(readFileSync(corruptOwnerPath, 'utf8')).toBe(corruptBefore);
  });

  test('鎖目錄尚未建立時回傳空清單', () => {
    expect(listLeases(makeTempDir())).toEqual([]);
  });
});

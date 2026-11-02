import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const logs = require('../electron/diagnostic-log');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-diagnostic-owner-'));
  const file = logs.queueLogPath(dir, 'job');
  const fd = fs.openSync(file, 'wx');
  const owner = logs.record(file, fd, 'job');
  fs.writeFileSync(fd, 'OWN LOG'); fs.closeSync(fd);
  return { dir, file, owner };
}

describe('診斷記錄檔案身分', () => {
  it('開啟與讀取之間換檔時只回傳本次 stderr，不讀外來 bytes', () => {
    const { dir, file, owner } = fixture();
    try {
      let swapped = false;
      const injected = { ...fs, openSync(name, ...args) {
        if (name === file && !swapped) {
          swapped = true;
          fs.renameSync(file, `${file}.original`);
          fs.writeFileSync(file, 'FOREIGN');
        }
        return fs.openSync(name, ...args);
      } };
      expect(logs.read(file, owner, 'SAFE TAIL', injected)).toBe('SAFE TAIL');
      expect(fs.readFileSync(file, 'utf8')).toBe('FOREIGN');
      expect(fs.readFileSync(`${file}.original`, 'utf8')).toBe('OWN LOG');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('claim rename 前換檔時復原外來檔，不把它當自己記錄清除', async () => {
    const { dir, file, owner } = fixture();
    try {
      let swapped = false;
      const injected = { ...fs, renameSync(source, destination) {
        if (source === file && !swapped) {
          swapped = true;
          fs.renameSync(file, `${file}.original`);
          fs.writeFileSync(file, 'FOREIGN');
        }
        return fs.renameSync(source, destination);
      } };
      expect(await logs.remove(file, owner, injected)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('FOREIGN');
      expect(fs.readFileSync(`${file}.original`, 'utf8')).toBe('OWN LOG');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('父資料夾同名替換後不接受舊 receipt，也不刪外來記錄', () => {
    const { dir, file } = fixture();
    const oldDir = `${dir}.old`;
    try {
      fs.renameSync(dir, oldDir);
      fs.mkdirSync(dir);
      const replacement = path.join(dir, path.basename(file));
      fs.copyFileSync(path.join(oldDir, path.basename(file)), replacement);
      fs.copyFileSync(path.join(oldDir, `${path.basename(file)}.owner`), `${replacement}.owner`);
      expect(logs.load(replacement)).toBeNull();
      logs.removeJobLogs(dir, 'job');
      expect(fs.readFileSync(replacement, 'utf8')).toBe('OWN LOG');
      expect(fs.readFileSync(path.join(oldDir, path.basename(file)), 'utf8')).toBe('OWN LOG');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('記錄已刪但 receipt 暫時無法刪除時，下一次清理可恢復', () => {
    const { dir, file } = fixture();
    try {
      let blocked = false;
      const injected = { ...fs, unlinkSync(name) {
        if (path.basename(name).startsWith('.subtool-receipt-') && !blocked) {
          blocked = true;
          const error = new Error('receipt locked'); error.code = 'EACCES'; throw error;
        }
        return fs.unlinkSync(name);
      } };
      expect(() => logs.removeJobLogs(dir, 'job', injected)).toThrow('receipt locked');
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.owner`)).toBe(true);
      logs.removeJobLogs(dir, 'job');
      expect(fs.existsSync(`${file}.owner`)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('讀取 receipt 遇到權限錯誤時保留資料並回報，恢復權限可重試', () => {
    const { dir, file } = fixture();
    try {
      const injected = { ...fs, openSync(name, ...args) {
        if (name === `${file}.owner`) {
          const error = new Error('receipt unreadable'); error.code = 'EACCES'; throw error;
        }
        return fs.openSync(name, ...args);
      } };
      expect(() => logs.removeJobLogs(dir, 'job', injected)).toThrow('receipt unreadable');
      expect(fs.readFileSync(file, 'utf8')).toBe('OWN LOG');
      logs.removeJobLogs(dir, 'job');
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

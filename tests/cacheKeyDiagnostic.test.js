import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { FileAuthority } = require('../electron/file-authority.js');
const roots = [];

afterEach(() => {
  for (const directory of roots.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(tmpdir()) || !path.basename(resolved).startsWith('subtool-cache-diagnostic-')) throw new Error('拒絕清除未核對的診斷測試目錄');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('快取診斷使用實際 runtime 的索引規則', () => {
  it('public ingest 發布 generation 元件後，CLI 不誤報 missing；刪掉一個元件才報一個', async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-cache-diagnostic-')); roots.push(directory);
    const source = path.join(directory, 'mother.bin'); fs.writeFileSync(source, 'mother source');
    const authority = new FileAuthority({ internalDirectories: [directory] });
    const runtime = createMediaIntakeRuntime({ fileAuthority: authority, tempRoot: directory,
      cacheRoot: path.join(directory, 'fallback'), delay: async () => {},
      ffmpegExecution: { async execute(args) {
        for (const file of args.filter(value => /\.(?:m4a|wav|mp4)$/.test(value))) fs.writeFileSync(file, 'complete cache');
      } } });
    try {
      const result = await runtime.ingest({ src: source, duration: 1, needsProxy: true, audio: [{ channels: 1 }] });
      const inspection = runtime.inspectCache(source).find(entry => entry.dir.includes('.subtool_Cache'));
      expect(inspection.files).toHaveLength(3);
      expect(inspection.files.every(entry => entry.state === 'complete' && entry.file.includes('generation-'))).toBe(true);
      const run = () => spawnSync(process.execPath, [path.resolve('scripts/diagnostics/measure-cache-key.js'), source],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      const complete = run(); expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout).toContain('3 個元件（缺 0 個，無法確認 0 個）');
      fs.unlinkSync(result.channels[0].file);
      const partial = run(); expect(partial.status, partial.stderr).toBe(0);
      expect(partial.stdout).toContain('3 個元件（缺 1 個，無法確認 0 個）');
      expect(runtime.inspectCache(source)[0].meta.channels).toEqual([]);
    } finally { await runtime.close(); }
  });
});

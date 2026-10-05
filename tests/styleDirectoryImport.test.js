import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { collectStyleDirectoryFiles } = require('../electron/style-directory-import.js');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('樣式資料夾匯入', () => {
  it('保留正常巢狀樣式，且不追隨指向所選資料夾外的連結', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-style-import-'));
    roots.push(fixture);
    const chosen = path.join(fixture, 'chosen');
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(path.join(chosen, 'group'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(chosen, 'group', 'safe.json'), '{"name":"safe"}');
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"name":"outside"}');
    fs.symlinkSync(outside, path.join(chosen, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    const files = collectStyleDirectoryFiles(chosen);
    expect(files.map(file => file.name)).toEqual(['group/safe.json']);
    expect(Buffer.from(files[0].b64, 'base64').toString()).toBe('{"name":"safe"}');
  });
});

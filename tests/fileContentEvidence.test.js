import { expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { digestFile } = require('../electron/file-content-evidence');

it('非同步開檔期間 A 被換成 B 再換回 A，不採信實際讀到 B 的 handle', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-content-evidence-'));
  const selected = path.join(root, 'project.subtool'), held = path.join(root, 'held.subtool'), foreign = path.join(root, 'foreign.subtool');
  fs.writeFileSync(selected, 'original bytes A'); fs.writeFileSync(foreign, 'different file B');
  const expected = fs.lstatSync(selected, { bigint: true });
  let opened;
  try {
    const io = { ...fs, ...fsp, async open(file, flags) {
      fs.renameSync(selected, held); fs.renameSync(foreign, selected);
      let handle;
      try { handle = await fsp.open(file, flags); opened = await handle.stat({ bigint: true }); }
      finally { fs.renameSync(selected, foreign); fs.renameSync(held, selected); }
      return handle;
    } };
    await expect(digestFile(io, selected, expected)).rejects.toThrow('檔案內容證據已變更');
    expect(opened.ino).not.toBe(expected.ino);
    expect(fs.lstatSync(selected, { bigint: true }).ino).toBe(expected.ino);
    expect(fs.readFileSync(selected, 'utf8')).toBe('original bytes A');
    expect(fs.readFileSync(foreign, 'utf8')).toBe('different file B');
  } finally {
    const actual = fs.realpathSync(root);
    expect(path.dirname(actual)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(actual).startsWith('subtool-content-evidence-')).toBe(true);
    fs.rmSync(actual, { recursive: true, force: true });
  }
});

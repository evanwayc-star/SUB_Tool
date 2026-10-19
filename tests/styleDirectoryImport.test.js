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
  it('匯入多層目錄中各種大小寫副檔名的 JSON 樣式，並略過其他格式', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-style-import-'));
    roots.push(fixture);
    const nested = path.join(fixture, 'group', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'lower.json'), '{"name":"小寫","style":{"fontSize":40}}');
    fs.writeFileSync(path.join(fixture, 'group', 'upper.JSON'), '{"name":"大寫","style":{"fontSize":60}}');
    fs.writeFileSync(path.join(nested, 'mixed.JsOn'), '{"name":"混合","style":{"fontSize":80}}');
    fs.writeFileSync(path.join(nested, 'backup.json.bak'), '{"name":"備份"}');
    fs.writeFileSync(path.join(nested, 'notes.txt'), '{"name":"非JSON副檔名"}');

    const files = collectStyleDirectoryFiles(fixture);
    expect(Object.fromEntries(files.map(file => [
      file.name, JSON.parse(Buffer.from(file.b64, 'base64').toString()),
    ]))).toEqual({
      'lower.json': { name: '小寫', style: { fontSize: 40 } },
      'group/upper.JSON': { name: '大寫', style: { fontSize: 60 } },
      'group/nested/mixed.JsOn': { name: '混合', style: { fontSize: 80 } },
    });
  });

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

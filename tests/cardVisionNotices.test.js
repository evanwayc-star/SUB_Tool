import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { renderCrateNotices } = require('../scripts/release/card-vision-notices');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'subtool-card-notices-'));
  directories.push(directory);
  const metadata = { packages: [{ id:'root', name:'app', version:'1' }],
    resolve: { root:'root', nodes:[{ id:'root', dependencies:[] }] } };
  function add(name, version, files, options = {}) {
    const packageDir = path.join(directory, name + '-' + version);
    mkdirSync(packageDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(packageDir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    }
    const id = name + '@' + version;
    metadata.packages.push({ id, name, version, manifest_path:path.join(packageDir, 'Cargo.toml'),
      license:'MIT', authors:['Upstream author'], ...options });
    metadata.resolve.nodes.push({ id, dependencies:[] });
    metadata.resolve.nodes[0].dependencies.push(id);
    return id;
  }
  const render = () => renderCrateNotices(metadata, { target:'x86_64-pc-windows-msvc',
    lockBytes:Buffer.from('exact locked dependency versions'), rustVersion:'rustc test-version' });
  return { directory, metadata, add, render };
}

describe('Rust 原生執行檔的第三方授權文字', () => {
  it('保留不同版本、巢狀授權與自訂 license_file 原文，不洩漏本機 Cargo 路徑', () => {
    const f = fixture();
    f.add('same-crate', '1.0.0', { 'LICENSE-MIT':'Copyright old author\nPermission notice old' });
    f.add('same-crate', '2.0.0', { 'LICENSE-MIT':'Copyright new author\nPermission notice new',
      'third_party/fiat/LICENSE':'Vendored copyright\nComplete vendored permission' });
    f.add('special-crate', '3.0.0', { 'legal/terms.txt':'Entire custom license terms' },
      { license:null, license_file:'legal/terms.txt' });
    f.add('unreachable-crate', '4.0.0', {});
    f.metadata.resolve.nodes[0].dependencies.pop();
    const result = f.render();
    for (const expected of ['same-crate 1.0.0', 'same-crate 2.0.0', 'Copyright old author',
      'Copyright new author', 'Complete vendored permission', 'Entire custom license terms']) {
      expect(result).toContain(expected);
    }
    expect(result).toContain('Resolved dependencies: 3');
    expect(result).toMatch(/Cargo.lock SHA-256: [a-f0-9]{64}/);
    expect(result).not.toContain('unreachable-crate');
    expect(result).not.toContain(f.directory);
    expect(result).toBe(f.render());
  });

  it('缺少授權原文時拒絕完成，而非只放 SPDX 名稱', () => {
    const f = fixture();
    f.add('missing-license', '1.2.3', { 'README.md':'MIT licensed' });
    expect(f.render).toThrow('缺少實際授權檔：missing-license 1.2.3');
  });

  it('拒絕不完整依賴圖或指向套件外的授權檔', () => {
    const f = fixture();
    f.metadata.resolve.nodes[0].dependencies.push('missing-node');
    expect(f.render).toThrow('依賴圖不完整');
    f.metadata.resolve.nodes[0].dependencies.pop();
    writeFileSync(path.join(f.directory, 'outside.txt'), 'outside data');
    f.add('outside-license', '1', {}, { license_file:'../outside.txt' });
    expect(f.render).toThrow('授權檔超出套件目錄');
  });
});

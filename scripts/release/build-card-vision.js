'use strict';

// Build the host's headless VLM engine. Requires the Rust 2024 toolchain and a native linker.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateCardVisionNotices } = require('./card-vision-notices');

if (!['win32-x64', 'darwin-arm64'].includes(`${process.platform}-${process.arch}`)) {
  throw new Error('畫面文字辨識引擎須在 Windows x64 或 Apple Silicon 主機原生建置');
}
const root = path.resolve(__dirname, '..', '..', 'electron', 'card-vision');
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'aarch64-apple-darwin';
// Metadata also resolves build dependencies. Fetch the locked target graph so
// notices can be generated offline even on a fresh CI or Mac machine.
const fetched = spawnSync('cargo', ['fetch', '--locked', '--target', target, '--manifest-path', path.join(root, 'Cargo.toml')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (fetched.error) throw fetched.error;
if (fetched.status !== 0) process.exit(fetched.status || 1);
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'Cargo.toml')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const name = `subtool-card-vision${process.platform === 'win32' ? '.exe' : ''}`;
const output = path.join(root, 'bin', `${process.platform}-${process.arch}`);
generateCardVisionNotices({ root, output, target });
fs.copyFileSync(path.join(root, 'target', 'release', name), path.join(output, name));
if (process.platform !== 'win32') fs.chmodSync(path.join(output, name), 0o755);
console.log(`畫面文字辨識引擎：${path.join(output, name)}`);

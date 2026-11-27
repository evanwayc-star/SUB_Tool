'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CRATE_NOTICES = 'THIRD_PARTY_NOTICES.txt';
const RUST_NOTICES = 'RUST_STANDARD_LIBRARY_NOTICES.html';
const NOTICE_NAME = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[-_.]|$)/i;

function readNotice(file) {
  const bytes = fs.readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim() || text.includes('\0')) throw new Error(`授權檔不是有效文字：${file}`);
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function packageNotices(pkg) {
  const root = fs.realpathSync(path.dirname(pkg.manifest_path));
  const files = new Set();
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !['.git', 'target'].includes(entry.name)) walk(file);
      else if (entry.isFile() && NOTICE_NAME.test(entry.name)) files.add(file);
    }
  };
  walk(root);
  if (pkg.license_file) {
    const declared = fs.realpathSync(path.resolve(root, pkg.license_file));
    const relative = path.relative(root, declared);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new Error(`授權檔超出套件目錄：${pkg.name} ${pkg.version}`);
    }
    files.add(declared);
  }
  if (!files.size) throw new Error(`缺少實際授權檔：${pkg.name} ${pkg.version}`);
  return [...files].sort().map(file => ({
    name: path.relative(root, file).split(path.sep).join('/'),
    text: readNotice(file),
  }));
}

function renderCrateNotices(metadata, { target, lockBytes, rustVersion }) {
  const nodes = new Map(metadata.resolve?.nodes?.map(node => [node.id, node]));
  const packages = new Map(metadata.packages?.map(pkg => [pkg.id, pkg]));
  const root = metadata.resolve?.root;
  if (!root || !nodes.has(root)) throw new Error('Cargo metadata 缺少原生核心依賴圖');
  const visited = new Set();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    const node = nodes.get(id);
    if (!node || !packages.has(id)) throw new Error('Cargo metadata 依賴圖不完整');
    visited.add(id);
    pending.push(...node.dependencies);
  }
  const dependencies = [...visited].filter(id => id !== root).map(id => packages.get(id))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const sections = [
    'SUB Tool card-vision — third-party notices',
    'Core adapted from the user-provided kvariety-card-vision Rust implementation.',
    `Target: ${target}`,
    `Toolchain: ${rustVersion}`,
    `Cargo.lock SHA-256: ${crypto.createHash('sha256').update(lockBytes).digest('hex')}`,
    `Resolved dependencies: ${dependencies.length}`,
    'This inventory includes the target-resolved Cargo dependency graph, including build dependencies.',
    'License expressions and full notice texts below are copied from the exact resolved packages.',
    `Rust standard-library notices are included separately in ${RUST_NOTICES}.`,
  ];
  for (const pkg of dependencies) {
    sections.push('\n' + '='.repeat(72), `${pkg.name} ${pkg.version}`,
      `Declared license: ${pkg.license || '(see supplied license file)'}`);
    if (pkg.authors?.length) sections.push(`Authors: ${pkg.authors.join('; ')}`);
    for (const notice of packageNotices(pkg)) sections.push(`\n--- ${notice.name} ---\n`, notice.text);
  }
  return sections.join('\n') + '\n';
}

function commandText(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true,
    maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 授權資料讀取失敗：${result.stderr?.trim() || result.status}`);
  return result.stdout.trim();
}

function generateCardVisionNotices({ root, output, target }) {
  const metadata = JSON.parse(commandText('cargo', ['metadata', '--locked', '--offline',
    '--filter-platform', target, '--format-version', '1', '--manifest-path', path.join(root, 'Cargo.toml')], root));
  const sysroot = commandText('rustc', ['--print', 'sysroot'], root);
  const rustVersion = commandText('rustc', ['--version'], root);
  const rustDocs = path.join(sysroot, 'share', 'doc', 'rust');
  const rustLicense = ['COPYRIGHT-library.html', 'COPYRIGHT.html']
    .map(name => path.join(rustDocs, name)).find(file => fs.existsSync(file));
  if (!rustLicense) throw new Error('Rust 工具鏈缺少標準函式庫授權資料，無法完成封裝');
  const rustText = readNotice(rustLicense);
  const crateText = renderCrateNotices(metadata, { target, rustVersion,
    lockBytes: fs.readFileSync(path.join(root, 'Cargo.lock')) });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, CRATE_NOTICES), crateText, 'utf8');
  fs.writeFileSync(path.join(output, RUST_NOTICES), rustText + '\n', 'utf8');
}

module.exports = { CRATE_NOTICES, RUST_NOTICES, renderCrateNotices, generateCardVisionNotices };

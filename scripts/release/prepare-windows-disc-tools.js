'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { path7za } = require('7zip-bin');
const manifest = require('../../electron/disc-tools.json');

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function matches(filename, expected) {
  try { return sha256(await fs.readFile(filename)) === expected; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function download(url, expectedHash, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`光碟工具下載失敗：HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expectedHash) throw new Error(`光碟工具 SHA-256 不符：${url}`);
  return bytes;
}

function probeTools(directory) {
  for (const [name, args, expected, statuses] of [
    ['dvdauthor.exe', ['--version'], /version 0\.7\.1-patched\./, [0]],
    ['mkisofs.exe', ['-version'], /mkisofs 3\.02a09/, [0]],
    // tsMuxeR's help intentionally returns -1 rather than success.
    ['tsMuxeR.exe', [], /tsMuxeR version 2\.7\.0\./, [0, -1, 4294967295]],
  ]) {
    const result = spawnSync(path.join(directory, name), args, {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    if (result.error || !statuses.includes(result.status) || !expected.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`${name} 版本或必要 DLL 載入驗證失敗：${result.error?.message || result.status}`);
    }
  }
}

async function prepareWindowsDiscTools(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== manifest.platform || arch !== manifest.arch) {
    throw new Error(`光碟工具只能在 Windows x64 準備，目前是 ${platform}/${arch}`);
  }
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..', '..'));
  const directory = path.join(repositoryRoot, 'electron', 'disc');
  const fetchImpl = options.fetch || globalThis.fetch;
  await fs.mkdir(directory, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(directory, '.prepare-'));
  const downloaded = [], reused = [];
  const archives = new Map();
  try {
    for (const file of manifest.files) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error('光碟工具 manifest 的檔名或雜湊無效');
      }
      const destination = path.join(directory, file.name);
      if (await matches(destination, file.sha256)) { reused.push(file.name); continue; }
      let bytes;
      if (file.archive) {
        const archive = file.archive;
        if (!archives.has(archive.sha256)) {
          const zipPath = path.join(scratch, `${archive.sha256}.zip`);
          await fs.writeFile(zipPath, await download(archive.url, archive.sha256, fetchImpl));
          archives.set(archive.sha256, zipPath);
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(archive.entry)) throw new Error('光碟工具壓縮檔項目無效');
        // Read only the named member; no paths from an archive are written to disk.
        const extracted = spawnSync(path7za, ['e', '-so', archives.get(archive.sha256), archive.entry], {
          windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
        });
        if (extracted.error || extracted.status !== 0) throw new Error(`${file.name} 解壓縮失敗`);
        bytes = extracted.stdout;
        if (sha256(bytes) !== file.sha256) throw new Error(`${file.name} 解壓縮後 SHA-256 不符`);
      } else bytes = await download(file.url, file.sha256, fetchImpl);
      const staged = path.join(scratch, file.name);
      await fs.writeFile(staged, bytes);
      await fs.rename(staged, destination);
      downloaded.push(file.name);
    }
    probeTools(directory);
    return { directory, downloaded, reused };
  } finally {
    // mkdtemp made this child beneath the fixed destination; never remove supplied paths.
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main(argv) {
  const index = argv.indexOf('--repository-root');
  const result = await prepareWindowsDiscTools({ repositoryRoot: index >= 0 ? argv[index + 1] : undefined });
  console.log(`Windows 光碟工具準備完成：${result.directory}\n下載 ${result.downloaded.length}，雜湊核對沿用 ${result.reused.length}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { prepareWindowsDiscTools };

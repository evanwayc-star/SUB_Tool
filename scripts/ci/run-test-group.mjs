import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsTestFiles } from './test-groups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const group = process.argv[2];
if (!['portable', 'windows'].includes(group)) {
  console.error('用法：node scripts/ci/run-test-group.mjs <portable|windows>');
  process.exit(2);
}

const windowsTests = windowsTestFiles(ROOT);

if (windowsTests.length === 0) {
  console.error('找不到標記為 Windows 的測試。');
  process.exit(2);
}

if (group === 'windows' && process.platform !== 'win32') {
  console.error(`Windows 測試群組不可在 ${process.platform} 執行。`);
  process.exit(2);
}

// Select the actual project: root --exclude is not a project selector and can
// leave a child's explicit include active after config inheritance.
const args = ['run', '--project', group === 'portable' ? 'portable' : 'windows-native'];
if (group === 'windows') {
  args.push(...windowsTests, '--maxWorkers=1');
}

const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const testEnv = { ...process.env };
if (group === 'windows') {
  // Electron 44 本身改由 require 延遲下載；專案 postinstall 會預先建立 dist。
  // CI 即使略過 install scripts，也要在直接使用執行檔路徑前準備 runtime。
  require('electron');
  const bundledFfmpeg = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
  const bundledFfprobe = path.join(ROOT, 'electron', 'ffmpeg', 'ffprobe.exe');
  testEnv.FFMPEG_PATH ||= existsSync(bundledFfmpeg) ? bundledFfmpeg : require('ffmpeg-static');
  testEnv.FFPROBE_PATH ||= existsSync(bundledFfprobe) ? bundledFfprobe : require('@derhuerst/ffprobe-static');
}
const result = spawnSync(process.execPath, [vitest, ...args], {
  cwd: ROOT,
  env: testEnv,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

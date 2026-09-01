import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_ROOT = path.join(ROOT, 'tests');
const WINDOWS_MARKER = '// @subtool-ci windows';

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(absolute);
    return entry.name.endsWith('.test.js') ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

const group = process.argv[2];
if (!['portable', 'windows'].includes(group)) {
  console.error('用法：node scripts/ci/run-test-group.mjs <portable|windows>');
  process.exit(2);
}

const windowsTests = collectTestFiles(TEST_ROOT)
  .filter(file => readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] === WINDOWS_MARKER)
  .map(relative)
  .sort();

if (windowsTests.length === 0) {
  console.error('找不到標記為 Windows 的測試。');
  process.exit(2);
}

if (group === 'windows' && process.platform !== 'win32') {
  console.error(`Windows 測試群組不可在 ${process.platform} 執行。`);
  process.exit(2);
}

const args = ['run'];
if (group === 'portable') {
  for (const file of windowsTests) args.push('--exclude', file);
} else {
  args.push(...windowsTests, '--maxWorkers=1');
}

const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

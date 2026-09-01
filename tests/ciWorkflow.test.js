import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_MARKER = '// @subtool-ci windows';

function isWindowsTest(source) {
  return source.split(/\r?\n/, 1)[0] === WINDOWS_MARKER;
}

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(absolute);
    return entry.name.endsWith('.test.js') ? [absolute] : [];
  });
}

describe('GitHub Actions 平台分流', () => {
  it('Ubuntu 與 Windows 使用不同測試群組，避免桌面測試在 Linux 假失敗', () => {
    const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('npm run test:ci:portable');
    expect(workflow).toContain('npm run test:ci:windows');
    expect(workflow.split(/\r?\n/).filter(line => /^\s*- run: npm test(?:\s|$)/.test(line))).toEqual([]);
    expect(workflow).not.toContain('actions/checkout@v4');
    expect(workflow).not.toContain('actions/setup-node@v4');
    expect(pkg.scripts['test:ci:portable']).toBe('node scripts/ci/run-test-group.mjs portable');
    expect(pkg.scripts['test:ci:windows']).toBe('node scripts/ci/run-test-group.mjs windows');
  });

  it('所有直接啟動 Electron 的測試都明確歸入 Windows 群組', () => {
    const unclassified = testFiles(path.join(ROOT, 'tests'))
      .filter(file => /\bspawn\s*\(\s*ELECTRON\s*,/.test(readFileSync(file, 'utf8')))
      .filter(file => !isWindowsTest(readFileSync(file, 'utf8')))
      .map(file => path.relative(ROOT, file).replaceAll('\\', '/'));

    expect(unclassified).toEqual([]);
    expect(isWindowsTest(readFileSync(path.join(ROOT, 'tests', 'projectWorkspace.test.js'), 'utf8'))).toBe(true);
  });
});

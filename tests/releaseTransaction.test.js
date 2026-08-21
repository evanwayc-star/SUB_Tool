import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nodeFs = require('node:fs');
const RELEASE_SCRIPT = path.resolve('scripts/release/release-transaction.js');
const {
  collectProductionSourceFiles,
  prepareRelease,
  verifyReleaseState,
} = require('../scripts/release/release-transaction.js');

const tempRoots = [];

function createRepositoryFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'subtool-release-transaction-'));
  tempRoots.push(rootDir);

  writeFileSync(path.join(rootDir, 'package.json'), `${JSON.stringify({
    name: 'sub-tool',
    version: '6.3.30',
    scripts: { test: 'vitest run' },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(rootDir, 'package-lock.json'), `${JSON.stringify({
    name: 'sub-tool',
    version: '6.3.30',
    lockfileVersion: 3,
    packages: { '': { name: 'sub-tool', version: '6.3.30' } },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(
    path.join(rootDir, 'CHANGELOG.md'),
    [
      '# CHANGELOG — SUB Tool',
      '',
      '導言。',
      '',
      '> **⚠ 絕對不要對這個檔案做版號的全域字串取代。**',
      '',
      '---',
      '',
      '## [v6.3.30] - 2026-08-20',
      '',
      '- v5.2.0 造成的歷史問題仍應保留原版號。',
      '',
      '### 驗證',
      '',
      '- 既有版本已驗證。',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(path.join(rootDir, 'README.md'), 'do not touch\r\n', 'utf8');
  return rootDir;
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('release transaction', () => {
  it('只更新兩份 manifest 版號並在導言後插入單一版本區段', () => {
    const rootDir = createRepositoryFixture();

    const result = prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 外部音訊在前段 gap 仍會持續播放。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles: ['src/playback-sync-engine.js'],
    });

    expect(result).toEqual({
      version: '6.3.31',
      changedFiles: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
    });
    expect(JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version).toBe('6.3.31');
    const packageLock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
    expect(packageLock.version).toBe('6.3.31');
    expect(packageLock.packages[''].version).toBe('6.3.31');

    const changelog = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
    expect(changelog.match(/^## \[v6\.3\.31\]/gm)).toHaveLength(1);
    expect(changelog.indexOf('## [v6.3.31]')).toBeLessThan(changelog.indexOf('## [v6.3.30]'));
    expect(changelog).toContain('v5.2.0 造成的歷史問題仍應保留原版號。');
    expect(changelog).toContain('\r\n## [v6.3.31] - 2026-08-20\r\n');
    expect(readFileSync(path.join(rootDir, 'README.md'), 'utf8')).toBe('do not touch\r\n');
  });

  it('保留三個 release 檔案的 CRLF 且不產生 bare CR', () => {
    const rootDir = createRepositoryFixture();
    for (const file of ['package.json', 'package-lock.json']) {
      const filePath = path.join(rootDir, file);
      writeFileSync(filePath, readFileSync(filePath, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
    }

    prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 修正播放同步。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles: ['src/playback-sync-engine.js'],
    });

    for (const file of ['package.json', 'package-lock.json', 'CHANGELOG.md']) {
      const content = readFileSync(path.join(rootDir, file), 'utf8');
      expect(content).toContain('\r\n');
      expect(content).not.toMatch(/(?<!\r)\n/);
      expect(content).not.toMatch(/\r(?!\n)/);
    }
  });

  it('缺少 production source evidence 時整個 transaction 不寫入', () => {
    const rootDir = createRepositoryFixture();
    const packageBefore = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const lockBefore = readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
    const changelogBefore = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 只有文件敘述，沒有實際修復。',
      sourceFiles: ['docs/版本變更紀錄.md'],
    })).toThrow(/production source evidence/i);

    expect(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toBe(changelogBefore);
  });

  it('驗證跨平台換行並拒絕目前版本重複', () => {
    const rootDir = createRepositoryFixture();
    const sourceFiles = ['src/playback-sync-engine.js'];
    prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 修正 gap transition。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles,
    });

    expect(verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles })).toEqual({
      version: '6.3.31',
      firstVersion: '6.3.31',
      productionSourceFiles: ['src/playback-sync-engine.js'],
    });

    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      `${readFileSync(changelogPath, 'utf8')}\r\n## [v6.3.31] - 2026-08-20\r\n`,
      'utf8',
    );
    expect(() => verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles }))
      .toThrow(/duplicate changelog version: v6\.3\.31/i);
  });

  it('保留不同日期重用舊版號的歷史事實', () => {
    const rootDir = createRepositoryFixture();
    const sourceFiles = ['src/playback-sync-engine.js'];
    prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 修正 gap transition。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles,
    });
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      `${readFileSync(changelogPath, 'utf8')}\r\n## [v6.3.30] - 2026-08-01\r\n\r\n### 驗證\r\n\r\n- 舊歷史。\r\n`,
      'utf8',
    );

    expect(verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles }))
      .toMatchObject({ version: '6.3.31', firstVersion: '6.3.31' });
  });

  it('從最新 Git tag 收集 tracked 與 untracked production source evidence', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'subtool-release-git-'));
    tempRoots.push(rootDir);
    mkdirSync(path.join(rootDir, 'src'));
    mkdirSync(path.join(rootDir, 'electron'));
    mkdirSync(path.join(rootDir, 'docs'));
    writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    writeFileSync(path.join(rootDir, 'src', 'existing.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(rootDir, 'docs', 'guide.md'), 'old\n', 'utf8');
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v1.0.0'], { cwd: rootDir });

    writeFileSync(path.join(rootDir, 'src', 'existing.js'), 'export const value = 2;\n', 'utf8');
    writeFileSync(path.join(rootDir, 'electron', 'new-runtime.js'), "'use strict';\n", 'utf8');
    writeFileSync(path.join(rootDir, 'docs', 'guide.md'), 'new\n', 'utf8');

    expect(collectProductionSourceFiles({ rootDir })).toEqual([
      'electron/new-runtime.js',
      'src/existing.js',
    ]);
  });

  it('目前版本尚無 tag 時不重用更舊 release 已包含的 source delta', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'subtool-release-boundary-'));
    tempRoots.push(rootDir);
    mkdirSync(path.join(rootDir, 'src'));
    writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'release v1.0.0'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v1.0.0'], { cwd: rootDir });

    writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.1.0"}\n', 'utf8');
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 2;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'release v1.1.0'], { cwd: rootDir, stdio: 'ignore' });

    expect(collectProductionSourceFiles({ rootDir })).toEqual([]);
  });

  it('拒絕名稱符合目前版本但內容版號錯置的 reachable tag', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'subtool-release-mistag-'));
    tempRoots.push(rootDir);
    mkdirSync(path.join(rootDir, 'src'));
    writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'release v1.0.0'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v1.1.0'], { cwd: rootDir });

    writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.1.0"}\n', 'utf8');
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 2;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'release v1.1.0'], { cwd: rootDir, stdio: 'ignore' });

    expect(() => collectProductionSourceFiles({ rootDir }))
      .toThrow(/tag v1\.1\.0 contains package version v1\.0\.0, expected v1\.1\.0/i);
  });

  it('verify CLI 在封裝前輸出已核對的版本與 source evidence', () => {
    const rootDir = createRepositoryFixture();
    mkdirSync(path.join(rootDir, 'src'));
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v6.3.29'], { cwd: rootDir });
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 2;\n', 'utf8');

    const output = execFileSync(
      process.execPath,
      [RELEASE_SCRIPT, 'verify', '--root', rootDir, '--changelog', 'CHANGELOG.md'],
      { encoding: 'utf8' },
    );

    expect(output.trim()).toBe('Release source verified: v6.3.30 (1 production source file)');
  });

  it('prepare CLI 從 notes file 完成同一個 release transaction', () => {
    const rootDir = createRepositoryFixture();
    mkdirSync(path.join(rootDir, 'src'));
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(
      path.join(rootDir, 'release-notes.md'),
      '### 修復\n\n- 修正播放同步。\n\n### 驗證\n\n- regression test 通過。\n',
      'utf8',
    );
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v6.3.30'], { cwd: rootDir });
    writeFileSync(path.join(rootDir, 'src', 'runtime.js'), 'export const value = 2;\n', 'utf8');

    const output = execFileSync(
      process.execPath,
      [
        RELEASE_SCRIPT,
        'prepare',
        '--root', rootDir,
        '--changelog', 'CHANGELOG.md',
        '--version', '6.3.31',
        '--date', '2026-08-20',
        '--notes', 'release-notes.md',
      ],
      { encoding: 'utf8' },
    );

    expect(output.trim()).toBe('Release prepared: v6.3.31 (3 files)');
    expect(JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version).toBe('6.3.31');
    expect(readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8').match(/^## \[v6\.3\.31\]/gm))
      .toHaveLength(1);
  });

  it('package scripts 讓 prepare 與 predist 共用同一個 release guard', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));

    expect(packageJson.scripts['release:prepare'])
      .toBe('node scripts/release/release-transaction.js prepare');
    expect(packageJson.scripts['release:verify-source'])
      .toBe('node scripts/release/release-transaction.js verify');
    expect(packageJson.scripts.predist)
      .toBe('npm run release:verify-source && node scripts/release/verify-native-binaries.js --platform win32 --arch x64');
  });

  it('任何 content guard 失敗都在 manifest 寫入前中止', () => {
    const rootDir = createRepositoryFixture();
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, 'utf8').replace(
        '> **⚠ 絕對不要對這個檔案做版號的全域字串取代。**\r\n',
        '',
      ),
      'utf8',
    );
    const packageBefore = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const lockBefore = readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
    const changelogBefore = readFileSync(changelogPath, 'utf8');

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 修正播放同步。',
      sourceFiles: ['src/playback-sync-engine.js'],
    })).toThrow(/warning/i);

    expect(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(changelogPath, 'utf8')).toBe(changelogBefore);
  });

  it('任一檔案寫入失敗時回復整個 release transaction', () => {
    const rootDir = createRepositoryFixture();
    const packageBefore = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const lockBefore = readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
    const changelogBefore = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
    const writeFile = nodeFs.writeFileSync.bind(nodeFs);
    let writeCount = 0;
    const writeSpy = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation((...args) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error('simulated disk failure');
      return writeFile(...args);
    });

    try {
      expect(() => prepareRelease({
        rootDir,
        changelogPath: 'CHANGELOG.md',
        version: '6.3.31',
        date: '2026-08-20',
        body: '### 修復\n\n- 修正播放同步。\n\n### 驗證\n\n- 行為測試通過。',
        sourceFiles: ['src/playback-sync-engine.js'],
      })).toThrow(/simulated disk failure/i);
    } finally {
      writeSpy.mockRestore();
    }

    expect(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toBe(changelogBefore);
  });

  it('變更紀錄沒有驗證證據時不允許完成 release preparation', () => {
    const rootDir = createRepositoryFixture();

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 只說修了什麼，沒有記錄怎麼驗。',
      sourceFiles: ['src/playback-sync-engine.js'],
    })).toThrow(/verification section/i);
  });

  it('變更紀錄的驗證標題沒有內容時不允許完成 release preparation', () => {
    const rootDir = createRepositoryFixture();
    const packageBefore = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const lockBefore = readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
    const changelogBefore = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 修正播放同步。\n\n### 驗證',
      sourceFiles: ['src/playback-sync-engine.js'],
    })).toThrow(/verification evidence/i);

    expect(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toBe(changelogBefore);
  });

  it('notes body 不可自行注入另一個版本標題', () => {
    const rootDir = createRepositoryFixture();
    const changelogBefore = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 合法內文。\n\n### 驗證\n\n- 測試通過。\n\n## [v9.9.9] - 2099-01-01',
      sourceFiles: ['src/playback-sync-engine.js'],
    })).toThrow(/must not contain a version heading/i);

    expect(readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8')).toBe(changelogBefore);
  });

  it('notes body 不可用 CommonMark 允許的縮排注入版本標題', () => {
    const rootDir = createRepositoryFixture();
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    const changelogBefore = readFileSync(changelogPath, 'utf8');

    expect(() => prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 合法內文。\n\n### 驗證\n\n- 測試通過。\n\n ## [v9.9.9] - 2099-01-01',
      sourceFiles: ['src/playback-sync-engine.js'],
    })).toThrow(/must not contain a version heading/i);

    expect(readFileSync(changelogPath, 'utf8')).toBe(changelogBefore);
  });

  it('verify 也拒絕手動縮排加入的目前版本標題', () => {
    const rootDir = createRepositoryFixture();
    const sourceFiles = ['src/playback-sync-engine.js'];
    prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 合法內文。\n\n### 驗證\n\n- 測試通過。',
      sourceFiles,
    });
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      `${readFileSync(changelogPath, 'utf8')}\r\n ## [v6.3.31] - 2026-08-20\r\n`,
      'utf8',
    );

    expect(() => verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles }))
      .toThrow(/duplicate changelog version: v6\.3\.31/i);
  });
});

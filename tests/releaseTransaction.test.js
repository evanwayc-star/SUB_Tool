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

function createPreparedGitFixture(version = '6.3.31') {
  const rootDir = createRepositoryFixture();
  mkdirSync(path.join(rootDir, 'src'));
  const sourcePath = path.join(rootDir, 'src', 'runtime.js');
  writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: rootDir });
  execFileSync('git', ['add', '.'], { cwd: rootDir });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
  writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
  const options = {
    rootDir, changelogPath: 'CHANGELOG.md', version, date: '2026-08-20',
    body: '### 修復\n\n- 原先待發版項目。\n\n### 驗證\n\n- 已完成初次驗證。',
    sourceFiles: ['src/runtime.js'],
  };
  prepareRelease(options);
  return { rootDir, options };
}

function releaseContents(rootDir) {
  return ['package.json', 'package-lock.json', 'CHANGELOG.md']
    .map(file => readFileSync(path.join(rootDir, file), 'utf8'));
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('release transaction', () => {
  it.each([
    '2026-02-30', '2026-04-31', '2026-02-29', '2100-02-29',
    '2026-00-10', '2026-13-01', '2026-10-00', '2026-10-32',
  ])('不存在的曆日 %s 在三檔寫入前拒絕', date => {
    const rootDir = createRepositoryFixture();
    const before = releaseContents(rootDir);

    expect(() => prepareRelease({
      rootDir, changelogPath: 'CHANGELOG.md', version: '6.3.31', date,
      body: '### 修復\n\n- 修正發版日期驗證。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles: ['src/runtime.js'],
    })).toThrow(/invalid release date/i);
    expect(releaseContents(rootDir)).toEqual(before);
  });

  it.each(['2024-02-29', '2000-02-29', '2026-02-28'])('合法曆日 %s 原樣寫入新版本標題', date => {
    const rootDir = createRepositoryFixture();

    prepareRelease({
      rootDir, changelogPath: 'CHANGELOG.md', version: '6.3.31', date,
      body: '### 修復\n\n- 修正發版日期驗證。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles: ['src/runtime.js'],
    });

    expect(releaseContents(rootDir)[2]).toContain(`## [v6.3.31] - ${date}`);
    expect(verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles: ['src/runtime.js'] }))
      .toMatchObject({ version: '6.3.31', firstVersion: '6.3.31' });
  });

  describe('replace-current prepared notes', () => {
    const replacementBody = '### 修復\n\n- 使用者追加永久快取需求。\n\n### 驗證\n\n- 重開後快取與原波形驗證通過。';

    it('只替換未提交版本的最上方 notes，保留 manifest、導言與歷史原始內容', () => {
      const { rootDir, options } = createPreparedGitFixture();
      const before = releaseContents(rootDir);
      const introduction = before[2].slice(0, before[2].indexOf('### 修復'));
      const history = before[2].slice(before[2].indexOf('## [v6.3.30]'));

      expect(prepareRelease({ ...options, replaceCurrent: true, body: replacementBody }))
        .toEqual({ version: '6.3.31', changedFiles: ['package.json', 'package-lock.json', 'CHANGELOG.md'] });

      const after = releaseContents(rootDir);
      expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
      expect(after[2]).toBe(`${introduction}${replacementBody.replaceAll('\n', '\r\n')}\r\n\r\n${history}`);
      expect(after[2].match(/^## \[v6\.3\.31\]/gm)).toHaveLength(1);
      expect(after[2]).not.toContain('原先待發版項目');
      expect(JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: rootDir, encoding: 'utf8' })).version)
        .toBe('6.3.30');
    });

    it('一般 prepare 仍拒絕重複目前版號', () => {
      const { rootDir, options } = createPreparedGitFixture();
      const before = releaseContents(rootDir);
      expect(() => prepareRelease({ ...options, body: replacementBody })).toThrow(/already contains v6\.3\.31/i);
      expect(releaseContents(rootDir)).toEqual(before);
    });

    it.each([
      ['不同要求版本', options => ({ ...options, version: '6.3.32' }), null, /current manifest version/i],
      ['不同第一節版本', options => options, text => text.replace('## [v6.3.31]', '## [v6.3.32]'), /first changelog version/i],
      ['重複目前版本', options => options, text => `${text}\r\n ## [v6.3.31] - 2026-08-20\r\n`, /duplicate changelog version/i],
      ['更改已準備日期', options => ({ ...options, date: '2026-08-21' }), null, /retain.*heading and date/i],
      ['缺少驗證的新 notes', options => ({ ...options, body: '### 修復\n\n- 無驗證。' }), null, /verification section/i],
    ])('%s 在三檔寫入前拒絕', (_name, changeOptions, changeChangelog, expected) => {
      const { rootDir, options } = createPreparedGitFixture();
      if (changeChangelog) {
        const changelogPath = path.join(rootDir, 'CHANGELOG.md');
        writeFileSync(changelogPath, changeChangelog(readFileSync(changelogPath, 'utf8')), 'utf8');
      }
      const before = releaseContents(rootDir);
      expect(() => prepareRelease(changeOptions({ ...options, replaceCurrent: true, body: replacementBody })))
        .toThrow(expected);
      expect(releaseContents(rootDir)).toEqual(before);
    });

    it.each(['committed', 'tagged'])('拒絕 %s 版本，即使有新的 production source evidence', state => {
      const { rootDir, options } = createPreparedGitFixture();
      if (state === 'committed') {
        execFileSync('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md'], { cwd: rootDir });
        execFileSync('git', ['commit', '-m', 'prepared release'], { cwd: rootDir, stdio: 'ignore' });
      } else {
        execFileSync('git', ['tag', '-a', 'v6.3.31', '-m', 'allocated release'], { cwd: rootDir });
      }
      const before = releaseContents(rootDir);
      expect(() => prepareRelease({ ...options, replaceCurrent: true, body: replacementBody }))
        .toThrow(new RegExp(`for ${state} release`, 'i'));
      expect(releaseContents(rootDir)).toEqual(before);
    });

    it('要求 Git HEAD 的已提交 manifest 較舊，不能用替換模式回改舊版', () => {
      const { rootDir, options } = createPreparedGitFixture();
      // Simulate a manually corrupted prepared state; normal prepare now rejects downgrades.
      options.version = '6.3.29';
      for (const file of ['package.json', 'package-lock.json']) {
        const filename = path.join(rootDir, file);
        const manifest = JSON.parse(readFileSync(filename, 'utf8'));
        manifest.version = options.version;
        if (manifest.packages?.['']) manifest.packages[''].version = options.version;
        writeFileSync(filename, JSON.stringify(manifest));
      }
      const changelogFile = path.join(rootDir, 'CHANGELOG.md');
      writeFileSync(changelogFile, readFileSync(changelogFile, 'utf8').replace('## [v6.3.31]', '## [v6.3.29]'));
      const before = releaseContents(rootDir);
      expect(() => prepareRelease({ ...options, replaceCurrent: true, body: replacementBody }))
        .toThrow(/older committed manifest version/i);
      expect(releaseContents(rootDir)).toEqual(before);
    });

    it('替換第三檔部分寫入失敗也回復三檔，保留原先 prepared notes', () => {
      const { rootDir, options } = createPreparedGitFixture();
      const before = releaseContents(rootDir);
      const writeFile = nodeFs.writeFileSync.bind(nodeFs);
      let writeCount = 0;
      const writeSpy = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation((...args) => {
        writeCount += 1;
        if (writeCount === 3) {
          writeFile(args[0], 'partial notes', 'utf8');
          throw new Error('simulated partial write');
        }
        return writeFile(...args);
      });
      try {
        expect(() => prepareRelease({ ...options, replaceCurrent: true, body: replacementBody }))
          .toThrow(/simulated partial write/i);
        expect(writeSpy.mock.calls.slice(-3).map(([file]) => path.basename(file)))
          .toEqual(['CHANGELOG.md', 'package-lock.json', 'package.json']);
      } finally { writeSpy.mockRestore(); }
      expect(releaseContents(rootDir)).toEqual(before);
    });

    it('CLI 的 --replace-current true 使用同一個 transaction，且拒絕非 boolean 旗標值', () => {
      const { rootDir, options } = createPreparedGitFixture();
      writeFileSync(path.join(rootDir, 'replacement-notes.md'), replacementBody, 'utf8');
      const args = [RELEASE_SCRIPT, 'prepare', '--root', rootDir, '--changelog', 'CHANGELOG.md',
        '--version', options.version, '--date', options.date, '--notes', 'replacement-notes.md', '--replace-current'];
      expect(execFileSync(process.execPath, [...args, 'true'], { encoding: 'utf8' }).trim())
        .toBe('Release prepared: v6.3.31 (3 files)');
      const before = releaseContents(rootDir);
      expect(() => execFileSync(process.execPath, [...args, 'yes'], { stdio: ['ignore', 'pipe', 'pipe'] }))
        .toThrow(/must be true or false/i);
      expect(releaseContents(rootDir)).toEqual(before);
    });
  });

  it('只更新兩份 manifest 版號並在導言後插入單一版本區段', () => {
    const rootDir = createRepositoryFixture();

    const result = prepareRelease({
      rootDir,
      changelogPath: 'CHANGELOG.md',
      version: '6.3.31',
      date: '2026-08-20',
      body: '### 修復\n\n- 外部音訊在前段 gap 仍會持續播放。\n\n### 驗證\n\n- 行為測試通過。',
      sourceFiles: ['src/media-presentation-core.js'],
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
      sourceFiles: ['src/media-presentation-core.js'],
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

  it.each(['09.6.1', '9.06.1', '9.6.01', '9.9007199254740992.1', '9007199254740992.0.0', '9.0.9007199254740992',
    '9.6.1\n','9.6.1\r\n','9.6.1 ',' 9.6.1'])('無法原樣打包的版號 %s 在寫檔前拒絕', version => {
    const rootDir = createRepositoryFixture();
    const before = releaseContents(rootDir);
    expect(() => prepareRelease({
      rootDir, changelogPath: 'CHANGELOG.md', version, date: '2026-10-18',
      body: '### 修復\n\n- 合法修復。\n\n### 驗證\n\n- 測試通過。',
      sourceFiles: ['src/runtime.js'],
    })).toThrow(/invalid release version/i);
    expect(releaseContents(rootDir)).toEqual(before);
  });

  it('verify 拒絕三檔一致但會被打包器改寫的版號',()=>{
    const rootDir=createRepositoryFixture(),version='9.06.001';
    for(const filename of ['package.json','package-lock.json']){
      const file=path.join(rootDir,filename),data=JSON.parse(readFileSync(file,'utf8'));
      data.version=version;if(data.packages?.[''])data.packages[''].version=version;
      writeFileSync(file,JSON.stringify(data));
    }
    const changelog=path.join(rootDir,'CHANGELOG.md');
    writeFileSync(changelog,readFileSync(changelog,'utf8').replace('## [v6.3.30] - 2026-08-20',`## [v${version}] - 2026-08-20`));
    const before=releaseContents(rootDir);
    expect(()=>verifyReleaseState({rootDir,changelogPath:'CHANGELOG.md',sourceFiles:['src/runtime.js']})).toThrow(/invalid release version/i);
    expect(releaseContents(rootDir)).toEqual(before);
  });

  it.each(['6.3.29', '6.2.99', '5.99.99'])('拒絕降低版本至 %s，三檔內容保持原樣', version => {
    const rootDir = createRepositoryFixture();
    const before = releaseContents(rootDir);
    expect(() => prepareRelease({
      rootDir, changelogPath: 'CHANGELOG.md', version, date: '2026-10-16',
      body: '### 修復\n\n- 合法修復。\n\n### 驗證\n\n- 測試通過。',
      sourceFiles: ['src/runtime.js'],
    })).toThrow(/newer.*version/i);
    expect(releaseContents(rootDir)).toEqual(before);
  });

  it.each(['index.html', 'vite.config.mjs', 'font/測試字型/font.ttf'])('正式來源 %s 可獨立提供 Git 發版證據', filename => {
    const rootDir = createRepositoryFixture();
    mkdirSync(path.dirname(path.join(rootDir, filename)), { recursive: true });
    writeFileSync(path.join(rootDir, filename), 'original source\n');
    execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rootDir });
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
    execFileSync('git', ['tag', 'v6.3.30'], { cwd: rootDir });
    writeFileSync(path.join(rootDir, filename), 'fixed production source\n');
    writeFileSync(path.join(rootDir, 'README.md'), 'documentation change\n');
    const sourceFiles = collectProductionSourceFiles({ rootDir });
    expect(sourceFiles).toEqual([filename]);
    expect(prepareRelease({
      rootDir, changelogPath: 'CHANGELOG.md', version: '6.3.31', date: '2026-10-16',
      body: '### 修復\n\n- 修正根目錄正式來源。\n\n### 驗證\n\n- 根目錄來源與建置通過。', sourceFiles,
    })).toMatchObject({ version: '6.3.31' });
  });

  it.each(['dependencies', 'devDependencies', 'build', 'lockfile'])('只有 %s 變更也保留 prepare 前後的正式來源證據', change => {
    const { rootDir, options } = createPreparedGitFixture();
    // 先把既有來源修復提交成目前版本，下一版只改套件或封裝內容。
    execFileSync('git', ['add', '.'], { cwd: rootDir });
    execFileSync('git', ['commit', '-m', 'release fixture'], { cwd: rootDir, stdio: 'ignore' });
    const filename = change === 'lockfile' ? 'package-lock.json' : 'package.json';
    const file = path.join(rootDir, filename);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (change === 'lockfile') manifest.packages['node_modules/example'] = { version: '2.0.0' };
    else manifest[change] = change === 'build' ? { asarUnpack: ['electron/native.js'] } : { example: '2.0.0' };
    writeFileSync(file, JSON.stringify(manifest));
    expect(collectProductionSourceFiles({ rootDir })).toEqual([filename]);
    prepareRelease({ ...options, version: '6.3.32', sourceFiles: collectProductionSourceFiles({ rootDir }) });
    expect(collectProductionSourceFiles({ rootDir })).toEqual([filename]);
    expect(verifyReleaseState({ rootDir, changelogPath: 'CHANGELOG.md', sourceFiles: collectProductionSourceFiles({ rootDir }) }))
      .toMatchObject({ version: '6.3.32' });
  });

  it('只改版號及 JSON 排版不能自行製造正式來源證據', () => {
    const { rootDir } = createPreparedGitFixture();
    // 回復實作變動，只留下 prepare 寫入的版本與歷史紀錄。
    writeFileSync(path.join(rootDir, 'src/runtime.js'), 'export const value = 1;\n');
    for (const filename of ['package.json', 'package-lock.json']) {
      const file = path.join(rootDir, filename);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify(manifest));
    }
    expect(collectProductionSourceFiles({ rootDir })).toEqual([]);
  });

  it('驗證跨平台換行並拒絕目前版本重複', () => {
    const rootDir = createRepositoryFixture();
    const sourceFiles = ['src/media-presentation-core.js'];
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
      productionSourceFiles: ['src/media-presentation-core.js'],
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
    const sourceFiles = ['src/media-presentation-core.js'];
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
      sourceFiles: ['src/media-presentation-core.js'],
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
        sourceFiles: ['src/media-presentation-core.js'],
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
      sourceFiles: ['src/media-presentation-core.js'],
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
      sourceFiles: ['src/media-presentation-core.js'],
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
      sourceFiles: ['src/media-presentation-core.js'],
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
      sourceFiles: ['src/media-presentation-core.js'],
    })).toThrow(/must not contain a version heading/i);

    expect(readFileSync(changelogPath, 'utf8')).toBe(changelogBefore);
  });

  it('verify 也拒絕手動縮排加入的目前版本標題', () => {
    const rootDir = createRepositoryFixture();
    const sourceFiles = ['src/media-presentation-core.js'];
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

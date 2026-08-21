'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function _readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function _formatJson(value, newline) {
  return `${JSON.stringify(value, null, 2).replace(/\n/g, newline)}${newline}`;
}

function _commitFiles(files) {
  const attempted = [];
  try {
    for (const file of files) {
      attempted.push(file);
      fs.writeFileSync(file.filePath, file.nextContent, 'utf8');
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const file of attempted.reverse()) {
      try {
        fs.writeFileSync(file.filePath, file.previousContent, 'utf8');
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      error.rollbackErrors = rollbackErrors;
    }
    throw error;
  }
}

function _productionSourceFiles(sourceFiles) {
  if (!Array.isArray(sourceFiles)) return [];
  return sourceFiles
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter((file) => /^(?:src|electron|shared|scripts)\//.test(file));
}

function _gitLines(rootDir, args) {
  const output = execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function _gitJson(rootDir, revision, filePath) {
  const output = execFileSync('git', ['show', `${revision}:${filePath}`], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function _releaseEvidenceBase(rootDir) {
  const headVersion = _gitJson(rootDir, 'HEAD', 'package.json').version;
  const versionTag = `v${headVersion}`;
  const matchingTag = _gitLines(rootDir, ['tag', '--list', versionTag])[0];
  if (matchingTag) {
    const taggedVersion = _gitJson(rootDir, matchingTag, 'package.json').version;
    if (taggedVersion !== headVersion) {
      throw new Error(
        `Release evidence tag ${matchingTag} contains package version v${taggedVersion}, expected v${headVersion}`,
      );
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', matchingTag, 'HEAD'], {
        cwd: rootDir,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(`Release evidence tag ${matchingTag} is not reachable from HEAD`);
    }
    return matchingTag;
  }

  const packageCommits = _gitLines(rootDir, [
    'log', '--first-parent', '--format=%H', '--', 'package.json',
  ]);
  for (const commit of packageCommits) {
    if (_gitJson(rootDir, commit, 'package.json').version !== headVersion) continue;
    const parent = _gitLines(rootDir, ['show', '-s', '--format=%P', commit])[0]?.split(' ')[0];
    if (!parent) return commit;
    let parentVersion = null;
    try {
      parentVersion = _gitJson(rootDir, parent, 'package.json').version;
    } catch { /* package.json may have been introduced by this commit */ }
    if (parentVersion !== headVersion) return commit;
  }
  throw new Error(`Cannot find committed release boundary for v${headVersion}`);
}

function collectProductionSourceFiles({ rootDir }) {
  const evidenceBase = _releaseEvidenceBase(rootDir);
  const tracked = _gitLines(rootDir, [
    'diff',
    '--name-only',
    evidenceBase,
    '--',
  ]);
  const untracked = _gitLines(rootDir, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(_productionSourceFiles([...tracked, ...untracked]))].sort();
}

function _inspectReleaseState({ packageJson, packageLock, changelog, sourceFiles }) {
  const normalizedChangelog = changelog.replace(/\r\n/g, '\n');
  const productionSourceFiles = _productionSourceFiles(sourceFiles);

  if (!productionSourceFiles.length) {
    throw new Error('Release requires production source evidence');
  }
  if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
    throw new Error('package.json and package-lock.json versions do not match');
  }
  if (!normalizedChangelog.startsWith('# CHANGELOG — SUB Tool\n')) {
    throw new Error('Changelog header is missing or malformed');
  }
  if ((normalizedChangelog.match(/^# CHANGELOG — SUB Tool$/gm) || []).length !== 1) {
    throw new Error('Changelog must contain exactly one document title');
  }
  if ((normalizedChangelog.match(/絕對不要對這個檔案做版號的全域字串取代/g) || []).length !== 1) {
    throw new Error('Changelog mutation warning is missing or duplicated');
  }
  if (normalizedChangelog.includes('\f') || /\\n## \[v/.test(normalizedChangelog)) {
    throw new Error('Changelog contains a known corruption marker');
  }

  const versionMatches = [...normalizedChangelog.matchAll(/^ {0,3}## \[v([^\]]+)\]/gm)];
  const versions = versionMatches.map((match) => match[1]);
  const firstVersion = versions[0] || null;
  if (firstVersion !== packageJson.version) {
    throw new Error(`First changelog version v${firstVersion} does not match package version v${packageJson.version}`);
  }
  if (versions.filter((version) => version === packageJson.version).length !== 1) {
    throw new Error(`Duplicate changelog version: v${packageJson.version}`);
  }
  const firstSection = normalizedChangelog.slice(
    versionMatches[0]?.index || 0,
    versionMatches[1]?.index || normalizedChangelog.length,
  );
  const verificationHeading = /^ {0,3}### 驗證[ \t]*$/m.exec(firstSection);
  if (!verificationHeading) {
    throw new Error(`Changelog v${firstVersion} requires a verification section`);
  }
  const afterVerificationHeading = firstSection.slice(
    verificationHeading.index + verificationHeading[0].length,
  );
  const nextPeerHeading = /^ {0,3}#{1,3}(?:[ \t]+|$)/m.exec(afterVerificationHeading);
  const verificationEvidence = afterVerificationHeading
    .slice(0, nextPeerHeading?.index ?? afterVerificationHeading.length)
    .trim();
  if (!verificationEvidence) {
    throw new Error(`Changelog v${firstVersion} requires verification evidence`);
  }

  return {
    version: packageJson.version,
    firstVersion,
    productionSourceFiles,
  };
}

function verifyReleaseState({
  rootDir,
  changelogPath = path.join('docs', '版本變更紀錄.md'),
  sourceFiles,
}) {
  return _inspectReleaseState({
    packageJson: _readJson(path.join(rootDir, 'package.json')),
    packageLock: _readJson(path.join(rootDir, 'package-lock.json')),
    changelog: fs.readFileSync(path.join(rootDir, changelogPath), 'utf8'),
    sourceFiles,
  });
}

function prepareRelease({
  rootDir,
  changelogPath = path.join('docs', '版本變更紀錄.md'),
  version,
  date,
  body,
  sourceFiles,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`Invalid release date: ${date}`);
  }
  if (!String(body || '').trim()) {
    throw new Error('Release changelog body is required');
  }
  if (/^ {0,3}## \[v[^\]]+\]/m.test(String(body))) {
    throw new Error('Release notes body must not contain a version heading');
  }
  if (!_productionSourceFiles(sourceFiles).length) {
    throw new Error('Release requires production source evidence');
  }

  const packagePath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const changelogFilePath = path.join(rootDir, changelogPath);
  const packageSource = fs.readFileSync(packagePath, 'utf8');
  const packageLockSource = fs.readFileSync(packageLockPath, 'utf8');
  const packageJson = JSON.parse(packageSource);
  const packageLock = JSON.parse(packageLockSource);
  const changelog = fs.readFileSync(changelogFilePath, 'utf8');
  const packageNewline = packageSource.includes('\r\n') ? '\r\n' : '\n';
  const packageLockNewline = packageLockSource.includes('\r\n') ? '\r\n' : '\n';
  const newline = changelog.includes('\r\n') ? '\r\n' : '\n';

  if (!packageLock.packages?.['']) {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (new RegExp(`^ {0,3}## \\[v${version.replaceAll('.', '\\.')}\\]`, 'm').test(changelog)) {
    throw new Error(`Changelog already contains v${version}`);
  }

  const divider = /^---(?=\r?$)/m.exec(changelog);
  if (!divider) {
    throw new Error('Changelog introduction divider was not found');
  }
  const dividerEnd = divider.index + divider[0].length;
  const beforeVersions = changelog.slice(0, dividerEnd);
  const versionHistory = changelog.slice(dividerEnd).replace(/^(?:\r?\n)*/, '');
  const normalizedBody = String(body).trim().replace(/\r?\n/g, newline);
  const section = `## [v${version}] - ${date}${newline}${newline}${normalizedBody}`;
  const nextChangelog = `${beforeVersions}${newline}${newline}${section}${newline}${newline}${versionHistory}`;

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[''].version = version;

  _inspectReleaseState({
    packageJson,
    packageLock,
    changelog: nextChangelog,
    sourceFiles,
  });

  _commitFiles([
    {
      filePath: packagePath,
      previousContent: packageSource,
      nextContent: _formatJson(packageJson, packageNewline),
    },
    {
      filePath: packageLockPath,
      previousContent: packageLockSource,
      nextContent: _formatJson(packageLock, packageLockNewline),
    },
    {
      filePath: changelogFilePath,
      previousContent: changelog,
      nextContent: nextChangelog,
    },
  ]);

  return {
    version,
    changedFiles: ['package.json', 'package-lock.json', changelogPath],
  };
}

function _parseCliArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value == null) {
      throw new Error(`Invalid release transaction argument: ${key || ''}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function runCli(argv = process.argv.slice(2), io = console) {
  const { command, options } = _parseCliArgs(argv);
  const rootDir = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const changelogPath = options.changelog || path.join('docs', '版本變更紀錄.md');

  const sourceFiles = collectProductionSourceFiles({ rootDir });
  if (command === 'verify') {
    const result = verifyReleaseState({ rootDir, changelogPath, sourceFiles });
    const noun = result.productionSourceFiles.length === 1 ? 'file' : 'files';
    io.log(`Release source verified: v${result.version} (${result.productionSourceFiles.length} production source ${noun})`);
    return result;
  }

  if (command === 'prepare') {
    if (!options.version || !options.date || !options.notes) {
      throw new Error('Usage: release-transaction.js prepare --version X.Y.Z --date YYYY-MM-DD --notes PATH');
    }
    const notesPath = path.isAbsolute(options.notes)
      ? options.notes
      : path.join(rootDir, options.notes);
    const result = prepareRelease({
      rootDir,
      changelogPath,
      version: options.version,
      date: options.date,
      body: fs.readFileSync(notesPath, 'utf8'),
      sourceFiles,
    });
    verifyReleaseState({ rootDir, changelogPath, sourceFiles });
    io.log(`Release prepared: v${result.version} (${result.changedFiles.length} files)`);
    return result;
  }

  throw new Error('Usage: release-transaction.js <prepare|verify>');
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`[release-transaction] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { collectProductionSourceFiles, prepareRelease, runCli, verifyReleaseState };

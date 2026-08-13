import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter(file => file && existsSync(path.join(ROOT, file)));
}

const ROOT_FILES = [
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md',
  'eslint.config.mjs',
  'index.html',
  'package-lock.json',
  'package.json',
  'vite.config.mjs',
  'vitest.config.mjs',
  '啟動桌面版.bat',
  '啟動網頁版.bat',
  '啟動網頁開發版.bat',
].sort();

const TOP_LEVEL_DIRECTORIES = [
  '.claude',
  '.github',
  'docs',
  'electron',
  'font',
  'scripts',
  'shared',
  'src',
  'tests',
].sort();

const RUNTIME_ENTRIES = [
  'src/main.js',
  'electron/main.js',
  'electron/preload.js',
  'electron/compare-preload.js',
  'electron/queue-preload.js',
];

function moduleSpecifiers(source) {
  const specifiers = new Set();
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const pending = [ast];
  const visited = new Set();

  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
      && typeof node.source?.value === 'string') {
      specifiers.add(node.source.value);
    } else if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') {
      specifiers.add(node.source.value);
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier'
      && node.callee.name === 'require' && typeof node.arguments?.[0]?.value === 'string') {
      specifiers.add(node.arguments[0].value);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return [...specifiers];
}

function resolveTrackedPath(fromFile, specifier, trackedSet) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), cleanSpecifier));
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`]
    .find(candidate => trackedSet.has(candidate));
}

function localMarkdownTargets(source) {
  const markdown = [...source.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)].map(match => ({
    raw: match[1].trim(), offset: match.index || 0,
  }));
  const html = [...source.matchAll(/\b(?:href|src)\s*=\s*['"]([^'"]+)['"]/gi)].map(match => ({
    raw: match[1].trim(), offset: match.index || 0,
  }));
  return [...markdown, ...html];
}

describe('repository structure', () => {
  it('Git index 不含沒有 .gitmodules 管理的 gitlink', () => {
    const index = execFileSync('git', ['ls-files', '--stage', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const gitlinks = index.split('\0')
      .filter(entry => entry.startsWith('160000 '))
      .map(entry => entry.slice(entry.indexOf('\t') + 1));

    expect(gitlinks).toEqual([]);
  });

  it('根目錄只追蹤入口、設定、規則與三支啟動器', () => {
    const files = trackedFiles();
    const rootFiles = files.filter(file => !file.includes('/')).sort();
    const directories = [...new Set(
      files.filter(file => file.includes('/')).map(file => file.split('/')[0]),
    )].sort();

    expect(rootFiles).toEqual(ROOT_FILES);
    expect(directories).toEqual(TOP_LEVEL_DIRECTORIES);
  });

  it('程式與工具檔使用 kebab-case，測試檔使用 lowerCamelCase.test.js', () => {
    const files = trackedFiles();
    const implementationFiles = files.filter(file =>
      /^(src|electron|scripts|shared)\/.+\.(js|cjs|mjs|ps1)$/.test(file),
    );
    const testFiles = files.filter(file => /^tests\/[^/]+\.test\.js$/.test(file));

    expect(implementationFiles.filter(file =>
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.(js|cjs|mjs|ps1)$/.test(path.posix.basename(file)),
    )).toEqual([]);
    expect(testFiles.filter(file =>
      !/^[a-z][A-Za-z0-9]*\.test\.js$/.test(path.posix.basename(file)),
    )).toEqual([]);
  });

  it('不追蹤一次性 scratch、patch、backup 或手動測試頁', () => {
    expect(trackedFiles().filter(file =>
      /(^|\/)(scratch|temp|tmp|backup)(\/|$)|(^|\/)scratch[_-]|\.bak$|(^|\/)test[_-].*\.html$/i.test(file),
    )).toEqual([]);
  });

  it('三支啟動器的名稱直接說明桌面版、網頁版與網頁開發版', () => {
    const launchers = trackedFiles().filter(file => !file.includes('/') && file.endsWith('.bat')).sort();

    expect(launchers).toEqual([
      '啟動桌面版.bat',
      '啟動網頁版.bat',
      '啟動網頁開發版.bat',
    ].sort());
  });

  it('scripts 使用的第三方套件都有在 package.json 宣告', () => {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
    ]);
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
    const missing = new Set();

    for (const file of trackedFiles().filter(file => /^scripts\/.+\.(?:js|cjs|mjs)$/.test(file))) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const specifier of moduleSpecifiers(source).filter(value => !value.startsWith('.'))) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!builtins.has(specifier) && !declared.has(packageName)) missing.add(`${file}: ${packageName}`);
      }
    }

    expect([...missing].sort()).toEqual([]);
  });

  it('正式來源模組都能從產品入口抵達，不靠測試單獨餵活', () => {
    const files = trackedFiles();
    const trackedSet = new Set(files);
    const implementationFiles = files.filter(file =>
      /^(src|electron)\/.+\.js$|^shared\/.+\.cjs$/.test(file),
    );
    const implementationSet = new Set(implementationFiles);
    const dependencies = new Map();
    const unresolved = [];

    expect(RUNTIME_ENTRIES.filter(entry => !implementationSet.has(entry))).toEqual([]);

    for (const file of implementationFiles) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      const resolvedDependencies = [];
      for (const specifier of moduleSpecifiers(source).filter(value => value.startsWith('.'))) {
        const resolved = resolveTrackedPath(file, specifier, trackedSet);
        if (!resolved) unresolved.push(`${file}: ${specifier}`);
        else if (implementationSet.has(resolved)) resolvedDependencies.push(resolved);
      }
      dependencies.set(file, resolvedDependencies);
    }
    expect(unresolved.sort()).toEqual([]);

    const reachable = new Set();
    const pending = [...RUNTIME_ENTRIES];
    while (pending.length) {
      const file = pending.pop();
      if (reachable.has(file)) continue;
      reachable.add(file);
      pending.push(...(dependencies.get(file) || []));
    }

    expect(implementationFiles.filter(file => !reachable.has(file)).sort()).toEqual([]);
  });

  it('Markdown 與內嵌 HTML 的本地連結、圖片目標都存在', () => {
    const missing = [];
    const markdownFiles = trackedFiles().filter(file => file.endsWith('.md'));

    for (const file of markdownFiles) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const { raw, offset } of localMarkdownTargets(source)) {
        let target = raw.replace(/^<|>$/g, '');
        if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        target = target.split(/[?#]/, 1)[0];
        if (!target) continue;
        try { target = decodeURIComponent(target); } catch { /* 保留原字串，交由 existsSync 判定 */ }
        const absolute = path.resolve(ROOT, path.dirname(file), target);
        if (!existsSync(absolute)) {
          const line = source.slice(0, offset).split('\n').length;
          missing.push(`${file}:${line} -> ${raw}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('版本變更紀錄保留單一標題、警語與目前版本入口', () => {
    const changelog = readFileSync(path.join(ROOT, 'docs/版本變更紀錄.md'), 'utf8');
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const firstVersion = changelog.match(/^## \[v([^\]]+)\]/m)?.[1];

    expect(changelog.startsWith('# CHANGELOG — SUB Tool\n')).toBe(true);
    expect(changelog.match(/^# CHANGELOG — SUB Tool$/gm)).toHaveLength(1);
    expect(changelog.match(/絕對不要對這個檔案做版號的全域字串取代/g)).toHaveLength(1);
    expect(changelog).not.toContain('\f');
    expect(changelog).not.toMatch(/\\n## \[v/);
    expect(firstVersion).toBe(packageJson.version);
  });
});

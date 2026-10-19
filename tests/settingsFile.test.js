import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createSettingsFile } = require('../electron/settings-file.js');
const { mergeRendererConfig } = require('../electron/ipc-guards.js');
const { createProjectWorkspace } = require('../electron/project-file-authority-engine.js');
const roots = [];

function shortcutHandlers(root, fsModule = fs) {
  const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function getKeysPath()');
  const end = source.indexOf('\nfunction mediaIntakeSession', begin);
  const handlers = new Map();
  vm.runInNewContext(source.slice(begin, end), {
    getConfigDir: () => root,
    path, fs: fsModule,
    createSettingsFile: options => createSettingsFile({ ...options, fsModule }),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    console: { error() {} },
  });
  return { load: () => handlers.get('keys:load')(), save: data => handlers.get('keys:save')({}, data) };
}

function fixture(contents, fsModule = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-settings-file-'));
  roots.push(root);
  const filePath = path.join(root, 'settings.json');
  if (contents != null) fs.writeFileSync(filePath, contents);
  return { root, filePath, settings: createSettingsFile({ filePath: () => filePath, fsModule }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(resolved).startsWith('subtool-settings-file-')).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('settings.json 的同步寫入交易', () => {
  it.each(['partial-write', 'rename'])('快捷鍵 IPC 遇到 %s 失敗保留先前設定並可再次儲存', failure => {
    const { root } = fixture();
    const file = path.join(root, 'key.json');
    const original = JSON.stringify({ playPause: [{ key: ' ' }], undo: [{ key: 'z', ctrl: true }] });
    fs.writeFileSync(file, original);
    let deny = true;
    const injected = { ...fs,
      writeFileSync(target, content, ...args) {
        if (deny && failure === 'partial-write') {
          fs.writeFileSync(target, content.slice(0, 12), ...args);
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(target, content, ...args);
      },
      renameSync(...args) {
        if (deny && failure === 'rename') throw Object.assign(new Error('locked'), { code: 'EPERM' });
        return fs.renameSync(...args);
      },
    };
    const keys = shortcutHandlers(root, injected);
    const next = { playPause: [{ key: 'k' }] };
    expect(keys.save(next)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(keys.load()).toEqual(JSON.parse(original));
    expect(fs.readdirSync(root)).toEqual(['key.json']);
    deny = false;
    expect(keys.save(next)).toBe(true);
    expect(keys.load()).toEqual(next);
  });

  it('快捷鍵 IPC 備份毀損內容失敗時不覆寫，成功後保留原始 bytes', () => {
    const { root } = fixture();
    const file = path.join(root, 'key.json');
    const original = Buffer.from('{recoverable shortcuts');
    fs.writeFileSync(file, original);
    let deny = true;
    const injected = { ...fs, writeFileSync(target, ...args) {
      if (deny && typeof target === 'string' && target.startsWith(file + '.corrupt-')) throw new Error('backup denied');
      return fs.writeFileSync(target, ...args);
    } };
    const keys = shortcutHandlers(root, injected);
    expect(keys.save({ playPause: [{ key: 'k' }] })).toBe(false);
    expect(fs.readFileSync(file)).toEqual(original);
    deny = false;
    expect(keys.save({ playPause: [{ key: 'k' }] })).toBe(true);
    const backups = fs.readdirSync(root).filter(name => name.startsWith('key.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, backups[0]))).toEqual(original);
  });

  it('首次讀取不建立檔案，三種更新保留彼此的資料', () => {
    const { root, settings } = fixture();
    expect(settings.read()).toEqual({});
    expect(fs.readdirSync(root)).toEqual([]);
    settings.update(current => mergeRendererConfig(current, { autoSelect: true, subPresets: [{ name: '中文' }] }));
    settings.update(current => ({ ...current, recentProjects: [{ path: 'C:/film.subtool' }] }));
    settings.update(current => ({ ...current, lastDirs: { media: 'C:/Media' } }));
    settings.update(current => mergeRendererConfig(current, { autoSelect: false }));
    expect(settings.read()).toEqual({ autoSelect: false, subPresets: [{ name: '中文' }],
      recentProjects: [{ path: 'C:/film.subtool' }], lastDirs: { media: 'C:/Media' } });
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });

  it.each(['{"subPresets": [', '[]'])('毀損或錯誤形狀 JSON 在更新前先保留原始位元組（%s）', source => {
    const { root, filePath, settings } = fixture(source);
    expect(() => settings.read()).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(source);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);

    settings.update(current => mergeRendererConfig(current, { safeFrame: true }));

    expect(settings.read()).toEqual({ safeFrame: true });
    const backups = fs.readdirSync(root).filter(name => name.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, backups[0]))).toEqual(Buffer.from(source));
  });

  it('rename 寫入失敗保留原始設定且清除暫存，近期清单操作回傳失敗', () => {
    const denied = { ...fs, renameSync() { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
    const source = JSON.stringify({ recentProjects: [{ path: 'C:/film.subtool' }], safeFrame: true });
    const { root, filePath, settings } = fixture(source, denied);
    const workspace = createProjectWorkspace({
      readRecent: () => settings.read().recentProjects,
      writeRecent: recentProjects => settings.update(current => ({ ...current, recentProjects })),
    });

    expect(workspace.clearRecent()).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(source);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
    expect(() => settings.update(current => mergeRendererConfig(current, { safeFrame: false }))).toThrow('locked');
  });

  it('無法備份毀損原檔時拒絕更新，不能丟掉可恢復的內容', () => {
    const denied = { ...fs, writeFileSync(file, ...args) {
      if (typeof file === 'string' && file.includes('.corrupt-')) throw new Error('backup denied');
      return fs.writeFileSync(file, ...args);
    } };
    const { root, filePath, settings } = fixture('{original', denied);
    expect(() => settings.update(() => ({ safeFrame: true }))).toThrow('backup denied');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{original');
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });

  it('候選資料無法序列化時原檔不變', () => {
    const { filePath, settings } = fixture('{"safeFrame":true}');
    expect(() => settings.update(() => undefined)).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"safeFrame":true}');
  });
});

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

function settingsConsumers(settingsFile, fsModule = fs) {
  const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const directories = source.slice(source.indexOf('let _lastDirs = null;'), source.indexOf("ipcMain.handle('dialog:openMedia'"));
  const recent = source.slice(source.indexOf('function loadRecentProjects()'), source.indexOf("ipcMain.handle('project:recentList'"));
  return vm.runInNewContext(`${directories}\n${recent}\n({ lastDir, rememberDir, loadRecentProjects, saveRecentProjects })`, {
    settingsFile, fs: fsModule, path,
  });
}

function fixture(contents, fsModule = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-settings-file-'));
  roots.push(root);
  const filePath = path.join(root, 'settings.json');
  if (contents != null) fs.writeFileSync(filePath, contents);
  return { root, filePath, settings: createSettingsFile({ filePath: () => filePath, fsModule }) };
}

function fsWithClosedStage(update, overrides = {}) {
  const writers = new Map();
  return { ...fs, ...overrides,
    openSync(file, ...args) {
      const fd = fs.openSync(file, ...args);
      if (args[0] === 'wx') writers.set(fd, file);
      return fd;
    },
    closeSync(fd) {
      const file = writers.get(fd), before = file ? fs.fstatSync(fd, { bigint: true }) : null;
      writers.delete(fd); fs.closeSync(fd);
      if (file) {
        fs.utimesSync(file, before.atime, new Date(Number(before.mtimeMs) + 2000));
        update(file, before);
      }
    },
  };
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
  it('NAS 只在關檔更新時間戳時仍儲存設定，不留下本次完整 tmp', () => {
    let stage, descriptor, beforeClose, afterClose;
    const injected = { ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (args[0] === 'wx') { stage = file; descriptor = fd; }
        return fd;
      },
      closeSync(fd) {
        if (fd !== descriptor) return fs.closeSync(fd);
        beforeClose = fs.fstatSync(fd, { bigint: true });
        fs.closeSync(fd); descriptor = null;
        fs.utimesSync(stage, beforeClose.atime, new Date(Number(beforeClose.mtimeMs) + 2000));
        afterClose = fs.lstatSync(stage, { bigint: true });
      },
    };
    const { filePath, settings } = fixture('{"safeFrame":true}', injected);
    let error;
    try { settings.update(current => ({ ...current, safeFrame: false })); } catch (caught) { error = caught; }
    expect(afterClose.ino).toBe(beforeClose.ino); expect(afterClose.size).toBe(beforeClose.size);
    expect(afterClose.mtimeNs).not.toBe(beforeClose.mtimeNs);
    expect.soft(error).toBeUndefined();
    expect.soft(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ safeFrame: false });
    expect(fs.existsSync(stage)).toBe(false);
  });

  it.each(['partial-write', 'rename'])('NAS %s 失敗關檔更新時間戳，只清理本次設定 tmp', failure => {
    let stage;
    const fault = Object.assign(new Error(failure + ' failed'), { code: 'EIO' });
    const injected = fsWithClosedStage(file => { stage = file; }, {
      writeFileSync(target, content, ...args) {
        if (failure === 'partial-write') { fs.writeFileSync(target, Buffer.from(content).subarray(0, 8)); throw fault; }
        return fs.writeFileSync(target, content, ...args);
      },
      renameSync(...args) { if (failure === 'rename') throw fault; return fs.renameSync(...args); },
    });
    const { root, filePath, settings } = fixture('{"safeFrame":true}', injected);
    expect(() => settings.update(() => ({ safeFrame: false }))).toThrow(fault);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"safeFrame":true}');
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });

  it.each(['normal', 'failed-write'].flatMap(phase => ['replacement', 'append', 'same-size'].map(change => [phase, change])))
  ('NAS %s 關檔時間更新並遇到 %s 外部變動，拒絕發布且保留外部 tmp', (phase, change) => {
    let stage, external;
    const fault = new Error('partial write failed');
    const injected = fsWithClosedStage((file, before) => {
      stage = file;
      const intended = fs.readFileSync(file);
      if (change === 'replacement') {
        fs.renameSync(file, file + '.original'); external = intended; fs.writeFileSync(file, external);
        expect(fs.lstatSync(file, { bigint: true }).ino).not.toBe(before.ino);
      } else {
        external = change === 'append' ? Buffer.concat([intended, Buffer.from('external')]) : Buffer.alloc(intended.length, 0x58);
        fs.writeFileSync(file, external);
        expect(fs.lstatSync(file, { bigint: true }).ino).toBe(before.ino);
      }
    }, {
      writeFileSync(target, content, ...args) {
        if (phase === 'failed-write') { fs.writeFileSync(target, Buffer.from(content).subarray(0, 8)); throw fault; }
        return fs.writeFileSync(target, content, ...args);
      },
    });
    const { filePath, settings } = fixture('{"safeFrame":true}', injected);
    expect(() => settings.update(() => ({ safeFrame: false }))).toThrow(phase === 'failed-write' ? fault : /設定檔/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"safeFrame":true}');
    expect(fs.readFileSync(stage)).toEqual(external);
  });

  it('設定暫存檔被替換時不發布替代內容，也不刪除替代檔', () => {
    let stage, descriptor, swapped=false;
    const injected = { ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (typeof file === 'string' && file.endsWith('.tmp')) { stage=file; descriptor=fd; }
        return fd;
      },
      closeSync(fd) {
        fs.closeSync(fd);
        if (fd === descriptor && !swapped) {
          swapped=true; fs.renameSync(stage, stage+'.original'); fs.writeFileSync(stage, '外部資料');
        }
      },
    };
    const { filePath, settings } = fixture('{"safeFrame":true}', injected);
    expect(() => settings.update(current => ({...current,safeFrame:false}))).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"safeFrame":true}');
    expect(fs.readFileSync(stage, 'utf8')).toBe('外部資料');
  });

  it('設定發布後同名暫存路徑被他人建立，不可在收尾時刪除', () => {
    let stage;
    const injected = { ...fs, renameSync(from, to) {
      fs.renameSync(from, to); stage=from; fs.writeFileSync(from, '另一項工作');
    } };
    const { filePath, settings } = fixture('{"safeFrame":true}', injected);
    expect(settings.update(current => ({...current,safeFrame:false}))).toEqual({safeFrame:false});
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({safeFrame:false});
    expect(fs.readFileSync(stage, 'utf8')).toBe('另一項工作');
  });

  it('設定交易期間目的檔被修改，保留較新的內容並回報衝突', () => {
    let changed=false, settingsPath;
    const injected = { ...fs, writeFileSync(target, content, ...args) {
      const result=fs.writeFileSync(target, content, ...args);
      if (typeof target === 'number' && !changed) {
        changed=true; fs.writeFileSync(settingsPath, '{"newer":true}');
      }
      return result;
    } };
    const { filePath, settings } = fixture('{"safeFrame":true}', injected); settingsPath=filePath;
    expect(() => settings.update(current => ({...current,safeFrame:false}))).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"newer":true}');
  });

  it.each(['stage','destination'])('即使 %s 的檔案資訊看起來相同，也要核對實際內容', kind => {
    let stage, descriptor, changed=false, filePath, frozen;
    const injected = { ...fs,
      openSync(file, ...args) {
        const fd=fs.openSync(file, ...args);
        if (typeof file === 'string' && file.endsWith('.tmp')) { stage=file; descriptor=fd; }
        return fd;
      },
      closeSync(fd) {
        if (fd === descriptor && !changed) {
          const target=kind === 'stage' ? stage : filePath;
          frozen=fs.lstatSync(target, {bigint:true});
          const bytes=fs.readFileSync(target);
          fs.writeFileSync(target, Buffer.alloc(bytes.length, 0x58));
          changed=true;
        }
        return fs.closeSync(fd);
      },
      lstatSync(file, ...args) {
        if (changed && file === (kind === 'stage' ? stage : filePath)) return frozen;
        return fs.lstatSync(file, ...args);
      },
    };
    const fixtureResult=fixture('{"safeFrame":true}', injected); filePath=fixtureResult.filePath;
    expect(() => fixtureResult.settings.update(current=>({...current,safeFrame:false}))).toThrow();
    const target=kind === 'stage' ? stage : filePath;
    expect(fs.readFileSync(target)).toEqual(Buffer.alloc(Number(frozen.size), 0x58));
  });

  it('最近專案暫時讀取失敗不能當空清單覆寫，之後開啟可重新加入', async () => {
    const previous = [{ path: path.resolve('previous.subtool'), name: 'previous', at: 1 }];
    let reads = 0, faults = 0;
    const injected = { ...fs, readFileSync(...args) {
      if (reads++ === 0) {
        faults++;
        throw Object.assign(new Error('settings temporarily locked'), { code: 'EACCES' });
      }
      return fs.readFileSync(...args);
    } };
    const { root, settings } = fixture(JSON.stringify({ recentProjects: previous, safeFrame: true }), injected);
    const helpers = settingsConsumers(settings);
    const file = path.join(root, 'fresh.subtool');
    fs.writeFileSync(file, JSON.stringify({ cues: [] }));
    const workspace = createProjectWorkspace({
      readFile: value => fs.promises.readFile(value),
      readRecent: helpers.loadRecentProjects,
      writeRecent: helpers.saveRecentProjects,
    });
    await expect(workspace.open(file)).resolves.toMatchObject({ path: file });
    expect(faults).toBe(1);
    expect(settings.read()).toEqual({ recentProjects: previous, safeFrame: true });
    await workspace.open(file);
    expect(settings.read().recentProjects.map(entry => entry.path)).toEqual([file, previous[0].path]);
  });

  it('對話框目錄讀取失敗不快取空值，下一次開窗會重讀', () => {
    let reads = 0, faults = 0;
    const injected = { ...fs, readFileSync(...args) {
      if (reads++ === 0) {
        faults++;
        throw Object.assign(new Error('settings temporarily locked'), { code: 'EACCES' });
      }
      return fs.readFileSync(...args);
    } };
    const { root, filePath, settings } = fixture(null, injected);
    fs.writeFileSync(filePath, JSON.stringify({ lastDirs: { media: root } }));
    const helpers = settingsConsumers(settings);
    expect(helpers.lastDir('media')).toBeUndefined();
    expect(faults).toBe(1);
    expect(helpers.lastDir('media')).toBe(root);
  });

  it('開啟缺檔的最近專案及讀取設定失敗都不改寫原清單', async () => {
    let reads=0, faults=0, writes=0, armed=false;
    const injected={...fs,readFileSync(...args) {
      if (armed && ++reads === 1) {
        faults++;
        throw Object.assign(new Error('settings temporarily locked'),{code:'EACCES'});
      }
      return fs.readFileSync(...args);
    }};
    const {root,filePath,settings}=fixture(null,injected);
    const previous=['missing','kept'].map(name=>({path:path.join(root,`${name}.subtool`),name,at:1}));
    fs.writeFileSync(filePath,JSON.stringify({recentProjects:previous}));
    fs.writeFileSync(previous[1].path,JSON.stringify({cues:[]}));
    const helpers=settingsConsumers(settings);
    const workspace=createProjectWorkspace({
      readFile:value=>fs.promises.readFile(value), stat:value=>fs.promises.stat(value),
      readRecent:helpers.loadRecentProjects,
      writeRecent:next=>{writes++;return helpers.saveRecentProjects(next);},
    });
    const [missing]=await workspace.listRecent();
    armed=true;
    await expect(workspace.openRecent(missing.token)).resolves.toBeNull();
    expect(faults).toBe(1);
    expect(writes).toBe(0);
    expect(JSON.parse(fs.readFileSync(filePath,'utf8')).recentProjects).toEqual(previous);
    armed=false;
    await expect(workspace.openRecent(missing.token)).resolves.toBeNull();
    expect(writes).toBe(0);
    expect(settings.read().recentProjects).toEqual(previous);
  });

  it('記住新對話框目錄時從實際設定合併，保留暫時讀不到的其他種類', () => {
    let reads = 0, faults = 0;
    const injected = { ...fs, readFileSync(...args) {
      if (reads++ === 0) {
        faults++;
        throw Object.assign(new Error('settings temporarily locked'), { code: 'EACCES' });
      }
      return fs.readFileSync(...args);
    } };
    const { root, filePath, settings } = fixture(null, injected);
    const previous = { project: root, media: path.join(root, 'previous') };
    fs.writeFileSync(filePath, JSON.stringify({ lastDirs: previous, safeFrame: true }));
    const helpers = settingsConsumers(settings);
    helpers.rememberDir('media', path.join(root, 'fresh.mp4'));
    expect(faults).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect(settings.read()).toEqual({ lastDirs: { ...previous, media: root }, safeFrame: true });
    expect(helpers.lastDir('project')).toBe(root);
  });

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

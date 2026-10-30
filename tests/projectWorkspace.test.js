// @subtool-ci windows
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createProjectWorkspace, createAtomicProjectWriter } = require('../electron/project-file-authority-engine.js');
const tempRoots = [];
const realpath = fs.realpathSync.native;

function createTempRoot(kind = 'save') {
  // Windows CI 的 TEMP 可含 RUNNER~1；fault injection 必須比對與 writer 相同的實體路徑。
  const root = realpath(fs.mkdtempSync(path.join(os.tmpdir(), `subtool-project-${kind}-`)));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  const parent = realpath(os.tmpdir());
  for (const root of tempRoots.splice(0)) {
    const actual = realpath(root);
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith('subtool-project-')) {
      throw new Error('拒絕清除未驗證的專案測試目錄');
    }
    fs.rmSync(actual, { recursive: true, force: true });
  }
});

const bytes = project => Buffer.from(JSON.stringify(project));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ files = {}, recent = [], writeFile, saveMetadata } = {}) {
  let storedRecent = recent.slice();
  const grants = [];
  const writes = [];
  const workspace = createProjectWorkspace({
    saveMetadata,
    readFile: vi.fn(async file => {
      const value = files[file];
      if (value instanceof Error) throw value;
      if (value?.then) return value;
      if (!Buffer.isBuffer(value)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    }),
    writeFile: writeFile || vi.fn(async (file, contents, options) => { writes.push(['write', file, contents, options]); }),
    grantProjectFile: file => grants.push(['project', file]),
    grantMediaFile: file => grants.push(['media', file]),
    canReadMedia: () => true,
    readRecent: () => storedRecent,
    writeRecent: next => { storedRecent = next; },
    stat: async file => {
      if (files[file] instanceof Error || !files[file]) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => true };
    },
    now: () => 123,
  });
  return { workspace, grants, writes, recent: () => storedRecent };
}

describe('project workspace', () => {
  it.each([{remember:true},{ensureParent:true}])('儲存與備份都以目前版本及電腦名稱作為 JSON 最前兩欄（%j）', async options => {
    const project = { playhead: 12.145, cues: [{text:'字幕'}], media: {}, version: 3,
      'SUB Tool':'舊版本', 'User Name':'另一台電腦' };
    const fx = fixture({saveMetadata:()=>({appVersion:'8.6.7',computerName:'Evan-PC'})});
    const file=path.resolve('metadata.subtool');
    await expect(fx.workspace.writeRendererProject(file, bytes(project).toString('base64'), options)).resolves.toBe(file);
    const written=fx.writes.find(([kind])=>kind==='write')[2];
    expect([...written.subarray(0,2)]).toEqual([0xff,0xfe]);
    const text=written.subarray(2).toString('utf16le');
    expect(text).toMatch(/^\{\n "SUB Tool": "8\.6\.7",\n "User Name": "Evan-PC",/);
    expect(JSON.parse(text)).toEqual({...project,'SUB Tool':'8.6.7','User Name':'Evan-PC'});
  });

  it('實際寫出的 UTF-16 專案仍可原樣開啟，中文電腦名稱與 JSON 字元不損毀', async () => {
    const root=createTempRoot('metadata');
    const file=path.join(root,'專案.subtool');
    const document={cues:[{text:'原字幕'}],version:3};
    const computerName='剪輯室-電腦 "A"';
    const workspace=createProjectWorkspace({readFile:fsp.readFile,writeFile:createAtomicProjectWriter(),
      saveMetadata:()=>({appVersion:'8.6.7',computerName}),canReadMedia:()=>true});
    await workspace.writeRendererProject(file,bytes(document).toString('base64'));
    const opened=await workspace.open(file);
    const buffer=Buffer.from(opened.b64,'base64');
    expect(JSON.parse(buffer.subarray(2).toString('utf16le'))).toEqual({
      'SUB Tool':'8.6.7','User Name':computerName,...document,
    });
    expect(fs.readFileSync(file)).toEqual(buffer);
  });

  it.runIf(process.platform === 'win32').each([false, true])('實際 Windows 8.3 短名可保存完整專案，備份=%s', async (backup, context) => {
    const root = createTempRoot('short-name');
    const shortRoot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
      + '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SUBTOOL_PROJECT_TEST_ROOT).ShortPath'], {
      env: { ...process.env, SUBTOOL_PROJECT_TEST_ROOT: root },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    }).trim();
    if (shortRoot.toLowerCase() === root.toLowerCase()) context.skip('此磁碟沒有提供 8.3 短檔名');
    expect(realpath(shortRoot)).toBe(root);
    expect(await fsp.realpath(shortRoot)).toBe(root);
    const relative = backup ? path.join('.subtool_AutoSave', '備份.subtool') : '專案.subtool';
    const selected = path.join(shortRoot, relative);
    const document = { version: 3, cues: [{ text: '短名路徑的字幕𠮷😀' }] };
    const workspace = createProjectWorkspace({ readFile: fsp.readFile,
      writeFile: createAtomicProjectWriter(), canReadMedia: () => true });
    await expect(workspace.writeRendererProject(selected, bytes(document).toString('base64'), { ensureParent: backup }))
      .resolves.toBe(selected);
    const saved = fs.readFileSync(path.join(root, relative));
    expect([...saved.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(JSON.parse(saved.subarray(2).toString('utf16le'))).toEqual(document);
    expect(Buffer.from((await workspace.open(selected)).b64, 'base64')).toEqual(saved);
    expect(fs.readdirSync(root)).toEqual([backup ? '.subtool_AutoSave' : '專案.subtool']);
  });

  it.each(['utf8', 'utf16le', 'utf16be'])('舊 %s 專案儲存與備份一律寫 UTF-16LE BOM，沒有識別資訊 adapter 也保留內容', async encoding => {
    const root = createTempRoot('encoding');
    const document = { app: 'SUB Tool', version: 3, tracks: [{ name: '字幕𠮷😀' }],
      cues: [{ text: '繁體中文\n罕字𠮷及 emoji 😀', start: 1, end: 2 }],
      media: { path: 'C:/素材/𠮷😀.mov' } };
    const text = JSON.stringify(document);
    const original = Buffer.from(encoding === 'utf8' ? text : '\uFEFF' + text,
      encoding === 'utf8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') original.swap16();
    const workspace = createProjectWorkspace({ readFile: fsp.readFile, writeFile: createAtomicProjectWriter(),
      canReadMedia: () => true });
    for (const options of [{}, { ensureParent: true }]) {
      const file = path.join(root, options.ensureParent ? 'backup.subtool' : '專案.subtool');
      fs.writeFileSync(file, original);
      const old = await workspace.open(file);
      expect(Buffer.from(old.b64, 'base64')).toEqual(original);
      await expect(workspace.writeRendererProject(file, old.b64, options)).resolves.toBe(file);
      const written = fs.readFileSync(file);
      expect([...written.subarray(0, 2)]).toEqual([0xFF, 0xFE]);
      expect(JSON.parse(written.subarray(2).toString('utf16le'))).toEqual(document);
      const reopened = await workspace.open(file);
      expect(Buffer.from(reopened.b64, 'base64')).toEqual(written);
    }
  });

  it('最近專案選取在存檔重新排序後仍開啟原目標', async () => {
    const a = path.resolve('recent-a.subtool'), b = path.resolve('recent-b.subtool'), c = path.resolve('current-c.subtool');
    const contents = bytes({ cues: [] });
    const fx = fixture({ files: { [a]: contents, [b]: contents }, recent: [{ path: a }, { path: b }] });
    const chosen = (await fx.workspace.listRecent())[1];
    await fx.workspace.writeRendererProject(c, contents.toString('base64'), { remember: true });
    await expect(fx.workspace.openRecent(chosen.token)).resolves.toMatchObject({ path: b });
    expect(fx.grants.filter(([kind]) => kind === 'project').map(([, file]) => file)).toEqual([c, b]);
  });

  it('移除的最近項目與任意路徑都不能取得開檔授權', async () => {
    const file = path.resolve('removed.subtool');
    const fx = fixture({ files: { [file]: bytes({ cues: [] }) }, recent: [{ path: file }] });
    const chosen = (await fx.workspace.listRecent())[0];
    fx.workspace.clearRecent();
    await expect(fx.workspace.openRecent(chosen.token)).resolves.toBeNull();
    await expect(fx.workspace.openRecent(file)).resolves.toBeNull();
    expect(fx.grants).toEqual([]);
  });

  it('temp 名稱已存在時不能刪掉其他工作擁有的檔案', async () => {
    const root = createTempRoot();
    const file = path.join(root, 'edit.subtool');
    const temporary = file + '.collision.tmp';
    fs.writeFileSync(file, '原專案');
    fs.writeFileSync(temporary, '另一個工作的資料');
    const writer = createAtomicProjectWriter({ createToken: () => 'collision' });
    await expect(writer(file, Buffer.from('新專案'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(file, 'utf8')).toBe('原專案');
    expect(fs.readFileSync(temporary, 'utf8')).toBe('另一個工作的資料');
  });

  it('備份目錄含連結時拒絕寫入，保留連結另一端的既有資料', async () => {
    const root = createTempRoot();
    const selected = path.join(root, 'selected');
    const other = path.join(root, 'other');
    fs.mkdirSync(selected); fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(selected, '.subtool_AutoSave'), process.platform === 'win32' ? 'junction' : 'dir');
    const original = Buffer.from('另一個目錄的資料，不屬於備份');
    fs.writeFileSync(path.join(other, 'backup.subtool'), original);
    const workspace = createProjectWorkspace({ readFile: fsp.readFile,
      writeFile: createAtomicProjectWriter(), canReadMedia: () => true });
    await expect(workspace.writeRendererProject(path.join(selected, '.subtool_AutoSave', 'backup.subtool'),
      bytes({ cues: [{ text: '新備份' }] }).toString('base64'), { ensureParent: true }))
      .rejects.toMatchObject({ code: 'UNSAFE_PROJECT_OUTPUT' });
    expect(fs.readFileSync(path.join(other, 'backup.subtool'))).toEqual(original);
    expect(fs.readdirSync(other)).toEqual(['backup.subtool']);
  });

  it('寫入模組完整準備正常備份目錄，再以 UTF-16LE 原子發布專案', async () => {
    const root = createTempRoot();
    const file = path.join(root, '.subtool_AutoSave', 'nested', '備份.subtool');
    const document = { cues: [{ text: '中文𠮷😀' }] };
    const workspace = createProjectWorkspace({ readFile: fsp.readFile,
      writeFile: createAtomicProjectWriter(), canReadMedia: () => true });
    await expect(workspace.writeRendererProject(file, bytes(document).toString('base64'), { ensureParent: true }))
      .resolves.toBe(file);
    const saved = fs.readFileSync(file);
    expect([...saved.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(JSON.parse(saved.subarray(2).toString('utf16le'))).toEqual(document);
    expect(fs.readdirSync(root)).toEqual(['.subtool_AutoSave']);
  });

  it.each(['open', 'sync', 'close'])('備份父目錄在 %s 等待期間換成其他實體時拒絕發布，只回收自己的暫存', async stage => {
    const root = createTempRoot();
    const backup = path.join(root, '.subtool_AutoSave');
    const retained = path.join(root, 'retained-backup');
    fs.mkdirSync(backup);
    const file = path.join(backup, 'backup.subtool');
    const old = Buffer.from('原本的備份');
    const other = Buffer.from('新的目錄內容，必須保留');
    fs.writeFileSync(file, old);
    let replaced = false;
    const replace = () => {
      if (replaced) return;
      replaced = true;
      // Both move targets are fixed children of this owned sandbox.
      expect(path.dirname(backup)).toBe(root);
      expect(path.dirname(retained)).toBe(root);
      fs.renameSync(backup, retained);
      fs.mkdirSync(backup);
      fs.writeFileSync(file, other);
    };
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fs, ...fsp,
      async open(...args) {
        if (stage === 'open') replace();
        const handle = await fsp.open(...args);
        return {
          stat: options => handle.stat(options), writeFile: data => handle.writeFile(data),
          async sync() { await handle.sync(); if (stage === 'sync') replace(); },
          async close() { await handle.close(); if (stage === 'close') replace(); },
        };
      },
    } });
    await expect(writer(file, Buffer.from('本次新備份'), { ensureParent: true }))
      .rejects.toMatchObject({ code: 'UNSAFE_PROJECT_OUTPUT' });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(file)).toEqual(other);
    expect(fs.readFileSync(path.join(retained, 'backup.subtool'))).toEqual(old);
    expect(fs.readdirSync(root).sort()).toEqual(['.subtool_AutoSave', 'retained-backup']);
  });

  it('私有暫存同名路徑被替換後，不發布也不清除其他檔案', async () => {
    const root = createTempRoot();
    const file = path.join(root, 'edit.subtool');
    fs.writeFileSync(file, '原專案');
    const writer = createAtomicProjectWriter({ createToken: () => 'owned', fsModule: {
      ...fs, ...fsp,
      async open(temporary, ...args) {
        const handle = await fsp.open(temporary, ...args);
        let closed = false;
        return {
          stat: options => handle.stat(options), writeFile: data => handle.writeFile(data), sync: () => handle.sync(),
          async close() {
            if (closed) return;
            closed = true;
            await handle.close();
            expect(path.dirname(temporary)).toBe(root);
            const retained = path.join(root, 'retained-stage');
            expect(path.dirname(retained)).toBe(root);
            fs.renameSync(temporary, retained);
            fs.writeFileSync(temporary, '其他工作的檔案');
          },
        };
      },
    } });
    await expect(writer(file, Buffer.from('新專案'))).rejects.toMatchObject({ code: 'UNSAFE_PROJECT_OUTPUT' });
    expect(fs.readFileSync(file, 'utf8')).toBe('原專案');
    expect(fs.readFileSync(file + '.owned.tmp', 'utf8')).toBe('其他工作的檔案');
    expect(fs.readFileSync(path.join(root, 'retained-stage'), 'utf8')).toBe('新專案');
  });

  it('既有專案共用 hardlink 時只替換所選名稱，不改其他檔案內容', async () => {
    const root = createTempRoot();
    const selected = path.join(root, 'selected.subtool');
    const other = path.join(root, 'other.subtool');
    fs.writeFileSync(other, '其他檔案的原始內容');
    fs.linkSync(other, selected);
    await createAtomicProjectWriter()(selected, Buffer.from('本次專案'));
    expect(fs.readFileSync(selected, 'utf8')).toBe('本次專案');
    expect(fs.readFileSync(other, 'utf8')).toBe('其他檔案的原始內容');
  });

  it.each(['write', 'rename'])('原子保存 %s 失敗保留原專案，不提交授權或最近記錄', async stage => {
    const root = createTempRoot();
    const file = path.join(root, 'edit.subtool');
    const original = bytes({ cues: [{ text: '原專案' }] });
    fs.writeFileSync(file, original);
    const failure = new Error('disk/SMB write failed');
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fs, ...fsp,
      async open(...args) {
        const handle = await fsp.open(...args);
        return {
          async writeFile(contents) {
            if (stage === 'write') { await handle.writeFile(contents.subarray(0, 3)); throw failure; }
            await handle.writeFile(contents);
          },
          stat: options => handle.stat(options), sync: () => handle.sync(), close: () => handle.close(),
        };
      },
      renameSync(...args) { if (stage === 'rename') throw failure; return fs.renameSync(...args); },
    } });
    const fx = fixture({ writeFile: writer });
    await expect(fx.workspace.writeRendererProject(file, bytes({ cues: [] }).toString('base64'), { remember: true }))
      .rejects.toBe(failure);
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readdirSync(root)).toEqual(['edit.subtool']);
    expect(fx.grants).toEqual([]);
    expect(fx.recent()).toEqual([]);
  });

  it('同目標並行保存依提交順序發佈完整 bytes', async () => {
    const root = createTempRoot();
    const file = path.join(root, 'edit.subtool');
    const first = deferred();
    const started = deferred();
    let count = 0;
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fs, ...fsp,
      async open(...args) {
        if (++count === 1) { started.resolve(); await first.promise; }
        return fsp.open(...args);
      },
    } });
    const old = writer(file, Buffer.from('完整第一份'));
    await started.promise;
    const latest = writer(file, Buffer.from('完整第二份'));
    expect(count).toBe(1);
    first.resolve();
    await Promise.all([old, latest]);
    expect(fs.readFileSync(file, 'utf8')).toBe('完整第二份');
    expect(fs.readdirSync(root)).toEqual(['edit.subtool']);
  });

  it('實體目標與所選目錄別名指向同一檔案時，也依呼叫順序發布', async () => {
    const root = createTempRoot();
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const gate = deferred(), started = deferred();
    let opens = 0;
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fs, ...fsp,
      async open(...args) {
        if (++opens === 1) { started.resolve(); await gate.promise; }
        return fsp.open(...args);
      },
    } });
    const earlier = writer(path.join(alias, 'edit.subtool'), Buffer.from('較舊專案'));
    await started.promise;
    const latest = writer(path.join(real, 'edit.subtool'), Buffer.from('較新專案'));
    let timer;
    try {
      // The old writer lets the later alias finish while the first is held.
      // A correct writer keeps it queued; the deadline only releases the test gate.
      await Promise.race([latest, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
    } finally { clearTimeout(timer); gate.resolve(); }
    await Promise.all([earlier, latest]);
    expect(fs.readFileSync(path.join(real, 'edit.subtool'), 'utf8')).toBe('較新專案');
  });

  it('最後非同步目錄查驗回覆後有變更時，不把備份發布到替換的資料夾', async () => {
    const root = createTempRoot();
    const backup = path.join(root, '.subtool_AutoSave');
    const retained = path.join(root, 'retained-backup');
    fs.mkdirSync(backup);
    const file = path.join(backup, 'backup.subtool');
    fs.writeFileSync(file, '原備份');
    let closed = false, replaced = false;
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fs, ...fsp,
      async lstat(current, ...args) {
        const result = await fsp.lstat(current, ...args);
        if (closed && current === backup && !replaced) {
          replaced = true;
          expect(path.dirname(backup)).toBe(root);
          expect(path.dirname(retained)).toBe(root);
          fs.renameSync(backup, retained);
          fs.mkdirSync(backup);
          fs.writeFileSync(file, '替換目錄的既有資料');
        }
        return result;
      },
      async open(...args) {
        const handle = await fsp.open(...args);
        return {
          stat: options => handle.stat(options), writeFile: data => handle.writeFile(data), sync: () => handle.sync(),
          async close() { await handle.close(); closed = true; },
        };
      },
    } });
    await expect(writer(file, Buffer.from('本次新備份'), { ensureParent: true }))
      .rejects.toMatchObject({ code: 'UNSAFE_PROJECT_OUTPUT' });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('替換目錄的既有資料');
    expect(fs.readFileSync(path.join(retained, 'backup.subtool'), 'utf8')).toBe('原備份');
    expect(fs.readdirSync(root).sort()).toEqual(['.subtool_AutoSave', 'retained-backup']);
  });

  it('dialog/drop、recent、OS live 與 startup 共用相同 parse-before-grant outcome', async () => {
    const valid = 'C:\\Projects\\valid.subtool';
    const broken = 'C:\\Projects\\broken.subtool';
    const project = bytes({ media: { path: 'D:\\Media\\program.mov' } });
    const fx = fixture({
      files: { [valid]: project, [broken]: Buffer.from('{broken') },
      recent: [{ path: broken, name: 'broken.subtool', at: 1 }],
    });

    await expect(fx.workspace.open(broken)).resolves.toBeNull();
    await expect(fx.workspace.openRecent((await fx.workspace.listRecent())[0].token)).resolves.toBeNull();
    expect(fx.workspace.stageStartup(broken)).toBe(true);
    await expect(fx.workspace.openStartup([])).resolves.toBeNull();
    await expect(fx.workspace.open(broken)).resolves.toBeNull();
    expect(fx.grants).toEqual([]);

    await expect(fx.workspace.open(valid)).resolves.toEqual({
      path: valid,
      b64: project.toString('base64'),
    });
    expect(fx.grants).toEqual([
      ['project', valid],
      ['media', 'D:\\Media\\program.mov'],
    ]);
  });

  it('OS open 是 latest-wins，較慢的舊讀取不會 grant、remember 或覆蓋新結果', async () => {
    const slow = deferred();
    const oldPath = 'C:\\Projects\\old.subtool';
    const newPath = 'C:\\Projects\\new.subtool';
    const fx = fixture({
      files: {
        [oldPath]: slow.promise,
        [newPath]: bytes({ media: { path: 'D:\\Media\\new.mov' } }),
      },
    });

    const oldOpen = fx.workspace.open(oldPath);
    const newOpen = fx.workspace.open(newPath);
    await expect(newOpen).resolves.toMatchObject({ path: newPath });
    slow.resolve(bytes({ media: { path: 'D:\\Media\\old.mov' } }));
    await expect(oldOpen).resolves.toBeNull();
    expect(fx.grants).toEqual([
      ['project', newPath],
      ['media', 'D:\\Media\\new.mov'],
    ]);
    expect(fx.recent().map(item => item.path)).toEqual([newPath]);
  });

  it('最近專案與原生對話框的慢讀取也不能蓋過較新的開檔意圖', async () => {
    const slowRecent = deferred();
    const slowDialog = deferred();
    const recentPath = 'C:\\Projects\\recent.subtool';
    const dialogPath = 'C:\\Projects\\dialog.subtool';
    const latestPath = 'C:\\Projects\\latest.subtool';
    const fx = fixture({ files: {
      [recentPath]: slowRecent.promise,
      [dialogPath]: slowDialog.promise,
      [latestPath]: bytes({ media: { path: 'D:\\Media\\latest.mov' } }),
    }, recent: [{ path: recentPath, name: 'recent.subtool', at: 1 }] });

    const recent = fx.workspace.openRecent((await fx.workspace.listRecent())[0].token);
    const dialog = fx.workspace.open(dialogPath);
    const latest = await fx.workspace.open(latestPath);
    expect(latest?.path).toBe(latestPath);
    slowRecent.resolve(bytes({ media: { path: 'D:\\Media\\recent.mov' } }));
    slowDialog.resolve(bytes({ media: { path: 'D:\\Media\\dialog.mov' } }));
    await expect(recent).resolves.toBeNull();
    await expect(dialog).resolves.toBeNull();
    expect(fx.grants).toEqual([
      ['project', latestPath], ['media', 'D:\\Media\\latest.mov'],
    ]);
    expect(fx.recent().map(item => item.path)).toEqual([latestPath, recentPath]);
  });

  it('startup 只消耗 staged/argv 一次，renderer reload 不會無提示重開原專案', async () => {
    const startupPath = 'C:\\Projects\\startup.subtool';
    const fx = fixture({ files: { [startupPath]: bytes({ cues: [] }) } });

    await expect(fx.workspace.openStartup([startupPath])).resolves.toMatchObject({ path: startupPath });
    await expect(fx.workspace.openStartup([startupPath])).resolves.toBeNull();
  });

  it('save 與 autosave 都在 workspace 內 admission，成功後才清 declaration/remember', async () => {
    const projectPath = 'C:\\Projects\\edit.subtool';
    const fx = fixture();
    const payload = bytes({ media: { path: 'D:\\Media\\program.mov' } }).toString('base64');

    await expect(fx.workspace.writeRendererProject(projectPath, payload, {
      ensureParent: true,
      remember: true,
    })).resolves.toBe(projectPath);
    expect(fx.writes.map(call => call.slice(0, 2))).toEqual([
      ['write', projectPath],
    ]);
    expect(fx.writes[0][3]).toEqual({ ensureParent: true });
    expect(fx.recent().map(item => item.path)).toEqual([projectPath]);
  });

  it('recent list/open/clear policy is hidden behind the workspace interface', async () => {
    const present = 'C:\\Projects\\present.subtool';
    const missing = 'C:\\Projects\\missing.subtool';
    const fx = fixture({
      files: { [present]: bytes({ cues: [] }) },
      recent: [
        { path: present, name: 'present.subtool', at: 2 },
        { path: missing, name: 'missing.subtool', at: 1 },
      ],
    });

    const entries = await fx.workspace.listRecent();
    expect(entries).toEqual([
      { index: 0, token: expect.any(String), path: present, name: 'present.subtool', at: 2, missing: false },
      { index: 1, token: expect.any(String), path: missing, name: 'missing.subtool', at: 1, missing: true },
    ]);
    expect(entries[0].token).not.toBe(entries[1].token);
    await expect(fx.workspace.openRecent(entries[1].token)).resolves.toBeNull();
    expect(fx.recent().map(item => item.path)).toEqual([present]);
    expect(fx.workspace.clearRecent()).toBe(true);
    expect(fx.recent()).toEqual([]);
  });
});

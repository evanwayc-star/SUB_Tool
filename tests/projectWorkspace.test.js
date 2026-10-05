// @subtool-ci windows
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProjectWorkspace, createAtomicProjectWriter } = require('../electron/project-file-authority-engine.js');
const tempRoots = [];
afterEach(() => { for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const bytes = project => Buffer.from(JSON.stringify(project));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ files = {}, recent = [], writeFile } = {}) {
  let storedRecent = recent.slice();
  const grants = [];
  const writes = [];
  const workspace = createProjectWorkspace({
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
    writeFile: writeFile || vi.fn(async (file, contents) => { writes.push(['write', file, contents]); }),
    ensureDirectory: vi.fn(async file => { writes.push(['mkdir', file]); }),
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-project-save-'));
    tempRoots.push(root);
    const file = path.join(root, 'edit.subtool');
    const temporary = file + '.collision.tmp';
    fs.writeFileSync(file, '原專案');
    fs.writeFileSync(temporary, '另一個工作的資料');
    const writer = createAtomicProjectWriter({ createToken: () => 'collision' });
    await expect(writer(file, Buffer.from('新專案'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(file, 'utf8')).toBe('原專案');
    expect(fs.readFileSync(temporary, 'utf8')).toBe('另一個工作的資料');
  });

  it.each(['write', 'rename'])('原子保存 %s 失敗保留原專案，不提交授權或最近記錄', async stage => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-project-save-'));
    tempRoots.push(root);
    const file = path.join(root, 'edit.subtool');
    const original = bytes({ cues: [{ text: '原專案' }] });
    fs.writeFileSync(file, original);
    const failure = new Error('disk/SMB write failed');
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fsp,
      async open(...args) {
        const handle = await fsp.open(...args);
        return {
          async writeFile(contents) {
            if (stage === 'write') { await handle.writeFile(contents.subarray(0, 3)); throw failure; }
            await handle.writeFile(contents);
          },
          sync: () => handle.sync(), close: () => handle.close(),
        };
      },
      async rename(...args) { if (stage === 'rename') throw failure; return fsp.rename(...args); },
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-project-save-'));
    tempRoots.push(root);
    const file = path.join(root, 'edit.subtool');
    const first = deferred();
    const started = deferred();
    let count = 0;
    const writer = createAtomicProjectWriter({ fsModule: {
      ...fsp,
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
      ['mkdir', projectPath],
      ['write', projectPath],
    ]);
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

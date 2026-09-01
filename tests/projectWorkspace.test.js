// @subtool-ci windows
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProjectWorkspace } = require('../electron/project-workspace.js');

const bytes = project => Buffer.from(JSON.stringify(project));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ files = {}, recent = [] } = {}) {
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
    writeFile: vi.fn(async (file, contents) => { writes.push(['write', file, contents]); }),
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
  it('dialog/drop、recent、OS live 與 startup 共用相同 parse-before-grant outcome', async () => {
    const valid = 'C:\\Projects\\valid.subtool';
    const broken = 'C:\\Projects\\broken.subtool';
    const project = bytes({ media: { path: 'D:\\Media\\program.mov' } });
    const fx = fixture({
      files: { [valid]: project, [broken]: Buffer.from('{broken') },
      recent: [{ path: broken, name: 'broken.subtool', at: 1 }],
    });

    await expect(fx.workspace.open(broken)).resolves.toBeNull();
    await expect(fx.workspace.openRecent(0)).resolves.toBeNull();
    expect(fx.workspace.stageStartup(broken)).toBe(true);
    await expect(fx.workspace.openStartup([])).resolves.toBeNull();
    await expect(fx.workspace.openLatest(broken)).resolves.toBeNull();
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

    const oldOpen = fx.workspace.openLatest(oldPath);
    const newOpen = fx.workspace.openLatest(newPath);
    await expect(newOpen).resolves.toMatchObject({ path: newPath });
    slow.resolve(bytes({ media: { path: 'D:\\Media\\old.mov' } }));
    await expect(oldOpen).resolves.toBeNull();
    expect(fx.grants).toEqual([
      ['project', newPath],
      ['media', 'D:\\Media\\new.mov'],
    ]);
    expect(fx.recent().map(item => item.path)).toEqual([newPath]);
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

    await expect(fx.workspace.listRecent()).resolves.toEqual([
      { index: 0, path: present, name: 'present.subtool', at: 2, missing: false },
      { index: 1, path: missing, name: 'missing.subtool', at: 1, missing: true },
    ]);
    await expect(fx.workspace.openRecent(1)).resolves.toBeNull();
    expect(fx.recent().map(item => item.path)).toEqual([present]);
    expect(fx.workspace.clearRecent()).toBe(true);
    expect(fx.recent()).toEqual([]);
  });
});

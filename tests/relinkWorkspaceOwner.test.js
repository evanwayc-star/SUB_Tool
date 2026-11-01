import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority.js');
const { createProjectWorkspace } = require('../electron/project-file-authority-engine.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('實際專案工作區切換與 relink 所有者', () => {
  it.each(['opened', 'failed', 'cancelled'])('另一專案 %s 時處理舊搜尋資格', async outcome => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-relink-owner-')); roots.push(root);
    const first = path.join(root, 'A.subtool'), second = path.join(root, 'B.subtool');
    const old = path.join(root, 'missing', 'master.mxf'), found = path.join(root, 'master.mxf');
    fs.writeFileSync(first, JSON.stringify({ media: { path: old } }));
    fs.writeFileSync(second, outcome === 'failed' ? '{invalid' : JSON.stringify({ media: null }));
    fs.writeFileSync(found, 'candidate bytes');
    const authority = new FileAuthority();
    const workspace = createProjectWorkspace({ readFile: file => fs.promises.readFile(file),
      grantProjectFile: file => authority.grantProjectFile(file), grantMediaFile: file => authority.grantTrustedFile(file) });
    expect(await workspace.open(first)).not.toBeNull();
    let started, resume;
    const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { resume = resolve; });
    const io = { ...fs, promises: { ...fs.promises, async readdir(...args) { started(); await gate; return fs.promises.readdir(...args); } } };
    const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8'), ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const statements = ast.body.filter(node => (node.type === 'FunctionDeclaration' && node.id?.name === 'findFileRecursively')
      || (node.type === 'ExpressionStatement' && node.expression?.callee?.object?.name === 'ipcMain'
        && node.expression.callee.property?.name === 'handle' && ['fs:findRelinkTarget', 'dialog:openProject'].includes(node.expression.arguments[0]?.value)));
    expect(statements).toHaveLength(3);
    const handlers = new Map();
    vm.runInNewContext(statements.map(node => source.slice(node.start, node.end)).join('\n'), {
      fs: io, path, fileAuthority: authority, projectWorkspace: workspace,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true }) }, lastDir: () => root, rememberDir() {},
    });
    const pending = handlers.get('fs:findRelinkTarget')({}, { projectPath: first, oldMediaPath: old });
    await ready;
    if (outcome === 'cancelled') expect(await handlers.get('dialog:openProject')()).toBeNull();
    else expect(await workspace.open(second)).toEqual(outcome === 'failed' ? null : expect.objectContaining({ path: second }));
    resume();
    expect(await pending).toBe(outcome === 'opened' ? null : found);
    expect(authority.canRead(found)).toBe(outcome !== 'opened');
    if (outcome === 'opened') {
      expect(await handlers.get('fs:findRelinkTarget')({}, { projectPath: first, oldMediaPath: old })).toBeNull();
      expect(authority.canRead(found)).toBe(false);
    }
  });
});

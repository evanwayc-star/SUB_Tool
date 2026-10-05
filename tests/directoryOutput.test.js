import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { writeDirectoryFiles } = require('../electron/directory-output.js');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(fs.realpathSync(root))).toBe(fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-directory-output-'));
  roots.push(root);
  const chosen = path.join(root, 'chosen'), outside = path.join(root, 'outside');
  fs.mkdirSync(chosen); fs.mkdirSync(outside);
  return { root, chosen, outside };
}
const file = (name, content) => ({ name, b64: Buffer.from(content).toString('base64') });
const privateFiles = chosen => fs.readdirSync(chosen).filter(name => name.startsWith('.directory-output-'));
function registeredExportDirectory(chosen, { canceled = false } = {}) {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const call = tree.body.map(node => node.expression).find(node =>
    node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle'
    && node.arguments?.[0]?.value === 'dialog:exportDirectory');
  let execute;
  const grant = vi.fn();
  vm.runInNewContext(source.slice(call.start, call.end), {
    ipcMain: { handle: (name, handler) => { execute = handler; } },
    dialog: { showOpenDialog: async () => ({ canceled, filePaths: [chosen] }) },
    fileAuthority: { grantDeliveryDirectory: grant }, writeDirectoryFiles,
    console: { warn: vi.fn() },
  });
  return { execute, grant };
}

describe('native directory output public interface', () => {
  it('publishes nested style and subtitle bytes and safely replaces a normal file', () => {
    const { chosen } = fixture();
    fs.writeFileSync(path.join(chosen, 'old.srt'), 'old subtitle');
    expect(writeDirectoryFiles(chosen, [file('styles/新聞/preset.json', '{"name":"主標"}'),
      { name: 'subs/cues.srt', content: Buffer.from('1\n字幕').toString('base64') }, file('old.srt', 'new subtitle')]))
      .toEqual({ written: 3, blocked: 0 });
    expect(fs.readFileSync(path.join(chosen, 'styles/新聞/preset.json'), 'utf8')).toBe('{"name":"主標"}');
    expect(fs.readFileSync(path.join(chosen, 'subs/cues.srt'), 'utf8')).toBe('1\n字幕');
    expect(fs.readFileSync(path.join(chosen, 'old.srt'), 'utf8')).toBe('new subtitle');
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('rejects lexical traversal and root-as-file while retaining legitimate output', () => {
    const { chosen, outside } = fixture();
    fs.writeFileSync(path.join(outside, 'secret'), 'preserved');
    const attacks = ['../outside/secret', 'sub/../../outside/secret', '.', path.join(outside, 'secret')];
    if (process.platform === 'win32') attacks.push('..\\outside\\secret', 'safe.json:stream');
    expect(writeDirectoryFiles(chosen, [...attacks.map(name => file(name, 'unsafe')), file('safe.srt', 'safe')]))
      .toEqual({ written: 1, blocked: attacks.length });
    expect(fs.readFileSync(path.join(outside, 'secret'), 'utf8')).toBe('preserved');
    expect(fs.readFileSync(path.join(chosen, 'safe.srt'), 'utf8')).toBe('safe');
  });

  it('actual exportDirectory IPC does not follow an existing directory junction outside picked root', async () => {
    const { chosen, outside } = fixture();
    const sentinel = path.join(outside, 'preset.json'); fs.writeFileSync(sentinel, 'preserved');
    fs.symlinkSync(outside, path.join(chosen, 'group'), process.platform === 'win32' ? 'junction' : 'dir');
    const { execute, grant } = registeredExportDirectory(chosen);
    expect(await execute({}, [file('group/preset.json', 'overwrite'), file('safe.json', 'safe')])).toBe(chosen);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserved');
    expect(fs.readFileSync(path.join(chosen, 'safe.json'), 'utf8')).toBe('safe');
    expect(grant).not.toHaveBeenCalled();
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('even a junction resolving inside the root is not traversed', () => {
    const { chosen } = fixture(); fs.mkdirSync(path.join(chosen, 'real'));
    fs.symlinkSync(path.join(chosen, 'real'), path.join(chosen, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(writeDirectoryFiles(chosen, [file('alias/new.json', 'unsafe')])).toEqual({ written: 0, blocked: 1 });
    expect(fs.readdirSync(path.join(chosen, 'real'))).toEqual([]);
  });

  it('the explicitly picked root may resolve through a junction, while nested links remain forbidden', () => {
    const { root, chosen } = fixture(); const picked = path.join(root, 'picked');
    fs.symlinkSync(chosen, picked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(writeDirectoryFiles(picked, [file('nested/preset.json', 'selected root')])).toEqual({ written: 1, blocked: 0 });
    expect(fs.readFileSync(path.join(chosen, 'nested/preset.json'), 'utf8')).toBe('selected root');
  });

  it('an existing linked target cannot be used as a file', () => {
    const { chosen, outside } = fixture(); const target = path.join(chosen, 'preset.json');
    fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    expect(writeDirectoryFiles(chosen, [file('preset.json', 'unsafe')])).toEqual({ written: 0, blocked: 1 });
    expect(fs.readdirSync(outside)).toEqual([]); expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('actual exportDirectory IPC replaces the chosen hardlink name without truncating an outside inode', async () => {
    const { chosen, outside } = fixture();
    const original = path.join(outside, 'preset.json'); fs.writeFileSync(original, 'original');
    const target = path.join(chosen, 'preset.json'); fs.linkSync(original, target);
    const { execute } = registeredExportDirectory(chosen);
    await execute({}, [file('preset.json', 'replacement')]);
    expect(fs.readFileSync(original, 'utf8')).toBe('original');
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
    expect(fs.statSync(original).ino).not.toBe(fs.statSync(target).ino);
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('picker cancellation writes nothing, while an empty directory choice grants only the native delivery capability', async () => {
    const { chosen } = fixture();
    const cancel = registeredExportDirectory(chosen, { canceled: true });
    expect(await cancel.execute({}, [file('unsafe.json', 'unused')])).toBeNull();
    expect(fs.readdirSync(chosen)).toEqual([]); expect(cancel.grant).not.toHaveBeenCalled();
    const pick = registeredExportDirectory(chosen);
    expect(await pick.execute({}, [])).toBe(chosen);
    expect(pick.grant).toHaveBeenCalledWith(chosen);
    expect(fs.readdirSync(chosen)).toEqual([]);
  });

  it.each(['writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'fstatSync'])('%s failure preserves existing bytes and removes its owned temporary file', operation => {
    const { chosen } = fixture(); const target = path.join(chosen, 'preset.json'); fs.writeFileSync(target, 'old bytes');
    let failed = false;
    const faultFs = { ...fs, [operation](...args) {
      if (!failed) { failed = true; throw Object.assign(new Error(operation + ' fault'), { code: 'EIO' }); }
      return fs[operation](...args);
    } };
    expect(() => writeDirectoryFiles(chosen, [file('preset.json', 'new bytes')], { fsModule: faultFs })).toThrow(operation + ' fault');
    expect(fs.readFileSync(target, 'utf8')).toBe('old bytes');
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('a nested parent replaced during staging is rejected and cleanup stays at the selected root', () => {
    const { chosen, outside } = fixture(); const parent = path.join(chosen, 'group'); fs.mkdirSync(parent);
    const sentinel = path.join(outside, 'preset.json'); fs.writeFileSync(sentinel, 'outside');
    const faultFs = { ...fs, writeFileSync(...args) {
      fs.writeFileSync(...args); fs.renameSync(parent, path.join(chosen, 'old-group'));
      fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    } };
    expect(writeDirectoryFiles(chosen, [file('group/preset.json', 'new bytes')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1 });
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside'); expect(privateFiles(chosen)).toEqual([]);
    expect(fs.readdirSync(path.join(chosen, 'old-group'))).toEqual([]);
  });

  it('a temporary path replaced by another writer is preserved rather than deleted or published', () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'preset.json'); fs.writeFileSync(target, 'old');
    let replacement;
    const faultFs = { ...fs, closeSync(descriptor) {
      fs.closeSync(descriptor); const name = privateFiles(chosen)[0]; replacement = path.join(chosen, name);
      fs.renameSync(replacement, path.join(chosen, 'owned-moved')); fs.writeFileSync(replacement, 'another writer');
    } };
    expect(writeDirectoryFiles(chosen, [file('preset.json', 'new')], { fsModule: faultFs })).toEqual({ written: 0, blocked: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('old'); expect(fs.readFileSync(replacement, 'utf8')).toBe('another writer');
  });

  it('exclusive temporary-file collision never deletes another writer file', () => {
    const { chosen } = fixture(); const collision = path.join(chosen, '.directory-output-fixed.tmp');
    fs.writeFileSync(collision, 'another writer');
    expect(() => writeDirectoryFiles(chosen, [file('preset.json', 'new')], { randomUUID: () => 'fixed' }))
      .toThrow();
    expect(fs.readFileSync(collision, 'utf8')).toBe('another writer');
    expect(fs.existsSync(path.join(chosen, 'preset.json'))).toBe(false);
  });
});

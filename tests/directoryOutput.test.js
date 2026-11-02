import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { writeDirectoryFiles, createDirectoryOutputRuntime } = require('../electron/directory-output.js');
const { fileCommitCoordinator } = require('../electron/file-commit-coordinator.js');
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
function registeredExportDirectory(chosen, { canceled = false, fsModule = fs } = {}) {
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
    fileAuthority: { grantDeliveryDirectory: grant },
    directoryOutput: { write: (directory, files) => writeDirectoryFiles(directory, files, { fsModule }) },
    console: { warn: vi.fn() },
  });
  return { execute, grant };
}

function registeredExportSubtitle(target, { canceled = false, fsModule = fs } = {}) {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const call = tree.body.map(node => node.expression).find(node =>
    node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle'
    && node.arguments?.[0]?.value === 'dialog:exportSub');
  let execute;
  vm.runInNewContext(source.slice(call.start, call.end), {
    ipcMain: { handle: (name, handler) => { execute = handler; } },
    dialog: { showSaveDialog: async () => ({ canceled, filePath: target }) },
    fs: fsModule, Buffer, path,
    directoryOutput: { write: (directory, files) => writeDirectoryFiles(directory, files, { fsModule }) },
  });
  return data => execute({}, { name: 'captions.srt', ext: 'srt', b64: Buffer.from(data).toString('base64') });
}

describe('native directory output public interface', () => {
  it('同步失敗且暫存內容被追加時，不能只憑原內容前綴清除外部資料', () => {
    const { chosen } = fixture();
    let stage, stageFd, stageStats=0;
    const injected = { ...fs,
      openSync(target, ...args) {
        const fd=fs.openSync(target,...args);
        if (typeof target === 'string' && path.basename(target).startsWith('.directory-output-') && args[0] === 'wx+') {
          stage=target;stageFd=fd;
        }
        return fd;
      },
      fstatSync(fd, ...args) {
        if (fd === stageFd && ++stageStats === 2) fs.appendFileSync(stage,'外部追加');
        return fs.fstatSync(fd,...args);
      },
      fsyncSync() { throw Object.assign(new Error('同步失敗'),{code:'EIO'}); },
    };
    expect(() => writeDirectoryFiles(chosen,[file('captions.srt','字幕原文')],{fsModule:injected})).toThrow('同步失敗');
    expect(fs.existsSync(path.join(chosen,'captions.srt'))).toBe(false);
    expect(fs.readFileSync(stage,'utf8')).toBe('字幕原文外部追加');
  });

  it('背景輸出保持主事件迴圈可回應，並等實際檔案發布完成', async () => {
    const { chosen } = fixture();
    const target = path.join(chosen, 'large.srt');
    const descriptor = fs.openSync(target, 'w');
    try { fs.ftruncateSync(descriptor, 64 * 1024 * 1024); } finally { fs.closeSync(descriptor); }
    const runtime = createDirectoryOutputRuntime({coordinator:fileCommitCoordinator});
    let settled = false;
    const pending = runtime.write(chosen, [file('large.srt', '完成的字幕')]);
    pending.finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await pending).toEqual({written:1,blocked:0});
    expect(fs.readFileSync(target, 'utf8')).toBe('完成的字幕');
    await runtime.close();
  });

  it('背景輸出依序提交；關閉等待已接受的工作並拒絕新工作，恢復後可再次輸出', async () => {
    const { chosen } = fixture(), runtime = createDirectoryOutputRuntime({coordinator:fileCommitCoordinator});
    const first = runtime.write(chosen, [file('captions.srt', '第一份')]);
    const second = runtime.write(chosen, [file('captions.srt', '第二份')]);
    const closing = runtime.close();
    await expect(runtime.write(chosen, [file('later.srt', '不應輸出')])).rejects.toThrow('正在關閉');
    await Promise.all([first, second, closing]);
    expect(fs.readFileSync(path.join(chosen, 'captions.srt'), 'utf8')).toBe('第二份');
    expect(fs.existsSync(path.join(chosen, 'later.srt'))).toBe(false);
    runtime.resume();
    expect(await runtime.write(chosen, [file('later.srt', '恢復')])).toEqual({written:1,blocked:0});
    expect(fs.readFileSync(path.join(chosen, 'later.srt'), 'utf8')).toBe('恢復');
    await runtime.close();
  });

  it('排入背景工作後所選目錄被替換，不可寫入替代目錄', async () => {
    const { root, chosen } = fixture(), runtime = createDirectoryOutputRuntime({coordinator:fileCommitCoordinator});
    const pending = runtime.write(chosen, [file('captions.srt', '舊工作')]);
    fs.renameSync(chosen, path.join(root, 'original'));
    fs.mkdirSync(chosen);
    fs.writeFileSync(path.join(chosen, 'captions.srt'), '外部內容');
    await expect(pending).rejects.toMatchObject({code:'UNSAFE_DIRECTORY_OUTPUT'});
    expect(fs.readFileSync(path.join(chosen, 'captions.srt'), 'utf8')).toBe('外部內容');
    expect(fs.existsSync(path.join(root, 'original', 'captions.srt'))).toBe(false);
    await runtime.close();
  });
  it('actual single subtitle IPC preserves previous output and uncertain partial bytes after a write failure', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'previous complete subtitles');
    const faultFs = { ...fs, writeFileSync(destination, bytes, ...rest) {
      fs.writeFileSync(destination, Buffer.from(bytes).subarray(0, 3), ...rest);
      throw Object.assign(new Error('disk write failed'), { code: 'EIO' });
    } };
    const execute = registeredExportSubtitle(target, { fsModule: faultFs });
    await expect(execute('new subtitles')).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(target, 'utf8')).toBe('previous complete subtitles');
    const [partial] = privateFiles(chosen);
    expect(privateFiles(chosen)).toHaveLength(1);
    expect(fs.readFileSync(path.join(chosen, partial), 'utf8')).toBe('new');
  });

  it('actual single subtitle IPC publishes complete bytes, including an intentionally empty file', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    const execute = registeredExportSubtitle(target);
    for (const bytes of [Buffer.from('完整字幕', 'utf16le'), Buffer.alloc(0)]) {
      expect(await execute(bytes)).toBe(target);
      expect(fs.readFileSync(target)).toEqual(bytes);
    }
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('single subtitle picker cancellation preserves the previous file', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'previous');
    expect(await registeredExportSubtitle(target, { canceled: true })('unused')).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('single subtitle output blocked during publication reports failure instead of success or cancellation', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.mkdirSync(target);
    await expect(registeredExportSubtitle(target)('subtitle')).rejects.toThrow();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('actual single subtitle IPC reports a destination conflict and preserves the other writer', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'original');
    const faultFs = { ...fs, fsyncSync(descriptor) {
      fs.fsyncSync(descriptor); fs.writeFileSync(target, 'external');
    } };
    await expect(registeredExportSubtitle(target, { fsModule: faultFs })('new')).rejects
      .toThrow('匯出期間目的檔已變更');
    expect(fs.readFileSync(target, 'utf8')).toBe('external');
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('actual batch IPC reports a conflict and partial success while preserving both results', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'conflict.srt');
    fs.writeFileSync(target, 'original');
    let injected = false;
    const faultFs = { ...fs, fsyncSync(descriptor) {
      fs.fsyncSync(descriptor);
      if (!injected) { injected = true; fs.writeFileSync(target, 'external'); }
    } };
    const { execute, grant } = registeredExportDirectory(chosen, { fsModule: faultFs });
    await expect(execute({}, [file('conflict.srt', 'pending'), file('success.srt', 'safe')]))
      .rejects.toThrow('已寫入 1 個檔案，略過 1 個；其中 1 個目的檔在匯出期間變更');
    expect(fs.readFileSync(target, 'utf8')).toBe('external');
    expect(fs.readFileSync(path.join(chosen, 'success.srt'), 'utf8')).toBe('safe');
    expect(privateFiles(chosen)).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
  });

  it('actual batch IPC reports a changed staging file while publishing other valid files', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'one.srt');
    fs.writeFileSync(target, 'original');
    let injected = false, changedStage;
    const faultFs = { ...fs, fsyncSync(descriptor) {
      fs.fsyncSync(descriptor);
      if (injected) return;
      injected = true;
      changedStage = path.join(chosen, privateFiles(chosen)[0]);
      fs.writeFileSync(changedStage, 'external');
    } };
    const { execute, grant } = registeredExportDirectory(chosen, { fsModule: faultFs });
    await expect(execute({}, [file('one.srt', 'intended'), file('two.srt', 'correct')]))
      .rejects.toThrow('匯出未完成：已寫入 1 個檔案，略過 1 個');
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readFileSync(changedStage, 'utf8')).toBe('external');
    expect(fs.readFileSync(path.join(chosen, 'two.srt'), 'utf8')).toBe('correct');
    expect(grant).not.toHaveBeenCalled();
  });

  it('核對多區塊內容時容許讀取系統呼叫回傳短讀', () => {
    const { chosen } = fixture(); const bytes = Buffer.alloc(150_000, 0x5a);
    let reads = 0;
    const faultFs = { ...fs, readSync(fd, buffer, offset, length, position) {
      reads++;
      return fs.readSync(fd, buffer, offset, Math.min(length, 4096), position);
    } };
    expect(writeDirectoryFiles(chosen, [{ name: 'large.srt', b64: bytes.toString('base64') }], { fsModule: faultFs }))
      .toEqual({ written: 1, blocked: 0 });
    expect(reads).toBeGreaterThan(3);
    expect(fs.readFileSync(path.join(chosen, 'large.srt'))).toEqual(bytes);
    expect(privateFiles(chosen)).toEqual([]);
  });

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

  it('actual exportDirectory IPC reports partial output and does not follow an existing directory junction outside picked root', async () => {
    const { chosen, outside } = fixture();
    const sentinel = path.join(outside, 'preset.json'); fs.writeFileSync(sentinel, 'preserved');
    fs.symlinkSync(outside, path.join(chosen, 'group'), process.platform === 'win32' ? 'junction' : 'dir');
    const { execute, grant } = registeredExportDirectory(chosen);
    await expect(execute({}, [file('group/preset.json', 'overwrite'), file('safe.json', 'safe')]))
      .rejects.toThrow('匯出未完成：已寫入 1 個檔案，略過 1 個');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserved');
    expect(fs.readFileSync(path.join(chosen, 'safe.json'), 'utf8')).toBe('safe');
    expect(grant).not.toHaveBeenCalled();
    expect(privateFiles(chosen)).toEqual([]);
  });

  it.each([
    { name: '有效與無效混合', files: [file('safe.json', 'safe'), null], written: 1 },
    { name: '全部無效', files: [null, { name: 'missing-content.json' }], written: 0 },
  ])('$name 的非空匯出不會被當成成功或純選目錄', async ({ files, written }) => {
    const { chosen } = fixture();
    const { execute, grant } = registeredExportDirectory(chosen);
    await expect(execute({}, files)).rejects.toThrow(`匯出未完成：已寫入 ${written} 個檔案，略過 ${files.length - written} 個`);
    expect(fs.readdirSync(chosen)).toEqual(written ? ['safe.json'] : []);
    if (written) expect(fs.readFileSync(path.join(chosen, 'safe.json'), 'utf8')).toBe('safe');
    expect(grant).not.toHaveBeenCalled();
    expect(privateFiles(chosen)).toEqual([]);
  });

  it('全部被阻擋時回報零份輸出並保留既有目錄', async () => {
    const { chosen } = fixture(); fs.mkdirSync(path.join(chosen, 'preset.json'));
    const { execute, grant } = registeredExportDirectory(chosen);
    await expect(execute({}, [file('preset.json', 'unsafe')]))
      .rejects.toThrow('匯出未完成：已寫入 0 個檔案，略過 1 個');
    expect(fs.statSync(path.join(chosen, 'preset.json')).isDirectory()).toBe(true);
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
    expect(await execute({}, [file('preset.json', 'replacement')])).toBe(chosen);
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
      if (!failed && (operation !== 'fstatSync' && operation !== 'closeSync' || privateFiles(chosen).length)) {
        failed = true; throw Object.assign(new Error(operation + ' fault'), { code: 'EIO' });
      }
      return fs[operation](...args);
    } };
    expect(() => writeDirectoryFiles(chosen, [file('preset.json', 'new bytes')], { fsModule: faultFs })).toThrow(operation + ' fault');
    expect(fs.readFileSync(target, 'utf8')).toBe('old bytes');
    expect(privateFiles(chosen)).toEqual([]);
  });

  it.each(['新增', '替換', '同檔修改', '移除'])('輸出準備期間目的檔%s時保留外部內容並回報衝突', change => {
    const { chosen } = fixture();
    const target = path.join(chosen, 'captions.srt'), retained = path.join(chosen, 'retained.srt');
    if (change !== '新增') fs.writeFileSync(target, 'original');
    let injected = false;
    const faultFs = { ...fs, fsyncSync(descriptor) {
      fs.fsyncSync(descriptor);
      if (injected) return;
      injected = true;
      if (change === '新增') fs.writeFileSync(target, 'external');
      if (change === '替換') { fs.renameSync(target, retained); fs.writeFileSync(target, 'external'); }
      if (change === '同檔修改') {
        const before = fs.statSync(target, { bigint: true });
        fs.writeFileSync(target, 'modified');
        fs.utimesSync(target, new Date(946684800000), new Date(946684800000));
        const after = fs.statSync(target, { bigint: true });
        expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
      }
      if (change === '移除') fs.renameSync(target, retained);
    } };
    expect(writeDirectoryFiles(chosen, [file('captions.srt', 'pending')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1, conflicted: 1 });
    expect(privateFiles(chosen)).toEqual([]);
    if (change === '移除') expect(fs.existsSync(target)).toBe(false);
    else expect(fs.readFileSync(target, 'utf8')).toBe(change === '同檔修改' ? 'modified' : 'external');
    if (change === '替換' || change === '移除') expect(fs.readFileSync(retained, 'utf8')).toBe('original');
  });

  it('目的檔同 inode 同大小改寫但時間戳不可區分，仍保留外部字幕', () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'original');
    const initial = fs.lstatSync(target, { bigint: true });
    let injected = false; const descriptors = new Set();
    const freeze = stat => {
      Object.defineProperties(stat, { mtimeNs: { value: initial.mtimeNs }, ctimeNs: { value: initial.ctimeNs } });
      return stat;
    };
    const faultFs = { ...fs, fsyncSync(descriptor) {
      fs.fsyncSync(descriptor);
      if (!injected) { injected = true; fs.writeFileSync(target, 'modified'); }
    }, openSync(current, ...args) {
      const fd = fs.openSync(current, ...args); if (current === target) descriptors.add(fd); return fd;
    }, fstatSync(fd, ...args) {
      const stat = fs.fstatSync(fd, ...args); return descriptors.has(fd) ? freeze(stat) : stat;
    }, closeSync(fd) {
      descriptors.delete(fd); return fs.closeSync(fd);
    }, lstatSync(current, ...args) {
      const stat = fs.lstatSync(current, ...args);
      return current === target ? freeze(stat) : stat;
    } };
    expect(writeDirectoryFiles(chosen, [file('captions.srt', 'pending')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1, conflicted: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('modified');
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
      fs.closeSync(descriptor); const name = privateFiles(chosen)[0];
      if (!name) return;
      replacement = path.join(chosen, name);
      fs.renameSync(replacement, path.join(chosen, 'owned-moved')); fs.writeFileSync(replacement, 'another writer');
    } };
    expect(writeDirectoryFiles(chosen, [file('preset.json', 'new')], { fsModule: faultFs })).toEqual({ written: 0, blocked: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('old'); expect(fs.readFileSync(replacement, 'utf8')).toBe('another writer');
  });

  it.each(['fsyncSync', 'closeSync'])('暫存檔同 inode 在 %s 被改寫時保留外部內容，不發布也不刪除', operation => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'existing');
    let stage, injected = false;
    const faultFs = { ...fs, [operation](descriptor) {
      fs[operation](descriptor);
      if (injected || !privateFiles(chosen).length) return;
      injected = true;
      stage = path.join(chosen, privateFiles(chosen)[0]);
      const before = fs.statSync(stage, { bigint: true });
      fs.writeFileSync(stage, 'external');
      const after = fs.statSync(stage, { bigint: true });
      expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
    } };
    expect(writeDirectoryFiles(chosen, [file('captions.srt', 'intended')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readFileSync(stage, 'utf8')).toBe('external');
  });

  it('最終目的檔雜湊期間暫存被改寫且 metadata 相同，不能發布外部內容', () => {
    const { chosen } = fixture(), target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'original');
    let stage, initial, changed = false;
    const targets = new Set(), stages = new Set();
    const freeze = stat => {
      if (initial && changed) Object.defineProperties(stat, {
        mtimeNs: { value: initial.mtimeNs }, ctimeNs: { value: initial.ctimeNs },
      });
      return stat;
    };
    const faultFs = { ...fs, openSync(file, ...args) {
      const fd = fs.openSync(file, ...args);
      if (file === target) targets.add(fd);
      if (path.basename(file).startsWith('.directory-output-')) { stage = file; stages.add(fd); }
      return fd;
    }, fstatSync(fd, ...args) {
      const stat = fs.fstatSync(fd, ...args); return stages.has(fd) ? freeze(stat) : stat;
    }, lstatSync(file, ...args) {
      const stat = fs.lstatSync(file, ...args); return file === stage ? freeze(stat) : stat;
    }, closeSync(fd) {
      if (stages.has(fd) && !initial) initial = fs.fstatSync(fd, { bigint: true });
      targets.delete(fd); stages.delete(fd); return fs.closeSync(fd);
    }, readSync(fd, ...args) {
      if (targets.has(fd) && initial && !changed) { fs.writeFileSync(stage, 'external'); changed = true; }
      return fs.readSync(fd, ...args);
    } };
    expect(writeDirectoryFiles(chosen, [file('captions.srt', 'intended')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1 });
    expect(changed).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readFileSync(stage, 'utf8')).toBe('external');
  });

  it('同步失敗時若暫存檔也被改寫，清理不可刪除外部內容', () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'existing');
    let stage;
    const faultFs = { ...fs, fsyncSync() {
      stage = path.join(chosen, privateFiles(chosen)[0]);
      fs.writeFileSync(stage, 'external');
      throw Object.assign(new Error('sync failed'), { code: 'EIO' });
    } };
    expect(() => writeDirectoryFiles(chosen, [file('captions.srt', 'intended')], { fsModule: faultFs })).toThrow('sync failed');
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readFileSync(stage, 'utf8')).toBe('external');
  });

  it('寫入部分資料後出錯，另一程序的同 inode 內容必須保留', async () => {
    const { chosen } = fixture(); const target = path.join(chosen, 'captions.srt');
    fs.writeFileSync(target, 'existing');
    let stage;
    const faultFs = { ...fs, writeFileSync(descriptor, bytes) {
      fs.writeFileSync(descriptor, Buffer.from(bytes).subarray(0, 3));
      stage = path.join(chosen, privateFiles(chosen)[0]);
      const before = fs.statSync(stage, { bigint: true });
      fs.writeFileSync(stage, 'external');
      const after = fs.statSync(stage, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      throw Object.assign(new Error('partial write failed'), { code: 'EIO' });
    } };
    await expect(registeredExportSubtitle(target, { fsModule: faultFs })('intended')).rejects.toThrow('partial write failed');
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readFileSync(stage, 'utf8')).toBe('external');
  });

  it('the picked root replaced after staging cannot authorize cleanup in the replacement directory', () => {
    const { root, chosen } = fixture();
    const target = path.join(chosen, 'captions.srt'), moved = path.join(root, 'moved-chosen');
    fs.writeFileSync(target, 'original');
    let planted;
    const faultFs = { ...fs, closeSync(descriptor) {
      fs.closeSync(descriptor);
      const stageName = privateFiles(chosen)[0];
      if (!stageName) return;
      fs.renameSync(chosen, moved);
      fs.mkdirSync(chosen);
      planted = path.join(chosen, stageName);
      fs.linkSync(path.join(moved, stageName), planted);
    } };
    expect(writeDirectoryFiles(chosen, [file('captions.srt', 'pending')], { fsModule: faultFs }))
      .toEqual({ written: 0, blocked: 1 });
    expect(fs.readFileSync(path.join(moved, 'captions.srt'), 'utf8')).toBe('original');
    expect(fs.readFileSync(planted, 'utf8')).toBe('pending');
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

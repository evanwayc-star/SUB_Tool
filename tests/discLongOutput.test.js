import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const filename = path.resolve('electron/disc-authoring.js');
const require = createRequire(filename);
const fixtures = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('BD 輸出長路徑', () => {
  it('以本工作短 junction 寫入同一預留 stage，清理不跟隨輸出目錄', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-bd-output-'));
    fixtures.push(root);
    const parent = path.join(root, 'lease'); fs.mkdirSync(parent);
    const outputDir = path.join(root, 'x'.repeat(70), 'y'.repeat(70), 'z'.repeat(70), 'exports');
    fs.mkdirSync(outputDir, { recursive: true });
    const stagePath = path.join(outputDir, `.subtool-${'a'.repeat(16)}-${'b'.repeat(32)}.stage.iso`);
    const unrelated = path.join(outputDir, 'unrelated.txt');
    fs.writeFileSync(stagePath, 'reserved'); fs.writeFileSync(unrelated, 'untouched');
    const before = fs.lstatSync(stagePath, { bigint: true });
    const disc = require('../electron/disc-authoring.js');
    const workspace = await disc.prepareDiscOutput('bd-iso', { tempDir: parent });
    fs.writeFileSync(workspace.encodedPath, 'encoded');
    const shortRoot = path.join(root, 'alias'); fs.symlinkSync(parent, shortRoot, 'junction');
    const child = new EventEmitter();
    Object.assign(child, { pid: 123456, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    let outputArgument;
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: loaded, exports: loaded.exports, __dirname: path.dirname(filename), process, Buffer,
      require: name => name === 'fs/promises' ? { ...fsp, access: async () => {} }
        : name === 'child_process' ? { spawn(binary, args) {
          outputArgument = args[1];
          queueMicrotask(() => {
            child.emit('spawn');
            if (outputArgument.length < 260) fs.writeFileSync(outputArgument, 'short alias output');
            child.exitCode = 0; child.emit('close', 0, null);
          });
          return child;
        } } : require(name),
    }, { filename });
    const assertOutput = () => {
      disc.assertDiscWorkspace(workspace, { tempDir: parent });
      const current = fs.lstatSync(stagePath, { bigint: true });
      expect(String(current.dev)).toBe(String(before.dev));
      expect(String(current.ino)).toBe(String(before.ino));
    };
    await loaded.exports.finalizeDiscOutput('bd-iso', workspace.encodedPath, stagePath,
      { fps: 24, nativePaths: { tsmuxer: 'mock.exe' }, nativeWorkRoot: shortRoot, onOutputStart() {},
        onOutputLink(evidence) { workspace.outputLink = evidence; }, assertOutput }).catch(() => {});
    expect(outputArgument.length).toBeLessThan(260);
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('short alias output');
    assertOutput();
    await disc.cleanupDiscOutput(workspace, { tempDir: parent });
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('short alias output');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('untouched');
    fs.unlinkSync(shortRoot);
  });

  it('登記輸出 junction 後取消，不啟動 writer 且清理不跟隨目標', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-bd-cancel-'));
    fixtures.push(root);
    const parent = path.join(root, 'lease'), outputDir = path.join(root, 'output');
    fs.mkdirSync(parent); fs.mkdirSync(outputDir);
    const stagePath = path.join(outputDir, 'stage.iso');
    fs.writeFileSync(stagePath, 'reserved');
    fs.writeFileSync(path.join(outputDir, 'foreign.txt'), 'untouched');
    const disc = require('../electron/disc-authoring.js');
    const workspace = await disc.prepareDiscOutput('bd-iso', { tempDir: parent });
    fs.writeFileSync(workspace.encodedPath, 'encoded');
    const shortRoot = path.join(root, 'alias'); fs.symlinkSync(parent, shortRoot, 'junction');
    const loaded = { exports: {} }, controller = new AbortController();
    let spawned = false;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: loaded, exports: loaded.exports, __dirname: path.dirname(filename), process, Buffer,
      require: name => name === 'fs/promises' ? { ...fsp, access: async () => {} }
        : name === 'child_process' ? { spawn() { spawned = true; throw new Error('must not spawn'); } } : require(name),
    }, { filename });
    const result = loaded.exports.finalizeDiscOutput('bd-iso', workspace.encodedPath, stagePath, {
      fps: 24, nativePaths: { tsmuxer: 'mock.exe' }, nativeWorkRoot: shortRoot, signal: controller.signal,
      onOutputStart() {}, assertOutput() { disc.assertDiscWorkspace(workspace, { tempDir: parent }); },
      onOutputLink(evidence) { workspace.outputLink = evidence; controller.abort(); },
    });
    await expect(result).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(spawned).toBe(false);
    await disc.cleanupDiscOutput(workspace, { tempDir: parent });
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('reserved');
    expect(fs.readFileSync(path.join(outputDir, 'foreign.txt'), 'utf8')).toBe('untouched');
    fs.unlinkSync(shortRoot);
  });
});

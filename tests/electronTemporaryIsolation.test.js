import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest' }).body;
const directories = [];
const text = node => source.slice(node.start, node.end);
const registration = (node, owner, event) => node.type === 'ExpressionStatement'
  && node.expression.type === 'CallExpression'
  && node.expression.callee.object?.name === owner
  && node.expression.arguments[0]?.value === event;

function sandbox() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-temp-isolation-'));
  directories.push(directory);
  return directory;
}

// Execute the actual main-process allocation and quit cleanup in separate JS
// runtimes. Both share a real filesystem/temp parent and an identical clock.
function instance(directory, profile) {
  const handlers = new Map();
  const context = vm.createContext({
    fs, path, os: { tmpdir: () => directory }, Date: { now: () => 1770000000000 },
    app: { getPath: () => path.join(directory, profile), on: (event, handler) => handlers.set(event, handler) },
    mpvHost: { dispose() {} }, mediaIntakeRuntime: { close: () => Promise.resolve() },
  });
  const selected = statements.filter(node =>
    node.type === 'VariableDeclaration' && node.declarations.some(declaration =>
      ['TMP', 'tempFiles', 'tmpSeq'].includes(declaration.id.name))
    || node.type === 'FunctionDeclaration' && ['ensureTmp', 'tmpPath'].includes(node.id.name)
    || registration(node, 'app', 'quit'));
  vm.runInContext(selected.map(text).join('\n'), context);
  return {
    root: vm.runInContext('TMP', context),
    temporary: ext => vm.runInContext(`tmpPath(${JSON.stringify(ext)})`, context),
    quit: () => handlers.get('quit')(),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())
        || !path.basename(resolved).startsWith('subtool-temp-isolation-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('主程序的私有暫存所有權', () => {
  it('不同 profile 在同一毫秒及相同序號分配的檔案不互相覆寫', () => {
    const directory = sandbox();
    const first = instance(directory, 'profile-a');
    const second = instance(directory, 'profile-b');
    const a = first.temporary('wav'), b = second.temporary('wav');
    fs.writeFileSync(a, 'first instance PCM');
    fs.writeFileSync(b, 'second instance PCM');
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, 'utf8')).toBe('first instance PCM');
    expect(fs.readFileSync(b, 'utf8')).toBe('second instance PCM');
  });

  it('退出只回收自己的整個工作目錄，其他 instance 仍可讀寫既有中間檔', () => {
    const directory = sandbox();
    const first = instance(directory, 'profile-a');
    const second = instance(directory, 'profile-b');
    fs.writeFileSync(first.temporary('wav'), 'first WAV');
    const other = second.temporary('ass');
    fs.writeFileSync(other, 'second ASS');
    const nested = path.join(first.root, 'adapter-work');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'untracked-intermediate'), 'first adapter');
    const sentinel = path.join(directory, 'unrelated-file');
    fs.writeFileSync(sentinel, 'outside either owner');

    first.quit();
    expect(fs.existsSync(first.root)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('second ASS');
    fs.appendFileSync(other, ' still writing');
    const next = second.temporary('wav');
    fs.writeFileSync(next, 'second still active');
    expect(fs.readFileSync(next, 'utf8')).toBe('second still active');
    expect(fs.readFileSync(other, 'utf8')).toBe('second ASS still writing');
    second.quit();
    expect(fs.existsSync(second.root)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside either owner');
  });

  it('同 profile 的另一主程序退出且從未配置檔案，也不能刪除存活 instance 的檔案', () => {
    const directory = sandbox();
    const first = instance(directory, 'same-profile');
    const active = first.temporary('m4a');
    fs.writeFileSync(active, 'live encoded audio');
    instance(directory, 'same-profile').quit();
    expect(fs.readFileSync(active, 'utf8')).toBe('live encoded audio');
  });

  it('既有 mpv 偵測 IPC 回報當前主程序私有目錄中的記錄位置', () => {
    const directory = sandbox();
    const root = instance(directory, 'profile-a').root;
    let detect;
    vm.runInNewContext(text(statements.find(node => registration(node, 'ipcMain', 'mpv:detect'))), {
      ipcMain: { handle: (_, handler) => { detect = handler; } },
      mpvEmbeddingSupported: () => true, process: { platform: 'win32' },
      mpvHost: { detect: () => 'mpv.exe' }, console: { error() {} }, path, TMP: root,
    });
    expect(detect()).toEqual({ available: true, supported: true, exe: 'mpv.exe', logPath: path.join(root, 'mpv-last.log') });
  });

  it('播放驗收失敗時只讀取當前 CDP instance 回報的 mpv 記錄', async () => {
    const directory = sandbox();
    const current = path.join(directory, 'current-mpv.log');
    fs.writeFileSync(current, 'current instance diagnostic');
    fs.writeFileSync(path.join(directory, 'other-mpv.log'), 'other instance diagnostic');
    const script = fs.readFileSync(new URL('../scripts/acceptance/verify-transport-smoothness.js', import.meta.url), 'utf8');
    const run = parse(script, { ecmaVersion: 'latest' }).body
      .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'runMedia');
    const detect = vi.fn(async () => ({ logPath: current }));
    const page = vm.createContext({ window: { subtool: { mpv: { detect } } } });
    class CdpClient {
      async connect() {}
      async send() {}
      evaluate(code) { return Promise.resolve(vm.runInContext(code, page)); }
      close() {}
    }
    let waits = 0;
    const context = vm.createContext({
      fs, path, os: { tmpdir: () => directory }, CdpClient,
      probeMedia: () => ({ duration: 10 }), projectBytes: () => '{}', reservePort: async () => 9222,
      trackElectron: child => child, spawn: () => ({ stderr: { on() {} }, once() {} }),
      ROOT: directory, ELECTRON: 'unused', PACKAGED_EXE: null, process: { env: {} },
      waitFor: async () => {
        if (++waits === 1) return { webSocketDebuggerUrl: 'ws://current-instance' };
        throw new Error('fixture playback failure');
      },
      stopElectron: async () => {}, killTree() {}, verifiedCleanup() {},
    });
    vm.runInContext(script.slice(run.start, run.end), context);
    let failure;
    try { await vm.runInContext("runMedia('fixture.mov')", context); }
    catch (error) { failure = error; }
    expect(failure?.message).toContain('fixture playback failure');
    expect(failure?.message).toContain('current instance diagnostic');
    expect(failure?.message).not.toContain('other instance diagnostic');
    expect(detect).toHaveBeenCalledOnce();
  });
});

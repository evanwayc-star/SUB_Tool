// @subtool-ci windows
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createScreenTextRuntime } = require('../electron/screen-text-runtime.js');
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

function fixture(messages, options = {}) {
  const { scriptForMessage, ...runtimeOptions } = options;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'subtool-screen-text-exit-'));
  const source = path.join(directory, 'source.mp4');
  writeFileSync(source, 'owned process-exit fixture');
  const children = [];
  const descendants = new Set();
  let index = 0;
  const runtime = createScreenTextRuntime({
    executable: process.execPath,
    settings: { apiKey: () => 'fixture-key-not-a-real-credential' },
    cacheDir: directory,
    ffmpegPath: process.execPath,
    ffprobePath: process.execPath,
    onProgress: () => {},
    spawnChild(_executable, _args, spawnOptions) {
      const message = messages[index++];
      const script = scriptForMessage?.(message) ?? `process.stdin.resume(); process.stdin.once('end', () => {
        process.stdout.write(${JSON.stringify(JSON.stringify(message) + '\n')}, () => process.exit(0));
      });`;
      const child = spawn(process.execPath, ['-e', script], {
        ...spawnOptions, stdio: [...spawnOptions.stdio, 'ipc'],
      });
      const closed = new Promise(resolve => child.once('close', resolve));
      child.on('message', message => {
        if (Number.isSafeInteger(message?.ownedDescendant) && message.ownedDescendant > 0) {
          descendants.add(message.ownedDescendant);
        }
      });
      children.push({ child, closed });
      return child;
    },
    ...runtimeOptions,
  });
  const request = requestId => ({ path: source, start: 2, end: 6, requestId,
    provider: 'openai', sourceLang: 'en', smartAccuracy: false });
  const cleanup = async () => {
    // These handles were created by this fixture; never enumerate or kill unrelated processes.
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map(({ closed }) => closed));
    for (const pid of descendants) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 5000;
      for (;;) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= deadline) throw new Error('Owned test descendant did not stop');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const absolute = path.resolve(directory);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep)
      || !path.basename(absolute).startsWith('subtool-screen-text-exit-')) {
      throw new Error('Unexpected test directory');
    }
    rmSync(absolute, { recursive: true, force: true });
  };
  return { runtime, request, cleanup, children, descendants };
}

describe.skipIf(process.platform !== 'win32')('畫面辨識程序退出與 Windows taskkill 競態', () => {
  it.each(['result', 'checkpoint'])('正常退出的 %s 越界保留原始錯誤且可重試', async type => {
    const current = fixture([
      { type, cues: [], processedEnd: 6.0000001 },
      { type: 'result', cues: [], processedEnd: 6 },
    ]);
    const sender = owner();
    try {
      await expect(current.runtime.recognize(sender, current.request('out-of-range')))
        .rejects.toThrow('無效的已處理範圍');
      expect(current.children[0].child.exitCode).toBe(0);
      await expect(current.runtime.recognize(sender, current.request('retry')))
        .resolves.toEqual({ cues: [], processedEnd: 6 });
      await expect(current.runtime.cancelAllAndWait()).resolves.toBeUndefined();
    } finally { await current.cleanup(); }
  });

  it('API 錯誤正常退出保留可處理原因，不被重啟提示覆蓋', async () => {
    const current = fixture([{ type: 'error', message: 'HTTP 429: project_spend_limit_exceeded' }]);
    try {
      await expect(current.runtime.recognize(owner(), current.request('quota')))
        .rejects.toThrow('專案支出上限已達');
      expect(current.children[0].child.exitCode).toBe(0);
      await expect(current.runtime.cancelAllAndWait()).resolves.toBeUndefined();
    } finally { await current.cleanup(); }
  });

  it('只停掉父程序而影音子程序仍活著時維持阻擋重試與退出', async () => {
    const current = fixture([{ type: 'result', cues: [], processedEnd: 7 }], {
      scriptForMessage: message => `
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          windowsHide: true, detached: true, stdio: 'ignore',
        });
        descendant.once('spawn', () => {
          process.send({ ownedDescendant: descendant.pid }, () => {
            process.stdin.resume();
            process.stdin.once('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(message) + '\n')}));
          });
        });
        setInterval(() => {}, 1000);
      `,
      terminateChild: child => {
        // Model a failed tree termination followed by the actual parent-only fallback kill.
        child.kill('SIGKILL');
        return Promise.reject(new Error('無法確認影音子程序已停止'));
      },
    });
    const sender = owner();
    try {
      await expect(current.runtime.recognize(sender, current.request('unconfirmed-tree')))
        .rejects.toThrow('無法確認影音子程序已停止');
      expect(current.descendants.size).toBe(1);
      for (const pid of current.descendants) expect(() => process.kill(pid, 0)).not.toThrow();
      await expect(current.runtime.recognize(sender, current.request('blocked-retry')))
        .rejects.toThrow('進行中');
      await expect(current.runtime.cancelAllAndWait()).rejects.toThrow('無法確認影音子程序已停止');
    } finally { await current.cleanup(); }
  });
});

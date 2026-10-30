import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { rendererLagProbe } = require('../scripts/diagnostics/renderer-lag-probe.js');
const { isMainWindowTarget } = require('../scripts/acceptance/cdp-electron-harness.js');
const source = readFileSync(new URL('../scripts/diagnostics/measure-dialog-stall.js', import.meta.url), 'utf8');

// 執行整支 CLI 及送入兩行程的原始程式；只替換 CDP 傳輸、Electron 與時鐘。
async function runDiagnostic({ failRendererSetup = false, failCleanupReply = false, dialogDelay = 0, replaceHook = false,
  interruptSignal = null, interruptAt = 'read', queueFirst = false } = {}) {
  let now = 1700000000000, nextTimer = 0, clicked = false, setupFailed = false, cleanupFailed = false, nextToken = 0;
  const mainTimers = new Map(), pageTimers = new Map(), listeners = new Map();
  const output = [], exits = [];
  let cliProcess, interrupted = false;
  class Clock extends Date { static now() { return now; } }
  const timers = store => ({
    setInterval(callback) { const id = ++nextTimer; store.set(id, callback); return id; },
    clearInterval: id => store.delete(id),
  });
  const document = {
    visibilityState: 'visible', hasFocus: () => true,
    addEventListener(kind, handler) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(handler);
    },
    removeEventListener: (kind, handler) => listeners.get(kind)?.delete(handler),
  };
  const page = vm.createContext({ document, Date: Clock, performance: { now: () => now }, ...timers(pageTimers) });
  vm.runInContext('window = globalThis', page);
  let completeDialog, dialogDue;
  const original = vi.fn(() => dialogDelay ? new Promise(resolve => {
    dialogDue = now + dialogDelay;
    completeDialog = () => resolve({ canceled: true, filePaths: [] });
  }) : Promise.resolve({ canceled: true, filePaths: [] }));
  const dialog = { showOpenDialog: original };
  let laterHook;
  const webContents = {
    getURL: () => 'file:///SUB_Tool/dist/index.html',
    isDestroyed: () => false,
    async executeJavaScript(code) {
      const result = await vm.runInContext(code, page);
      if (failCleanupReply && !cleanupFailed && code.includes('probe.cleanup()')) {
        cleanupFailed = true;
        throw new Error('renderer cleanup reply lost');
      }
      if (failRendererSetup && !setupFailed && listeners.get('click')?.size) {
        setupFailed = true;
        throw new Error('renderer setup reply lost');
      }
      return result;
    },
  };
  const queueExecute = vi.fn(async () => { throw new Error('queue is not the media renderer'); });
  const windows = [{ getParentWindow: () => null, webContents }];
  if (queueFirst) windows.unshift({ getParentWindow: () => null, webContents: {
    getURL: () => 'file:///SUB_Tool/electron/queue.html', isDestroyed: () => false, executeJavaScript: queueExecute } });
  const host = vm.createContext({ URL,
    Date: Clock, performance: { now: () => now }, ...timers(mainTimers), __dlgLog: ['other-probe'],
    require: () => ({ dialog, BrowserWindow: { getAllWindows: () => windows } }),
  });
  const close = vi.fn();
  class CdpClient {
    async connect() {}
    async evaluate(code) {
      const result = await vm.runInContext(code, host);
      if (interruptSignal && !interrupted && code.includes(`)(${JSON.stringify(interruptAt)},`)) {
        interrupted = true;
        cliProcess.emit(interruptSignal);
      }
      if (!clicked && listeners.get('click')?.size) {
        clicked = true;
        for (const handler of listeners.get('click')) handler({
          target: { closest: () => ({ dataset: { act: 'open-media' } }) },
        });
        const pending = dialog.showOpenDialog();
        if (!dialogDelay) await pending;
        if (replaceHook) {
          const wrapped = dialog.showOpenDialog;
          laterHook = (...args) => wrapped(...args);
          dialog.showOpenDialog = laterHook;
        }
      }
      return result;
    }
    close() { close(); }
  }
  const runAgain = async () => {
    clicked = false;
    cliProcess = Object.assign(new EventEmitter(), {
      argv: ['node', 'measure-dialog-stall.js', '123'], _debugProcess() {},
      stdout: { write() {} }, exit: code => exits.push(code), exitCode: 0,
    });
    await vm.runInNewContext(source, {
    require: name => name === 'child_process' ? {} : name === 'node:crypto' ? { randomUUID: () => `dialog-fixture-${++nextToken}` }
      : name.includes('renderer-lag-probe') ? { rendererLagProbe }
        : { connectMainInspector: async () => new CdpClient(), isMainWindowTarget },
    process: cliProcess,
    console: { log: (...args) => output.push(args.join(' ')), error: (...args) => output.push(args.join(' ')) },
    Date: Clock, setTimeout: callback => {
      now += 2000;
      if (completeDialog && now >= dialogDue) { completeDialog(); completeDialog = null; }
      callback(); return 0;
    },
    });
  };
  await runAgain();
  return { mainTimers, pageTimers, listeners, original, dialog, laterHook, close, output, exits, host, page, runAgain,
    cliProcess, elapsed: now - 1700000000000, queueExecute };
}

describe('開檔延遲診斷的工作生命週期', () => {
  it('queue 視窗先列出仍只在主 renderer 安裝開檔與延遲探針', async () => {
    const run = await runDiagnostic({ queueFirst: true });
    expect(run.output.join('\n')).toContain('點擊 → 主行程進入 showOpenDialog： 0 ms');
    expect(run.original).toHaveBeenCalledOnce();
    expect(run.queueExecute).not.toHaveBeenCalled();
    expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
  });
  it.each([['SIGINT', 130], ['SIGTERM', 143]])(
    '%s 後清理回覆失敗仍保留中止碼，下一輪可完成收尾', async (interruptSignal, exitCode) => {
      const run = await runDiagnostic({ interruptSignal, interruptAt: 'start', failCleanupReply: true });
      expect(run.cliProcess.exitCode).toBe(exitCode);
      expect(run.output.join('\n')).toContain('renderer cleanup reply lost');
      expect(run.host.__subtoolDialogDiagnostic?.active).toBe(false);
      expect(run.dialog.showOpenDialog).toBe(run.original);
      expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
      expect(run.cliProcess.eventNames()).toEqual([]);
      await run.runAgain();
      expect(run.host.__subtoolDialogDiagnostic).toBeUndefined();
      expect(run.output.join('\n')).not.toContain('開檔診斷已在執行');
    },
  );

  it.each([['SIGINT', 'start', 130], ['SIGTERM', 'read', 143]])(
    '%s 中止 %s 階段仍收回兩行程探針並保留中止結束碼', async (interruptSignal, interruptAt, exitCode) => {
      const run = await runDiagnostic({ interruptSignal, interruptAt, dialogDelay: 7000 });
      expect(run.cliProcess.exitCode).toBe(exitCode);
      expect(run.elapsed).toBeLessThan(7000);
      expect(run.output.join('\n')).not.toContain('量測摘要');
      expect(run.dialog.showOpenDialog).toBe(run.original);
      expect(run.host.__subtoolDialogDiagnostic).toBeUndefined();
      expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
      expect([...run.listeners.values()].every(handlers => handlers.size === 0)).toBe(true);
      expect(run.cliProcess.eventNames()).toEqual([]);
      expect(run.close).toHaveBeenCalledOnce();
      await run.runAgain();
      expect(run.host.__subtoolDialogDiagnostic).toBeUndefined();
      expect(run.output.join('\n')).not.toContain('開檔診斷已在執行');
    },
  );

  it('正常報告後還原 dialog、釋放兩行程計時器與 renderer listeners', async () => {
    const run = await runDiagnostic();
    expect(run.output.join('\n')).toContain('點擊 → 主行程進入 showOpenDialog： 0 ms');
    expect(run.original).toHaveBeenCalledOnce();
    expect(run.dialog.showOpenDialog).toBe(run.original);
    expect(run.mainTimers.size).toBe(0);
    expect(run.pageTimers.size).toBe(0);
    expect([...run.listeners.values()].every(handlers => handlers.size === 0)).toBe(true);
    expect(run.close).toHaveBeenCalledOnce();
  });

  it('renderer 啟動回覆失敗也清理已裝上的探針與 CDP 連線', async () => {
    const run = await runDiagnostic({ failRendererSetup: true });
    expect(run.output.join('\n')).toContain('renderer setup reply lost');
    expect(run.dialog.showOpenDialog).toBe(run.original);
    expect(run.mainTimers.size).toBe(0);
    expect(run.pageTimers.size).toBe(0);
    expect([...run.listeners.values()].every(handlers => handlers.size === 0)).toBe(true);
    expect(run.close).toHaveBeenCalledOnce();
  });

  it('對話框超過 1.5 秒才關閉仍等待真實回覆並印出同次呼叫耗時', async () => {
    const run = await runDiagnostic({ dialogDelay: 7000 });
    expect(run.output.join('\n')).toMatch(/呼叫 → Promise 回覆：\s+8000 ms/);
    expect(run.dialog.showOpenDialog).toBe(run.original);
    expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
  });

  it('不清除常駐探針資料，也不覆寫後來安裝的 dialog hook', async () => {
    const run = await runDiagnostic({ replaceHook: true });
    expect(run.host.__dlgLog).toEqual(['other-probe']);
    expect(run.dialog.showOpenDialog).toBe(run.laterHook);
    expect(await run.dialog.showOpenDialog()).toEqual({ canceled: true, filePaths: [] });
    expect(run.original).toHaveBeenCalledTimes(2);
    expect(run.host.__subtoolDialogDiagnostic).toBeUndefined();
    expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
  });

  it('cleanup 回覆失敗後，下一次執行先完成舊 owner 收尾再重新量測', async () => {
    const run = await runDiagnostic({ failCleanupReply: true });
    expect(run.output.join('\n')).toContain('renderer cleanup reply lost');
    expect(run.host.__subtoolDialogDiagnostic?.active).toBe(false);
    await run.runAgain();
    expect(run.original).toHaveBeenCalledTimes(2);
    expect(run.host.__subtoolDialogDiagnostic).toBeUndefined();
    expect(run.mainTimers.size + run.pageTimers.size).toBe(0);
    expect(run.close).toHaveBeenCalledTimes(2);
  });
});

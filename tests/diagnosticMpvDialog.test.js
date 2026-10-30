import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isMainWindowTarget } = require('../scripts/acceptance/cdp-electron-harness.js');

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = read('scripts/diagnostics/diagnose-mpv-dialog.js');

async function runDiagnostic({ pid = '123', failProbe = false, initiallyOpen = false, queueFirst = false } = {}) {
  const dom = new JSDOM(`<div class="menubar"><div class="menu ${initiallyOpen ? 'open' : ''}">
    <button id="recentBtn"></button><div class="items"></div></div></div>`);
  const document = dom.window.document;
  document.elementFromPoint = () => document.querySelector('.items');
  const transitions = [];
  let nativeVisible = !initiallyOpen;
  const page = vm.createContext({
    document, window: {}, getComputedStyle: dom.window.getComputedStyle,
    emit(event) {
      if (event === 'mpv:sync') {
        nativeVisible = !document.querySelector('.menu.open');
        transitions.push(nativeVisible);
      }
    },
  });
  // 執行正式 UI 的選單函式與 click handlers；僅以事件訂閱者代替原生視窗。
  for (const [file, select] of [
    ['src/ui.js', node => node.type === 'FunctionDeclaration'
      && ['closeMenus', 'openMenu'].includes(node.id.name)],
    ['src/app.js', (node, code) => node.type === 'ExpressionStatement'
      && (code.startsWith("document.addEventListener('click',")
        || code.startsWith("document.querySelectorAll('.menu>button').forEach"))],
  ]) {
    const code = read(file);
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of ast.body) {
      const statement = code.slice(node.start, node.end);
      if (select(node, statement)) vm.runInContext(statement, page);
    }
  }
  const webContents = {
    getURL: () => 'file:///SUB_Tool/dist/index.html',
    async executeJavaScript(code) {
      if (failProbe && code.includes('elementFromPoint')) throw new Error('probe failed');
      return vm.runInContext(code, page);
    },
  };
  const queueExecute = vi.fn(async () => { throw new Error('queue is not the media renderer'); });
  const windows = [{
    id: 1, isVisible: () => nativeVisible, getParentWindow: () => null, webContents,
  }];
  if (queueFirst) windows.unshift({ id: 2, isVisible: () => true, getParentWindow: () => null,
    webContents: { getURL: () => 'file:///SUB_Tool/electron/queue.html', isDestroyed: () => false, executeJavaScript: queueExecute } });
  const host = vm.createContext({ URL, require: () => ({ BrowserWindow: { getAllWindows: () => windows } }) });
  const close = vi.fn(), debug = vi.fn(), getJSON = vi.fn(async () => [{ webSocketDebuggerUrl: 'ws://fixture' }]);
  class CdpClient {
    async connect() {}
    evaluate(code) { return vm.runInContext(code, host); }
    close() { close(); }
  }
  const exitSignal = new Error('fixture process exit');
  let exitCode;
  const runtime = vm.createContext({
    require: name => name === 'child_process'
      ? { execFileSync: () => pid } : {
        findMainPid: () => Number(pid),
        connectMainInspector: async () => { debug(); await getJSON(); return new CdpClient(); },
        isMainWindowTarget,
      },
    console: { log() {}, error() {} },
    setTimeout: callback => callback(),
    process: {
      argv: ['node', 'diagnose-mpv-dialog.js'], _debugProcess: debug,
      // process.exit 在真程序不會回到 catch；fixture 保留第一次退出結果並停止執行。
      exit(code) { exitCode ??= code; throw exitSignal; },
    },
  });
  try {
    await vm.runInContext(source, runtime);
  } catch (error) {
    if (error !== exitSignal) throw error;
  }
  const open = !!document.querySelector('.menu.open');
  dom.window.close();
  return { transitions, nativeVisible, open, exitCode, close, debug, getJSON, queueExecute };
}

describe('mpv 診斷腳本的真實入口', () => {
  it('queue 視窗先列出時，選單探針仍只操作主 renderer', async () => {
    const result = await runDiagnostic({ queueFirst: true });
    expect(result.exitCode).toBe(0);
    expect(result.transitions).toContain(false);
    expect(result.queueExecute).not.toHaveBeenCalled();
  });
  it.each([false, true])('選單起始 open=%s，診斷後經正常關閉流程恢復原生視窗', async initiallyOpen => {
    const result = await runDiagnostic({ initiallyOpen });
    expect(result.transitions).toContain(false);
    expect(result.transitions.at(-1)).toBe(true);
    expect(result.open).toBe(false);
    expect(result.nativeVisible).toBe(true);
    expect(result.close).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
  });

  it('探針失敗仍關閉工具開啟的選單及 inspector 連線', async () => {
    const result = await runDiagnostic({ failProbe: true });
    expect(result.open).toBe(false);
    expect(result.nativeVisible).toBe(true);
    expect(result.close).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(1);
  });

  it.each(['', '0', '-1', '1.5'])('PID %j 不可啟用 debugger 或連到 inspector', async pid => {
    const result = await runDiagnostic({ pid });
    expect(result.exitCode).toBe(1);
    expect(result.debug).not.toHaveBeenCalled();
    expect(result.getJSON).not.toHaveBeenCalled();
  });
});

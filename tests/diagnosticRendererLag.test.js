import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { rendererLagProbe } = require('../scripts/diagnostics/renderer-lag-probe.js');

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
  return null;
}

// 從實際診斷 caller 取得送至 webContents 的探針；只替換 Electron 與頁面時鐘 seam。
async function probe(file, name) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/diagnostics', file), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest' });
  const selected = name
    ? find(ast, node => node.type === 'VariableDeclarator' && node.id.name === name)?.init
    : find(ast, node => node.type === 'CallExpression' && node.callee.name === 'inPage'
      && source.slice(node.start, node.end).includes('window.__clickLog'))?.arguments[0];
  expect(selected).toBeTruthy();
  let now = 0, wallOffset = 0, nextTimer = 0;
  const listeners = new Map(), timers = new Map();
  const document = {
    visibilityState: 'visible', hasFocus: () => false,
    addEventListener(kind, handler) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(handler);
    },
    removeEventListener: (kind, handler) => listeners.get(kind)?.delete(handler),
  };
  const page = vm.createContext({
    window: {}, document,
    Date: { now: () => now + wallOffset }, performance: { now: () => now },
    setInterval(handler) { const id = ++nextTimer; timers.set(id, handler); return id; },
    clearInterval: id => timers.delete(id),
  });
  page.globalThis = page.window;
  const host = vm.createContext({
    rendererLagProbe,
    require: () => ({ BrowserWindow: { getAllWindows: () => [{
      getParentWindow: () => null,
      webContents: { executeJavaScript: code => vm.runInContext(code, page) },
    }] } }),
  });
  const code = vm.runInContext(source.slice(selected.start, selected.end), host);
  const arm = () => vm.runInContext(code, name ? host : page);
  await arm();
  const visibility = value => {
    document.visibilityState = value;
    for (const handler of listeners.get('visibilitychange') || []) handler();
  };
  return {
    arm, listeners, timers, page,
    advance(ms) { now += ms; for (const handler of timers.values()) handler(); },
    transition(ms, value) { now += ms; visibility(value); },
    visibility,
    moveWallClock: ms => { wallOffset += ms; },
    count: () => page.window.__lagTotal_p ?? page.window.__lagSum
      ?? (page.window.__lag_rend || []).reduce((total, row) => total + row.blocked, 0),
  };
}

describe('renderer 診斷的真實注入入口', () => {
  for (const [file, name] of [
    ['profile-renderer-stall.js', 'ARM_LAG'],
    ['watch-cpu-and-lag.js', 'ARM'],
    ['measure-dialog-stall.js', null],
  ]) {
    it(`${file} 排除背景節流與可見性切換，仍記錄無焦點的可見延遲`, async () => {
      const recorder = await probe(file, name);
      recorder.visibility('hidden');
      recorder.advance(60000);
      expect(recorder.count()).toBe(0);
      recorder.transition(30000, 'visible');
      recorder.advance(100);
      expect(recorder.count()).toBe(0);
      recorder.advance(1000);
      expect(recorder.count()).toBe(900);
      recorder.transition(50, 'hidden');
      recorder.transition(30000, 'visible');
      recorder.advance(100);
      expect(recorder.count()).toBe(900);
    });

    it(`${file} 重掛只保留一個 timer/listener，系統時鐘跳轉不會冒充延遲`, async () => {
      const recorder = await probe(file, name);
      await recorder.arm();
      expect(recorder.timers.size).toBe(1);
      expect(recorder.listeners.get('visibilitychange').size).toBe(1);
      if (name === null) expect(recorder.listeners.get('click').size).toBe(1);
      recorder.moveWallClock(60000);
      recorder.advance(100);
      expect(recorder.count()).toBe(0);
      recorder.advance(1000);
      expect(recorder.count()).toBe(900);
    });
  }

  it('長時間對話框量測保留最近事件並記錄被丟棄的筆數', async () => {
    const recorder = await probe('measure-dialog-stall.js', null);
    for (let i = 0; i < 601; i++) recorder.advance(1000);
    expect(recorder.page.window.__lag_rend).toHaveLength(600);
    expect(recorder.page.window.__lag_rendDropped).toBe(1);
    expect(recorder.page.window.__lag_rend[0]).toEqual({ t: 2000, blocked: 900 });
  });
});

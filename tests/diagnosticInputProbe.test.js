import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../scripts/diagnostics/measure-input-latency.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const result = child && typeof child === 'object' && find(child, predicate);
      if (result) return result;
    }
  }
  return null;
}
const arm = find(ast, node => node.type === 'VariableDeclarator' && node.id.name === 'ARM');
const polling = find(ast, node => node.type === 'WhileStatement' && node.test.name === 'alive');
const readerSource = readFileSync(new URL('../scripts/diagnostics/read-input-probe.js', import.meta.url), 'utf8');

async function readProbe(records) {
  const lines = [], exits = [];
  let read = 0;
  class CdpClient {
    async connect() {}
    async evaluate() {
      return [true, JSON.stringify(records), '[]'][read++];
    }
    close() {}
  }
  await vm.runInNewContext(readerSource, {
    require: name => name === 'child_process' ? {} : {
      CdpClient,
      getJSON: async () => [{ webSocketDebuggerUrl: 'ws://test' }],
    },
    process: { argv: ['node', 'read-input-probe.js', '123'], _debugProcess() {}, exit: code => exits.push(code) },
    console: { log: value => lines.push(value), error: value => lines.push(value) },
    setTimeout: callback => { callback(); return 0; },
    Date,
  });
  expect(exits).toEqual([0]);
  return lines.join('\n');
}

function probe() {
  const handlers = new Map();
  const context = vm.createContext({ window: {}, performance: { now: () => 10 }, Date,
    document: { visibilityState: 'visible', addEventListener: (kind, handler) => handlers.set(kind, handler) },
  });
  const script = vm.runInContext(source.slice(arm.init.start, arm.init.end), context);
  const armProbe = () => vm.runInContext(script, context);
  armProbe();
  const emit = count => {
    for (let i = 0; i < count; i++) handlers.get('click')({ timeStamp: 9, target: { id: `event-${context.window.__inpSeq + 1}` } });
  };
  return { context, armProbe, emit };
}

async function poll(probe, afterFirst = 0) {
  const lines = [], warnings = [];
  let reads = 0;
  const context = { main: { evaluate: async () => {
    if (reads++ === 2) throw new Error('target closed');
    return JSON.stringify(probe.context.window.__inp);
  } }, inPage: value => value, sleep: async () => { if (reads === 1) probe.emit(afterFirst); },
  console: { log: value => lines.push(value), warn: value => warnings.push(value) }, Date,
  };
  await vm.runInNewContext(`(async () => { let seen = 0, alive = true; ${source.slice(polling.start, polling.end)} })()`, context);
  return { lines, warnings };
}

describe('輸入延遲探針的有界 ring', () => {
  it('累計超過60筆後仍輸出新事件一次，不用ring長度當讀取游標', async () => {
    const recorder = probe();
    recorder.emit(60);
    const result = await poll(recorder, 3);
    expect(result.lines).toHaveLength(63);
    for (let i = 1; i <= 63; i++) expect(result.lines.filter(line => line.endsWith(`event-${i}`))).toHaveLength(1);
    expect(recorder.context.window.__inp).toHaveLength(60);
    expect(result.warnings).toEqual([]);
  });

  it('重新掛上保留探針與序列，沒有重複安裝 listener', async () => {
    const recorder = probe();
    recorder.emit(3);
    recorder.armProbe();
    recorder.emit(1);
    expect((await poll(recorder)).lines).toHaveLength(4);
    expect(recorder.context.window.__inpSeq).toBe(4);
  });

  it('超過保存窗口時明確報告丟失筆數，仍印出保留事件', async () => {
    const recorder = probe();
    recorder.emit(100);
    const result = await poll(recorder);
    expect(result.lines).toHaveLength(60);
    expect(result.warnings).toEqual([expect.stringContaining('略過 40 筆')]);
  });

  it('常駐讀取的高延遲標記只描述到 handler 前等待，不代替使用者整段等待', async () => {
    const recorder = probe();
    recorder.emit(1);
    recorder.context.window.__inp[0].延遲ms = 2133;
    const result = await poll(recorder);
    expect(result.lines[0]).toContain('到 handler 前等待超過 1 秒');
    expect(result.lines[0]).not.toContain('這一段就是使用者等的時間');
  });
});

describe('輸入延遲讀取 CLI 的證據限制', () => {
  it('真實 reader 執行後保留高延遲資料，不能排除 renderer JavaScript 排隊', async () => {
    const output = await readProbe([
      { seq: 1, kind: 'pointerdown', act: 'busy-page', 延遲ms: 2133, vis: 'visible', at: 1700000000000 },
      { seq: 2, kind: 'click', act: 'normal', 延遲ms: 3, vis: 'visible', at: 1700000002200 },
    ]);
    expect(output).toContain('2133 ms');
    expect(output).toContain('busy-page');
    expect(output).toContain('3 ms');
    expect(output).toContain('normal');
    expect(output).toContain('可能包含 renderer JavaScript 排隊');
    expect(output).toContain('不能單靠這個數字判定原因');
    expect(output).toContain('到 handler 前等待超過 1 秒');
    expect(output).not.toContain('不是頁面裡的 JS');
    expect(output).not.toContain('這一段就是使用者等的時間');
  });

  it('正常事件仍印出資料，只對本次保留樣本下結論', async () => {
    const output = await readProbe([
      { seq: 1, kind: 'pointerdown', act: 'open-media', 延遲ms: 4, vis: 'visible', at: 1700000000000 },
    ]);
    expect(output).toContain('open-media');
    expect(output).toContain('4 ms');
    expect(output).toContain('本次保留樣本');
    expect(output).toContain('未記錄的時段');
    expect(output).not.toContain('每一次輸入都是即時處理的');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/diagnostics/watch-cpu-and-lag.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { rendererLagProbe } = require('../scripts/diagnostics/renderer-lag-probe.js');
const { isMainWindowTarget } = require('../scripts/acceptance/cdp-electron-harness.js');
const runs = [];
afterEach(async () => { for (const run of runs.splice(0)) await run.stop(); });

// 執行真正 CLI、main 注入與 renderer 探針，只替換 native adapters 與時鐘。
async function watcher({ failStart = false, holdStart = false, keepOtherProbe = false } = {}) {
  let now = 0, wallTime = 0, cpu = { app: 0, ffmpeg: 0 }, tick, timerActive = false;
  let holdRead = false, release, reply, readError, cpuCalls = 0, jobCalls = 0, reads = 0, closes = 0;
  let cleanupFailure = false, releaseStart;
  const lines = [], errors = [], pageTimers = new Map(), listeners = new Set();
  let nextTimer = 0;
  class WallDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wallTime])); }
    static now() { return wallTime; }
  }
  const page = vm.createContext({ window: { __inp: ['other-input-probe'] }, Date: WallDate,
    performance: { now: () => now }, document: { visibilityState: 'visible', hasFocus: () => true,
      addEventListener: (_, handler) => listeners.add(handler), removeEventListener: (_, handler) => listeners.delete(handler) },
    setInterval: callback => { const id = ++nextTimer; pageTimers.set(id, callback); return id; },
    clearInterval: id => pageTimers.delete(id),
  });
  if (keepOtherProbe) vm.runInContext(rendererLagProbe({ timerKey: '__lagT_cpu_other', totalKey: '__lagSum_cpu_other' }), page);
  const window = { getParentWindow: () => null, isVisible: () => true, isMinimized: () => false, isFocused: () => true,
    webContents: { getURL: () => 'file:///SUB_Tool/dist/index.html', isDestroyed: () => false,
      executeJavaScript: code => vm.runInContext(code, page) } };
  const replacementCalls = [];
  const replacement = { ...window, webContents: { ...window.webContents,
    executeJavaScript: code => { replacementCalls.push(code); return true; } } };
  let windows = [window];
  const host = vm.createContext({ URL, require: () => ({ BrowserWindow: { getAllWindows: () => windows } }) });
  const client = {
    async evaluate(code) {
      const command = /\)\('(start|read|stop)',/.exec(code)?.[1];
      if (command === 'read') {
        reads++;
        if (holdRead) { holdRead = false; await new Promise(resolve => { release = resolve; }); }
        if (readError) throw readError;
        if (reply !== undefined) return reply;
      }
      const result = await vm.runInContext(code, host);
      if (command === 'start' && holdStart) await new Promise(resolve => { releaseStart = resolve; });
      if (command === 'start' && failStart) throw new Error('start reply lost');
      if (command === 'stop' && cleanupFailure) { cleanupFailure = false; throw new Error('cleanup reply lost'); }
      return result;
    },
    close: () => { closes++; },
  };
  const cliProcess = Object.assign(new EventEmitter(), { argv: ['node', 'fixture', '42'], exitCode: 0 });
  const done = vm.runInNewContext(source, {
    require(name) {
      if (name === 'child_process') return { execFileSync: (_, args) => {
        if (args[2].includes('Get-Process |')) { cpuCalls++; return `10|electron|${cpu.app}\n12|ffmpeg|${cpu.ffmpeg}`; }
        jobCalls++; return '';
      } };
      if (name === 'os') return { cpus: () => [{}, {}] };
      if (name === 'node:crypto') return { randomUUID: () => 'cpu-fixture' };
      if (name === 'perf_hooks') return { performance: { now: () => now } };
      if (name.includes('main-inspector')) return { connectMainInspector: async () => client };
      if (name.includes('cdp-electron-harness')) return { isMainWindowTarget };
      return { rendererLagProbe };
    },
    Date: WallDate, process: cliProcess,
    console: { log: value => lines.push(value), error: (...values) => errors.push(values.join(' ')) },
    setTimeout: callback => { callback(); return 1; },
    setInterval: callback => { tick = callback; timerActive = true; return 1; },
    clearInterval: () => { timerActive = false; },
  });
  for (let i = 0; i < 20 && !tick && !closes; i++) await Promise.resolve();
  const setTime = (time, counters, wallJump = 0) => {
    wallTime += time - now + wallJump; now = time; cpu = counters;
  };
  const run = {
    done, lines, errors, page, host, pageTimers, listeners, cliProcess,
    tick: () => tick(), setTime,
    stats: () => ({ cpuCalls, jobCalls, reads, closes, timerActive }),
    hold: () => { holdRead = true; }, release: () => { release?.(); },
    invalidReply: value => { reply = value; }, rejectRead: () => { readError = new Error('renderer read failed'); },
    loseCleanupReply: () => { cleanupFailure = true; },
    releaseStart: () => releaseStart?.(), replacementCalls,
    replaceMainWindow: () => { windows = [replacement]; },
    async sample(time, counters, wallJump = 0) {
      setTime(time, counters, wallJump);
      const start = lines.length; await tick();
      const row = lines.slice(start).find(line => /\d+%/.test(line));
      const [, total, ffmpeg] = /(\d+)%\s+(\d+)%/.exec(row);
      return { total: Number(total), ffmpeg: Number(ffmpeg) };
    },
    async stop(signal = 'SIGINT') {
      cliProcess.emit(signal); release?.(); releaseStart?.(); await done;
    },
  };
  runs.push(run);
  return run;
}

describe('CPU 診斷使用實際相鄰採樣區間', () => {
  it.each([2000, 4000, 10000])('callback 在 %sms 才完成仍正確顯示雙核心飽和率', async elapsed => {
    const diagnostic = await watcher();
    expect(await diagnostic.sample(elapsed, { app: 0, ffmpeg: elapsed / 500 }))
      .toEqual({ total: 100, ffmpeg: 100 });
  });

  it('連續 callback 每次使用自己的真實區間，app 與 ffmpeg 分開計算', async () => {
    const diagnostic = await watcher();
    expect(await diagnostic.sample(2000, { app: 2, ffmpeg: 2 })).toEqual({ total: 100, ffmpeg: 50 });
    expect(await diagnostic.sample(5000, { app: 5, ffmpeg: 5 })).toEqual({ total: 100, ffmpeg: 50 });
    expect(await diagnostic.sample(12000, { app: 8.5, ffmpeg: 8.5 })).toEqual({ total: 50, ffmpeg: 25 });
  });

  it('系統時間跳轉不會改變單調時鐘下的 CPU 比例', async () => {
    const diagnostic = await watcher();
    expect(await diagnostic.sample(4000, { app: 4, ffmpeg: 4 }, 3600000))
      .toEqual({ total: 100, ffmpeg: 50 });
  });

  it('READ 延遲時跳過整輪，恢復後才讀 CPU 且使用包含等待的實際區間', async () => {
    const diagnostic = await watcher();
    diagnostic.setTime(2000, { app: 2, ffmpeg: 2 });
    diagnostic.hold();
    const pending = diagnostic.tick();
    await diagnostic.tick(); await diagnostic.tick();
    expect(diagnostic.stats()).toMatchObject({ reads: 1, cpuCalls: 1, jobCalls: 0 });
    diagnostic.setTime(10000, { app: 10, ffmpeg: 10 });
    diagnostic.page.window['__lagSum_cpu_cpu-fixture'] = 8000;
    diagnostic.release(); await pending;
    expect(diagnostic.stats()).toMatchObject({ reads: 1, cpuCalls: 2, jobCalls: 1 });
    expect(diagnostic.lines.filter(line => /\d+%/.test(line))).toEqual([expect.stringMatching(/8000 ms\s+100%\s+50%/)]);
    expect(await diagnostic.sample(12000, { app: 12, ffmpeg: 12 })).toEqual({ total: 100, ffmpeg: 50 });
  });
});

describe('CPU 診斷的失敗與取消生命週期', () => {
  it('啟動回覆前收到取消，等安裝完成後清理，不開始 CPU 採樣', async () => {
    const diagnostic = await watcher({ holdStart: true });
    diagnostic.cliProcess.emit('SIGINT');
    expect(diagnostic.pageTimers.size).toBe(1);
    expect(diagnostic.stats()).toMatchObject({ cpuCalls: 0, jobCalls: 0, closes: 0 });
    diagnostic.releaseStart(); await diagnostic.done;
    expect(diagnostic.cliProcess.exitCode).toBe(130);
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
    expect(diagnostic.stats()).toMatchObject({ cpuCalls: 0, jobCalls: 0, closes: 1, timerActive: false });
  });

  it('視窗清單改變後仍清理原 renderer，不在新視窗操作', async () => {
    const diagnostic = await watcher();
    diagnostic.replaceMainWindow();
    await diagnostic.stop();
    expect(diagnostic.replacementCalls).toEqual([]);
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
  });

  it.each(['SIGINT', 'SIGTERM'])('%s 等待 pending READ 後只清自己的探針，不增加掃描', async signal => {
    const diagnostic = await watcher({ keepOtherProbe: true });
    diagnostic.hold();
    const pending = diagnostic.tick();
    diagnostic.cliProcess.emit(signal);
    await diagnostic.tick();
    expect(diagnostic.stats()).toMatchObject({ reads: 1, cpuCalls: 1, jobCalls: 0, closes: 0, timerActive: false });
    expect(diagnostic.pageTimers.size).toBe(2);
    diagnostic.release(); await pending; await diagnostic.done;
    expect(diagnostic.cliProcess.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(diagnostic.lines.filter(line => /\d+%/.test(line))).toEqual([]);
    expect(diagnostic.pageTimers.size).toBe(1);
    expect(diagnostic.listeners.size).toBe(1);
    expect(diagnostic.page.window.__inp).toEqual(['other-input-probe']);
    expect(diagnostic.page.window.__lagSum_cpu_other).toBe(0);
    expect(diagnostic.host.__subtoolCpuDiagnostics).toBeUndefined();
    expect(diagnostic.cliProcess.eventNames()).toEqual([]);
    expect(diagnostic.stats().closes).toBe(1);
  });

  it.each(['invalid JSON', '{}', '{"lag":-1,"vis":"visible","focus":true}'])('回覆 %s 失敗時不假報 0 ms，停止並清理', async reply => {
    const diagnostic = await watcher();
    diagnostic.invalidReply(reply);
    await diagnostic.tick(); await diagnostic.done;
    expect(diagnostic.lines.filter(line => /\d+%/.test(line))).toEqual([]);
    expect(diagnostic.stats()).toMatchObject({ cpuCalls: 1, jobCalls: 0, closes: 1, timerActive: false });
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
    expect(diagnostic.cliProcess.exitCode).toBe(1);
    expect(diagnostic.errors.join('\n')).toContain('失敗:');
  });

  it('READ 拒絕後不留下 timer 或連線', async () => {
    const diagnostic = await watcher();
    diagnostic.rejectRead();
    await diagnostic.tick(); await diagnostic.done;
    expect(diagnostic.errors.join('\n')).toContain('renderer read failed');
    expect(diagnostic.lines.filter(line => /\d+%/.test(line))).toEqual([]);
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
    expect(diagnostic.stats().closes).toBe(1);
  });

  it('啟動已生效但回覆遺失仍清理原 renderer', async () => {
    const diagnostic = await watcher({ failStart: true });
    await diagnostic.done;
    expect(diagnostic.errors.join('\n')).toContain('start reply lost');
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
    expect(diagnostic.stats()).toMatchObject({ cpuCalls: 0, jobCalls: 0, closes: 1, timerActive: false });
  });

  it('清理回覆遺失會重試且保留取消碼', async () => {
    const diagnostic = await watcher();
    diagnostic.loseCleanupReply();
    await diagnostic.stop();
    expect(diagnostic.cliProcess.exitCode).toBe(130);
    expect(diagnostic.errors).toEqual([]);
    expect(diagnostic.pageTimers.size + diagnostic.listeners.size).toBe(0);
    expect(diagnostic.host.__subtoolCpuDiagnostics).toBeUndefined();
  });
});

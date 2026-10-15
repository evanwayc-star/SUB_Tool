import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/diagnostics/watch-cpu-and-lag.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { rendererLagProbe } = require('../scripts/diagnostics/renderer-lag-probe.js');

// 執行真正的診斷入口；只替換累計 CPU provider、inspector 與 host timer seam。
async function watcher() {
  let now = 0, wallTime = 0, cpu = { app: 0, ffmpeg: 0 }, tick;
  const lines = [];
  class Client {
    async connect() {}
    async evaluate(code) {
      return code.includes('winVisible')
        ? JSON.stringify({ lag: 0, vis: 'visible', focus: true, winMin: false })
        : true;
    }
  }
  class WallDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wallTime])); }
    static now() { return wallTime; }
  }
  const context = {
    require(name) {
      if (name === 'child_process') return {
        execFileSync: (_, args) => args[2].includes('Get-Process |')
          ? `10|electron|${cpu.app}\n12|ffmpeg|${cpu.ffmpeg}` : '',
      };
      if (name === 'os') return { cpus: () => [{}, {}] };
      if (name === 'perf_hooks') return { performance: { now: () => now } };
      if (name.includes('cdp-electron-harness')) return {
        CdpClient: Client, getJSON: async () => [{ webSocketDebuggerUrl: 'fixture' }],
      };
      return { rendererLagProbe };
    },
    Date: WallDate,
    process: {
      argv: ['node', 'fixture', '42'], _debugProcess: () => {},
      stdout: { write: () => {} }, exit: () => { throw new Error('Diagnostic failed'); },
    },
    console: { log: value => lines.push(value), error: value => { throw new Error(String(value)); } },
    setTimeout: callback => { callback(); return 1; },
    setInterval: callback => { tick = callback; return 1; },
  };
  await vm.runInNewContext(source, context);
  expect(typeof tick).toBe('function');
  return {
    async sample(time, counters, wallJump = 0) {
      wallTime += time - now + wallJump; now = time; cpu = counters;
      const start = lines.length; await tick();
      const row = lines.slice(start).find(line => /\d+%/.test(line));
      const [, total, ffmpeg] = /(\d+)%\s+(\d+)%/.exec(row);
      return { total: Number(total), ffmpeg: Number(ffmpeg) };
    },
  };
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
});

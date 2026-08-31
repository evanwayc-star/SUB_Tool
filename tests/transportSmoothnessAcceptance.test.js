import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { assertSmooth, killTree } = require('../scripts/acceptance/verify-transport-smoothness.js');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cadence(rate, direction) {
  return {
    progressFrames: 40,
    signedAverageRate: direction * rate,
    averageRate: rate,
    p95GapMs: 50,
    maxGapMs: 60,
    p95StepSeconds: 0.04,
    maxSeekBarDriftSeconds: 0,
    maxTimelineDriftSeconds: 0,
  };
}

function stepSamples(target) {
  return Array.from({ length: 6 }, () => ({
    latencyMs: 10,
    target,
    result: { status: 'presented', presentedTime: target },
    display: target,
    domPlayhead: target,
    timelinePlayhead: target,
    presented: target,
  }));
}

function validResult() {
  const fps = 24;
  const frame = 1 / fps;
  const base = 10;
  const requested = base + frame;
  const issued = [
    { inputId: 1, direction: 1, target: base + frame },
    { inputId: 2, direction: 1, target: base + 2 * frame },
    { inputId: 3, direction: -1, target: requested },
  ];
  const records = issued.map(input => ({
    ...input,
    latencyMs: 10,
    result: {
      status: input.inputId === 3 ? 'presented' : 'superseded',
      presentedTime: requested,
    },
    display: requested,
    domPlayhead: requested,
    timelinePlayhead: requested,
    presented: requested,
  }));
  const stepTrace = stepSamples(requested);
  return {
    info: { fps },
    forward1x: cadence(1, 1),
    fastForward2x: cadence(2, 1),
    fastForward4x: cadence(4, 1),
    reverse1x: cadence(1, -1),
    reverse4x: cadence(4, -1),
    stepForward: { samples: 6, p95Ms: 10, maxMs: 10, trace: stepTrace },
    stepBackward: { samples: 6, p95Ms: 10, maxMs: 10, trace: stepTrace },
    rapidStepPatterns: [{
      label: '快速右右左',
      directions: [1, 1, -1],
      netFrames: 1,
      before: { display: base },
      requested,
      display: requested,
      presented: requested,
      domPlayhead: requested,
      timelinePlayhead: requested,
      totalLatencyMs: 30,
      issued,
      records,
    }],
  };
}

describe('播放平滑度真機驗收規則', () => {
  it('接受逐鍵目標與延遲都合格的快速逐格', () => {
    expect(assertSmooth(validResult())).toEqual([]);
  });

  it('抓出中間按鍵沿用舊播放點的累積目標錯誤', () => {
    const result = validResult();
    result.rapidStepPatterns[0].issued[1].target = result.rapidStepPatterns[0].issued[0].target;
    expect(assertSmooth(result)).toContain('快速右右左 第 2 鍵累積目標錯誤');
  });

  it('拒絕總延遲或任一請求達到 500ms', () => {
    const result = validResult();
    result.rapidStepPatterns[0].totalLatencyMs = 500;
    result.rapidStepPatterns[0].records[0].latencyMs = 500;
    expect(assertSmooth(result)).toEqual(expect.arrayContaining([
      '快速右右左 總延遲過高：500ms',
      '快速右右左 有單鍵延遲達 500ms',
    ]));
  });

  it('只接受最後 inputId 的呈現證據', () => {
    const result = validResult();
    const pattern = result.rapidStepPatterns[0];
    pattern.records[0] = {
      ...pattern.records[0],
      target: pattern.requested,
      result: { status: 'presented', presentedTime: pattern.requested },
    };
    pattern.records[2].result.status = 'superseded';
    expect(assertSmooth(result)).toContain('快速右右左 最新目標沒有實際呈現證據');
  });

  it.skipIf(process.platform !== 'win32')('Electron 父行程先退出後仍會清除測試孤兒行程', async () => {
    const parent = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'console.log(child.pid);',
      'child.unref();',
    ].join(' ')], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    parent.stdout.on('data', chunk => { output += chunk; });
    let orphanPid = null;
    try {
      await once(parent, 'close');
      orphanPid = Number(output.trim());
      expect(parent.exitCode).toBe(0);
      expect(Number.isSafeInteger(orphanPid)).toBe(true);
      expect(processExists(orphanPid)).toBe(true);

      killTree(parent);
      const deadline = Date.now() + 5000;
      while (processExists(orphanPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(processExists(orphanPid)).toBe(false);
    } finally {
      if (Number.isSafeInteger(orphanPid) && processExists(orphanPid)) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(orphanPid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {}
      }
    }
  }, 10000);
});

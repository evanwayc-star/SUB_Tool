// @subtool-ci windows
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { captureDocumentationWorkspace } = require('../scripts/acceptance/capture-documentation-workspace.js');
const { ROOT, ELECTRON, delay, waitFor, verifiedCleanup } = require('../scripts/acceptance/cdp-electron-harness.js');
const canRun = process.platform === 'win32' && existsSync(ELECTRON);

// The Windows project serializes desktop tests after portable tests. Build the
// current source here as npm test may run before npm run build; stale dist must
// not make a renderer/CSS regression pass. CI uses the same Windows grouping.
beforeAll(() => {
  if (!canRun) return;
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT, windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });
});

// Serialized into the real Chromium renderer. The zero-gain destination keeps
// the test inaudible while the analyser receives actual oscillator PCM.
async function prepareMeter() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = 1000;
  const input = ctx.createGain(); input.gain.value = 0;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  const silent = ctx.createGain(); silent.gain.value = 0;
  oscillator.connect(input); input.connect(analyser);
  analyser.connect(silent); silent.connect(ctx.destination);
  const track = {
    analyser, audioSourceId: 'meter-source', source: 'meter-source',
    sourceStream: 0, sourceChannel: 0, name: 'Meter test tone',
    volume: 1, muted: false, solo: false,
  };
  SUB.State.audioProject = {
    buses: [{ id: 'meter-bus', name: 'Meter acceptance', volume: 1, muted: false, solo: false, pan: 0 }],
    sourceMaps: {
      'meter-source': { channels: [
        { sourceStream: 0, sourceChannel: 0, enabled: true, gain: 1, busIds: ['meter-bus'] },
      ] },
    },
    exportLayout: { streams: [] },
  };
  SUB.Media.tracks = [track];
  window.meterAcceptance = { ctx, oscillator, input, analyser, silent };
  oscillator.start(); await ctx.resume();
  document.querySelector('[data-act="mixer"]').click();
  return { state: ctx.state, routes: SUB.Media.routedTrackStatesForBus('meter-bus').length };
}

function measureMeter() {
  const strip = document.querySelector('.mx-strip');
  const meter = strip.querySelector('.mx-channel-meter').getBoundingClientRect();
  const mask = strip.querySelector('.mx-mask').getBoundingClientRect();
  const samples = new Float32Array(meterAcceptance.analyser.fftSize);
  meterAcceptance.analyser.getFloatTimeDomainData(samples);
  const style = getComputedStyle(document.getElementById('mixerPanel'));
  return {
    readout: strip.querySelector('.mx-meter-val').textContent,
    pcmPeak: Math.max(...samples.map(Math.abs)),
    height: meter.height, width: meter.width, top: meter.top,
    maskHeight: mask.height, barTop: mask.bottom,
    visible: style.display !== 'none' && style.visibility !== 'hidden',
    contextState: meterAcceptance.ctx.state,
    ticks: [...strip.querySelectorAll('.mx-meter-scale span')].map(element => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent, y: rect.y + rect.height / 2 };
    }),
  };
}

it.skipIf(!canRun)('真實 PCM 的音量變化、數字讀數、音柱與 dB 刻度一致，停止後回到表底', async () => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-meter-native-'));
  const readings = [];
  try {
    await captureDocumentationWorkspace(path.join(directory, 'meter.png'), async client => {
      const prepared = await client.evaluate(`(${prepareMeter.toString()})()`);
      try {
        expect(prepared).toEqual({ state: 'running', routes: 1 });
        for (const db of [-30, -12, -6, -3]) {
          await client.evaluate(`meterAcceptance.input.gain.value = Math.pow(10, ${db} / 20)`);
          await delay(250);
          const reading = await client.evaluate(`(${measureMeter.toString()})()`);
          readings.push(reading);
          expect(reading.contextState).toBe('running');
          expect(reading.visible).toBe(true);
          expect(reading.height).toBeGreaterThan(100);
          expect(reading.width).toBeGreaterThan(0);
          expect(20 * Math.log10(reading.pcmPeak)).toBeCloseTo(db, 1);
          expect(Number(reading.readout)).toBeCloseTo(db, 1);

          // Require the labels first: deleting a mismatched tick must not turn
          // this into a passing test. -30 is midway between -24 and -36.
          expect(reading.ticks.map(tick => tick.text)).toEqual([
            '0', '-3', '-6', '-12', '-24', '-36', '-48', '-60',
          ]);
          const tickY = value => reading.ticks.find(tick => Number(tick.text) === value).y;
          const targetY = db === -30 ? (tickY(-24) + tickY(-36)) / 2 : tickY(db);
          expect(Math.abs(reading.barTop - targetY), `${db} dBFS 音柱須對齊相同刻度`).toBeLessThan(5);
          if (readings.length > 1) {
            expect(reading.maskHeight).toBeLessThan(readings.at(-2).maskHeight - 1);
          }
        }

        await client.evaluate('meterAcceptance.oscillator.stop()');
        const stopped = await waitFor(async () => {
          const reading = await client.evaluate(`(${measureMeter.toString()})()`);
          return reading.readout === '-∞' && reading.maskHeight >= reading.height - 0.5 ? reading : null;
        }, '停止訊號後數字與音柱都回到表底', 5000);
        expect(stopped.pcmPeak).toBe(0);
        expect(stopped.maskHeight).toBeCloseTo(stopped.height, 0);
      } finally {
        await client.evaluate('(async () => { await meterAcceptance.ctx.close(); })()');
      }
    });
  } finally {
    verifiedCleanup(directory, 'subtool-meter-native-', { maxRetries: 20, retryDelay: 100 });
  }
}, 30000);

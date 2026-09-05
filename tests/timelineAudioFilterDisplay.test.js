// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { paintClipWave } from '../src/timeline-renderer.js';
import { Wave } from '../src/waveform-decoder.js';

describe('時間軸音訊濾鏡標記與波形圖繪製', () => {
  it('paintClipWave 在未套用濾鏡時使用標準色與寬度', () => {
    const strokeStyleHistory = [];
    const lineWidthHistory = [];
    const mockCtx = {
      save: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      restore: vi.fn(),
      set strokeStyle(val) { strokeStyleHistory.push(val); },
      set lineWidth(val) { lineWidthHistory.push(val); },
    };

    const displayList = {
      Hpx: 40,
      cvw: 10,
      res: 100,
      n: 5,
      pk: new Float32Array([-0.5, 0.5, -0.6, 0.6, -0.4, 0.4, -0.2, 0.2, -0.1, 0.1]),
      dpr: 1,
      timeToXMap: new Float64Array([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1]),
      hasLimiter: false,
    };

    paintClipWave(mockCtx, displayList);

    expect(strokeStyleHistory).toContain('rgba(190,230,255,.5)');
    expect(lineWidthHistory).toContain(1);
    expect(mockCtx.stroke).toHaveBeenCalled();
  });

  it('paintClipWave 在套用平衡化濾鏡時使用亮紫藍光澤色與加粗筆觸', () => {
    const strokeStyleHistory = [];
    const lineWidthHistory = [];
    const drawnCoords = [];

    const mockCtx = {
      save: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn((x, y) => drawnCoords.push({ type: 'move', x, y })),
      lineTo: vi.fn((x, y) => drawnCoords.push({ type: 'line', x, y })),
      stroke: vi.fn(),
      restore: vi.fn(),
      set strokeStyle(val) { strokeStyleHistory.push(val); },
      set lineWidth(val) { lineWidthHistory.push(val); },
    };

    // 模擬平衡化後的波形（最大峰值被削平至 0.5，即 -6dB）
    const displayList = {
      Hpx: 40,
      cvw: 3,
      res: 100,
      n: 3,
      pk: new Float32Array([-0.5, 0.5, -0.5, 0.5, -0.5, 0.5]),
      dpr: 1,
      timeToXMap: new Float64Array([0, 0.01, 0.02, 0.03]),
      hasLimiter: true,
    };

    paintClipWave(mockCtx, displayList);

    expect(strokeStyleHistory).toContain('rgba(165,180,252,0.95)');
    expect(lineWidthHistory).toContain(1.2);
    expect(drawnCoords.length).toBeGreaterThan(0);

    // 驗證 mid=20, amp=48 (40*1.2), mx=0.5 -> y = 20 - 0.5*48 = -4
    const firstMove = drawnCoords.find(c => c.type === 'move');
    expect(firstMove).toBeDefined();
    expect(firstMove.y).toBeCloseTo(20 - 0.5 * 48);
  });

  it('Wave.calcFromWav 正確解析 PCM 16-bit WAV 並計算波形 peaks', () => {
    // 構造標準 PCM 16-bit 單聲道 WAV 緩衝區
    const sampleRate = 44100;
    const numSamples = 4410; // 0.1 秒
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF 標頭
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    // fmt subchunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
    view.setUint16(22, 1, true); // NumChannels (1)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    // data subchunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, dataSize, true);

    // 寫入方波 samples（振幅 16384，即 0.5 / -6dB）
    const int16 = new Int16Array(buffer, 44, numSamples);
    for (let i = 0; i < numSamples; i++) {
      int16[i] = (i % 2 === 0) ? 16384 : -16384;
    }

    const peaks = Wave.calcFromWav(buffer);
    expect(peaks).toBeInstanceOf(Float32Array);
    expect(peaks.length).toBeGreaterThan(0);

    // 驗證計算出的峰值不超過 0.5（-6dB 平衡化後的特徵）
    for (let i = 0; i < peaks.length; i += 2) {
      expect(peaks[i]).toBeCloseTo(-0.5, 1);
      expect(peaks[i + 1]).toBeCloseTo(0.5, 1);
    }
  });

  it('resolveAudioTargets 能夠完整解析包含 asset、clip 與 target 物件的所有目標', async () => {
    const { resolveAudioTargets } = await import('../src/audio-normalizer-dialog.js');
    const mockAsset = { id: 'audio-1', path: 'c:/test/audio.mp3', hasAudioLimiter: false };
    const mockAudioSource = {
      id: 'audio-1',
      path: 'c:/test/audio.mp3',
      name: '語音錄音',
      asset: mockAsset,
    };

    const targets = resolveAudioTargets(mockAudioSource);
    expect(targets).toBeInstanceOf(Array);
    expect(targets).toContain(mockAsset);
    expect(targets.some(t => t.id === 'audio-1')).toBe(true);
  });

  it('paintClipBlocks 能夠正確標記正在運算 (⏳) 與已套用 (🎚) 之視覺狀態', async () => {
    const { paintClipBlocks } = await import('../src/timeline-renderer.js');
    const container = document.createElement('div');
    const displayList = {
      rows: [{ vtrack: 0, top: 0, height: 40, visible: true }],
      clips: [
        {
          id: 'c1',
          vtrack: 0,
          x: 0,
          w: 100,
          escapedName: '正常片段',
          hasAudioLimiter: false,
          audioNormalizing: false,
        },
        {
          id: 'c2',
          vtrack: 0,
          x: 120,
          w: 100,
          escapedName: '處理中片段',
          hasAudioLimiter: false,
          audioNormalizing: true,
        },
        {
          id: 'c3',
          vtrack: 0,
          x: 240,
          w: 100,
          escapedName: '已平衡片段',
          hasAudioLimiter: true,
          audioNormalizing: false,
        },
      ],
    };

    paintClipBlocks(container, displayList);
    const labels = container.querySelectorAll('.clip-label');
    expect(labels.length).toBe(3);
    expect(labels[0].textContent).not.toContain('⏳');
    expect(labels[0].textContent).not.toContain('🎚');
    expect(labels[1].textContent).toContain('⏳');
    expect(labels[2].textContent).toContain('🎚');
  });

  it('驗證 CSS 中 .audio-clip-block.has-limiter 包含淺紫色背景色調', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cssPath = path.resolve(__dirname, '../src/styles.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // 驗證 .audio-clip-block.has-limiter 包含淺紫色漸層 (rgba 168, 85, 247 等)
    expect(cssContent).toMatch(/\.audio-clip-block\.has-limiter\s*\{[^}]*background:\s*linear-gradient\([^}]*168,\s*85,\s*247/);
    expect(cssContent).toMatch(/\.audio-clip-block\.has-limiter\s*\{[^}]*border:\s*1\.5px\s+solid\s+#c084fc/);
  });
});



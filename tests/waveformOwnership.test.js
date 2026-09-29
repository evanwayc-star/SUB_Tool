import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({ fileURL: vi.fn() }));
vi.mock('../src/state.js', () => ({ State: { audioProject: { sourceMaps: {} } }, DESK: desktop }));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/util.js', () => ({ readFile: vi.fn() }));
vi.mock('../src/audio-engine.js', () => ({ AudioEngine: { isReady: true } }));
vi.mock('../src/audio-routing-engine.js', () => ({ AudioPipeline: {} }));
vi.mock('../src/media.js', () => ({ Media: { tracks: [], activeSource: null } }));
vi.mock('../src/dom.js', () => ({ $: vi.fn(), video: {} }));
vi.mock('../src/ui.js', () => ({ setStatus: vi.fn() }));

import { Wave } from '../src/waveform-decoder.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  Wave.clearSources();
  Wave.peaks = null;
  desktop.fileURL.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('同一來源的波形檔更換後，舊解碼晚到不會污染新檔且新解碼仍可開始', async () => {
  const oldUrl = deferred();
  const peaks = new Float32Array([-0.5, 0.5]);
  desktop.fileURL.mockReturnValueOnce(oldUrl.promise).mockResolvedValueOnce('file:///B.wav');
  const fetch = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(Wave, 'calcFromWav').mockReturnValue(peaks);

  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'A.wav' }] });
  const oldLoad = Wave.loadSourceWaveform('source-1', '0:0');
  // Re-registering the same file must retain the in-flight request.
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'A.wav' }] });
  const sameLoad = Wave.loadSourceWaveform('source-1', '0:0');
  expect(desktop.fileURL).toHaveBeenCalledTimes(1);
  Wave.registerSourceWaveforms('source-1', { channels: [{ sourceChannel: 0, file: 'B.wav' }] });
  oldUrl.resolve('file:///A.wav');
  expect(await oldLoad).toBeNull();
  expect(await sameLoad).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  expect(await Wave.loadSourceWaveform('source-1', '0:0')).toBe(peaks);
  expect(desktop.fileURL.mock.calls.map(([path]) => path)).toEqual(['A.wav', 'B.wav']);
  expect(Wave.getSourceWaveform('source-1').peaks).toBeNull();
  Wave.setSourceWaveSelection('source-1', '0:0');
  expect(Wave.getSourceWaveform('source-1').peaks).toBe(peaks);
});

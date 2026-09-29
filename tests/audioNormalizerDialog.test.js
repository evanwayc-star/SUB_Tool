// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => {
  document.body.innerHTML = '<div id="modalBody"></div>';
  const pending = [];
  window.subtool = {
    normalizeAudio: () => {},
    analyzeAudioLoudness: (path) => new Promise(resolve => pending.push({ path, resolve })),
  };
  return pending;
});

vi.mock('../src/media.js', () => ({
  Media: { audioEffects: { targets: source => [source] } },
  Wave: { peaks: null },
}));
vi.mock('../src/state.js', () => ({ IS_DESKTOP: true }));
vi.mock('../src/ui.js', () => ({
  openModal: (title, html) => { document.getElementById('modalBody').innerHTML = html; },
  closeModal: () => {},
  showToast: () => {},
}));

import { openHardLimiterDialog } from '../src/audio-normalizer-dialog.js';

beforeEach(() => {
  requests.length = 0;
  document.getElementById('modalBody').innerHTML = '';
});

it('舊來源的聲量分析晚到時不覆寫後開啟的音訊效果面板', async () => {
  openHardLimiterDialog({ id: 'a', path: 'C:/a.wav', name: 'A' });
  openHardLimiterDialog({ id: 'b', path: 'C:/b.wav', name: 'B' });
  expect(requests.map(request => request.path)).toEqual(['C:/a.wav', 'C:/b.wav']);

  requests[1].resolve({ maxDb: -2, meanDb: -14, minDb: -28, dynamicRangeDb: 12 });
  await Promise.resolve();
  expect(document.getElementById('hlAnalyzedMax').textContent).toBe('-2 dB');

  requests[0].resolve({ maxDb: -40, meanDb: -50, minDb: -60, dynamicRangeDb: 20 });
  await Promise.resolve();
  expect(document.getElementById('hlAnalyzedMax').textContent).toBe('-2 dB');
  expect(document.getElementById('hlAnalyzedMean').textContent).toBe('-14 dB');
});

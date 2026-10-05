// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => {
  document.body.innerHTML = '<div id="modalBody"></div>';
  const pending = [];
  window.subtool = {
    normalizeAudio: () => {},
    analyzeAudioLoudness: (path) => new Promise((resolve,reject) => pending.push({ path, resolve,reject })),
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

it('量測失敗保留快速預覽，不誤顯示精準綠色或無聲',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    openHardLimiterDialog({id:'a',path:'C:/a.wav',name:'A',peaks:new Float32Array([0.5,0.25])});
    const previous=document.getElementById('hlAnalyzedMax').textContent;
    requests[0].reject(new Error('ffmpeg decoding failed'));
    await Promise.resolve();await Promise.resolve();
    expect(document.getElementById('hlAnalyzedMax').textContent).toBe(previous);
    expect(document.getElementById('hlAnalysisStatus').textContent).toContain('量測失敗');
    expect(document.getElementById('hlAnalysisStatus').textContent).toContain('保留快速預覽');
    expect(document.getElementById('hlAnalysisStatus').title).toBe('ffmpeg decoding failed');
  }finally{warn.mockRestore();}
});

it('舊量測失敗不寫入新面板的成功狀態',async()=>{
  openHardLimiterDialog({id:'a',path:'C:/a.wav'});
  openHardLimiterDialog({id:'b',path:'C:/b.wav'});
  requests[1].resolve({maxDb:-2,meanDb:-14,minDb:-28,dynamicRangeDb:12});
  await Promise.resolve();
  requests[0].reject(new Error('old request failed'));
  await Promise.resolve();await Promise.resolve();
  expect(document.getElementById('hlAnalysisStatus').textContent).toContain('精準量測');
  expect(document.getElementById('hlAnalyzedMax').textContent).toBe('-2 dB');
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

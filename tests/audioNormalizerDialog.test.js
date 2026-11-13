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
const modal = vi.hoisted(()=>({generation:0,session:null}));

vi.mock('../src/media.js', () => ({
  Media: { audioEffects: { targets: source => [source] } },
  Wave: { peaks: null },
}));
vi.mock('../src/state.js', () => ({ IS_DESKTOP: true }));
vi.mock('../src/ui.js', () => ({renderCurrentTimecode:vi.fn(),
  openModal: (title, html) => {
    document.getElementById('modalBody').innerHTML = html;
    const owner=++modal.generation;
    return modal.session={isCurrent:()=>modal.generation===owner,close:()=>{if(modal.generation===owner)modal.generation++;}};
  },
  closeModal: () => {},
  showToast: () => {},
}));

import { openHardLimiterDialog } from '../src/audio-normalizer-dialog.js';

beforeEach(() => {
  requests.length = 0;
  modal.generation++;
  document.getElementById('modalBody').innerHTML = '';
});

it('真峰值與一般峰值切換時，單位與目前增益說明跟隨真正處理模式', () => {
  openHardLimiterDialog({ id:'a', path:'C:/a.wav' });
  expect(document.getElementById('hlTargetLabel').textContent).toBe('目標整體響度：');
  expect(document.getElementById('hlTargetUnit').textContent).toBe('LUFS');
  expect(document.getElementById('hlPeakUnit').textContent).toBe('dBTP');
  expect(document.getElementById('hlStatusDesc').textContent).toContain('-12 LUFS');
  expect(document.getElementById('hlMinAmp').getAttribute('aria-label')).toContain('LUFS');

  const peak=document.getElementById('hlPeakRadio');peak.checked=true;peak.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlTargetLabel').textContent).toBe('增益計算基準：');
  expect(document.getElementById('hlTargetUnit').textContent).toBe('dB');
  expect(document.getElementById('hlPeakUnit').textContent).toBe('dBFS');
  expect(document.getElementById('hlModeHelp').textContent).toContain('不進行響度標準化');
  expect(document.getElementById('hlStatusDesc').textContent).toContain('輸入增益 +6 dB');
  const target=document.getElementById('hlMinAmpNum');target.value='-18';target.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusDesc').textContent).toContain('輸入增益 +12 dB');
  expect(document.getElementById('hlMinAmp').value).toBe('-18');

  const truePeak=document.getElementById('hlTruePeakRadio');truePeak.checked=true;truePeak.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlTargetUnit').textContent).toBe('LUFS');
  expect(document.getElementById('hlModeHelp').textContent).toContain('優先遵守峰值上限');
  expect(document.getElementById('hlStatusDesc').textContent).toContain('-18 LUFS');
});

it('已有效果的未套用數值不冒充已生效，回到原設定才恢復已生效', () => {
  const source={id:'a',path:'C:/a.wav',hasAudioLimiter:true,audioLimiterSpec:{max:-6,min:-12,inputBoost:6,isTruePeak:true}};
  openHardLimiterDialog(source);
  expect(document.getElementById('hlStatusBadge').textContent).toBe('已生效');
  const target=document.getElementById('hlMinAmpNum');target.value='-18';target.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusBadge').textContent).toBe('未套用');
  expect(document.getElementById('hlStatusTitle').textContent).toContain('待套用變更');
  expect(document.getElementById('hlStatusDesc').textContent).toMatch(/^套用後：/);
  expect(source.audioLimiterSpec.min).toBe(-12);
  target.value='-12';target.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusBadge').textContent).toBe('已生效');
  const peak=document.getElementById('hlPeakRadio');peak.checked=true;peak.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusBadge').textContent).toBe('未套用');
  const toggle=document.getElementById('hlToggleEnable');toggle.checked=false;toggle.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusBadge').textContent).toBe('準備關閉');
  toggle.checked=true;toggle.dispatchEvent(new Event('change'));
  expect(document.getElementById('hlStatusBadge').textContent).toBe('未套用');
});

it('對話框關閉後，晚到聲量分析不得修改仍連接的隱藏面板',async()=>{
  openHardLimiterDialog({id:'a',path:'C:/a.wav'});
  const panel=document.querySelector('.hard-limiter-panel');
  const before=panel.querySelector('#hlAnalysisStatus').textContent;
  modal.session.close();
  expect(panel.isConnected).toBe(true);
  requests[0].resolve({maxDb:-2,meanDb:-14,minDb:-28,dynamicRangeDb:12});
  await Promise.resolve();
  expect(panel.querySelector('#hlAnalysisStatus').textContent).toBe(before);
});

it('來源在量測期間改變時，不把舊來源量測顯示為新來源的精準結果',async()=>{
  const source={id:'a',path:'C:/original.wav'};
  openHardLimiterDialog(source);
  source.path='C:/replacement.wav';
  requests[0].resolve({maxDb:-2,meanDb:-14,minDb:-28,dynamicRangeDb:12});
  await Promise.resolve();
  expect(document.getElementById('hlAnalysisStatus').textContent).toContain('來源已變更');
  expect(document.getElementById('hlAnalyzedMax').textContent).not.toBe('-2 dB');
});

it('短音訊的平均 RMS 不誤標為 ITU 精準量測', async () => {
  openHardLimiterDialog({ id: 'a', path: 'C:/a.wav' });
  requests[0].resolve({ maxDb: 0, meanDb: -3, minDb: -70, dynamicRangeDb: 0, meanSource: 'volumedetect' });
  await Promise.resolve();
  expect(document.getElementById('hlAnalysisStatus').textContent).toContain('RMS');
  expect(document.getElementById('hlAnalysisStatus').textContent).not.toContain('ITU');
  expect(document.getElementById('hlAnalyzedMean').textContent).toBe('-3 dB');
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

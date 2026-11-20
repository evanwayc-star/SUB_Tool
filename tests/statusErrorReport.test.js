// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';

beforeEach(()=>{
  vi.resetModules();
  document.body.innerHTML=readFileSync('index.html','utf8');
});

it('records reported errors while the status is locked and after notifications disappear',async()=>{
  const {setStatus,showToast,openModal,closeModal}=await import('../src/ui.js');
  const {openStatusErrorReport}=await import('../src/status-error-report.js');
  openStatusErrorReport(openModal);
  expect(document.querySelector('#statusErrorList').textContent).toContain('尚未收到錯誤');
  closeModal();
  setStatus('輸出中','busy','lock');
  setStatus('影片載入失敗','err',false,'mpv 回報 <unknown> & I/O error');
  showToast('輸入檔案已移動','error');
  showToast('已儲存');setStatus('輸出完成','ok','unlock');
  expect(document.querySelector('#stMsg').textContent).toBe('輸出完成');
  const count=document.querySelector('#stErrorCount');
  expect(count.hidden).toBe(false);expect(count.textContent).toBe('2');
  openStatusErrorReport(openModal);
  const rows=[...document.querySelectorAll('#statusErrorList li')];
  expect(rows.map(row=>row.querySelector('strong').textContent)).toEqual(['輸入檔案已移動','影片載入失敗']);
  expect(rows[1].querySelector('p').textContent).toBe('mpv 回報 <unknown> & I/O error');
  expect(rows[1].querySelector('unknown')).toBeNull();
  expect(rows.every(row=>Number.isFinite(Date.parse(row.querySelector('time').dateTime)))).toBe(true);
});

it('retains the latest 100 reports and avoids recording the same background state on every render',async()=>{
  const {setMediaIntakeStatus,openModal}=await import('../src/ui.js');
  const {recordStatusError,openStatusErrorReport}=await import('../src/status-error-report.js');
  for(let i=1;i<=101;i++)recordStatusError('影片 '+i);
  setMediaIntakeStatus('音軌失敗','err','stream 2');
  setMediaIntakeStatus('音軌失敗','err','stream 2');
  openStatusErrorReport(openModal);
  const rows=[...document.querySelectorAll('#statusErrorList strong')].map(el=>el.textContent);
  expect(rows).toHaveLength(100);expect(rows.slice(0,2)).toEqual(['音軌失敗','影片 101']);
  expect(rows.at(-1)).toBe('影片 3');
});

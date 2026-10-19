// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/media.js',()=>({Media:{mpvMode:false}}));

let jobs,bindView,progress,setStatus,cancel,requests,resolve;
beforeEach(async()=>{
  vi.resetModules();
  document.body.innerHTML='<span id="stMsg"></span><span id="stDot"></span><span id="stMedia">movie.mxf</span><button id="stProxyCancelBtn"></button><button id="stStopBtn">停止匯出</button>';
  requests=[];
  window.subtool={isDesktop:true,ingest:vi.fn(options=>{requests.push(options);return new Promise(done=>{resolve=done;});}),cancelMediaIntake:vi.fn(async()=>1)};
  ({MediaIntakeJobs:jobs}=await import('../src/media-intake-jobs.js'));
  ({bindMediaIntakeView:bindView,handleMediaIntakeProgress:progress}=await import('../src/media-intake-view.js'));
  ({setStatus}=await import('../src/ui.js'));
  cancel=vi.fn(()=>jobs.reset());bindView(cancel);
});

it('shows a working Proxy cancellation button separately from the export stop control',async()=>{
  const exportStop=vi.fn();document.getElementById('stStopBtn').onclick=exportStop;
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
  const button=document.getElementById('stProxyCancelBtn');
  expect(getComputedStyle(button).display).not.toBe('none');
  expect(button.textContent).toBe('取消 Proxy');
  button.click();await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(window.subtool.cancelMediaIntake).toHaveBeenCalledWith({sessionId:requests[0].sessionId});
  expect(getComputedStyle(button).display).toBe('none');
  expect(document.getElementById('stMedia').style.display).toBe('');
  expect(exportStop).not.toHaveBeenCalled();
});

it('ignores old project progress and never unlocks or overwrites an active export status',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  setStatus('匯出 42%','busy','lock');
  expect(progress({...requests[0],jobId:'ingest-1',pct:70})).toBe(true);
  expect(document.getElementById('stMsg').textContent).toBe('匯出 42%');
  progress({...requests[0],jobId:'ingest-1',done:true,outcome:'success'});
  setStatus('background ready','ok');
  expect(document.getElementById('stMsg').textContent).toBe('匯出 42%');
  resolve({});await work;
  const old=requests[0];await jobs.reset();
  setStatus('new project ready','ok','unlock');
  expect(progress({...old,pct:80})).toBe(false);
  expect(document.getElementById('stMsg').textContent).toBe('new project ready');
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/media.js',()=>({Media:{mpvMode:false,playing:false,setRate:vi.fn(),
  play(){this.playing=true;},pause(){this.playing=false;}}}));

let jobs,bindView,progress,setStatus,cancel,requests,resolve;
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
  vi.resetModules();
  document.body.innerHTML='<video id="video"></video><span id="stMsg"></span><span id="stDot"></span><span id="stMedia">movie.mxf</span><div id="toast"></div><button id="stProxyCancelBtn"></button><button id="stStopBtn">停止匯出</button>';
  requests=[];
  window.subtool={isDesktop:true,ingest:vi.fn(options=>{requests.push(options);return new Promise(done=>{resolve=done;});}),cancelMediaIntake:vi.fn(async()=>1)};
  ({MediaIntakeJobs:jobs}=await import('../src/media-intake-jobs.js'));
  ({bindMediaIntakeView:bindView,handleMediaIntakeProgress:progress}=await import('../src/media-intake-view.js'));
  ({setStatus}=await import('../src/ui.js'));
  cancel=vi.fn(()=>jobs.reset());bindView(cancel);
});

it('原生終態通知同步換專案時不發布舊工作完成事件或覆蓋新狀態',async()=>{
  const {on}=await import('../src/events.js');
  const events=vi.spyOn(window,'dispatchEvent');
  const work=jobs.ingest({path:'old.mxf',needsProxy:true});
  const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
  let revoked=false;
  on('media:intakeJobs',state=>{
    if(!revoked&&state.count===0){
      revoked=true;
      void jobs.reset();
      setStatus('新專案已載入','ok');
    }
  });
  expect(progress({...requests[0],jobId:'ingest-old',done:true,outcome:'success',label:'舊轉檔'})).toBe(false);
  await rejected;
  expect(document.getElementById('stMsg').textContent).toBe('新專案已載入');
  expect(events.mock.calls.some(([event])=>event.type==='desk:ingest-done')).toBe(false);
  resolve({cached:true});
});

it('較早訂閱者同步換專案後，畫面不顯示外層通知中已失效的背景工作',async()=>{
  vi.resetModules();
  const {on}=await import('../src/events.js');
  let shouldReset=true;
  on('media:intakeJobs',state=>{
    if(shouldReset&&state.count){
      shouldReset=false;void jobs.reset();setStatus('新專案已載入','ok');
    }
  });
  ({MediaIntakeJobs:jobs}=await import('../src/media-intake-jobs.js'));
  ({bindMediaIntakeView:bindView}=await import('../src/media-intake-view.js'));
  ({setStatus}=await import('../src/ui.js'));
  bindView(()=>jobs.reset());
  const work=jobs.ingest({path:'old.mxf',needsProxy:true});
  await expect(work).rejects.toMatchObject({name:'AbortError'});
  expect(jobs.snapshot().count).toBe(0);
  expect(document.getElementById('stMsg').textContent).toBe('新專案已載入');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).toBe('none');
  expect(window.subtool.ingest).not.toHaveBeenCalled();
});

it('同專案同步新增第二份工作時，畫面以最新工作數呈現',async()=>{
  vi.resetModules();
  const pending=[];
  window.subtool.ingest=vi.fn(()=>new Promise(done=>pending.push(done)));
  const {on}=await import('../src/events.js');
  let next,spawnNext=true;
  on('media:intakeJobs',state=>{
    if(spawnNext&&state.count===1){spawnNext=false;next=jobs.ingest({path:'next.mxf'});}
  });
  ({MediaIntakeJobs:jobs}=await import('../src/media-intake-jobs.js'));
  ({bindMediaIntakeView:bindView}=await import('../src/media-intake-view.js'));
  bindView(()=>jobs.reset());
  const first=jobs.ingest({path:'first.mxf'});
  expect(jobs.snapshot().count).toBe(2);
  expect(document.getElementById('stMsg').textContent).toContain('另有 1 項背景工作');
  pending.forEach(done=>done({cached:true}));
  await Promise.all([first,next]);
});

it('播放及暫停的公開操作不覆蓋母素材驗證百分比',async()=>{
  const {togglePlayPause,shuttlePause}=await import('../src/transport-controller.js');
  const {Media}=await import('../src/media.js');
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37});
  const message=document.getElementById('stMsg').textContent;
  togglePlayPause();await Promise.resolve();await Promise.resolve();
  expect(Media.playing).toBe(true);
  expect(document.getElementById('stMsg').textContent).toBe(message);
  togglePlayPause();shuttlePause();
  expect(Media.playing).toBe(false);
  expect(document.getElementById('stMsg').textContent).toBe(message);
  resolve({});await work;
});

it('普通訊息不遮蓋工作進度，錯誤仍顯示且換專案會釋放進度',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37});
  setStatus('已載入專案','ok');
  expect(document.getElementById('stMsg').textContent).toContain('驗證母素材內容');
  setStatus('來源讀取失敗','err');
  expect(document.getElementById('stMsg').textContent).toBe('來源讀取失敗');
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:38});
  expect(document.getElementById('stMsg').textContent).toContain('38%');
  expect(document.getElementById('toast').textContent).toBe('來源讀取失敗');
  await jobs.reset();await rejected;
  setStatus('新專案已載入','ok');
  expect(document.getElementById('stMsg').textContent).toBe('新專案已載入');
  expect(progress({...requests[0],pct:90})).toBe(false);
});

it('無總量的快取檢查顯示階段，不偽造百分比',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'cache-check',label:'檢查 Proxy 與音訊快取',pct:null});
  expect(document.getElementById('stMsg').textContent).toBe('檢查 Proxy 與音訊快取…');
  resolve({});await work;
});

it('母素材驗證顯示已讀與總容量，無效容量與其他階段不顯示',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const verification={...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37,processedBytes:57831000000,totalBytes:156300000000};
  progress(verification);
  expect(document.getElementById('stMsg').textContent).toBe('驗證母素材內容… 37%（57.8 / 156.3 GB）');
  progress({...verification,processedBytes:500000,totalBytes:2000000,pct:25});
  expect(document.getElementById('stMsg').textContent).toBe('驗證母素材內容… 25%（0.5 / 2.0 MB）');
  for(const invalid of [{processedBytes:-1},{processedBytes:Infinity},{processedBytes:'123'},{totalBytes:0},{processedBytes:156300000001}]){
    progress({...verification,...invalid});
    expect(document.getElementById('stMsg').textContent).toBe('驗證母素材內容… 37%');
  }
  progress({...verification,stage:'transcoding',label:'轉檔 Proxy'});
  expect(document.getElementById('stMsg').textContent).toBe('轉檔 Proxy… 37%');
  resolve({});await work;
});

it('匯出結束立即恢復最新背景進度，轉換階段會重算剩餘時間',async()=>{
  let now=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:20});
  now=10000;
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:40});
  expect(document.getElementById('stMsg').textContent).toContain('已用 00:10 / 預估剩餘 00:15');
  setStatus('匯出 50%','busy','lock');
  progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:1});
  expect(document.getElementById('stMsg').textContent).toBe('匯出 50%');
  setStatus('匯出完成','ok','unlock');
  expect(document.getElementById('stMsg').textContent).toBe('轉檔 Proxy… 1%');
  resolve({});await work;
  expect(document.getElementById('stMsg').textContent).toBe('匯出完成');
});

it('一份工作完成仍顯示另一份工作進度，本機波形完成後釋放busy',async()=>{
  const first=jobs.ingest({path:'first.mxf',needsProxy:true}),resolveFirst=resolve;
  progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:80});
  let completeWave,report;
  const wave=jobs.prepareWaveform(control=>{report=control.report;return new Promise(done=>{completeWave=done;});});
  report({label:'讀取波形',pct:32});
  progress({...requests[0],done:true,outcome:'success',label:'轉檔 Proxy'});
  expect(document.getElementById('stMsg').textContent).toBe('讀取波形… 32%');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).not.toBe('none');
  completeWave();await wave;resolveFirst({});await first;
  expect(document.getElementById('stMsg').textContent).toBe('轉檔 Proxy完成');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).toBe('none');
  expect(report({label:'過期波形',pct:90})).toBe(false);
});

it('已開始的優先波形顯示在後來Proxy之前，排隊不遮住進度且完成後自動切回',async()=>{
  let finishWave,waveOptions;
  window.subtool.prepareSourceWaveform=vi.fn(options=>{waveOptions=options;return new Promise(done=>{finishWave=done;});});
  const wave=jobs.prepareSourceWaveform({path:'demo.mxf'});
  expect(document.getElementById('stMsg').textContent).toBe('等候優先產生波形…');
  const proxy=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:19});
  expect(document.getElementById('stMsg').textContent).toContain('驗證母素材內容… 19%');
  progress({...waveOptions,stage:'source-waveform',label:'優先產生波形',queued:false,pct:7});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:20});
  expect(document.getElementById('stMsg').textContent).toBe('7% 波形｜20% 驗證母素材');
  finishWave({wave:'source.wav'});await wave;
  expect(document.getElementById('stMsg').textContent).toBe('驗證母素材內容… 20%');
  const queued=jobs.prepareSourceWaveform({path:'next.mxf'});
  expect(document.getElementById('stMsg').textContent).toContain('驗證母素材內容… 20%');
  finishWave({wave:'next.wav'});await queued;
  resolve({});await proxy;
});

it.each([['source-verification','驗證母素材內容','驗證母素材'],['transcoding','轉檔 Proxy','Proxy 轉檔']])('波形與 %s 並行時各自顯示百分比且提供完整無障礙資訊',async(stage,label,short)=>{
  let report,finish;
  const wave=jobs.prepareWaveform(control=>{report=control.report;return new Promise(done=>{finish=done;});});
  const proxy=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage,label,pct:20});report({label:'優先產生波形',pct:7,overall:true});
  const message=document.getElementById('stMsg');
  expect(message.textContent).toContain('7% 波形');expect(message.textContent).toContain('20% '+short);
  expect(message.getAttribute('aria-label')).toContain('優先產生波形');
  expect(message.getAttribute('aria-label')).toContain(label);
  expect(message.title).toBe(message.getAttribute('aria-label'));
  expect([...message.children].map(child=>child.className)).toEqual(['status-pair-item','status-pair-separator','status-pair-item']);
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).not.toBe('none');
  setStatus('匯出 50%','busy','lock');expect(message.textContent).toBe('匯出 50%');expect(message.classList.contains('status-pair')).toBe(false);
  setStatus('匯出完成','ok','unlock');expect(message.textContent).toContain('20% '+short);expect(message.classList.contains('status-pair')).toBe(true);
  finish();await wave;resolve({});await proxy;
});

it('整體波形保持累積進度與ETA，分段完成不宣告整片或清掉外層工作',async()=>{
  let now=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const dispatched=vi.spyOn(window,'dispatchEvent');
  const chunks=[];
  window.subtool.prepareSourceWaveform=vi.fn(options=>new Promise(done=>chunks.push({options,done})));
  let report,finishOverall;
  const overall=jobs.prepareWaveform(control=>{
    report=control.report;report({label:'優先產生波形',pct:null,overall:true,queued:true});
    return new Promise(done=>{finishOverall=done;});
  });
  const proxy=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:3});
  expect(document.getElementById('stMsg').textContent).toContain('驗證母素材內容… 3%');
  const first=jobs.prepareSourceWaveform({path:'demo.mxf',start:0,length:60,duration:600});
  progress({...chunks[0].options,stage:'source-waveform',label:'優先產生波形',queued:false,pct:8});
  expect(document.getElementById('stMsg').textContent).toContain('8% 波形');
  expect(document.getElementById('stMsg').textContent).toContain('3% 驗證母素材');
  progress({...chunks[0].options,stage:'source-waveform',done:true,outcome:'success',pct:100});
  chunks[0].done({wave:'first.wav',start:0,duration:60});await first;
  report({label:'優先產生波形',pct:10,overall:true});
  const second=jobs.prepareSourceWaveform({path:'demo.mxf',start:60,length:60,duration:600});
  progress({...chunks[1].options,stage:'source-waveform',label:'優先產生波形',queued:false,pct:19});
  expect(document.getElementById('stMsg').textContent).toContain('10% 波形');
  now=4000;
  progress({...chunks[1].options,stage:'source-waveform',done:true,outcome:'success',pct:100});
  chunks[1].done({wave:'second.wav',start:60,duration:60});await second;
  report({label:'優先產生波形',pct:20,overall:true});
  expect(document.getElementById('stMsg').textContent).toContain('20% 波形');
  expect(document.getElementById('stMsg').getAttribute('aria-label')).toContain('20% [已用 00:04 / 預估剩餘 00:16]');
  expect(dispatched.mock.calls.some(([event])=>event.type==='desk:ingest-done')).toBe(false);
  expect(jobs.snapshot().count).toBe(2);
  finishOverall();await overall;
  expect(document.getElementById('stMsg').textContent).toMatch(/^驗證母素材內容… 3%/);
  resolve({});await proxy;
});

it('沒有背景工作時，播放暫停也保留最後一則有意義的資訊',async()=>{
  const {togglePlayPause}=await import('../src/transport-controller.js');
  setStatus('波形已就緒','ok');
  togglePlayPause();await Promise.resolve();await Promise.resolve();togglePlayPause();
  expect(document.getElementById('stMsg').textContent).toBe('波形已就緒');
});

it('截圖真正寫入後才顯示完成toast，並保留背景工作百分比',async()=>{
  const {State}=await import('../src/state.js');
  State.duration=5;State.mediaPath='C:/demo.mxf';
  const renderer=await import('../src/video-renderer.js');
  vi.spyOn(renderer,'capturePreviewFrame').mockResolvedValue({time:0,fps:25,canvas:{
    toBlob:callback=>callback(new Blob(['jpeg'],{type:'image/jpeg'})),
  }});
  let finishWrite;
  window.subtool.reserveScreenshotPath=vi.fn(async()=>({path:'C:/Shot-1.jpg',name:'Shot-1.jpg',token:'test-token'}));
  window.subtool.writeScreenshot=vi.fn(()=>new Promise(done=>{finishWrite=done;}));
  window.subtool.releaseScreenshotPath=vi.fn(async()=>{});
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:42});
  const {takeScreenshot}=await import('../src/commands.js');
  const screenshot=takeScreenshot();
  await vi.waitFor(()=>expect(window.subtool.writeScreenshot).toHaveBeenCalled());
  expect(window.subtool.writeScreenshot).toHaveBeenCalledWith('C:/Shot-1.jpg', expect.any(String), 'test-token');
  expect(document.getElementById('toast').textContent).not.toContain('截圖已儲存');
  finishWrite('C:/Shot-1.jpg');await screenshot;
  expect(window.subtool.releaseScreenshotPath).toHaveBeenCalledWith('C:/Shot-1.jpg', 'test-token');
  expect(document.getElementById('toast').textContent).toBe('截圖已儲存：Shot-1.jpg');
  expect(document.getElementById('toast').classList.contains('show')).toBe(true);
  expect(document.getElementById('stMsg').textContent).toBe('轉檔 Proxy… 42%');
  resolve({});await work;
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

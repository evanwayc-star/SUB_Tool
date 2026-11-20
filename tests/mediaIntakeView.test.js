// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/media.js',()=>({Media:{mpvMode:false,playing:false,setRate:vi.fn(),
  play(){this.playing=true;},pause(){this.playing=false;}}}));

let jobs,bindView,progress,setStatus,cancel,requests,resolve;
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
  vi.resetModules();
  const app=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html');
  document.body.innerHTML='<video id="video"></video><div id="toast"></div>';
  document.body.append(app.querySelector('.statusbar'));
  requests=[];
  window.subtool={isDesktop:true,ingest:vi.fn(options=>{requests.push(options);return new Promise(done=>{resolve=done;});}),cancelMediaIntake:vi.fn(async()=>1)};
  ({MediaIntakeJobs:jobs}=await import('../src/media-intake-jobs.js'));
  ({bindMediaIntakeView:bindView,handleMediaIntakeProgress:progress}=await import('../src/media-intake-view.js'));
  ({setStatus}=await import('../src/ui.js'));
  cancel=vi.fn(()=>jobs.reset());bindView(cancel);
});

it.each([false,true])('實際 Proxy 轉檔和停止操作顯示於錯誤按鈕前，左欄獨立顯示操作訊息（含音軌=%s）',async audio=>{
  setStatus('專案已儲存','ok');
  const work=jobs.ingest({path:'demo.mxf',duration:3600,needsProxy:true});
  progress({...requests[0],stage:'transcoding',label:'正在轉檔 Proxy 與分析音訊',pct:42,outputs:{proxy:true,audio}});
  const right=document.getElementById('stBackground');
  expect(right.nextElementSibling.id).toBe('stErrorsBtn');
  expect(right.querySelector('#stIntakeMsg').textContent).toContain('42%');
  expect(right.querySelector('#stIntakeMsg').textContent).toContain('Proxy 約 1.80 GB');
  expect(right.querySelector('#stProxy').hidden).toBe(true);
  expect(right.contains(document.getElementById('stProxyCancelBtn'))).toBe(true);
  expect(document.getElementById('stMsg').textContent).toBe('專案已儲存');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).not.toBe('none');
  progress({...requests[0],done:true,outcome:'success',label:'正在轉檔 Proxy',proxyReady:true,outputs:{proxy:true,audio}});
  resolve({proxy:'proxy.mp4'});await work;
  expect(document.getElementById('stMsg').textContent).toBe('專案已儲存');
  if(!audio)expect(right.querySelector('#stProxy').hidden).toBe(false);
});

it('直接波形進度只清理自己的訊息，受管進度接管後不會復活舊的顯示',async()=>{
  const {setMediaProcessingStatus}=await import('../src/ui.js');
  const message=document.getElementById('stIntakeMsg'),proxy=document.getElementById('stProxy');
  const clearFirst=setMediaProcessingStatus('第一軌波形','busy');
  const clearSecond=setMediaProcessingStatus('第二軌波形','busy');
  clearFirst();
  expect(message.textContent).toBe('第二軌波形');
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:42,outputs:{proxy:true,audio:false}});
  clearSecond();
  setMediaProcessingStatus('波形已就緒','ok');
  expect(message.textContent).toBe('轉檔 Proxy… 42%');
  expect(proxy.hidden).toBe(true);
  resolve({});await work;
  expect(message.hidden).toBe(true);
  expect(proxy.hidden).toBe(false);
});

it('音訊平衡進度與匯出、Proxy 可同時讀取，新工作不會被上一筆完成提示清除',async()=>{
  vi.useFakeTimers();
  try {
    const {emit}=await import('../src/events.js');
    const {bindAudioEffectStatusView}=await import('../src/ui.js');
    bindAudioEffectStatusView(vi.fn(),vi.fn());
    setStatus('正在匯出影片','busy','lock');
    const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
    progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:42,outputs:{proxy:true}});
    const status=document.getElementById('stAudioEffect');
    const busy={sourceId:'first',name:'電影',label:'分析響度',pct:28};
    emit('media:audioEffectStatus',{active:[busy]});
    expect(status?.hidden).toBe(false);
    expect(status.textContent).toMatch(/音訊平衡 28%.*分析響度/);
    expect(status.title).toContain('電影');
    expect(document.getElementById('stIntakeMsg').textContent).toContain('42%');
    expect(document.getElementById('stMsg').textContent).toBe('正在匯出影片');
    emit('media:audioEffectStatus',{active:[],result:{status:'completed',name:'電影'}});
    expect(status.textContent).toContain('已套用');
    emit('media:audioEffectStatus',{active:[{...busy,name:'配樂',pct:0}]});
    vi.advanceTimersByTime(6000);
    expect(status.hidden).toBe(false);
    expect(status.title).toContain('配樂');
    emit('media:audioEffectStatus',{active:[],result:{status:'failed',name:'配樂',detail:'解碼失敗'}});
    expect(status.textContent).toContain('失敗');
    expect(status.title).toContain('解碼失敗');
    emit('media:audioEffectStatus',{active:[]});
    expect(status.hidden).toBe(true);
    resolve({});await work;
  } finally {vi.useRealTimers();}
});

it('背景結果保留錯誤紀錄、屆時回到目前 Proxy 狀態，另開專案立即清理',async()=>{
  const {setMediaProcessingStatus,openModal}=await import('../src/ui.js');
  const {openStatusErrorReport}=await import('../src/status-error-report.js');
  const message=document.getElementById('stIntakeMsg'),proxy=document.getElementById('stProxy');
  const modal=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html').getElementById('modalBg');
  document.body.append(modal);
  vi.useFakeTimers();
  try{
    setStatus('已儲存專案','ok');
    setMediaProcessingStatus('波形未完成','err',false,'檔案讀取失敗');
    expect(message.textContent).toBe('波形未完成');
    expect(document.getElementById('stMsg').textContent).toBe('已儲存專案');
    openStatusErrorReport(openModal);
    expect(document.querySelector('#statusErrorList p').textContent).toBe('檔案讀取失敗');
    vi.advanceTimersByTime(3500);
    expect(message.hidden).toBe(true);expect(proxy.hidden).toBe(false);
    setMediaProcessingStatus('舊專案的素材','busy');
    await jobs.reset();
    expect(message.hidden).toBe(true);expect(proxy.hidden).toBe(false);
  }finally{vi.useRealTimers();}
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
  expect(document.getElementById('stIntakeMsg').textContent).toContain('另有 1 項背景工作');
  pending.forEach(done=>done({cached:true}));
  await Promise.all([first,next]);
});

it('播放及暫停的公開操作不覆蓋母素材驗證百分比',async()=>{
  const {togglePlayPause,shuttlePause}=await import('../src/transport-controller.js');
  const {Media}=await import('../src/media.js');
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37});
  const message=document.getElementById('stIntakeMsg').textContent;
  togglePlayPause();await Promise.resolve();await Promise.resolve();
  expect(Media.playing).toBe(true);
  expect(document.getElementById('stIntakeMsg').textContent).toBe(message);
  togglePlayPause();shuttlePause();
  expect(Media.playing).toBe(false);
  expect(document.getElementById('stIntakeMsg').textContent).toBe(message);
  resolve({});await work;
});

it('普通訊息不遮蓋工作進度，錯誤仍顯示且換專案會釋放進度',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37});
  setStatus('已載入專案','ok');
  expect(document.getElementById('stMsg').textContent).toBe('已載入專案');
  expect(document.getElementById('stIntakeMsg').textContent).toContain('驗證母素材內容');
  setStatus('來源讀取失敗','err');
  expect(document.getElementById('stMsg').textContent).toBe('來源讀取失敗');
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:38});
  expect(document.getElementById('stMsg').textContent).toBe('來源讀取失敗');
  expect(document.getElementById('stIntakeMsg').textContent).toContain('38%');
  expect(document.getElementById('toast').textContent).toBe('來源讀取失敗');
  await jobs.reset();await rejected;
  setStatus('新專案已載入','ok');
  expect(document.getElementById('stMsg').textContent).toBe('新專案已載入');
  expect(progress({...requests[0],pct:90})).toBe(false);
});

it('無總量的快取檢查顯示階段，不偽造百分比',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'cache-check',label:'檢查 Proxy 與音訊快取',pct:null});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('檢查 Proxy 與音訊快取…');
  resolve({});await work;
});

it('母素材驗證顯示已讀與總容量，無效容量與其他階段不顯示',async()=>{
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const verification={...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:37,processedBytes:57831000000,totalBytes:156300000000};
  progress(verification);
  expect(document.getElementById('stIntakeMsg').textContent).toBe('驗證母素材內容… 37%（57.8 / 156.3 GB）');
  progress({...verification,processedBytes:500000,totalBytes:2000000,pct:25});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('驗證母素材內容… 25%（0.5 / 2.0 MB）');
  for(const invalid of [{processedBytes:-1},{processedBytes:Infinity},{processedBytes:'123'},{totalBytes:0},{processedBytes:156300000001}]){
    progress({...verification,...invalid});
    expect(document.getElementById('stIntakeMsg').textContent).toBe('驗證母素材內容… 37%');
  }
  progress({...verification,stage:'transcoding',label:'轉檔 Proxy'});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('轉檔 Proxy… 37%');
  resolve({});await work;
});

it('匯出結束立即恢復最新背景進度，轉換階段會重算剩餘時間',async()=>{
  let now=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:20});
  now=10000;
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:40});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('已用 00:10 / 預估剩餘 00:15');
  setStatus('匯出 50%','busy','lock');
  progress({...requests[0],stage:'transcoding',label:'轉檔 Proxy',pct:1});
  expect(document.getElementById('stMsg').textContent).toBe('匯出 50%');
  setStatus('匯出完成','ok','unlock');
  expect(document.getElementById('stIntakeMsg').textContent).toBe('轉檔 Proxy… 1%');
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
  expect(document.getElementById('stIntakeMsg').textContent).toBe('讀取波形… 32%');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).not.toBe('none');
  completeWave();await wave;resolveFirst({});await first;
  expect(document.getElementById('stProxy').hidden).toBe(false);
  expect(document.getElementById('stMsg').textContent).toBe('就緒');
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).toBe('none');
  expect(report({label:'過期波形',pct:90})).toBe(false);
});

it('已開始的優先波形顯示在後來Proxy之前，排隊不遮住進度且完成後自動切回',async()=>{
  let finishWave,waveOptions;
  window.subtool.prepareSourceWaveform=vi.fn(options=>{waveOptions=options;return new Promise(done=>{finishWave=done;});});
  const wave=jobs.prepareSourceWaveform({path:'demo.mxf'});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('等候優先產生波形…');
  const proxy=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:19});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('驗證母素材內容… 19%');
  progress({...waveOptions,stage:'source-waveform',label:'優先產生波形',queued:false,pct:7});
  progress({...requests[0],stage:'source-verification',label:'驗證母素材內容',pct:20});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('7% 波形｜20% 驗證母素材');
  finishWave({wave:'source.wav'});await wave;
  expect(document.getElementById('stIntakeMsg').textContent).toBe('驗證母素材內容… 20%');
  const queued=jobs.prepareSourceWaveform({path:'next.mxf'});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('驗證母素材內容… 20%');
  finishWave({wave:'next.wav'});await queued;
  resolve({});await proxy;
});

it.each([['source-verification','驗證母素材內容','驗證母素材'],['transcoding','轉檔 Proxy','Proxy 轉檔']])('波形與 %s 並行時各自顯示百分比且提供完整無障礙資訊',async(stage,label,short)=>{
  let report,finish;
  const wave=jobs.prepareWaveform(control=>{report=control.report;return new Promise(done=>{finish=done;});});
  const proxy=jobs.ingest({path:'demo.mxf',needsProxy:true});
  progress({...requests[0],stage,label,pct:20});report({label:'優先產生波形',pct:7,overall:true});
  const message=document.getElementById('stIntakeMsg');
  expect(message.textContent).toContain('7% 波形');expect(message.textContent).toContain('20% '+short);
  expect(message.getAttribute('aria-label')).toContain('優先產生波形');
  expect(message.getAttribute('aria-label')).toContain(label);
  expect(message.title).toBe(message.getAttribute('aria-label'));
  expect([...message.children].map(child=>child.className)).toEqual(['status-pair-item','status-pair-separator','status-pair-item']);
  expect(getComputedStyle(document.getElementById('stProxyCancelBtn')).display).not.toBe('none');
  setStatus('匯出 50%','busy','lock');expect(document.getElementById('stMsg').textContent).toBe('匯出 50%');expect(message.classList.contains('status-pair')).toBe(true);
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
  expect(document.getElementById('stIntakeMsg').textContent).toContain('驗證母素材內容… 3%');
  const first=jobs.prepareSourceWaveform({path:'demo.mxf',start:0,length:60,duration:600});
  progress({...chunks[0].options,stage:'source-waveform',label:'優先產生波形',queued:false,pct:8});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('8% 波形');
  expect(document.getElementById('stIntakeMsg').textContent).toContain('3% 驗證母素材');
  progress({...chunks[0].options,stage:'source-waveform',done:true,outcome:'success',pct:100});
  chunks[0].done({wave:'first.wav',start:0,duration:60});await first;
  report({label:'優先產生波形',pct:10,overall:true});
  const second=jobs.prepareSourceWaveform({path:'demo.mxf',start:60,length:60,duration:600});
  progress({...chunks[1].options,stage:'source-waveform',label:'優先產生波形',queued:false,pct:19});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('10% 波形');
  now=4000;
  progress({...chunks[1].options,stage:'source-waveform',done:true,outcome:'success',pct:100});
  chunks[1].done({wave:'second.wav',start:60,duration:60});await second;
  report({label:'優先產生波形',pct:20,overall:true});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('20% 波形');
  expect(document.getElementById('stIntakeMsg').getAttribute('aria-label')).toContain('20% [已用 00:04 / 預估剩餘 00:16]');
  expect(document.getElementById('stIntakeMsg').textContent).toContain('20% 波形 [已用 00:04 / 預估剩餘 00:16]');
  expect(dispatched.mock.calls.some(([event])=>event.type==='desk:ingest-done')).toBe(false);
  expect(jobs.snapshot().count).toBe(2);
  finishOverall();await overall;
  expect(document.getElementById('stIntakeMsg').textContent).toMatch(/^驗證母素材內容… 3%/);
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
  expect(document.getElementById('stIntakeMsg').textContent).toBe('轉檔 Proxy… 42%');
  resolve({});await work;
});

it('按停止與下一個專案開啟發生在同一刻時，舊按鈕不能取消新工作',async()=>{
  const old=jobs.ingest({path:'old.mxf'}),oldRejected=expect(old).rejects.toMatchObject({name:'AbortError'});
  document.getElementById('stProxyCancelBtn').click();
  const reset=jobs.reset();
  const next=jobs.ingest({path:'new.mxf'});
  await oldRejected;await reset;
  expect(cancel).not.toHaveBeenCalled();
  expect(jobs.snapshot().count).toBe(1);
  resolve({});await next;
});

it('shows a working Proxy cancellation button separately from the export stop control',async()=>{
  const exportStop=vi.fn();document.getElementById('stStopBtn').onclick=exportStop;
  const work=jobs.ingest({path:'demo.mxf',needsProxy:true});
  const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
  const button=document.getElementById('stProxyCancelBtn');
  expect(getComputedStyle(button).display).not.toBe('none');
  expect(button.textContent).toBe('停止背景處理');
  button.click();await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(window.subtool.cancelMediaIntake).toHaveBeenCalledWith({sessionId:requests[0].sessionId});
  expect(getComputedStyle(button).display).toBe('none');
  expect(document.getElementById('stMedia').style.display).toBe('');
  expect(exportStop).not.toHaveBeenCalled();
});

it('同一素材的本機波形與原生工作只算一項，其他素材才列為額外工作',async()=>{
  let finish;
  window.subtool.prepareSourceWaveform=vi.fn(options=>{requests.push(options);return new Promise(done=>{finish=done;});});
  const wave=jobs.prepareWaveform(()=>jobs.prepareSourceWaveform({path:'demo.mxf'}),{path:'demo.mxf'});
  progress({...requests[0],stage:'source-waveform',label:'優先產生波形',pct:7,queued:false});
  expect(document.getElementById('stIntakeMsg').textContent).toBe('優先產生波形… 7%');
  const other=jobs.ingest({path:'other.mxf'});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('另有 1 項背景工作');
  finish({});resolve({});await Promise.all([wave,other]);
});

it('停止後保留可見的續算入口與原因，換專案撤銷舊按鈕資格',async()=>{
  let current=true;
  const retry=vi.fn(async()=>{});
  const recovery=jobs.registerRecovery({path:'C:/movie.mxf',owns:()=>current,retry});
  recovery.fail(new Error('磁碟空間不足，無法保存波形'));
  const button=document.getElementById('stIntakeRetryBtn');
  expect(button).not.toBeNull();
  expect(getComputedStyle(button).display).not.toBe('none');
  expect(document.getElementById('stIntakeMsg').textContent).toContain('磁碟空間不足');
  const staleClick=button.onclick;
  current=false;await jobs.reset();staleClick();await Promise.resolve();
  expect(retry).not.toHaveBeenCalled();expect(getComputedStyle(button).display).toBe('none');
});

it('stream IPC 已回可播網址後的失敗終態仍顯示原因及重試入口',async()=>{
  window.subtool.streamIngest=vi.fn(async options=>{requests.push(options);return {streamUrl:'http://127.0.0.1/stream',cached:false};});
  jobs.registerRecovery({path:'movie.mxf',owns:()=>true,retry:vi.fn()});
  await jobs.streamIngest({path:'movie.mxf'});
  expect(jobs.snapshot().count).toBe(1);
  progress({...requests[0],stage:'transcoding',done:true,outcome:'failed',label:'Proxy',errorMsg:'磁碟已滿'});
  expect(document.getElementById('stIntakeMsg').textContent).toContain('磁碟已滿');
  expect(getComputedStyle(document.getElementById('stIntakeRetryBtn')).display).not.toBe('none');
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

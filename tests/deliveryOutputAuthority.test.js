import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from 'acorn';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createExportAdmission, createExportQueue, isRetryable } = require('../electron/export-queue');
const { createDeliveryRunner } = require('../electron/delivery-runner');
const { createDeliveryPreparation } = require('../electron/delivery-preparation');
const QueueStore = require('../electron/queue-store');
const { outputKey, assertDestinationEvidence, captureDestinationEvidence, captureDestinationEvidenceAsync, retargetOutputAuthority } = require('../electron/export-lease');
const roots = [];
const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const mainTree = parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script' });
function handler(name, context) {
  const call = mainTree.body.map(node => node.expression).find(node => node?.callee?.object?.name === 'ipcMain'
    && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === name);
  let invoke;
  const deliveryPreparation = createDeliveryPreparation(context.deliveryConsent || { release() {} });
  vm.runInNewContext(mainSource.slice(call.start, call.end), {
    ipcMain: { handle: (channel, fn) => { invoke = fn; } }, path, process,
    ExportLease: require('../electron/export-lease'), deliveryPreparation, ...context,
  });
  return invoke;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-output-authority-'));
  roots.push(root);
  const picked = path.join(root, 'picked'), outside = path.join(root, 'outside');
  fs.mkdirSync(picked); fs.mkdirSync(outside);
  const source = path.join(root, 'mother.mp4'); fs.writeFileSync(source, 'mother bytes');
  const authority = new FileAuthority(); authority.grantTrustedFile(source);
  const admission = createExportAdmission({
    expectedExtensionFor: () => 'mp4', outputKeyFor: outputKey,
    mergeSourcePaths: QueueStore.mergeSourcePaths, currentJobs: () => [],
    canReadSource: file => authority.canRead(file), canWriteDelivery: file => authority.canWriteDelivery(file),
    isPreviewCacheMedia: () => false,
  });
  const job = file => ({ id: 'delivery', payload: { format: 'h264', outPath: file, clips: [{ path: source }] } });
  const link = (target, alias) => fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, picked, outside, source, authority, admission, job, link };
}

function queueFor(f) {
  const queueDir = path.join(f.root, 'queue');
  const queue = createExportQueue({ dir: () => queueDir, store: QueueStore, history: QueueStore.QueueHistory,
    admission: f.admission, canReadSource: file => f.authority.canRead(file),
    canWriteDelivery: file => f.authority.canWriteDelivery(file), isFile: file => fs.statSync(file).isFile(),
    captureOutputAuthority: file => f.authority.captureDeliveryOutput(file),
    grantPersistedCapabilities(job) {
      if (job.outputAuthority) { try { f.authority.restoreDeliveryFile(job.payload.outPath, job.outputAuthority); } catch {} }
    }, runJob: vi.fn(async () => {}), onChanged() {},
  });
  queue.setPaused(true);
  return { queue, queueDir };
}

function legacyQueue(f) {
  const { queue, queueDir } = queueFor(f);
  const job = { ...f.job(path.join(f.picked, 'delivery.mp4')), status: 'failed', attempt: 0,
    assRef: 'delivery.ass', createdAt: 1, errorMsg: '舊工作缺少目錄身分' };
  QueueStore.writeAssFile(queueDir, job.assRef, 'frozen subtitle bytes');
  QueueStore.stageTerminalOutcome(queueDir, job);
  queue.restoreJobs(); queue.setPaused(true);
  return { queue, queueDir, job: queue.jobs()[0] };
}

describe('delivery physical output authority', () => {
  it('真 main 的 recovery warning 只在存活視窗顯一次，不等待 modal、不重寫 queue', async () => {
    const declaration = mainTree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'showExportRecoveryWarnings');
    let finish;
    const showMessageBox = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const context = vm.createContext({ exportRecoveryWarningsShown: false, _isAppQuitting: false,
      mainWin: { isDestroyed: () => false }, dialog: { showMessageBox }, console: { error: vi.fn() } });
    vm.runInContext(mainSource.slice(declaration.start, declaration.end), context);
    context.showExportRecoveryWarnings([]);
    context._isAppQuitting = true; context.showExportRecoveryWarnings([{}]);
    context._isAppQuitting = false; context.mainWin.isDestroyed = () => true; context.showExportRecoveryWarnings([{}]);
    expect(showMessageBox).not.toHaveBeenCalled();
    context.mainWin.isDestroyed = () => false;
    expect(context.showExportRecoveryWarnings(Array.from({ length: 8 }, (_, i) => ({ outPath: `legacy-${i}.mp4`, message: '保留原檔' })))).toBeUndefined();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][1].detail).toContain('另有 3 筆');
    expect(showMessageBox.mock.calls[0][1].detail).toContain('新檔名');
    finish({ response: 0 }); await Promise.resolve();
    context.showExportRecoveryWarnings([{}]); expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('所選根內的 junction 不得讓公開交付准入授權根外成品', () => {
    const f = fixture(), child = path.join(f.picked, 'child');
    f.link(f.outside, child); f.authority.grantDeliveryDirectory(f.picked);
    const outPath = path.join(child, 'delivery.mp4');
    expect(() => f.admission.assertJobAdmissible(f.job(outPath))).toThrow(/未經授權/);
    expect(f.authority.canListDirectory(child)).toBe(false);
  });

  it.each(['directory', 'file'])('%s grant 不授予同名替換目錄，明確重新選取才恢復', kind => {
    const f = fixture(), outPath = path.join(f.picked, 'delivery.mp4');
    const grant = () => kind === 'directory' ? f.authority.grantDeliveryDirectory(f.picked) : f.authority.grantDeliveryFile(outPath);
    grant(); expect(f.authority.canWriteDelivery(outPath)).toBe(true);
    fs.renameSync(f.picked, path.join(f.root, 'old-picked')); fs.mkdirSync(f.picked);
    expect(f.authority.canWriteDelivery(outPath)).toBe(false);
    grant(); expect(f.authority.canWriteDelivery(outPath)).toBe(true);
  });

  it('使用者明確選取的根本身可以是 junction；改向後不沿新目錄授權', () => {
    const f = fixture(), alias = path.join(f.root, 'selected-alias');
    f.link(f.picked, alias); f.authority.grantDeliveryDirectory(alias);
    const outPath = path.join(alias, 'delivery.mp4');
    expect(f.admission.assertJobAdmissible(f.job(outPath))).toEqual([f.source]);
    fs.unlinkSync(alias); f.link(f.outside, alias);
    expect(f.authority.canWriteDelivery(outPath)).toBe(false);
  });

  it('精確單檔 evidence 經 snapshot 與 failed journal 重啟保留，不授予旁邊檔案', () => {
    const f = fixture(), outPath = path.join(f.picked, 'delivery.mp4');
    f.authority.grantDeliveryFile(outPath);
    const { queue, queueDir } = queueFor(f);
    queue.addJob({ ...f.job(outPath), status: 'queued', createdAt: 1 });
    const evidence = queue.jobs()[0].outputAuthority;
    expect(QueueStore.loadJobs(queueDir).jobs[0].outputAuthority).toEqual(evidence);
    queue.reportProgress('delivery', { error: true, errorMsg: 'encoding failed' });
    expect(QueueStore.loadTerminalOutcomes(queueDir)[0].outputAuthority).toEqual(evidence);
    const fresh = new FileAuthority();
    fresh.restoreDeliveryFile(outPath, evidence);
    expect(fresh.canWriteDelivery(outPath)).toBe(true);
    expect(fresh.canWriteDelivery(path.join(f.picked, 'sibling.mp4'))).toBe(false);
    fs.renameSync(f.picked, path.join(f.root, 'moved')); fs.mkdirSync(f.picked);
    expect(() => fresh.restoreDeliveryFile(outPath, evidence)).toThrow();
  });

  it('legacy 工作可從正式 queue picker 在空專案重新授權原目錄，保留同 job／ASS 並持久化新 attempt', async () => {
    const f = fixture(), { queue, queueDir, job } = legacyQueue(f);
    expect(queue.retryJob(job.id)).toBe(false);
    const invoke = handler('queue:retryWithOutputDirectory', { QueueManager: queue, isRetryable,
      fileAuthority: f.authority, queueWin: {}, mainWin: {}, dialog: { showOpenDialog: async () => ({ filePaths: [f.picked] }) } });
    expect(await invoke({}, job.id)).toMatchObject({ status: 'retried' });
    const current = queue.jobs()[0];
    expect(current).toMatchObject({ id: job.id, assRef: job.assRef, attempt: 1 });
    expect(current.payload.outPath).toBe(job.payload.outPath);
    expect(current.outputAuthority.parents.at(-1).ino).toBe(String(fs.lstatSync(f.picked, { bigint: true }).ino));
    expect(QueueStore.loadJobs(queueDir).jobs[0].outputAuthority).toEqual(current.outputAuthority);
    expect(fs.readFileSync(QueueStore.safeAssPath(queueDir, job.assRef), 'utf8')).toBe('frozen subtitle bytes');
  });

  it('舊工作缺少目錄證據時，普通 retry 不能借用其他用途的上層目錄授權',()=>{
    const f=fixture();f.authority.grantDeliveryDirectory(f.picked);
    const {queue,job}=legacyQueue(f),before=structuredClone(job);
    expect(queue.retryJob(job.id)).toBe(false);
    expect(queue.get(job.id)).toEqual(before);
  });

  it('一般重試不能因上層資料夾授權而採納同名替換的子目錄',()=>{
    const f=fixture(),sub=path.join(f.picked,'sub'),outPath=path.join(sub,'delivery.mp4');
    fs.mkdirSync(sub);f.authority.grantDeliveryDirectory(f.picked);
    const {queue,queueDir}=queueFor(f);
    queue.addJob({...f.job(outPath),status:'queued',createdAt:1});
    expect(queue.stopJob('delivery')).toBe(true);
    const original=structuredClone(queue.get('delivery'));
    const persisted=structuredClone(QueueStore.loadTerminalOutcomes(queueDir));
    fs.renameSync(sub,path.join(f.picked,'old-sub'));fs.mkdirSync(sub);
    expect(fs.existsSync(outPath)).toBe(false);
    const invoke=handler('queue:retryJob',{QueueManager:queue});
    expect(invoke({},'delivery')).toBe(false);
    expect(queue.get('delivery')).toEqual(original);
    expect(QueueStore.loadTerminalOutcomes(queueDir)).toEqual(persisted);
    expect(QueueStore.loadJobs(queueDir).jobs).toEqual([]);
  });

  it('替換子目錄必須透過使用者明確選擇原輸出資料夾才能重新授權',async()=>{
    const f=fixture(),sub=path.join(f.picked,'sub'),outPath=path.join(sub,'delivery.mp4');
    fs.mkdirSync(sub);f.authority.grantDeliveryDirectory(f.picked);
    const {queue}=queueFor(f);queue.addJob({...f.job(outPath),status:'queued',createdAt:1});
    expect(queue.stopJob('delivery')).toBe(true);
    const oldIdentity=queue.get('delivery').outputAuthority.parents.at(-1).ino;
    fs.renameSync(sub,path.join(f.picked,'old-sub'));fs.mkdirSync(sub);
    const invoke=handler('queue:retryWithOutputDirectory',{QueueManager:queue,isRetryable,
      fileAuthority:f.authority,queueWin:{},mainWin:{},dialog:{showOpenDialog:async()=>({filePaths:[sub]})}});
    expect(await invoke({},'delivery')).toMatchObject({status:'retried'});
    expect(queue.get('delivery').outputAuthority.parents.at(-1).ino).not.toBe(oldIdentity);
    expect(queue.get('delivery').outputAuthority.destinationEvidence).toEqual({version:1,identity:null});
  });

  it('重新授權資料夾不代表同意覆寫替代目錄中新出現的目的檔',async()=>{
    const f=fixture(),sub=path.join(f.picked,'sub'),outPath=path.join(sub,'delivery.mp4');
    fs.mkdirSync(sub);fs.writeFileSync(outPath,'original target');f.authority.grantDeliveryDirectory(f.picked);
    const {queue}=queueFor(f);queue.addJob({...f.job(outPath),status:'queued',createdAt:1});
    const expected=structuredClone(queue.get('delivery').outputAuthority.destinationEvidence);
    expect(queue.stopJob('delivery')).toBe(true);
    fs.renameSync(sub,path.join(f.picked,'old-sub'));fs.mkdirSync(sub);fs.writeFileSync(outPath,'newer target');
    const invoke=handler('queue:retryWithOutputDirectory',{QueueManager:queue,isRetryable,
      fileAuthority:f.authority,queueWin:{},mainWin:{},dialog:{showOpenDialog:async()=>({filePaths:[sub]})}});
    expect(await invoke({},'delivery')).toMatchObject({status:'retried'});
    expect(queue.get('delivery').outputAuthority.destinationEvidence).toEqual(expected);
    expect(()=>assertDestinationEvidence(queue.get('delivery').outputAuthority)).toThrow(/輸出檔.*變更/);
    expect(fs.readFileSync(outPath,'utf8')).toBe('newer target');
  });

  it.each(['cancel', 'other-directory', 'stale'])('queue picker %s 不授權或重試舊工作', async action => {
    const f = fixture(), { queue, job } = legacyQueue(f);
    let finish;
    const invoke = handler('queue:retryWithOutputDirectory', { QueueManager: queue, isRetryable,
      fileAuthority: f.authority, queueWin: {}, mainWin: {}, dialog: { showOpenDialog: () => new Promise(resolve => { finish = resolve; }) } });
    const pending = invoke({}, job.id);
    if (action === 'stale') queue.clearJob(job.id);
    finish(action === 'cancel' ? { canceled: true } : { filePaths: [action === 'other-directory' ? f.outside : f.picked] });
    expect(await pending).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'failed' });
    expect(f.authority.canWriteDelivery(job.payload.outPath)).toBe(false);
    if (action !== 'stale') expect(queue.jobs()[0]).toMatchObject({ status: 'failed', attempt: 0 });
  });

  it('legacy outPath 是已選 junction 時，picker 回同一實體長路徑仍可重新授權原工作', async () => {
    const f = fixture(), selected = f.picked, alias = path.join(f.root, 'selected-alias');
    f.link(selected, alias); f.picked = alias;
    const { queue, job } = legacyQueue(f);
    const invoke = handler('queue:retryWithOutputDirectory', { QueueManager: queue, isRetryable,
      ExportLease: require('../electron/export-lease'), fileAuthority: f.authority, queueWin: {}, mainWin: {},
      dialog: { showOpenDialog: async () => ({ filePaths: [selected] }) } });
    expect(await invoke({}, job.id)).toMatchObject({ status: 'retried' });
    expect(queue.jobs()[0].payload.outPath).toBe(path.join(alias, 'delivery.mp4'));
    expect(queue.jobs()[0].outputAuthority.parents[0].path).toBe(fs.realpathSync.native(selected));
  });

  it.runIf(process.platform === 'win32')('真 8.3 舊輸出路徑可由同一長名原生選擇重新授權', async context => {
    const f = fixture(), selected = f.picked;
    const shortRoot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
      + '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SUBTOOL_DELIVERY_TEST_ROOT).ShortPath'], {
      env: { ...process.env, SUBTOOL_DELIVERY_TEST_ROOT: selected }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    }).trim();
    if (shortRoot.toLowerCase() === selected.toLowerCase()) context.skip('此磁碟沒有提供 8.3 短檔名');
    f.picked = shortRoot;
    const { queue, job } = legacyQueue(f);
    const invoke = handler('queue:retryWithOutputDirectory', { QueueManager: queue, isRetryable,
      fileAuthority: f.authority, queueWin: {}, mainWin: {}, dialog: { showOpenDialog: async () => ({ filePaths: [selected] }) } });
    expect(await invoke({}, job.id)).toMatchObject({ status: 'retried' });
    expect(queue.jobs()[0].payload.outPath).toBe(path.join(shortRoot, 'delivery.mp4'));
    expect(queue.jobs()[0].outputAuthority.parents[0].path).toBe(fs.realpathSync.native(selected));
  });

  it('正式 export IPC 丟棄 renderer 偽造 outputAuthority，由 queue 保存 picker 的物理 evidence', async () => {
    const f = fixture(), outPath = path.join(f.picked, 'delivery.mp4'); f.authority.grantDeliveryDirectory(f.picked);
    const { queue, queueDir } = queueFor(f);
    const invoke = handler('ffmpeg:exportVideo', { FFMPEG: 'ffmpeg', prepareDeliveryPayload: value => value,
      getDeliveryFormatPreset: () => null, expectedExportExtension: () => 'mp4', QueueManager: queue,
      deliveryCapabilities: { assertReady: async () => {} }, fileAuthority: f.authority,
      newJobId: () => 'delivery', JOB_STATUS: { QUEUED: 'queued' }, QueueStore, EXPORT_QUEUE_DIR: queueDir,
      openQueueWindow() {},
    });
    await invoke({ sender: { id: 1 } }, { ...f.job(outPath).payload, outputAuthority: { version: 1, forged: true } });
    expect(queue.jobs()[0].payload).not.toHaveProperty('outputAuthority');
    expect(queue.jobs()[0].outputAuthority).toEqual({...f.authority.captureDeliveryOutput(outPath),
      destinationEvidence:{version:1,identity:null}});
  });

  it('舊直接匯出遇既有大型目的檔立即拒絕，不開始完整內容雜湊',async()=>{
    const f=fixture(),outPath=path.join(f.picked,'existing.mp4');f.authority.grantDeliveryDirectory(f.picked);
    const descriptor=fs.openSync(outPath,'wx');
    try{fs.ftruncateSync(descriptor,16*1024*1024);}finally{fs.closeSync(descriptor);}
    const {queue,queueDir}=queueFor(f),hash=vi.fn(async()=>{throw new Error('不應讀取既有檔內容');});
    const invoke=handler('ffmpeg:exportVideo',{FFMPEG:'ffmpeg',prepareDeliveryPayload:value=>value,
      getDeliveryFormatPreset:()=>null,expectedExportExtension:()=> 'mp4',QueueManager:queue,
      ExportLease:{...require('../electron/export-lease'),captureDestinationEvidenceAsync:hash},
      deliveryCapabilities:{assertReady:vi.fn()},fileAuthority:f.authority,
      newJobId:()=> 'delivery',JOB_STATUS:{QUEUED:'queued'},QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
    await expect(invoke({sender:{id:1}},f.job(outPath).payload)).rejects.toThrow('輸出檔已存在');
    expect(hash).not.toHaveBeenCalled();expect(queue.jobs()).toEqual([]);
    expect(fs.statSync(outPath).size).toBe(16*1024*1024);
  });

  it('交付確認失權後，即使能力探測晚到也不能將工作加入佇列', async () => {
    const f = fixture(), outPath = path.join(f.picked, 'delivery.mp4');
    f.authority.grantDeliveryDirectory(f.picked);
    const {queue,queueDir} = queueFor(f);
    const sender = {id:1};
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = vi.fn(() => gate);
    const authority = captureDestinationEvidence(f.authority.captureDeliveryOutput(outPath));
    const deliveryConsent = {prepare:async()=>({id:'receipt',existing:[]}),release:()=>true,take:()=>authority};
    const deliveryPreparation = createDeliveryPreparation(deliveryConsent);
    const ticket=deliveryPreparation.begin(sender,'delivery-test');
    await deliveryPreparation.prepare(sender,[outPath],'delivery-test',ticket);
    const invoke = handler('ffmpeg:exportVideo', { FFMPEG:'ffmpeg', prepareDeliveryPayload:value=>value,
      getDeliveryFormatPreset:()=>null, expectedExportExtension:()=> 'mp4', QueueManager:queue,
      deliveryPreparation, deliveryConsent,
      deliveryCapabilities:{assertReady:ready},fileAuthority:f.authority,
      newJobId:()=> 'delivery', JOB_STATUS:{QUEUED:'queued'}, QueueStore, EXPORT_QUEUE_DIR:queueDir,
      openQueueWindow:vi.fn(),
    });
    const pending = invoke({sender}, {...f.job(outPath).payload, deliveryReceipt:'receipt',deliveryRequestId:'delivery-test',deliveryRequestTicket:ticket});
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    deliveryPreparation.cancel(sender,'delivery-test',ticket); release();
    await expect(pending).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    expect(queue.jobs()).toEqual([]);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it.each(['dialog','probe'])('舊直接匯出在 %s 等待期間導覽，不能授權或入列',async stage=>{
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4');
    f.authority.grantDeliveryDirectory(f.picked);
    const {queue,queueDir}=queueFor(f),sender=new EventEmitter();sender.id=1;
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const dialog={showSaveDialog:vi.fn(()=>stage==='dialog'?gate:Promise.resolve({canceled:false,filePath:outPath}))};
    const ready=vi.fn(()=>stage==='probe'?gate:Promise.resolve());
    const invoke=handler('ffmpeg:exportVideo',{FFMPEG:'ffmpeg',prepareDeliveryPayload:value=>value,
      getDeliveryFormatPreset:()=>null,expectedExportExtension:()=> 'mp4',QueueManager:queue,
      deliveryCapabilities:{assertReady:ready},fileAuthority:f.authority,dialog,mainWin:{},
      newJobId:()=> 'delivery',JOB_STATUS:{QUEUED:'queued'},QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
    const payload={...f.job(outPath).payload};delete payload.outPath;
    const pending=invoke({sender},payload);
    try{
      if(stage==='dialog')await vi.waitFor(()=>expect(dialog.showSaveDialog).toHaveBeenCalledOnce());
      else await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
      sender.emit('did-start-navigation',{},'url',false,true);
      release(stage==='dialog'?{canceled:false,filePath:outPath}:undefined);
      await expect(pending).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
      expect(queue.jobs()).toEqual([]);
      expect(sender.listenerCount('destroyed')).toBe(0);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      expect(fs.existsSync(outPath)).toBe(false);
    }finally{release({canceled:false,filePath:outPath});}
  });

  it.each(['created','replaced','modified','removed'])('真 export IPC 入列後目的檔被 %s，queue runner 不可覆寫', async change => {
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4'),queueDir=path.join(f.root,'queue');
    if(change!=='created') fs.writeFileSync(outPath,'original target');
    let runner;
    const runFfmpeg=vi.fn(async()=>{ fs.writeFileSync(outPath,'encoded output'); return {maps:[]}; });
    const queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,
      admission:f.admission,canReadSource:file=>f.authority.canRead(file),
      canWriteDelivery:file=>f.authority.canWriteDelivery(file),isFile:file=>fs.statSync(file).isFile(),
      captureOutputAuthority:file=>f.authority.captureDeliveryOutput(file),
      runJob:job=>runner.run(job),onChanged(){} });
    queue.setPaused(true);
    runner=createDeliveryRunner({queue,queueDir:()=>queueDir,tempDir:path.join(f.root,'work'),
      mediaProbe:()=>({hasAudio:async()=>false,audioBitrates:async()=>[]}),
      nativeCapabilities:{assertReady:async()=>{}},runFfmpeg,
      encoder:{bitrateArgs:()=>['-c:v','libx264']}});
    const invoke=handler('ffmpeg:exportVideo',{FFMPEG:'ffmpeg',prepareDeliveryPayload:value=>value,
      getDeliveryFormatPreset:()=>null,expectedExportExtension:()=> 'mp4',QueueManager:queue,
      deliveryCapabilities:{assertReady:async()=>{}},fileAuthority:f.authority,
      dialog:{showSaveDialog:async()=>({canceled:false,filePath:outPath})},mainWin:{},
      newJobId:()=> 'delivery',JOB_STATUS:{QUEUED:'queued'},QueueStore,EXPORT_QUEUE_DIR:queueDir,openQueueWindow(){}});
    const payload={format:'h264',width:640,height:360,fps:25,duration:1,
      clips:[{path:f.source,in:0,out:1,offset:0}]};
    await invoke({sender:{id:1}},payload);
    if(change==='replaced'||change==='removed') fs.unlinkSync(outPath);
    const newer='newer target bytes';
    if(change!=='removed') fs.writeFileSync(outPath,newer);
    queue.setPaused(false);queue.processQueue();
    await vi.waitFor(()=>expect(queue.get('delivery')?.status).toMatch(/^(failed|done)$/));
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(queue.get('delivery')).toMatchObject({status:'failed',errorMsg:expect.stringMatching(/輸出檔.*變更/)});
    if(change==='removed') expect(fs.existsSync(outPath)).toBe(false);
    else expect(fs.readFileSync(outPath,'utf8')).toBe(newer);
  });

  it('probe 等待時母素材改為指向目的檔，真 queue runner 拒絕啟動 writer', async context => {
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4'),queueDir=path.join(f.root,'queue');
    f.authority.grantDeliveryDirectory(f.picked);fs.writeFileSync(outPath,'original output');
    const check=path.join(f.root,'link-check');
    try { fs.symlinkSync(outPath,check,'file'); fs.unlinkSync(check); }
    catch(error) { if(['EPERM','EACCES','ENOSYS'].includes(error.code)) context.skip('此環境無法建立檔案符號連結'); throw error; }
    let release,runner;const gate=new Promise(resolve=>{release=resolve;});
    const hasAudio=vi.fn(()=>gate),runFfmpeg=vi.fn(async()=>({maps:[]}));
    const queue=createExportQueue({dir:()=>queueDir,store:QueueStore,history:QueueStore.QueueHistory,
      admission:f.admission,canReadSource:file=>f.authority.canRead(file),canWriteDelivery:file=>f.authority.canWriteDelivery(file),
      isFile:file=>fs.statSync(file).isFile(),captureOutputAuthority:file=>f.authority.captureDeliveryOutput(file),
      runJob:job=>runner.run(job),onChanged(){}});
    queue.setPaused(true);
    runner=createDeliveryRunner({queue,queueDir:()=>queueDir,tempDir:path.join(f.root,'work'),
      mediaProbe:()=>({hasAudio,audioBitrates:async()=>[]}),nativeCapabilities:{assertReady:async()=>{}},runFfmpeg,
      encoder:{bitrateArgs:()=>['-c:v','libx264']}});
    const job={...f.job(outPath),status:'queued',createdAt:1};
    Object.assign(job.payload,{width:640,height:360,fps:25,duration:1});
    queue.addJob(job, await captureDestinationEvidenceAsync(f.authority.captureDeliveryOutput(outPath)));
    try {
      queue.setPaused(false);queue.processQueue();
      await vi.waitFor(()=>expect(hasAudio).toHaveBeenCalledOnce());
      fs.unlinkSync(f.source);fs.symlinkSync(outPath,f.source,'file');
      release(false);
      await vi.waitFor(()=>expect(queue.get('delivery')?.status).toBe('failed'));
      expect(runFfmpeg).not.toHaveBeenCalled();
      expect(queue.get('delivery').errorMsg).toContain('不可覆蓋母素材');
      expect(fs.readFileSync(outPath,'utf8')).toBe('original output');
    } finally { release(false); }
  });

  it('入列後目標證據隨 queue 快照、重啟與一般重試保留，不接納後來出現的檔案', () => {
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4');f.authority.grantDeliveryFile(outPath);
    const {queue,queueDir}=queueFor(f);
    queue.addJob({...f.job(outPath),status:'queued',createdAt:1});
    const admitted=structuredClone(queue.get('delivery').outputAuthority.destinationEvidence);
    expect(admitted).toEqual({version:1,identity:null});
    fs.writeFileSync(outPath,'later output');
    expect(QueueStore.loadJobs(queueDir).jobs[0].outputAuthority.destinationEvidence).toEqual(admitted);
    const {queue:restored}=queueFor(f);restored.restoreJobs();
    expect(restored.get('delivery').outputAuthority.destinationEvidence).toEqual(admitted);
    expect(restored.stopJob('delivery')).toBe(true);
    expect(restored.retryJob('delivery')).toBe(true);
    expect(restored.get('delivery').outputAuthority.destinationEvidence).toEqual(admitted);
    expect(()=>assertDestinationEvidence(restored.get('delivery').outputAuthority)).toThrow(/輸出檔.*變更/);
    expect(fs.readFileSync(outPath,'utf8')).toBe('later output');
  });

  it('已入列工作改交付檔名時分別記錄新目標，同名更新仍沿用原證據', () => {
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4');f.authority.grantDeliveryFile(outPath);
    const {queue}=queueFor(f);queue.addJob({...f.job(outPath),status:'queued',createdAt:1});
    const original=queue.get('delivery').outputAuthority;
    fs.writeFileSync(outPath,'later output');
    const same=retargetOutputAuthority(original,outPath);
    expect(same.destinationEvidence).toEqual(original.destinationEvidence);
    expect(()=>assertDestinationEvidence(same)).toThrow(/輸出檔.*變更/);
    const next=path.join(f.picked,'delivery.mov');fs.writeFileSync(next,'existing other file');
    const changed=retargetOutputAuthority(original,next);
    expect(changed.destinationEvidence.identity).not.toBeNull();
    expect(()=>assertDestinationEvidence(changed)).not.toThrow();
    fs.writeFileSync(next,'later other file');
    expect(()=>assertDestinationEvidence(changed)).toThrow(/輸出檔.*變更/);
  });

  it('准入後 probe 等待期間換掉父目錄，runner 不把工作交給原生 writer', async () => {
    const f = fixture(), outPath = path.join(f.picked, 'delivery.mp4'); f.authority.grantDeliveryFile(outPath);
    let finish;
    const runFfmpeg = vi.fn();
    const queue = { assertJobCapabilities: job => f.admission.assertJobAdmissible(job), reportProgress: vi.fn(),
      registerActiveJob() {}, clearActiveJob() {} };
    const runner = createDeliveryRunner({ queue, queueDir: () => path.join(f.root, 'queue'), tempDir: path.join(f.root, 'work'),
      mediaProbe: () => ({ hasAudio: () => new Promise(resolve => { finish = resolve; }) }),
      nativeCapabilities: { assertReady: async () => {} }, runFfmpeg,
      encoder: { bitrateArgs: () => ['-c:v', 'libx264'] },
    });
    const job = f.job(outPath);
    Object.assign(job.payload, { width: 640, height: 360, fps: 25, duration: 1, clips: [{ path: f.source, in: 0, out: 1, offset: 0 }] });
    job.outputAuthority = captureDestinationEvidence(f.authority.captureDeliveryOutput(outPath));
    const pending = runner.run(job);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    fs.renameSync(f.picked, path.join(f.root, 'moved')); fs.mkdirSync(f.picked);
    fs.writeFileSync(outPath, 'foreign delivery'); finish(false);
    await pending;
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(fs.readFileSync(outPath, 'utf8')).toBe('foreign delivery');
    expect(queue.reportProgress).toHaveBeenCalledWith('delivery', expect.objectContaining({ error: true }));
  });

  it('runner probe 等待期間目的檔出現，不把工作交給原生 writer', async () => {
    const f=fixture(),outPath=path.join(f.picked,'delivery.mp4');f.authority.grantDeliveryFile(outPath);
    let finish;const runFfmpeg=vi.fn();
    const queue={assertJobCapabilities:job=>f.admission.assertJobAdmissible(job),reportProgress:vi.fn(),
      registerActiveJob(){},clearActiveJob(){}};
    const runner=createDeliveryRunner({queue,queueDir:()=>path.join(f.root,'queue'),tempDir:path.join(f.root,'work'),
      mediaProbe:()=>({hasAudio:()=>new Promise(resolve=>{finish=resolve;})}),
      nativeCapabilities:{assertReady:async()=>{}},runFfmpeg,encoder:{bitrateArgs:()=>['-c:v','libx264']}});
    const job=f.job(outPath);Object.assign(job.payload,{width:640,height:360,fps:25,duration:1,
      clips:[{path:f.source,in:0,out:1,offset:0}]});
    job.outputAuthority=captureDestinationEvidence(f.authority.captureDeliveryOutput(outPath));
    const pending=runner.run(job);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    fs.writeFileSync(outPath,'later output');finish(false);await pending;
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(fs.readFileSync(outPath,'utf8')).toBe('later output');
    expect(queue.reportProgress).toHaveBeenCalledWith('delivery',expect.objectContaining({error:true}));
  });
});

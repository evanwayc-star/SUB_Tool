import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from 'acorn';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createExportAdmission, createExportQueue, isRetryable } = require('../electron/export-queue');
const { createDeliveryRunner } = require('../electron/delivery-runner');
const QueueStore = require('../electron/queue-store');
const { outputKey } = require('../electron/export-lease');
const roots = [];
const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const mainTree = parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script' });
function handler(name, context) {
  const call = mainTree.body.map(node => node.expression).find(node => node?.callee?.object?.name === 'ipcMain'
    && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === name);
  let invoke;
  vm.runInNewContext(mainSource.slice(call.start, call.end), {
    ipcMain: { handle: (channel, fn) => { invoke = fn; } }, path, process,
    ExportLease: require('../electron/export-lease'), ...context,
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
    expect(queue.jobs()[0].outputAuthority).toEqual(f.authority.captureDeliveryOutput(outPath));
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
    job.outputAuthority = f.authority.captureDeliveryOutput(outPath);
    const pending = runner.run(job);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    fs.renameSync(f.picked, path.join(f.root, 'moved')); fs.mkdirSync(f.picked);
    fs.writeFileSync(outPath, 'foreign delivery'); finish(false);
    await pending;
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(fs.readFileSync(outPath, 'utf8')).toBe('foreign delivery');
    expect(queue.reportProgress).toHaveBeenCalledWith('delivery', expect.objectContaining({ error: true }));
  });
});

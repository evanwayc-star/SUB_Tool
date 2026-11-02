import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const { createExportQueue } = require('../electron/export-queue');
const { createDeliveryRunner } = require('../electron/delivery-runner');
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine');
const { spawnExportWatchdog } = require('../electron/export-watchdog');
const { captureOutputAuthority, captureOutputDirectory, prepareSharedLeaseRoot } = require('../electron/export-lease');
const store = require('../electron/queue-store');
const ExportLease = require('../electron/export-lease');
const { expectedExportExtension } = require('../electron/ipc-guards');
const { FileAuthority } = require('../electron/file-authority');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-legacy-consent-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('舊版持久化交付缺少目的檔身分證據，恢復後不能覆寫入列後產生的新內容', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-legacy-consent-'));
  roots.push(root);
  const queueDir = path.join(root, 'queue'), source = path.join(root, 'source.mp4');
  const target = path.join(root, 'output.mp4'), marker = path.join(root, 'writer-started');
  const script = path.join(root, 'encoder.cjs');
  fs.writeFileSync(source, 'real source placeholder'); fs.writeFileSync(target, 'old version');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'started');fs.writeFileSync(process.argv[3],'encoded delivery');");
  const job = { id: 'legacy', status: 'queued', createdAt: Date.now(), assRef: null,
    outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)),
    payload: { format: 'h264', width: 640, height: 360, fps: 25, duration: 1, outPath: target,
      videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
      clips: [{ path: source, type: 'video', vtrack: 0, in: 0, out: 1, offset: 0, natW: 640, natH: 360 }] } };
  store.persistJob(queueDir, job, 0);
  expect(store.loadJobs(queueDir).jobs[0].outputAuthority).not.toHaveProperty('destinationEvidence');
  fs.unlinkSync(target); fs.writeFileSync(target, 'new user content');
  let runner;
  const queue = createExportQueue({ dir: () => queueDir, store, history: store.QueueHistory,
    admission: { sourcePathsOf: item => store.collectSourcePaths(item.payload),
      assertJobAdmissible() {}, assertMasterMedia() {}, assertOutputAvailable() {}, assertOutputFormat() {} },
    grantPersistedCapabilities() {}, canReadSource: () => true, canWriteDelivery: () => true,
    isFile: file => fs.statSync(file).isFile(), runJob: item => runner.run(item), onChanged() {} });
  const controllers = [];
  const execution = createFFmpegExecution({ getFFmpegPath: () => process.execPath, getQueueDir: () => queueDir,
    getSharedOutputLock: () => prepareSharedLeaseRoot(root),
    spawnWatchdog(config, handlers) {
      const controller = spawnExportWatchdog({ ...config, args: [script, marker, config.outPath] }, handlers);
      controllers.push(controller); return controller;
    } });
  runner = createDeliveryRunner({ queue, queueDir: () => queueDir, tempDir: path.join(root, 'work'),
    nativeCapabilities: { assertReady: async () => {} }, mediaProbe: () => ({ hasAudio: async () => false }),
    encoder: { bitrateArgs: () => ['-c:v', 'libx264'] }, runFfmpeg: (args, options) => execution.execute(args, options) });
  try {
    queue.restoreJobs();
    expect(queue.isPaused).toBe(true);
    queue.setPaused(false);
    await vi.waitFor(() => expect(['done', 'failed'].includes(queue.get(job.id).status)).toBe(true), { timeout: 10000 });
    expect(fs.readFileSync(target, 'utf8')).toBe('new user content');
    expect(fs.existsSync(marker)).toBe(false);
    expect(queue.get(job.id)).toMatchObject({ status: 'failed', errorMsg: expect.stringMatching(/重新|確認/) });
  } finally {
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
    await Promise.all(controllers.map(controller => vi.waitFor(() => expect(controller.child.exitCode != null || controller.child.signalCode != null).toBe(true))));
  }
}, 30000);

it('繞過 runner 的真 watchdog 也拒絕缺少覆寫證據的舊工作', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-legacy-consent-'));
  roots.push(root);
  const target = path.join(root, 'delivery.mp4'), marker = path.join(root, 'started'), script = path.join(root, 'writer.cjs');
  fs.writeFileSync(target, 'new user content');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'started');fs.writeFileSync(process.argv[3],'encoded');");
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, target], cwd: root,
    outPath: target, jobId: 'legacy-watchdog', queueDir: path.join(root, 'queue'),
    outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)), ...prepareSharedLeaseRoot(root) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    await expect(controller.ready).rejects.toMatchObject({ code: 'DELIVERY_DESTINATION_CONFIRMATION_REQUIRED' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('new user content');
  } finally {
    controller.stop('test-cleanup'); await controller.completion.catch(() => null);
    await vi.waitFor(() => expect(controller.child.exitCode != null || controller.child.signalCode != null).toBe(true));
  }
}, 30000);

it.each(['原目標', 'v1 原目標', '新目標', '原目錄移走後選新目標', '完全缺少目錄身分', '取消選檔', '取消覆寫', '確認時換檔', '工作變更', '頁面導覽', '雜湊中導覽', '保存失敗', '來源別名', '輸出衝突', '原程序仍活躍', '跨 profile 活躍鎖', '別的工作佔用目標', '舊成品鎖', '損壞鎖', '佇列鎖目錄換檔', '共用鎖目錄換檔', '佇列鎖目錄缺失', '共用鎖目錄缺失', '移動後仍選舊實體目錄'])
('舊版佇列透過真 main IPC 恢復：%s', async scenario => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-legacy-consent-'));
  roots.push(root);
  const queueDir = path.join(root, 'queue'), source = path.join(root, 'source.mp4');
  const oldDirectory = ['原目錄移走後選新目標', '移動後仍選舊實體目錄'].includes(scenario) ? path.join(root, 'old-output') : root;
  fs.mkdirSync(oldDirectory, { recursive: true });
  const original = path.join(oldDirectory, 'original.mp4'), replacement = path.join(root, 'replacement.mp4');
  const marker = path.join(root, 'writer-started'), script = path.join(root, 'encoder.cjs');
  fs.writeFileSync(source, 'source'); fs.writeFileSync(original, 'original');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'started');fs.writeFileSync(process.argv[3],'encoded delivery');");
  const job = { id: 'legacy', status: 'queued', createdAt: Date.now(), assRef: 'legacy.ass',
    outputAuthority: captureOutputAuthority(original, captureOutputDirectory(oldDirectory)),
    payload: { format: 'h264', width: 640, height: 360, fps: 25, duration: 1, outPath: original,
      videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
      clips: [{ path: source, type: 'video', vtrack: 0, in: 0, out: 1, offset: 0, natW: 640, natH: 360 }] } };
  if (scenario === 'v1 原目標') job.outputAuthority = ExportLease.captureDestinationEvidence(job.outputAuthority);
  if (scenario === '完全缺少目錄身分') delete job.outputAuthority;
  store.ensureDir(queueDir); store.writeAssFile(queueDir, job.assRef, '[Script Info]\nTitle: frozen subtitle\n');
  store.persistJob(queueDir, job, 0);
  fs.mkdirSync(path.join(queueDir, 'output-leases'), { recursive: true });
  const sharedLock = prepareSharedLeaseRoot(root);
  let failSave = false, runner;
  const queueStore = { ...store, persistJob(...args) {
    if (failSave && args[1].status === 'queued') throw new Error('disk unavailable');
    return store.persistJob(...args);
  } };
  const fileAuthority = new FileAuthority();
  fileAuthority.grantTrustedFile(source);
  const grant = vi.fn(item => fileAuthority.restoreDeliveryFile(item.payload.outPath, item.outputAuthority));
  const queue = createExportQueue({ dir: () => queueDir, store: queueStore, history: store.QueueHistory,
    admission: { sourcePathsOf: item => store.collectSourcePaths(item.payload),
      assertJobAdmissible(item) { if (!fileAuthority.canWriteDelivery(item.payload.outPath)) throw new Error('輸出未授權'); },
      assertMasterMedia() {}, assertOutputAvailable(item) {
        if (scenario === '輸出衝突' && item.payload.outPath === replacement) throw new Error('輸出已被佇列使用');
      }, assertOutputFormat() {} },
    grantPersistedCapabilities: grant, canReadSource: file => fileAuthority.canRead(file), canWriteDelivery: file => fileAuthority.canWriteDelivery(file),
    isFile: file => fs.statSync(file).isFile(), runJob: item => runner.run(item), onChanged() {},
    captureOutputAuthority: file => fileAuthority.captureDeliveryOutput(file) });
  const controllers = [];
  const execution = createFFmpegExecution({ getFFmpegPath: () => process.execPath, getQueueDir: () => queueDir,
    getSharedOutputLock: () => sharedLock, spawnWatchdog(config, handlers) {
      const controller = spawnExportWatchdog({ ...config, args: [script, marker, config.outPath] }, handlers);
      controllers.push(controller); return controller;
    } });
  runner = createDeliveryRunner({ queue, queueDir: () => queueDir, tempDir: path.join(root, 'work'),
    nativeCapabilities: { assertReady: async () => {} }, mediaProbe: () => ({ hasAudio: async () => false }),
    encoder: { bitrateArgs: () => ['-c:v', 'libx264'] }, runFfmpeg: (args, options) => execution.execute(args, options) });
  const sender = new EventEmitter(), frame = {};
  Object.assign(sender, { mainFrame: frame, isDestroyed: () => false });
  const win = { webContents: sender, isDestroyed: () => false };
  const dialog = {
    showSaveDialog: vi.fn(async () => {
      if (['原目錄移走後選新目標', '移動後仍選舊實體目錄'].includes(scenario)) fs.renameSync(oldDirectory, `${oldDirectory}-moved`);
      if (['佇列鎖目錄換檔', '佇列鎖目錄缺失'].includes(scenario)) {
        fs.renameSync(path.join(queueDir, 'output-leases'), path.join(queueDir, 'output-leases-moved'));
        if (scenario === '佇列鎖目錄換檔') fs.mkdirSync(path.join(queueDir, 'output-leases'));
      }
      if (['共用鎖目錄換檔', '共用鎖目錄缺失'].includes(scenario)) {
        fs.renameSync(sharedLock.sharedQueueDir, `${sharedLock.sharedQueueDir}-moved`);
        if (scenario === '共用鎖目錄換檔') fs.mkdirSync(path.join(sharedLock.sharedQueueDir, 'output-leases'), { recursive: true });
      }
      return scenario === '取消選檔' ? { canceled: true } :
        { canceled: false, filePath: ['新目標', '輸出衝突', '原目錄移走後選新目標'].includes(scenario) ? replacement :
          scenario === '移動後仍選舊實體目錄' ? path.join(`${oldDirectory}-moved`, 'original.mp4') : scenario === '來源別名' ? source : original };
    }),
    showMessageBox: vi.fn(async (_window, options) => {
      expect(options.detail).toBe(scenario === '來源別名' ? source : scenario === '移動後仍選舊實體目錄' ? path.join(`${oldDirectory}-moved`, 'original.mp4') : original);
      if (scenario === '確認時換檔') { fs.unlinkSync(original); fs.writeFileSync(original, 'changed during confirmation'); }
      if (scenario === '工作變更') queue.get(job.id).attempt = 99;
      if (scenario === '頁面導覽') sender.emit('did-start-navigation', {}, 'app://queue', false, true);
      return { response: scenario === '取消覆寫' ? 1 : 0 };
    }),
  };
  const mainSource = fs.readFileSync('electron/main.js', 'utf8');
  const expression = parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script' }).body.map(node => node.expression)
    .find(node => node?.callee?.object?.name === 'ipcMain' && node.callee.property?.name === 'handle'
      && node.arguments?.[0]?.value === 'queue:retryWithOutputConfirmation');
  let invoke;
  const hashStarted = vi.fn();
  const ipcLease = scenario !== '雜湊中導覽' ? ExportLease : {
    ...ExportLease,
    captureDestinationEvidenceAsync: (_authority, {signal}) => new Promise((_resolve, reject) => {
      hashStarted(); signal.addEventListener('abort', () => reject(new Error('已取消核對')), {once:true});
    }),
  };
  vm.runInNewContext(mainSource.slice(expression.start, expression.end), { ipcMain: { handle: (_channel, handler) => { invoke = handler; } },
    QueueManager: queue, queueWin: win, isRetryable: status => ['failed', 'stopped'].includes(status), dialog, path, AbortController,
    expectedExportExtension, ExportLease:ipcLease, EXPORT_QUEUE_DIR: queueDir, SHARED_OUTPUT_LOCK: sharedLock });
  try {
    queue.restoreJobs(); queue.setPaused(false);
    await vi.waitFor(() => expect(queue.get(job.id).status).toBe('failed'));
    await vi.waitFor(() => expect(queue.activeJob(job.id)).toBeNull());
    await new Promise(resolve => setImmediate(resolve));
    const grantsBefore = grant.mock.calls.length;
    if (scenario === '原程序仍活躍') queue.registerActiveJob(job.id, { stop() {} });
    if (['跨 profile 活躍鎖', '別的工作佔用目標', '舊成品鎖'].includes(scenario)) ExportLease.acquireLease({
      queueDir: scenario === '舊成品鎖' ? queueDir : sharedLock.sharedQueueDir,
      outPath: original, jobId: scenario === '別的工作佔用目標' ? 'other-job' : job.id,
      token: 'old-lock-token', watchdogPid: process.pid, outputStarted: false });
    if (scenario === '損壞鎖') fs.mkdirSync(path.join(queueDir, 'output-leases', 'invalid.lock'));
    failSave = scenario === '保存失敗';
    const pending = invoke({ sender, senderFrame: frame }, job.id);
    if (scenario === '雜湊中導覽') {
      await vi.waitFor(() => expect(hashStarted).toHaveBeenCalledOnce());
      sender.emit('did-start-navigation', {}, 'app://queue', false, true);
    }
    const result = await pending;
    if (['原目標', 'v1 原目標', '新目標', '原目錄移走後選新目標'].includes(scenario)) {
      expect(result.status).toBe('retried');
      await vi.waitFor(() => expect(queue.get(job.id).status).toBe('done'), { timeout: 10000 });
      expect(fs.readFileSync(['原目標','v1 原目標'].includes(scenario) ? original : replacement, 'utf8')).toBe('encoded delivery');
      if (scenario === '新目標') expect(fs.readFileSync(original, 'utf8')).toBe('original');
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(['原目標','v1 原目標'].includes(scenario) ? 1 : 0);
    } else {
      expect(result.status).toBe(['取消選檔', '取消覆寫'].includes(scenario) ? 'cancelled' : 'failed');
      if (scenario === '完全缺少目錄身分') {
        expect(result.message).toContain('缺少原輸出目錄身分');
        expect(dialog.showSaveDialog).not.toHaveBeenCalled();
      }
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(scenario === '移動後仍選舊實體目錄' ? path.join(`${oldDirectory}-moved`, 'original.mp4') : original, 'utf8')).toBe(scenario === '確認時換檔' ? 'changed during confirmation' : 'original');
      expect(queue.get(job.id).status).toBe('failed');
      expect(queue.get(job.id).outputAuthority || {}).not.toHaveProperty('destinationEvidence');
      expect(fs.readFileSync(store.safeAssPath(queueDir, job.assRef), 'utf8')).toContain('frozen subtitle');
      expect(grant).toHaveBeenCalledTimes(grantsBefore);
    }
  } finally {
    if (scenario === '原程序仍活躍') queue.clearActiveJob(job.id);
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
    await Promise.all(controllers.map(controller => vi.waitFor(() => expect(controller.child.exitCode != null || controller.child.signalCode != null).toBe(true))));
  }
}, 30000);

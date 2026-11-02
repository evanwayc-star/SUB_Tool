import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createExportAdmission, createExportQueue } = require('../electron/export-queue');
const { outputKey } = require('../electron/export-lease');
const { acquireLease, updateLease, releaseLease, listLeases, normalizeOutputPath, outputReservationEntry, stagePathForCanonical, captureOutputDirectory, captureOutputAuthority, captureDestinationEvidence, prepareSharedLeaseRoot } = require('../electron/export-lease');
const { spawnExportWatchdog: spawnWatchdog, recoverExportLeases } = require('../electron/export-watchdog');
// 這些 alias 測試以極小檔案模擬先前已確認的完整內容；保留原始證據直到 writer 啟動。
const confirmedFixture = input => {
  const authority=Object.hasOwn(input || {},'destinationEvidence')?structuredClone(input):captureDestinationEvidence(input);
  if(authority.destinationEvidence.version===1&&authority.destinationEvidence.identity!==null)
    authority.destinationEvidence={...authority.destinationEvidence,version:2,sha256:crypto.createHash('sha256').update(fs.readFileSync(authority.outPath)).digest('hex')};
  return authority;
};
const spawnExportWatchdog = (config, options) => spawnWatchdog({ ...prepareSharedLeaseRoot(config.cwd), ...config,
  outputAuthority: confirmedFixture(config.outputAuthority) }, options);
const QueueStore = require('../electron/queue-store');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-output-alias-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

it.runIf(process.platform === 'win32')('已存在輸出檔的長檔名與 8.3 別名不能同時保留兩份佇列工作', context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const source = path.join(root, 'source.mp4');
  const target = path.join(root, 'A Very Long Delivery Target Filename.mp4');
  fs.writeFileSync(source, 'source bytes');
  fs.writeFileSync(target, 'original target');
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
  const authority = new FileAuthority();
  authority.grantTrustedFile(source);
  authority.grantDeliveryDirectory(root);
  let queue;
  const admission = createExportAdmission({
    expectedExtensionFor: () => 'mp4', outputKeyFor: outputKey,
    mergeSourcePaths: QueueStore.mergeSourcePaths, currentJobs: () => queue?.jobs() || [],
    canReadSource: file => authority.canRead(file), canWriteDelivery: file => authority.canWriteDelivery(file),
    isPreviewCacheMedia: () => false,
  });
  queue = createExportQueue({ dir: () => path.join(root, 'queue'), store: QueueStore, history: QueueStore.QueueHistory,
    admission, canReadSource: file => authority.canRead(file), canWriteDelivery: file => authority.canWriteDelivery(file),
    isFile: file => fs.statSync(file).isFile(), captureOutputAuthority: file => authority.captureDeliveryOutput(file),
    runJob: vi.fn(), onChanged() {} });
  queue.setPaused(true);
  const job = (id, outPath) => ({ id, status: 'queued', createdAt: 1,
    payload: { format: 'h264', outPath, clips: [{ path: source, in: 0, out: 1, offset: 0 }] } });
  queue.addJob(job('first', target));
  expect(() => queue.addJob(job('second', short))).toThrow(expect.objectContaining({ code: 'OUTPUT_BUSY' }));
  expect(queue.jobs()).toHaveLength(1);
  expect(fs.readFileSync(target, 'utf8')).toBe('original target');
});

it.runIf(process.platform === 'win32')('跨 watchdog 長短名稱同時指向同一目的檔時只可啟動一個 writer', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Concurrent Delivery Filename.mp4');
  const script = path.join(root, 'writer.cjs');
  const marker = path.join(root, 'started.txt');
  const queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
  const controllers = [];
  const launch = (id, outPath) => {
    const controller = spawnExportWatchdog({ ffmpegPath: process.execPath,
      args: [script, marker, outPath], cwd: root, outPath, jobId: id, queueDir,
      outputAuthority: captureOutputAuthority(outPath, captureOutputDirectory(root)) });
    controller.ready.catch(() => {}); controller.completion.catch(() => {}); controllers.push(controller);
    return controller;
  };
  try {
    const first = launch('first', target);
    await first.ready;
    await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1));
    const second = launch('second', short);
    await expect(second.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
  }
}, 30000);

it.runIf(process.platform === 'win32')('取得 canonical reservation 時目的檔被替換，不啟動 writer 並回滾所有新鎖', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Lock Change Target Filename.mp4'), queueDir = path.join(root, 'queue');
  const old = path.join(root, 'old-file.bin'), shim = path.join(root, 'swap.cjs');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.writeFileSync(process.argv[2],'started'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const aliasLock = `${outputKey(target)}.lock`;
  fs.writeFileSync(shim, `const fs=require('node:fs'),path=require('node:path'),rename=fs.renameSync;let once=false;
    fs.renameSync=function(src,dst){const result=rename.call(this,src,dst);
      if(!once&&path.basename(String(dst))===${JSON.stringify(aliasLock)}){once=true;
        rename.call(this,${JSON.stringify(target)},${JSON.stringify(old)});fs.writeFileSync(${JSON.stringify(target)},'new target');}
      return result;};`);
  const authority = captureDestinationEvidence(captureOutputAuthority(short, captureOutputDirectory(root)));
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, short],
    cwd: root, outPath: short, jobId: 'swap', queueDir, outputAuthority: authority }, {
    env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${shim.replaceAll('\\', '/')}"`.trim() },
  });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    await expect(controller.ready).rejects.toMatchObject({ code: expect.stringMatching(/^DELIVERY_DESTINATION_/) });
    await controller.completion.catch(() => null);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(old, 'utf8')).toBe('original target');
    expect(fs.readFileSync(target, 'utf8')).toBe('new target');
    expect(listLeases(queueDir)).toEqual([]);
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
  }
}, 30000);

it('不同 queueDir 的 watchdog 不能同時寫入同一個現存目的檔', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'shared-target.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  const sharedQueueDir = path.join(root, 'shared');
  fs.mkdirSync(path.join(sharedQueueDir, 'output-leases'), { recursive: true });
  const sharedRoot = captureOutputDirectory(path.join(sharedQueueDir, 'output-leases'));
  const sharedAuthority = captureOutputAuthority(path.join(sharedRoot.path, '.subtool-root-proof'), sharedRoot);
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const start = (id, queueDir) => spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, target], cwd: root, outPath: target, jobId: id, queueDir, sharedQueueDir, sharedAuthority,
    outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)) });
  const first = start('first', path.join(root, 'profile-a'));
  first.ready.catch(() => {}); first.completion.catch(() => {});
  let second;
  try {
    await first.ready;
    await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1));
    second = start('second', path.join(root, 'profile-b'));
    second.ready.catch(() => {}); second.completion.catch(() => {});
    await expect(second.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    for (const controller of [first, second].filter(Boolean)) controller.stop('test-cleanup');
    await Promise.all([first, second].filter(Boolean).map(controller => controller.completion.catch(() => null)));
  }
}, 30000);

it('不同 profile 同時啟動時，真 watchdog 只准一個 writer 取得共用鎖', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'simultaneous.mp4'), script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  fs.writeFileSync(target, 'previous');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[3],'partial');fs.appendFileSync(process.argv[2],'writer\\n');setInterval(()=>{},1000);");
  const authority = captureOutputAuthority(target, captureOutputDirectory(root));
  const controllers = ['a', 'b'].map(id => spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, target], cwd: root, outPath: target, queueDir: path.join(root, id), jobId: id, outputAuthority: authority }));
  for (const controller of controllers) { controller.ready.catch(() => {}); controller.completion.catch(() => {}); }
  try {
    const started = await Promise.allSettled(controllers.map(controller => controller.ready));
    expect(started.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(started.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'OUTPUT_BUSY' });
    await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1));
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
  } finally {
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
  }
}, 30000);

it('共用鎖的原程序消失時，僅在暫存成品不存在後復原並准入另一個 profile', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'recovery.mp4'), oldQueue = path.join(root, 'old-profile');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  fs.writeFileSync(target, 'previous');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[3],'partial');fs.writeFileSync(process.argv[2],'started');setInterval(()=>{},1000);");
  const shared = prepareSharedLeaseRoot(root), authority = captureOutputAuthority(target, captureOutputDirectory(root));
  const primary = normalizeOutputPath(authority.outPath), token = 'old-recovery-token';
  const stage = stagePathForCanonical(primary, token);
  fs.mkdirSync(path.join(oldQueue, 'output-leases'), { recursive: true });
  const queueAuthority = captureOutputAuthority(path.join(oldQueue, 'output-leases', '.subtool-queue-proof'), captureOutputDirectory(oldQueue));
  acquireLease({ queueDir: shared.sharedQueueDir, outPath: primary, token, jobId: 'old', watchdogPid: 2147483647,
    outputStarted: false, aliasOf: { version: 1, queueDir: oldQueue, outPath: primary,
      key: outputKey(primary), stagePath: stage, outputAuthority: authority, queueAuthority } });
  fs.writeFileSync(stage, 'recoverable stage');
  const launch = id => spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, target], cwd: root,
    outPath: target, queueDir: path.join(root, 'new-profile'), jobId: id, outputAuthority: authority });
  const first = launch('blocked'); first.ready.catch(() => {}); first.completion.catch(() => {});
  let second;
  try {
    await expect(first.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(fs.readFileSync(stage, 'utf8')).toBe('recoverable stage');
    expect(fs.existsSync(marker)).toBe(false);
    fs.unlinkSync(stage);
    second = launch('recovered'); second.ready.catch(() => {}); second.completion.catch(() => {});
    await second.ready;
    await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8')).toBe('started'));
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
  } finally {
    for (const controller of [first, second].filter(Boolean)) controller.stop('test-cleanup');
    await Promise.all([first, second].filter(Boolean).map(controller => controller.completion.catch(() => null)));
  }
}, 30000);

it('偽造的共用鎖不得要求復原或中止其他 profile 的真 watchdog', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const victim = path.join(root, 'victim.mp4'), target = path.join(root, 'forged.mp4');
  const queueDir = path.join(root, 'victim-profile'), script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started');
  fs.writeFileSync(victim, 'victim previous'); fs.writeFileSync(target, 'target previous');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[3],'partial');fs.writeFileSync(process.argv[2],'started');setInterval(()=>{},1000);");
  const shared = prepareSharedLeaseRoot(root);
  const owner = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, victim], cwd: root,
    outPath: victim, queueDir, jobId: 'victim', outputAuthority: captureOutputAuthority(victim, captureOutputDirectory(root)) });
  owner.ready.catch(() => {}); owner.completion.catch(() => {});
  let contender;
  try {
    await owner.ready;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    const victimLease = listLeases(queueDir)[0].owner;
    const victimShared = listLeases(shared.sharedQueueDir).find(entry => entry.owner.token === victimLease.token).owner;
    acquireLease({ queueDir: shared.sharedQueueDir, outPath: target, token: victimLease.token, jobId: 'forged',
      watchdogPid: 2147483647, outputStarted: false, aliasOf: victimShared.aliasOf });
    contender = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, target], cwd: root,
      outPath: target, queueDir: path.join(root, 'other-profile'), jobId: 'contender',
      outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)) });
    contender.ready.catch(() => {}); contender.completion.catch(() => {});
    await expect(contender.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(owner.child.exitCode).toBe(null);
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim previous');
  } finally {
    for (const controller of [owner, contender].filter(Boolean)) controller.stop('test-cleanup');
    await Promise.all([owner, contender].filter(Boolean).map(controller => controller.completion.catch(() => null)));
    await Promise.all([owner, contender].filter(Boolean).map(controller => vi.waitFor(() => expect(controller.child.exitCode != null || controller.child.signalCode != null).toBe(true))));
  }
}, 30000);

it('原 profile 佇列根目錄被替換後不復原共用鎖', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'replaced-root.mp4'), queueDir = path.join(root, 'old-profile');
  fs.writeFileSync(target, 'previous'); fs.mkdirSync(path.join(queueDir, 'output-leases'), { recursive: true });
  const shared = prepareSharedLeaseRoot(root), token = 'root-replacement-token';
  const authority = captureOutputAuthority(target, captureOutputDirectory(root)), primary = normalizeOutputPath(authority.outPath);
  const queueAuthority = captureOutputAuthority(path.join(queueDir, 'output-leases', '.subtool-queue-proof'), captureOutputDirectory(queueDir));
  acquireLease({ queueDir: shared.sharedQueueDir, outPath: primary, token, jobId: 'old', watchdogPid: 2147483647,
    outputStarted: false, aliasOf: { version: 1, queueDir, outPath: primary, key: outputKey(primary),
      stagePath: stagePathForCanonical(primary, token), outputAuthority: authority, queueAuthority } });
  fs.renameSync(queueDir, `${queueDir}-displaced`); fs.mkdirSync(path.join(queueDir, 'output-leases'), { recursive: true });
  const result = await recoverExportLeases(shared.sharedQueueDir, { pipeAttempts: 1 });
  expect(result.warnings).toHaveLength(1);
  expect(listLeases(shared.sharedQueueDir)).toHaveLength(1);
  expect(fs.readFileSync(target, 'utf8')).toBe('previous');
});

it('共用鎖根目錄遭替換時不得發布，保留原輸出與已完成暫存成品', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'lost-lock.mp4'), queueDir = path.join(root, 'queue');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt'), gate = path.join(root, 'gate');
  fs.writeFileSync(target, 'previous');
  fs.writeFileSync(script, "const fs=require('node:fs');const [marker,gate,out]=process.argv.slice(2);fs.writeFileSync(out,'completed');fs.writeFileSync(marker,'started');const t=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(t);process.exit(0)}},20);");
  const shared = prepareSharedLeaseRoot(root);
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, gate, target], cwd: root,
    outPath: target, queueDir, jobId: 'lost-lock', outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    await controller.ready;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    fs.renameSync(shared.sharedQueueDir, `${shared.sharedQueueDir}-displaced`);
    fs.mkdirSync(path.join(shared.sharedQueueDir, 'output-leases'), { recursive: true });
    fs.writeFileSync(gate, 'finish');
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    expect(result.cleanup.retainedLease).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readFileSync(listLeases(queueDir)[0].owner.stagePath, 'utf8')).toBe('completed');
  } finally { controller.stop('test-cleanup'); await controller.completion.catch(() => null); }
}, 30000);

it('watchdog 在 writer 啟動與 PID 入鎖之間崩潰時保留兩個鎖', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'spawn-gap.mp4'), queueDir = path.join(root, 'queue');
  const script = path.join(root, 'writer.cjs'), shim = path.join(root, 'delay-owner.cjs');
  const marker = path.join(root, 'writer-pid'), paused = path.join(root, 'paused');
  fs.writeFileSync(target, 'previous');
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync(process.argv[3],'partial');fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);");
  fs.writeFileSync(shim, `const fs=require('node:fs'),cp=require('node:child_process'),rename=fs.renameSync,spawn=cp.spawn;
    cp.spawn=function(file,args,opts){return spawn.call(this,file,args,{...opts,detached:true});};
    fs.renameSync=function(src,dst){if(String(src).includes('.owner.')) {let data;try{data=JSON.parse(fs.readFileSync(src,'utf8'));}catch{}
      if(data && data.writerSpawnPending===false && data.ffmpegPid){fs.writeFileSync(${JSON.stringify(paused)},'paused');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}}
      return rename.call(this,src,dst);};`);
  const shared = prepareSharedLeaseRoot(root);
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, target], cwd: root,
    outPath: target, queueDir, jobId: 'spawn-gap', outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)) },
  { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${shim.replaceAll('\\', '/')}"`.trim() } });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  const controllerClosed = new Promise(resolve => controller.child.once('close', resolve));
  let writerPid, contender, contenderClosed;
  try {
    await vi.waitFor(() => { expect(fs.existsSync(paused)).toBe(true); expect(fs.existsSync(marker)).toBe(true); }, { timeout: 10000 });
    writerPid = Number(fs.readFileSync(marker, 'utf8'));
    expect(() => process.kill(writerPid, 0)).not.toThrow();
    const exited = new Promise(resolve => controller.child.once('exit', resolve));
    controller.child.kill('SIGKILL');
    await exited;
    const local = await recoverExportLeases(queueDir, { pipeAttempts: 1 });
    const common = await recoverExportLeases(shared.sharedQueueDir, { pipeAttempts: 1 });
    expect(local.warnings).toContainEqual(expect.objectContaining({ code: 'WRITER_START_UNCERTAIN' }));
    expect(common.warnings).toContainEqual(expect.objectContaining({ code: 'WRITER_START_UNCERTAIN' }));
    expect(listLeases(queueDir)).toHaveLength(1);
    expect(listLeases(shared.sharedQueueDir)).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    contender = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, target], cwd: root,
      outPath: target, queueDir: path.join(root, 'other-profile'), jobId: 'contender',
      outputAuthority: captureOutputAuthority(target, captureOutputDirectory(root)) });
    contenderClosed = new Promise(resolve => contender.child.once('close', resolve));
    contender.ready.catch(() => {}); contender.completion.catch(() => {});
    await expect(contender.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(Number(fs.readFileSync(marker, 'utf8'))).toBe(writerPid);
  } finally {
    const cleanupErrors = [];
    try {
      if (contender) {
        contender.stop('test-cleanup');
        await contender.completion.catch(() => null);
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      if (controller.child.exitCode == null && controller.child.signalCode == null) controller.child.kill('SIGKILL');
      await controller.completion.catch(() => null);
    } catch (error) { cleanupErrors.push(error); }
    try {
      // A failed assertion may happen before the test recorded the writer PID.
      // Do not remove the root when a detached writer cannot be identified.
      if (!writerPid && fs.existsSync(marker)) writerPid = Number(fs.readFileSync(marker, 'utf8'));
      if (!Number.isSafeInteger(writerPid) || writerPid <= 0) throw new Error('無法確認測試 writer PID');
      try { process.kill(writerPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await vi.waitFor(() => {
        try { process.kill(writerPid, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        throw new Error('測試 writer 尚未結束');
      }, { timeout: 5000 });
    } catch (error) { cleanupErrors.push(error); }
    try { await Promise.all([controllerClosed, ...(contenderClosed ? [contenderClosed] : [])]); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
      throw new AggregateError(cleanupErrors, `測試程序尚未安全結清，保留目錄 ${root}`);
    }
  }
}, 30000);

it.runIf(process.platform === 'win32')('兩份 reservation 均記錄真實 writer PID，重啟時等程序結束後才釋放', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Live Writer Target Filename.mp4'), queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const token = 'live-writer-token', authority = captureOutputAuthority(short, captureOutputDirectory(root));
  const primaryPath = normalizeOutputPath(authority.outPath);
  acquireLease({ queueDir, outPath: target, jobId: 'live', token, outputStarted: false,
    aliasOf: { version: 1, outPath: primaryPath, key: outputKey(primaryPath) } });
  acquireLease({ queueDir, outPath: primaryPath, jobId: 'live', token, outputStarted: false,
    stagePath: stagePathForCanonical(primaryPath, token), outputAuthority: authority });
  const writer = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),1200)'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise(resolve => writer.once('exit', resolve));
  try {
    updateLease({ queueDir, outPath: target, token, ffmpegPid: writer.pid });
    updateLease({ queueDir, outPath: primaryPath, token, ffmpegPid: writer.pid });
    const active = await recoverExportLeases(queueDir);
    expect(active.warnings.filter(warning => warning.code === 'EXPORT_PROCESS_RUNNING')).toHaveLength(2);
    expect(listLeases(queueDir)).toHaveLength(2);
    await exited;
    const recovered = await recoverExportLeases(queueDir);
    expect(recovered.warnings).toEqual([]);
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill();
    await exited;
  }
}, 30000);

it.runIf(process.platform === 'win32')('長短名 watchdog 同時啟動時原子保留同一現存目的檔', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Simultaneous Target Filename.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  const queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const controllers = [target, short].map((outPath, index) => spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, outPath], cwd: root, outPath, jobId: `concurrent-${index}`, queueDir,
    outputAuthority: captureOutputAuthority(outPath, captureOutputDirectory(root)) }));
  for (const controller of controllers) { controller.ready.catch(() => {}); controller.completion.catch(() => {}); }
  try {
    const results = await Promise.allSettled(controllers.map(controller => controller.ready));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'OUTPUT_BUSY' }) }),
    ]);
    await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1));
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
  }
  expect(listLeases(queueDir)).toEqual([]);
}, 30000);

it('不同 hardlink 目錄項及不同 symlink 可分別保留各自目的地', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'target.mp4'), hard = path.join(root, 'hard.mp4');
  const link1 = path.join(root, 'first-link.mp4'), link2 = path.join(root, 'second-link.mp4');
  fs.writeFileSync(target, 'original target');
  fs.linkSync(target, hard);
  fs.symlinkSync(target, link1, 'file');
  fs.symlinkSync(target, link2, 'file');
  expect(fs.statSync(target).ino).toBe(fs.statSync(hard).ino);
  expect(outputReservationEntry(target)).not.toBe(outputReservationEntry(hard));
  expect(outputReservationEntry(link1)).not.toBe(outputReservationEntry(target));
  expect(outputReservationEntry(link1)).not.toBe(outputReservationEntry(link2));
  const first = { id: 'first', status: 'queued', payload: { outPath: target } };
  const admission = createExportAdmission({ outputKeyFor: outputKey, currentJobs: () => [first] });
  expect(() => admission.assertOutputAvailable({ id: 'second', payload: { outPath: hard } })).not.toThrow();
  expect(() => admission.assertOutputAvailable({ id: 'third', payload: { outPath: link1 } })).not.toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('original target');
});

it.runIf(process.platform === 'win32')('最末 symlink 的長短名代表同一連結，但不指向目標的 reservation', context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'target.mp4');
  const link = path.join(root, 'A Very Long Symbolic Output Filename.mp4');
  fs.writeFileSync(target, 'source target');
  fs.symlinkSync(target, link, 'file');
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: link },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(link)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  expect(fs.lstatSync(short).isSymbolicLink()).toBe(true);
  expect(outputReservationEntry(short)).toBe(outputReservationEntry(link));
  expect(outputReservationEntry(short)).not.toBe(outputReservationEntry(target));
  const other = path.join(root, 'another-link.mp4');
  fs.symlinkSync(target, other, 'file');
  const first = { id: 'first', status: 'queued', payload: { outPath: link } };
  const admission = createExportAdmission({ outputKeyFor: outputKey, currentJobs: () => [first] });
  expect(() => admission.assertOutputAvailable({ id: 'second', payload: { outPath: short } }))
    .toThrow(expect.objectContaining({ code: 'OUTPUT_BUSY' }));
  expect(() => admission.assertOutputAvailable({ id: 'third', payload: { outPath: other } })).not.toThrow();
});

it.runIf(process.platform === 'win32')('短名 watchdog 取消時原 lease 與 canonical reservation 都依 owner 釋放', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Cancellation Target Filename.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  const queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, short],
    cwd: root, outPath: short, jobId: 'cancel', queueDir,
    outputAuthority: captureOutputAuthority(short, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    const ready = await controller.ready;
    const entries = listLeases(queueDir);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.valid && entry.owner.ffmpegPid === ready.ffmpegPid)).toBe(true);
    expect(entries.filter(entry => entry.owner.stagePath)).toHaveLength(1);
    expect(entries.filter(entry => !entry.owner.stagePath && entry.owner.outputStarted === false)).toHaveLength(1);
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
  }
  expect(listLeases(queueDir)).toEqual([]);
  expect(fs.readFileSync(target, 'utf8')).toBe('original target');
}, 30000);

it.runIf(process.platform === 'win32')('重啟可回收未寫入的 canonical reservation 與原始 reservation', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Restart Target Filename.mp4'), queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const token = 'recover-alias-token', authority = captureOutputAuthority(short, captureOutputDirectory(root));
  const primaryPath = normalizeOutputPath(authority.outPath);
  acquireLease({ queueDir, outPath: target, jobId: 'recover', token, outputStarted: false,
    aliasOf: { version: 1, outPath: primaryPath, key: outputKey(primaryPath) } });
  acquireLease({ queueDir, outPath: authority.outPath, jobId: 'recover', token, outputStarted: false,
    stagePath: stagePathForCanonical(authority.outPath, token), outputAuthority: authority });
  expect(listLeases(queueDir)).toHaveLength(2);
  const result = await recoverExportLeases(queueDir);
  expect(result.warnings).toEqual([]);
  expect(result.recovered).toHaveLength(2);
  expect(listLeases(queueDir)).toEqual([]);
  expect(fs.readFileSync(target, 'utf8')).toBe('original target');
}, 30000);

it.runIf(process.platform === 'win32')('輸出變更而保留成品時，重啟保持長短名雙鎖直到使用者移走成品', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Retained Target Filename.mp4'), queueDir = path.join(root, 'queue');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt'), gate = path.join(root, 'finish');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); const [marker,gate,out]=process.argv.slice(2); fs.writeFileSync(out,'partial'); fs.writeFileSync(marker,'started'); const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);fs.writeFileSync(out,'completed stage');process.exit(0)}},20);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, gate, short],
    cwd: root, outPath: short, jobId: 'retain', queueDir,
    outputAuthority: captureOutputAuthority(short, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  const exited = new Promise(resolve => controller.child.once('exit', resolve));
  try {
    await controller.ready;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    fs.writeFileSync(target, 'replacement target');
    fs.writeFileSync(gate, 'finish');
    const result = await controller.completion;
    expect(result.ok).toBe(false);
    await exited;
    const entries = listLeases(queueDir);
    expect(entries).toHaveLength(2);
    const primary = entries.find(entry => entry.owner.retainedResult);
    const alias = entries.find(entry => entry.owner.aliasOf);
    expect(primary.owner.retainedResult.code).toBe('DELIVERY_DESTINATION_CHANGED');
    expect(alias.owner.aliasOf.key).toBe(primary.key);
    expect(fs.readFileSync(primary.owner.stagePath, 'utf8')).toBe('completed stage');
    const firstRecovery = await recoverExportLeases(queueDir);
    expect(firstRecovery.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DELIVERY_DESTINATION_CHANGED' }),
      expect.objectContaining({ code: 'ALIAS_PRIMARY_RETAINED' }),
    ]));
    expect(listLeases(queueDir)).toHaveLength(2);
    fs.unlinkSync(primary.owner.stagePath);
    const secondRecovery = await recoverExportLeases(queueDir);
    expect(secondRecovery.warnings).toEqual([]);
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement target');
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
  }
}, 30000);

it.runIf(process.platform === 'win32')('原本不存在的長名工作已啟動後目的出現，短名不能另啟動 writer', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Newly Created Target Filename.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt'), queueDir = path.join(root, 'queue');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const start = (id, outPath) => spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, outPath], cwd: root, outPath, jobId: id, queueDir,
    outputAuthority: captureOutputAuthority(outPath, captureOutputDirectory(root)) });
  const first = start('first', target), controllers = [first];
  first.ready.catch(() => {}); first.completion.catch(() => {});
  try {
    await first.ready;
    fs.writeFileSync(target, 'external target');
    const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
      encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
    }).trim();
    const short = path.join(root, path.basename(rawShort));
    if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
    const second = start('second', short); controllers.push(second);
    second.ready.catch(() => {}); second.completion.catch(() => {});
    await expect(second.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(fs.readFileSync(target, 'utf8')).toBe('external target');
  } finally {
    for (const controller of controllers) controller.stop('test-cleanup');
    await Promise.all(controllers.map(controller => controller.completion.catch(() => null)));
  }
  expect(listLeases(queueDir)).toEqual([]);
}, 30000);

it.runIf(process.platform === 'win32')('watchdog 異常結束而 writer 尚存活時，重啟不提前釋放別名鎖', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Crash Recovery Target Filename.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt'), queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.writeFileSync(process.argv[2],'started'); setTimeout(()=>process.exit(0),1800);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, short],
    cwd: root, outPath: short, jobId: 'crash', queueDir,
    outputAuthority: captureOutputAuthority(short, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  const exited = new Promise(resolve => controller.child.once('exit', resolve));
  let writerPid;
  try {
    const ready = await controller.ready;
    writerPid = ready.ffmpegPid;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    controller.child.kill('SIGKILL');
    await exited;
    const processExists = () => { try { process.kill(writerPid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
    if (!processExists()) context.skip('此執行環境在 watchdog 終止時同步結束 writer');
    const recovery = await recoverExportLeases(queueDir, { pipeAttempts: 1 });
    expect(recovery.warnings.filter(warning => warning.code === 'EXPORT_PROCESS_RUNNING')).toHaveLength(2);
    expect(listLeases(queueDir)).toHaveLength(2);
    await vi.waitFor(() => expect(processExists()).toBe(false), { timeout: 7000, interval: 50 });
    const afterWriter = await recoverExportLeases(queueDir, { pipeAttempts: 1 });
    expect(afterWriter.warnings).toEqual([]);
    expect(listLeases(queueDir)).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    if (writerPid) await vi.waitFor(() => {
      try { process.kill(writerPid, 0); throw new Error('writer still running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, { timeout: 7000, interval: 50 }).catch(() => {});
  }
}, 30000);

it.runIf(process.platform === 'win32').each(['long-first', 'short-first'])('既有 %s 舊 lease 存在時不得以另一別名啟動 writer', async (order, context) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Legacy Delivery Filename.mp4');
  const script = path.join(root, 'writer.cjs');
  const marker = path.join(root, 'started.txt');
  const queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
  const oldPath = order === 'long-first' ? target : short;
  const newPath = order === 'long-first' ? short : target;
  acquireLease({ queueDir, outPath: oldPath, jobId: 'legacy', token: 'legacy-token' });
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, newPath], cwd: root, outPath: newPath, jobId: 'new', queueDir,
    outputAuthority: captureOutputAuthority(newPath, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    await expect(controller.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('original target');
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
    releaseLease({ queueDir, outPath: oldPath, token: 'legacy-token' });
  }
}, 30000);

it.runIf(process.platform === 'win32')('短名 primary 已被舊工作持有時，先取得的 canonical 鎖必須回滾', async context => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-output-alias-'));
  roots.push(root);
  const target = path.join(root, 'A Very Long Rollback Target Filename.mp4');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt');
  const queueDir = path.join(root, 'queue');
  fs.writeFileSync(target, 'original target');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync(process.argv[3],'partial'); fs.appendFileSync(process.argv[2],'writer\\n'); setInterval(()=>{},1000);");
  const rawShort = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SUBTOOL_ALIAS_TARGET).ShortPath'], {
    encoding: 'utf8', env: { ...process.env, SUBTOOL_ALIAS_TARGET: target },
  }).trim();
  const short = path.join(root, path.basename(rawShort));
  if (outputKey(short) === outputKey(target)) context.skip('此磁碟沒有提供可區分的 8.3 檔名');
  acquireLease({ queueDir, outPath: short, jobId: 'legacy', token: 'legacy-token' });
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath,
    args: [script, marker, short], cwd: root, outPath: short, jobId: 'new', queueDir,
    outputAuthority: captureOutputAuthority(short, captureOutputDirectory(root)) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  try {
    await expect(controller.ready).rejects.toMatchObject({ code: 'OUTPUT_BUSY' });
    await controller.completion.catch(() => null);
    const entries = listLeases(queueDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].owner.token).toBe('legacy-token');
    expect(entries[0].key).toBe(outputKey(short));
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
    releaseLease({ queueDir, outPath: short, token: 'legacy-token' });
  }
}, 30000);

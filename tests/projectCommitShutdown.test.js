import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { parse } = require('acorn');
const { fileCommitCoordinator } = require('../electron/file-commit-coordinator');
const { createAtomicProjectWriter } = require('../electron/project-file-authority-engine');

it('真 before-quit 等已受理的專案存檔完成及暫存檔收尾才退出，期間拒絕新提交', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-project-quit-'));
  const target = path.join(directory, 'project.subtool');
  fs.writeFileSync(target, '原專案');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const stageStarted = new Promise(resolve => { started = resolve; });
  const writer = createAtomicProjectWriter({ fsModule:{ ...fs, ...fs.promises, async open(file, flags, ...args) {
    if (flags === 'wx') { started(); await gate; }
    return fs.promises.open(file, flags, ...args);
  } } });
  const source = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
  const node = parse(source, { ecmaVersion:'latest', sourceType:'script' }).body.find(entry =>
    entry.expression?.callee?.object?.name === 'app' && entry.expression?.callee?.property?.name === 'on'
      && entry.expression.arguments?.[0]?.value === 'before-quit');
  let handler;
  const idle = () => ({ cancelAllAndWait:async () => {}, resume:async () => {} });
  const close = vi.fn(() => fileCommitCoordinator.close());
  const context = {
    app:{ on:(_event, callback) => { handler = callback; }, quit:vi.fn() },
    _quitReady:false, _quitSequenceStarted:false, _isAppQuitting:false, audioNormalizationJobs:new Map(),
    mediaProbe:null, ffmpegExecution:idle(), deliveryCapabilities:idle(), speechCompressionRuntime:idle(),
    vocalWaveformRuntime:idle(), mediaIngestCoordinator:idle(), mediaWaveformCoordinator:idle(),
    directoryOutput:{ close:async () => {}, resume:async () => {} },
    QueueManager:{ prepareForShutdown:async () => {}, cancelShutdown:async () => {} },
    clipAudioCache:{ waitForIdle:async () => {} }, clipFrameCache:{ waitForIdle:async () => {} },
    screenshotOutput:{ close:async () => {}, resume:async () => {} },
    fileCommitCoordinator:{ close, resume:() => fileCommitCoordinator.resume() },
    mpvHost:{ disposeAndWait:async () => {}, resume:async () => {} },
    mediaIntakeRuntime:{ close:async () => {}, resume:async () => {} },
    mainWin:null, dialog:{ showMessageBox:vi.fn() }, console, Promise,
  };
  vm.runInNewContext(source.slice(node.start, node.end), context);
  const write = writer(target, Buffer.from('新專案'));
  try {
    await stageStarted;
    handler({ preventDefault() {} });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(context.app.quit).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('原專案');
    await expect(writer(target, Buffer.from('遲到存檔'))).rejects.toMatchObject({ code:'FILE_COMMIT_CLOSED' });
    release();
    await write;
    await vi.waitFor(() => expect(context.app.quit).toHaveBeenCalledOnce());
    expect(fs.readFileSync(target, 'utf8')).toBe('新專案');
    expect(fs.readdirSync(directory)).toEqual(['project.subtool']);
  } finally {
    release();
    await write.catch(() => {});
    await fileCommitCoordinator.resume();
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

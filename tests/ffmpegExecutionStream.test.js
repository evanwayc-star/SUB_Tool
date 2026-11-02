import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createFFmpegExecution } = require('../electron/ffmpeg-execution-engine.js');
const { FileAuthority } = require('../electron/file-authority.js');
const { createIpcGuards } = require('../electron/ipc-guards.js');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup(kind, { chunks = [], code = 0, stage, signal = null, shouldSend, observers = {}, fsModule = fs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-ffmpeg-stream-'));
  roots.push(root);
  const queueDir = path.join(root, 'queue');
  const sent = [], progress = [], stderr = [];
  let nativeChild;
  const failure = Object.assign(new Error('native startup failed'), { code: 'ENOENT' });
  const execution = createFFmpegExecution({
    fs: fsModule,
    getFFmpegPath: () => stage === 'missing' ? null : 'fake-ffmpeg',
    getUserDataDir: () => root,
    getQueueDir: () => queueDir,
    getSharedOutputLock: () => ({ sharedQueueDir: path.join(root, 'shared'), sharedAuthority: {} }),
    ensureQueueDir: () => fs.mkdirSync(queueDir, { recursive: true }),
    onLogRetained: file => observers.logRetained?.(file),
    send: (sender, event, data) => {
      sent.push({ sender, event, data });
      return observers.send?.(data);
    },
    spawnDirect() {
      if (stage === 'throw') throw failure;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      nativeChild = child;
      if (stage === 'hold') return child;
      queueMicrotask(() => {
        for (const chunk of chunks) child.stderr.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (stage === 'error') child.emit('error', failure);
        child.emit('close', code, signal);
        child.emit('close', code, signal); // duplicate native notification must remain idempotent
      });
      return child;
    },
    spawnWatchdog(config, handlers) {
      if (stage === 'throw') throw failure;
      return {
        ready: Promise.resolve(),
        completion: new Promise((resolve, reject) => queueMicrotask(() => {
          for (const chunk of chunks) handlers.onStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (stage === 'error') reject(failure);
          else resolve({ ok: code === 0, code });
        })),
      };
    },
  });
  return { root, sent, progress, stderr, failure, execution, get child() { return nativeChild; },
    run: () => execution.execute(['-i', 'mother.mxf', path.join(root, 'out.mp4')], {
      executionKind: kind, duration: 10, jobId: 'ingest', label: '轉檔預覽影片',
      outPath: path.join(root, 'out.mp4'), sender: { id: 7 }, shouldSend,
      onProgress: value => { progress.push(value); return observers.progress?.(value); },
      onStderr: value => { stderr.push(value); return observers.stderr?.(value); },
    }),
  };
}

describe('public FFmpeg execution terminal and pipe records', () => {
  it('direct 可將受持有的輸入與輸出 fd 分別交給 stdin 與 stdout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-input-fd-')); roots.push(root);
    const input=fs.openSync(path.join(root,'input.wav'),'wx+'),output=fs.openSync(path.join(root,'output.mp3'),'wx+');
    let spawned;
    const engine=createFFmpegExecution({getFFmpegPath:()=> 'fake',getUserDataDir:()=>root,
      spawnDirect(_exe,args,options){spawned={args,options};const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
        queueMicrotask(()=>child.emit('close',0,null));return child;}});
    try{
      const args=['-f','wav','-i','fd:','-f','mp3','fd:'];
      await engine.execute(args,{executionKind:'direct',inputDescriptor:input,outputDescriptor:output});
      expect(spawned).toEqual({args,options:{stdio:[input,output,'pipe']}});
      fs.writeSync(input,Buffer.from('still-open'));fs.writeSync(output,Buffer.from('still-open'));
    }finally{fs.closeSync(input);fs.closeSync(output);}
  });

  it.each([0,1,2,-1,2.5,NaN,Infinity,'3',null])('拒絕無效 inputDescriptor %s，不啟動子程序',async inputDescriptor=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-invalid-input-fd-'));roots.push(root);
    let calls=0;
    const engine=createFFmpegExecution({getFFmpegPath:()=> 'fake',getUserDataDir:()=>root,
      spawnDirect(){calls++;throw new Error('must not spawn');}});
    await expect(engine.execute(['-f','wav','-i','fd:','out.mp3'],{executionKind:'direct',inputDescriptor})).rejects.toThrow(/inputDescriptor/);
    expect(calls).toBe(0);
  });

  it('不得將 inputDescriptor 用於 queued-delivery、不同輸入路徑或同一輸出 fd',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-input-fd-invalid-use-'));roots.push(root);
    let calls=0;
    const engine=createFFmpegExecution({getFFmpegPath:()=> 'fake',getUserDataDir:()=>root,getQueueDir:()=>root,
      spawnDirect(){calls++;throw new Error('must not spawn');},spawnWatchdog(){calls++;throw new Error('must not spawn');}});
    await expect(engine.execute(['-i','fd:','out.mp3'],{executionKind:'queued-delivery',jobId:'q',outPath:path.join(root,'out.mp3'),inputDescriptor:3})).rejects.toThrow(/inputDescriptor/);
    await expect(engine.execute(['-i','other.wav','out.mp3'],{executionKind:'direct',inputDescriptor:3})).rejects.toThrow(/inputDescriptor/);
    await expect(engine.execute(['-i','fd:','-f','mp3','fd:'],{executionKind:'direct',inputDescriptor:3,outputDescriptor:3})).rejects.toThrow(/inputDescriptor/);
    expect(calls).toBe(0);
  });

  it('direct 將呼叫方持有的輸出 fd 映射到 child stdout，close 後 fd 仍可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-fd-spawn-')); roots.push(root);
    const output = path.join(root, 'reserved.wav');
    const fd = fs.openSync(output, 'wx+');
    let spawned;
    const engine = createFFmpegExecution({ getFFmpegPath: () => 'fake', getUserDataDir: () => root,
      spawnDirect(_exe, args, options) {
        spawned = { args, options };
        const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => child.emit('close', 0, null)); return child;
      } });
    try {
      await engine.execute(['-f', 'wav', 'fd:'], { executionKind: 'direct', outputDescriptor: fd, cwd: root });
      expect(spawned).toEqual({ args: ['-f', 'wav', 'fd:'], options: { cwd: root, stdio: ['ignore', fd, 'pipe'] } });
      fs.writeSync(fd, Buffer.from('OWNER STILL OPEN'));
      expect(fs.readFileSync(output, 'utf8')).toBe('OWNER STILL OPEN');
    } finally { fs.closeSync(fd); }
  });

  it.each([0, 1, 2, -1, 2.5, NaN, Infinity, '3', null])('拒絕無效 outputDescriptor %s，不啟子程序', async outputDescriptor => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-invalid-fd-')); roots.push(root);
    let calls = 0;
    const engine = createFFmpegExecution({ getFFmpegPath: () => 'fake', getUserDataDir: () => root,
      spawnDirect() { calls++; throw new Error('must not spawn'); } });
    await expect(engine.execute([], { executionKind: 'direct', outputDescriptor })).rejects.toThrow(/outputDescriptor/);
    expect(calls).toBe(0);
  });

  it('queued-delivery 不接受 outputDescriptor，亦不得啟動 watchdog', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-queued-fd-')); roots.push(root);
    let calls = 0;
    const engine = createFFmpegExecution({ getFFmpegPath: () => 'fake', getQueueDir: () => root,
      getUserDataDir: () => root, spawnWatchdog() { calls++; throw new Error('must not spawn'); } });
    await expect(engine.execute([], { executionKind: 'queued-delivery', jobId: 'q',
      outPath: path.join(root, 'out.mp4'), outputDescriptor: 3 })).rejects.toThrow(/outputDescriptor/);
    expect(calls).toBe(0);
  });

  it('指定 outputDescriptor 時不接受路徑輸出，避免失權後退回路徑寫入', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-fd-path-')); roots.push(root);
    let calls = 0;
    const engine = createFFmpegExecution({ getFFmpegPath: () => 'fake', getUserDataDir: () => root,
      spawnDirect() { calls++; throw new Error('must not spawn'); } });
    await expect(engine.execute(['-y', path.join(root, 'out.wav')],
      { executionKind: 'direct', outputDescriptor: 3 })).rejects.toThrow(/outputDescriptor/);
    expect(calls).toBe(0);
  });
  it('queued 重試不覆寫同名外來檔，兩次失敗各保留獨立診斷', async () => {
    const fixture = setup('queued-delivery', { code: 1, chunks: ['OWN_NATIVE_DIAGNOSTIC\n'] });
    const queueDir = path.join(fixture.root, 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    const foreignPath = path.join(queueDir, 'ingest.log');
    fs.writeFileSync(foreignPath, 'FOREIGN_BYTES');
    const first = await fixture.run().catch(error => error);
    const second = await fixture.run().catch(error => error);
    expect(fs.readFileSync(foreignPath, 'utf8')).toBe('FOREIGN_BYTES');
    const firstPath = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(first.message)?.[1];
    const secondPath = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(second.message)?.[1];
    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(firstPath).not.toBe(secondPath);
    expect(fs.readFileSync(firstPath, 'utf8')).toContain('OWN_NATIVE_DIAGNOSTIC');
    expect(fs.readFileSync(secondPath, 'utf8')).toContain('OWN_NATIVE_DIAGNOSTIC');
  });
  it.each(['direct', 'queued-delivery'].flatMap(kind => [0, 1].map(code => [kind, code])))(
    '%s close 後記錄被同名替換時，結束碼 %s 不讀取、刪除或發布外來記錄', async (kind, code) => {
      const retained = [];
      const foreign = 'FOREIGN_PRIVATE_CONTENT\nUnknown encoder foreign-only\n';
      let logPath, original;
      const fixture = setup(kind, { code, chunks: ['OWN_NATIVE_DIAGNOSTIC\n'], fsModule: {
        ...fs,
        createWriteStream(file, options) {
          logPath = file;
          original = `${file}.original`;
          const stream = fs.createWriteStream(file, options);
          stream.once('close', () => {
            fs.renameSync(file, original);
            fs.writeFileSync(file, foreign);
          });
          return stream;
        },
      }, observers: { logRetained: file => retained.push(file) } });
      const outcome = await fixture.run().then(result => ({ result }), error => ({ error }));
      expect(fs.readFileSync(logPath, 'utf8')).toBe(foreign);
      expect(fs.readFileSync(original, 'utf8')).toContain('OWN_NATIVE_DIAGNOSTIC');
      expect(retained).toEqual([]);
      if (code === 0) expect(outcome.error).toBeUndefined();
      else {
        expect(outcome.error.code).toBe('FFMPEG_EXIT');
        expect(outcome.error.message).toContain('OWN_NATIVE_DIAGNOSTIC');
        expect(outcome.error.message).not.toContain('FOREIGN_PRIVATE_CONTENT');
        expect(outcome.error.message).not.toContain('foreign-only');
        expect(outcome.error.message).not.toContain('[LOG_PATH]');
      }
    },
  );

  it.each([0, 1])('direct log EEXIST 時結束碼 %s 不讀取、刪除或授權外來記錄', async code => {
    const authority = new FileAuthority();
    const reads = [], deletes = [], openErrors = [];
    const foreign = 'FOREIGN_PRIVATE_CONTENT\nUnknown encoder foreign-only\n';
    let logPath;
    const fixture = setup('direct', { code, chunks: ['OWN_NATIVE_DIAGNOSTIC\n'], fsModule: {
      ...fs,
      createWriteStream(file, options) {
        logPath = file;
        fs.writeFileSync(file, foreign);
        const stream = fs.createWriteStream(file, options);
        stream.on('error', error => openErrors.push(error.code));
        return stream;
      },
      readFileSync(file, ...args) { reads.push(file); return fs.readFileSync(file, ...args); },
      unlink(file, callback) { deletes.push(file); return fs.unlink(file, callback); },
    }, observers: { logRetained: file => authority.grantDiagnosticLogFile(file) } });
    const outcome = await fixture.run().then(result => ({ result }), error => ({ error }));
    expect(openErrors).toEqual(['EEXIST']);
    expect(reads).toEqual([]);
    expect(deletes).toEqual([]);
    expect(fs.readFileSync(logPath, 'utf8')).toBe(foreign);
    expect(authority.canOpenQueueLog(logPath)).toBe(false);
    if (code === 0) expect(outcome.result.tail).toBe('OWN_NATIVE_DIAGNOSTIC\n');
    else {
      expect(outcome.error.code).toBe('FFMPEG_EXIT');
      expect(outcome.error.message).toContain('OWN_NATIVE_DIAGNOSTIC');
      expect(outcome.error.message).toContain('EEXIST');
      expect(outcome.error.message).not.toContain('FOREIGN_PRIVATE_CONTENT');
      expect(outcome.error.message).not.toContain('[LOG_PATH]');
    }
  });

  it('direct 失敗記錄只在自身檔案 close 後取得精確 shell 開啟資格', async () => {
    const authority = new FileAuthority();
    const observed = [];
    const fixture = setup('direct', { code: 1, chunks: ['Unknown encoder\n'], observers: {
      logRetained(file) {
        observed.push(fs.readFileSync(file, 'utf8'));
        authority.grantDiagnosticLogFile(file);
      },
    } });
    authority.grantQueueLogDirectory(path.join(fixture.root, 'queue'));
    const failure = await fixture.run().catch(error => error);
    const file = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(failure.message)[1];
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('Unknown encoder\n');
    const guard = createIpcGuards(authority);
    expect(() => guard.requirePermittedShellOpenPath(file)).not.toThrow();
    expect(authority.canOpenQueueLog(path.join(fixture.root, 'another.log'))).toBe(false);
    expect(authority.canRead(file)).toBe(false);
    expect(authority.canWrite(file)).toBe(false);
  });

  it('成功刪除的 direct 記錄從未獲得開啟資格，同路徑重建亦拒絕', async () => {
    const authority = new FileAuthority();
    let logPath;
    const fixture = setup('direct', { fsModule: { ...fs, createWriteStream(file, options) {
      logPath = file;
      return fs.createWriteStream(file, options);
    } }, observers: { logRetained: file => authority.grantDiagnosticLogFile(file) } });
    await fixture.run();
    expect(fs.existsSync(logPath)).toBe(false);
    fs.writeFileSync(logPath, 'unrelated replacement');
    expect(authority.canOpenQueueLog(logPath)).toBe(false);
  });

  it('direct 記錄無法開檔不授權路徑，保留 native 失敗', async () => {
    const retained = [];
    const fixture = setup('direct', { code: 1, fsModule: { ...fs, createWriteStream(file, options) {
      return fs.createWriteStream(path.join(file, 'missing-parent', 'diagnostic.log'), options);
    } }, observers: { logRetained: file => retained.push(file) } });
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_EXIT' });
    expect(retained).toEqual([]);
  });

  it('保留記錄的 observer 拋錯不能取代原生失敗或遺失完整診斷', async () => {
    const fixture = setup('direct', { code: 1, chunks: ['Unknown encoder\n'], observers: {
      logRetained() { throw new Error('observer failure'); },
    } });
    const failure = await fixture.run().catch(error => error);
    expect(failure.code).toBe('FFMPEG_EXIT');
    expect(failure.message).toContain('Unknown encoder');
    const file = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(failure.message)[1];
    expect(fs.readFileSync(file, 'utf8')).toContain('Unknown encoder\n');
  });

  it.each([0, 1])('同毫秒同類 direct 工作的記錄各自持有，第一份結束碼 %s 不混入或刪除第二份診斷', async firstCode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-ffmpeg-stream-'));
    roots.push(root);
    const children = [], logPaths = [];
    const execution = createFFmpegExecution({
      now: () => 1780000000000,
      getFFmpegPath: () => 'fake-ffmpeg',
      getUserDataDir: () => root,
      fs: { ...fs, createWriteStream(file, options) {
        logPaths.push(file);
        return fs.createWriteStream(file, options);
      } },
      spawnDirect() {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        children.push(child);
        return child;
      },
    });
    const run = source => execution.execute(['-i', source, 'output.mp3'], {
      executionKind: 'direct', jobId: 'speech-compress',
    }).then(result => ({ result }), error => ({ error }));
    const first = run('first.wav'), second = run('second.wav');
    children[0].stderr.emit('data', Buffer.from('FIRST_PRIVATE_DIAGNOSTIC\n'));
    children[1].stderr.emit('data', Buffer.from('SECOND_PRIVATE_DIAGNOSTIC\n'));
    children[0].emit('close', firstCode);
    const firstResult = await first;
    children[1].stderr.emit('data', Buffer.from('SECOND_LATE_FAILURE\n'));
    children[1].emit('close', 1);
    const secondResult = await second;
    expect(logPaths[0]).not.toBe(logPaths[1]);
    const secondLog = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(secondResult.error.message)[1];
    expect(secondLog).toBe(logPaths[1]);
    expect(fs.readFileSync(secondLog, 'utf8')).toBe(
      '> ffmpeg -i second.wav output.mp3\n\nSECOND_PRIVATE_DIAGNOSTIC\nSECOND_LATE_FAILURE\n',
    );
    if (firstCode === 0) {
      expect(firstResult.result).toBeDefined();
      expect(fs.existsSync(logPaths[0])).toBe(false);
    } else {
      const firstLog = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(firstResult.error.message)[1];
      expect(firstLog).toBe(logPaths[0]);
      expect(fs.readFileSync(firstLog, 'utf8')).toBe(
        '> ffmpeg -i first.wav output.mp3\n\nFIRST_PRIVATE_DIAGNOSTIC\n',
      );
    }
  });

  it.each(['direct', 'queued-delivery'].flatMap(kind => [0, 1].map(code => [kind, code])))(
    '%s native code %s cannot settle before the diagnostic log descriptor closes', async (kind, code) => {
      let releaseClose, closed, requested;
      const closeRequested = new Promise(resolve => { requested = resolve; });
      const closeCompleted = new Promise(resolve => { closed = resolve; });
      const fixture = setup(kind, { code, fsModule: {
        ...fs,
        createWriteStream(filename, options) {
          return fs.createWriteStream(filename, { ...options, fs: {
            open: fs.open, write: fs.write,
            close(fd, callback) {
              releaseClose = () => fs.close(fd, error => { callback(error); closed(); });
              requested();
            },
          } });
        },
      } });
      let settled = false;
      const work = fixture.run().then(
        value => { settled = true; return value; },
        error => { settled = true; return error; },
      );
      try {
        await closeRequested;
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(fixture.sent.some(item => item.data.done)).toBe(false);
      } finally {
        releaseClose();
        await closeCompleted;
        await work;
      }
      expect(settled).toBe(true);
      expect(fixture.sent.at(-1).data.outcome).toBe(code === 0 ? 'success' : 'failed');
    },
  );

  it.each(['direct', 'queued-delivery'])('%s completes diagnostic log deletion before publishing completion', async kind => {
    let observedDeletion = false;
    const fixture = setup(kind, { fsModule: {
      ...fs,
      unlinkSync(filename) {
        if (filename.endsWith('.discard') && path.basename(filename).startsWith('.subtool-log-')) {
          observedDeletion = true;
          expect(fixture.sent.some(item => item.data.done)).toBe(false);
        }
        return fs.unlinkSync(filename);
      },
    } });
    await fixture.run();
    expect(observedDeletion).toBe(true);
    expect(fs.readdirSync(fixture.root, { recursive: true }).filter(file => file.endsWith('.log'))).toEqual([]);
    expect(fixture.sent.at(-1).data.outcome).toBe('success');
  });

  it('a real diagnostic stream open error closes safely and preserves native success', async () => {
    const fixture = setup('direct', { fsModule: {
      ...fs,
      createWriteStream(filename, options) {
        return fs.createWriteStream(path.join(filename, 'missing-parent', 'diagnostic.log'), options);
      },
    } });
    await expect(fixture.run()).resolves.toMatchObject({ maps: [] });
    expect(fixture.sent.at(-1).data.outcome).toBe('success');
  });

  it.each(['direct', 'queued-delivery'].flatMap(kind => ['data', 'EOF'].flatMap(phase =>
    ['send', 'progress', 'stderr'].map(observer => [kind, phase, observer]))))(
    '%s isolates throwing %s %s observers while retaining native success and parsed records',
    async (kind, phase, observer) => {
      const fixture = setup(kind, {
        chunks: ['Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))\n',
          `time=00:00:05.00 speed=1.0x${phase === 'data' ? '\n' : ''}`],
        observers: { [observer]: () => { throw new Error('observer failed'); } },
      });
      const result = await fixture.run();
      expect(result.maps).toEqual(['h264 (native) -> h264 (libx264)']);
      expect(result.tail).toContain('time=00:00:05.00');
      expect(fixture.progress).toContainEqual(expect.objectContaining({ pct: 50 }));
      expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['success']);
      expect(fixture.progress.filter(item => item.done)).toHaveLength(kind === 'direct' ? 1 : 0);
    },
  );

  it.each(['direct', 'queued-delivery'])('%s observer rejections cannot become unhandled or replace a native failure', async kind => {
    const rejectObserver = () => Promise.reject(new Error('async observer failed'));
    const fixture = setup(kind, { code: 1, chunks: ['Unknown encoder\ntime=00:00:05.00'],
      observers: { send: rejectObserver, progress: rejectObserver, stderr: rejectObserver } });
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_EXIT',
      message: expect.stringContaining('Unknown encoder') });
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['failed']);
  });

  it('throwing observers cannot complete a direct writer or its shutdown before native close', async () => {
    const fail = () => { throw new Error('observer failed'); };
    const fixture = setup('direct', { stage: 'hold', observers: { send: fail, progress: fail, stderr: fail } });
    let completed = false, closed = false;
    const work = fixture.run().finally(() => { completed = true; }).catch(error => error);
    expect(() => fixture.child.stderr.emit('data', Buffer.from('time=00:00:05.00\n'))).not.toThrow();
    const closing = fixture.execution.cancelAllAndWait().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(closed).toBe(false);
    fixture.child.emit('close', 0);
    await expect(work).resolves.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    await closing;
    expect(fixture.execution.resume()).toBe(true);
  });

  it.each(['direct', 'queued-delivery'])('%s nonzero close emits one failed terminal, never success', async kind => {
    const fixture = setup(kind, { code: 1, chunks: ['Output container does not support this codec\n'] });
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_EXIT' });
    expect(fixture.sent.filter(item => item.data.done)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ done: true, outcome: 'failed', errorCode: 'FFMPEG_EXIT' }) }),
    ]);
    expect(fixture.sent.some(item => item.data.done && item.data.outcome === 'success')).toBe(false);
  });

  it.each(['missing', 'throw', 'error'])('direct %s failure also emits one failed terminal', async stage => {
    const fixture = setup('direct', { stage });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.filter(item => item.data.done)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ done: true, outcome: 'failed' }) }),
    ]);
    expect(fixture.progress.filter(item => item.done)).toHaveLength(1);
  });

  it.each(['throw', 'error'])('watchdog %s failure emits a terminal but no fake artifact completion callback', async stage => {
    const fixture = setup('queued-delivery', { stage });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.filter(item => item.data.done)).toHaveLength(1);
    expect(fixture.sent.at(-1).data.outcome).toBe('failed');
    expect(fixture.progress.some(item => item.done)).toBe(false);
  });

  it('signal termination cannot report success even with code zero', async () => {
    const fixture = setup('direct', { signal: 'SIGTERM' });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent.at(-1).data).toMatchObject({ done: true, outcome: 'failed' });
  });

  it('shutdown cancellation and admission rejection both report failed once, even after code-zero close', async () => {
    const fixture = setup('direct', { stage: 'hold' });
    const work = fixture.run().catch(error => error);
    const closing = fixture.execution.cancelAllAndWait();
    fixture.child.emit('close', 0);
    await expect(work).resolves.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    await closing;
    expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['failed']);
    await expect(fixture.run()).rejects.toMatchObject({ code: 'FFMPEG_SHUTTING_DOWN' });
    expect(fixture.sent.filter(item => item.data.done).map(item => item.data.outcome)).toEqual(['failed', 'failed']);
  });

  it('successful direct child emits one shared success terminal after EOF progress', async () => {
    const fixture = setup('direct', { chunks: ['frame=25 time=00:00:05.00 speed=1.0x'] });
    await fixture.run();
    expect(fixture.sent.filter(item => item.data.done)).toHaveLength(1);
    expect(fixture.progress.at(-2)).toMatchObject({ pct: 50 });
    expect(fixture.progress.at(-1)).toMatchObject({ done: true, outcome: 'success', pct: 100 });
  });

  it('queued callbacks remain encode progress until the artifact owner publishes', async () => {
    const fixture = setup('queued-delivery', { chunks: ['frame=25 time=00:00:05.00 speed=1.0x\r'] });
    await fixture.run();
    expect(fixture.progress).toEqual([expect.objectContaining({ pct: 50 })]);
    expect(fixture.progress.some(item => item.done || item.pct === 100)).toBe(false);
  });

  it('stale sender suppression also applies to failed terminal notifications', async () => {
    const fixture = setup('direct', { code: 1, shouldSend: () => false });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.sent).toEqual([]);
    expect(fixture.progress.at(-1)).toMatchObject({ done: true, outcome: 'failed' });
  });

  it.each(['direct', 'queued-delivery'])('%s retains stream maps and progress across arbitrary pipe chunks', async kind => {
    const fixture = setup(kind, { chunks: [
      'Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_',
      'nvenc))\nframe= 150 ti',
      'me=00:00:05.00 speed=2.0x\r',
    ] });
    const result = await fixture.run();
    expect.soft(result.maps).toEqual(['h264 (native) -> h264 (h264_nvenc)']);
    expect(fixture.progress).toContainEqual(expect.objectContaining({ pct: 50, etaS: 2.5 }));
  });

  it.each(['direct', 'queued-delivery'])('%s reports latest complete progress when one chunk has multiple CR records', async kind => {
    const fixture = setup(kind, { chunks: ['frame=30 time=00:00:01.00 speed=1.0x\rframe=240 time=00:00:08.00 speed=2.0x\r'] });
    await fixture.run();
    expect(fixture.progress.filter(item => !item.done).at(-1)).toMatchObject({ pct: 80, etaS: 2 / 1.5 });
  });

  it.each(['direct', 'queued-delivery'])('%s preserves split UTF8 diagnostics and parses last record without newline', async kind => {
    const bytes = Buffer.from('來源字幕測試\nStream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))\r\nframe=150 time=00:00:05.00 speed=2.0x');
    const fixture = setup(kind, { chunks: [...bytes].map(value => Buffer.from([value])) });
    const result = await fixture.run();
    expect(result.maps).toEqual(['h264 (native) -> h264 (libx264)']);
    expect(result.tail).toBe(bytes.toString());
    expect(fixture.stderr.join('')).toBe(bytes.toString());
    expect(fixture.progress).toContainEqual(expect.objectContaining({ pct: 50, etaS: 2.5 }));
  });

  it.each(['direct', 'queued-delivery'])('%s flushes complete EOF map but rejects a truncated map ending at an inner parenthesis', async kind => {
    const partial = setup(kind, { chunks: ['Stream #0:0 -> #0:0 (h264 (native)'] });
    expect((await partial.run()).maps).toEqual([]);
    const complete = setup(kind, { chunks: ['Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))'] });
    expect((await complete.run()).maps).toEqual(['h264 (native) -> h264 (libx264)']);
  });

  it.each(['direct', 'queued-delivery'])('%s discards an oversized incomplete record and recovers at the next delimiter', async kind => {
    const fixture = setup(kind, { chunks: [
      'noise'.repeat(20000), 'time=00:00:09.00 speed=1.0x\r',
      'frame=150 time=00:00:05.00 speed=2.0x\n',
    ] });
    await fixture.run();
    expect(fixture.progress.filter(item => !item.done).map(item => item.pct)).toEqual([50]);
  });

  it('failure log retains original UTF8 bytes after parser framing', async () => {
    const bytes = Buffer.from('來源字幕測試\r\nUnknown encoder\n');
    const fixture = setup('direct', { code: 1, chunks: [...bytes].map(value => Buffer.from([value])) });
    const failure = await fixture.run().catch(error => error);
    const logPath = /\[LOG_PATH\](.*?)\[\/LOG_PATH\]/.exec(failure.message)[1];
    expect(fs.readFileSync(logPath).subarray(-bytes.length)).toEqual(bytes);
  });
});

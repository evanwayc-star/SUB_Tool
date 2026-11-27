import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createMpvHost } = require('../electron/mpv-host.js');
const { captureOutputDirectory } = require('../electron/export-lease.js');
const { parse } = require('acorn');

function setup(dir, { autoClose = true, rootAuthority, describeSource, subtitleReply } = {}) {
  const commands = [];
  const tracks = [];
  const children = [];
  const documents = [];
  class Window {
    constructor() { this.webContents = { executeJavaScript: async () => {} }; }
    isDestroyed() { return false; }
    getNativeWindowHandle() { return Buffer.alloc(8); }
    setIgnoreMouseEvents() {} setMenu() {} async loadURL(target) { if (target.startsWith('file:')) documents.push(url.fileURLToPath(target)); } setBounds() {}
    show() {} showInactive() {} moveTop() {} hide() {} destroy() {}
  }
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.write = raw => {
    const { command, request_id: id } = JSON.parse(raw);
    commands.push(command);
    const reply = (data, error='success') => queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({request_id:id, error, data})+'\n')));
    if (subtitleReply?.(command, reply, tracks)) return;
    if (command[0] === 'loadfile') {
      tracks.length = 0;
      queueMicrotask(() => socket.emit('data', Buffer.from('{"event":"start-file","playlist_entry_id":1}\n{"event":"file-loaded"}\n{"event":"playback-restart"}\n')));
    }
    if (command[0] === 'sub-add') tracks.push({type:'sub', external:true, 'external-filename':command[1], id:tracks.length+1, selected:true});
    if (id) reply(command[1] === 'track-list' ? tracks : command[0] === 'loadfile' ? { playlist_entry_id:1 } : command[1] === 'path' ? 'movie.mp4' : 1);
  };
  const host = createMpvHost({ BrowserWindow: Window, spawn: () => {
    const child = Object.assign(new EventEmitter(), { stderr:new PassThrough(), kill() { if (autoClose) queueMicrotask(() => child.emit('close', 0)); } });
    children.push(child); return child;
  },
    createConnection: () => { queueMicrotask(() => socket.emit('connect')); return socket; }, fs, path, url,
    getMainWindow: () => ({ isDestroyed: () => false, getContentBounds: () => ({ x:0, y:0 }) }),
    supported: () => true, findExecutable: () => 'mpv', ensureTmp: () => {}, tmpDir:dir, describeSource,
    tempFiles:new Set(), tempRootAuthority:rootAuthority, guideHtml:'guide content', now:() => 123, setTimer:() => 0, clearTimer:() => {} });
  return { host, commands, tracks, children, documents };
}

describe('mpv 暫存檔所有權', () => {
  it('同一畫格快速改樣式等待 mpv 讀完 ASS，再將最後一次修改套至專案字幕軌', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-subtitle-edit-'));
    let finishAdd;
    const { host, commands, tracks } = setup(dir, { subtitleReply(command, reply, currentTracks) {
      if (command[0] === 'sub-reload') {
        const track = currentTracks.find(t => t.id === command[1]);
        for (const t of currentTracks) t.selected = t === track;
        track.id = 6; // 另一條字幕還在時，mpv 會給重載的專案字幕新 ID 並選取。
        reply(null);
        return true;
      }
      if (command[0] !== 'sub-add' || finishAdd) return false;
      finishAdd = () => {
        currentTracks.push({ type:'sub', external:true, 'external-filename':command[1], id:4, selected:false });
        currentTracks.push({ type:'sub', external:false, id:5, selected:true });
        reply(null);
      };
      return true;
    } });
    try {
      const {sourceSessionId} = await host.launch({src:'movie.mp4'});
      const first = host.setSubtitles('white', sourceSessionId);
      await vi.waitFor(() => expect(finishAdd).toBeTypeOf('function'));
      const file = commands.find(c => c[0] === 'sub-add')[1];
      const second = host.setSubtitles('blue', sourceSessionId);
      const latest = host.setSubtitles('green', sourceSessionId);
      expect(fs.readFileSync(file, 'utf8')).toBe('white');
      finishAdd();
      expect(await first).toBe(false);
      expect(await second).toBe(false);
      expect(await latest).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('green');
      expect(tracks).toHaveLength(2);
      expect(tracks.filter(t => t.selected)).toEqual([expect.objectContaining({id:6,'external-filename':file})]);
      expect(commands.filter(c => c[0] === 'sub-reload')).toEqual([['sub-reload',4]]);
      expect(commands.filter(c => c[0] === 'set_property' && c[1] === 'sid')).toEqual([]);
    } finally { await host.disposeAndWait(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('mpv 拒絕重載但軌仍存在時重查 ID 再試；連續失敗不誤報成功或重複加軌', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-subtitle-retry-'));
    let failures = 1;
    const {host, commands, tracks} = setup(dir, {subtitleReply(command,reply,sourceTracks) {
      if (command[0] !== 'sub-reload' || failures <= 0) return false;
      failures--;
      sourceTracks[0].id++;
      reply(null,'error running command');
      return true;
    }});
    try {
      const {sourceSessionId} = await host.launch({src:'movie.mp4'});
      expect(await host.setSubtitles('initial',sourceSessionId)).toBe(true);
      expect(await host.setSubtitles('revised',sourceSessionId)).toBe(true);
      expect(commands.filter(c => c[0] === 'sub-reload')).toEqual([['sub-reload',1],['sub-reload',2]]);
      failures = 2;
      expect(await host.setSubtitles('later',sourceSessionId)).toBe(false);
      expect(await host.setSubtitles('recovered',sourceSessionId)).toBe(true);
      expect(tracks).toHaveLength(1);
      expect(commands.filter(c => c[0] === 'sub-add')).toHaveLength(1);
      expect(fs.readFileSync(tracks[0]['external-filename'],'utf8')).toBe('recovered');
    } finally { await host.disposeAndWait(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('換片期間和前一個來源的延遲樣式無法覆蓋新片；加入失敗後以最新內容重試', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-subtitle-source-'));
    let resumeProbe, failAdd = true;
    const {host, commands} = setup(dir, {describeSource:() => resumeProbe === null
      ? new Promise(resolve => { resumeProbe = resolve; }) : undefined, subtitleReply(command,reply) {
      if (command[0] !== 'sub-add' || !failAdd) return false;
      failAdd = false;
      reply(null,'error running command');
      return true;
    }});
    try {
      const first = await host.launch({src:'movie.mp4'});
      resumeProbe = null;
      const loading = host.loadFile('movie.mp4');
      expect(await host.setSubtitles('stale while loading',first.sourceSessionId)).toBe(false);
      resumeProbe();
      const next = await loading;
      expect(await host.setSubtitles('stale after load',first.sourceSessionId)).toBe(false);
      expect(commands.some(c => c[0] === 'sub-add')).toBe(false);
      expect(await host.setSubtitles('new style',next.sourceSessionId)).toBe(true);
      const adds = commands.filter(c => c[0] === 'sub-add');
      expect(adds).toHaveLength(2);
      expect(fs.readFileSync(adds[1][1],'utf8')).toBe('new style');
      expect(commands.some(c => c[0] === 'sub-reload')).toBe(false);
    } finally { await host.disposeAndWait(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('真 main 組裝把建立時 TMP authority 交給 host', () => {
    const source = fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
    const tree = parse(source,{ecmaVersion:'latest',sourceType:'script'});
    const declaration = tree.body.find(node=>node.type==='VariableDeclaration'
      && node.declarations.some(item=>item.id?.name==='mpvHost'));
    const owner = {identity:'original'};let received;
    vm.runInNewContext(source.slice(declaration.start,declaration.end),{
      createMpvHost:args=>{received=args;return {};},BrowserWindow:class {},spawn:()=>{},net:{createConnection(){}},
      fs,path,url,ensureTmp:()=>{},TMP:'unused',TMP_OWNER:owner,tempFiles:new Set(),MPV_GUIDE_HTML:'',fontsRoot:()=>{},
      console,
    });
    expect(received.tempRootAuthority).toBe(owner);
  });
  it('首次啟動前原始 TMP 被替換時不進入外來目錄', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-root-owner-test-'));
    const root = path.join(parent,'tmp'); fs.mkdirSync(root);
    const authority = captureOutputDirectory(root);
    const { host } = setup(root,{rootAuthority:authority});
    try {
      fs.renameSync(root,path.join(parent,'original')); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root,'sentinel'),'foreign');
      await expect(host.launch({src:'movie.mp4'})).rejects.toThrow();
      expect(fs.readdirSync(root)).toEqual(['sentinel']);
    } finally { await host.disposeAndWait(); fs.rmSync(parent,{recursive:true,force:true}); }
  });
  it('預先存在的 guide 與 log 不會被覆寫', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'mpv-guide.html'), 'foreign guide');
      fs.writeFileSync(path.join(dir, 'mpv-last.log'), 'foreign log');
      const oldSub = path.join(dir, `subtool-mpv-${process.pid}-2-123.ass`);
      fs.writeFileSync(oldSub, 'foreign subtitle');
      const { host } = setup(dir);
      await host.launch({ src:'movie.mp4' });
      await host.setSubtitles('字幕');
      await new Promise(resolve => setImmediate(resolve));
      await host.disposeAndWait();
      expect(fs.readFileSync(path.join(dir, 'mpv-guide.html'), 'utf8')).toBe('foreign guide');
      expect(fs.readFileSync(path.join(dir, 'mpv-last.log'), 'utf8')).toBe('foreign log');
      expect(fs.readFileSync(oldSub, 'utf8')).toBe('foreign subtitle');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('字幕檔被替換後不覆寫外部檔案', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      const { host, commands } = setup(dir);
      await host.launch({ src:'movie.mp4' });
      await host.setSubtitles('first');
      const file = commands.find(c => c[0] === 'sub-add')[1];
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'foreign subtitle');
      await host.setSubtitles('second');
      expect(fs.readFileSync(file, 'utf8')).toBe('foreign subtitle');
      const replacement = commands.filter(c => c[0] === 'sub-add').at(-1)[1];
      expect(replacement).not.toBe(file);
      expect(fs.readFileSync(replacement, 'utf8')).toBe('second');
      await host.setSubtitles('third');
      expect(fs.readFileSync(replacement, 'utf8')).toBe('third');
      expect(commands.at(-1)[0]).toBe('sub-reload');
      await host.disposeAndWait();
      expect(fs.readFileSync(file, 'utf8')).toBe('foreign subtitle');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('正常更新字幕、重啟並等待程序和記錄真正關閉後清理', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      const { host, commands, children, documents } = setup(dir, { autoClose:false });
      await host.launch({ src:'movie.mp4' });
      expect(fs.readFileSync(documents[0], 'utf8')).toBe('guide content');
      await host.setSubtitles('第一版');
      const first = commands.find(c => c[0] === 'sub-add')[1];
      await host.setSubtitles('第二版');
      expect(fs.readFileSync(first, 'utf8')).toBe('第二版');
      expect(commands.some(c => c[0] === 'sub-reload')).toBe(true);
      await host.launch({ src:'movie.mp4' });
      await host.setSubtitles('新播放器');
      const second = commands.filter(c => c[0] === 'sub-add').at(-1)[1];
      expect(second).not.toBe(first);
      expect(fs.readFileSync(second, 'utf8')).toBe('新播放器');
      let done = false;
      const stopping = host.disposeAndWait().then(result => { done = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      expect(done).toBe(false);
      children[0].emit('close', 0);
      children[1].emit('close', 0);
      expect(await stopping).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
      await expect(host.launch({ src:'movie.mp4' })).rejects.toThrow('已關閉');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('取消退出時舊 mpv 尚未 close，延後恢復直到清理完成', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-delayed-resume-test-'));
    const { host, children } = setup(dir,{autoClose:false});
    try {
      await host.launch({src:'movie.mp4'});
      const draining=host.disposeAndWait();
      expect(host.resume()).toBe(false);
      await expect(host.launch({src:'movie.mp4'})).rejects.toThrow('已關閉');
      children[0].emit('close',0);
      await draining;
      await expect(host.launch({src:'movie.mp4'})).resolves.toMatchObject({ok:true});
      children[1].emit('close',0);
    } finally { await host.disposeAndWait(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('guide 被替換後退出不刪除新檔', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      const { host, documents } = setup(dir);
      await host.launch({ src:'movie.mp4' });
      const file = documents[0];
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'foreign guide');
      expect(await host.disposeAndWait()).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('foreign guide');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('log 路徑遭替換時仍只寫入原來的開啟檔案，退出保留新檔', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      const { host, children } = setup(dir);
      await host.launch({ src:'movie.mp4' });
      const file = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.log')));
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'foreign log');
      expect(host.logPath()).toBeNull();
      children[0].stderr.write('original log');
      await new Promise(resolve => setImmediate(resolve));
      expect(await host.disposeAndWait()).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('foreign log');
      expect(fs.readFileSync(file + '.original', 'utf8')).toContain('original log');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('播放器意外結束後保留最後記錄供診斷，重啟換新記錄，離開再回收', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-ownership-test-'));
    try {
      const { host, children } = setup(dir);
      await host.launch({ src:'movie.mp4' });
      const first = host.logPath();
      children[0].stderr.write('mpv diagnostic');
      await new Promise(resolve => setImmediate(resolve));
      children[0].emit('close', 1);
      await new Promise(resolve => setImmediate(resolve));
      expect(host.logPath()).toBe(first);
      // Child close / setImmediate do not wait for the WriteStream's pending fs write.
      await vi.waitFor(() => expect(fs.readFileSync(first, 'utf8')).toContain('mpv diagnostic'));
      await host.launch({ src:'movie.mp4' });
      expect(host.logPath()).not.toBe(first);
      for (let attempt = 0; attempt < 100 && fs.existsSync(first); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(first)).toBe(false);
      expect(await host.disposeAndWait()).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  });
  it('真 before-quit 在 mpv 結清後因其他 owner 失敗取消退出，可重新啟動 mpv', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-quit-resume-test-'));
    const { host } = setup(dir);
    const source = fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
    const tree = parse(source,{ecmaVersion:'latest',sourceType:'script'});
    const registration = tree.body.find(node=>node.expression?.callee?.object?.name==='app'
      && node.expression?.callee?.property?.name==='on' && node.expression?.arguments?.[0]?.value==='before-quit');
    let beforeQuit;
    const owner = () => ({cancelAllAndWait:async()=>{},resume:()=>{}});
    const context = {
      app:{on:(_event,fn)=>{beforeQuit=fn;},quit:()=>{}},_quitReady:false,_quitSequenceStarted:false,_isAppQuitting:false,
      audioNormalizationJobs:new Map(),mediaProbe:null,ffmpegExecution:owner(),deliveryCapabilities:owner(),
      clipAudioCache:{waitForIdle:async()=>{}},clipFrameCache:{waitForIdle:async()=>{}},
      speechCompressionRuntime:owner(),speechAudioReader:owner(), screenTextRuntime: owner(),mediaIngestCoordinator:owner(),mediaWaveformCoordinator:owner(),vocalWaveformRuntime:owner(),
      nativeAudioMeter:{stop:vi.fn().mockResolvedValue()},
      QueueManager:{prepareForShutdown:async()=>{},cancelShutdown:async()=>{}},
      screenshotOutput:{close:async()=>{},resume:async()=>{}},directoryOutput:{close:async()=>{},resume:async()=>{}},fileCommitCoordinator:{close:async()=>{},resume:async()=>{}},mpvHost:host,
      mediaIntakeRuntime:{close:async()=>{throw new Error('simulated close error');}},
      mainWin:null,dialog:{showMessageBox:async()=>{}},console:{error:()=>{}},Promise,
    };
    vm.runInNewContext(source.slice(registration.start,registration.end),context);
    try {
      await host.launch({src:'movie.mp4'});
      beforeQuit({preventDefault(){}});
      await vi.waitFor(()=>expect(context._quitSequenceStarted).toBe(false));
      expect(context._quitReady).toBe(false);
      expect(context.nativeAudioMeter.stop).toHaveBeenCalledOnce();
      await expect(host.launch({src:'movie.mp4'})).resolves.toMatchObject({ok:true});
    } finally { await host.disposeAndWait(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
});

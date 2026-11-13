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

function setup(dir, { autoClose = true, rootAuthority } = {}) {
  const commands = [];
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
    if (command[0] === 'loadfile') queueMicrotask(() => socket.emit('data', Buffer.from('{"event":"start-file","playlist_entry_id":1}\n{"event":"file-loaded"}\n{"event":"playback-restart"}\n')));
    if (id) queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ request_id:id, error:'success', data:command[0] === 'loadfile' ? { playlist_entry_id:1 } : command[1] === 'path' ? 'movie.mp4' : 1 })+'\n')));
  };
  const host = createMpvHost({ BrowserWindow: Window, spawn: () => {
    const child = Object.assign(new EventEmitter(), { stderr:new PassThrough(), kill() { if (autoClose) queueMicrotask(() => child.emit('close', 0)); } });
    children.push(child); return child;
  },
    createConnection: () => { queueMicrotask(() => socket.emit('connect')); return socket; }, fs, path, url,
    getMainWindow: () => ({ isDestroyed: () => false, getContentBounds: () => ({ x:0, y:0 }) }),
    supported: () => true, findExecutable: () => 'mpv', ensureTmp: () => {}, tmpDir:dir,
    tempFiles:new Set(), tempRootAuthority:rootAuthority, guideHtml:'guide content', now:() => 123, setTimer:() => 0, clearTimer:() => {} });
  return { host, commands, children, documents };
}

describe('mpv 暫存檔所有權', () => {
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
      speechCompressionRuntime:owner(),speechAudioReader:owner(),mediaIngestCoordinator:owner(),mediaWaveformCoordinator:owner(),vocalWaveformRuntime:owner(),
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

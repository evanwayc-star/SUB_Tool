import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { CdpClient, getJSON, trackElectron, stopElectron, verifiedCleanup, dispatchKey, isMainWindowTarget } = require('../scripts/acceptance/cdp-electron-harness.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const servers = [];
const httpServers = [];

async function serve(onConnection) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  server.on('connection', onConnection);
  await once(server, 'listening');
  return `ws://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

describe('CDP 驗收連線的失敗歸屬', () => {
  it('以正式或開發入口識別主視窗，專案標題變動及其他視窗不影響選擇', () => {
    const main = { type: 'page', title: '電影 第三版 — SUB TOOL', url: 'file:///C:/Program%20Files/SUB%20Tool/resources/app.asar/dist/index.html' };
    const queue = { type: 'page', title: 'SUB TOOL', url: 'file:///C:/Program%20Files/SUB%20Tool/resources/app.asar/electron/queue.html' };
    const compare = { type: 'page', title: 'SUB TOOL', url: 'file:///C:/Program%20Files/SUB%20Tool/resources/app.asar/electron/compare.html' };
    expect([queue, compare, main].find(isMainWindowTarget)).toBe(main);
    expect(isMainWindowTarget({ ...main, url: 'file:///C:/work/SUB_Tool/dist/index.html' })).toBe(true);
    expect(isMainWindowTarget({ ...main, url: 'http://localhost:8777/' })).toBe(true);
    expect(isMainWindowTarget({ ...main, url: 'http://localhost:8778/' })).toBe(false);
    expect(isMainWindowTarget({ ...main, url: 'https://example.com/dist/index.html' })).toBe(false);
    expect(isMainWindowTarget({ ...main, type: 'worker' })).toBe(false);
    expect(isMainWindowTarget({ ...main, url: 'not a url' })).toBe(false);
  });
  it('renderer 單次讀取未回覆也遵守等待期限，不接受期限後才到的 ready', async () => {
    let reply, received;
    const requested = new Promise(resolve => { received = resolve; });
    const url = await serve(socket => socket.on('message', raw => {
      const { id } = JSON.parse(raw.toString());
      reply = () => socket.send(JSON.stringify({ id, result: { result: { value: true } } }));
      received();
    }));
    const client = new CdpClient(url, { timeoutMs: 1000 });
    let observation, work;
    try {
      await client.connect();
      work = client.waitForApp(30).then(
        value => { observation = { ready: value }; },
        error => { observation = { error: error.message }; },
      );
      await requested;
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(observation).toEqual({ error: expect.stringContaining('等待逾時：SUB Tool renderer 初始化') });
      reply(); await work;
      expect(observation).not.toHaveProperty('ready');
    } finally {
      client.close(); await work;
    }
  });

  it('page 已存在仍等待 renderer 的公開 interface 初始化後才讓驗收繼續',async()=>{
    let reads=0;
    const url=await serve(socket=>{
      socket.on('message',raw=>{
        const {id,method,params}=JSON.parse(raw.toString());
        expect(method).toBe('Runtime.evaluate');
        expect(params.expression).toContain('window.SUB?.State');
        reads++;
        socket.send(JSON.stringify({id,result:{result:{value:reads>=3}}}));
      });
    });
    const client=new CdpClient(url);
    try{await client.connect();expect(await client.waitForApp(1000)).toBe(true);expect(reads).toBe(3);}
    finally{client.close();}
  });

  it('Electron 關閉連線後，進行中的命令立即失敗而不永久等待', async () => {
    const url = await serve(socket => {
      socket.on('message', () => socket.close());
    });
    const client = new CdpClient(url);
    try {
      await client.connect();
      const result = await Promise.race([
        client.send('Runtime.evaluate').then(() => 'resolved', error => `rejected: ${error.message}`),
        new Promise(resolve => setTimeout(() => resolve('pending'), 500)),
      ]);
      expect(result).toMatch(/^rejected: /);
    } finally {
      client.close();
    }
  });

  it('仍能回傳同一連線上的 CDP 命令結果', async () => {
    const url = await serve(socket => {
      socket.on('message', raw => {
        const { id } = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ id, result: { value: 42 } }));
      });
    });
    const client = new CdpClient(url);
    try {
      await client.connect();
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      expect(await client.send('Runtime.evaluate')).toEqual({ value: 42 });
    } finally {
      client.close();
    }
  });

  it('連線未關但命令沒回應時會逾時，下一個命令仍能正常執行', async () => {
    let first = true;
    const url = await serve(socket => {
      socket.on('message', raw => {
        const { id } = JSON.parse(raw.toString());
        if (first) { first = false; return; }
        socket.send(JSON.stringify({ id, result: { value: 7 } }));
      });
    });
    const client = new CdpClient(url, { timeoutMs: 30 });
    try {
      await client.connect();
      await expect(client.send('Runtime.evaluate')).rejects.toThrow('等待逾時');
      expect(await client.send('Runtime.evaluate')).toEqual({ value: 7 });
    } finally { client.close(); }
  });

  it('HTTP 已開始傳資料但未結束，也受絕對期限限制', async () => {
    const server = createServer((_, response) => {
      response.writeHead(200);
      response.write('{');
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await expect(getJSON(`http://127.0.0.1:${server.address().port}/json/list`, 30))
      .rejects.toThrow('等待逾時');
  });

  it('無法序列化的命令立即失敗，不留下待回覆工作', async () => {
    const url = await serve(() => {});
    const client = new CdpClient(url);
    try {
      await client.connect();
      const params = {};
      params.self = params;
      await expect(client.send('Runtime.evaluate', params)).rejects.toThrow();
      expect(client.pending.size).toBe(0);
    } finally { client.close(); }
  });

  it('HTTP 錯誤狀態不會被當作有效 target 列表', async () => {
    const server = createServer((_, response) => { response.writeHead(503); response.end('[]'); });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await expect(getJSON(`http://127.0.0.1:${server.address().port}/json/list`)).rejects.toThrow('503');
  });
});

describe('CDP 原生鍵盤輸入契約', () => {
  async function encodedKeys(platform, keys) {
    const messages = [];
    const url = await serve(socket => socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    }));
    const client = new CdpClient(url);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      await client.connect();
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      for (const [key, code] of keys) await dispatchKey(client, key, code);
      return messages;
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      client.close();
    }
  }

  it('Windows 選單與逐格按鍵送出平台鍵碼，按下放開順序完整', async () => {
    const messages = await encodedKeys('win32', [['Home'], ['ArrowDown'], ['Enter'], ['ArrowLeft'], ['ArrowRight']]);
    expect(messages.map(message => message.method)).toEqual(Array(10).fill('Input.dispatchKeyEvent'));
    expect(messages.map(message => message.params.type)).toEqual(Array(5).fill(['rawKeyDown', 'keyUp']).flat());
    expect(messages.filter((_, index) => index % 2 === 0).map(message => message.params.nativeVirtualKeyCode))
      .toEqual([36, 40, 13, 37, 39]);
    for (let index = 0; index < messages.length; index += 2) {
      const down = messages[index].params, up = messages[index + 1].params;
      expect(down.windowsVirtualKeyCode).toBe(down.nativeVirtualKeyCode);
      expect(up).toEqual({ ...down, type: 'keyUp' });
      expect(down.code).toBe(down.key);
    }
  });

  it('字幕與播放的文字快捷鍵保留 DOM 鍵值和明確 code', async () => {
    const messages = await encodedKeys('win32', [['p', 'KeyP'], ['j', 'KeyJ'], ['k', 'KeyK'], ['l', 'KeyL']]);
    expect(messages.map(message => message.params)).toEqual(['p', 'j', 'k', 'l'].flatMap(key => [
      { type: 'keyDown', key, code: `Key${key.toUpperCase()}` },
      { type: 'keyUp', key, code: `Key${key.toUpperCase()}` }
    ]));
  });

  it.each(['darwin', 'linux'])('%s 不使用 Windows 原生鍵碼', async platform => {
    const messages = await encodedKeys(platform, [['Home']]);
    expect(messages.map(message => message.params)).toEqual([
      { type: 'keyDown', key: 'Home', code: 'Home' },
      { type: 'keyUp', key: 'Home', code: 'Home' }
    ]);
  });
});

describe('Electron 驗收程序的完整收尾', () => {
  it('主程序已退出仍等待 close，之後才允許清除 profile', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
    trackElectron(child);
    let stopped = false;
    const completion = stopElectron(child).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    child.emit('close');
    await completion;
    expect(stopped).toBe(true);
  });

  it('未完成 close 的逾時必須失敗，不能把等待期限當作已退出', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
    trackElectron(child);
    await expect(stopElectron(child, { timeoutMs: 20 })).rejects.toThrow('未完成關閉');
    child.emit('close');
  });
});

describe('驗收暫存清理的有界重試與路徑護欄', () => {
  function fakeCleanup(resolvedTarget) {
    const tempRoot=path.resolve(os.tmpdir());
    const target=path.join(tempRoot,'subtool-cleanup-unit');
    vi.spyOn(fs,'realpathSync').mockImplementation(value=>value===os.tmpdir()?tempRoot:resolvedTarget||target);
    const remove=vi.spyOn(fs,'rmSync').mockImplementation(()=>{});
    const wait=vi.spyOn(Atomics,'wait').mockReturnValue('timed-out');
    return {tempRoot,target,remove,wait};
  }

  it.each(['EPERM','EBUSY','EMFILE','ENFILE','ENOTEMPTY'])('%s 暫時失敗後成功，每次完整等待設定毫秒',code=>{
    const {target,remove,wait}=fakeCleanup(),order=[];
    const error=Object.assign(new Error('transient cleanup'),{code});
    remove.mockImplementationOnce(()=>{order.push('remove');throw error;})
      .mockImplementationOnce(()=>{order.push('remove');throw error;})
      .mockImplementationOnce(()=>{order.push('remove');});
    wait.mockImplementation((view,index,value,timeout)=>{order.push(`wait:${timeout}`);return 'timed-out';});
    verifiedCleanup(target,'subtool-cleanup-',{maxRetries:2,retryDelay:17});
    expect(remove).toHaveBeenCalledTimes(3);
    for(const [destination,options]of remove.mock.calls){
      expect(destination).toBe(target);expect(options).toMatchObject({recursive:true,force:true,maxRetries:0});
    }
    expect(wait.mock.calls.map(call=>call[3])).toEqual([17,17]);
    expect(order).toEqual(['remove','wait:17','remove','wait:17','remove']);
  });

  it('用完重試仍拋出原錯誤，不能把剩餘目錄當作已清除',()=>{
    const {target,remove,wait}=fakeCleanup();
    const error=Object.assign(new Error('still locked'),{code:'EPERM'});
    remove.mockImplementation(()=>{throw error;});
    expect(()=>verifiedCleanup(target,'subtool-cleanup-',{maxRetries:2,retryDelay:11})).toThrow(error);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(call=>call[3])).toEqual([11,11]);
  });

  it('maxRetries=0 只嘗試一次，不等待或吞掉失敗',()=>{
    const {target,remove,wait}=fakeCleanup();
    const error=Object.assign(new Error('locked'),{code:'EPERM'});
    remove.mockImplementation(()=>{throw error;});
    expect(()=>verifiedCleanup(target,'subtool-cleanup-',{maxRetries:0})).toThrow(error);
    expect(remove).toHaveBeenCalledTimes(1);expect(wait).not.toHaveBeenCalled();
  });

  it('真實同步等待以毫秒執行，fakeFS 不觸碰任何實際目錄',()=>{
    const {target,remove,wait}=fakeCleanup();wait.mockRestore();
    remove.mockImplementationOnce(()=>{throw Object.assign(new Error('transient'),{code:'EPERM'});});
    const started=performance.now();
    verifiedCleanup(target,'subtool-cleanup-',{maxRetries:1,retryDelay:12});
    expect(performance.now()-started).toBeGreaterThanOrEqual(10);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it.each([{maxRetries:Infinity},{maxRetries:-1},{retryDelay:Infinity},{retryDelay:-1}])
  ('不合法的重試預算 %j 不刪除或等待',options=>{
    const {target,remove,wait}=fakeCleanup();
    expect(()=>verifiedCleanup(target,'subtool-cleanup-',options)).toThrow(RangeError);
    expect(remove).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();
  });

  it.each(['EIO','EACCES',undefined])('非重試錯誤 %s 立即失敗',code=>{
    const {target,remove,wait}=fakeCleanup();
    const error=Object.assign(new Error('unrelated cleanup failure'),{code});
    remove.mockImplementation(()=>{throw error;});
    expect(()=>verifiedCleanup(target,'subtool-cleanup-')).toThrow(error);
    expect(remove).toHaveBeenCalledTimes(1);expect(wait).not.toHaveBeenCalled();
  });

  it.each(['temp-root','nested','outside','prefix','symlink-escape'])('不合法的 %s 目標不刪除也不等待',kind=>{
    const tempRoot=path.resolve(os.tmpdir());
    const resolved=kind==='temp-root'?tempRoot:kind==='nested'?path.join(tempRoot,'nested','subtool-cleanup-unit')
      :kind==='prefix'?path.join(tempRoot,'other-unit'):path.join(path.dirname(tempRoot),'subtool-cleanup-unit');
    const {target,remove,wait}=fakeCleanup(resolved);
    expect(()=>verifiedCleanup(target,'subtool-cleanup-')).toThrow('拒絕清除未驗證的路徑');
    expect(remove).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();
  });
});

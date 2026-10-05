import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { CdpClient, getJSON, trackElectron, stopElectron } = require('../scripts/acceptance/cdp-electron-harness.js');
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { findMainPid, connectMainInspector } = require('../scripts/diagnostics/main-inspector.js');
const { ELECTRON } = require('../scripts/acceptance/cdp-electron-harness.js');
const disposers = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function inspector(identity, { silent = false } = {}) {
  const messages = [];
  let closed = 0;
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(ws, 'listening');
  ws.on('connection', socket => {
    socket.on('close', () => closed++);
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (silent) return;
      socket.send(JSON.stringify({ id: message.id, result: { result: {
        value: messages.length === 1 ? identity : 'probe-result',
      } } }));
    });
  });
  const http = createServer((_, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ webSocketDebuggerUrl: `ws://127.0.0.1:${ws.address().port}` }]));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  disposers.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  });
  return {
    endpoint: `http://127.0.0.1:${http.address().port}/json/list`,
    messages, closed: () => closed,
  };
}

describe('診斷主行程的發現與 inspector 准入', () => {
  const main = { ProcessId: 321, Name: 'electron.exe', ExecutablePath: ELECTRON,
    CommandLine: `"${ELECTRON}" .` };
  function discovery(rows) {
    return { exec: vi.fn(() => JSON.stringify(rows)) };
  }

  it('其他 Electron 在前仍選本專案主行程，排除 renderer 與未知命令列', () => {
    const options = discovery([
      { ...main, ProcessId: 2, ExecutablePath: 'C:\\Other App\\electron.exe' },
      { ...main, ProcessId: 3, CommandLine: 'electron --type=renderer' },
      { ...main, ProcessId: 4, CommandLine: null },
      main,
    ]);
    expect(findMainPid(options)).toBe(321);
    expect(options.exec.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 10000 });
  });

  it('可找到自訂路徑安裝版；多個主行程要求明確 PID，不任取第一個', () => {
    const installed = { ...main, ProcessId: 444, Name: 'SUB Tool.exe', ExecutablePath: 'D:\\Apps\\SUB Tool.exe' };
    expect(findMainPid(discovery(installed))).toBe(444);
    expect(() => findMainPid(discovery([installed, main]))).toThrow('多個');
    expect(findMainPid({ exec: () => '' })).toBe(0);
  });

  it.each([0, -1, 1.5, NaN])('PID %s 不啟用 inspector', async pid => {
    const enable = vi.fn();
    await expect(connectMainInspector(pid, { enable })).rejects.toThrow('正整數');
    expect(enable).not.toHaveBeenCalled();
  });

  it.each([
    { pid: 999, type: 'browser', name: 'SUB Tool' },
    { pid: 321, type: 'browser', name: 'Other app' },
    { pid: 321, type: undefined, name: null },
  ])('拒絕占用相同 port 的另一程序或非 SUB Tool：%j', async identity => {
    const server = await inspector(identity), enable = vi.fn();
    await expect(connectMainInspector(321, { endpoint: server.endpoint, enable }))
      .rejects.toThrow('不屬於');
    await vi.waitFor(() => expect(server.closed()).toBe(1));
    expect(enable).toHaveBeenCalledWith(321);
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0].params.expression).toContain('process.pid');
    expect(server.messages[0].params.expression).not.toContain('executeJavaScript');
  });

  it.each(['sub-tool', 'SUB Tool'])('確認 %s 與指定 PID 後才交付可用連線', async name => {
    const server = await inspector({ pid: 321, type: 'browser', name });
    const client = await connectMainInspector(321, { endpoint: server.endpoint, enable() {} });
    try {
      expect(await client.evaluate('installProbe()')).toBe('probe-result');
      expect(server.messages[1].params.expression).toBe('installProbe()');
    } finally { client.close(); }
  });

  it('身分查詢沒有回覆時按期限拒絕並關閉連線', async () => {
    const server = await inspector(null, { silent: true });
    await expect(connectMainInspector(321, { endpoint: server.endpoint, enable() {}, timeoutMs: 80 }))
      .rejects.toThrow('逾時');
    await vi.waitFor(() => expect(server.closed()).toBe(1));
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'acceptance', 'cdp-run.js');
const scratchDirs = [];
const servers = [];

async function runCli(onCommand) {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'subtool-cdp-run-'));
  scratchDirs.push(scratch);
  const source = path.join(scratch, 'acceptance.js');
  writeFileSync(source, '21 * 2', 'utf8');

  let port;
  const httpServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{
      type: 'page', title: 'SUB Tool', url: 'file:///fake/index.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
    }]));
  });
  const wsServer = new WebSocketServer({ server: httpServer });
  servers.push({ httpServer, wsServer });
  wsServer.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      onCommand(socket, message);
    });
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  port = httpServer.address().port;

  const child = spawn(process.execPath, [CLI, source, String(port)], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), 3000);
  const [code] = await once(child, 'close');
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

afterEach(async () => {
  for (const { httpServer, wsServer } of servers.splice(0)) {
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise(resolve => wsServer.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
  }
  const tempRoot = realpathSync(tmpdir());
  for (const scratch of scratchDirs.splice(0)) {
    const resolved = realpathSync(scratch);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('subtool-cdp-run-')) {
      throw new Error('拒絕清除未驗證的測試路徑');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('手動 CDP 驗收執行器', () => {
  it('桌面視窗在 evaluate 中斷線時回傳失敗，不把未完成驗收當成功', async () => {
    const result = await runCli((socket, message) => {
      if (message.method === 'Runtime.enable') socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'Runtime.evaluate') socket.close();
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/CDP|WebSocket|連線/);
  });

  it('正常命令仍輸出頁面回傳值', async () => {
    const result = await runCli((socket, message) => {
      if (message.method === 'Runtime.enable') socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'Runtime.evaluate') {
        socket.send(JSON.stringify({ id: message.id, result: { result: { value: 42 } } }));
      }
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('42');
  });
});

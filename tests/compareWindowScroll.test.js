// @subtool-ci windows
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'compare-window-scroll.cjs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntil(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw lastError || new Error('等待 Electron 比對視窗逾時');
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error('比對視窗 renderer 執行失敗');
    return response.result.value;
  }

  close() { this.ws?.close(); }
}

async function runScrollFixture() {
  const port = await reservePort();
  const child = spawn(ELECTRON, [FIXTURE, `--remote-debugging-port=${port}`, '--no-sandbox'], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const closed = new Promise(resolve => child.once('close', resolve));
  let client;
  try {
    const before = await waitUntil(() => {
      const marker = 'COMPARE_SCROLL_READY:';
      const line = stdout.split(/\r?\n/).find(value => value.startsWith(marker));
      return line ? JSON.parse(line.slice(marker.length)) : null;
    });
    const target = await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find(item => item.type === 'page' && item.title === '字幕比對');
    });
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    let afterWheel = 0;
    for (let attempt = 0; attempt < 4 && afterWheel <= before.scrollTop; attempt++) {
      await client.send('Page.bringToFront');
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: before.x,
        y: before.y,
        deltaX: 0,
        deltaY: 240,
      });
      afterWheel = await waitUntil(async () => {
        const value = await client.evaluate(`document.getElementById('container').scrollTop`);
        return value > before.scrollTop ? value : null;
      }, 1000).catch(() => 0);
    }
    client.close();
    client = null;
    child.kill();
    await closed;
    return { ...before, afterWheel };
  } finally {
    client?.close();
    if (child.exitCode == null) child.kill('SIGKILL');
  }
}

describe('字幕比對視窗捲動', () => {
  it('大量字幕時捲動區受視窗高度限制，滑鼠滾輪可看到後面的列', async () => {
    const result = await runScrollFixture();

    expect(result.overflowY).toBe('auto');
    expect(result.bodyHeight).toBeLessThanOrEqual(result.viewportHeight);
    expect(result.scrollHeight).toBeGreaterThan(result.clientHeight);
    expect(result.afterWheel).toBeGreaterThan(result.scrollTop);
  }, 15000);
});

/* ============================================================================
   Electron / CDP acceptance 共用啟動與輸入工具
   ============================================================================ */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJSON(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = http.get(url, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`CDP HTTP 回應 ${response.statusCode}`));
        return;
      }
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('CDP HTTP 回應中斷')));
      response.on('end', () => {
        try { finish(null, JSON.parse(body)); }
        catch (error) { finish(error); }
      });
    }).on('error', error => finish(error));
    // 絕對期限：持續收到零碎資料也不能令 waitFor 的單次讀取永久等待。
    const timer = setTimeout(() => {
      const error = new Error(`CDP HTTP 等待逾時：${url}`);
      finish(error);
      request.destroy(error);
    }, timeoutMs);
  });
}

async function waitFor(read, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`等待逾時：${label}${lastError ? `；${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url, { timeoutMs = 300000, connectTimeoutMs = 10000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: this.connectTimeoutMs });
    this.ws.on('close', () => this.rejectPending(new Error('CDP 連線已關閉')));
    this.ws.on('error', error => this.rejectPending(error));
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('CDP 連線在建立前已關閉')); };
      const cleanup = () => {
        this.ws.off('open', onOpen);
        this.ws.off('error', onError);
        this.ws.off('close', onClose);
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
    });
    this.ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw); }
      catch (error) { this.rejectPending(error); this.ws.terminate(); return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP 連線尚未建立或已關閉'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP 命令等待逾時：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const fail = error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      };
      try { this.ws.send(JSON.stringify({ id, method, params }), fail); }
      catch (error) { fail(error); }
    });
  }

  async evaluate(expression, options = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
      userGesture: true,
      ...options
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    this.ws?.close();
    this.rejectPending(new Error('CDP 連線已關閉'));
  }
}

const electronLifetimes = new WeakMap();

// 註冊時就觀察 close；exitCode 非 null 並不代表 stdio / profile 已完全釋放。
function trackElectron(child) {
  if (!child || electronLifetimes.has(child)) return child;
  const lifetime = { closed: false, error: null };
  lifetime.completion = new Promise(resolve => {
    child.once('error', error => { lifetime.error = error; });
    child.once('close', () => { lifetime.closed = true; resolve(); });
  });
  electronLifetimes.set(child, lifetime);
  return child;
}

async function stopElectron(child, { timeoutMs = 10000 } = {}) {
  if (!child) return;
  const wasTracked = electronLifetimes.has(child);
  trackElectron(child);
  const lifetime = electronLifetimes.get(child);
  if (lifetime.closed) return;
  if (!wasTracked && (child.exitCode !== null || child.signalCode !== null)) return;
  let timer;
  try {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', timeout: timeoutMs,
          });
        } catch {
          child.kill('SIGKILL');
        }
      } else child.kill('SIGKILL');
    }
    await Promise.race([
      lifetime.completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Electron 程序未完成關閉：${child.pid || '未啟動'}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchClick(client, rect, button = 'left') {
  const x = rect.left + Math.min(20, rect.width / 2);
  const y = rect.top + Math.min(10, rect.height / 2);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: 1
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: 1
  });
}

async function dispatchKey(client, key, code = key) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
}

function verifiedCleanup(profileDir, expectedPrefix, { maxRetries = 10, retryDelay = 100 } = {}) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(profileDir);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error(`拒絕清除未驗證的路徑：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries, retryDelay });
}

module.exports = {
  ROOT,
  ELECTRON,
  delay,
  reservePort,
  getJSON,
  waitFor,
  CdpClient,
  trackElectron,
  stopElectron,
  dispatchClick,
  dispatchKey,
  verifiedCleanup
};

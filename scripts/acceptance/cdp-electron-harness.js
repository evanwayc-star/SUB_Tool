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
  const expired = Symbol('wait-for-deadline');
  let lastError, timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(expired), timeoutMs);
  });
  try {
    while (Date.now() < deadline) {
      try {
        // 單次 CDP／HTTP 讀取也受同一期限限制；晚到 ready 不能讓逾時驗收通過。
        const value = await Promise.race([Promise.resolve().then(() => read()), timeout]);
        if (value === expired || Date.now() >= deadline) break;
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([delay(Math.min(50, remaining)), timeout]);
    }
  } finally {
    clearTimeout(timer);
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

  async waitForApp(timeoutMs = 15000) {
    return waitFor(() => this.evaluate('Boolean(window.SUB?.State && window.SUB?.Media)'),
      'SUB Tool renderer 初始化', timeoutMs);
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
  const navigationCodes = { Home: 36, ArrowDown: 40, Enter: 13, ArrowLeft: 37, ArrowRight: 39 };
  const nativeCode = process.platform === 'win32' ? navigationCodes[key] : undefined;
  // Windows 原生 select 接管輸入時，需要非零 native_key_code 才會建立 OS event。
  // https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/input_handler.cc
  const params = nativeCode === undefined ? { key, code } : {
    key, code, windowsVirtualKeyCode: nativeCode, nativeVirtualKeyCode: nativeCode
  };
  await client.send('Input.dispatchKeyEvent', { type: nativeCode === undefined ? 'keyDown' : 'rawKeyDown', ...params });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

function verifiedCleanup(profileDir, expectedPrefix, { maxRetries = 10, retryDelay = 100 } = {}) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(profileDir);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error(`拒絕清除未驗證的路徑：${resolved}`);
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || !Number.isSafeInteger(retryDelay) || retryDelay < 0) {
    throw new RangeError('清理重試次數與等待毫秒必須是非負整數');
  }
  // Node 24.16.0 的同步刪除不重試 Windows permission_denied，且 Sleep 單位換算錯誤。
  // https://github.com/nodejs/node/blob/v24.16.0/src/node_file.cc#L1534-L1627
  // 由此處保留同步 caller 的有界重試；每次等待完整 retryDelay 毫秒。
  const retryable = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
  const waitView = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (attempt >= maxRetries || !retryable.has(error?.code)) throw error;
    }
    if (retryDelay > 0) Atomics.wait(waitView, 0, 0, retryDelay);
  }
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

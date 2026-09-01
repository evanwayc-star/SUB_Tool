// @subtool-ci windows
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const activeApps = new Set();
const tempRoots = new Set();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(read, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(75);
  }
  throw new Error(`等待逾時：${label}${lastError ? `；${lastError.message}` : ''}`);
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

class CdpClient {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.socketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
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
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || 'renderer 執行失敗');
    }
    return response.result.value;
  }

  close() { this.socket?.close(); }
}

function wavBytes(sampleCount = 800) {
  const bytes = Buffer.alloc(44 + sampleCount, 128);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + sampleCount, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(sampleCount, 40);
  return bytes;
}

async function launchApp(projectFile, profileDir) {
  const port = await reservePort();
  const isolatedTemp = path.join(profileDir, 'system-temp');
  mkdirSync(isolatedTemp, { recursive: true });
  const stderr = [];
  const child = spawn(ELECTRON, [
    '.', projectFile, `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`, '--no-sandbox',
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
  });
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const closed = new Promise(resolve => child.once('close', resolve));
  const app = { child, closed, stderr };
  activeApps.add(app);
  child.once('close', () => activeApps.delete(app));

  const target = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page' && item.title === 'SUB TOOL');
  }, 'SUB Tool 主視窗');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  return { app, client };
}

afterEach(async () => {
  for (const app of activeApps) {
    if (app.child.exitCode == null) app.child.kill('SIGKILL');
    await Promise.race([app.closed, delay(5000)]);
  }
  activeApps.clear();
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {}
  }
  tempRoots.clear();

});

describe('本機媒體資源 capability URL', () => {
  it('renderer 只可透過 opaque 授權 URL 讀檔，literal file URL 無法繞過授權', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'subtool-local-resource-'));
    tempRoots.add(root);
    const authorizedFile = path.join(root, 'authorized.txt');
    const authorizedAudio = path.join(root, 'authorized.wav');
    const unauthorizedFile = path.join(root, 'unauthorized.txt');
    const unauthorizedAudio = path.join(root, 'unauthorized.wav');
    const projectFile = path.join(root, 'capability.subtool');
    const profileDir = path.join(root, 'profile');
    writeFileSync(authorizedFile, 'AUTHORIZED-SENTINEL', 'utf8');
    writeFileSync(authorizedAudio, wavBytes());
    writeFileSync(unauthorizedFile, 'UNAUTHORIZED-SENTINEL', 'utf8');
    writeFileSync(unauthorizedAudio, wavBytes());
    writeFileSync(projectFile, JSON.stringify({
      clips: [{ path: authorizedFile }, { path: authorizedAudio }],
      externalAudioSources: [],
      cues: [],
    }), 'utf8');

    const { app, client } = await launchApp(projectFile, profileDir);
    try {
      const result = await client.evaluate(`(async () => {
        await window.subtool.getStartupFile();
        const authorizedPath = ${JSON.stringify(authorizedFile)};
        const authorizedAudioPath = ${JSON.stringify(authorizedAudio)};
        const unauthorizedPath = ${JSON.stringify(unauthorizedFile)};
        const authorizedURL = await window.subtool.fileURL(authorizedPath);
        const sameAuthorizedURL = await window.subtool.fileURL(authorizedPath);
        const authorizedAudioURL = await window.subtool.fileURL(authorizedAudioPath);
        const unauthorizedURL = await window.subtool.fileURL(unauthorizedPath);
        const full = await fetch(authorizedURL);
        const ranged = await fetch(authorizedURL, { headers: { Range: 'bytes=2-5' } });
        let literalFetch;
        try {
          const response = await fetch(${JSON.stringify(pathToFileURL(unauthorizedFile).href)});
          literalFetch = { loaded: response.ok, text: await response.text() };
        } catch (error) {
          literalFetch = { loaded: false, error: error.name };
        }
        const loadAudio = source => new Promise(resolve => {
          const audio = document.createElement('audio');
          const timer = setTimeout(() => resolve('timeout'), 3000);
          audio.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve('loaded'); }, { once: true });
          audio.addEventListener('error', () => { clearTimeout(timer); resolve('blocked'); }, { once: true });
          audio.src = source;
          audio.load();
        });
        return {
          authorizedURL,
          sameAuthorizedURL,
          unauthorizedURL,
          fullStatus: full.status,
          fullText: await full.text(),
          rangeStatus: ranged.status,
          rangeHeader: ranged.headers.get('content-range'),
          rangeText: await ranged.text(),
          literalFetch,
          authorizedAudio: await loadAudio(authorizedAudioURL),
          unauthorizedAudio: await loadAudio(${JSON.stringify(pathToFileURL(unauthorizedAudio).href)}),
        };
      })()`);

      expect(result.authorizedURL).toMatch(/^subtool-local:\/\/resource\/[a-f0-9]{48}$/);
      expect(result.authorizedURL).toBe(result.sameAuthorizedURL);
      expect(result.authorizedURL).not.toContain(encodeURIComponent(authorizedFile));
      expect(result.unauthorizedURL).toBeNull();
      expect(result.fullStatus).toBe(200);
      expect(result.fullText).toBe('AUTHORIZED-SENTINEL');
      expect(result.rangeStatus).toBe(206);
      expect(result.rangeHeader).toBe('bytes 2-5/19');
      expect(result.rangeText).toBe('THOR');
      expect(result.literalFetch.loaded).toBe(false);
      expect(result.authorizedAudio).toBe('loaded');
      expect(result.unauthorizedAudio).toBe('blocked');
    } finally {
      client.close();
      if (app.child.exitCode == null) app.child.kill();
      await Promise.race([app.closed, delay(5000)]);
    }
  }, 30000);
});

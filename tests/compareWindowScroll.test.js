// @subtool-ci windows
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { CdpClient, getJSON, waitFor, trackElectron, stopElectron, verifiedCleanup } = require('../scripts/acceptance/cdp-electron-harness.js');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'compare-window-scroll.cjs');

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

async function runScrollFixture() {
  const port = await reservePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'subtool-compare-scroll-'));
  const child = trackElectron(spawn(ELECTRON, [FIXTURE, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-sandbox'], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let client;
  try {
    const before = await waitFor(() => {
      const marker = 'COMPARE_SCROLL_READY:';
      const line = stdout.split(/\r?\n/).find(value => value.startsWith(marker));
      return line ? JSON.parse(line.slice(marker.length)) : null;
    }, '字幕比對視窗回報捲動區資訊');
    const target = await waitFor(async () => {
      return (await getJSON(`http://127.0.0.1:${port}/json/list`))
        .find(item => item.type === 'page' && item.title === '字幕比對');
    }, '字幕比對視窗的 CDP page target');
    client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 10000 });
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
      afterWheel = await waitFor(async () => {
        const value = await client.evaluate(`document.getElementById('container').scrollTop`);
        return value > before.scrollTop ? value : null;
      }, '滑鼠滾輪使字幕比對容器向下捲動', 1000).catch(() => 0);
    }
    client.close();
    client = null;
    await stopElectron(child);
    return { ...before, afterWheel };
  } finally {
    client?.close();
    await stopElectron(child);
    verifiedCleanup(profile, 'subtool-compare-scroll-');
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

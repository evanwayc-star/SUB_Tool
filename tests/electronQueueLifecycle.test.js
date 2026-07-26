import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const activeApps = new Set();
const tempProfiles = new Set();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntil(fn, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`等待逾時：${label}${lastError ? `；${lastError.message}` : ''}`);
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP 回應 ${response.status}`);
  return response.json();
}

async function waitForTarget(port, predicate, label) {
  return waitUntil(
    async () => (await listTargets(port)).find(predicate),
    label,
  );
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
      if (!message.id) return;
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Renderer 執行失敗');
    }
    return result.result.value;
  }

  close() {
    this.ws?.close();
  }
}

async function connectTarget(target) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

async function launchApp(profileDir) {
  const port = await reservePort();
  const stderr = [];
  const isolatedTemp = path.join(profileDir, 'system-temp');
  mkdirSync(isolatedTemp, { recursive: true });
  const child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
    },
  );
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const closed = new Promise(resolve => child.once('close', resolve));
  const app = { child, port, stderr, closed };
  activeApps.add(app);
  child.once('close', () => activeApps.delete(app));
  await waitForTarget(port, target => target.type === 'page' && target.title === 'SUB TOOL', '主視窗啟動');
  return app;
}

async function launchSecondInstance(profileDir) {
  const stderr = [];
  const isolatedTemp = path.join(profileDir, `system-temp-second-${Date.now()}`);
  mkdirSync(isolatedTemp, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${profileDir}`], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
  });
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    delay(10000).then(() => {
      child.kill('SIGKILL');
      throw new Error(`第二執行個體未結束：${stderr.join('')}`);
    }),
  ]);
  return stderr.join('');
}

function minimizeMainWindow(processId) {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SubToolWindowTest {
  public delegate bool EnumProc(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
}
"@
$script:found = $false
[SubToolWindowTest]::EnumWindows({
  param([IntPtr]$handle, [IntPtr]$state)
  [uint32]$owner = 0
  [SubToolWindowTest]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
  if ($owner -eq ${processId}) {
    $title = New-Object System.Text.StringBuilder 512
    [SubToolWindowTest]::GetWindowText($handle, $title, $title.Capacity) | Out-Null
    if ($title.ToString() -like 'SUB TOOL*') {
      [SubToolWindowTest]::ShowWindowAsync($handle, 6) | Out-Null
      $script:found = $true
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if (-not $script:found) { exit 2 }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: 'pipe',
  });
}

async function waitForExit(app) {
  await Promise.race([
    app.closed,
    delay(10000).then(() => {
      throw new Error(`Electron 未結束：${app.stderr.join('')}`);
    }),
  ]);
}

async function openQueueMonitor(app, mainClient) {
  await mainClient.evaluate('window.subtool.openQueueMonitor()');
  const target = await waitForTarget(
    app.port,
    item => item.type === 'page' && item.title === '匯出佇列監控',
    '佇列監控視窗啟動',
  );
  return connectTarget(target);
}

afterEach(async () => {
  for (const app of [...activeApps]) {
    if (app.child.exitCode === null) app.child.kill('SIGKILL');
    await Promise.race([app.closed, delay(5000)]);
  }
  activeApps.clear();
  for (const profile of tempProfiles) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  tempProfiles.clear();
});

const describeElectron = process.platform === 'win32' ? describe.sequential : describe.skip;

describeElectron('Electron 匯出佇列生命週期', () => {
  test('主視窗關閉後可從佇列監控重新打開', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-main-reopen-'));
    tempProfiles.add(profile);
    const app = await launchApp(profile);
    const mainTarget = await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得主視窗',
    );
    const mainClient = await connectTarget(mainTarget);
    const queueClient = await openQueueMonitor(app, mainClient);

    // 模擬 renderer 完成既有「是否儲存」確認後，要求主行程關閉主視窗。
    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'hidden',
      '主視窗隱藏且保留 renderer',
    );

    const secondInstanceError = await launchSecondInstance(profile);
    expect(secondInstanceError).not.toContain('Object has been destroyed');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'visible',
      '由第二執行個體重新顯示主視窗',
    );

    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'hidden',
      '再次隱藏主視窗',
    );

    const clicked = await queueClient.evaluate(`(() => {
      const button = document.getElementById('showMainWindowBtn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '主視窗重新開啟',
    );
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'visible',
      '主視窗恢復顯示',
    );

    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'hidden',
      '測試結束前隱藏主視窗',
    );
    await queueClient.send('Page.close').catch(() => {});
    await waitForExit(app);
    mainClient.close();
    queueClient.close();
  }, 20000);

  test('主視窗只最小化時，關閉監控視窗不會誤退出程式', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-main-minimize-'));
    tempProfiles.add(profile);
    const app = await launchApp(profile);
    const mainTarget = await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得最小化測試主視窗',
    );
    const mainClient = await connectTarget(mainTarget);
    const queueClient = await openQueueMonitor(app, mainClient);
    await mainClient.send('Page.bringToFront');
    minimizeMainWindow(app.child.pid);

    await queueClient.send('Page.close').catch(() => {});
    await delay(300);
    expect(app.child.exitCode).toBeNull();
    await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '最小化後主視窗仍存在',
    );

    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitForExit(app);
    mainClient.close();
    queueClient.close();
  }, 20000);

  test('未開始的工作在重開程式後仍保留，並維持暫停', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-queue-restore-'));
    tempProfiles.add(profile);
    const outPath = path.join(profile, 'queued-output.mp4');
    const firstApp = await launchApp(profile);
    const firstMainTarget = await waitForTarget(
      firstApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得第一次主視窗',
    );
    const firstMainClient = await connectTarget(firstMainTarget);
    const firstQueueClient = await openQueueMonitor(firstApp, firstMainClient);
    await firstQueueClient.evaluate('window.queueAPI.setPause(true)');

    const payload = {
      outPath,
      assText: '',
      clips: [],
      videoTracks: [],
      duration: 1,
      width: 1920,
      height: 1080,
      fps: 25,
      format: 'h264',
      videoKbps: 1000,
      audioPlan: null,
    };
    await firstMainClient.evaluate(`window.subtool.exportVideo(${JSON.stringify(payload)})`);
    const beforeRestart = await firstQueueClient.evaluate('window.queueAPI.getAll()');
    expect(beforeRestart.jobs).toHaveLength(1);
    expect(beforeRestart.jobs[0].status).toBe('queued');

    await firstMainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await firstMainClient.evaluate('document.visibilityState') === 'hidden',
      '第一次主視窗隱藏',
    );
    await firstQueueClient.send('Page.close').catch(() => {});
    await waitForExit(firstApp);
    firstMainClient.close();
    firstQueueClient.close();

    const secondApp = await launchApp(profile);
    const secondMainTarget = await waitForTarget(
      secondApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得重開後主視窗',
    );
    const secondMainClient = await connectTarget(secondMainTarget);
    await waitUntil(
      async () => (await secondMainClient.evaluate(
        'document.getElementById("stMsg")?.textContent || ""',
      )).includes('佇列已暫停'),
      '重開後主視窗立即顯示已恢復的暫停佇列',
    );
    const secondQueueClient = await openQueueMonitor(secondApp, secondMainClient);
    const afterRestart = await secondQueueClient.evaluate('window.queueAPI.getAll()');

    expect(afterRestart.isPaused).toBe(true);
    expect(afterRestart.jobs).toHaveLength(1);
    expect(afterRestart.jobs[0].status).toBe('queued');
    expect(afterRestart.jobs[0].payload.outPath).toBe(outPath);

    await secondMainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await secondMainClient.evaluate('document.visibilityState') === 'hidden',
      '重開後主視窗隱藏',
    );
    await secondQueueClient.send('Page.close').catch(() => {});
    await waitForExit(secondApp);
    secondMainClient.close();
    secondQueueClient.close();
  }, 30000);
});

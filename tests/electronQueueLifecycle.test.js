// @subtool-ci windows
import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const QueueStore = require(path.join(ROOT, 'electron', 'queue-store.js'));
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const activeApps = new Set();
const tempProfiles = new Set();
let capabilitySeedCounter = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-sandbox'],
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
  try {
    await waitForTarget(port, target => target.type === 'page' && target.title === 'SUB TOOL', '主視窗啟動');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr.join('')}`, { cause: error });
  }
  return app;
}

async function launchSecondInstance(profileDir) {
  const stderr = [];
  const isolatedTemp = path.join(profileDir, `system-temp-second-${Date.now()}`);
  mkdirSync(isolatedTemp, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${profileDir}`, '--no-sandbox'], {
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

/* exportVideo 的能力只能來自原生選取或 app 自己保存的 job snapshot。
   這個 E2E helper 在 Electron 啟動前寫入與正式 QueueStore 相同格式的 queued snapshot，
   確認 restoreJobs 已恢復其精確來源／輸出能力後，經由真實 queue monitor 清掉 seed。
   清除工作檔不會撤銷已在本次主程序 session 恢復的 capability，因此後續 CDP 呼叫仍是
   正式 IPC 路徑，而不是測試專用後門。 */
function seedQueuedCapabilities(profileDir, entries) {
  const queueDir = path.join(profileDir, 'export-queue');
  const records = Array.isArray(entries) ? entries : [entries];
  return records.map((entry, order) => {
    const id = entry.id || `e2e-capability-seed-${++capabilitySeedCounter}`;
    QueueStore.persistJob(queueDir, {
      id,
      createdAt: Date.now() + order,
      status: 'queued',
      payload: {
        outPath: entry.outPath,
        format: entry.format || 'h264',
        clips: [],
        audioPlan: null,
      },
      sourcePaths: entry.sourcePaths,
    }, order);
    return id;
  });
}

async function restoreSeededCapabilities(app, mainClient, seedIds, { resume = true } = {}) {
  const queueClient = await openQueueMonitor(app, mainClient);
  await waitUntil(
    async () => {
      const snapshot = await queueClient.evaluate('window.queueAPI.getAll()');
      return snapshot.isPaused && seedIds.every(id => snapshot.jobs.some(job => job.id === id));
    },
    'app-owned queue capability snapshot 已恢復',
  );
  for (const id of seedIds) {
    await queueClient.evaluate(`window.queueAPI.clearJob(${JSON.stringify(id)})`);
  }
  await waitUntil(
    async () => {
      const snapshot = await queueClient.evaluate('window.queueAPI.getAll()');
      return seedIds.every(id => !snapshot.jobs.some(job => job.id === id));
    },
    'queue monitor 已清除 capability seed',
  );
  if (resume) await queueClient.evaluate('window.queueAPI.setPause(false)');
  return queueClient;
}

async function exportError(mainClient, payload) {
  return mainClient.evaluate(`(async () => {
    try {
      await window.subtool.exportVideo(${JSON.stringify(payload)});
      return null;
    } catch (error) {
      return error && error.message ? error.message : String(error);
    }
  })()`);
}

afterEach(async () => {
  for (const app of [...activeApps]) {
    killProcessTree(app.child);
    await Promise.race([app.closed, delay(5000)]);
  }
  activeApps.clear();
  for (const profile of tempProfiles) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
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
  }, 35000);

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
    expect(await mainClient.evaluate('window.subtool.minimizeApp()')).toBe(true);

    await queueClient.send('Page.close').catch(() => {});
    await delay(300);
    expect(app.child.exitCode).toBeNull();
    await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '最小化後主視窗仍存在',
    );

    // 驗證斷言已全部完成（主程序未退出且主視窗仍存在）。
    // 關閉 CDP 連線並使用 killProcessTree 徹底終止包含 GPU Process 的進程樹，確保 Windows 檔案鎖完整釋放。
    mainClient.close();
    queueClient.close();
    killProcessTree(app.child);
    await Promise.race([app.closed, delay(3000)]);
  }, 35000);

  test('CDP 直接匯出不會將 renderer 路徑升格為來源或輸出能力', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-export-capability-reject-'));
    tempProfiles.add(profile);
    const authorizedSourcePath = path.join(profile, 'authorized-source.png');
    const unauthorizedSourcePath = path.join(profile, 'unauthorized-source.png');
    const seedOutPath = path.join(profile, 'seed-output.mp4');
    const unauthorizedOutPath = path.join(profile, 'unauthorized-output.mp4');
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(authorizedSourcePath, image);
    writeFileSync(unauthorizedSourcePath, image);
    const [seedId] = seedQueuedCapabilities(profile, {
      sourcePaths: [authorizedSourcePath],
      outPath: seedOutPath,
    });

    const app = await launchApp(profile);
    const mainTarget = await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得 capability 拒絕測試主視窗',
    );
    const mainClient = await connectTarget(mainTarget);
    const queueClient = await restoreSeededCapabilities(app, mainClient, [seedId], { resume: false });
    const makePayload = (sourcePath, outPath) => ({
      outPath,
      assText: '',
      clips: [{
        type: 'image',
        path: sourcePath,
        in: 0,
        out: 0.3,
        offset: 0,
        vtrack: 0,
        natW: 1,
        natH: 1,
      }],
      videoTracks: [{ vt: 0 }],
      duration: 0.3,
      width: 320,
      height: 180,
      fps: 25,
      format: 'h264',
      videoKbps: 500,
      audioPlan: null,
    });

    expect(await exportError(mainClient, makePayload(unauthorizedSourcePath, unauthorizedOutPath)))
      .toContain('匯出來源未經授權');
    expect(await exportError(mainClient, makePayload(authorizedSourcePath, unauthorizedOutPath)))
      .toContain('匯出輸出位置未經授權');
    expect((await queueClient.evaluate('window.queueAPI.getAll()')).jobs).toHaveLength(0);
    expect(existsSync(unauthorizedOutPath)).toBe(false);

    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'hidden',
      'capability 拒絕測試主視窗隱藏',
    );
    await queueClient.send('Page.close').catch(() => {});
    await waitForExit(app);
    mainClient.close();
    queueClient.close();
  }, 20000);

  test('MOD-FHD 入列固定規格、音訊編組與修改限制由主程序執行', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-mod-fhd-queue-'));
    tempProfiles.add(profile);
    const outPath = path.join(profile, 'mod-output.ts');
    const audioPath = path.join(profile, 'source.wav');
    writeFileSync(audioPath, Buffer.from('paused queue audio source'));
    const [seedId] = seedQueuedCapabilities(profile, { sourcePaths: [audioPath], outPath, format: 'mod-fhd' });
    const app = await launchApp(profile);
    const mainClient = await connectTarget(await waitForTarget(app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL', 'MOD-FHD 測試主視窗'));
    const queueClient = await restoreSeededCapabilities(app, mainClient, [seedId], { resume: false });
    const payload = {
      format: ' MOD-FHD ', outPath, clips: [], duration: 1,
      width: 640, height: 360, targetH: 360, fps: 29.97, videoKbps: 1000,
      timelineStartTimecode: '01:00:00;00', timecodeWatermark: { start: '01:00:00;00' },
      audioPlan: {
        buses: ['a1', 'a2'].map((id, channel) => ({ id, inputs: [{
          file: audioPath, sourceStream: 0, sourceChannel: channel, offset: 0, trimStart: 0, trimEnd: 1,
        }] })),
        streams: ['a1', 'a2'].map(id => ({ id, layout: 'mono', busIds: [id] })),
      },
    };
    expect(await exportError(mainClient, { ...payload, audioPlan: {
      ...payload.audioPlan, streams: [{ id: 'only-one', layout: 'mono', busIds: ['a1'] }],
    } })).toContain('單一 Stereo');
    const jobId = await mainClient.evaluate(`window.subtool.exportVideo(${JSON.stringify(payload)})`);
    const snapshot = await queueClient.evaluate('window.queueAPI.getAll()');
    expect(snapshot.deliveryFormatPresets).toEqual(expect.arrayContaining([expect.objectContaining({ format: 'mod-fhd' })]));
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0].payload).toMatchObject({
      format: 'mod-fhd', width: 1920, height: 1080, targetH: 1080, fps: 29.97, videoKbps: 7280,
      audioPlan: { streams: [{ layout: 'stereo', busIds: ['a1', 'a2'] }] },
    });
    await queueClient.evaluate(`window.queueAPI.updateDelivery(${JSON.stringify(jobId)}, { targetH: 720, kbps: 2000 })`);
    const fixed = (await queueClient.evaluate('window.queueAPI.getAll()')).jobs[0].payload;
    expect(fixed).toMatchObject({ width: 1920, height: 1080, targetH: 1080, videoKbps: 7280, fps: 29.97 });
    await queueClient.evaluate(`window.queueAPI.updateDelivery(${JSON.stringify(jobId)}, { format: 'h264', targetH: 720, kbps: 3000 })`);
    const changed = (await queueClient.evaluate('window.queueAPI.getAll()')).jobs[0].payload;
    expect(changed).toMatchObject({ format: 'h264', height: 720, videoKbps: 3000, fps: 29.97, timecodeWatermark: { start: '01:00:00;00' } });
    const rejected = await queueClient.evaluate(`(async () => {
      try { await window.queueAPI.updateDelivery(${JSON.stringify(jobId)}, { format: 'mod-fhd' }); return null; }
      catch (error) { return error.message; }
    })()`);
    expect(rejected).toContain('請回交付清單新增 MOD-FHD');
    expect((await queueClient.evaluate('window.queueAPI.getAll()')).jobs[0].payload).toEqual(changed);
    mainClient.close();
    queueClient.close();
  }, 25000);

  test.each(['h264', 'mod-fhd', 'airline-s3k', 'airline-dmpes'])('實際 %s 匯出由 watchdog 完成並釋放輸出鎖', async format => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-watchdog-export-'));
    tempProfiles.add(profile);
    const imagePath = path.join(profile, 'one-pixel.png');
    const extensions = { h264: '.mp4', 'mod-fhd': '.ts', 'airline-s3k': '.m1v', 'airline-dmpes': '.h264' };
    const outPath = path.join(profile, `watchdog-output${extensions[format]}`);
    writeFileSync(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    const payload = {
      outPath,
      assText: '',
      clips: [{
        type: 'image',
        path: imagePath,
        in: 0,
        out: 0.3,
        offset: 0,
        vtrack: 0,
        natW: 1,
        natH: 1,
      }],
      videoTracks: [{ vt: 0 }],
      duration: 0.3,
      width: 320,
      height: 180,
      fps: 25,
      format,
      videoKbps: 500,
      audioPlan: null,
    };
    const [seedId] = seedQueuedCapabilities(profile, { sourcePaths: [imagePath], outPath, format });

    const app = await launchApp(profile);
    const mainTarget = await waitForTarget(
      app.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得 watchdog 匯出主視窗',
    );
    const mainClient = await connectTarget(mainTarget);
    const queueClient = await restoreSeededCapabilities(app, mainClient, [seedId]);
    await mainClient.evaluate(`window.subtool.exportVideo(${JSON.stringify(payload)})`);
    const finished = await waitUntil(
      async () => {
        const snapshot = await queueClient.evaluate('window.queueAPI.getAll()');
        const job = snapshot.jobs[0];
        return job && ['done', 'failed'].includes(job.status) ? job : null;
      },
      'watchdog 實際匯出完成',
      20000,
    );

    expect(finished.status, finished.errorMsg).toBe('done');
    expect(finished.completedAt).toEqual(expect.any(Number));
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    if (format.startsWith('airline-')) {
      const { deliveryOutputPaths, MANZANITA_CONFIG } = require('../electron/airline-output.js');
      const outputFiles = deliveryOutputPaths(format, outPath);
      expect(outputFiles.every(file => statSync(file).size > 0)).toBe(true);
      expect(readFileSync(outputFiles[2], 'utf8')).toBe(MANZANITA_CONFIG);
      const probe = file => JSON.parse(execFileSync(path.join(ROOT, 'electron/ffmpeg/ffprobe.exe'),
        ['-v', 'error', '-show_streams', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' })).streams;
      expect(probe(outPath)).toEqual([expect.objectContaining({ codec_name: format === 'airline-s3k' ? 'mpeg1video' : 'h264',
        width: format === 'airline-s3k' ? 352 : 720, height: format === 'airline-s3k' ? 240 : 480,
        sample_aspect_ratio: format === 'airline-s3k' ? '200:219' : '32:27',
        display_aspect_ratio: format === 'airline-s3k' ? '880:657' : '16:9' })]);
      expect(probe(outputFiles[1])).toEqual([expect.objectContaining({ codec_name: format === 'airline-s3k' ? 'mp2' : 'aac',
        sample_rate: '48000', channels: 2 })]);
      expect(existsSync(path.join(profile, 'watchdog-output.mpg'))).toBe(false);
    }
    if (format === 'mod-fhd') {
      const data = readFileSync(outPath);
      const ids = [];
      for (let offset = 0; offset < data.length; offset += 188) {
        const packet = data.subarray(offset, offset + 188);
        const pid = ((packet[1] & 31) << 8) | packet[2];
        if (pid !== 4130 || !(packet[1] & 64)) continue;
        const start = 4 + ((packet[3] & 32) ? 1 + packet[4] : 0);
        const adts = start + 9 + packet[start + 8];
        expect(packet[adts]).toBe(0xff);
        ids.push((packet[adts + 1] >> 3) & 1);
      }
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every(id => id === 1), '完成事件之前所有 ADTS 必須已標記 MPEG-2').toBe(true);
    }
    const leaseDir = path.join(profile, 'export-queue', 'output-leases');
    expect(existsSync(leaseDir) ? readdirSync(leaseDir).filter(name => name.endsWith('.lock')) : [])
      .toEqual([]);

    await mainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await mainClient.evaluate('document.visibilityState') === 'hidden',
      'watchdog 匯出後主視窗隱藏',
    );
    await queueClient.send('Page.close').catch(() => {});
    await waitForExit(app);
    mainClient.close();
    queueClient.close();
  }, 30000);

  test('強制結束主程序後 watchdog 會停止 ffmpeg，重開只恢復等待工作', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-watchdog-crash-'));
    tempProfiles.add(profile);
    const imagePath = path.join(profile, 'crash-source.png');
    const outPath = path.join(profile, 'crash-partial.mp4');
    const leaseDir = path.join(profile, 'export-queue', 'output-leases');
    writeFileSync(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    const payload = {
      outPath,
      assText: '',
      clips: [{
        type: 'image',
        path: imagePath,
        in: 0,
        out: 300,
        offset: 0,
        vtrack: 0,
        natW: 1,
        natH: 1,
      }],
      videoTracks: [{ vt: 0 }],
      duration: 300,
      width: 3840,
      height: 2160,
      fps: 25,
      format: 'h264',
      videoKbps: 500,
      audioPlan: null,
    };
    const [seedId] = seedQueuedCapabilities(profile, { sourcePaths: [imagePath], outPath });

    const firstApp = await launchApp(profile);
    const firstMainTarget = await waitForTarget(
      firstApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得 crash 測試主視窗',
    );
    const firstMainClient = await connectTarget(firstMainTarget);
    const firstQueueClient = await restoreSeededCapabilities(firstApp, firstMainClient, [seedId]);
    await firstMainClient.evaluate(`window.subtool.exportVideo(${JSON.stringify(payload)})`);
    const owner = await waitUntil(
      async () => {
        if (!existsSync(leaseDir) || !existsSync(outPath)) return null;
        const lock = readdirSync(leaseDir).find(name => name.endsWith('.lock'));
        if (!lock) return null;
        return JSON.parse(readFileSync(path.join(leaseDir, lock, 'owner.json'), 'utf8'));
      },
      'ffmpeg 已啟動並建立 output lease',
      15000,
    );
    expect(owner.ffmpegPid).toBeGreaterThan(0);

    firstApp.child.kill('SIGKILL');
    await waitForExit(firstApp);
    firstMainClient.close();
    firstQueueClient.close();
    await waitUntil(
      async () => !processIsRunning(owner.ffmpegPid),
      '主程序消失後 ffmpeg 已停止',
      10000,
    );

    const secondApp = await launchApp(profile);
    const secondMainTarget = await waitForTarget(
      secondApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得 crash 後重開主視窗',
    );
    const secondMainClient = await connectTarget(secondMainTarget);
    const secondQueueClient = await openQueueMonitor(secondApp, secondMainClient);
    const locksAfterRecovery = existsSync(leaseDir)
      ? readdirSync(leaseDir).filter(name => name.endsWith('.lock'))
      : [];
    expect(existsSync(outPath)).toBe(false);
    expect(locksAfterRecovery).toEqual([]);
    const restored = await secondQueueClient.evaluate('window.queueAPI.getAll()');
    expect(restored.isPaused).toBe(true);
    expect(restored.jobs).toHaveLength(1);
    expect(restored.jobs[0]).toMatchObject({
      status: 'queued',
      payload: { outPath },
    });

    await secondMainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await secondMainClient.evaluate('document.visibilityState') === 'hidden',
      'crash 重開後主視窗隱藏',
    );
    await secondQueueClient.send('Page.close').catch(() => {});
    await waitForExit(secondApp);
    secondMainClient.close();
    secondQueueClient.close();
  }, 45000);

  test('未開始的工作在重開程式後仍保留，並維持暫停', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-queue-restore-'));
    tempProfiles.add(profile);
    const outPath = path.join(profile, 'queued-output.mp4');
    const audioPath = path.join(profile, 'queued-audio.wav');
    writeFileSync(audioPath, Buffer.from('queued audio plan source'));
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
      audioPlan: {
        buses: [
          { id: 'a1', inputs: [{ file: audioPath, sourceStream: 0, sourceChannel: 0, offset: 0.5, trimStart: 1, trimEnd: 6 }] },
          { id: 'a2', inputs: [{ file: audioPath, sourceStream: 0, sourceChannel: 1, offset: 0.5, trimStart: 1, trimEnd: 6 }] },
        ],
        streams: [{ id: 'stereo', layout: 'stereo', busIds: ['a1', 'a2'] }],
      },
    };
    const [seedId] = seedQueuedCapabilities(profile, { sourcePaths: [audioPath], outPath });

    const firstApp = await launchApp(profile);
    const firstMainTarget = await waitForTarget(
      firstApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得第一次主視窗',
    );
    const firstMainClient = await connectTarget(firstMainTarget);
    const firstQueueClient = await restoreSeededCapabilities(firstApp, firstMainClient, [seedId], { resume: false });
    await firstQueueClient.evaluate('window.queueAPI.setPause(true)');
    await firstMainClient.evaluate(`window.subtool.exportVideo(${JSON.stringify(payload)})`);
    const duplicateError = await firstMainClient.evaluate(`(async () => {
      try {
        await window.subtool.exportVideo(${JSON.stringify(payload)});
        return null;
      } catch (error) {
        return error && error.message ? error.message : String(error);
      }
    })()`);
    expect(duplicateError).toContain('同一個輸出檔案');
    const beforeRestart = await firstQueueClient.evaluate('window.queueAPI.getAll()');
    expect(beforeRestart.jobs).toHaveLength(1);
    expect(beforeRestart.jobs[0].status).toBe('queued');
    expect(beforeRestart.jobs[0].payload.duration).toBe(5.5);

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
    expect(afterRestart.jobs[0].payload.duration).toBe(5.5);

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

  test('重試工作會依監控畫面與持久化順序優先執行，重開後也維持相同順序', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'subtool-queue-retry-order-'));
    tempProfiles.add(profile);
    const imagePath = path.join(profile, 'retry-order-source.png');
    writeFileSync(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    const makePayload = label => ({
      outPath: path.join(profile, `retry-order-${label}.mp4`),
      assText: '',
      clips: [{
        type: 'image',
        path: imagePath,
        in: 0,
        out: 300,
        offset: 0,
        vtrack: 0,
        natW: 1,
        natH: 1,
      }],
      videoTracks: [{ vt: 0 }],
      duration: 300,
      width: 3840,
      height: 2160,
      fps: 25,
      format: 'h264',
      videoKbps: 500,
      audioPlan: null,
    });
    const retryPayloads = ['a', 'b', 'c'].map(makePayload);
    const seedIds = seedQueuedCapabilities(profile, retryPayloads.map(payload => ({
      sourcePaths: [imagePath],
      outPath: payload.outPath,
    })));

    const firstApp = await launchApp(profile);
    const firstMainTarget = await waitForTarget(
      firstApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得重試排序測試主視窗',
    );
    const firstMainClient = await connectTarget(firstMainTarget);
    const firstQueueClient = await restoreSeededCapabilities(firstApp, firstMainClient, seedIds, { resume: false });
    await firstQueueClient.evaluate('window.queueAPI.setPause(true)');

    const jobIds = [];
    for (const payload of retryPayloads) {
      jobIds.push(await firstMainClient.evaluate(
        `window.subtool.exportVideo(${JSON.stringify(payload)})`,
      ));
    }
    await waitUntil(
      async () => {
        const snapshot = await firstQueueClient.evaluate('window.queueAPI.getAll()');
        return snapshot.jobs.length === 3 && snapshot.jobs.every(job => job.status === 'queued');
      },
      '三份暫停中的等待工作',
    );

    expect(await firstQueueClient.evaluate(`window.queueAPI.stopJob(${JSON.stringify(jobIds[0])})`)).toBe(true);
    expect(await firstQueueClient.evaluate(`window.queueAPI.retryJob(${JSON.stringify(jobIds[0])})`)).toBe(true);

    const retried = await waitUntil(
      async () => {
        const snapshot = await firstQueueClient.evaluate('window.queueAPI.getAll()');
        return snapshot.jobs.length === 3 && snapshot.jobs.every(job => job.status === 'queued')
          ? snapshot
          : null;
      },
      '停止後重試的工作回到等待佇列',
    );
    expect(retried.jobs.map(job => job.id)).toEqual(jobIds);
    const persistedOrder = readdirSync(path.join(profile, 'export-queue'))
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(path.join(profile, 'export-queue', name), 'utf8')))
      .sort((a, b) => a.order - b.order)
      .map(job => job.id);
    expect(persistedOrder).toEqual(jobIds);

    await firstQueueClient.evaluate('window.queueAPI.setPause(false)');
    const started = await waitUntil(
      async () => {
        const snapshot = await firstQueueClient.evaluate('window.queueAPI.getAll()');
        return snapshot.jobs.find(job => job.status === 'running') || null;
      },
      '解除暫停後開始第一份等待工作',
      15000,
    );
    expect(started.id).toBe(jobIds[0]);

    await firstMainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await firstMainClient.evaluate('document.visibilityState') === 'hidden',
      '重試排序測試主視窗隱藏',
    );
    await firstQueueClient.send('Page.close').catch(() => {});
    await waitForExit(firstApp);
    firstMainClient.close();
    firstQueueClient.close();

    const secondApp = await launchApp(profile);
    const secondMainTarget = await waitForTarget(
      secondApp.port,
      target => target.type === 'page' && target.title === 'SUB TOOL',
      '取得重開後的重試排序主視窗',
    );
    const secondMainClient = await connectTarget(secondMainTarget);
    const secondQueueClient = await openQueueMonitor(secondApp, secondMainClient);
    const restored = await secondQueueClient.evaluate('window.queueAPI.getAll()');

    expect(restored.isPaused).toBe(true);
    expect(restored.jobs.map(job => job.id)).toEqual(jobIds);
    expect(restored.jobs.every(job => job.status === 'queued')).toBe(true);

    await secondQueueClient.evaluate('window.queueAPI.setPause(false)');
    const restarted = await waitUntil(
      async () => {
        const snapshot = await secondQueueClient.evaluate('window.queueAPI.getAll()');
        return snapshot.jobs.find(job => job.status === 'running') || null;
      },
      '重開後解除暫停時開始第一份等待工作',
      15000,
    );
    expect(restarted.id).toBe(jobIds[0]);

    await secondMainClient.evaluate('window.subtool.closeApp(); true');
    await waitUntil(
      async () => await secondMainClient.evaluate('document.visibilityState') === 'hidden',
      '重開後的重試排序主視窗隱藏',
    );
    await secondQueueClient.send('Page.close').catch(() => {});
    await waitForExit(secondApp);
    secondMainClient.close();
    secondQueueClient.close();
  }, 60000);
});

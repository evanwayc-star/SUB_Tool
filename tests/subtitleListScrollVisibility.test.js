import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  ...(process.platform === 'darwin'
    ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
    : [process.platform === 'win32' ? 'electron.exe' : 'electron']),
);
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'subtitle-list-scroll-visibility.cjs');
const RESULT_MARKER = 'SUBTITLE_LIST_SCROLL_RESULT:';

async function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      child.off('close', onClose);
    };
    const onClose = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('close', onClose);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待字幕列表 Electron fixture 逾時'));
    }, timeoutMs);
  });
}

async function runVisibilityFixture() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'subtool-subtitle-list-scroll-'));
  const bundleDir = path.join(tempRoot, 'bundle');
  const profileDir = path.join(tempRoot, 'profile');
  mkdirSync(profileDir, { recursive: true });
  let child = null;
  try {
    await build({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.mjs'),
      logLevel: 'silent',
      build: {
        outDir: bundleDir,
        emptyOutDir: true,
      },
    });
    const entryPath = path.join(bundleDir, 'index.html');
    if (!existsSync(entryPath)) throw new Error('Vite 未產生測試用 index.html');

    child = spawn(ELECTRON, [
      FIXTURE,
      `--app-entry=${pathToFileURL(entryPath).href}`,
      `--user-data-dir=${profileDir}`,
    ], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const status = await waitForExit(child);
    child = null;
    if (status.code !== 0) {
      throw new Error(`字幕列表 Electron fixture 失敗 (${status.code ?? status.signal})：${stderr}`);
    }
    const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith(RESULT_MARKER));
    if (!resultLine) throw new Error(`字幕列表 Electron fixture 沒有結果：${stdout}\n${stderr}`);
    return JSON.parse(resultLine.slice(RESULT_MARKER.length));
  } finally {
    try {
      if (child && child.exitCode == null && child.signalCode == null) {
        const closed = waitForExit(child, 5000);
        child.kill('SIGKILL');
        await closed;
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

describe('字幕列表選取列可視性', () => {
  it('從時間軸跨軌點選遠端字幕後，主選取列會進入列表 viewport', async () => {
    const result = await runVisibilityFixture();

    expect(result.initialRowCount).toBe(80);
    expect(result.rowCount).toBe(80);
    expect(result.framesWaited).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      selected: true,
      primary: true,
      listTrack: '1',
      visible: true,
    });
    expect(result.primaryId).toBe(result.targetId);
    expect(result.row.bottom).toBeGreaterThan(result.list.top);
    expect(result.row.top).toBeLessThan(result.list.bottom);
  }, 30000);
});

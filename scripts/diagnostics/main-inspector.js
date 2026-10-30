'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CdpClient, getJSON, waitFor, ELECTRON } = require('../acceptance/cdp-electron-harness.js');

// 六個診斷 caller 共用主行程的發現與准入；檢查完成前不安裝任何探針。
function findMainPid({ exec = execFileSync } = {}) {
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + "Get-CimInstance Win32_Process -Filter \"Name='SUB Tool.exe' or Name='electron.exe'\" | "
    + 'Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const raw = exec('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  }).trim();
  if (!raw) return 0;
  const rows = JSON.parse(raw);
  const candidates = (Array.isArray(rows) ? rows : [rows]).filter(row => {
    if (!Number.isSafeInteger(row.ProcessId) || row.ProcessId <= 0
      || typeof row.CommandLine !== 'string' || /--type(?:=|\s)/.test(row.CommandLine)) return false;
    return row.Name?.toLowerCase() === 'sub tool.exe'
      || (typeof row.ExecutablePath === 'string'
        && path.win32.normalize(row.ExecutablePath).toLowerCase() === path.win32.normalize(ELECTRON).toLowerCase());
  });
  if (candidates.length > 1) throw new Error('找到多個 SUB Tool 主行程，請以命令列 PID 指定本次診斷目標');
  return candidates[0]?.ProcessId || 0;
}

async function connectMainInspector(pid, {
  endpoint = 'http://127.0.0.1:9229/json/list',
  enable = process._debugProcess.bind(process),
  timeoutMs = 10000,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('診斷 PID 必須是正整數');
  enable(pid);
  const targets = await waitFor(async () => {
    const list = await getJSON(endpoint, Math.min(timeoutMs, 1000));
    return Array.isArray(list) && list.length ? list : null;
  }, 'SUB Tool 主行程 inspector', timeoutMs);
  // 9229 可被其他 Node / Electron 程序先占用；URL 存在不是目標身分證據。
  if (targets.length !== 1 || typeof targets[0]?.webSocketDebuggerUrl !== 'string') {
    throw new Error('主行程 inspector 目標不唯一或缺少連線位址');
  }
  const client = new CdpClient(targets[0].webSocketDebuggerUrl, {
    connectTimeoutMs: timeoutMs, timeoutMs,
  });
  try {
    await client.connect();
    const identity = await client.evaluate(`(() => ({
      pid: process.pid, type: process.type,
      name: process.type === 'browser' ? require('electron').app.getName() : null
    }))()`);
    if (identity?.pid !== pid || identity?.type !== 'browser'
      || !['sub-tool', 'SUB Tool'].includes(identity?.name)) {
      throw new Error(`inspector 不屬於指定的 SUB Tool 主行程 ${pid}（回報 PID ${identity?.pid ?? '未知'}）`);
    }
    // 准入只用短期限；既有長時間的 profile 命令仍可等候其原始期限。
    client.timeoutMs = 300000;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

module.exports = { findMainPid, connectMainInspector };

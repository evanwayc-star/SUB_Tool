'use strict';

/* 已完成匯出的紀錄（跨重啟保留）。
   ============================================================================
   為什麼不直接讓 done 工作走既有的 queue-store 持久化：

   queue-store.js 把 done / failed / stopped / stopping 視為 **terminal**，
   persistJob() 寫完就立刻刪檔、loadJobs() 讀到 terminal 記錄也會刪掉並跳過。
   那個 tombstone 機制是刻意的安全設計——它保證「已完成的工作不會在重啟後被誤當
   queued 重跑」，否則會以 -y 覆寫掉已經交付出去的成品（見 queue-store.js:147-152
   與 tests/queueStore.test.js「殘留的 terminal tombstone 不會被恢復或重跑」）。

   所以完成紀錄走**另一條路**：獨立的 history 檔，只存渲染完成卡片需要的欄位，
   **不含 payload**。history 記錄永遠不會進入排程（沒有 payload 就不可能被執行），
   上面那條安全性質因此完全不受影響。

   同時這也避免了把整份 payload（clips + audioPlan，可達數十 KB）無限累積在磁碟上。
============================================================================ */

const fs = require('fs');
const path = require('path');

const HISTORY_VERSION = 1;
const HISTORY_FILE = 'history.json';
/* 上限只是防呆，不是產品限制。使用者要的是「留下紀錄來檢驗」，
   200 筆足以涵蓋數週的交付量；超出時丟最舊的。 */
const MAX_ENTRIES = 200;

function historyPath(queueDir) {
  return path.join(queueDir, HISTORY_FILE);
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* 只留下監控畫面渲染完成卡片會用到的欄位（見 electron/queue.html createJobCard）：
   outPath 決定標題與「打開資料夾」、duration 決定時長欄、elapsedMs 與 completedAt
   決定「完成於 X · 花費 Y」。其餘一律不存。 */
function toEntry(job) {
  if (!job || typeof job.id !== 'string' || !job.id) return null;
  const outPath = job.payload?.outPath;
  if (typeof outPath !== 'string' || !outPath.trim()) return null;
  return {
    id: job.id,
    status: 'done',
    createdAt: finiteOr(job.createdAt, 0),
    completedAt: finiteOr(job.completedAt, Date.now()),
    elapsedMs: finiteOr(job.elapsedMs, 0),
    payload: {
      outPath,
      duration: finiteOr(job.payload?.duration, 0),
      format: typeof job.payload?.format === 'string' ? job.payload.format : null,
    },
  };
}

/* 讀不到或格式壞掉一律回空陣列——完成紀錄是稽核資料，不該讓它擋住程式啟動。 */
function load(queueDir) {
  if (!queueDir) return [];
  let raw;
  try {
    raw = fs.readFileSync(historyPath(queueDir), 'utf8');
  } catch (error) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return [];
  }
  if (!parsed || parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.entries)) return [];
  const seen = new Set();
  const entries = [];
  for (const candidate of parsed.entries) {
    const entry = toEntry(candidate);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function writeAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (cleanupError) {}
    throw error;
  }
}

function save(queueDir, entries) {
  if (!queueDir) return [];
  const trimmed = entries.slice(-MAX_ENTRIES);
  fs.mkdirSync(queueDir, { recursive: true });
  writeAtomic(historyPath(queueDir), `${JSON.stringify({ version: HISTORY_VERSION, entries: trimmed }, null, 2)}\n`);
  return trimmed;
}

/* 同一個 id 重新完成（重試後再成功）時取代舊紀錄，而不是留下兩筆。 */
function append(queueDir, job) {
  const entry = toEntry(job);
  if (!entry) return load(queueDir);
  const entries = load(queueDir).filter(item => item.id !== entry.id);
  entries.push(entry);
  return save(queueDir, entries);
}

function remove(queueDir, jobId) {
  const entries = load(queueDir);
  const next = entries.filter(entry => entry.id !== jobId);
  if (next.length === entries.length) return entries;
  return save(queueDir, next);
}

function clear(queueDir) {
  if (!queueDir) return [];
  try { fs.unlinkSync(historyPath(queueDir)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [];
}

module.exports = {
  HISTORY_VERSION,
  HISTORY_FILE,
  MAX_ENTRIES,
  historyPath,
  toEntry,
  load,
  save,
  append,
  remove,
  clear,
};

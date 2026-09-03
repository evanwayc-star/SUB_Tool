const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { isRestorable, isTerminal, JOB_STATUS } = require('./export-queue');

const STORE_VERSION = 1;
/* 跨多檔刪除／終態切換不能靠「依序 unlink」假裝交易：Windows 在 JSON 已刪、ASS
   被防毒鎖住時若當場 crash，重啟便不知道使用者其實已按過清除、或 ffmpeg 已經完成。
   這兩份 journal 是可原子寫入的意圖紀錄；QueueManager 以它們作恢復時的唯一裁決。 */
const JOURNAL_VERSION = 1;
const TERMINAL_OUTCOME_JOURNAL = '.queue-terminal-outcomes';
const PENDING_DELETE_JOURNAL = '.queue-pending-deletes';
/* 分類的唯一來源在 export-job-status.js；這裡保留同名薄包裝，讓既有呼叫端與
   模組匯出面不變（tests/queueStore.test.js 會 import 這兩個名字）。 */
const RESTORABLE_STATUSES = { has: isRestorable };
const TERMINAL_STATUSES = { has: isTerminal };

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const resolved = path.resolve(value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function collectSourcePaths(payload) {
  const paths = [];
  for (const clip of payload?.clips || []) {
    if (clip?.path) paths.push(clip.path);
    for (const channel of clip?.audio || []) {
      if (channel?.file) paths.push(channel.file);
    }
  }
  for (const bus of payload?.audioPlan?.buses || []) {
    for (const input of bus?.inputs || []) {
      if (input?.file) paths.push(input.file);
    }
  }
  return uniquePaths(paths);
}

function mergeSourcePaths(payload, storedPaths) {
  return uniquePaths([
    ...collectSourcePaths(payload),
    ...(Array.isArray(storedPaths) ? storedPaths : []),
  ]);
}

function safeId(id) {
  if (typeof id !== 'string' || !id) throw new TypeError('匯出工作缺少有效 id');
  return encodeURIComponent(id);
}

function jobPath(queueDir, id) {
  return path.join(queueDir, `${safeId(id)}.json`);
}

function logPath(queueDir, id) {
  return path.join(queueDir, `${safeId(id)}.log`);
}

function burnAssFileName(id) {
  const token = crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
  return `burn_${token}.ass`;
}

function safeAssPath(queueDir, assRef) {
  if (!isSafeAssRef(assRef)) {
    return null;
  }
  return path.join(queueDir, assRef);
}

function isSafeAssRef(assRef) {
  return typeof assRef === 'string' && !!assRef && path.basename(assRef) === assRef && assRef.endsWith('.ass');
}

function normaliseAttempt(value) {
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
}

function ensureDir(queueDir) {
  fs.mkdirSync(queueDir, { recursive: true });
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

function terminalOutcomeJournalPath(queueDir) {
  return path.join(queueDir, TERMINAL_OUTCOME_JOURNAL);
}

function pendingDeleteJournalPath(queueDir) {
  return path.join(queueDir, PENDING_DELETE_JOURNAL);
}

function pendingDeleteEntry(job) {
  safeId(job?.id);
  return { id: job.id, assRef: isSafeAssRef(job.assRef) ? job.assRef : null };
}

function terminalOutcomeEntry(job) {
  safeId(job?.id);
  if (!isTerminal(job?.status)) throw new TypeError(`終態工作 ${job?.id || '(unknown)'} 的 status 無效`);
  if (!job.payload || typeof job.payload !== 'object') {
    throw new TypeError(`終態工作 ${job.id} 缺少 payload`);
  }
  return {
    id: job.id,
    status: job.status,
    attempt: normaliseAttempt(job.attempt),
    createdAt: Number(job.createdAt) || 0,
    completedAt: Number(job.completedAt) || 0,
    elapsedMs: Number(job.elapsedMs) || 0,
    errorMsg: typeof job.errorMsg === 'string' ? job.errorMsg : null,
    payload: job.payload,
    assRef: isSafeAssRef(job.assRef) ? job.assRef : null,
    sourcePaths: mergeSourcePaths(job.payload, job.sourcePaths),
  };
}

function loadJournal(queueDir, filePathFor, field, normalise) {
  if (!queueDir) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePathFor(queueDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`${field} journal 格式損毀`);
  }
  if (!parsed || parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed[field])) {
    throw new Error(`${field} journal 版本或格式無效`);
  }
  const seen = new Set();
  const entries = [];
  for (const candidate of parsed[field]) {
    const entry = normalise(candidate);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function saveJournal(queueDir, filePathFor, field, entries, normalise) {
  if (!queueDir) throw new Error('匯出佇列目錄尚未初始化');
  const seen = new Set();
  const normalised = [];
  for (const candidate of entries || []) {
    const entry = normalise(candidate);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalised.push(entry);
  }
  ensureDir(queueDir);
  writeAtomic(filePathFor(queueDir), `${JSON.stringify({ version: JOURNAL_VERSION, [field]: normalised }, null, 2)}\n`);
  return normalised;
}

function loadTerminalOutcomes(queueDir) {
  return loadJournal(queueDir, terminalOutcomeJournalPath, 'outcomes', terminalOutcomeEntry);
}

function stageTerminalOutcome(queueDir, job) {
  const next = terminalOutcomeEntry(job);
  const entries = loadTerminalOutcomes(queueDir).filter(entry => entry.id !== next.id);
  entries.push(next);
  return saveJournal(queueDir, terminalOutcomeJournalPath, 'outcomes', entries, terminalOutcomeEntry);
}

function resolveTerminalOutcomes(queueDir, ids) {
  const resolved = new Set(Array.isArray(ids) ? ids : []);
  return saveJournal(
    queueDir,
    terminalOutcomeJournalPath,
    'outcomes',
    loadTerminalOutcomes(queueDir).filter(entry => !resolved.has(entry.id)),
    terminalOutcomeEntry,
  );
}

function loadPendingDeletes(queueDir) {
  return loadJournal(queueDir, pendingDeleteJournalPath, 'deletes', pendingDeleteEntry);
}

function stagePendingDeletes(queueDir, jobs) {
  const entries = loadPendingDeletes(queueDir);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  for (const job of jobs || []) {
    const entry = pendingDeleteEntry(job);
    const previous = byId.get(entry.id);
    const assRef = previous?.assRef || entry.assRef || null;
    byId.set(entry.id, { id: entry.id, assRef });
  }
  return saveJournal(queueDir, pendingDeleteJournalPath, 'deletes', Array.from(byId.values()), pendingDeleteEntry);
}

function resolvePendingDeletes(queueDir, ids) {
  const resolved = new Set(Array.isArray(ids) ? ids : []);
  return saveJournal(
    queueDir,
    pendingDeleteJournalPath,
    'deletes',
    loadPendingDeletes(queueDir).filter(entry => !resolved.has(entry.id)),
    pendingDeleteEntry,
  );
}

function removeJobFile(queueDir, id) {
  try { fs.unlinkSync(jobPath(queueDir, id)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function removeAssFile(queueDir, assRef) {
  const filePath = safeAssPath(queueDir, assRef);
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function removeLogFile(queueDir, id) {
  try { fs.unlinkSync(logPath(queueDir, id)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeAssFile(queueDir, assRef, content) {
  const filePath = safeAssPath(queueDir, assRef);
  if (!filePath) throw new TypeError('字幕暫存檔名無效');
  ensureDir(queueDir);
  writeAtomic(filePath, String(content ?? ''));
  return filePath;
}

function persistedRecord(job, order) {
  if (!job.payload || typeof job.payload !== 'object') {
    throw new TypeError(`匯出工作 ${job.id || '(unknown)'} 缺少 payload`);
  }
  const sourcePaths = mergeSourcePaths(job.payload, job.sourcePaths);
  return {
    version: STORE_VERSION,
    id: job.id,
    createdAt: Number(job.createdAt) || Date.now(),
    order: Number.isFinite(Number(order)) ? Number(order) : 0,
    status: job.status,
    attempt: normaliseAttempt(job.attempt),
    payload: job.payload,
    assRef: job.assRef || null,
    sourcePaths,
  };
}

function persistJob(queueDir, job, order = 0) {
  if (!RESTORABLE_STATUSES.has(job?.status) && !TERMINAL_STATUSES.has(job?.status)) {
    if (job?.id) removeJobFile(queueDir, job.id);
    return false;
  }
  ensureDir(queueDir);
  const record = persistedRecord(job, order);
  try {
    writeAtomic(jobPath(queueDir, job.id), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    /* 終態 intent 已由 QueueManager 的 journal 保護；這裡絕不能因新檔寫失敗
       刪掉舊 running snapshot，否則 RAM rollback 後重啟會直接遺失這份工作。 */
    throw error;
  }
  job.sourcePaths = record.sourcePaths;
  if (TERMINAL_STATUSES.has(job.status)) {
    // 先把磁碟狀態改成 terminal，再嘗試移除。即使 Windows 防毒或權限讓 unlink
    // 暫時失敗，重啟時也只會清理 tombstone，不會把已完成工作誤當 queued 重跑。
    try { removeJobFile(queueDir, job.id); } catch (error) {}
    return false;
  }
  return true;
}

function loadJobs(queueDir, { protectedAssRefs = [] } = {}) {
  const jobs = [];
  const warnings = [];
  if (!fs.existsSync(queueDir)) return { jobs, warnings };
  /* outcome journal 是 failed/stopped 的可重試 snapshot；若有殘留 stopping JSON，
     讀它時只能刪 tombstone，不能連同 journal 正在引用的 ASS 一起當孤兒刪掉。 */
  const protectedAss = new Set((protectedAssRefs || []).filter(isSafeAssRef));

  const files = fs.readdirSync(queueDir)
    .filter(name => name.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  const ids = new Set();

  for (const name of files) {
    const filePath = path.join(queueDir, name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!record || record.version !== STORE_VERSION || typeof record.id !== 'string' ||
          !record.id || !record.payload || typeof record.payload !== 'object') {
        throw new Error('格式或版本無效');
      }
      if (path.basename(jobPath(queueDir, record.id)) !== name) {
        throw new Error('工作檔名與 id 不一致');
      }
      if (ids.has(record.id)) throw new Error(`重複的工作 id：${record.id}`);
      ids.add(record.id);
      if (TERMINAL_STATUSES.has(record.status)) {
        try { removeJobFile(queueDir, record.id); } catch (error) {}
        if (record.assRef && !protectedAss.has(record.assRef)) {
          try { removeAssFile(queueDir, record.assRef); } catch (error) {}
        }
        continue;
      }
      if (!RESTORABLE_STATUSES.has(record.status)) throw new Error(`未知的工作狀態：${record.status}`);

      const sourcePaths = mergeSourcePaths(record.payload, record.sourcePaths);
      const missingPaths = sourcePaths.filter(sourcePath => !fs.existsSync(sourcePath));
      const assPath = record.assRef ? safeAssPath(queueDir, record.assRef) : null;
      if (record.assRef && (!assPath || !fs.existsSync(assPath))) {
        missingPaths.push(assPath || `無效字幕暫存：${record.assRef}`);
      }
      const missing = uniquePaths(missingPaths.filter(value => !String(value).startsWith('無效字幕暫存：')));
      const invalidAss = missingPaths.find(value => String(value).startsWith('無效字幕暫存：'));
      const missingLabels = invalidAss ? [...missing, invalidAss] : missing;
      const status = missingLabels.length ? 'missing-source' : 'queued';

      jobs.push({
        id: record.id,
        createdAt: Number(record.createdAt) || 0,
        status,
        attempt: normaliseAttempt(record.attempt),
        payload: record.payload,
        assRef: record.assRef || null,
        sourcePaths,
        senderId: null,
        pct: 0,
        elapsedMs: 0,
        etaS: null,
        errorMsg: missingLabels.length ? `找不到來源檔：\n${missingLabels.join('\n')}` : null,
        _persistOrder: Number.isFinite(Number(record.order)) ? Number(record.order) : Number.MAX_SAFE_INTEGER,
      });
    } catch (error) {
      warnings.push({ filePath, message: error.message || String(error) });
    }
  }

  jobs.sort((a, b) =>
    a._persistOrder - b._persistOrder ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id));
  return { jobs, warnings };
}

function cleanupOrphanAssFiles(queueDir, referencedAssFiles) {
  if (!fs.existsSync(queueDir)) return [];
  const referenced = new Set(
    (referencedAssFiles || []).filter(name => safeAssPath(queueDir, name)),
  );
  const removed = [];
  for (const name of fs.readdirSync(queueDir)) {
    if (!name.endsWith('.ass') || referenced.has(name)) continue;
    const matchingJobFile = path.join(queueDir, `${name.slice(0, -4)}.json`);
    if (fs.existsSync(matchingJobFile)) continue;
    removeAssFile(queueDir, name);
    removed.push(name);
  }
  return removed;
}

module.exports = {
  JOURNAL_VERSION,
  TERMINAL_OUTCOME_JOURNAL,
  PENDING_DELETE_JOURNAL,
  STORE_VERSION,
  RESTORABLE_STATUSES,
  TERMINAL_STATUSES,
  burnAssFileName,
  cleanupOrphanAssFiles,
  collectSourcePaths,
  ensureDir,
  jobPath,
  logPath,
  loadPendingDeletes,
  loadTerminalOutcomes,
  loadJobs,
  mergeSourcePaths,
  persistJob,
  removeAssFile,
  removeJobFile,
  removeLogFile,
  resolvePendingDeletes,
  resolveTerminalOutcomes,
  safeAssPath,
  stagePendingDeletes,
  stageTerminalOutcome,
  pendingDeleteJournalPath,
  terminalOutcomeJournalPath,
  writeAssFile,
};

/* ==============================================================================
   已完成匯出歷史紀錄持久化 (Queue History Store)
   ============================================================================== */

const HISTORY_VERSION = 1;
const HISTORY_FILE = 'history.json';
const MAX_ENTRIES = 200;

function historyPath(queueDir) {
  return path.join(queueDir, HISTORY_FILE);
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toHistoryEntry(job) {
  if (!job || typeof job.id !== 'string' || !job.id) return null;
  const outPath = job.payload?.outPath;
  if (typeof outPath !== 'string' || !outPath.trim()) return null;
  return {
    id: job.id,
    status: JOB_STATUS.DONE,
    createdAt: finiteOr(job.createdAt, 0),
    completedAt: finiteOr(job.completedAt, Date.now()),
    elapsedMs: finiteOr(job.elapsedMs, 0),
    payload: {
      outPath,
      duration: finiteOr(job.payload?.duration, 0),
      format: typeof job.payload?.format === 'string' ? job.payload.format : null,
      width: finiteOr(job.payload?.width, 0),
      height: finiteOr(job.payload?.height, 0),
      fps: finiteOr(job.payload?.fps, 0),
      videoKbps: finiteOr(job.payload?.videoKbps, 0),
      subtitleTracks: Array.isArray(job.payload?.subtitleTracks)
        ? job.payload.subtitleTracks.filter(n => typeof n === 'string')
        : undefined,
      timecodeWatermark: job.payload?.timecodeWatermark ? { start: null } : null,
    },
  };
}

function loadHistory(queueDir) {
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
    const entry = toHistoryEntry(candidate);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function saveHistory(queueDir, entries) {
  if (!queueDir) return [];
  const trimmed = entries.slice(-MAX_ENTRIES);
  fs.mkdirSync(queueDir, { recursive: true });
  writeAtomic(historyPath(queueDir), `${JSON.stringify({ version: HISTORY_VERSION, entries: trimmed }, null, 2)}\n`);
  return trimmed;
}

function appendHistory(queueDir, job) {
  const entry = toHistoryEntry(job);
  if (!entry) return loadHistory(queueDir);
  const entries = loadHistory(queueDir).filter(item => item.id !== entry.id);
  entries.push(entry);
  return saveHistory(queueDir, entries);
}

function removeHistory(queueDir, jobId) {
  const entries = loadHistory(queueDir);
  const next = entries.filter(entry => entry.id !== jobId);
  if (next.length === entries.length) return entries;
  return saveHistory(queueDir, next);
}

function clearHistory(queueDir) {
  if (!queueDir) return [];
  try { fs.unlinkSync(historyPath(queueDir)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [];
}

const QueueHistory = Object.freeze({
  HISTORY_VERSION,
  HISTORY_FILE,
  MAX_ENTRIES,
  historyPath,
  toEntry: toHistoryEntry,
  load: loadHistory,
  save: saveHistory,
  append: appendHistory,
  remove: removeHistory,
  clear: clearHistory,
});

module.exports.QueueHistory = QueueHistory;


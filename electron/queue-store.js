const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 1;
const RESTORABLE_STATUSES = new Set(['queued', 'running', 'missing-source']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'stopping']);

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
  if (typeof assRef !== 'string' || !assRef || path.basename(assRef) !== assRef || !assRef.endsWith('.ass')) {
    return null;
  }
  return path.join(queueDir, assRef);
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
    if (TERMINAL_STATUSES.has(job.status)) {
      try { removeJobFile(queueDir, job.id); } catch (cleanupError) {}
    }
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

function loadJobs(queueDir) {
  const jobs = [];
  const warnings = [];
  if (!fs.existsSync(queueDir)) return { jobs, warnings };

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
        if (record.assRef) {
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
  STORE_VERSION,
  RESTORABLE_STATUSES,
  TERMINAL_STATUSES,
  burnAssFileName,
  cleanupOrphanAssFiles,
  collectSourcePaths,
  ensureDir,
  jobPath,
  logPath,
  loadJobs,
  mergeSourcePaths,
  persistJob,
  removeAssFile,
  removeJobFile,
  removeLogFile,
  safeAssPath,
  writeAssFile,
};

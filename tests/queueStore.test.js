import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  burnAssFileName,
  cleanupOrphanAssFiles,
  collectSourcePaths,
  jobPath,
  logPath,
  loadJobs,
  loadPendingDeletes,
  loadTerminalOutcomes,
  mergeSourcePaths,
  persistJob,
  removeLogFile,
  resolvePendingDeletes,
  resolveTerminalOutcomes,
  stagePendingDeletes,
  stageTerminalOutcome,
  writeAssFile,
} = require('../electron/queue-store');

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-queue-store-'));
  tempDirs.push(dir);
  return dir;
}

function makeJob(overrides = {}) {
  return {
    id: 'export-test-1',
    createdAt: 1234,
    status: 'queued',
    payload: {
      outPath: 'C:\\output\\delivery.mp4',
      clips: [],
      videoTracks: [],
      audioPlan: null,
    },
    assRef: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  tempDirs.length = 0;
});

describe('匯出佇列持久化', () => {
  test('保存凍結 payload、工作順序，並將 running 恢復成 queued', () => {
    const dir = makeTempDir();
    const first = makeJob({ id: 'first', status: 'running' });
    const second = makeJob({ id: 'second', createdAt: 1000 });
    persistJob(dir, first, 1);
    persistJob(dir, second, 0);

    const result = loadJobs(dir);
    expect(result.warnings).toEqual([]);
    expect(result.jobs.map(job => job.id)).toEqual(['second', 'first']);
    expect(result.jobs.every(job => job.status === 'queued')).toBe(true);
    expect(result.jobs[1].payload.outPath).toBe(first.payload.outPath);
    expect(result.jobs[1].pct).toBe(0);
  });

  test('retry attempt 與終態 outcome 都會跨重啟保留 generation', () => {
    const dir = makeTempDir();
    const queued = makeJob({ id: 'attempted', attempt: 3 });
    const failed = makeJob({ id: 'attempted', status: 'failed', attempt: 3 });

    persistJob(dir, queued);
    stageTerminalOutcome(dir, failed);

    expect(loadJobs(dir).jobs).toEqual([expect.objectContaining({ id: 'attempted', attempt: 3 })]);
    expect(loadTerminalOutcomes(dir)).toEqual([expect.objectContaining({ id: 'attempted', attempt: 3 })]);
  });

  test('從影片、片段音訊與 audioPlan 蒐集去重後的來源路徑', () => {
    const dir = makeTempDir();
    const video = path.join(dir, 'source.mov');
    const audio = path.join(dir, 'source.wav');
    const planAudio = path.join(dir, 'external.wav');
    const paths = collectSourcePaths({
      clips: [
        { path: video, audio: [{ file: audio }, { file: audio }] },
        { path: video },
      ],
      audioPlan: { buses: [{ inputs: [{ file: planAudio }] }] },
    });

    expect(paths).toEqual([video, audio, planAudio].map(value => path.resolve(value)));
    expect(mergeSourcePaths({ clips: [{ path: video }] }, [])).toEqual([path.resolve(video)]);
  });

  test('恢復時將遺失來源或字幕暫存標成 missing-source', () => {
    const dir = makeTempDir();
    const source = path.join(dir, 'missing.mov');
    persistJob(dir, makeJob({
      sourcePaths: [source],
      assRef: 'export-test-1.ass',
    }));

    const [job] = loadJobs(dir).jobs;
    expect(job.status).toBe('missing-source');
    expect(job.errorMsg).toContain(source);
    expect(job.errorMsg).toContain('export-test-1.ass');
  });

  test('JSON 內偽造空 sourcePaths 仍會依 payload 重新驗出遺失素材', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'payload-missing.mov');
    persistJob(dir, makeJob({
      payload: {
        outPath: 'C:\\output\\delivery.mp4',
        clips: [{ path: missing }],
        videoTracks: [],
        audioPlan: null,
      },
      sourcePaths: [],
    }));
    const recordPath = jobPath(dir, 'export-test-1');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.sourcePaths = [];
    writeFileSync(recordPath, JSON.stringify(record), 'utf8');

    const [job] = loadJobs(dir).jobs;
    expect(job.status).toBe('missing-source');
    expect(job.errorMsg).toContain(missing);
  });

  test('字幕快照獨立原子寫入且可逐字讀回', () => {
    const dir = makeTempDir();
    const ass = '[Script Info]\nTitle: 測試\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,字幕';
    const filePath = writeAssFile(dir, 'export-test-1.ass', ass);
    expect(readFileSync(filePath, 'utf8')).toBe(ass);
  });

  test('ffmpeg 燒錄暫存檔名不受工作 id 的路徑或 filter 字元影響', () => {
    const name = burnAssFileName('../evil,fontsdir=C:\\escape');
    expect(name).toMatch(/^burn_[a-f0-9]{24}\.ass$/);
    expect(name).not.toMatch(/[\\/:,]/);
    expect(burnAssFileName('export-one')).not.toBe(burnAssFileName('export-two'));
  });

  test('工作 log 使用固定安全檔名，手動清除時可一併刪除', () => {
    const dir = makeTempDir();
    const filePath = logPath(dir, 'export-test-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, 'ffmpeg error', 'utf8');
    removeLogFile(dir, 'export-test-1');
    expect(existsSync(filePath)).toBe(false);
  });

  test('done、failed 與 stopped 不會成為可恢復的 job JSON snapshot', () => {
    const dir = makeTempDir();
    const queued = makeJob();
    persistJob(dir, queued);
    expect(readFileSync(jobPath(dir, queued.id), 'utf8')).toContain('"status": "queued"');

    for (const status of ['done', 'failed', 'stopped']) {
      persistJob(dir, { ...queued, status });
      expect(loadJobs(dir).jobs).toEqual([]);
      persistJob(dir, queued);
    }
  });

  test('殘留的 terminal tombstone 不會被恢復或重跑', () => {
    const dir = makeTempDir();
    const job = makeJob({ status: 'done', assRef: 'export-test-1.ass' });
    writeAssFile(dir, job.assRef, 'subtitle');
    persistJob(dir, makeJob());
    const record = JSON.parse(readFileSync(jobPath(dir, job.id), 'utf8'));
    record.status = 'done';
    record.assRef = job.assRef;
    writeFileSync(jobPath(dir, job.id), JSON.stringify(record), 'utf8');

    const result = loadJobs(dir);
    expect(result.jobs).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(jobPath(dir, job.id))).toBe(false);
    expect(existsSync(path.join(dir, job.assRef))).toBe(false);
  });

  test('損毀 JSON 不阻止其他工作恢復，且孤兒 ASS 會被清掉', () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'broken.json'), '{not-json', 'utf8');
    writeFileSync(path.join(dir, 'future.json'), '{"version":999}', 'utf8');
    writeFileSync(path.join(dir, 'kept.ass'), 'kept', 'utf8');
    writeFileSync(path.join(dir, 'future.ass'), 'future', 'utf8');
    writeFileSync(path.join(dir, 'orphan.ass'), 'orphan', 'utf8');
    persistJob(dir, makeJob({ id: 'valid', assRef: 'kept.ass' }));

    const result = loadJobs(dir);
    expect(result.jobs).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(cleanupOrphanAssFiles(dir, ['kept.ass'])).toEqual(['orphan.ass']);
    expect(existsSync(path.join(dir, 'future.ass'))).toBe(true);
  });
});

describe('跨檔交易 journal', () => {
  test('終態 outcome journal 保留可恢復的完成資訊，並可原子結清', () => {
    const dir = makeTempDir();
    const finished = makeJob({ status: 'done', completedAt: 4567, elapsedMs: 3000 });

    stageTerminalOutcome(dir, finished);
    expect(loadTerminalOutcomes(dir)).toEqual([expect.objectContaining({
      id: finished.id,
      status: 'done',
      completedAt: 4567,
      payload: finished.payload,
    })]);

    resolveTerminalOutcomes(dir, [finished.id]);
    expect(loadTerminalOutcomes(dir)).toEqual([]);
  });

  test('pending-delete journal 不會被 loadJobs 當成工作，且清理可重試', () => {
    const dir = makeTempDir();
    const queued = makeJob({ id: 'queued' });
    persistJob(dir, queued);

    stagePendingDeletes(dir, [{ id: queued.id, assRef: 'queued.ass' }]);
    expect(loadJobs(dir).jobs.map(job => job.id)).toEqual(['queued']);
    expect(loadPendingDeletes(dir)).toEqual([{ id: 'queued', assRef: 'queued.ass' }]);

    resolvePendingDeletes(dir, [queued.id]);
    expect(loadPendingDeletes(dir)).toEqual([]);
  });
});

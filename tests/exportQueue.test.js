/* 匯出佇列的排程與狀態（electron/export-queue.js）。

   這一整段原本住在 electron/main.js 裡，而它需要的狀態是【模組層的 let】
   （EXPORT_QUEUE_DIR / _queuePaused / _queueConcurrency / _activeQueueCount）。
   main.js 起不了 vitest，所以排程行為只能靠 electronQueueLifecycle.test.js
   那支會真的啟動 Electron 的端對端測試——它慢、會 flaky，而且它的 payload
   從未走過字幕燒錄／多聲道／ProRes／WAV 任何一條分支。

   佇列自己擁有狀態之後，這些行為可以直接測：並行度、暫停、失敗處理、
   完成後寫紀錄、關機收尾。

   測不到的：真正的 ffmpeg。runJob 是注入的，這裡用假的。 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createExportQueue } = require(path.join(ROOT, 'electron/export-queue.js'));

const JOB_STATUS = {
  QUEUED: 'queued', RUNNING: 'running', STOPPING: 'stopping',
  DONE: 'done', FAILED: 'failed', STOPPED: 'stopped', MISSING_SOURCE: 'missing-source',
};
const LIVE = new Set(['queued', 'running', 'stopping']);
const RESERVES = new Set(['queued', 'running', 'stopping']);

/* 夠用的假 ExportQueueState——真的那支已由 exportQueueState.test.js 測過。 */
function fakeState() {
  let jobs = [];
  return {
    jobs: () => jobs,
    load: v => { jobs = v.slice(); },
    add: j => { jobs.push(j); },
    get: id => jobs.find(j => j.id === id),
    remove: id => { const i = jobs.findIndex(j => j.id === id); return i < 0 ? null : jobs.splice(i, 1)[0]; },
    setStatus: (id, s, fields) => {
      const j = jobs.find(x => x.id === id);
      if (!j) return null;
      j.status = s;
      if (fields && typeof fields === 'object') Object.assign(j, fields);
      return j;
    },
    nextQueued: () => jobs.find(j => j.status === 'queued') || null,
    statusSnapshot: p => ({ paused: p, total: jobs.length }),
    liveWorkCount: () => jobs.filter(j => LIVE.has(j.status)).length,
    reorder: () => null, retry: () => null, stop: () => null,
  };
}

function make(over = {}) {
  const state = over.state || fakeState();
  const persisted = [];
  const appended = [];
  const onChanged = vi.fn();
  const queue = createExportQueue({
    dir: () => 'D:/queue',
    state,
    store: {
      ensureDir: vi.fn(),
      persistJob: (d, job, order) => persisted.push({ id: job.id, status: job.status, order }),
      removeJobFile: vi.fn(), removeAssFile: vi.fn(), removeLogFile: vi.fn(),
      collectSourcePaths: p => p?.sources || [],
      safeAssPath: (d, ref) => `${d}/${ref}`,
      loadJobs: () => ({ jobs: over.storedJobs || [], warnings: [] }),
      cleanupOrphanAssFiles: vi.fn(),
    },
    history: {
      append: (d, job) => appended.push(job.id),
      remove: vi.fn(),
      load: () => over.storedHistory || [],
    },
    JOB_STATUS,
    isLiveWork: s => LIVE.has(s),
    reservesOutput: s => RESERVES.has(s),
    admission: {
      sourcePathsOf: j => j.sourcePaths || j.payload?.sources || [],
      assertMasterMedia: () => {},
      assertOutputFormat: () => {},
      assertOutputAvailable: () => {},
      assertJobAdmissible: () => {},
      ...over.admission,
    },
    grantPersistedCapabilities: vi.fn(),
    canReadSource: over.canReadSource || (() => true),
    canWriteDelivery: over.canWriteDelivery || (() => true),
    isFile: over.isFile || (() => true),
    runJob: over.runJob || (async () => {}),
    onChanged,
    onJobFailed: over.onJobFailed,
    activeJobs: over.activeJobs || new Map(),
  });
  return { queue, state, persisted, appended, onChanged };
}

const job = (id, over = {}) => ({
  id, status: 'queued', assRef: null,
  payload: { outPath: `D:/out/${id}.mp4`, format: 'h264', sources: ['D:/m.mxf'] },
  ...over,
});

const settle = () => new Promise(r => setTimeout(r, 0));

describe('並行度', () => {
  it('預設一次只跑一個', async () => {
    let running = 0, maxRunning = 0;
    const { queue, state } = make({
      runJob: async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await settle();
        running--;
      },
    });
    state.load([job('a'), job('b'), job('c')]);
    queue.processQueue();
    await new Promise(r => setTimeout(r, 30));
    expect(maxRunning).toBe(1);
  });

  it('setConcurrency 提高後可同時跑多個，且夾在 1..3', async () => {
    let running = 0, maxRunning = 0;
    const { queue, state } = make({
      runJob: async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 15));
        running--;
      },
    });
    state.load([job('a'), job('b'), job('c'), job('d')]);
    queue.setConcurrency(3);
    expect(queue.concurrency).toBe(3);
    await new Promise(r => setTimeout(r, 10));
    expect(maxRunning).toBe(3);

    queue.setConcurrency(99);
    expect(queue.concurrency, '上限 3——兩個 NVENC 同時跑會耗盡 VRAM（ADR-0001）').toBe(3);
    queue.setConcurrency(0);
    expect(queue.concurrency).toBe(1);
  });
});

describe('暫停', () => {
  it('暫停時不開新工作，恢復後才跑', async () => {
    const runJob = vi.fn(async () => {});
    const { queue, state } = make({ runJob });
    state.load([job('a')]);
    queue.setPaused(true);
    queue.processQueue();
    await settle();
    expect(runJob).not.toHaveBeenCalled();

    queue.setPaused(false);
    await settle();
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it('isPaused 反映目前狀態（監控視窗靠它顯示按鈕）', () => {
    const { queue } = make();
    expect(queue.isPaused).toBe(false);
    queue.setPaused(true);
    expect(queue.isPaused).toBe(true);
  });
});

describe('失敗處理', () => {
  it('runJob 丟例外 → failed，並帶出錯誤訊息與通知', async () => {
    const onJobFailed = vi.fn();
    const { queue, state } = make({
      runJob: async () => { throw new Error('ffmpeg 結束碼 1'); },
      onJobFailed,
    });
    const j = job('a');
    state.load([j]);
    queue.processQueue();
    await new Promise(r => setTimeout(r, 10));
    expect(j.status).toBe('failed');
    expect(j.errorMsg).toContain('ffmpeg 結束碼 1');
    expect(onJobFailed).toHaveBeenCalled();
  });

  it('MISSING_SOURCE 這個 code 要對應到 missing-source 而不是 failed', async () => {
    const err = new Error('來源不見了'); err.code = 'MISSING_SOURCE';
    const { queue, state } = make({ runJob: async () => { throw err; } });
    const j = job('a');
    state.load([j]);
    queue.processQueue();
    await new Promise(r => setTimeout(r, 10));
    expect(j.status).toBe('missing-source');
  });

  it('來源檔不存在時不會開跑，直接標成 missing-source', async () => {
    const runJob = vi.fn(async () => {});
    const { queue, state } = make({ isFile: () => false, runJob });
    const j = job('a');
    state.load([j]);
    queue.processQueue();
    await settle();
    expect(runJob).not.toHaveBeenCalled();
    expect(j.status).toBe('missing-source');
    expect(j.errorMsg).toContain('找不到或未授權');
  });

  it('輸出位置未授權時擋下（failed，不是 missing-source）', async () => {
    const { queue, state } = make({ canWriteDelivery: () => false });
    const j = job('a');
    state.load([j]);
    queue.processQueue();
    await settle();
    expect(j.status).toBe('failed');
    expect(j.errorMsg).toContain('未經授權');
  });
});

describe('完成後的收尾', () => {
  it('done 時清掉半成品並寫入完成紀錄', async () => {
    const { queue, state, appended } = make({
      runJob: async j => { j.status = 'done'; },
    });
    state.load([job('a')]);
    queue.processQueue();
    await new Promise(r => setTimeout(r, 10));
    expect(appended, '「這份交付完成過」要留成紀錄').toEqual(['a']);
  });

  it('失敗的工作不寫進完成紀錄', async () => {
    const { queue, state, appended } = make({
      runJob: async () => { throw new Error('boom'); },
    });
    state.load([job('a')]);
    queue.processQueue();
    await new Promise(r => setTimeout(r, 10));
    expect(appended).toEqual([]);
  });
});

describe('persistAll', () => {
  it('已完成的工作不再寫 job 快照（由完成紀錄保存，寫了只會再刪一次）', () => {
    const { queue, state, persisted } = make();
    state.load([job('a', { status: 'done' }), job('b', { status: 'queued' })]);
    queue.persistAll();
    expect(persisted.map(p => p.id)).toEqual(['b']);
  });
});

describe('關機收尾', () => {
  it('執行中的工作落回 queued 並清掉進度（重啟後才能重跑）', async () => {
    const { queue, state } = make({ activeJobs: new Map() });
    const j = job('a', { status: 'running', pct: 55, elapsedMs: 1000, errorMsg: 'x' });
    state.load([j]);
    await queue.prepareForShutdown();
    expect(j.status).toBe('queued');
    expect(j.pct).toBe(0);
    expect(j.errorMsg).toBe(null);
  });

  it('關機後不可再加入工作', async () => {
    const { queue } = make();
    await queue.prepareForShutdown();
    expect(() => queue.addJob(job('x'))).toThrow(/正在關閉/);
  });

  it('prepareForShutdown 只會執行一次（回同一個 promise）', () => {
    const { queue } = make();
    expect(queue.prepareForShutdown()).toBe(queue.prepareForShutdown());
  });
});

describe('恢復', () => {
  it('有可執行工作時開機即暫停，等使用者確認', () => {
    const { queue } = make({ storedJobs: [job('a')] });
    queue.restoreJobs();
    expect(queue.isPaused).toBe(true);
  });

  /* 這一條的順序不可對調：完成紀錄不該讓佇列開機即暫停。 */
  it('只有完成紀錄時不暫停', () => {
    const { queue } = make({
      storedJobs: [],
      storedHistory: [{ id: 'old', status: 'done', payload: { outPath: 'D:/out/old.mp4' } }],
    });
    queue.restoreJobs();
    expect(queue.isPaused).toBe(false);
    expect(queue.jobs().map(j => j.id)).toEqual(['old']);
  });
});

describe('模組保持可測', () => {
  it('不 require electron／fs——相依一律注入', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'electron/export-queue.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

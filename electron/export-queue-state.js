const { isRetryable, isLiveWork } = require('./export-job-status');
'use strict';

/* 匯出佇列唯一的順序來源。這裡不保存第二份「可執行清單」：監控畫面、持久化 order
   與 scheduler 都從同一個有序 collection 讀取，避免重試或拖曳後兩種順序分歧。 */

function assertJob(job) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id) {
    throw new TypeError('匯出工作缺少有效 id');
  }
  return job;
}

class ExportQueueState {
  constructor(jobs = []) {
    this._jobs = [];
    this.load(jobs);
  }

  load(jobs = []) {
    if (!Array.isArray(jobs)) throw new TypeError('匯出佇列必須是工作陣列');
    const ids = new Set();
    const next = jobs.map(job => {
      assertJob(job);
      if (ids.has(job.id)) throw new Error(`匯出工作 id 重複：${job.id}`);
      ids.add(job.id);
      return job;
    });
    this._jobs = next;
    return this.jobs();
  }

  jobs() {
    return this._jobs.slice();
  }

  get(jobId) {
    return this._jobs.find(job => job.id === jobId) || null;
  }

  add(job) {
    assertJob(job);
    if (this.get(job.id)) throw new Error(`匯出工作 id 重複：${job.id}`);
    this._jobs.push(job);
    return job;
  }

  nextQueued() {
    return this._jobs.find(job => job.status === 'queued') || null;
  }

  /* 重試只改同一個 collection 內的工作狀態，不重新插入另一份排程陣列；因此
     重試工作在監控畫面、持久化 order 與 nextQueued() 都維持原本的位置。 */
  retry(jobId) {
    const job = this.get(jobId);
    if (!job || !isRetryable(job.status)) return null;
    job.status = 'queued';
    job.pct = 0;
    job.elapsedMs = 0;
    job.etaS = null;
    job.errorMsg = null;
    delete job.completedAt;
    return job;
  }

  setStatus(jobId, status, fields = null) {
    const job = this.get(jobId);
    if (!job || typeof status !== 'string' || !status) return null;
    job.status = status;
    if (fields && typeof fields === 'object') Object.assign(job, fields);
    return job;
  }

  stop(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.status === 'queued') return this.setStatus(jobId, 'stopped');
    if (job.status === 'running') return this.setStatus(jobId, 'stopping');
    return null;
  }

  remove(jobId) {
    const index = this._jobs.findIndex(job => job.id === jobId);
    if (index < 0) return null;
    return this._jobs.splice(index, 1)[0];
  }

  reorder(jobId, newIndex) {
    const oldIndex = this._jobs.findIndex(job => job.id === jobId);
    if (oldIndex < 0) return null;
    const [job] = this._jobs.splice(oldIndex, 1);
    const rawIndex = Number(newIndex);
    const target = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : this._jobs.length;
    this._jobs.splice(Math.max(0, Math.min(this._jobs.length, target)), 0, job);
    return job;
  }

  /* 「還在轉檔」的定義只有這一份。關閉主視窗要不要改開監控視窗、關閉監控視窗要不要
     先確認，兩個決定都讀這裡——否則兩處各寫一次 status 比對，改狀態名稱時會有一處
     漏掉，而漏掉的後果是【安靜地把使用者的轉檔砍掉】。
     stopping 也算：ffmpeg 還沒真正結束，這時關掉一樣會中斷它。 */
  liveWorkCount() {
    return this._jobs.filter(job => isLiveWork(job.status)).length;
  }

  statusSnapshot(isPaused = false) {
    return {
      waitingCount: this._jobs.filter(job => job.status === 'queued').length,
      missingCount: this._jobs.filter(job => job.status === 'missing-source').length,
      liveCount: this.liveWorkCount(),
      isPaused: !!isPaused,
    };
  }
}

module.exports = { ExportQueueState };

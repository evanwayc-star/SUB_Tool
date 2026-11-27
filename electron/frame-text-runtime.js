'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { FRAME_TEXT_LANGUAGES } = require('../shared/screen-text-options.cjs');

function validateFrame(request) {
  if (typeof request?.requestId !== 'string' || !request.requestId.trim() || request.requestId.length > 128) {
    throw new Error('單格辨識工作編號無效');
  }
  const png = request.pngBase64;
  if (typeof png !== 'string' || png.length < 44 || png.length > 64 * 1024 * 1024 || png.length % 4 !== 0) {
    throw new Error('單格辨識需要有效的 PNG 圖片（最多 48 MiB）');
  }
  const header = Buffer.from(png.slice(0, 44), 'base64');
  if (header.length < 33 || header.readBigUInt64BE() !== 0x89504e470d0a1a0an ||
      header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('單格辨識需要有效的 PNG 圖片');
  }
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 16 * 1024 * 1024) {
    throw new Error('辨識影格過大或圖片尺寸無效');
  }
  const languages = request.languages ?? [];
  if (!Array.isArray(languages) || languages.length > Object.keys(FRAME_TEXT_LANGUAGES).length ||
      languages.some(id => typeof id !== 'string' || !Object.hasOwn(FRAME_TEXT_LANGUAGES, id))) {
    throw new Error('未支援的本機辨識語言');
  }
  return { png, width, height, languages:[...new Set(languages)] };
}

function createFrameTextRuntime({ resourcesDir, idleMs = 45000, timeoutMs = 120000 } = {}) {
  let worker, active, idleTimer, stopping = Promise.resolve();
  function settle(error, text) {
    if (!active) return;
    const job = active;
    active = null;
    clearTimeout(job.timer);
    job.owner.removeListener('destroyed', job.destroyed);
    if (error) job.reject(error);
    else job.resolve({ text });
  }
  function stop(error) {
    clearTimeout(idleTimer);
    const ended = worker;
    worker = null;
    settle(error);
    if (ended) stopping = ended.terminate();
    return stopping;
  }
  function startWorker() {
    const file = require.resolve('./frame-text-worker.js').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const child = new Worker(file, { workerData: { resourcesDir } });
    child.on('error', error => { if (worker === child) void stop(error); });
    child.on('exit', () => {
      if (worker === child) {
        worker = null;
        settle(new Error('本機文字辨識引擎已結束'));
      }
    });
    child.on('message', result => {
      if (worker !== child || !active || result.id !== active.id) return;
      if (typeof result.text !== 'string') { void stop(new Error(result.error || '本機文字辨識失敗')); return; }
      settle(null, result.text);
      idleTimer = setTimeout(() => { void stop(); }, idleMs);
      idleTimer.unref();
    });
    return child;
  }
  async function recognize(owner, request) {
    const input = validateFrame(request);
    if (active) throw new Error('已有單格文字辨識工作正在執行');
    if (owner.isDestroyed()) throw new Error('辨識視窗已關閉');
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      const destroyed = () => { void stop(new Error('辨識視窗已關閉')); };
      const id = request.requestId;
      const job = { id, owner, resolve, reject, destroyed,
        timer: setTimeout(() => { void stop(new Error('本機文字辨識逾時')); }, timeoutMs) };
      active = job;
      owner.once('destroyed', destroyed);
      stopping.then(() => {
        if (active !== job) return;
        worker ||= startWorker();
        worker.postMessage({ id, ...input });
      }).catch(error => { if (active === job) void stop(error); });
    });
  }
  return {
    recognize,
    async cancel(owner, id) {
      if (!active || active.owner !== owner || active.id !== id) return false;
      await stop(new Error('已取消單格文字辨識'));
      return true;
    },
    close: () => stop(new Error('單格文字辨識已停止')),
  };
}

module.exports = { createFrameTextRuntime };

'use strict';

const { Worker } = require('node:worker_threads');
const os = require('node:os');

function ownWaveformProcess(child, own) {
  // Never let pid=0 change Electron's priority. A failed priority hint must
  // still register the writer with its cancellation / close owner.
  if (Number.isInteger(child?.pid) && child.pid > 0) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
  }
  own?.(child);
}

// The worker owns blocking NAS validation. Native writers remain in the main
// execution owner, and settlement includes both their close and worker exit.
function runSourceWaveformWorker(config, { describeAudio, execute, progress, publish, removed, session = {} }) {
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(require.resolve('./source-waveform-task.js'), { workerData: { ...config, cancellation: cancellation.buffer } });
  let child, failure, result, complete = false;
  const native = new Set(), pcmReplies = new Map(); let pcmSerial = 0;
  const cancel = () => {
    Atomics.store(cancellation, 0, 1);
    try { child?.kill(); } catch (_) {}
  };
  const current = () => {
    if (session.isCancelled?.()) cancel();
    if (Atomics.load(cancellation, 0)) throw Object.assign(new Error('媒體波形工作已取消'), { code: 'INGEST_SUPERSEDED' });
  };
  const reply = message => { try { worker.postMessage(message); } catch (_) {} };
  const errorData = error => ({ message: error.message, code: error.code, name: error.name });
  try { session.ownProcess?.({ kill: cancel }); } catch (error) { failure = error; cancel(); }
  const poll = setInterval(() => { if (session.isCancelled?.()) cancel(); }, 20);
  worker.on('message', message => {
    if (message.type === 'cacheRemoved') {
      // This is an already completed deletion, not a late UI result. Process
      // its identity even after cancellation, before the worker exit settles.
      try { removed?.(message.result); } catch (error) { failure ||= error; cancel(); }
      return;
    }
    if (message.type === 'pcmAck') {
      const waiting = pcmReplies.get(message.id); if (!waiting) return;
      pcmReplies.delete(message.id);
      if (message.error) waiting.reject(Object.assign(new Error(message.error.message), message.error));
      else waiting.resolve();
      return;
    }
    if (message.type === 'progress') {
      try { current(); progress(message.payload); } catch (_) { cancel(); }
      return;
    }
    if (message.type === 'complete') { complete = true; return; }
    if (message.type === 'error') { failure = Object.assign(new Error(message.error.message), message.error); return; }
    const work = (async () => {
      current();
      if (message.type === 'describe') return describeAudio ? await describeAudio(config.request.src) : config.request.audio;
      if (message.type === 'execute') {
        const pcmTasks = new Set(); let pcmFailure;
        try {
          const value = await execute(message.args, { ...message.options,
            onProcess: process => ownWaveformProcess(process, value => {
              child = value;
              if (message.options.streamPcm) value.stdout?.on('data', bytes => {
                if (pcmFailure || Atomics.load(cancellation, 0)) return;
                value.stdout.pause();
                const id = ++pcmSerial, data = Uint8Array.from(bytes);
                const task = new Promise((resolve, reject) => {
                  pcmReplies.set(id, { resolve, reject });
                  worker.postMessage({ type: 'nativePcm', id, bytes: data }, [data.buffer]);
                }).catch(error => { pcmFailure ||= error; try { value.kill(); } catch (_) {} })
                  .finally(() => { pcmTasks.delete(task); value.stdout.resume(); });
                pcmTasks.add(task);
              });
              if (Atomics.load(cancellation, 0)) cancel();
            }),
            onProgress: payload => reply({ type: 'nativeProgress', payload }),
          });
          await Promise.all([...pcmTasks]);
          if (pcmFailure) throw pcmFailure;
          return value;
        } catch (error) { await Promise.all([...pcmTasks]); throw pcmFailure || error; }
        finally { child = null; }
      }
      if (message.type === 'publish') { result = await publish(message.result); current(); return null; }
      throw new Error('未知波形工作請求');
    })();
    native.add(work);
    work.then(value => reply({ type: 'reply', id: message.id, value }), error => {
      if (error.code !== 'SOURCE_WAVE_RESUME_MISMATCH') { failure ||= error; cancel(); }
      reply({ type: 'reply', id: message.id, error: errorData(error) });
    }).finally(() => native.delete(work));
  });
  return new Promise((resolve, reject) => {
    worker.on('error', error => { failure ||= error; cancel(); });
    worker.once('exit', async code => {
      clearInterval(poll);
      for (const waiting of pcmReplies.values()) waiting.reject(new Error('波形背景工作已結束'));
      pcmReplies.clear();
      if (!complete || code !== 0) { failure ||= new Error('波形背景工作提前結束'); cancel(); }
      await Promise.allSettled([...native]);
      try { if (failure) throw failure; current(); resolve(result); } catch (error) { reject(error); }
    });
  });
}

module.exports = { runSourceWaveformWorker, ownWaveformProcess };

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  acquireLease,
  updateLease,
  releaseLease,
  listLeases,
} = require('./export-lease');

const CONTROL_PROTOCOL_VERSION = 1;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_DELETE_ATTEMPTS = 6;
const DEFAULT_DELETE_RETRY_MS = 50;
const DEFAULT_PIPE_ATTEMPTS = 3;
const DEFAULT_PIPE_RETRY_MS = 75;
const DEFAULT_PIPE_TIMEOUT_MS = 750;
const DEFAULT_RELEASE_WAIT_MS = 1500;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorWithCode(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function serializeError(error) {
  return {
    code: error?.code || 'EXPORT_WATCHDOG_ERROR',
    message: error?.message || String(error),
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 缺少設定');
  }
  if (typeof config.ffmpegPath !== 'string' || !config.ffmpegPath.trim()) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 缺少 ffmpegPath');
  }
  if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog args 必須是字串陣列');
  }
  for (const field of ['outPath', 'jobId', 'queueDir']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) {
      throw errorWithCode('INVALID_WATCHDOG_CONFIG', `匯出 watchdog 缺少 ${field}`);
    }
  }
  if (config.cwd != null && (typeof config.cwd !== 'string' || !config.cwd.trim())) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog cwd 必須是有效路徑');
  }
}

function makePipeName() {
  const suffix = crypto.randomBytes(12).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\subtool-export-${process.pid}-${suffix}`;
  }
  return path.join(os.tmpdir(), `subtool-export-${process.pid}-${suffix}.sock`);
}

function tokensMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function sendIpc(message) {
  if (typeof process.send !== 'function' || !process.connected) return false;
  try {
    // Parent termination can race with this call. Supplying a callback keeps a
    // late ERR_IPC_CHANNEL_CLOSED from becoming an unhandled process error.
    process.send(message, () => {});
    return true;
  } catch {
    return false;
  }
}

function writeSocketMessage(socket, message) {
  return new Promise(resolve => {
    if (!socket || socket.destroyed) {
      resolve(false);
      return;
    }
    socket.end(`${JSON.stringify(message)}\n`, () => resolve(true));
  });
}

function createControlServer({ pipeName, token, onCleanup }) {
  let server;
  let closed = false;

  const listenPromise = new Promise((resolve, reject) => {
    server = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = '';
      let handled = false;

      const rejectRequest = async (code, message) => {
        if (handled) return;
        handled = true;
        await writeSocketMessage(socket, {
          version: CONTROL_PROTOCOL_VERSION,
          ok: false,
          code,
          message,
        });
      };

      socket.on('data', chunk => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
          void rejectRequest('CONTROL_MESSAGE_TOO_LARGE', 'watchdog 控制訊息過大');
          return;
        }

        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        handled = true;

        let request;
        try {
          request = JSON.parse(buffer.slice(0, newline));
        } catch {
          void writeSocketMessage(socket, {
            version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            code: 'INVALID_CONTROL_MESSAGE',
            message: 'watchdog 控制訊息不是有效 JSON',
          });
          return;
        }

        if (request?.type !== 'cleanup') {
          void writeSocketMessage(socket, {
            version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            code: 'INVALID_CONTROL_MESSAGE',
            message: 'watchdog 只接受 cleanup 控制訊息',
          });
          return;
        }
        if (!tokensMatch(request.token, token)) {
          void writeSocketMessage(socket, {
            version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            code: 'TOKEN_MISMATCH',
            message: 'watchdog cleanup token 不符',
          });
          return;
        }

        Promise.resolve(onCleanup('recovery-request'))
          .then(result => writeSocketMessage(socket, {
            version: CONTROL_PROTOCOL_VERSION,
            ok: true,
            type: 'cleanup',
            ...result,
          }))
          .catch(error => writeSocketMessage(socket, {
            version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            ...serializeError(error),
          }));
      });

      socket.on('end', () => {
        if (!handled && buffer) void rejectRequest('INVALID_CONTROL_MESSAGE', 'watchdog 控制訊息不完整');
      });
      socket.on('error', () => {});
    });

    server.once('error', reject);
    server.listen(pipeName, () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      resolve();
    });
  });

  const close = () => new Promise(resolve => {
    if (closed || !server) {
      resolve();
      return;
    }
    closed = true;
    server.close(() => {
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(pipeName);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            // Unix domain socket cleanup is best effort; the random name is never reused.
          }
        }
      }
      resolve();
    });
  });

  return { listenPromise, close };
}

function terminateProcessTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;

  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL');
    } catch {}
    return;
  }

  let fallbackTimer;
  try {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const fallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    };
    killer.once('error', fallback);
    killer.once('exit', code => {
      if (code !== 0) fallback();
    });
    fallbackTimer = setTimeout(fallback, 500);
    fallbackTimer.unref?.();
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

async function deletePartialFile(outPath, options = {}) {
  const attempts = Math.max(1, options.deleteAttempts || DEFAULT_DELETE_ATTEMPTS);
  const retryMs = Math.max(0, options.deleteRetryMs ?? DEFAULT_DELETE_RETRY_MS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.promises.unlink(outPath);
      return { removed: true, missing: false, attempts: attempt };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { removed: false, missing: true, attempts: attempt };
      }
      lastError = error;
      if (attempt < attempts) await delay(retryMs * attempt);
    }
  }

  return {
    removed: false,
    missing: false,
    attempts,
    error: serializeError(lastError),
  };
}

async function startWatchdogRuntime(config, options = {}) {
  validateConfig(config);

  const token = crypto.randomBytes(32).toString('hex');
  const pipeName = makePipeName();
  let lease = null;
  let child = null;
  let childClosed = false;
  let cleanupReason = null;
  let finalizing = null;
  let finalResult = null;
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });

  const finalize = (code, signal, childError = null) => {
    if (finalizing) return finalizing;
    finalizing = (async () => {
      const needsCleanup = !!cleanupReason || childError || code !== 0;
      let cleanup = null;
      let release = null;

      if (needsCleanup) {
        const deletion = await deletePartialFile(config.outPath, options);
        cleanup = {
          reason: cleanupReason || (childError ? 'ffmpeg-error' : 'ffmpeg-nonzero'),
          ...deletion,
          released: false,
          retainedLease: false,
        };

        if (deletion.removed || deletion.missing) {
          try {
            release = await Promise.resolve(releaseLease({
              queueDir: config.queueDir,
              outPath: config.outPath,
              token,
            }));
            cleanup.released = true;
          } catch (error) {
            cleanup.retainedLease = true;
            cleanup.releaseError = serializeError(error);
          }
        } else {
          cleanup.retainedLease = true;
        }
        sendIpc({ type: 'cleanup', jobId: config.jobId, ...cleanup });
        if (!deletion.removed && !deletion.missing) {
          sendIpc({
            type: 'error',
            jobId: config.jobId,
            code: 'PARTIAL_CLEANUP_FAILED',
            message: deletion.error?.message || '匯出半成品刪除失敗，輸出鎖已保留',
          });
        } else if (cleanup.releaseError) {
          sendIpc({
            type: 'error',
            jobId: config.jobId,
            code: cleanup.releaseError.code || 'LEASE_RELEASE_FAILED',
            message: cleanup.releaseError.message,
          });
        }
      } else {
        try {
          release = await Promise.resolve(releaseLease({
            queueDir: config.queueDir,
            outPath: config.outPath,
            token,
          }));
        } catch (error) {
          release = { error: serializeError(error), retainedLease: true };
          sendIpc({
            type: 'error',
            jobId: config.jobId,
            code: 'LEASE_RELEASE_FAILED',
            message: error.message,
          });
        }
      }

      if (childError) {
        sendIpc({
          type: 'error',
          jobId: config.jobId,
          code: childError.code || 'FFMPEG_SPAWN_FAILED',
          message: childError.message,
        });
      } else if (code !== 0 && cleanupReason === 'ffmpeg-nonzero') {
        sendIpc({
          type: 'error',
          jobId: config.jobId,
          code: 'FFMPEG_EXIT',
          message: `ffmpeg 結束碼 ${code}${signal ? ` (${signal})` : ''}`,
        });
      }

      finalResult = {
        type: 'exit',
        jobId: config.jobId,
        ok: !needsCleanup && !release?.error,
        code,
        signal,
        cleanup,
        release,
      };
      sendIpc(finalResult);
      resolveDone(finalResult);
      return finalResult;
    })();
    return finalizing;
  };

  const requestCleanup = async (reason = 'stop') => {
    if (!cleanupReason) cleanupReason = reason;
    if (finalResult) return finalResult.cleanup || {
      reason,
      removed: false,
      missing: false,
      released: true,
      alreadyFinished: true,
    };

    if (child && !childClosed) {
      terminateProcessTree(child);
    } else if (lease) {
      void finalize(null, null);
    }

    const result = await done;
    return result.cleanup || {
      reason,
      removed: false,
      missing: false,
      released: !result.release?.error,
      alreadyFinished: true,
    };
  };

  const control = createControlServer({
    pipeName,
    token,
    onCleanup: requestCleanup,
  });

  try {
    await control.listenPromise;
    lease = await Promise.resolve(acquireLease({
      queueDir: config.queueDir,
      outPath: config.outPath,
      jobId: config.jobId,
      token,
      watchdogPid: process.pid,
      pipeName,
    }));
  } catch (error) {
    await control.close();
    throw error;
  }

  if (cleanupReason) {
    void finalize(null, null);
    return { done, requestCleanup, close: control.close, pipeName, token };
  }

  try {
    child = spawn(config.ffmpegPath, config.args, {
      cwd: config.cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    cleanupReason = 'ffmpeg-spawn-failed';
    void finalize(null, null, error);
    return { done, requestCleanup, close: control.close, pipeName, token };
  }

  child.stderr.on('data', chunk => {
    try {
      process.stderr.write(chunk);
    } catch {}
  });
  child.stderr.on('error', () => {});

  child.once('error', error => {
    cleanupReason ||= 'ffmpeg-spawn-failed';
    void finalize(null, null, error);
  });
  child.once('close', (code, signal) => {
    childClosed = true;
    if (code !== 0 && !cleanupReason) cleanupReason = 'ffmpeg-nonzero';
    void finalize(code, signal);
  });

  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch {
    return { done, requestCleanup, close: control.close, pipeName, token };
  }

  if (cleanupReason) {
    void requestCleanup(cleanupReason);
    return { done, requestCleanup, close: control.close, pipeName, token };
  }

  try {
    await Promise.resolve(updateLease({
      queueDir: config.queueDir,
      outPath: config.outPath,
      token,
      watchdogPid: process.pid,
      ffmpegPid: child.pid,
      pipeName,
    }));
  } catch (error) {
    cleanupReason = 'lease-update-failed';
    sendIpc({
      type: 'error',
      jobId: config.jobId,
      code: error.code || 'LEASE_UPDATE_FAILED',
      message: error.message,
    });
    void requestCleanup(cleanupReason);
    return { done, requestCleanup, close: control.close, pipeName, token };
  }

  sendIpc({
    type: 'ready',
    jobId: config.jobId,
    watchdogPid: process.pid,
    ffmpegPid: child.pid,
  });

  return { done, requestCleanup, close: control.close, pipeName, token };
}

function requestPipeCleanup(pipeName, token, options = {}) {
  const timeoutMs = Math.max(50, options.pipeTimeoutMs || DEFAULT_PIPE_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection(pipeName);

    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => {
      fail(errorWithCode('CONTROL_PIPE_TIMEOUT', `watchdog pipe timeout: ${pipeName}`));
    });
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'cleanup',
        token,
      })}\n`);
    });
    socket.on('data', chunk => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
        fail(errorWithCode('CONTROL_MESSAGE_TOO_LARGE', 'watchdog pipe 回應過大'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;

      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        fail(errorWithCode('INVALID_CONTROL_RESPONSE', 'watchdog pipe 回應不是有效 JSON', error));
        return;
      }

      settled = true;
      socket.end();
      resolve(response);
    });
    socket.once('end', () => {
      if (!settled) fail(errorWithCode('CONTROL_PIPE_CLOSED', 'watchdog pipe 未回應就關閉'));
    });
  });
}

async function waitForLeaseRelease(lockPath, options = {}) {
  const waitMs = Math.max(0, options.releaseWaitMs ?? DEFAULT_RELEASE_WAIT_MS);
  const retryMs = Math.max(10, options.pipeRetryMs || DEFAULT_PIPE_RETRY_MS);
  const deadline = Date.now() + waitMs;
  do {
    if (!fs.existsSync(lockPath)) return true;
    await delay(retryMs);
  } while (Date.now() <= deadline);
  return !fs.existsSync(lockPath);
}

function isMissingPipeError(error) {
  return ['ENOENT', 'ECONNREFUSED']
    .includes(error?.code);
}

async function recoverExportLeases(queueDir, options = {}) {
  const recovered = [];
  const warnings = [];
  let entries;

  try {
    entries = await Promise.resolve(listLeases(queueDir));
  } catch (error) {
    return {
      recovered,
      warnings: [{
        code: error.code || 'LEASE_SCAN_FAILED',
        message: error.message,
      }],
    };
  }

  for (const entry of entries) {
    if (!entry?.valid) {
      warnings.push({
        code: 'LEASE_CORRUPT',
        key: entry?.key,
        lockPath: entry?.lockPath,
        message: entry?.error?.message || '損壞的匯出鎖已保留，需人工檢查',
      });
      continue;
    }

    const owner = entry.owner;
    let liveResponse = null;
    let missingPipe = !owner?.pipeName;
    let lastPipeError = null;
    const pipeAttempts = Math.max(1, options.pipeAttempts || DEFAULT_PIPE_ATTEMPTS);

    if (owner?.pipeName) {
      for (let attempt = 1; attempt <= pipeAttempts; attempt += 1) {
        try {
          liveResponse = await requestPipeCleanup(owner.pipeName, owner.token, options);
          missingPipe = false;
          break;
        } catch (error) {
          lastPipeError = error;
          if (!isMissingPipeError(error)) {
            missingPipe = false;
            break;
          }
          missingPipe = true;
          if (attempt < pipeAttempts) {
            await delay(Math.max(0, options.pipeRetryMs ?? DEFAULT_PIPE_RETRY_MS) * attempt);
          }
        }
      }
    }

    if (liveResponse) {
      if (!liveResponse.ok) {
        warnings.push({
          code: liveResponse.code || 'LIVE_WATCHDOG_REJECTED',
          key: entry.key,
          outPath: owner.outPath,
          message: liveResponse.message || '仍在執行的 watchdog 拒絕 cleanup，鎖已保留',
        });
        continue;
      }

      const released = await waitForLeaseRelease(entry.lockPath, options);
      if (!released) {
        warnings.push({
          code: 'LIVE_LEASE_NOT_RELEASED',
          key: entry.key,
          outPath: owner.outPath,
          message: 'watchdog 已回應 cleanup，但輸出鎖仍存在',
        });
        continue;
      }

      recovered.push({
        key: entry.key,
        outPath: owner.outPath,
        mode: 'live',
        cleanup: liveResponse,
      });
      continue;
    }

    if (!missingPipe) {
      warnings.push({
        code: lastPipeError?.code || 'LIVE_WATCHDOG_UNCERTAIN',
        key: entry.key,
        outPath: owner.outPath,
        message: lastPipeError?.message || 'watchdog pipe 狀態不明，鎖已保留',
      });
      continue;
    }

    const deletion = await deletePartialFile(owner.outPath, options);
    if (!deletion.removed && !deletion.missing) {
      warnings.push({
        code: 'PARTIAL_CLEANUP_FAILED',
        key: entry.key,
        outPath: owner.outPath,
        message: deletion.error?.message || '無法刪除匯出半成品，鎖已保留',
      });
      continue;
    }

    try {
      await Promise.resolve(releaseLease({
        queueDir,
        outPath: owner.outPath,
        token: owner.token,
      }));
      recovered.push({
        key: entry.key,
        outPath: owner.outPath,
        mode: 'stale',
        cleanup: deletion,
      });
    } catch (error) {
      warnings.push({
        code: error.code || 'LEASE_RELEASE_FAILED',
        key: entry.key,
        outPath: owner.outPath,
        message: error.message,
      });
    }
  }

  return { recovered, warnings };
}

function spawnExportWatchdog(config, options = {}) {
  validateConfig(config);

  const child = spawn(options.nodePath || process.execPath, [options.scriptPath || __filename], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(options.env || {}),
    },
  });

  let readySettled = false;
  let completionSettled = false;
  let resolveReady;
  let rejectReady;
  let resolveCompletion;
  let rejectCompletion;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const rejectStartup = message => {
    const error = errorWithCode(
      message?.code || 'WATCHDOG_START_FAILED',
      message?.message || '匯出 watchdog 啟動失敗',
    );
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(error);
    }
  };

  child.stderr.on('data', chunk => {
    options.onStderr?.(chunk);
  });
  child.stderr.on('error', () => {});
  child.on('message', message => {
    options.onMessage?.(message);
    if (message?.type === 'ready' && !readySettled) {
      readySettled = true;
      resolveReady(message);
    } else if (message?.type === 'error' && !readySettled) {
      rejectStartup(message);
    } else if (message?.type === 'exit' && !completionSettled) {
      completionSettled = true;
      resolveCompletion(message);
    }
  });
  child.once('error', error => rejectStartup({
    code: error.code || 'WATCHDOG_SPAWN_FAILED',
    message: error.message,
  }));
  child.once('exit', (code, signal) => {
    if (!readySettled) {
      rejectStartup({
        code: 'WATCHDOG_EXITED',
        message: `匯出 watchdog 尚未 ready 就結束 (${code ?? signal ?? 'unknown'})`,
      });
      return;
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(errorWithCode(
        'WATCHDOG_EXITED',
        `匯出 watchdog 未回傳結果就結束 (${code ?? signal ?? 'unknown'})`,
      ));
    }
  });

  try {
    child.send({ ...config, type: 'start' }, error => {
      if (error) rejectStartup({
        code: error.code || 'WATCHDOG_IPC_FAILED',
        message: error.message,
      });
    });
  } catch (error) {
    rejectStartup({
      code: error.code || 'WATCHDOG_IPC_FAILED',
      message: error.message,
    });
  }

  const stop = reason => {
    if (!child.connected) return false;
    try {
      child.send({ type: 'stop', reason: reason || 'stop' });
      return true;
    } catch {
      return false;
    }
  };

  return {
    child,
    process: child,
    ready,
    completion,
    stop,
    disconnect() {
      if (!child.connected) return false;
      child.disconnect();
      return true;
    },
  };
}

async function runStandalone() {
  let runtime = null;
  let started = false;
  let pendingCleanupReason = null;

  // stderr is a pipe owned by Electron main. If main is force-killed while
  // ffmpeg is still producing diagnostics, EPIPE must not take down the
  // watchdog before its disconnect cleanup can stop the ffmpeg process tree.
  process.stderr.on('error', () => {});

  const closeAndDisconnect = async () => {
    if (runtime) await runtime.close();
    if (process.connected) {
      try {
        process.disconnect();
      } catch {}
    }
  };

  process.on('message', message => {
    if (message?.type === 'start' && !started) {
      started = true;
      void (async () => {
        try {
          runtime = await startWatchdogRuntime(message);
          if (pendingCleanupReason) {
            void runtime.requestCleanup(pendingCleanupReason);
          }
          await runtime.done;
        } catch (error) {
          sendIpc({ type: 'error', ...serializeError(error), jobId: message?.jobId });
        } finally {
          await closeAndDisconnect();
        }
      })();
      return;
    }

    if (message?.type === 'stop') {
      pendingCleanupReason ||= message.reason || 'stop';
      if (runtime) void runtime.requestCleanup(pendingCleanupReason);
    }
  });

  process.on('disconnect', () => {
    pendingCleanupReason ||= 'parent-disconnect';
    if (runtime) void runtime.requestCleanup(pendingCleanupReason);
  });
}

if (require.main === module) {
  void runStandalone();
}

module.exports = {
  spawnExportWatchdog,
  recoverExportLeases,
};

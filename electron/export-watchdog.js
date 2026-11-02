'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createExportArtifact, isDiscOutput } = require('./export-artifact');
const { assertDeliveryInputEvidence } = require('./delivery-temporary-input');
const {
  acquireLease,
  updateLease,
  releaseLease,
  listLeases,
  stagePathForCanonical,
  assertOutputAuthority,
  captureOutputDirectory,
  captureOutputAuthority,
  assertDistinctSourceEntries,
  assertDeliveryDestinationEvidenceAsync,
  normalizeOutputPath,
  outputKey,
  outputReservationEntry,
  leaseRoot,
  prepareNativeWorkspace,
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

function fileIdentity(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw errorWithCode('UNSAFE_DELIVERY_STAGE', '匯出暫存成品身分已變更，檔案與輸出鎖已保留');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function assertStageIdentity(file, expected) {
  const current = fileIdentity(fs.lstatSync(file, { bigint: true }));
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw errorWithCode('UNSAFE_DELIVERY_STAGE', '匯出暫存成品已被替換，檔案與輸出鎖已保留');
  }
}

// Detect ordinary in-place changes while destination hashing yields. This is
// metadata evidence, not a content fingerprint or an OS-level write lock:
// same-metadata writes and changes between the final check and rename remain
// possible and require a native handle-based commit to exclude completely.
function stageStatMetadata(stat) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]));
}

function stageMetadata(file, expected) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    const identity = fileIdentity(stat);
    if (identity.dev !== expected.dev || identity.ino !== expected.ino) throw new Error('stage identity changed');
    return stageStatMetadata(stat);
  } catch (error) {
    throw errorWithCode('DELIVERY_STAGE_CHANGED', '無法確認匯出暫存成品是否變更；成品與輸出鎖已保留', error);
  }
}

function assertStageMetadata(file, expected, before) {
  const after = stageMetadata(file, expected);
  if (after.some((value, index) => value !== before[index])) {
    throw errorWithCode('DELIVERY_STAGE_CHANGED', '匯出暫存成品在核對期間變更；成品與輸出鎖已保留');
  }
}

// A destination that changes after this writer starts belongs to a later
// operation; keep that state and do not publish this older job over it.
function destinationIdentity(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDestinationIdentity(file, expected) {
  let current;
  try { current = destinationIdentity(file); }
  catch (error) {
    throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '無法確認輸出檔是否變更；已保留暫存成品及輸出鎖', error);
  }
  if ((current === null) !== (expected === null)
    || (current && current.some((value, index) => value !== expected[index]))) {
    throw errorWithCode('DELIVERY_DESTINATION_CHANGED', '輸出檔在匯出期間變更；已保留新內容、暫存成品及輸出鎖');
  }
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
  if (config.args.at(-1) !== config.outPath) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 的最後一個 FFmpeg 參數必須是單一 outPath');
  }
  if (isDiscOutput(config.outputFormat)
    && path.extname(config.outPath).toLowerCase() !== '.iso') {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '光碟匯出必須使用單一 ISO 輸出路徑');
  }
  if (config.outputPaths != null) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 僅接受單一 outPath');
  }
  if (config.stagePath != null) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出暫存路徑只能由 watchdog 建立');
  }
  if (config.sourcePaths != null && (!Array.isArray(config.sourcePaths) || config.sourcePaths.some(file => typeof file !== 'string' || !file.trim()))) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 來源路徑必須是字串陣列');
  }
  if (config.inputEvidence != null && !Array.isArray(config.inputEvidence)) {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 暫存輸入證據必須是陣列');
  }
  if (typeof config.sharedQueueDir !== 'string' || !path.isAbsolute(config.sharedQueueDir)
    || !config.sharedAuthority || typeof config.sharedAuthority !== 'object') {
    throw errorWithCode('INVALID_WATCHDOG_CONFIG', '匯出 watchdog 缺少可信共用輸出鎖目錄');
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
      if (options.assertOutput) {
        options.assertOutput();
        fs.unlinkSync(outPath);
      } else await fs.promises.unlink(outPath);
      return { removed: true, missing: false, attempts: attempt };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // ENOENT can also mean the authorized parent disappeared after the
        // previous check. Only treat the stage as absent if the same parent
        // is still present; otherwise keep both the stage owner and lease.
        try {
          options.assertDirectory?.();
          return { removed: false, missing: true, attempts: attempt };
        } catch (directoryError) { error = directoryError; }
      }
      // A failed authority check or unlink leaves the stage uncertain. A later
      // retry cannot prove the bytes stayed unchanged, even if inode and
      // timestamps appear identical. Retain the stage and its lease instead.
      if (options.assertOutput) {
        const original = serializeError(error);
        const uncertain = errorWithCode('PARTIAL_DELETE_UNCERTAIN',
          `無法安全確認或清理暫存檔（${original.code}：${original.message}），檔案與輸出鎖已保留`, error);
        return { removed:false, missing:false, attempts:attempt,
          error:{...serializeError(uncertain),cause:original} };
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
  const outputAuthority = config.outputAuthority;
  assertOutputAuthority(outputAuthority, config.outPath);
  // The acquired destination stays canonical for the entire writer lifetime.
  // Re-resolving a selected alias after it changes would also change its lease key.
  config = { ...config, outPath: outputAuthority.outPath };
  const assertDirectory = () => assertOutputAuthority(outputAuthority, config.outPath);
  const assertSharedDirectory = () => {
    try {
      assertOutputAuthority(config.sharedAuthority, config.sharedAuthority.requestedPath);
      const expected = path.join(leaseRoot(config.sharedQueueDir), '.subtool-root-proof');
      if (normalizeOutputPath(expected) !== normalizeOutputPath(config.sharedAuthority.outPath)) throw new Error('共用鎖目錄不相符');
    } catch (error) { throw errorWithCode('SHARED_OUTPUT_LOCK_UNAVAILABLE', '無法確認共用輸出鎖目錄；交付未啟動', error); }
  };

  const token = crypto.randomBytes(32).toString('hex');
  const pipeName = makePipeName();
  const stagePath = stagePathForCanonical(config.outPath, token);
  let stageIdentity = null;
  let stageReservationMetadata = null;
  let destinationBefore = null;
  let nativeWorkspace = null;
  const assertOutput = () => {
    assertDirectory();
    assertSharedDirectory();
    nativeWorkspace?.assertCurrent();
    if (stageIdentity) assertStageIdentity(stagePath, stageIdentity);
  };
  const assertReservedStage = () => {
    if (!stageReservationMetadata) return;
    if (BigInt(stageReservationMetadata[3]) !== 0n)
      throw errorWithCode('DELIVERY_STAGE_CHANGED', '匯出暫存預留檔不是空檔；成品與輸出鎖已保留');
    assertStageMetadata(stagePath, stageIdentity, stageReservationMetadata);
  };
  let artifactTempDir = null;
  let leasesAcquired = false;
  let leaseKey = null;
  let aliasLease = null;
  let sharedLease = null;
  let starting = true;
  let child = null;
  let childClosed = false;
  let nativeChildError = null;
  let terminationRequested = false;
  let cleanupReason = null;
  let finalizing = null;
  let finalResult = null;
  const finalizerAbort = new AbortController();
  const recordWriter = (writerSpawnPending, ffmpegPid) => {
    const update = { token, writerSpawnPending, ...(ffmpegPid == null ? {} : { ffmpegPid }) };
    assertSharedDirectory();
    updateLease({ ...update, queueDir: config.sharedQueueDir, outPath: sharedLease.outPath, leaseKey: sharedLease.key });
    updateLease({ ...update, queueDir: config.queueDir, outPath: config.outPath, leaseKey });
    if (aliasLease) updateLease({ ...update, queueDir: config.queueDir, outPath: aliasLease.outPath, leaseKey: aliasLease.key });
  };
  const artifact = createExportArtifact({ ...config, stagePath }, {
    signal: finalizerAbort.signal,
    assertOutput,
    onWorkspacePrepared: stage => updateLease({ queueDir: config.queueDir, outPath: config.outPath,
      token, leaseKey, discWorkspace: stage, discWorkspacePending: false }),
    onOutputStart: () => {
      assertOutput();
      if (!stageIdentity) {
        const fd = fs.openSync(stagePath, 'wx');
        try {
          const stat = fs.fstatSync(fd, { bigint: true });
          stageIdentity = fileIdentity(stat);
          stageReservationMetadata = stageStatMetadata(stat);
        }
        finally { fs.closeSync(fd); }
      }
      if (leasesAcquired) updateLease({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey, outputStarted: true, stageIdentity });
      assertReservedStage();
    },
    onBeforeProcess: () => {
      recordWriter(true);
      assertReservedStage();
    },
    onProcess: childProcess => {
      // The native writer now owns the file; its subsequent changes are not
      // evidence that the original empty reservation was externally modified.
      stageReservationMetadata = null;
      recordWriter(false, childProcess.pid);
    },
    onProgress: progress => sendIpc({ type: 'progress', progress }),
  }, options.artifactAdapters);
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });

  const releaseOutputs = async () => {
    if (!leasesAcquired && !aliasLease && !sharedLease) return undefined;
    try {
      let result;
      if (leasesAcquired) {
        result = await Promise.resolve(releaseLease({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey }));
        leasesAcquired = false;
      }
      if (aliasLease) {
        await Promise.resolve(releaseLease({ queueDir: config.queueDir, outPath: aliasLease.outPath, token, leaseKey: aliasLease.key }));
        aliasLease = null;
      }
      if (sharedLease) {
        assertSharedDirectory();
        await Promise.resolve(releaseLease({ queueDir: config.sharedQueueDir, outPath: sharedLease.outPath, token, leaseKey: sharedLease.key }));
        sharedLease = null;
      }
      return result;
    } catch (error) {
      return { error: serializeError(error), retainedLease: true };
    }
  };

  const finalize = (code, signal, childError = null) => {
    if (finalizing) return finalizing;
    finalizing = (async () => {
      // The artifact settles all format-specific writers and private workspace
      // cleanup before this owner may remove output, release a lease or succeed.
      const artifactResult = await artifact.settle({ encoded: !cleanupReason && !childError && code === 0 });
      childError ||= artifactResult.error;
      cleanupReason ||= artifactResult.reason;
      const stageCleanupError = artifactResult.cleanupError ? serializeError(artifactResult.cleanupError) : null;
      let outputCommitted = false;
      if (!cleanupReason && !childError && code === 0 && !finalizerAbort.signal.aborted) {
        let stageBefore = null;
        try {
          assertOutput();
          stageBefore = stageMetadata(stagePath, stageIdentity);
          if (BigInt(stageBefore[3]) <= 0n) {
            throw errorWithCode('INVALID_DELIVERY_STAGE', '匯出暫存成品缺少有效檔案內容');
          }
          finalizerAbort.signal.throwIfAborted();
          assertDestinationIdentity(config.outPath, destinationBefore);
          await assertDeliveryDestinationEvidenceAsync(outputAuthority, { signal: finalizerAbort.signal });
          finalizerAbort.signal.throwIfAborted();
          assertOutput();
          assertDestinationIdentity(config.outPath, destinationBefore);
          assertDistinctSourceEntries(config.sourcePaths || [], config.outPath);
          assertDeliveryInputEvidence(config.inputEvidence || []);
          assertStageMetadata(stagePath, stageIdentity, stageBefore);
          // Both paths are in the same output directory. After FFmpeg and any
          // format-specific checks succeed, this rename is the commit point.
          fs.renameSync(stagePath, config.outPath);
          outputCommitted = true;
        } catch (error) {
          // Cancellation during destination hashing must not delete a stage
          // whose ownership became uncertain while the operation was paused.
          if (stageBefore) {
            try { assertStageMetadata(stagePath, stageIdentity, stageBefore); }
            catch (stageError) { error = stageError; }
          }
          if (error?.code === 'DELIVERY_STAGE_CHANGED') { childError = error; cleanupReason = 'artifact-commit-failed'; }
          else if (finalizerAbort.signal.aborted) cleanupReason ||= 'stop';
          else { childError = error; cleanupReason = 'artifact-commit-failed'; }
        }
      }
      const needsCleanup = !outputCommitted;
      let cleanup = null;
      let release = null;

      if (needsCleanup) {
        // If startup was cancelled or failed before any writer was admitted,
        // never remove a reservation that was filled while we were waiting.
        if (stageReservationMetadata) {
          try { assertReservedStage(); }
          catch (stageError) { childError = stageError; cleanupReason = 'artifact-commit-failed'; }
        }
        // A failed mux handle close can leave a writer alive. Preserve the
        // stage as well as the lease until recovery can safely inspect it.
        const destinationUncertain = !!stageIdentity && (childError?.code === 'DELIVERY_STAGE_CHANGED'
          || (cleanupReason === 'artifact-commit-failed'
            && ['DELIVERY_DESTINATION_CHANGED', 'DELIVERY_DESTINATION_UNVERIFIABLE', 'OUTPUT_OVERWRITES_SOURCE', 'DELIVERY_TEMP_INPUT_CHANGED', 'SHARED_OUTPUT_LOCK_UNAVAILABLE'].includes(childError?.code)));
        let retentionRecordError = null;
        if (destinationUncertain) {
          if (childError.code === 'OUTPUT_OVERWRITES_SOURCE') {
            childError.message = `母素材目前指向輸出路徑，為避免覆蓋母素材，暫存成品 ${stagePath} 及輸出鎖已保留`;
          } else if (childError.code === 'DELIVERY_TEMP_INPUT_CHANGED') {
            childError.message = `交付字幕或字型暫存資料已變更，暫存成品 ${stagePath} 及輸出鎖已保留`;
          }
          try {
            // Persist only inside this token-owned lease and bind the receipt to
            // the exact stage; an arbitrary sidecar file grants no retention.
            updateLease({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey, outputStarted:true, stageIdentity,
              retainedResult: { version: 1, code: childError.code, stageIdentity } });
          } catch (error) {
            retentionRecordError = serializeError(error);
            childError.message += `；無法保存保留紀錄，重新啟動前請先備份暫存成品：${stagePath}`;
          }
        }
        const deletion = destinationUncertain || ['AIRLINE_TEMP_HANDLE_CLOSE_FAILED', 'OUTPUT_HANDLE_CLOSE_FAILED'].includes(stageCleanupError?.code)
          ? { removed: false, missing: false, untouched: true }
          : leasesAcquired
          ? stageIdentity
            ? { outPath: config.outPath, stagePath, ...await deletePartialFile(stagePath, { ...options, assertOutput, assertDirectory }) }
            : { removed: false, missing: false, untouched: true }
          : { removed: false, missing: false, untouched: true };
        if (deletion.error?.code === 'PARTIAL_DELETE_UNCERTAIN') {
          try {
            updateLease({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey, outputStarted:true, stageIdentity,
              retainedResult:{ version:1, code:'PARTIAL_DELETE_UNCERTAIN', stageIdentity } });
          } catch (error) { retentionRecordError = serializeError(error); }
        }
        const failed = (!deletion.removed && !deletion.missing && !deletion.untouched ? deletion : null) || stageCleanupError
          || (destinationUncertain ? serializeError(childError) : null);
        cleanup = {
          reason: cleanupReason || (childError ? 'ffmpeg-error' : 'ffmpeg-nonzero'),
          ...deletion,
          released: false,
          retainedLease: false,
          ...(stageCleanupError ? { stageCleanupError } : {}),
          ...(retentionRecordError ? { retentionRecordError } : {}),
        };

        if (!failed) {
          release = await releaseOutputs();
          if (release?.error) {
            cleanup.retainedLease = true;
            cleanup.releaseError = release.error;
          } else cleanup.released = true;
        } else {
          cleanup.retainedLease = true;
        }
        sendIpc({ type: 'cleanup', jobId: config.jobId, ...cleanup });
        if (failed && !destinationUncertain) {
          sendIpc({
            type: 'error',
            jobId: config.jobId,
            code: 'PARTIAL_CLEANUP_FAILED',
            message: (stageCleanupError?.message || deletion.error?.message || '匯出半成品刪除失敗，輸出鎖已保留')
              + (childError ? `；原始錯誤：${childError.message || childError}` : '')
              + (retentionRecordError ? `；無法保存保留紀錄（${retentionRecordError.message}），重新啟動前請先備份暫存成品：${stagePath}` : ''),
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
        release = await releaseOutputs();
        if (release?.error) {
          sendIpc({
            type: 'error',
            jobId: config.jobId,
            code: 'LEASE_RELEASE_FAILED',
            message: release.error.message,
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
    finalizerAbort.abort();
    if (finalResult) return finalResult.cleanup || {
      reason,
      removed: false,
      missing: false,
      released: true,
      alreadyFinished: true,
    };

    if (child && !childClosed) {
      if (!terminationRequested) {
        // A failed kill can emit another error synchronously or asynchronously.
        // Keep the writer's lease until close without recursively killing it.
        terminationRequested = true;
        terminateProcessTree(child);
      }
    } else if (leasesAcquired && !starting) {
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
  const abortStartup = () => { void requestCleanup(options.signal.reason || 'stop'); };
  options.signal?.addEventListener('abort', abortStartup, { once: true });
  if (options.signal?.aborted) abortStartup();
  const close = async () => {
    options.signal?.removeEventListener('abort', abortStartup);
    await control.close();
  };

  try {
    await control.listenPromise;
    assertDirectory();
    let reservationEntry;
    try { reservationEntry = outputReservationEntry(config.outPath); }
    catch (error) { throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '無法確認輸出檔案的實際目錄項', error); }
    assertSharedDirectory();
    const primaryOutPath = normalizeOutputPath(config.outPath);
    const sharedOutPath = reservationEntry || primaryOutPath;
    const sharedKey = outputKey(sharedOutPath);
    fs.mkdirSync(config.queueDir, { recursive: true });
    const queueRoot = captureOutputDirectory(config.queueDir);
    fs.mkdirSync(leaseRoot(config.queueDir), { recursive: true });
    const queueAuthority = captureOutputAuthority(path.join(leaseRoot(config.queueDir), '.subtool-queue-proof'), queueRoot);
    assertOutputAuthority(queueAuthority, queueAuthority.requestedPath);
    const acquireShared = () => acquireLease({ queueDir: config.sharedQueueDir, outPath: sharedOutPath,
      jobId: config.jobId, token, watchdogPid: process.pid, pipeName, outputStarted: false,
      aliasOf: { version: 1, queueDir: path.resolve(config.queueDir), outPath: primaryOutPath,
        key: outputKey(primaryOutPath), stagePath, outputAuthority, queueAuthority } });
    try { sharedLease = acquireShared(); }
    catch (error) {
      if (error.code !== 'OUTPUT_BUSY') throw error;
      // A disk record never grants authority to recover or stop another profile.
      const previous = listLeases(config.sharedQueueDir).find(entry => entry.key === sharedKey);
      const owner = previous?.valid && previous.owner;
      if (!owner?.aliasOf?.queueDir || !Number.isInteger(owner.watchdogPid) || owner.watchdogPid <= 0
        || processMayBeRunning(owner.watchdogPid) || processMayBeRunning(owner.ffmpegPid)) throw error;
      assertSharedDirectory();
      const recovery = await recoverExportLeases(config.sharedQueueDir, { onlyLeaseKey: sharedKey, pipeAttempts: 1, assertLeaseDirectory: assertSharedDirectory });
      if (recovery.warnings.length) throw errorWithCode('OUTPUT_BUSY', `此輸出仍被保留：${recovery.warnings[0].message}`);
      assertSharedDirectory();
      sharedLease = acquireShared();
    }
    sharedLease.outPath = sharedOutPath;
    // Keep the old primary key and stage path stable. A second reservation on
    // the canonical existing entry makes new long/8.3 aliases mutually exclusive.
    if (reservationEntry && outputKey(reservationEntry) !== outputKey(config.outPath)) {
      const primaryOutPath = normalizeOutputPath(config.outPath);
      aliasLease = acquireLease({ queueDir: config.queueDir, outPath: reservationEntry,
        jobId: config.jobId, token, watchdogPid: process.pid, pipeName, outputStarted: false,
        aliasOf: { version: 1, outPath: primaryOutPath, key: outputKey(primaryOutPath) } });
      aliasLease.outPath = reservationEntry;
    }
    const lease = await Promise.resolve(acquireLease({
      queueDir: config.queueDir, outPath: config.outPath, jobId: config.jobId,
      token, watchdogPid: process.pid, pipeName,
      outputStarted: false, stagePath, outputAuthority,
    }));
    leasesAcquired = true;
    leaseKey = lease.key;
    artifactTempDir = lease.lockPath;
    assertDirectory();
    let currentEntry;
    try { currentEntry = outputReservationEntry(config.outPath); }
    catch (error) { throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '無法確認輸出檔案的實際目錄項', error); }
    if (currentEntry !== reservationEntry) throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '輸出目錄項在取得輸出鎖期間變更');
    // Older watchdogs did not acquire the canonical alias reservation. Detect
    // their existing locks without granting authority to their current paths.
    for (const other of listLeases(config.queueDir)) {
      if (!other.valid) throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '無法確認既有輸出鎖，請先檢查佇列');
      if (other.owner.token === token || !reservationEntry) continue;
      let otherEntry;
      try { otherEntry = outputReservationEntry(other.owner.outPath); }
      catch (error) { throw errorWithCode('DELIVERY_DESTINATION_UNVERIFIABLE', '無法確認既有輸出鎖的目錄項', error); }
      if (otherEntry === reservationEntry) throw errorWithCode('OUTPUT_BUSY', '同一個輸出檔案已被其他交付使用');
    }
    if (isDiscOutput(config.outputFormat)) {
      updateLease({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey, discWorkspacePending: true });
    }
    if (process.platform === 'win32' && isDiscOutput(config.outputFormat)) {
      nativeWorkspace = prepareNativeWorkspace({ queueDir: config.queueDir, outPath: config.outPath, token, leaseKey });
    }
  } catch (error) {
    // No FFmpeg has started: only release reservations, never delete an
    // existing deliverable when a sibling is owned by another job.
    const release = await releaseOutputs();
    // A recovery request can already be waiting on done. Let that socket
    // finish before closing the control server after a failed reservation.
    const result = { type: 'exit', jobId: config.jobId, ok: false, code: null, signal: null, release, cleanup: {
      reason: cleanupReason || 'lease-acquire-failed',
      removed: false, missing: false, untouched: true,
      released: !release?.error, retainedLease: !!release?.error,
      ...(release?.error ? { releaseError: release.error } : {}),
    } };
    resolveDone(result);
    await close();
    // The standalone IPC owner needs both the original startup cause and the
    // reservation outcome; throwing only the original loses a retained lease.
    const startupError = error instanceof Error ? error : new Error(String(error));
    startupError.watchdogResult = result;
    throw startupError;
  }

  if (cleanupReason) {
    starting = false;
    void finalize(null, null);
    return { done, requestCleanup, close, pipeName, token };
  }

  try {
    assertDirectory();
    await assertDeliveryDestinationEvidenceAsync(outputAuthority, { signal: finalizerAbort.signal });
    finalizerAbort.signal.throwIfAborted();
    assertDistinctSourceEntries(config.sourcePaths || [], config.outPath);
    assertDeliveryInputEvidence(config.inputEvidence || []);
    destinationBefore = destinationIdentity(config.outPath);
    const args = await artifact.prepare({ tempDir: artifactTempDir, nativeWorkRoot: nativeWorkspace?.path });
    assertOutput();
    assertDestinationIdentity(config.outPath, destinationBefore);
    await assertDeliveryDestinationEvidenceAsync(outputAuthority, { signal: finalizerAbort.signal });
    finalizerAbort.signal.throwIfAborted();
    assertOutput();
    assertDestinationIdentity(config.outPath, destinationBefore);
    assertDistinctSourceEntries(config.sourcePaths || [], config.outPath);
    assertDeliveryInputEvidence(config.inputEvidence || []);
    starting = false;
    if (cleanupReason) {
      void finalize(null, null);
      return { done, requestCleanup, close, pipeName, token };
    }
    recordWriter(true);
    assertReservedStage();
    child = spawn(config.ffmpegPath, args, {
      cwd: config.cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (Number.isInteger(child.pid) && child.pid > 0) stageReservationMetadata = null;
  } catch (error) {
    starting = false;
    cleanupReason ||= 'ffmpeg-spawn-failed';
    const startupError = finalizerAbort.signal.aborted && error === finalizerAbort.signal.reason ? null : error;
    void finalize(null, null, startupError);
    return { done, requestCleanup, close, pipeName, token };
  }

  child.stderr.on('data', chunk => {
    try {
      process.stderr.write(chunk);
    } catch {}
  });
  child.stderr.on('error', () => {});

  child.on('error', error => {
    nativeChildError ||= error;
    // ChildProcess error also means kill/send failure. A spawned writer still
    // owns its staging file and lease until close, even after its exit event.
    if (Number.isInteger(child.pid) && child.pid > 0) {
      void requestCleanup(cleanupReason || 'ffmpeg-error');
      return;
    }
    cleanupReason ||= 'ffmpeg-spawn-failed';
    void finalize(null, null, nativeChildError);
  });
  child.once('close', (code, signal) => {
    childClosed = true;
    if (code !== 0 && !cleanupReason) cleanupReason = 'ffmpeg-nonzero';
    void finalize(code, signal, nativeChildError);
  });

  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch {
    return { done, requestCleanup, close, pipeName, token };
  }

  if (cleanupReason) {
    void requestCleanup(cleanupReason);
    return { done, requestCleanup, close, pipeName, token };
  }

  try {
    recordWriter(false, child.pid);
  } catch (error) {
    cleanupReason = 'lease-update-failed';
    sendIpc({
      type: 'error',
      jobId: config.jobId,
      code: error.code || 'LEASE_UPDATE_FAILED',
      message: error.message,
    });
    void requestCleanup(cleanupReason);
    return { done, requestCleanup, close, pipeName, token };
  }

  sendIpc({
    type: 'ready',
    jobId: config.jobId,
    watchdogPid: process.pid,
    ffmpegPid: child.pid,
  });

  return { done, requestCleanup, close, pipeName, token };
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

function isClosedPipeError(error) {
  // The owner can close between connect and reply. Retry only this transport
  // race; stale cleanup still requires both recorded processes to be gone.
  return ['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET', 'CONTROL_PIPE_CLOSED']
    .includes(error?.code);
}

function processMayBeRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function recoverExportLeases(queueDir, options = {}) {
  const recovered = [];
  const warnings = [];
  let entries;

  try {
    entries = await Promise.resolve(listLeases(queueDir));
    if (options.onlyLeaseKey) entries = entries.filter(entry => entry.key === options.onlyLeaseKey);
    // A stale alias reservation follows its primary lease; handle the primary
    // first so retained completed work keeps both names protected.
    entries.sort((left, right) => Number(!!left?.owner?.aliasOf) - Number(!!right?.owner?.aliasOf));
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

    try { fs.lstatSync(entry.lockPath); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      warnings.push({ code: error.code || 'LEASE_SCAN_FAILED', key: entry.key, message: error.message });
      continue;
    }

    const owner = entry.owner;
    if (owner.retainedResult) {
      try {
        assertOutputAuthority(owner.outputAuthority, owner.outPath);
        assertStageIdentity(owner.stagePath, owner.stageIdentity);
        const reason = owner.retainedResult.code === 'OUTPUT_OVERWRITES_SOURCE'
          ? '偵測到母素材指向輸出路徑，為避免覆蓋母素材'
          : owner.retainedResult.code === 'PARTIAL_DELETE_UNCERTAIN'
            ? '上次無法安全確認或清理暫存檔'
          : owner.retainedResult.code === 'DELIVERY_STAGE_CHANGED'
            ? '偵測到暫存成品曾變更或無法確認'
          : owner.retainedResult.code === 'DELIVERY_TEMP_INPUT_CHANGED'
            ? '偵測到交付字幕或字型暫存資料曾變更'
            : '輸出檔曾變更或無法確認';
        const stageLabel = owner.retainedResult.code === 'PARTIAL_DELETE_UNCERTAIN' ? '暫存檔' : '已完成的暫存成品';
        warnings.push({ code: owner.retainedResult.code, key: entry.key, outPath: owner.outPath,
          message: `${reason}；${stageLabel} ${path.basename(owner.stagePath)} 及輸出鎖持續保留，請檢查後改用新檔名` });
        continue;
      } catch (error) {
        // A missing stage no longer needs preservation; ordinary recovery may
        // release the lease. Any other uncertainty remains fail-closed.
        if (error.code !== 'ENOENT') {
          warnings.push({ code: error.code || 'RETAINED_OUTPUT_UNVERIFIABLE', key: entry.key, outPath: owner.outPath,
            message: '無法確認保留成品的目錄或身分；暫存檔與輸出鎖已保留' });
          continue;
        }
        try { assertOutputAuthority(owner.outputAuthority, owner.outPath); }
        catch (directoryError) {
          warnings.push({ code: directoryError.code || 'RETAINED_OUTPUT_UNVERIFIABLE', key: entry.key, outPath: owner.outPath,
            message: '無法確認保留成品的目錄；暫存檔與輸出鎖已保留' });
          continue;
        }
      }
    }
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
          if (!isClosedPipeError(error)) {
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

    if (processMayBeRunning(owner.watchdogPid) || processMayBeRunning(owner.ffmpegPid)) {
      warnings.push({ code: 'EXPORT_PROCESS_RUNNING', key: entry.key, outPath: owner.outPath,
        message: '匯出程序仍可能執行中，暫存檔與輸出鎖已保留' });
      continue;
    }
    if (owner.writerSpawnPending) {
      warnings.push({ code: 'WRITER_START_UNCERTAIN', key: entry.key, outPath: owner.outPath,
        message: '匯出程序啟動時中斷，無法確認背景寫入程序是否仍在執行；暫存檔及輸出鎖已保留，請先確認程序已停止並檢查成品' });
      continue;
    }
    if (owner.aliasOf) {
      let primary;
      try {
        const primaryDir = owner.aliasOf.queueDir || queueDir;
        if (owner.aliasOf.queueDir) {
          const expected = path.join(leaseRoot(primaryDir), '.subtool-queue-proof');
          assertOutputAuthority(owner.aliasOf.queueAuthority, expected);
          if (outputKey(expected) !== outputKey(owner.aliasOf.queueAuthority.outPath)) throw new Error('佇列目錄身分不相符');
        }
        primary = listLeases(primaryDir).find(candidate => candidate.key === owner.aliasOf.key);
        if (owner.aliasOf.queueDir) assertOutputAuthority(owner.aliasOf.queueAuthority, owner.aliasOf.queueAuthority.requestedPath);
      }
      catch (error) {
        warnings.push({ code: error.code || 'LEASE_SCAN_FAILED', key: entry.key, outPath: owner.outPath,
          message: '無法確認別名鎖對應的原始輸出鎖，已保留' });
        continue;
      }
      if (primary) {
        warnings.push({ code: 'ALIAS_PRIMARY_RETAINED', key: entry.key, outPath: owner.outPath,
          message: '原始輸出鎖尚未釋放，別名鎖一併保留' });
        continue;
      }
      if (owner.aliasOf.queueDir) {
        try {
          assertOutputAuthority(owner.aliasOf.outputAuthority, owner.aliasOf.outPath);
          try {
            fs.lstatSync(owner.aliasOf.stagePath);
            warnings.push({ code: 'ALIAS_STAGE_RETAINED', key: entry.key, outPath: owner.outPath,
              message: `原輸出鎖已不存在，但暫存成品 ${path.basename(owner.aliasOf.stagePath)} 仍在；別名鎖已保留` });
            continue;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          assertOutputAuthority(owner.aliasOf.outputAuthority, owner.aliasOf.outPath);
          assertOutputAuthority(owner.aliasOf.queueAuthority, owner.aliasOf.queueAuthority.requestedPath);
        } catch (error) {
          warnings.push({ code: error.code || 'DELIVERY_DESTINATION_UNVERIFIABLE', key: entry.key, outPath: owner.outPath,
            message: '無法確認原始輸出目錄或暫存成品，別名鎖已保留' });
          continue;
        }
      }
    }
    // Without historical identities, recovery cannot grant the current same-name
    // directory or file. A proven reservation that never wrote owns no file.
    let unusedReservation = owner.outputStarted === false && !owner.stagePath;
    if (owner.outputStarted === false && owner.stagePath && owner.outputAuthority && !owner.stageIdentity) {
      try {
        assertOutputAuthority(owner.outputAuthority, owner.outPath);
        try { fs.lstatSync(owner.stagePath); } catch (error) {
          if (error.code === 'ENOENT') {
            assertOutputAuthority(owner.outputAuthority, owner.outPath);
            unusedReservation = true;
          }
        }
      } catch {}
    }
    // A parent-directory authorization does not identify the output file.
    // Older or damaged owners without a staged file cannot prove that the
    // current destination is theirs, even if outputStarted is true.
    if (!unusedReservation && (!owner.outputAuthority || !owner.stagePath || !owner.stageIdentity)) {
      warnings.push({ code: 'OUTPUT_AUTHORITY_MISSING', key: entry.key, outPath: owner.outPath,
        message: '舊交付鎖缺少原目錄或暫存成品身分；已保留既有輸出、暫存檔與鎖，請檢查後改用新的交付檔名' });
      continue;
    }
    const guardedOptions = owner.outputAuthority
      ? { ...options, assertDirectory: () => assertOutputAuthority(owner.outputAuthority, owner.outPath), assertOutput: () => {
        assertOutputAuthority(owner.outputAuthority, owner.outPath);
        if (owner.stageIdentity) assertStageIdentity(owner.stagePath, owner.stageIdentity);
      } } : options;
    const deletion = unusedReservation ? { removed: false, missing: false, untouched: true }
      : await deletePartialFile(owner.stagePath, guardedOptions);
    if (!deletion.removed && !deletion.missing && !deletion.untouched) {
      let retentionRecordError = null;
      if (deletion.error?.code === 'PARTIAL_DELETE_UNCERTAIN') {
        try {
          updateLease({ queueDir, outPath:owner.outPath, token:owner.token, leaseKey:entry.key,
            outputStarted:true, stageIdentity:owner.stageIdentity,
            retainedResult:{ version:1, code:'PARTIAL_DELETE_UNCERTAIN', stageIdentity:owner.stageIdentity } });
        } catch (error) { retentionRecordError = serializeError(error); }
      }
      warnings.push({
        code: 'PARTIAL_CLEANUP_FAILED',
        key: entry.key,
        outPath: owner.outPath,
        message: (deletion.error?.message || '無法刪除匯出半成品，鎖已保留')
          + (retentionRecordError ? `；無法保存保留紀錄（${retentionRecordError.message}），重新啟動前請先備份暫存成品：${owner.stagePath}` : ''),
      });
      continue;
    }

    try {
      options.assertLeaseDirectory?.();
      await Promise.resolve(releaseLease({
        queueDir,
        outPath: owner.outPath,
        token: owner.token,
        leaseKey: entry.key,
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
    // Windows must let this owner survive a hard-killed parent, then handle
    // IPC disconnect and finish native close, stage cleanup and lease release.
    detached: process.platform === 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(options.env || {}),
    },
  });

  let readySettled = false;
  let completionSettled = false;
  let startupFailure = null;
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
    const error = startupFailure ||= errorWithCode(
      message?.code || 'WATCHDOG_START_FAILED',
      message?.message || '匯出 watchdog 啟動失敗',
    );
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    // Readiness may fail after FFmpeg has spawned. Its standalone owner still
    // holds native close, staging and leases; callers must retain ASS/TC inputs
    // and active-job ownership until the exit result or watchdog termination.
    if (!completionSettled && (!Number.isInteger(child.pid) || child.pid <= 0)) {
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
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(startupFailure || errorWithCode(
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

async function runStandalone(options = {}) {
  let runtime = null;
  let started = false;
  let pendingCleanupReason = null;
  const startupAbort = new AbortController();

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
          runtime = await startWatchdogRuntime(message, { signal: startupAbort.signal, artifactAdapters: options.artifactAdapters });
          if (pendingCleanupReason) {
            void runtime.requestCleanup(pendingCleanupReason);
          }
          await runtime.done;
        } catch (error) {
          sendIpc({ type: 'error', ...serializeError(error), jobId: message?.jobId });
          if (error?.watchdogResult) sendIpc(error.watchdogResult);
        } finally {
          await closeAndDisconnect();
        }
      })();
      return;
    }

    if (message?.type === 'stop') {
      pendingCleanupReason ||= message.reason || 'stop';
      startupAbort.abort(pendingCleanupReason);
      if (runtime) void runtime.requestCleanup(pendingCleanupReason);
    }
  });

  process.on('disconnect', () => {
    pendingCleanupReason ||= 'parent-disconnect';
    startupAbort.abort(pendingCleanupReason);
    if (runtime) void runtime.requestCleanup(pendingCleanupReason);
  });
}

if (require.main === module) {
  void runStandalone();
}

module.exports = {
  spawnExportWatchdog,
  recoverExportLeases,
  runStandalone,
};

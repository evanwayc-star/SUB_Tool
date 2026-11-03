'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { motherSourceFingerprint, motherSourceFingerprintSync, portableSourceFingerprint,
  sharedSourceFingerprintSync } = require('./mother-source-evidence');
const { sourceChannelCount, flattenSourceChannels, channelFileName } = require('../shared/channel-layout.cjs');
const { buildIngestArgs, previewPipelineCandidates, previewFallbackAllowed } = require('./ffmpeg-execution-engine');
const { sourceAudioClockFilter, sourceClockSeek, timestampOffset } = require('./media-source-clock');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');
const { createTemporaryOutputOwnership } = require('./temporary-output-ownership');
const { readSourceWaveformChunk, saveSourceWaveformChunk, inspectSourceWaveformCache,
  isSourceWaveformCachePath, validSourceWaveformPcm, MAX_SOURCE_WAVEFORM_BYTES } = require('./source-waveform-cache');
const SOURCE_CACHE_VERSION = 'source-v3';
const PORTABLE_SOURCE_FORMAT = SOURCE_CACHE_VERSION + '-sha256';

function cacheKeyFor(src) {
  // v3 隔離未對齊影片來源 PTS 的舊音訊／Proxy；母素材取樣規則保持單一 owner。
  return motherSourceFingerprintSync(src, { namespace: SOURCE_CACHE_VERSION, digestLength: 16 });
}

async function cacheKeyForAsync(src) {
  return motherSourceFingerprint(src, { namespace: SOURCE_CACHE_VERSION, digestLength: 16 });
}

function ownsMediaIntake(owner, scope) {
  return !!owner && owner.sender === scope.sender
    && (scope.sessionId === undefined || owner.sessionId === scope.sessionId)
    && (scope.requestId === undefined || owner.requestId === scope.requestId);
}

/**
 * ffprobe audio[] → 單次 ffmpeg ingest 的跨平台音訊規劃。
 */
function buildAudioIngestPlan(audio, { waveOnly = false } = {}) {
  const filters = [];
  const channels = [];
  const channelMaps = [];
  const waveContribs = [];
  const audioArr = Array.isArray(audio) ? audio : [];
  // Match Wave.calcPeaks(): every original channel has equal weight, including
  // channels from streams with different widths. Keep enough precision for
  // large layouts rather than rounding a valid contribution down to zero.
  const totalChannels = audioArr.reduce((sum, stream) => sum + sourceChannelCount(stream), 0);
  const contribution = totalChannels ? (1 / totalChannels).toFixed(12) : '1';
  let channelIndex = 0;

  audioArr.forEach((stream, streamIndex) => {
    const count = sourceChannelCount(stream);
    const base = (stream && (stream.title || stream.lang)) || `音軌 ${streamIndex + 1}`;
    // 所有聲道／波形在 split、pan 或 mix 前共用來源秒數：正 PTS 補靜音，
    // 負 PTS 去除來源起點以前的 samples，decoder 已裁掉的 primer 不重裁。
    filters.push(`[0:a:${streamIndex}]${sourceAudioClockFilter(stream)}[at${streamIndex}]`);

    if (count === 1) {
      if (waveOnly) {
        if (totalChannels === 1) waveContribs.push(`[at${streamIndex}]`);
        else {
          filters.push(`[at${streamIndex}]volume=${contribution}[wm${streamIndex}]`);
          waveContribs.push(`[wm${streamIndex}]`);
        }
        return;
      }
      filters.push(`[at${streamIndex}]asplit=2[co${channelIndex}][wv${streamIndex}]`);
      channels.push({
        label: base,
        file: channelFileName(channelIndex),
        sourceStream: streamIndex,
        sourceChannel: 0,
      });
      channelMaps.push(`[co${channelIndex}]`);
      if (totalChannels === 1) waveContribs.push(`[wv${streamIndex}]`);
      else {
        filters.push(`[wv${streamIndex}]volume=${contribution}[wm${streamIndex}]`);
        waveContribs.push(`[wm${streamIndex}]`);
      }
      channelIndex++;
      return;
    }

    if (!waveOnly) {
      const splitPads = Array.from({ length: count }, (_, sourceChannel) => `sp${streamIndex}_${sourceChannel}`);
      filters.push(
        `[at${streamIndex}]asplit=${count + 1}${splitPads.map(pad => `[${pad}]`).join('')}[wv${streamIndex}]`,
      );
      for (let sourceChannel = 0; sourceChannel < count; sourceChannel++) {
        filters.push(`[${splitPads[sourceChannel]}]pan=mono|c0=c${sourceChannel}[co${channelIndex}]`);
        channels.push({
          label: `${base} · 聲道${sourceChannel + 1}`,
          file: channelFileName(channelIndex),
          sourceStream: streamIndex,
          sourceChannel,
        });
        channelMaps.push(`[co${channelIndex}]`);
        channelIndex++;
      }
    }
    const sum = Array.from({ length: count }, (_, sourceChannel) => `${contribution}*c${sourceChannel}`).join('+');
    filters.push(`[${waveOnly ? 'at' : 'wv'}${streamIndex}]pan=mono|c0=${sum}[wm${streamIndex}]`);
    waveContribs.push(`[wm${streamIndex}]`);
  });

  let waveLabel = null;
  if (waveContribs.length === 1) {
    waveLabel = waveContribs[0];
  } else if (waveContribs.length > 1) {
    filters.push(`${waveContribs.join('')}amix=inputs=${waveContribs.length}:normalize=0[wavemix]`);
    waveLabel = '[wavemix]';
  }

  return { filters, channels, channelMaps, waveLabel };
}

function createMediaIntakeRuntime(options = {}) {
  const fileAuthority = options.fileAuthority;
  const ffmpegExecution = options.ffmpegExecution;
  const tempRoot = options.tempRoot;
  const allowSidecarCache = options.allowSidecarCache !== false;
  const getEncoder = options.getEncoder || (() => 'libx264');
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const createStreamId = options.createStreamId
    || (prefix => prefix + crypto.randomBytes(12).toString('hex'));
  let streamServer = null;
  let streamServerReady = null;
  let streamPort = null;
  let closed = false;
  let runtimeGeneration = 0;
  const drainingServers = new Set();
  const streamJobs = new Map();
  const activeCacheDirs = new Map();
  const activeCacheSources = new Map();
  const portableHits = new Map();
  const portableHashes = new Set();
  const cleanupTasks = new Map();
  const sidecarCleanups = new Set();
  const cleanupHandles = new Set();
  let drainingCleanup = false;
  let closeOperation = null;
  const inspectedCacheOwners = new WeakMap();
  // All produced temp paths cross IPC as strings. Share owner/tombstone state
  // across same-process runtime reconstruction for this exact temp root.
  const temporaryOwnership = tempRoot ? createTemporaryOutputOwnership({ tempRoot, rootAuthority: options.tempRootAuthority }) : null;
  let sourceWaveRoot = temporaryOwnership?.rootAuthority || options.tempRootAuthority || null;
  const cleanupRoots = new Map();
  const sidecarRoots = new Map();
  const sourceWaveKey = file => {
    const absolute = path.resolve(file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const cacheRoot = () => {
    const value = typeof options.cacheRoot === 'function' ? options.cacheRoot() : options.cacheRoot;
    return value || tempRoot;
  };

  // 清理能力要綁定可信入口取得的根目錄身分，不能在刪除時把同名新根
  // 當作原本的授權；選到巢狀授權時也不能退回較寬的祖先根。
  function assertCleanupAncestors(target) {
    for (const root of cleanupRoots.values()) {
      if (withinCachePath(root.requestedPath, target)) captureOutputAuthority(target, root);
    }
  }

  function registerCleanupRoot(directory) {
    try {
      if (!directory || !fileAuthority.canManageInternalFile(directory)) return false;
      assertCleanupAncestors(path.join(directory, '.cleanup-root-check'));
      const key = sourceWaveKey(directory), previous = cleanupRoots.get(key);
      const authority = previous || (tempRoot && key === sourceWaveKey(tempRoot) && sourceWaveRoot)
        || captureOutputDirectory(directory);
      captureOutputAuthority(path.join(directory, '.cleanup-root-check'), authority);
      if (!previous) cleanupRoots.set(key, authority);
      if (tempRoot && key === sourceWaveKey(tempRoot) && !sourceWaveRoot) {
        sourceWaveRoot = authority;
        temporaryOwnership?.setRootAuthority(authority);
      }
      return true;
    } catch (_) { return false; }
  }

  function grantManagedCleanupRoot(directory, verify = () => {}) {
    verify();
    assertCleanupAncestors(path.join(directory, '.cleanup-root-check'));
    const key = sourceWaveKey(directory), previous = cleanupRoots.get(key);
    const authority = previous || captureOutputDirectory(directory);
    captureOutputAuthority(path.join(directory, '.cleanup-root-check'), authority);
    fileAuthority.grantManagedCacheDirectory(directory);
    verify();
    assertCleanupAncestors(path.join(directory, '.cleanup-root-check'));
    captureOutputAuthority(path.join(directory, '.cleanup-root-check'), authority);
    if (!previous) cleanupRoots.set(key, authority);
  }

  function cleanupAuthority(target) {
    const candidates = [...cleanupRoots.values()]
      .filter(root => withinCachePath(root.requestedPath, target))
      .sort((a, b) => b.requestedPath.length - a.requestedPath.length);
    if (!candidates.length) return null;
    try { assertCleanupAncestors(target); return captureOutputAuthority(target, candidates[0]); }
    catch (_) { return null; }
  }

  function canUseCacheCandidate(directory) {
    try {
      let existing = directory;
      for (;;) {
        try { fs.lstatSync(existing); break; }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          existing = parent;
        }
      }
      assertCleanupAncestors(path.join(existing, '.cleanup-root-check'));
      return true;
    } catch (_) { return false; }
  }

  function forgetRemovedCleanupRoots(directory) {
    for (const [key, authority] of cleanupRoots) {
      if (withinCachePath(directory, authority.requestedPath)) cleanupRoots.delete(key);
    }
  }

  function protectSource(src) {
    if (src) activeCacheSources.set(src, (activeCacheSources.get(src) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (src) {
        const sourceCount = activeCacheSources.get(src) || 0;
        if (sourceCount <= 1) activeCacheSources.delete(src);
        else activeCacheSources.set(src, sourceCount - 1);
      }
    };
  }

  function protectCacheDir(dir, src) {
    activeCacheDirs.set(dir, (activeCacheDirs.get(dir) || 0) + 1);
    const releaseSource = protectSource(src);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = activeCacheDirs.get(dir) || 0;
      if (count <= 1) activeCacheDirs.delete(dir);
      else activeCacheDirs.set(dir, count - 1);
      releaseSource();
    };
  }

  function withSourceLease(work, sourceOf = request => request?.src, guardSession = false) {
    return async (...args) => {
      const release = protectSource(sourceOf(args[0]));
      if (guardSession) {
        const original = args[1] || {}, generation = runtimeGeneration;
        args[1] = { ...original, isCancelled: () => generation !== runtimeGeneration || !!original.isCancelled?.() };
      }
      try { return await work(...args); }
      finally { release(); }
    };
  }

  function cacheCandidates(src, key = cacheKeyFor(src), onUncertain = null) {
    const candidates = [];
    if (allowSidecarCache) {
      try {
        const sourceDir = path.dirname(src);
        if (sourceDir && sourceDir !== '.') candidates.push(path.join(sourceDir, '.subtool_Cache', key));
      } catch (error) {}
    }
    candidates.push(path.join(cacheRoot(), key));
    const portable = portableHits.get(key);
    if (portable) {
      // 共享目錄可被同步或搬移工作取代；先前驗證的路徑不能替新內容作證。
      // 讀取、補建與清理都必須使用同一份仍有效的母素材證據。
      const current = inspectCacheDirectory(portable.dir, [], !!onUncertain);
      if (!current.error && sameSourceContent(current.sourceContent, portable.sourceContent)) {
        if (!candidates.includes(portable.dir)) candidates.push(portable.dir);
      } else if (!current.error) portableHits.delete(key);
      else if (onUncertain) onUncertain();
      // 暫時讀不到 metadata 不代表映射永久失效；保留它供稍後重試，本次不准入。
    }
    return candidates;
  }

  const canonicalCachePath = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const withinCachePath = (root, file) => {
    const directory = canonicalCachePath(root), target = canonicalCachePath(file);
    return target === directory || target.startsWith(directory + path.sep);
  };
  function sidecarRoot(src) { return path.join(path.dirname(src), '.subtool_Cache'); }
  function sidecarAuthority(src, { allowMissing = false } = {}) {
    try {
      const directory = sidecarRoot(src), parent = fs.realpathSync.native(path.dirname(src));
      const key = sourceWaveKey(directory), previous = sidecarRoots.get(key);
      let stat;
      try { stat = fs.lstatSync(directory); }
      catch (error) { if (allowMissing && !previous && error.code === 'ENOENT') return { missing: true }; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || canonicalCachePath(fs.realpathSync.native(directory)) !== canonicalCachePath(path.join(parent, '.subtool_Cache'))) return null;
      const authority = previous || captureOutputDirectory(directory);
      captureOutputAuthority(path.join(directory, '.sidecar-root-check'), authority);
      if (!previous) sidecarRoots.set(key, authority);
      return authority;
    } catch (_) { return null; }
  }
  function isSidecarCandidate(src, directory) { return withinCachePath(sidecarRoot(src), directory); }
  if (tempRoot) registerCleanupRoot(tempRoot);
  if (typeof options.cacheRoot === 'string') registerCleanupRoot(options.cacheRoot);
  function cachePathEscape() {
    const error = new Error('快取元件超出實際目錄');
    error.code = 'CACHE_PATH_ESCAPE';
    return error;
  }
  function realCacheDirectory(dir) {
    // 設定的 cache root 可以是掛載路徑；其下的來源 key 不得再導向其他目錄。
    if (fs.lstatSync(dir).isSymbolicLink()) throw cachePathEscape();
    const parent = fs.realpathSync(path.dirname(dir)), actual = fs.realpathSync(dir);
    if (canonicalCachePath(actual) !== canonicalCachePath(path.join(parent, path.basename(dir)))) throw cachePathEscape();
    return actual;
  }
  const sameCacheDirectory = (left, right) => left?.isDirectory() && !left.isSymbolicLink()
    && right?.isDirectory() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino;
  function cacheDirectoryOwner(dir) {
    const owner = fs.lstatSync(dir, { bigint: true });
    if (!owner.isDirectory() || owner.isSymbolicLink()) throw cachePathEscape();
    realCacheDirectory(dir);
    if (!sameCacheDirectory(owner, fs.lstatSync(dir, { bigint: true }))) throw cacheDirectoryChanged();
    return owner;
  }
  function cacheDirectoryChanged() {
    const error = new Error('媒體快取目錄或母素材在補建期間變更');
    error.code = 'CACHE_DIRECTORY_CHANGED';
    return error;
  }
  function checkPublicationDirectory(dir, owner, sourceContent, sourceRequired) {
    const before = cacheDirectoryOwner(dir);
    if (owner && !sameCacheDirectory(owner, before)) throw cacheDirectoryChanged();
    const current = inspectCacheDirectory(dir);
    if (current.error === 'CACHE_PATH_ESCAPE') throw cachePathEscape();
    if ((current.error && !current.metadataMissing)
      || (current.sourceContent && !sameSourceContent(current.sourceContent, sourceContent))
      || (sourceRequired && !sameSourceContent(current.sourceContent, sourceContent))
      || !sameCacheDirectory(before, cacheDirectoryOwner(dir))) throw cacheDirectoryChanged();
    return { owner: before, current };
  }
  function captureStreamGuard(dir, rootOwner, file, reserved = null) {
    if (!file || !withinCachePath(dir, file)) throw cachePathEscape();
    const parent = path.dirname(file), parentOwner = cacheDirectoryOwner(parent);
    const fileOwner = fs.lstatSync(file, { bigint: true });
    if (!fileOwner.isFile() || fileOwner.isSymbolicLink()) throw cachePathEscape();
    if (reserved && (reserved.dev !== fileOwner.dev || reserved.ino !== fileOwner.ino)) throw cacheDirectoryChanged();
    const verify = observed => {
      try {
        if (!sameCacheDirectory(rootOwner, cacheDirectoryOwner(dir))
          || !sameCacheDirectory(parentOwner, cacheDirectoryOwner(parent))) throw cacheDirectoryChanged();
        const current = fs.lstatSync(file, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== fileOwner.dev || current.ino !== fileOwner.ino
          || (observed && (observed.dev !== fileOwner.dev || observed.ino !== fileOwner.ino))) throw cacheDirectoryChanged();
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw cacheDirectoryChanged();
        throw error;
      }
    };
    verify();
    return verify;
  }
  async function openCacheComponent(cacheDirectory, filePath) {
    const resolveCurrent = async () => {
      if (!cacheDirectory || !filePath || !withinCachePath(cacheDirectory, filePath)
        || (await fsp.lstat(cacheDirectory)).isSymbolicLink()) throw cachePathEscape();
      const [parent, directory, file] = await Promise.all([
        fsp.realpath(path.dirname(cacheDirectory)), fsp.realpath(cacheDirectory), fsp.realpath(filePath),
      ]);
      if (canonicalCachePath(directory) !== canonicalCachePath(path.join(parent, path.basename(cacheDirectory)))
        || !withinCachePath(directory, file)) throw cachePathEscape();
      return file;
    };
    const actual = await resolveCurrent(), file = await fsp.open(actual, 'r');
    try {
      const currentPath = await resolveCurrent();
      const [opened, current] = await Promise.all([file.stat({ bigint: true }), fsp.stat(currentPath, { bigint: true })]);
      if (canonicalCachePath(actual) !== canonicalCachePath(currentPath)
        || opened.dev !== current.dev || opened.ino !== current.ino) throw cachePathEscape();
      return file;
    } catch (error) { await file.close(); throw error; }
  }
  function checkCacheComponent(root, file) {
    let candidate = file;
    for (;;) {
      try {
        if (!withinCachePath(root, fs.realpathSync(candidate))) throw cachePathEscape();
        return;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        // 缺件仍交原本 missing/unknown 規則處理，但其最近存在的父目錄不能越界。
        const parent = path.dirname(candidate);
        if (parent === candidate) throw cachePathEscape();
        candidate = parent;
      }
    }
  }

  function resolveMeta(raw, dir, realDirectory) {
    const root = realDirectory || realCacheDirectory(dir);
    const resolveFile = file => {
      if (!file) return file;
      // 舊 meta 只存 basename；補建的完整元件可位於同一 cache 的 generation。
      const relative = path.isAbsolute(file) ? path.basename(file) : file;
      const resolved = path.resolve(dir, relative);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('快取元件超出目錄');
      checkCacheComponent(root, resolved);
      return resolved;
    };
    return {
      proxy: resolveFile(raw.proxy),
      wave: resolveFile(raw.wave),
      channels: (raw.channels || []).map(channel => ({
        label: channel.label,
        file: resolveFile(channel.file),
        sourceStream: Number.isInteger(channel.sourceStream) && channel.sourceStream >= 0
          ? channel.sourceStream : null,
        sourceChannel: Number.isInteger(channel.sourceChannel) && channel.sourceChannel >= 0
          ? channel.sourceChannel : null,
      })),
    };
  }

  function metaToStore(meta, dir) {
    const relative = file => file ? path.relative(dir, file).split(path.sep).join('/') : file;
    return {
      proxy: relative(meta.proxy),
      ...(meta.proxy && options.describeVideo ? { proxyColorVersion: 1 } : {}),
      wave: relative(meta.wave),
      ...(meta.wave ? { waveMixVersion: 1 } : {}),
      channels: (meta.channels || []).map(channel => ({
        label: channel.label,
        file: relative(channel.file),
        sourceStream: Number.isInteger(channel.sourceStream) ? channel.sourceStream : null,
        sourceChannel: Number.isInteger(channel.sourceChannel) ? channel.sourceChannel : null,
      })),
    };
  }

  function fileState(file, expectedSize) {
    if (!file) return 'missing';
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size > 0 && (expectedSize === undefined || expectedSize === stat.size) ? 'complete' : 'missing';
    }
    catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unknown'; }
  }

  function completeFile(file) {
    return fileState(file) === 'complete';
  }

  // 同一份檔案證據決定重用與清理；暫時 I/O 錯誤不能等同可刪除。
  function inspectMeta(meta, sizes = new Map()) {
    const expected = file => file ? sizes.get(canonicalCachePath(file)) : undefined;
    const proxyState = fileState(meta.proxy, expected(meta.proxy));
    const waveState = fileState(meta.wave, expected(meta.wave));
    const channelStates = meta.channels.map(channel => fileState(channel.file, expected(channel.file)));
    return {
      files: [
        { file: meta.proxy, state: proxyState },
        { file: meta.wave, state: waveState },
        ...meta.channels.map((channel, index) => ({ file: channel.file, state: channelStates[index] })),
      ].filter(entry => entry.file).map(entry => ({ ...entry, expectedSize: expected(entry.file) })),
      retained: [proxyState, waveState, ...channelStates].some(state => state !== 'missing'),
      meta: {
        proxy: proxyState === 'complete' ? meta.proxy : null,
        wave: waveState === 'complete' ? meta.wave : null,
        channels: meta.channels.filter((_, index) => channelStates[index] === 'complete'),
      },
      audioLayout: meta.channels,
    };
  }

  function coversAudioRequest(meta, audio) {
    if (!audio.length) return true;
    const expected = flattenSourceChannels(audio);
    return completeFile(meta.wave) && meta.channels.length === expected.length
      && expected.every((channel, index) =>
        completeFile(meta.channels[index].file)
        &&
        meta.channels[index].sourceStream === channel.sourceStream
        && meta.channels[index].sourceChannel === channel.sourceChannel);
  }

  function metaValid(meta) {
    return (!meta.proxy || completeFile(meta.proxy))
      && (meta.channels || []).every(channel => completeFile(channel.file))
      && (!meta.wave || completeFile(meta.wave));
  }

  function writeRawMeta(metaPath, raw, verify = () => {}) {
    const temporaryPath = metaPath + '.tmp-' + crypto.randomBytes(12).toString('hex');
    try {
      verify();
      fs.writeFileSync(temporaryPath, JSON.stringify(raw));
      verify();
      fs.renameSync(temporaryPath, metaPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (ignored) {}
      throw error;
    }
  }

  function validSourceContent(value) {
    return value?.format === PORTABLE_SOURCE_FORMAT && Number.isSafeInteger(value.size) && value.size >= 0
      && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
  }

  const sameSourceContent = (left, right) => validSourceContent(left) && validSourceContent(right)
    && left.sha256 === right.sha256 && left.size === right.size;
  const sameAudioLayout = (left, right) => left.length === right.length && left.every((channel, index) =>
    channel.sourceStream === right[index].sourceStream && channel.sourceChannel === right[index].sourceChannel);
  // A wave's mix version is meaningful only with its ordered source-channel
  // layout. A proxy-only publication can otherwise carry and incorrectly
  // certify an older wave whose missing coordinates hide multiple streams.
  function completeAudioLayout(channels) {
    if (!channels.length) return false;
    let stream = 0, channel = 0;
    for (const entry of channels) {
      if (entry.sourceStream === stream && entry.sourceChannel === channel) { channel++; continue; }
      if (channel > 0 && entry.sourceStream === stream + 1 && entry.sourceChannel === 0) {
        stream++; channel = 1; continue;
      }
      return false;
    }
    return true;
  }

  function writeMeta(metaPath, publicationPath, meta, sourceContent, sourceKey, audio, verify) {
    verify();
    const current = inspectCacheDirectory(path.dirname(metaPath), audio);
    if (current.sourceContent && !sameSourceContent(current.sourceContent, sourceContent)) throw cacheDirectoryChanged();
    const keys = !current.error && sameSourceContent(current.sourceContent, sourceContent) ? current.sourceKeys : [];
    if (!current.error && sameSourceContent(current.sourceContent, sourceContent)) {
      meta.proxy ||= current.meta.proxy;
      if (!audio.length) {
        meta.wave = current.meta.wave || meta.wave;
        if (current.meta.channels.length) meta.channels = current.meta.channels;
      }
    }
    const dir = path.dirname(metaPath);
    const artifactSizes = Object.fromEntries([...new Set([meta.proxy, meta.wave, ...meta.channels.map(channel => channel.file)].filter(Boolean))]
      .map(file => [path.relative(dir, file).split(path.sep).join('/'), fs.statSync(file).size]));
    const raw = { ...metaToStore(meta, dir), artifactSizes, publicationVersion: 1, sourceContent,
      sourceKeys: [...new Set([...keys, sourceKey])] };
    // 每個 writer 只發布自己的 generation；相容索引可被另一台電腦覆寫，
    // 完成紀錄仍獨立存在，讀取端依母素材與聲道 layout 合併完整元件。
    writeRawMeta(publicationPath, raw, verify);
    try { writeRawMeta(metaPath, raw, verify); }
    catch (error) {
      if (error.code === 'CACHE_DIRECTORY_CHANGED' || error.code === 'CACHE_PATH_ESCAPE') throw error;
      try { options.log?.('[cache] compatibility index not saved:', error.code || error.message); } catch (ignored) {}
    }
  }

  // 身分 receipt 與產物 publication 分開；補記身分不能回寫過期的產物索引。
  function bindPortableCache(dir, sourceContent, sourceKey, verify = () => {}, sharedSourceKey = null) {
    try {
      const realDirectory = realCacheDirectory(dir);
      const receipt = path.join(dir, 'source-' + sourceKey + '.json');
      checkCacheComponent(realDirectory, receipt);
      writeRawMeta(receipt, { sourceContent, sourceKey, ...(sharedSourceKey ? { sharedSourceKey } : {}) }, verify);
    } catch (error) {
      // 唯讀的共享快取仍可直接播放；下次跨工作階段再驗證，不複製或重轉 Proxy。
      try { options.log?.('[cache] portable binding not saved:', error.code || error.message); } catch (ignored) {}
    }
  }

  function metadataEntries(entries) {
    return [{ file: 'meta.json', kind: 'index' }, ...entries.flatMap(entry => {
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory() && /^generation-[a-f0-9]{24}$/.test(entry.name)) {
        return [{ file: path.join(entry.name, 'cache-meta.json'), kind: 'publication' }];
      }
      if (entry.isFile() && /^source-[a-f0-9]{16}\.json$/.test(entry.name)) {
        return [{ file: entry.name, kind: 'binding', sourceKey: entry.name.slice(7, -5) }];
      }
      return [];
    })];
  }

  function acceptedRecord(entry, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (entry.kind === 'index') return true;
    if (!validSourceContent(raw.sourceContent)) return false;
    return entry.kind === 'publication' ? raw.publicationVersion === 1 : raw.sourceKey === entry.sourceKey;
  }

  function inspectCacheDirectory(dir, audio = [], bounded = false) {
    try {
      const owner = cacheDirectoryOwner(dir);
      const realDirectory = realCacheDirectory(dir);
      const records = [];
      let uncertain = false;
      for (const entry of metadataEntries(bounded ? readCleanupEntries(dir) : fs.readdirSync(dir, { withFileTypes: true }))) {
        const file = path.join(dir, entry.file);
        try {
          checkCacheComponent(realDirectory, file);
          if (fs.statSync(file).size > 1024 * 1024) throw new Error('快取 metadata 過大');
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (acceptedRecord(entry, raw)) records.push({ ...entry, raw });
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) uncertain = true;
          if (entry.kind === 'index' && error.code === 'CACHE_PATH_ESCAPE') throw error;
        }
      }
      const sourceContent = records.map(record => record.raw.sourceContent).find(validSourceContent) || null;
      const sourceKeys = [...new Set(records.filter(record => sameSourceContent(record.raw.sourceContent, sourceContent))
        .flatMap(record => record.kind === 'binding' ? [record.raw.sourceKey]
          : Array.isArray(record.raw.sourceKeys) ? record.raw.sourceKeys : [])
        .filter(key => typeof key === 'string' && /^[a-f0-9]{16}$/.test(key)))];
      const verifiedSource = records.some(record => record.kind === 'binding'
        && sameSourceContent(record.raw.sourceContent, sourceContent));
      const sharedSourceKeys = records.filter(record => record.kind === 'binding'
        && sameSourceContent(record.raw.sourceContent, sourceContent))
        .map(record => record.raw.sharedSourceKey).filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key));
      const resolved = [], sizes = new Map();
      for (const record of records) {
        if (record.kind === 'binding' || (record.kind !== 'index' && !sameSourceContent(record.raw.sourceContent, sourceContent))) continue;
        try {
          const meta = resolveMeta(record.raw, dir, realDirectory);
          resolved.push({ meta, raw: record.raw });
          for (const file of [meta.proxy, meta.wave, ...meta.channels.map(channel => channel.file)].filter(Boolean)) {
            const size = record.raw.artifactSizes?.[path.relative(dir, file).split(path.sep).join('/')];
            if (!Number.isSafeInteger(size) || size <= 0) continue;
            const key = canonicalCachePath(file);
            // 同一路徑的任何已知完成長度都不能被缺少證據的舊索引繞過。
            sizes.set(key, sizes.has(key) && sizes.get(key) !== size ? -1 : size);
          }
        } catch (error) { if (record.kind === 'index') throw error; uncertain = true; }
      }
      const variants = resolved.map(({ meta, raw }) => {
        const inspected = inspectMeta(meta, sizes);
        if (options.describeVideo && raw.proxyColorVersion !== 1) inspected.meta.proxy = null;
        // Even a previously versioned entry can be a proxy-only publication
        // made from ambiguous old metadata. Reject that wave without dropping
        // the actual file, Proxy, or channel artifacts.
        const layout = inspected.audioLayout;
        if (!completeAudioLayout(layout) || (raw.waveMixVersion !== 1 && layout.at(-1).sourceStream !== 0))
          inspected.meta.wave = null;
        return inspected;
      });
      if (!variants.length) {
        if (!verifiedSource) return { dir, files: [], error: 'CACHE_METADATA_MISSING', metadataMissing: !uncertain };
        // 完整來源驗證與轉檔是兩份成果。只有 receipt 時仍能重用驗證，
        // 但不宣稱任何 Proxy／聲道／波形已完成。
        variants.push({ files: [], retained: true, audioLayout: [], meta: { proxy: null, wave: null, channels: [] } });
      }
      const expected = flattenSourceChannels(audio);
      const chosen = (expected.length && variants.find(variant => sameAudioLayout(variant.audioLayout, expected)))
        || variants.reduce((best, variant) => variant.audioLayout.length > best.audioLayout.length ? variant : best);
      const matching = variants.filter(variant => sameAudioLayout(variant.audioLayout, chosen.audioLayout));
      const audioLayout = chosen.audioLayout.map((channel, index) =>
        matching.find(variant => variant.meta.channels.some(valid => valid.file === variant.audioLayout[index].file))?.audioLayout[index] || channel);
      const validChannels = new Set(matching.flatMap(variant => variant.meta.channels.map(channel => channel.file)));
      const files = [...new Map(variants.flatMap(variant => variant.files).map(entry => [entry.file, entry])).values()];
      const result = { dir, files, retained: uncertain || verifiedSource || variants.some(variant => variant.retained), audioLayout,
        meta: { proxy: variants.find(variant => variant.meta.proxy)?.meta.proxy || null,
          wave: matching.find(variant => variant.meta.wave)?.meta.wave || null,
          channels: audioLayout.filter(channel => validChannels.has(channel.file)) }, sourceContent, sourceKeys, sharedSourceKeys };
      if (!sameCacheDirectory(owner, cacheDirectoryOwner(dir))) throw cacheDirectoryChanged();
      inspectedCacheOwners.set(result, owner);
      return result;
    } catch (error) {
      return { dir, files: [], error: error.code || error.message, metadataMissing: ['ENOENT', 'ENOTDIR'].includes(error.code) };
    }
  }

  function inspectCache(src) {
    const key = cacheKeyFor(src), portable = portableHits.get(key);
    return cacheCandidates(src, key).map(dir => inspectSourceCache(dir, [], key, portable, false, src));
  }

  function inspectSourceCache(dir, audio, key, portable, bounded = false, src = null) {
    const hit = inspectCacheDirectory(dir, audio, bounded);
    if (hit.error) return hit;
    const mapped = portable && canonicalCachePath(dir) === canonicalCachePath(portable.dir);
    if (mapped && !sameSourceContent(hit.sourceContent, portable.sourceContent)) {
      if (portableHits.get(key) === portable) portableHits.delete(key);
      return { dir, files: [], error: 'CACHE_SOURCE_MISMATCH' };
    }
    if (src && isSidecarCandidate(src, dir) && hit.sharedSourceKeys.length) {
      const shared = sharedSourceFingerprintSync(src);
      // A previously recorded shared witness is stronger than the local key.
      // Its mismatch must not silently upgrade an old SHA or complete waveform.
      // A fresh full-hash mapping can still read a read-only old receipt.
      const verified = mapped ? portable.sharedSourceKey === shared : shared && hit.sharedSourceKeys.includes(shared);
      if (!verified) {
        if (portableHits.get(key) === portable) portableHits.delete(key);
        return { dir, files: [], error: 'CACHE_SOURCE_UNVERIFIED' };
      }
    }
    // 新格式已明示來源證據時，不能僅憑本機 key 的目錄名稱認領別的母素材。
    // 沒有新證據的舊 metadata 保留 strict-key 相容；未綁定的新內容先全文驗證。
    if (hit.sourceContent && !mapped && !hit.sourceKeys.includes(key)) {
      return { dir, files: [], error: 'CACHE_SOURCE_UNVERIFIED' };
    }
    return hit;
  }

  function readCache(src, audio, needsProxy) {
    const key = cacheKeyFor(src), portable = portableHits.get(key);
    let partial = null;
    for (const dir of cacheCandidates(src, key)) {
      if (!canUseCacheCandidate(dir)) continue;
      const sidecar = isSidecarCandidate(src, dir) ? sidecarAuthority(src) : null;
      if (isSidecarCandidate(src, dir) && !sidecar) continue;
      const verify = () => { if (sidecar) captureOutputAuthority(path.join(sidecar.requestedPath, '.sidecar-root-check'), sidecar); };
      // 候選只是路徑提示；實際讀到的這份 metadata 仍須符合當次來源證據。
      const hit = inspectSourceCache(dir, audio, key, portable, false, src);
      if (hit.error) continue;
      if (coversAudioRequest(hit.meta, audio) && (!needsProxy || hit.meta.proxy)) {
        try { grantManagedCleanupRoot(dir, verify); return hit; } catch (_) { continue; }
      }
      if (!partial) partial = { hit, verify };
    }
    if (partial) { try { grantManagedCleanupRoot(partial.hit.dir, partial.verify); } catch (_) { return null; } }
    return partial?.hit || null;
  }

  async function preparePortableCache({ src, audio = [], needsProxy }, session, requireContent = false) {
    reportProgress(session, { jobId: 'ingest', stage: 'cache-check', label: '檢查 Proxy 與音訊快取', pct: null });
    const sourceKey = cacheKeyFor(src);
    const current = () => !closed && !cancelled(session);
    const ensureCurrent = () => { if (!current()) throw new IngestSupersededError(); };
    const check = () => {
      ensureCurrent();
      if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
    };
    let sharedSourceKey;
    const sharedKey = () => {
      if (sharedSourceKey === undefined) { sharedSourceKey = sharedSourceFingerprintSync(src); check(); }
      return sharedSourceKey;
    };
    const bindSource = (dir, sourceContent) => {
      const shared = isSidecarCandidate(src, dir) ? sharedKey() : null;
      const owner = cacheDirectoryOwner(dir);
      const verify = () => {
        check();
        if (shared && sharedSourceFingerprintSync(src) !== shared) throw new Error('母素材在內容驗證期間變更');
        checkPublicationDirectory(dir, owner, sourceContent, false);
      };
      verify();
      bindPortableCache(dir, sourceContent, sourceKey, verify, shared);
      // Read-only receipt persistence is best effort; source/directory fences
      // are not. Recheck outside its catch before adopting any cached content.
      verify();
    };
    check();
    const direct = readCache(src, audio, needsProxy);
    const knownContent = direct?.sourceContent?.size === fs.statSync(src).size ? direct.sourceContent : null;
    const directComplete = direct && coversAudioRequest(direct.meta, audio) && (!needsProxy || direct.meta.proxy);
    // 嚴格本機 key 已證明來源未變；完整舊快取不必先讀完整母素材，
    // 才能交付原本可用的音訊／波形。未具有內容證據者仍不得跨機猜用。
    if (directComplete && (!requireContent || knownContent)) {
      // Upgrade only a receipt whose full content is already bound to this
      // unchanged strict source. An unrelated old SHA cannot acquire a witness.
      if (knownContent && isSidecarCandidate(src, direct.dir) && !direct.sharedSourceKeys.includes(sharedKey()))
        bindSource(direct.dir, knownContent);
      return { sourceKey, sourceContent: knownContent };
    }
    const candidates = [];
    if (!directComplete) {
      const roots = [cacheRoot()];
      if (allowSidecarCache) roots.unshift(path.join(path.dirname(src), '.subtool_Cache'));
      const size = fs.statSync(src).size;
      for (const root of new Set(roots)) {
        const sidecar = canonicalCachePath(root) === canonicalCachePath(sidecarRoot(src)) ? sidecarAuthority(src) : null;
        if (canonicalCachePath(root) === canonicalCachePath(sidecarRoot(src)) && !sidecar) continue;
        const verifyRoot = () => {
          if (sidecar) captureOutputAuthority(path.join(root, '.sidecar-root-check'), sidecar);
          else assertCleanupAncestors(path.join(root, '.cleanup-root-check'));
        };
        let entries;
        try { verifyRoot(); entries = await fsp.readdir(root, { withFileTypes: true }); verifyRoot(); } catch (error) { entries = []; }
        ensureCurrent();
        for (const entry of entries) {
          // 不追逐 symlink 或任意 metadata 路徑，只查看原本位置的 cache key 目錄。
          if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
          const dir = path.join(root, entry.name), records = [];
          try {
            for (const metadata of metadataEntries(await fsp.readdir(dir, { withFileTypes: true }))) {
              ensureCurrent(); verifyRoot();
              let file;
              try {
                file = await openCacheComponent(dir, path.join(dir, metadata.file));
                ensureCurrent(); verifyRoot();
                if ((await file.stat()).size > 1024 * 1024) continue;
                const raw = JSON.parse(await file.readFile('utf8'));
                verifyRoot(); if (acceptedRecord(metadata, raw)) records.push({ ...metadata, raw });
              } catch (error) { ensureCurrent(); }
              finally { if (file) await file.close(); }
            }
          } catch (error) { continue; }
          ensureCurrent();
          const sourceContent = records.map(record => record.raw.sourceContent).find(validSourceContent);
          if (!sourceContent || sourceContent.size !== size) continue;
          const sourceKeys = records.filter(record => sameSourceContent(record.raw.sourceContent, sourceContent))
            .flatMap(record => record.kind === 'binding' ? [record.raw.sourceKey]
              : Array.isArray(record.raw.sourceKeys) ? record.raw.sourceKeys : []);
          try { verifyRoot(); candidates.push({ dir, sourceContent, sourceKeys, verifyRoot }); } catch (_) {}
        }
      }
      check();
      // 本機 strict key 或同一 NAS 檔案的共享證據可沿用已完成全文驗證。
      // 僅相鄰 sidecar 能使用共享證據；複製檔、其他 NAS 與舊收據仍讀全文。
      let verifiedPartial = null;
      for (const candidate of candidates) {
        try { candidate.verifyRoot(); } catch (_) { continue; }
        const hit = inspectCacheDirectory(candidate.dir, audio);
        if (hit.error || !sameSourceContent(hit.sourceContent, candidate.sourceContent)) continue;
        const shared = isSidecarCandidate(src, candidate.dir) && sharedKey();
        if (isSidecarCandidate(src, candidate.dir) && hit.sharedSourceKeys.length
          && !(shared && hit.sharedSourceKeys.includes(shared))) continue;
        if (!hit.sourceKeys.includes(sourceKey) && !(shared && hit.sharedSourceKeys.includes(shared))) continue;
        check(); candidate.verifyRoot();
        if (!coversAudioRequest(hit.meta, audio) || (needsProxy && !hit.meta.proxy)) {
          verifiedPartial ||= candidate;
          continue;
        }
        bindSource(candidate.dir, candidate.sourceContent);
        portableHits.set(sourceKey, { dir: candidate.dir, sourceContent: candidate.sourceContent, sharedSourceKey: sharedKey() });
        return { sourceKey, sourceContent: candidate.sourceContent };
      }
      // 缺少元件不撤銷先前對母素材的完整驗證；只補缺件，仍在 plan/commit 重核目錄與來源。
      if (verifiedPartial) {
        bindSource(verifiedPartial.dir, verifiedPartial.sourceContent);
        portableHits.set(sourceKey, { dir: verifiedPartial.dir, sourceContent: verifiedPartial.sourceContent, sharedSourceKey: sharedKey() });
        return { sourceKey, sourceContent: verifiedPartial.sourceContent };
      }
    }
    let sha256 = knownContent?.sha256;
    if (!sha256) {
      // Freeze shared file identity before the full read, then recheck it at
      // receipt publication. A new sample cannot certify an older SHA.
      if (allowSidecarCache) sharedKey();
      let lastPercent = -1, lastReport = -Infinity;
      const hash = portableSourceFingerprint(src, { shouldContinue: current, onProgress: ({ processedBytes, totalBytes, completed }) => {
        const pct = totalBytes ? processedBytes / totalBytes * 100 : completed ? 100 : null;
        const timestamp = now(), integer = pct === null ? -1 : Math.floor(pct);
        if (integer === lastPercent && timestamp - lastReport < 250) return;
        lastPercent = integer; lastReport = timestamp;
        reportProgress(session, { jobId: 'ingest', stage: 'source-verification', label: '驗證母素材內容', pct, processedBytes, totalBytes });
      } });
      portableHashes.add(hash);
      try { sha256 = await hash; } finally { portableHashes.delete(hash); }
    }
    check();
    const sourceContent = { format: PORTABLE_SOURCE_FORMAT, size: fs.statSync(src).size, sha256 };
    if (direct && (!sameSourceContent(direct.sourceContent, sourceContent) || !direct.sourceKeys.includes(sourceKey))) {
      if (!isSidecarCandidate(src, direct.dir) || sidecarAuthority(src)) bindSource(direct.dir, sourceContent);
    }
    if (!directComplete) {
      let partial = null;
      for (const candidate of candidates) {
        try { candidate.verifyRoot(); } catch (_) { continue; }
        if (candidate.sourceContent.sha256 !== sha256) continue;
        const hit = inspectCacheDirectory(candidate.dir, audio);
        if (hit.error || !sameSourceContent(hit.sourceContent, sourceContent)) continue;
        if (coversAudioRequest(hit.meta, audio) && (!needsProxy || hit.meta.proxy)) { partial = hit; break; }
        partial ||= hit;
      }
      if (partial) {
        if (!partial.sourceKeys.includes(sourceKey)
          || (isSidecarCandidate(src, partial.dir) && !partial.sharedSourceKeys.includes(sharedKey()))) bindSource(partial.dir, sourceContent);
        portableHits.set(sourceKey, { dir: partial.dir, sourceContent, sharedSourceKey: sharedKey() });
      }
    }
    if (!direct && !portableHits.has(sourceKey)) {
      // 先保存已完成的全文驗證；之後取消／轉檔失敗不能讓大型 NAS
      // 母素材在重開時又被完整讀取。receipt 不等於產物完成紀錄。
      bindSource(writeCacheDir(src), sourceContent);
    }
    return { sourceKey, sourceContent };
  }

  function isDirWritable(dir) {
    let testPath, descriptor, owner, directoryOwner;
    try {
      try { if (fs.lstatSync(dir).isSymbolicLink()) return false; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return false; }
      fs.mkdirSync(dir, { recursive: true });
      directoryOwner = cacheDirectoryOwner(dir);
      // 素材旁的共用快取不是私有目錄；固定 PID 探針可能是既有 hardlink，
      // 預設 w 會截斷另一份檔案。以獨占 handle 寫入，只清理本次建立的身分。
      testPath = path.join(dir, '.wtest_' + crypto.randomBytes(12).toString('hex'));
      descriptor = fs.openSync(testPath, 'wx');
      owner = fs.fstatSync(descriptor, { bigint: true });
      fs.writeFileSync(descriptor, 'x');
      return true;
    } catch (error) {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (error) {}
      }
      if (owner) {
        try {
          const current = fs.lstatSync(testPath, { bigint: true });
          if (sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))
            && current.isFile() && !current.isSymbolicLink()
            && current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(testPath);
        } catch (error) {}
      }
    }
  }

  function writeCacheDir(src) {
    const key = cacheKeyFor(src), portable = portableHits.get(key);
    const central = cacheRoot();
    // 測試或嵌入式 caller 若尚未建立中央根，只能為本次獨占建立的目錄登記；
    // 已存在但未登記的根不能在清理或後續工作中被默默採信。
    if (!cleanupRoots.has(sourceWaveKey(central))) {
      try { fs.mkdirSync(path.dirname(central), { recursive: true }); fs.mkdirSync(central); grantManagedCleanupRoot(central); }
      catch (_) {}
    }
    const admitted = dir => {
      const hit = inspectSourceCache(dir, [], key, portable, false, src);
      return !hit.error || hit.metadataMissing;
    };
    for (const dir of cacheCandidates(src, key)) {
      let sidecar = null;
      if (isSidecarCandidate(src, dir)) {
        sidecar = sidecarAuthority(src, { allowMissing: true });
        if (sidecar?.missing) {
          try { fs.mkdirSync(sidecarRoot(src)); sidecar = sidecarAuthority(src); } catch (_) { sidecar = null; }
        }
        if (!sidecar) continue;
      }
      const ownsSidecar = () => {
        if (!sidecar) return true;
        try { captureOutputAuthority(path.join(sidecar.requestedPath, '.sidecar-root-check'), sidecar); return true; }
        catch (_) { return false; }
      };
      if (!ownsSidecar() || !canUseCacheCandidate(dir) || !admitted(dir) || !isDirWritable(dir)
        || !ownsSidecar() || !canUseCacheCandidate(dir) || !admitted(dir)) continue;
      try { grantManagedCleanupRoot(dir, () => { if (!ownsSidecar()) throw cacheDirectoryChanged(); }); return dir; } catch (_) { continue; }
    }
    const fallback = path.join(cacheRoot(), key);
    if (!canUseCacheCandidate(fallback) || !admitted(fallback) || !isDirWritable(fallback)
      || !canUseCacheCandidate(fallback) || !admitted(fallback)) {
      throw new Error('無法建立媒體快取，請確認快取目錄權限與來源');
    }
    grantManagedCleanupRoot(fallback);
    return fallback;
  }

  function dirSize(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) throw cachePathEscape();
      if (stat.isDirectory()) total += dirSize(entryPath);
      else if (stat.isFile()) total += stat.size;
      else throw cachePathEscape();
    }
    return total;
  }

  function cacheInfo() {
    const root = cacheRoot();
    let folders = 0;
    let bytes = 0;
    try {
      const authority = cleanupRoots.get(sourceWaveKey(root));
      if (!authority) throw cacheDirectoryChanged();
      const verify = () => captureOutputAuthority(path.join(root, '.cache-info-check'), authority);
      verify();
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        verify();
        const stat = fs.lstatSync(path.join(root, entry.name));
        if (stat.isSymbolicLink()) throw cachePathEscape();
        if (!stat.isDirectory()) continue;
        folders++;
        bytes += dirSize(path.join(root, entry.name));
      }
      verify();
    } catch (error) { return { root, unavailable: true }; }
    return { root, folders, bytes };
  }

  function captureCentralEntry(target, authority) {
    const parent = captureOutputAuthority(target, authority);
    const entry = fs.lstatSync(target, { bigint: true });
    if (entry.isSymbolicLink()) throw cachePathEscape();
    return { target, parent, entry };
  }

  // 清理前後最多掃 20,000 項、2,048 個目錄、48 層；任何越界、符號連結
  // 或 I/O 不確定都保留整筆，不使用「部分看見」的內容授權遞迴刪除。
  function readCleanupEntries(dir, limit = 20000) {
    const handle = fs.opendirSync(dir), entries = [];
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (entries.length >= limit) throw new Error('快取清理列舉超過上限');
        entries.push(entry);
      }
      return entries;
    } finally { handle.closeSync(); }
  }

  function captureCleanupTree(target, budget = { entries: 0, directories: 0 }, initialDepth = 0) {
    const entries = [];
    let bytes = 0;
    const visit = (file, relative, depth) => {
      if (depth > 48 || ++budget.entries > 20000) throw new Error('快取清理快照超過上限');
      const before = fs.lstatSync(file, { bigint: true });
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw new Error('快取包含未確認的目錄項');
      entries.push([relative, String(before.dev), String(before.ino), String(before.mode),
        String(before.size), String(before.mtimeNs), relative ? String(before.ctimeNs) : null]);
      if (before.isFile()) {
        bytes += Number(before.size);
        if (!Number.isSafeInteger(bytes)) throw new Error('快取大小超過上限');
      }
      if (before.isDirectory()) {
        if (++budget.directories > 2048) throw new Error('快取清理目錄數超過上限');
        const names = readCleanupEntries(file, 20000 - budget.entries).map(entry => entry.name).sort();
        for (const name of names) visit(path.join(file, name), relative ? `${relative}/${name}` : name, depth + 1);
      }
      const after = fs.lstatSync(file, { bigint: true });
      if (!sameCentralEntry(before, after, true) || (relative && before.ctimeNs !== after.ctimeNs)) throw cacheDirectoryChanged();
    };
    visit(target, '', initialDepth);
    return { proof: JSON.stringify(entries), entries, bytes };
  }

  // 清理候選須讀完整內容，不能以抽樣或時間戳代替。每次 I/O
  // 交出主行程後都重新確認來源目錄、活動 writer 與工作世代。
  function cleanupDigestQueue(check) {
    const pending = [];
    async function flush() {
      if (!pending.length) return;
      const batch = pending.splice(0), handles = [];
      const all = async promises => {
        const results = await Promise.allSettled(promises);check();
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        return results.map(result => result.value);
      };
      try {
        check();
        const opened = await Promise.allSettled(batch.map(async item => {
          const handle = await fsp.open(item.file, 'r');handles.push(handle);cleanupHandles.add(handle);return handle;
        }));
        check();
        const failure = opened.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        for (let index=0;index<batch.length;index++) {
          const item=batch[index];item.handle=opened[index].value;item.position=0;
          item.hash=crypto.createHash('sha256');
          item.buffer=Buffer.allocUnsafe(Math.min(1024*1024,Math.max(1,Number(item.entry.size))));
          item.same=stat=>sameCentralEntry(item.entry,stat,true)&&item.entry.ctimeNs===stat.ctimeNs;
        }
        const before=await all(batch.map(item=>item.handle.stat({bigint:true})));
        if (before.some((stat,index)=>!batch[index].same(stat))) throw cacheDirectoryChanged();
        for (;;) {
          const active=batch.filter(item=>item.position<Number(item.entry.size));
          if (!active.length) break;
          const reads=await all(active.map(item=>item.handle.read(item.buffer,0,Math.min(item.buffer.length,Number(item.entry.size)-item.position),item.position)));
          for(let index=0;index<active.length;index++) {
            const item=active[index],count=reads[index].bytesRead;
            if (!count) throw cacheDirectoryChanged();
            item.hash.update(item.buffer.subarray(0,count));item.position+=count;
          }
        }
        const after=await all(batch.map(item=>item.handle.stat({bigint:true})));
        if (after.some((stat,index)=>!batch[index].same(stat))) throw cacheDirectoryChanged();
        for(const item of batch) {
          if (!item.same(fs.lstatSync(item.file,{bigint:true}))) throw cacheDirectoryChanged();
          item.accept(item.hash.digest('hex'));
        }
      } finally {
        const closedHandles = await Promise.allSettled(handles.map(async handle=>{
          await handle.close();cleanupHandles.delete(handle);
        }));
        const failure=closedHandles.find(result=>result.status==='rejected');
        if (failure) throw failure.reason;
      }
      check();
    }
    return {
      add(item) { pending.push(item);return pending.length >= 32 ? flush() : null; },
      async finish() { await flush(); },
    };
  }

  function cleanupDigest(entries, hashes) {
    const hash = crypto.createHash('sha256');
    for (let index=0;index<entries.length;index++) if (hashes[index] !== undefined) {
      hash.update(entries[index][0]).update('\0').update(entries[index][4]).update('\0').update(hashes[index]);
    }
    return hash.digest('hex');
  }

  async function cleanupContentDigest(directory, snapshot, check) {
    const hashes = [], queue = cleanupDigestQueue(check);
    try {
      check();
      for (let index=0;index<snapshot.entries.length;index++) {
        const [relative, dev, ino, mode, size, mtime, ctime] = snapshot.entries[index];
        const file = relative ? path.join(directory, ...relative.split('/')) : directory;
        const entry = fs.lstatSync(file, { bigint: true });
        if (!entry.isFile()) continue;
        if (![entry.dev,entry.ino,entry.mode,entry.size,entry.mtimeNs,entry.ctimeNs].map(String)
          .every((value,i)=>i===5 && ctime===null || value===[dev,ino,mode,size,mtime,ctime][i])) throw cacheDirectoryChanged();
        const pending=queue.add({file,entry,accept:digest=>{hashes[index]=digest;}});
        if(pending){await pending;check();}
      }
      await queue.finish();check();
      return cleanupDigest(snapshot.entries, hashes);
    } catch (error) { throw error; }
  }

  async function captureCleanupSnapshot(directory, check, budget = { entries: 0, directories: 0 }, initialDepth = 0) {
    const entries = [], hashes = [], queue = cleanupDigestQueue(check);
    let bytes = 0;
    function visit(file, relative, depth) {
      if (depth > 48 || ++budget.entries > 20000) throw new Error('快取清理快照超過上限');
      const before = fs.lstatSync(file, { bigint: true });
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw cacheDirectoryChanged();
      const index=entries.length;
      entries.push([relative, String(before.dev), String(before.ino), String(before.mode),
        String(before.size), String(before.mtimeNs), relative ? String(before.ctimeNs) : null]);
      if (before.isDirectory()) {
        if (++budget.directories > 2048) throw new Error('快取清理目錄數超過上限');
        const names=readCleanupEntries(file, 20000 - budget.entries).map(entry => entry.name).sort();
        return (async()=>{
          for(const name of names){
            const pending=visit(path.join(file, name),relative ? `${relative}/${name}` : name,depth+1);
            if(pending){await pending;check();}
          }
          const after=fs.lstatSync(file,{bigint:true});
          if(!sameCentralEntry(before,after,true)||(relative&&before.ctimeNs!==after.ctimeNs))throw cacheDirectoryChanged();
        })();
      } else {
        bytes += Number(before.size);
        if (!Number.isSafeInteger(bytes)) throw new Error('快取大小超過上限');
        return queue.add({file,entry:before,accept:digest=>{hashes[index]=digest;}});
      }
    }
    try { check();const pending=visit(directory, '', initialDepth);if(pending){await pending;check();}await queue.finish();check(); }
    catch (error) { throw error; }
    return { entries, hashes, proof: JSON.stringify(entries), bytes, digest: cleanupDigest(entries, hashes) };
  }

  // 整棵隔離樹完成准入後，逐檔重新讀取並立即核對再刪除；任何衝突
  // 保留尚未處理的檔案。這仍是多個系統呼叫，不能宣稱原子刪除。
  async function removeVerifiedCleanupTree(directory, snapshot, check) {
    let removedBytes = 0;
    const active = new Set();
    const ready = [];
    let wake = null;
    const completed = result => {
      ready.push(result);
      if (wake) { const notify=wake;wake=null;notify(); }
    };
    try {
      const files=snapshot.entries.map((entry,index)=>({entry,index})).filter(({index})=>snapshot.hashes[index]!==undefined);
      const launch=({entry,index})=>{
        const work=(async()=>{
        const expectedHash=snapshot.hashes[index];
        const relative=entry[0],file=relative?path.join(directory,...relative.split('/')):directory;
        const same=stat=>stat.isFile()&&!stat.isSymbolicLink()
          && [stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].map(String)
            .every((value,i)=>i===5&&entry[6]===null||value===entry[i+1]);
        let handle;
        try {
          handle=await fsp.open(file,'r');cleanupHandles.add(handle);check();
          if(!same(fs.fstatSync(handle.fd,{bigint:true})))throw cacheDirectoryChanged();
          const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(Math.min(1024*1024,Math.max(1,Number(entry[4]))));
          let position=0;
          while(position<Number(entry[4])){
            const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(entry[4])-position),position);check();
            if(!bytesRead)throw cacheDirectoryChanged();hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
          }
          if(!same(fs.fstatSync(handle.fd,{bigint:true}))||hash.digest('hex')!==expectedHash)throw cacheDirectoryChanged();
        } finally {
          if(handle){await handle.close();cleanupHandles.delete(handle);}
        }
        check();return {file,same};
        })();
        const tracked=work.then(value=>({tracked,value}),error=>({tracked,error}));
        active.add(tracked);
        tracked.then(completed);
      };
      let next=0;
      while(next<files.length || active.size){
        while(next<files.length&&active.size<32)launch(files[next++]);
        if (!ready.length) await new Promise(resolve=>{wake=resolve;});
        check();
        const result=ready.shift();
        active.delete(result.tracked);
        if(result.error)throw result.error;
        const {file,same}=result.value,current=fs.lstatSync(file,{bigint:true});
        if(!same(current))throw cacheDirectoryChanged();
        fs.unlinkSync(file);removedBytes+=Number(current.size);
      }
      for (let index=snapshot.entries.length-1;index>=0;index--) {
        if (snapshot.hashes[index] !== undefined) continue;
        check();
        const entry=snapshot.entries[index],file=entry[0]?path.join(directory,...entry[0].split('/')):directory;
        const current=fs.lstatSync(file,{bigint:true});
        if (!current.isDirectory() || current.isSymbolicLink()
          || String(current.dev)!==entry[1] || String(current.ino)!==entry[2] || String(current.mode)!==entry[3]) throw cacheDirectoryChanged();
        fs.rmdirSync(file);
      }
      return { complete:true, removedBytes };
    } catch (_) { return { complete:false, removedBytes }; }
    finally { await Promise.allSettled([...active]); }
  }

  function sameCentralEntry(left, right, content = false) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
      && (!content || (left.size === right.size && left.mtimeNs === right.mtimeNs));
  }

  function ownsCentralEntry(owner, { content = false } = {}) {
    try {
      assertOutputAuthority(owner.parent, owner.target);
      return sameCentralEntry(owner.entry, fs.lstatSync(owner.target, { bigint: true }), content);
    } catch (_) { return false; }
  }

  // 先把剛核對的目錄項移入本次獨占隔離目錄，再以 inode 及內容時間
  // 確認取得的是原項；若有疑慮只嘗試放回空位，不覆蓋較新目錄項。
  async function removeCentralEntry(owner, root, authority, snapshot, eligible = () => true, check = () => {}) {
    const holder = path.join(root, '.subtool-cleanup-retained-' + crypto.randomBytes(12).toString('hex'));
    const staged = path.join(holder, 'entry');
    let holderOwner, holderAuthority, moved = false, removed = false;
    const checkHolder = () => {
      assertOutputAuthority(holderAuthority, path.join(holder, '.check'));
    };
    try {
      check();
      if (!ownsCentralEntry(owner, { content: true }) || captureCleanupTree(owner.target).proof !== snapshot.proof) return false;
      fs.mkdirSync(holder);
      holderOwner = captureOutputDirectory(holder);
      holderAuthority = captureOutputAuthority(path.join(holder, '.check'), authority);
      const holderEntry=holderAuthority.parents.at(-1);
      if(holderEntry.dev!==holderOwner.dev || holderEntry.ino!==holderOwner.ino) throw cacheDirectoryChanged();
      checkHolder();
      if (!ownsCentralEntry(owner, { content: true })) return false;
      fs.renameSync(owner.target, staged);
      moved = true;
      checkHolder();
      if (!sameCentralEntry(owner.entry, fs.lstatSync(staged, { bigint: true }), true)
        || captureCleanupTree(staged).proof !== snapshot.proof || !eligible(staged)) return false;
      const current = () => {
        check();checkHolder();
        if (!sameCentralEntry(owner.entry, fs.lstatSync(staged, { bigint: true }))) throw cacheDirectoryChanged();
      };
      const digest = await cleanupContentDigest(staged, snapshot, current);
      current();
      if (digest !== snapshot.digest || !eligible(staged)) return false;
      if (!sameCentralEntry(owner.entry, fs.lstatSync(staged, { bigint: true }), true) || captureCleanupTree(staged).proof !== snapshot.proof) return false;
      const result=await removeVerifiedCleanupTree(staged,snapshot,current);
      if (!result.complete) return result;
      moved = false; removed = true;
      forgetRemovedCleanupRoots(owner.target);
      return result;
    } catch (_) { return { complete:false, removedBytes:0 }; }
    finally {
      if (moved && holderOwner) {
        try {
          checkHolder(); assertOutputAuthority(owner.parent, owner.target);
          if (!sameCentralEntry(owner.entry, fs.lstatSync(staged, { bigint: true }))) throw cacheDirectoryChanged();
          try { fs.lstatSync(owner.target); }
          catch (error) { if (error.code === 'ENOENT') { fs.renameSync(staged, owner.target); moved = false; } }
        } catch (_) {}
      }
      if (!moved && holderOwner) { try { checkHolder(); fs.rmdirSync(holder); } catch (_) {} }
      // 保留無法證明歸屬的隔離資料；後續清理不得視為孤兒再次刪除。
      if (!removed && moved) options.log?.('[cache] retained uncertain cleanup:', holder);
    }
  }

  function cleanOrphans() {
    const generation = runtimeGeneration, cleanup = { targets: new Set(), uncertain: false };
    const task = (closed || drainingCleanup) ? Promise.resolve({ removed: 0, bytes: 0, incomplete: true }) : cleanOrphansWork(generation, cleanup);
    cleanupTasks.set(task, cleanup);
    task.then(() => cleanupTasks.delete(task), () => cleanupTasks.delete(task));
    return task;
  }

  async function cleanOrphansWork(generation, cleanup) {
    const root = cacheRoot();
    const authority = cleanupRoots.get(sourceWaveKey(root));
    let removed = 0;
    let bytes = 0, incomplete = false;
    if (!authority) return { removed, bytes, incomplete: true };
    try {
      captureOutputAuthority(path.join(root, '.cleanup-root-check'), authority);
      // 凍結整批候選後才開始刪除；否則前一筆完成期間新增的下一筆內容
      // 會被當作本次掃描看到的舊孤兒。所有候選共用同一掃描預算。
      const candidates = [], budget = { entries: 0, directories: 0 };
      const rootEntries = readCleanupEntries(root);
      for (const entry of rootEntries) if (entry.isDirectory()) {
        try { cleanup.targets.add(sourceWaveKey(fs.realpathSync.native(path.join(root, entry.name)))); }
        catch (_) { cleanup.uncertain = true; }
      }
      for (const entry of rootEntries) {
        if (generation !== runtimeGeneration) { incomplete = true; break; }
        captureOutputAuthority(path.join(root, '.cleanup-root-check'), authority);
        if (entry.name.startsWith('.subtool-cleanup-retained-')) { incomplete = true; continue; }
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const physicalDir = fs.realpathSync.native(dir);
        if ([...activeCacheDirs.keys(), ...activeCacheSources.keys()].some(writer => withinCachePath(physicalDir, fs.realpathSync.native(writer)))) { incomplete = true; continue; }
        let owner, snapshot;
        const check = () => {
          if (generation !== runtimeGeneration) throw cacheDirectoryChanged();
          captureOutputAuthority(path.join(root, '.cleanup-root-check'), authority);
          if ([...activeCacheDirs.keys(), ...activeCacheSources.keys()].some(writer => withinCachePath(physicalDir, fs.realpathSync.native(writer)))) throw cacheDirectoryChanged();
        };
        try {
          owner = captureCentralEntry(dir, authority);
          snapshot = await captureCleanupSnapshot(dir, () => {
            if (generation !== runtimeGeneration || !ownsCentralEntry(owner, { content: true })
              || [...activeCacheDirs.keys(), ...activeCacheSources.keys()].some(writer => withinCachePath(physicalDir, fs.realpathSync.native(writer)))) throw cacheDirectoryChanged();
          }, budget);
          check();
        } catch (_) { incomplete = true; continue; }
        const inspected = inspectCacheDirectory(dir, [], true);
        const waveformCache = inspectSourceWaveformCache(dir);
        if (waveformCache.retained || waveformCache.uncertain) {
          if (waveformCache.uncertain) incomplete = true;
          continue;
        }
        const remove = inspected.metadataMissing || (!inspected.error && !inspected.retained);
        if (!remove) {
          if (inspected.error || (inspected.files.some(file => file.state === 'unknown')
            && !inspected.files.some(file => file.state === 'complete'))) incomplete = true;
          continue;
        }
        candidates.push({ dir, owner, snapshot, inspected });
      }
      for (const { dir, owner, snapshot, inspected } of candidates) {
        try {
          captureOutputAuthority(path.join(root, '.cleanup-root-check'), authority);
          const physicalDir = fs.realpathSync.native(dir);
          if ([...activeCacheDirs.keys(), ...activeCacheSources.keys()].some(writer => withinCachePath(physicalDir, fs.realpathSync.native(writer)))) { incomplete = true; continue; }
          const check = () => {
            if (generation !== runtimeGeneration) throw cacheDirectoryChanged();
            if ([...activeCacheDirs.keys(), ...activeCacheSources.keys()].some(writer => withinCachePath(physicalDir, fs.realpathSync.native(writer)))) throw cacheDirectoryChanged();
          };
          const removedEntry = await removeCentralEntry(owner, root, authority, snapshot, staged => {
            const waveformCache = inspectSourceWaveformCache(staged);
            if (waveformCache.retained || waveformCache.uncertain) return false;
            const current = inspectCacheDirectory(staged, [], true);
            const sameContent = (!inspected.sourceContent && !current.sourceContent)
              || sameSourceContent(inspected.sourceContent, current.sourceContent);
            const sameKeys = JSON.stringify([...(inspected.sourceKeys || [])].sort()) === JSON.stringify([...(current.sourceKeys || [])].sort());
            return !!inspected.metadataMissing === !!current.metadataMissing && !!inspected.error === !!current.error
              && sameContent && sameKeys && (current.metadataMissing || (!current.error && !current.retained));
          }, check);
          if (!removedEntry?.complete) { bytes += removedEntry?.removedBytes || 0;incomplete = true; continue; }
          removed++;
          bytes += snapshot.bytes;
        } catch (error) { incomplete = true; }
      }
    } catch (error) { incomplete = true; }
    return { removed, bytes, incomplete };
  }

  function clearAll(currentSrc) {
    const generation = runtimeGeneration;
    const cleanup = { targets: new Set(), uncertain: false, source: currentSrc || null };
    const task = (closed || drainingCleanup) ? Promise.resolve({ bytes: 0, incomplete: true }) : clearAllWork(currentSrc, generation, cleanup);
    cleanupTasks.set(task, cleanup);
    task.then(() => cleanupTasks.delete(task), () => cleanupTasks.delete(task));
    return task;
  }

  function sourceCleanupTasks(src) {
    if (!cleanupTasks.size) return [];
    try {
      const sourceIdentity = fs.statSync(src, { bigint: true });
      const sourcePath = sourceWaveKey(fs.realpathSync.native(src));
      // 即使目錄已被隔離改名，仍以原實體父目錄與 basename 識別。
      const physicalCandidate = file => {
        try { return sourceWaveKey(fs.realpathSync.native(file)); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return sourceWaveKey(path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)));
        }
      };
      const candidates = new Set();
      for (const file of cacheCandidates(src)) {
        try { candidates.add(physicalCandidate(file)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return [...cleanupTasks].filter(([,cleanup]) => {
        if (cleanup.uncertain) return true;
        if (cleanup.source) {
          const other = fs.statSync(cleanup.source, { bigint: true });
          if ((other.dev === sourceIdentity.dev && other.ino === sourceIdentity.ino)
            || sourceWaveKey(fs.realpathSync.native(cleanup.source)) === sourcePath) return true;
        }
        return [...cleanup.targets].some(target => [...candidates].some(candidate =>
          withinCachePath(target, candidate) || withinCachePath(candidate, target)));
      })
        .map(([task]) => task);
    } catch (_) { return [...cleanupTasks.keys()]; }
  }

  async function waitSourceCleanups(src) {
    let tasks;
    while ((tasks = sourceCleanupTasks(src)).length) await Promise.allSettled(tasks);
  }

  async function clearAllWork(currentSrc, generation, cleanup) {
    if (generation !== runtimeGeneration) return { bytes: 0, incomplete: true };
    const root = cacheRoot();
    const authority = cleanupRoots.get(sourceWaveKey(root));
    const ownsCentralRoot = () => {
      if (!authority) return false;
      try { captureOutputAuthority(path.join(root, '.cleanup-root-check'), authority); return true; }
      catch (_) { return false; }
    };
    const canonical = file => {
      const resolved = path.resolve(file);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const physical = file => canonical(fs.realpathSync.native(file));
    const activePaths = () => [...activeCacheDirs.keys(), ...activeCacheSources.keys(), ...(currentSrc ? [currentSrc] : [])].map(physical);
    // 含活躍 writer 的祖先先凍結全部非活躍 sibling；不讀 writer 內容，
    // 也不在刪除一個 sibling 後把新加入或新改寫的另一項重新採信。
    let bytes = 0, incomplete = false;
    const freezeUnleased = async (target, writers, budget, depth = 0) => {
      if (depth > 48 || path.basename(target).startsWith('.subtool-cleanup-retained-')) { incomplete = true; return null; }
      const resolved = physical(target), owner = captureCentralEntry(target, authority);
      if (writers.includes(resolved)) { incomplete = true; return null; }
      if (writers.some(writer => writer.startsWith(resolved + path.sep))) {
        if (++budget.entries > 20000 || ++budget.directories > 2048) throw new Error('快取清理快照超過上限');
        const names = readCleanupEntries(target, 20000 - budget.entries).map(entry => entry.name).sort();
        const children = [];
        for (const name of names) {
          const child = await freezeUnleased(path.join(target, name), writers, budget, depth + 1);
          if (child) children.push(child);
        }
        if (!ownsCentralEntry(owner, { content: true })) throw cacheDirectoryChanged();
        return { owner, children };
      }
      const check = () => {
        if (generation !== runtimeGeneration || !ownsCentralEntry(owner, { content: true })
          || activePaths().some(writer => withinCachePath(resolved, writer))) throw cacheDirectoryChanged();
      };
      const snapshot = await captureCleanupSnapshot(target, check, budget, depth);
      check();
      return { owner, snapshot };
    };
    const removeFrozen = async (frozen, ownsAncestors = () => true) => {
      if (!frozen) return 0;
      if (!ownsAncestors() || !ownsCentralEntry(frozen.owner, { content: true })) { incomplete = true; return 0; }
      const { owner } = frozen, target = owner.target, resolved = physical(target);
      const current = () => ownsAncestors() && ownsCentralEntry(owner);
      const writers = activePaths();
      if (writers.includes(resolved)) { incomplete = true; return 0; }
      if (frozen.children) {
        let removed = 0;
        for (const child of frozen.children) { if (!current()) { incomplete = true; break; } removed += await removeFrozen(child, current); }
        return removed;
      }
      if (writers.some(writer => writer.startsWith(resolved + path.sep))) { incomplete = true; return 0; }
      let size = frozen.snapshot.bytes;
      try { const stat = fs.statSync(target); if (stat.isFile()) size = stat.size; } catch (error) {}
      try {
        if (!ownsCentralRoot() || !current()) { incomplete = true; return 0; }
        const check = () => {
          if (generation !== runtimeGeneration || !ownsAncestors()
            || activePaths().some(writer => withinCachePath(resolved, writer))) throw cacheDirectoryChanged();
        };
        const result=await removeCentralEntry(owner, root, authority, frozen.snapshot, () => true, check);
        if (result?.complete) return size;
        incomplete = true; return result?.removedBytes || 0;
      } catch (error) { incomplete = true; return 0; }
    };
    // 根本身是持久授權，不刪除再重建，避免同名新根被誤認為原目錄。
    if (ownsCentralRoot()) {
      try {
        const writers = activePaths(), budget = { entries: 0, directories: 0 };
        const frozen = [];
        const rootEntries = readCleanupEntries(root);
        for (const entry of rootEntries) {
          try { cleanup.targets.add(physical(path.join(root, entry.name))); }
          catch (_) { cleanup.uncertain = true; }
        }
        for (const entry of rootEntries) {
          if (!ownsCentralRoot()) { incomplete = true; break; }
          try { const candidate = await freezeUnleased(path.join(root, entry.name), writers, budget); if (candidate) frozen.push(candidate); }
          catch (_) { incomplete = true; }
        }
        // 所有同層候選均凍結後才刪除；不在刪除前一筆後採信較新的下一筆。
        for (const candidate of frozen) {
          if (!ownsCentralRoot()) { incomplete = true; break; }
          try { bytes += await removeFrozen(candidate); } catch (_) { incomplete = true; }
        }
      }
      catch (_) { incomplete = true; }
    } else { incomplete = true; }
    if (currentSrc && fileAuthority.canRead(currentSrc)) {
      try {
        const sidecarRoot = canonical(path.join(path.dirname(currentSrc), '.subtool_Cache'));
        const sidecarOwner = sidecarAuthority(currentSrc);
        if (!sidecarOwner) {
          try { fs.lstatSync(sidecarRoot); incomplete = true; }
          catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
          return { bytes, incomplete };
        }
        const assertSidecar = () => captureOutputAuthority(path.join(sidecarRoot, '.cleanup-root-check'), sidecarOwner);
        const key = cacheKeyFor(currentSrc), portable = portableHits.get(key);
        const removeSidecar = async dir => {
          const target = physical(dir);
          const registered = cleanupRoots.get(sourceWaveKey(dir));
          if (sidecarCleanups.has(target)) { incomplete = true; return 0; }
          if (activePaths().some(writer => {
            return writer === target || writer.startsWith(target + path.sep);
          })) { incomplete = true; return 0; }
          const quarantine = path.join(path.dirname(dir), '.subtool-clear-' + crypto.randomBytes(12).toString('hex'));
          if (canonical(path.dirname(quarantine)) !== sidecarRoot) { incomplete = true; return 0; }
          sidecarCleanups.add(target);
          let moved = false, ownedDirectory = dir, directoryIdentity = null;
          const restore = () => {
            if (!moved) return;
            // 另一個 writer 已重建原路徑時保留私有隔離目錄，不能覆蓋它的新內容。
            try {
              assertSidecar();
              if (!directoryIdentity || !sameDirectory(directoryIdentity, fs.lstatSync(quarantine, { bigint: true }))) return;
              try { fs.lstatSync(dir); }
              catch (error) { if (error.code === 'ENOENT') { fs.renameSync(quarantine, dir); moved = false; } }
            } catch (error) {}
          };
          const sameDirectory = (left, right) => left.isDirectory() && !left.isSymbolicLink()
            && right.isDirectory() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino;
          const check = () => {
            if (generation !== runtimeGeneration || activePaths().some(writer => writer === target || writer.startsWith(target + path.sep))) throw cacheDirectoryChanged();
            assertSidecar();
            if (directoryIdentity && !sameDirectory(directoryIdentity, fs.lstatSync(ownedDirectory, { bigint: true }))) throw cacheDirectoryChanged();
          };
          try {
            check();
            const before = fs.lstatSync(dir, { bigint: true });
            if (!before.isDirectory() || before.isSymbolicLink()) { incomplete = true; return 0; }
            directoryIdentity = before;
            const snapshot = await captureCleanupSnapshot(dir, check);
            check();
            const accepted = inspectSourceCache(dir, [], key, portable, true, currentSrc);
            if (accepted.error && !accepted.metadataMissing) { incomplete = true; return 0; }
            if (!sameDirectory(before, fs.lstatSync(dir, { bigint: true })) || captureCleanupTree(dir).proof !== snapshot.proof) { incomplete = true; return 0; }
            // 先原子取得將刪除的目錄物件，再核對身分與來源；不對先前候選路徑直接刪除。
            fs.renameSync(dir, quarantine);
            moved = true;
            ownedDirectory = quarantine;
            assertSidecar();
            const claimed = fs.lstatSync(quarantine, { bigint: true });
            const current = inspectCacheDirectory(quarantine, [], true);
            if (!sameDirectory(before, claimed)
              || (accepted.sourceContent && (current.error || !sameSourceContent(current.sourceContent, accepted.sourceContent)))
              || (current.sourceContent && !accepted.sourceContent)
              || (current.error && !current.metadataMissing)
              || captureCleanupTree(quarantine).proof !== snapshot.proof) { incomplete = true; restore(); return 0; }
            const size = snapshot.bytes;
            if (!sameDirectory(claimed, fs.lstatSync(quarantine, { bigint: true })) || captureCleanupTree(quarantine).proof !== snapshot.proof) { incomplete = true; restore(); return 0; }
            const finalDigest = await cleanupContentDigest(quarantine, snapshot, check);
            check();
            if (finalDigest !== snapshot.digest || !sameDirectory(claimed, fs.lstatSync(quarantine, { bigint: true })) || captureCleanupTree(quarantine).proof !== snapshot.proof) { incomplete = true; restore(); return 0; }
            assertSidecar();
            const removed=await removeVerifiedCleanupTree(quarantine,snapshot,check);
            if (!removed.complete) { incomplete = true;restore();return removed.removedBytes; }
            if (cleanupRoots.get(sourceWaveKey(dir)) === registered) cleanupRoots.delete(sourceWaveKey(dir));
            moved = false;
            return size;
          } catch (error) { incomplete = true; restore(); return 0; }
          finally { sidecarCleanups.delete(target); }
        };
        const sidecarCandidates = cacheCandidates(currentSrc, key, () => { incomplete = true; cleanup.uncertain = true; })
          .filter(dir => canonical(path.dirname(dir)) === sidecarRoot && /^[a-f0-9]{16}$/.test(path.basename(dir)));
        for (const dir of sidecarCandidates) {
          try { cleanup.targets.add(physical(dir)); }
          catch (error) { if (error.code !== 'ENOENT') cleanup.uncertain = true; }
        }
        for (const dir of sidecarCandidates) {
          // 可攜命中仍在原 key 目錄；清理只接受目前素材旁已驗證的 cache 目錄。
          try { fs.lstatSync(dir); bytes += await removeSidecar(dir); }
          catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
        }
      } catch (error) { incomplete = true; }
    } else if (currentSrc) {
      incomplete = true;
      options.log?.('[sec] cache clear source blocked:', currentSrc);
    }
    return { bytes, incomplete };
  }

  // 舊式 proxy／音訊 IPC 尚未交接輸出路徑時，由同一交易持有暫存。
  // produce 必須等待 native writer close；成功交接沿用既有 renderer cleanup。
  function assertTemporaryOwner(target, owner) {
    const current = fs.lstatSync(target, { bigint: true });
    if (!owner || !current.isFile() || current.isSymbolicLink()
      || current.dev !== owner.dev || current.ino !== owner.ino) {
      throw new Error('媒體暫存檔案身分已變更');
    }
  }

  function isOwnedTemporary(file) {
    try { return !!temporaryOwnership?.lookup(file); }
    catch (_) { return false; }
  }

  function hasUnsafeTemporaryFiles() {
    return temporaryOwnership?.hasUnsafe() || false;
  }
  async function produceTemporaryFile(file, produce, { assertParent = null, reservation = null } = {}) {
    const target = path.resolve(file);
    if (closed || !withinCachePath(tempRoot, target) || !fileAuthority.canManageInternalFile(target)
      || typeof produce !== 'function') throw new Error('無法建立此媒體暫存工作');
    const forget = () => { try { options.forgetTemporaryFile?.(target); } catch (ignored) {} };
    let record = reservation;
    if (!record) {
      try { record = temporaryOwnership.reserve(target); }
      catch (error) { if (error.code !== 'TEMP_PATH_REUSED') forget(); throw error; }
    }
    if (record.target !== target || temporaryOwnership.lookup(target)?.record !== record || !record.writing || record.retired)
      throw new Error('媒體暫存工作歸屬無效');
    const checkParent = () => { assertOutputAuthority(record.authority, target); assertParent?.(); };
    let descriptor = null, owner = null;
    let completed = false;
    try {
      checkParent();
      descriptor = fs.openSync(target, 'wx');
      owner = fs.fstatSync(descriptor, { bigint: true });
      record.owner = owner;
      fs.closeSync(descriptor); descriptor = null;
      await produce(target, owner);
      // produce 可同步發送進度並在 await 交接時讓出執行權；此後不可將
      // 被別人替換的同名檔案當成本工作結果交給 caller。
      checkParent(); temporaryOwnership.assertOwner(record);
      completed = true;
      return target;
    } catch (error) {
      if (descriptor !== null) {
        try { owner ||= fs.fstatSync(descriptor, { bigint: true }); } catch (statError) {}
        try { fs.closeSync(descriptor); } catch (closeError) {}
      }
      if (owner && !record.retired) {
        try {
          checkParent();
          // 不讓出 JS 執行權後再用過去的 metadata 刪檔；這不是 OS atomic compare-delete。
          const current = fs.lstatSync(target, { bigint: true });
          if (current.isFile() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino) {
            fs.unlinkSync(target);
            forget();
          } else {
            // 同名新物件不再屬於這份工作，也撤回這份工作的逐檔清理登記。
            forget();
          }
        } catch (cleanupError) {
          // 不掩蓋原生失敗；暫時無法回收的檔案仍保留 quit 時的清理登記。
          if (cleanupError.code === 'ENOENT' || cleanupError.code === 'SOURCE_WAVE_PARENT_CHANGED') forget();
        }
      } else if (error.code === 'EEXIST') forget();
      throw error;
    } finally {
      if (!reservation) { record.writing = false; if (!completed) record.retired = true; }
    }
  }

  function assertTemporaryOutput(file, owner) {
    const found = temporaryOwnership?.lookup(file);
    if (!found || found.alias || !found.record.writing || found.record.retired
      || found.record.owner !== owner) throw new Error('媒體暫存工作歸屬無效');
    return temporaryOwnership.assertOwner(found.record);
  }

  function withTemporaryDescriptor(file, owner, work, { truncate = false } = {}) {
    assertTemporaryOutput(file, owner);
    return temporaryOwnership.withDescriptor(file, owner, work, {
      truncate, assertParent: () => assertTemporaryOutput(file, owner),
    });
  }

  function cleanupGeneratedFile(file) {
    let target;
    try { target = path.resolve(file); } catch (error) { return false; }
    // 完成片段由整份快取清理管理；單次 renderer 的暫存清理沒有刪除它的資格。
    if (isSourceWaveformCachePath(target)) return false;
    if (!fileAuthority.canManageInternalFile(target)) {
      options.log?.('[sec] ffmpeg:cleanup blocked (outside cache):', file);
      return false;
    }
    const authority = cleanupAuthority(target);
    if (!authority) return false;
    const found = temporaryOwnership?.lookup(target);
    if (found) {
      const { record: sourceWave, alias } = found;
      if (alias || sourceWave.writing || sourceWave.retired || !sourceWave.owner) return false;
      try { temporaryOwnership.assertOwner(sourceWave); }
      catch (_) {
        sourceWave.retired = true;
        try { options.forgetTemporaryFile?.(sourceWave.target); } catch (ignored) {}
        return false;
      }
      try {
        fs.unlinkSync(sourceWave.target);
        sourceWave.retired = true;
        options.forgetTemporaryFile?.(sourceWave.target);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          sourceWave.retired = true;
          try { options.forgetTemporaryFile?.(sourceWave.target); } catch (ignored) {}
        }
        return false;
      }
    }
    // 私有 TMP 只清理由本程序交易持有的檔案；舊式中央快取清理仍保留。
    if (withinCachePath(tempRoot, target)) return false;
    try {
      assertOutputAuthority(authority, target);
      fs.unlinkSync(target);
      options.forgetTemporaryFile?.(target);
      return true;
    } catch (error) {
      return false;
    }
  }

  function isPreviewCacheMedia(file) {
    if (typeof file !== 'string' || !file) return false;
    let resolved;
    try { resolved = path.resolve(file); } catch (error) { return false; }
    const basename = path.basename(resolved).toLowerCase();
    // channelFileName() 產生 ch_01.m4a；舊版無底線聲道與混音波形也只供預覽。
    if (basename !== 'proxy.mp4' && basename !== 'wave.wav' && !basename.endsWith('.source-wave.wav')
      && !/^ch_?\d+\.m4a$/i.test(basename)) return false;
    const lower = resolved.toLowerCase();
    const inInternalRoot = [cacheRoot(), tempRoot].filter(Boolean).some(root => {
      try {
        const resolvedRoot = path.resolve(root).toLowerCase();
        return lower === resolvedRoot || lower.startsWith(resolvedRoot + path.sep);
      } catch (error) {
        return false;
      }
    });
    return inInternalRoot || lower.split(path.sep).includes('.subtool_cache');
  }

  function cancelled(session) {
    return !!session?.isCancelled?.();
  }

  async function describeMissingProxy(src, audio, required = false) {
    if (!options.describeVideo || (!required && readCache(src, audio || [], true)?.meta.proxy)) return null;
    const sourceKey = cacheKeyFor(src);
    const video = await options.describeVideo(src);
    // probe 的描述與後續快取准入必須屬於同一母素材，不能認證等待期間被替換的新檔。
    if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
    if (!(video?.width > 0 && video?.height > 0)) throw new Error('無法確認 Proxy 母素材的視訊尺寸與色彩');
    return { video, sourceKey };
  }

  async function ensureStreamServer() {
    if (closed) throw new Error('媒體串流 runtime 已關閉');
    if (streamServerReady) return streamServerReady;
    streamServerReady = new Promise((resolve, reject) => {
      streamServer = http.createServer((request, response) => {
        let id;
        try { id = decodeURIComponent((request.url || '').slice(1).split('?')[0]); }
        catch (error) { response.writeHead(400); response.end(); return; }
        const job = streamJobs.get(id);
        if (!job?.filePath) {
          response.writeHead(404);
          response.end();
          return;
        }
        // URL lease 已授權後才提供 CORS；猜測或已釋放的 token 仍是無內容 404。
        // renderer 以 anonymous 讀取，不能靠關閉 webSecurity 讓 Web Audio/canvas
        // 取用 opaque 的 Proxy 回應。Range preflight 也只能跨同一份有效 lease。
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Range');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        const method = request.method;
        const requestedMethod = request.headers['access-control-request-method'];
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)
          || (method === 'OPTIONS' && requestedMethod && !['GET', 'HEAD'].includes(requestedMethod))) {
          response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
          response.end();
          return;
        }
        if (method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }
        // 每個 HTTP 回應的 reader／輪詢與 URL lease 共用同一份 lifetime。
        // 回應斷線、lease 釋放或 runtime 關閉都會走 cancel，不能留下重試 timer。
        const sessions = job.requests ||= new Set();
        let reader = null;
        let timer = null;
        let ended = false;
        const cancel = () => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          reader?.destroy();
          sessions.delete(cancel);
          response.destroy();
        };
        sessions.add(cancel);
        request.once('aborted', cancel);
        response.once('close', cancel);
        const live = () => !ended && !response.destroyed && streamJobs.get(id) === job;
        const fail = (error, status = 500) => {
          if (!live()) return;
          if (error) options.log?.('[HTTP] range 供應失敗：', error);
          if (!response.headersSent) { response.writeHead(status); response.end(); }
          else cancel();
        };
        const cacheDirectory = [...activeCacheDirs.keys()].filter(dir => withinCachePath(dir, job.filePath))
          .sort((left, right) => right.length - left.length)[0];
        const openStreamFile = async () => {
          job.verifySourceOwner();
          const file = await openCacheComponent(cacheDirectory, job.filePath);
          try { job.verifySourceOwner(await file.stat({ bigint: true })); return file; }
          catch (error) { await file.close(); throw error; }
        };
        const streamStat = async () => {
          const file = await openStreamFile();
          try { return await file.stat(); } finally { await file.close(); }
        };
        const pipe = async (streamOptions, end = true) => {
          if (!live()) return;
          const file = await openStreamFile();
          try {
            if (!live()) { await file.close(); return; }
            job.verifySourceOwner(await file.stat({ bigint: true }));
            if (!live()) { await file.close(); return; }
            // 沿已驗證的 handle 讀取；准入後再換 junction 也不能把 reader 轉向外檔。
            reader = fs.createReadStream(job.filePath, { ...streamOptions, fd: file, autoClose: true });
            reader.once('error', error => fail(error));
            reader.pipe(response, { end });
            return reader;
          } catch (error) { await file.close(); throw error; }
        };
        const schedule = (work, ms) => {
          if (!live()) return;
          timer = setTimeout(() => {
            timer = null;
            if (live()) Promise.resolve().then(work).catch(error => fail(error));
          }, ms);
        };
        const range = request.headers.range;
        if (!range) {
          const headers = {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          };
          if (method === 'HEAD') {
            // 成長中的 Proxy 沒有最終長度；HEAD 不建立 reader、不等 writer。
            void streamStat().then(stat => {
              if (!live()) return;
              if (job.error) { fail(new Error(job.error)); return; }
              if (job.done) headers['Content-Length'] = stat.size;
              response.writeHead(200, headers);
              response.end();
            }).catch(error => fail(error));
            return;
          }
          response.writeHead(200, headers);
          let offset = 0;
          const pump = async () => {
            if (!live()) return;
            const size = (await streamStat()).size;
            if (!live()) return;
            if (job.error) { fail(new Error(job.error)); return; }
            if (size <= offset) {
              if (job.done) response.end();
              else schedule(pump, 400);
              return;
            }
            // 非 Range 請求也須供應後續增長的 bytes，不能只等 writer 完成後
            // 關閉最初的短回應，否則會交付截斷的 fragmented MP4。
            const stream = await pipe({ start: offset, end: size - 1 }, false);
            if (!stream) return;
            stream.on('data', chunk => { offset += chunk.length; });
            stream.once('end', () => { void pump().catch(error => fail(error)); });
          };
          void pump().catch(error => fail(error));
          return;
        }
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) {
          response.writeHead(400);
          response.end();
          return;
        }
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : undefined;
        if (!Number.isSafeInteger(start) || (requestedEnd !== undefined
          && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))) {
          fail(null, 416);
          return;
        }
        /* Proxy 多半在素材旁的 .subtool_Cache；SMB 上的 Range 輪詢必須用
           非同步 stat，否則每 500ms 會鎖住 Electron 主執行緒與原生檔案對話框。 */
        const tryRange = async attempt => {
          if (!live()) return;
          let size = 0;
          try { size = (await streamStat()).size; }
          catch (error) { if (['CACHE_PATH_ESCAPE', 'CACHE_DIRECTORY_CHANGED'].includes(error.code)) { fail(error, 403); return; } }
          if (!live()) return;
          if (job.error) { fail(new Error(job.error)); return; }
          if (size <= start && !job.done && attempt < 120) {
            schedule(() => tryRange(attempt + 1), 500);
            return;
          }
          if (size <= start) {
            response.writeHead(416);
            response.end();
            return;
          }
          const end = requestedEnd === undefined ? size - 1 : Math.min(requestedEnd, size - 1);
          response.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes ${start}-${end}/${job.done ? size : '*'}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          if (method === 'HEAD') response.end();
          else await pipe({ start, end });
        };
        void tryRange(0).catch(error => fail(error));
      });
      streamServer.listen(0, '127.0.0.1', () => {
        streamPort = streamServer.address().port;
        resolve(streamPort);
      });
      streamServer.on('error', reject);
    });
    return streamServerReady;
  }

  // cache coverage 與補建publication共用一個owner，batch/stream不能各自重抽已完成元件。
  function planIntake({ src, needsProxy, audio }, isStream, description = null, portable = null, previewPipeline = null) {
    const video = description?.video || null;
    const audioSources = Array.isArray(audio) ? audio : [];
    const hit = readCache(src, audioSources, needsProxy);
    const sourceKey = cacheKeyFor(src);
    if ((description && sourceKey !== description.sourceKey) || (portable && sourceKey !== portable.sourceKey)) {
      throw new Error('母素材在轉檔期間變更，請重新載入');
    }
    if (hit
      && coversAudioRequest(hit.meta, audioSources)
      && (!needsProxy || hit.meta.proxy)) {
      return { cached: true, dir: hit.dir, meta: hit.meta,
        streamGuard: () => captureStreamGuard(hit.dir, inspectedCacheOwners.get(hit), hit.meta.proxy) };
    }
    // 舊快取命中免全文驗證，但若 admission 等待期間失去元件，
    // 新 generation 仍必須具備完整母素材證據才能建立及發布。
    if (!validSourceContent(portable?.sourceContent)) return { needsSourceVerification: true };
    const copyCompleted = hit && !isDirWritable(hit.dir);
    const hitOwner = hit && inspectedCacheOwners.get(hit);
    if (hit) checkPublicationDirectory(hit.dir, hitOwner, portable.sourceContent, !!hit.sourceContent);
    const buildProxy = needsProxy && !hit?.meta.proxy;
    // A warm lookup can lose its files while awaiting admission. Do not create
    // or certify a replacement until the caller has described that source.
    if (buildProxy && options.describeVideo && !video) return { needsVideoDescription: true };
    const dir = hit && !copyCompleted ? hit.dir : writeCacheDir(src);
    if (description && cacheKeyFor(src) !== description.sourceKey) {
      throw new Error('母素材在轉檔期間變更，請重新載入');
    }
    const metaPath = path.join(dir, 'meta.json');
    const accepted = checkPublicationDirectory(dir, hit && !copyCompleted ? hitOwner : null, portable.sourceContent,
      hit && !copyCompleted && !!hit.sourceContent);
    const directoryOwner = accepted.owner, sourceRequired = !!accepted.current.sourceContent;
    // 初建也只寫私有 generation：不同程式共用 sidecar 時，失敗 writer
    // 不能覆寫另一個已提交 writer 的檔案。
    const outputDir = path.join(dir, 'generation-' + crypto.randomBytes(12).toString('hex'));
    fs.mkdirSync(outputDir);
    const outputOwner = cacheDirectoryOwner(outputDir);
    const verifyPublication = () => {
      const current = checkPublicationDirectory(dir, directoryOwner, portable.sourceContent, sourceRequired);
      if (!sameCacheDirectory(outputOwner, cacheDirectoryOwner(outputDir))) throw cacheDirectoryChanged();
      return current;
    };
    verifyPublication();
    const copies = new Map(), reusedSizes = new Map();
    const reuseFile = file => {
      if (!file) return file;
      const expectedSize = hit.files.find(entry => entry.file === file)?.expectedSize ?? fs.statSync(file).size;
      const target = copyCompleted ? path.join(outputDir, path.basename(file)) : file;
      reusedSizes.set(target, expectedSize);
      if (copyCompleted && !copies.has(file)) copies.set(file, target);
      return target;
    };
    const expected = flattenSourceChannels(audioSources);
    const sameAudioLayout = hit && hit.audioLayout.length === expected.length
      && expected.every((channel, index) => hit.audioLayout[index].sourceStream === channel.sourceStream
        && hit.audioLayout[index].sourceChannel === channel.sourceChannel);
    const reuseWave = !audioSources.length || (sameAudioLayout && hit.meta.wave);
    const reuseChannels = expected.map((_, index) => sameAudioLayout
      && hit.meta.channels.some(channel => channel.file === hit.audioLayout[index].file));
    const reuseAudio = reuseWave && reuseChannels.every(Boolean);
    const audioPlan = buildAudioIngestPlan(reuseAudio ? [] : audioSources);
    const channels = !audioSources.length ? (hit?.meta.channels || []).map(channel => ({ ...channel, file: reuseFile(channel.file) })) : expected.map((_, index) =>
      reuseChannels[index] ? { ...hit.audioLayout[index], file: reuseFile(hit.audioLayout[index].file) }
        : { ...audioPlan.channels[index], file: path.join(outputDir, audioPlan.channels[index].file) });
    const buildChannels = [];
    const channelMaps = [];
    audioPlan.channelMaps.forEach((pad, index) => {
      if (reuseChannels[index]) audioPlan.filters.push(`${pad}anullsink`);
      else { buildChannels.push(channels[index]); channelMaps.push(pad); }
    });
    if (reuseWave && audioPlan.waveLabel) audioPlan.filters.push(`${audioPlan.waveLabel}anullsink`);
    const proxy = reuseFile(hit?.meta.proxy) || (buildProxy ? path.join(outputDir, 'proxy.mp4') : null);
    const wave = reuseWave ? reuseFile(hit?.meta.wave || null) : (audioPlan.waveLabel ? path.join(outputDir, 'wave.wav') : null);
    const meta = { proxy, channels, wave };
    const args = buildIngestArgs({
      src,
      needsProxy: buildProxy,
      proxyPath: proxy,
      fc: audioPlan.filters,
      channels: buildChannels,
      chMaps: channelMaps,
      waveLabel: reuseWave ? null : audioPlan.waveLabel,
      wavePath: wave,
      encoder: buildProxy ? getEncoder() : 'libx264',
      pipeline: buildProxy ? previewPipeline : null,
      isStream,
      video,
    });
    let committed = false;
    let streamGuard = null;
    return {
      cached: false, dir, args, meta, buildProxy,
      readDirs: copyCompleted ? [hit.dir] : [],
      assertRetryOwner() {
        if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
        verifyPublication();
      },
      streamGuard() {
        if (streamGuard) return streamGuard;
        verifyPublication();
        if (buildProxy) {
          const fd = fs.openSync(proxy, 'wx');
          try { streamGuard = captureStreamGuard(dir, directoryOwner, proxy, fs.fstatSync(fd, { bigint: true })); }
          finally { fs.closeSync(fd); }
        } else {
          streamGuard = captureStreamGuard(dir, directoryOwner, proxy);
        }
        streamGuard();
        verifyPublication();
        return streamGuard;
      },
      prepare: copies.size ? async (owns = () => true) => {
        // 唯讀共享快取只缺部分元件時，非同步複用完成 bytes 到既有本機退路；
        // 原 Proxy 不動，也不能因無法補寫音訊便重新編碼影片。
        const verifySource = () => checkPublicationDirectory(hit.dir, hitOwner, portable.sourceContent, !!hit.sourceContent);
        for (const [source, destination] of copies) {
          if (closed || !owns()) throw new IngestSupersededError();
          verifySource();
          const file = await openCacheComponent(hit.dir, source);
          const controller = new AbortController();
          const timer = setInterval(() => { if (closed || !owns()) controller.abort(); }, 100);
          timer.unref?.();
          try {
            if (closed || !owns()) throw new IngestSupersededError();
            // 開檔可以讓出執行權；handle 自洽仍不足以替換入的另一份母素材作證。
            verifySource();
            const before = await file.stat();
            if (before.size !== reusedSizes.get(destination)) throw new Error('既有媒體快取在補建期間變更');
            await pipeline(file.createReadStream({ autoClose: true }),
              fs.createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal });
            const current = await openCacheComponent(hit.dir, source);
            try {
              const after = await current.stat();
              if (['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'].some(field => before[field] !== after[field])
                || (await fsp.stat(destination)).size !== before.size) throw new Error('既有媒體快取在補建期間變更');
            } finally { await current.close(); }
            verifySource();
          } catch (error) {
            if (closed || !owns()) throw new IngestSupersededError();
            throw error;
          } finally { clearInterval(timer); await file.close(); }
          if (closed || !owns()) throw new IngestSupersededError();
        }
        if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
      } : null,
      label: buildProxy ? `${audioPlan.channels.length ? '正在轉檔 Proxy 與分析音訊' : '正在轉檔 Proxy'}（${previewPipeline.label}）`
        : '正在分析音訊',
      commit() {
        if (closed) throw new IngestSupersededError();
        if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
        verifyPublication();
        if ([...reusedSizes].some(([file, size]) => fileState(file, size) !== 'complete')) {
          throw new Error('既有媒體快取在補建期間變更');
        }
        if (!metaValid(meta)) throw new Error('媒體轉檔沒有產生完整快取');
        writeMeta(metaPath, path.join(outputDir, 'cache-meta.json'), meta, portable.sourceContent, sourceKey, audioSources, verifyPublication);
        committed = true;
      },
      dispose() {
        if (committed) return true;
        // 失敗只收回自己建立的實體 generation；同名路徑可已被另一個 writer 接手。
        const quarantine = path.join(dir, '.subtool-discard-' + crypto.randomBytes(12).toString('hex'));
        let moved = false;
        try {
          if (!sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))
            || !sameCacheDirectory(outputOwner, cacheDirectoryOwner(outputDir))) return false;
          fs.renameSync(outputDir, quarantine);
          moved = true;
          if (!sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))
            || !sameCacheDirectory(outputOwner, cacheDirectoryOwner(quarantine))) return false;
          fs.rmSync(quarantine, { recursive: true, force: true });
          moved = false;
          return true;
        } catch (error) {}
        finally {
          if (moved) {
            try { if (!fs.existsSync(outputDir)) fs.renameSync(quarantine, outputDir); } catch (error) {}
          }
        }
        return false;
      },
    };
  }

  function protectPlan(plan, src) {
    const releases = [...new Set([plan.dir, ...(plan.readDirs || [])])].map(dir => protectCacheDir(dir, src));
    return () => { for (const release of releases) release(); };
  }

  function reportCacheHit(session) {
    reportProgress(session, { jobId: 'ingest', stage: 'cache-ready', label: '使用既有快取', done: true, outcome: 'success', pct: 100 });
  }

  function reportCompletion(session, jobId, label, error) {
    reportProgress(session, {
      jobId, label, done: true, outcome: error ? 'failed' : 'success',
      ...(error ? { errorCode: error.code || 'MEDIA_CACHE_FAILED', errorMsg: error.message || String(error) } : { pct: 100 }),
    });
  }

  function reportProgress(session, payload) {
    if (cancelled(session)) return;
    try {
      options.sendProgress?.(session.progressTarget, {
        ...payload,
        ...(session.owner?.sessionId !== undefined ? {
          sessionId: session.owner.sessionId, requestId: session.owner.requestId,
        } : {}),
      });
    } catch (ignored) {}
  }

  // 優先波形按本機或同一共享檔案的母素材證據重用完成片段，不參與 portable index/binding
  // 或 Proxy／逐聲道 publication。caller 永遠拿私有副本，可沿用原本的清理契約。
  async function waveform({ src, duration, audio = [], start = 0, length, ignoreCached = false }, session = {}) {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start) || start < 0 || start >= duration
      || (length !== undefined && (!Number.isFinite(length) || length <= 0 || length > 60))
      || (length === undefined && start !== 0)) throw new RangeError('波形範圍必須在來源內，片段不可超過 60 秒');
    if (typeof ignoreCached !== 'boolean') throw new TypeError('波形快取選項無效');
    const validAudio = list => Array.isArray(list) && list.length <= 256 && !list.some(stream => !stream || typeof stream !== 'object'
      || !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 64
      || (stream.timestampOffset !== undefined && !Number.isFinite(stream.timestampOffset)));
    if (!validAudio(audio)) throw new TypeError('波形來源音訊描述無效');
    const ensureCurrent = () => { if (closed || cancelled(session)) throw new IngestSupersededError(); };
    ensureCurrent();
    while (sourceCleanupTasks(src).length) await waitSourceCleanups(src);
    ensureCurrent();
    const sourceKey = cacheKeyFor(src), segmentDuration = Math.min(length ?? duration, duration - start);
    const segmentSamples = Math.max(1, Math.round(segmentDuration * 4000));
    if (!Number.isSafeInteger(segmentSamples)) throw new RangeError('波形片段長度無效');
    const check = () => {
      ensureCurrent();
      if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在波形讀取期間變更，請重新載入');
    };
    const progress = payload => reportProgress(session, { jobId: 'source-wave', stage: 'source-waveform',
      label: '優先產生波形', queued: false, start, length: segmentDuration, totalDuration: duration, ...payload });
    progress({ pct: start / duration * 100 });
    const hit = ignoreCached ? null : readCache(src, audio, false);
    check();
    if (hit?.meta.wave && sameAudioLayout(hit.audioLayout, flattenSourceChannels(audio))) {
      progress({ pct: 100, done: true, outcome: 'success', label: '波形已就緒' });
      ensureCurrent();
      return { wave: hit.meta.wave, channels: [], cached: true, temporary: false, start: 0, duration, complete: true, sourceKey };
    }
    // 主程序重用既有 probe owner；renderer 的舊描述不可決定換檔後的聲道或來源時鐘。
    if (options.describeAudio) {
      audio = await options.describeAudio(src);
      check();
      if (!validAudio(audio)) throw new TypeError('無法確認波形來源音訊描述');
    }
    const localWaveKey = crypto.createHash('sha256').update('strict-source-wave-v1\0' + sourceKey).digest('hex');
    // 共享證據仍含 NAS 檔案身分與完整時間戳；不把同樣取樣內容的另一份檔案當成同一來源。
    const sharedWaveKey = allowSidecarCache ? sharedSourceFingerprintSync(src) : null;
    const checkPreparedSource = () => {
      check();
      if (sharedWaveKey && sharedSourceFingerprintSync(src) !== sharedWaveKey)
        throw new Error('母素材的共享檔案身分在波形讀取期間變更，請重新載入');
    };
    checkPreparedSource();
    const localChunkSpec = { version: 1, sharedSourceKey: localWaveKey, start, length: segmentDuration, samples: segmentSamples,
      audio: audio.map(stream => ({ channels: stream.channels, timestampOffset: timestampOffset(stream) })) };
    const sharedChunkSpec = sharedWaveKey ? { ...localChunkSpec, sharedSourceKey: sharedWaveKey } : localChunkSpec;
    const chunkSpecFor = dir => isSidecarCandidate(src, dir) ? sharedChunkSpec : localChunkSpec;
    let cachedChunk = null;
    if (!ignoreCached) {
      const visited = new Set();
      const readChunk = dir => {
        const key = canonicalCachePath(dir);
        if (visited.has(key) || !canUseCacheCandidate(dir)) return null;
        visited.add(key);
        const sidecar = isSidecarCandidate(src, dir) ? sidecarAuthority(src) : null;
        if (isSidecarCandidate(src, dir) && !sidecar) return null;
        try {
          return readSourceWaveformChunk(dir, chunkSpecFor(dir), { verify: () => {
            ensureCurrent(); assertCleanupAncestors(path.join(dir, '.wave-cache-check'));
            if (sidecar) captureOutputAuthority(path.join(sidecar.requestedPath, '.sidecar-root-check'), sidecar);
          } });
        } catch (_) { /* 完成紀錄讀不到時直接解來源，不能把缺件當成可刪除。 */ }
        return null;
      };
      for (const dir of cacheCandidates(src, sourceKey)) {
        cachedChunk = readChunk(dir);
        if (cachedChunk) break;
      }
      // UNC／磁碟代號與另一台電腦可有不同 strict key；只在同一相鄰 sidecar 查共享檔案證據。
      if (!cachedChunk && sharedWaveKey) {
        const sidecar = sidecarAuthority(src), root = sidecarRoot(src);
        if (sidecar) {
          try {
            captureOutputAuthority(path.join(root, '.sidecar-root-check'), sidecar);
            for (const entry of readCleanupEntries(root)) {
              if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
              captureOutputAuthority(path.join(root, '.sidecar-root-check'), sidecar);
              cachedChunk = readChunk(path.join(root, entry.name));
              if (cachedChunk) break;
            }
            captureOutputAuthority(path.join(root, '.sidecar-root-check'), sidecar);
          } catch (_) { cachedChunk = null; /* 未知的共享目錄不授權重用，保留重新解碼退路。 */ }
        }
      }
      checkPreparedSource();
    }
    const seek = sourceClockSeek(start, audio[0]);
    const clocks = audio.map(stream => ({ ...stream, timestampOffset: timestampOffset(stream) + seek.seek - start }));
    const plan = buildAudioIngestPlan(clocks, { waveOnly: true });
    if (!plan.waveLabel) {
      progress({ pct: 100, done: true, outcome: 'success', label: '來源沒有音訊' });
      return { wave: null, channels: [], cached: false, temporary: false, start: 0, duration, complete: true, sourceKey };
    }
    const complete = start === 0 && segmentDuration >= duration;
    const file = options.createTempPath?.('source-wave.wav')
      || path.join(tempRoot, crypto.randomBytes(12).toString('hex') + '.source-wave.wav');
    const sourceWavePath = path.resolve(file);
    let sourceWave;
    try {
      sourceWave = temporaryOwnership.reserve(sourceWavePath);
    } catch (error) {
      if (error.code === 'TEMP_PATH_REUSED') throw error;
      try { options.forgetTemporaryFile?.(sourceWavePath); } catch (ignored) {}
      throw new Error('來源波形暫存目錄無法確認', { cause: error });
    }
    const authority = sourceWave.authority;
    const assertParent = () => {
      try { assertOutputAuthority(authority, sourceWavePath); }
      catch (cause) { throw Object.assign(new Error('來源波形暫存目錄身分已變更', { cause }), { code: 'SOURCE_WAVE_PARENT_CHANGED' }); }
    };
    let completedOwner, completedBytes, completedEvidence;
    const assertCompletedWave = wave => {
      assertParent(); assertTemporaryOwner(wave, completedOwner);
      const current = fs.lstatSync(wave, { bigint: true });
      if (completedEvidence && (current.size !== completedEvidence.size
        || current.mtimeNs !== completedEvidence.mtimeNs || current.ctimeNs !== completedEvidence.ctimeNs))
        throw new Error('已完成波形的內容在交接前變更');
    };
    try {
      const wave = await produceTemporaryFile(file, async (out, owner) => {
        completedOwner = owner;
        sourceWave.owner = owner;
        await withTemporaryDescriptor(out, owner, async (fd, verify) => {
          checkPreparedSource();
          // 時間式 atrim 在容器粗 timebase 與極短尾段可能裁出零 samples；
          // 先轉成最終取樣率，再以同一整數 sample 數補零與裁切。
          const filters = [...plan.filters, `${plan.waveLabel}aresample=4000,apad=whole_len=${segmentSamples},atrim=end_sample=${segmentSamples},asetpts=N/SR/TB[sourcewave]`];
          const args = ['-y', '-ss', String(seek.seek), '-i', src, '-vn', '-sn', '-dn',
            '-filter_complex', filters.join(';'), '-map', '[sourcewave]',
            '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', '-f', 'wav', 'fd:'];
          if (cachedChunk) fs.writeFileSync(fd, cachedChunk);
          else await ffmpegExecution.execute(args, { executionKind: 'direct', deferTerminal: true,
              outputDescriptor: fd,
              duration: segmentDuration, jobId: 'source-wave', label: '優先產生波形',
              onProcess: child => session.ownProcess?.(child),
              onProgress: payload => progress({ ...payload, pct: Number.isFinite(payload.pct)
                ? (start + segmentDuration * Math.max(0, Math.min(100, payload.pct)) / 100) / duration * 100 : null }),
            });
          checkPreparedSource();
          completedEvidence = verify();
          if (completedEvidence.size <= 0n) throw new Error('波形暫存缺少完整內容');
        });
      }, { assertParent, reservation: sourceWave });
      try {
        checkPreparedSource(); assertCompletedWave(wave);
        progress({ pct: (start + segmentDuration) / duration * 100, done: true, outcome: 'success',
          label: complete ? '波形已就緒' : '波形片段已備妥' });
        // 通知觀察者可同步換工作，也可在 microtask 更換來源或暫存路徑。
        await Promise.resolve();
        checkPreparedSource(); assertCompletedWave(wave);
        if (!cachedChunk) {
          // 重新開啟受 owner 保護的 descriptor，避免 FFmpeg 共用的 fd offset 影響讀取。
          await withTemporaryDescriptor(wave, completedOwner, (fd, verify) => {
            const size = verify().size;
            if (size > 0n && size <= BigInt(MAX_SOURCE_WAVEFORM_BYTES)) completedBytes = fs.readFileSync(fd);
            verify(); assertCompletedWave(wave);
          });
          checkPreparedSource(); assertCompletedWave(wave);
          if (completedBytes && validSourceWaveformPcm(completedBytes, segmentSamples)) {
            let unprotect = () => {};
            try {
              const dir = writeCacheDir(src), directoryOwner = cacheDirectoryOwner(dir);
              const sidecar = isSidecarCandidate(src, dir) ? sidecarAuthority(src) : null;
              if (isSidecarCandidate(src, dir) && !sidecar) throw cacheDirectoryChanged();
              unprotect = protectCacheDir(dir, src);
              const verify = () => {
                checkPreparedSource(); assertCompletedWave(wave);
                if (sidecar) captureOutputAuthority(path.join(sidecar.requestedPath, '.sidecar-root-check'), sidecar);
                assertCleanupAncestors(path.join(dir, '.wave-cache-check'));
                if (!sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))) throw cacheDirectoryChanged();
              };
              saveSourceWaveformChunk(dir, chunkSpecFor(dir), completedBytes, { verify });
            } catch (error) {
              // 快取是可重建的加速資料；寫入失敗仍可交付本次已完成的私有波形。
              checkPreparedSource(); assertCompletedWave(wave);
              try { options.log?.('[cache] source waveform chunk not saved:', error.code || error.message); } catch (_) {}
            } finally { unprotect(); }
          }
        }
        checkPreparedSource(); assertCompletedWave(wave);
      }
      catch (error) {
        // 等待交接時若目錄項已變更，只撤回清理登記，不刪除新物件。
        try {
          assertCompletedWave(wave);
          fs.unlinkSync(wave);
        } catch (ignored) {}
        try { options.forgetTemporaryFile?.(wave); } catch (ignored) {}
        throw error;
      }
      return { wave, channels: [], cached: !!cachedChunk, temporary: true, start, duration: segmentDuration, complete, sourceKey };
    } catch (error) {
      sourceWave.retired = true;
      progress({ done: true, outcome: 'failed', errorCode: error.code || 'SOURCE_WAVE_FAILED', errorMsg: error.message });
      throw error;
    } finally { sourceWave.writing = false; }
  }

  async function ingest(request, session = {}) {
    if (closed || cancelled(session)) throw new IngestSupersededError();
    while (sourceCleanupTasks(request.src).length) await waitSourceCleanups(request.src);
    if (closed || cancelled(session)) throw new IngestSupersededError();
    let portable = await preparePortableCache(request, session);
    let description = request.needsProxy && options.describeVideo ? await describeMissingProxy(request.src, request.audio) : null;
    while (sourceCleanupTasks(request.src).length) await waitSourceCleanups(request.src);
    if (closed || cancelled(session)) throw new IngestSupersededError();
    let pipelines = previewPipelineCandidates({ encoder: getEncoder(), video: description?.video, needsProxy: request.needsProxy });
    let index = 0;
    let plan = planIntake(request, false, description, portable, pipelines[index]);
    if (plan.needsSourceVerification) {
      portable = await preparePortableCache(request, session, true);
      while (sourceCleanupTasks(request.src).length) await waitSourceCleanups(request.src);
      if (closed || cancelled(session)) throw new IngestSupersededError();
      plan = planIntake(request, false, description, portable, pipelines[index]);
    }
    if (plan.needsVideoDescription) {
      description = await describeMissingProxy(request.src, request.audio, true);
      while (sourceCleanupTasks(request.src).length) await waitSourceCleanups(request.src);
      if (closed || cancelled(session)) throw new IngestSupersededError();
      pipelines = previewPipelineCandidates({ encoder: getEncoder(), video: description?.video, needsProxy: request.needsProxy });
      plan = planIntake(request, false, description, portable, pipelines[index]);
    }
    if (plan.cached) {
      reportCacheHit(session);
      return Object.assign({ cached: true }, plan.meta);
    }

    let unprotect = protectPlan(plan, request.src);
    try {
      await delay(1000);
      if (cancelled(session)) throw new IngestSupersededError();
      for (;;) {
        if (plan.prepare) await plan.prepare(() => !cancelled(session));
        if (closed || cancelled(session)) throw new IngestSupersededError();
        let stderr = '';
        try {
          await ffmpegExecution.execute(plan.args, {
            executionKind: 'direct', deferTerminal: true,
            onProgress: payload => reportProgress(session, { ...payload, stage: 'transcoding' }),
            onStderr: text => { stderr = (stderr + text).slice(-16000); },
            duration: request.duration, jobId: 'ingest', label: plan.label,
            onProcess: process => session.ownProcess?.(process),
            shouldSend: () => !cancelled(session),
          });
          break;
        } catch (error) {
          if (closed || cancelled(session)) throw new IngestSupersededError();
          if (!plan.buildProxy || index + 1 >= pipelines.length || !previewFallbackAllowed(pipelines[index], error, stderr)) throw error;
          plan.assertRetryOwner();
          if (!plan.dispose()) throw new Error('無法安全清理失敗的媒體轉檔，已保留原資料');
          unprotect();
          unprotect = () => {};
          index++;
          const next = planIntake(request, false, description, portable, pipelines[index]);
          if (next.cached || next.needsVideoDescription) throw new Error('媒體快取在重試期間變更，請重新載入');
          plan = next;
          unprotect = protectPlan(plan, request.src);
        }
      }
      if (closed || cancelled(session)) throw new IngestSupersededError();
      plan.commit();
      reportCompletion(session, 'ingest', plan.label);
      return Object.assign({ cached: false }, plan.meta);
    } catch (error) {
      reportCompletion(session, 'ingest', plan.label, error);
      throw error;
    } finally {
      try { plan.dispose(); } finally { unprotect(); }
    }
  }

  async function stream({ src, duration, audio }, session = {}) {
    const port = await ensureStreamServer();
    if (closed || cancelled(session)) return { response: null, completion: null };
    while (sourceCleanupTasks(src).length) await waitSourceCleanups(src);
    if (closed || cancelled(session)) return { response: null, completion: null };
    let portable;
    try { portable = await preparePortableCache({ src, duration, audio, needsProxy: true }, session); }
    catch (error) {
      if (closed || cancelled(session)) return { response: null, completion: null };
      throw error;
    }
    let description = options.describeVideo ? await describeMissingProxy(src, audio) : null;
    while (sourceCleanupTasks(src).length) await waitSourceCleanups(src);
    if (closed || cancelled(session)) return { response: null, completion: null };
    const request = { src, needsProxy: true, audio };
    let pipelines = previewPipelineCandidates({ encoder: getEncoder(), video: description?.video, needsProxy: true });
    let index = 0;
    let plan = planIntake(request, true, description, portable, pipelines[index]);
    if (plan.needsSourceVerification) {
      try { portable = await preparePortableCache(request, session, true); }
      catch (error) {
        if (closed || cancelled(session)) return { response: null, completion: null };
        throw error;
      }
      while (sourceCleanupTasks(src).length) await waitSourceCleanups(src);
      if (closed || cancelled(session)) return { response: null, completion: null };
      plan = planIntake(request, true, description, portable, pipelines[index]);
    }
    if (plan.needsVideoDescription) {
      description = await describeMissingProxy(src, audio, true);
      while (sourceCleanupTasks(src).length) await waitSourceCleanups(src);
      if (closed || cancelled(session)) return { response: null, completion: null };
      pipelines = previewPipelineCandidates({ encoder: getEncoder(), video: description?.video, needsProxy: true });
      plan = planIntake(request, true, description, portable, pipelines[index]);
    }
    const verifySource = () => {
      let current;
      try { current = cacheKeyFor(src); } catch (_) {}
      if (current !== portable.sourceKey) {
        const error = new Error('母素材在串流準備期間變更，請重新載入');
        error.code = 'SOURCE_CHANGED';
        throw error;
      }
    };
    if (plan.cached) {
      if (closed || cancelled(session)) return { response: null, completion: null };
      const verifySourceOwner = plan.streamGuard();
      verifySource();
      reportCacheHit(session);
      if (closed || cancelled(session)) return { response: null, completion: null };
      verifySource();
      const id = createStreamId('c-');
      streamJobs.set(id, {
        filePath: plan.meta.proxy, done: true, error: null,
        owner: session.owner, verifySourceOwner,
        releaseCache: protectCacheDir(plan.dir, src),
      });
      return Object.assign({
        cached: true,
        streamUrl: `http://127.0.0.1:${port}/${id}`,
        streamLeaseId: id,
        sourceKey: portable.sourceKey,
      }, plan.meta);
    }

    const id = createStreamId('l-');
    // HTTP reader 與 writer 各自持有引用；writer 完成不代表播放端已釋放。
    let streamGuard = null;
    const job = { filePath: plan.meta.proxy, done: false, error: null, owner: session.owner,
      verifySourceOwner: observed => { if (!streamGuard) throw cacheDirectoryChanged(); streamGuard(observed); },
      releaseCache: protectCacheDir(plan.dir, src) };
    streamJobs.set(id, job);
    // close/cancel 也可在等待可播 bytes 期間收回 registry；URL 只有仍持有
    // 同一 lease 才能交給 renderer，不能以 writer 後來完成重新取得資格。
    const ownsStream = () => !closed && streamJobs.get(id) === job && !cancelled(session);
    if (cancelled(session)) {
      job.done = true;
      job.error = '媒體轉檔已被較新的載入取代';
      releaseStream(id);
      plan.dispose();
      return { response: null, completion: null };
    }
    let unprotect = protectPlan(plan, src);
    let writer = null;
    let readinessError = null;
    let preparationReady = false;
    let published = false;
    let attemptEpoch = 0;
    const stopUnreadyWriter = () => { try { writer?.kill?.(); } catch (error) {} };
    const runAttempts = async () => {
      for (;;) {
        attemptEpoch++;
        preparationReady = false;
        if (plan.prepare) await plan.prepare(() => ownsStream());
        if (!ownsStream()) throw new IngestSupersededError();
        streamGuard = plan.streamGuard();
        preparationReady = true;
        let stderr = '';
        try {
          await ffmpegExecution.execute(plan.args, {
            executionKind: 'direct', deferTerminal: true,
            onProgress: payload => reportProgress(session, { ...payload, stage: 'transcoding' }),
            onStderr: text => { stderr = (stderr + text).slice(-16000); },
            duration, jobId: id, label: plan.label,
            onProcess: process => { writer = process; session.ownProcess?.(process); if (readinessError) stopUnreadyWriter(); },
            shouldSend: () => !cancelled(session),
          });
          return;
        } catch (error) {
          if (!ownsStream()) throw new IngestSupersededError();
          if (published || job.requests?.size || readinessError || !plan.buildProxy || index + 1 >= pipelines.length
            || !previewFallbackAllowed(pipelines[index], error, stderr)) throw error;
          // Revoke outstanding stat results before any await or path change.
          attemptEpoch++;
          preparationReady = false;
          streamGuard = null;
          plan.assertRetryOwner();
          if (!plan.dispose()) throw new Error('無法安全清理失敗的媒體轉檔，已保留原資料');
          unprotect();
          unprotect = () => {};
          index++;
          const next = planIntake(request, true, description, portable, pipelines[index]);
          if (next.cached || next.needsVideoDescription) throw new Error('媒體快取在重試期間變更，請重新載入');
          plan = next;
          unprotect = protectPlan(plan, src);
          job.releaseCache();
          job.releaseCache = protectCacheDir(plan.dir, src);
          job.filePath = plan.meta.proxy;
        }
      }
    };
    const completion = runAttempts().then(() => {
      job.done = true;
      if (readinessError) {
        reportCompletion(session, id, plan.label, readinessError);
      } else if (!cancelled(session)) {
        plan.commit();
        reportCompletion(session, id, plan.label);
      }
    }).catch(error => {
      job.done = true;
      const failure = readinessError && error?.code === 'ABORT_ERR' ? readinessError : error;
      job.error = failure.message;
      reportCompletion(session, id, plan.label, failure);
    }).finally(() => { try { plan.dispose(); } finally { unprotect(); } });

    const startedAt = now();
    let ready = false;
    try {
      /* 可播門檻的 300ms 輪詢也可能打到 SMB sidecar，因此只用 fsp.stat。 */
      while (now() - startedAt < 60000) {
        if (!ownsStream()) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
        if (!preparationReady) {
          // 即使測試注入零延遲，仍讓出 I/O 事件迴圈，避免餓死準備中的複製。
          try { await fsp.stat(plan.meta.proxy); } catch (error) {}
          await delay(300);
          continue;
        }
        const observedPlan = plan, observedEpoch = attemptEpoch;
        const observedGuard = streamGuard;
        let size = 0;
        let stat;
        try { observedGuard(); stat = await fsp.stat(observedPlan.meta.proxy, { bigint: true }); } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
        if (!ownsStream()) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
        if (observedPlan !== plan || observedEpoch !== attemptEpoch) continue;
        observedGuard(stat);
        if (stat) size = stat.size;
        if (preparationReady && (size >= 131072 || (job.done && size > 0))) { ready = true; break; }
        await delay(300);
        if (!ownsStream()) return { response: null, completion };
      }

      if (!ready) {
        readinessError = new Error('媒體串流在 60 秒內尚未產生可播放的 Proxy，請重新載入');
        readinessError.code = 'STREAM_READINESS_TIMEOUT';
        job.error = readinessError.message;
        stopUnreadyWriter();
        throw readinessError;
      }
      verifySource();
      published = true;
      return {
        response: {
          cached: false,
          streamUrl: `http://127.0.0.1:${port}/${id}`,
          streamLeaseId: id,
          sourceKey: portable.sourceKey,
          proxy: plan.meta.proxy,
          channels: plan.meta.channels,
          wave: plan.meta.wave,
          ingestJobId: id,
        },
        completion,
      };
    } catch (error) {
      // 未交付的exception也必須等writer settle，不能讓coordinator提前准入下一個。
      if (!readinessError && ['CACHE_DIRECTORY_CHANGED', 'CACHE_PATH_ESCAPE', 'SOURCE_CHANGED'].includes(error.code)) {
        readinessError = error;
        stopUnreadyWriter();
      }
      await completion;
      if (job.error && job.error !== error.message) error.message += `：${job.error}`;
      throw error;
    } finally {
      if (!published) releaseStream(id);
    }
  }

  function close() {
    closed = true;
    runtimeGeneration++;
    if (closeOperation) return closeOperation;
    const operation = closeRuntime();
    closeOperation = operation;
    operation.then(() => { if (closeOperation === operation) closeOperation = null; },
      () => { if (closeOperation === operation) closeOperation = null; });
    return operation;
  }

  async function closeRuntime() {
    drainingCleanup = true;
    try {
      await Promise.allSettled([...cleanupTasks.keys()]);
      const cleanupCloseResults = await Promise.allSettled([...cleanupHandles].map(async handle=>{
        await handle.close();cleanupHandles.delete(handle);
      }));
      const cleanupCloseFailure = cleanupCloseResults.find(result=>result.status==='rejected');
      if (cleanupCloseFailure) throw cleanupCloseFailure.reason;
    } finally { drainingCleanup = false; }
    await Promise.allSettled([...portableHashes]);
    if (!streamServer) { await Promise.all([...drainingServers].map(drainServer)); return; }
    const server = streamServer;
    await streamServerReady.catch(() => {});
    streamServer = null;
    streamServerReady = null;
    streamPort = null;
    for (const id of streamJobs.keys()) releaseStream(id);
    streamJobs.clear();
    const entry = { server, done: false, started: false, completion: null };
    entry.completion = new Promise(resolve => server.once('close', () => { entry.done = true; resolve(); }));
    drainingServers.add(entry);
    await drainServer(entry);
  }

  async function drainServer(entry) {
    if (!entry.done) {
      if (!entry.started) { entry.server.close(); entry.started = true; }
      entry.server.closeAllConnections?.();
      await entry.completion;
    }
    drainingServers.delete(entry);
  }

  async function resume() {
    // Never revive leases from the closed generation. Finish closing any old
    // listener before a later request can create a fresh server and URLs.
    const generation = runtimeGeneration;
    if (closeOperation) await closeOperation.catch(() => {});
    // A newer close owns the runtime and must not be undone by an older resume.
    if (runtimeGeneration !== generation) return false;
    // A failed cleanup close left a tracked handle. Retry the complete close
    // before accepting work; a second failure keeps the runtime closed.
    if (cleanupHandles.size) {
      const retry = close();
      const retryGeneration = runtimeGeneration;
      await retry;
      if (runtimeGeneration !== retryGeneration) return false;
    }
    const resumeGeneration = runtimeGeneration;
    await Promise.all([...drainingServers].map(drainServer));
    if (closeOperation || runtimeGeneration !== resumeGeneration) return false;
    closed = false;
    return true;
  }

  function releaseStream(streamLeaseId, owner) {
    if (typeof streamLeaseId !== 'string') return false;
    const job = streamJobs.get(streamLeaseId);
    if (!job) return false;
    if (owner && !ownsMediaIntake(job.owner, owner)) return false;
    for (const cancel of job.requests || []) cancel();
    job.releaseCache?.();
    return streamJobs.delete(streamLeaseId);
  }

  function cancel(scope) {
    // writer 由 coordinator 終止並等待 close；這裡收回已交付的 HTTP reader lease。
    let count = 0;
    for (const [id, job] of streamJobs) {
      if (ownsMediaIntake(job.owner, scope) && releaseStream(id)) count++;
    }
    return count;
  }

  return Object.freeze({
    cacheInfo,
    cancel,
    cleanOrphans,
    cleanupGeneratedFile,
    registerCleanupRoot,
    hasUnsafeTemporaryFiles,
    hasUnsafeSourceWaveFiles: hasUnsafeTemporaryFiles,
    clearAll,
    close,
    resume,
    ingest: withSourceLease(ingest, undefined, true),
    inspectCache,
    isDirWritable,
    isPreviewCacheMedia,
    isOwnedTemporary,
    isSourceWaveTemporary: isOwnedTemporary,
    assertTemporaryOutput,
    withTemporaryDescriptor,
    produceTemporaryFile,
    releaseStream,
    sourceKey: withSourceLease(cacheKeyForAsync, src => src),
    stream: withSourceLease(stream, undefined, true),
    waveform: withSourceLease(waveform, undefined, true),
  });
}

/**
 * 轉檔被較新工作取代之自訂錯誤類型。
 */
class IngestSupersededError extends Error {
  constructor() {
    super('媒體轉檔已被較新的載入取代');
    this.name = 'IngestSupersededError';
    this.code = 'INGEST_SUPERSEDED';
  }
}

/**
 * 建立媒體轉檔排程協調器。
 * 
 * @param {object} [options]
 * @param {Function} [options.killProcess] 終止行程函式注入
 */
function createMediaIngestCoordinator({ killProcess } = {}) {
  const kill = typeof killProcess === 'function'
    ? killProcess
    : process => { try { process?.kill?.(); } catch (error) {} };

  const pending = [];
  // sender 生命週期內保留撤銷資格，防止取消 IPC 先於遲到 ingest 到達。
  const revoked = new WeakMap();
  let active = null;
  let draining = false;
  let closing = false;
  let drainFinished = Promise.resolve();
  let resumeWhenIdle = false;

  const cancel = lease => {
    if (!lease || lease.cancelled) return;
    lease.cancelled = true;
    if (lease.process) kill(lease.process);
  };

  const cancelMatching = matches => {
    let count = 0;
    for (let index = pending.length - 1; index >= 0; index--) {
      if (!matches(pending[index].owner)) continue;
      pending.splice(index, 1)[0].reject(new IngestSupersededError());
      count++;
    }
    if (!active || !matches(active.owner)) return { count, completion: Promise.resolve() };
    count++;
    const completion = active.finished;
    cancel(active);
    return { count, completion };
  };

  const asWorkResult = value => {
    if (value && typeof value === 'object'
      && (Object.prototype.hasOwnProperty.call(value, 'response')
        || Object.prototype.hasOwnProperty.call(value, 'completion'))) {
      return { response: value.response, completion: value.completion };
    }
    return { response: value, completion: null };
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    let finishDrain;
    drainFinished = new Promise(resolve => { finishDrain = resolve; });
    try {
      while (pending.length) {
        const ticket = pending.shift();
        let finishLease;
        const lease = {
          owner: ticket.owner, cancelled: false, process: null,
          finished: new Promise(resolve => { finishLease = resolve; }),
        };
        active = lease;
        try {
          const value = await ticket.work({
            setProcess(process) {
              lease.process = process || null;
              if (lease.cancelled && lease.process) kill(lease.process);
            },
            isCancelled: () => lease.cancelled,
          });
          const { response, completion } = asWorkResult(value);

          // 若等待期間已被取代，拒絕 resolve 舊回應
          if (lease.cancelled) {
            ticket.reject(new IngestSupersededError());
          } else {
            ticket.resolve(response);
          }

          // 背景寫入完成前，保持通道鎖定以確保快取寫入順序
          if (completion) {
            await Promise.resolve(completion).catch(() => undefined);
          }
        } catch (error) {
          ticket.reject(lease.cancelled ? new IngestSupersededError() : error);
        } finally {
          if (active === lease) active = null;
          finishLease();
        }
      }
    } finally {
      draining = false;
      if (resumeWhenIdle && !pending.length) closing = false;
      finishDrain();
      if (pending.length) void drain();
    }
  };

  const submit = (work, owner, { replace = false } = {}) => new Promise((resolve, reject) => {
    if (closing) { reject(new IngestSupersededError()); return; }
    const revokedSession = owner?.sender && revoked.get(owner.sender)?.get(owner.sessionId);
    if (revokedSession && (revokedSession.all || revokedSession.requests.has(owner.requestId))) {
      reject(new IngestSupersededError()); return;
    }
    if (typeof work !== 'function') {
      reject(new TypeError('media ingest work must be a function'));
      return;
    }
    if (replace) {
      cancelMatching(candidate => owner?.sender ? ownsMediaIntake(candidate, { sender: owner.sender }) : true);
    }
    const ticket = { work, resolve, reject, owner: owner ? { ...owner } : null };
    if (replace) pending.unshift(ticket);
    else pending.push(ticket);
    void drain();
  });

  return Object.freeze({
    /** 有 owner 時只取代同 sender 的工作；內部無 owner 呼叫保留全域取代語意。 */
    replace: (work, owner) => submit(work, owner, { replace: true }),
    /** 將新轉檔工作依序加入排隊佇列 */
    enqueue: (work, owner) => submit(work, owner),
    /** 只取消原 sender／session／request；完成代表 native writer 與快取收尾已結束。 */
    cancel(scope) {
      if (scope.sender && scope.sessionId !== undefined) {
        let sessions = revoked.get(scope.sender);
        if (!sessions) { sessions = new Map(); revoked.set(scope.sender, sessions); }
        let session = sessions.get(scope.sessionId);
        if (!session) { session = { all: false, requests: new Set() }; sessions.set(scope.sessionId, session); }
        if (scope.requestId === undefined) session.all = true;
        else session.requests.add(scope.requestId);
      }
      const { count, completion } = cancelMatching(owner => ownsMediaIntake(owner, scope));
      return completion.then(() => count);
    },
    cancelAllAndWait() {
      closing = true;
      resumeWhenIdle = false;
      while (pending.length) pending.shift().reject(new IngestSupersededError());
      cancel(active);
      return drainFinished;
    },
    resume() {
      resumeWhenIdle = true;
      if (draining) return false;
      closing = false;
      return true;
    },
  });
}

module.exports = {
  cacheKeyFor,
  createMediaIntakeRuntime,
  createMediaIngestCoordinator,
  IngestSupersededError,
  buildAudioIngestPlan,
  sourceAudioClockFilter,
  flattenSourceChannels,
  channelFileName,
};

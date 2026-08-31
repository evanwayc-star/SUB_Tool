'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { buildAudioIngestPlan } = require('./channel-layout');
const { buildIngestArgs } = require('./ffmpeg-pipeline-builder');

function createMediaIntakeRuntime(options = {}) {
  const fileAuthority = options.fileAuthority;
  const ffmpegExecution = options.ffmpegExecution;
  const tempRoot = options.tempRoot;
  const allowSidecarCache = options.allowSidecarCache !== false;
  const getEncoder = options.getEncoder || (() => 'libx264');
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const createStreamId = options.createStreamId
    || (prefix => prefix + crypto.randomBytes(12).toString('hex'));
  let streamServer = null;
  let streamPort = null;
  const streamJobs = new Map();
  const cacheRoot = () => {
    const value = typeof options.cacheRoot === 'function' ? options.cacheRoot() : options.cacheRoot;
    return value || tempRoot;
  };

  function cacheKeyFor(src) {
    try {
      const stat = fs.statSync(src);
      const readLength = Math.min(1024 * 1024, stat.size);
      const hash = crypto.createHash('sha1').update(path.basename(src) + '|' + stat.size + '|');
      if (readLength > 0) {
        const fd = fs.openSync(src, 'r');
        try {
          const buffer = Buffer.alloc(readLength);
          fs.readSync(fd, buffer, 0, readLength, 0);
          hash.update(buffer);
        } finally {
          fs.closeSync(fd);
        }
      }
      return hash.digest('hex').slice(0, 16);
    } catch (error) {
      return crypto.createHash('sha1').update(path.basename(String(src))).digest('hex').slice(0, 16);
    }
  }

  function cacheCandidates(src) {
    const key = cacheKeyFor(src);
    const candidates = [];
    if (allowSidecarCache) {
      try {
        const sourceDir = path.dirname(src);
        if (sourceDir && sourceDir !== '.') candidates.push(path.join(sourceDir, '.subtool_Cache', key));
      } catch (error) {}
    }
    candidates.push(path.join(cacheRoot(), key));
    return candidates;
  }

  function resolveMeta(raw, dir) {
    const resolveFile = file => file ? path.join(dir, path.basename(file)) : file;
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

  function metaToStore(meta) {
    const basename = file => file ? path.basename(file) : file;
    return {
      proxy: basename(meta.proxy),
      wave: basename(meta.wave),
      channels: (meta.channels || []).map(channel => ({
        label: channel.label,
        file: basename(channel.file),
        sourceStream: Number.isInteger(channel.sourceStream) ? channel.sourceStream : null,
        sourceChannel: Number.isInteger(channel.sourceChannel) ? channel.sourceChannel : null,
      })),
    };
  }

  function hasRoutingMetadata(meta) {
    return (meta.channels || []).every(channel =>
      Number.isInteger(channel.sourceStream) && channel.sourceStream >= 0
      && Number.isInteger(channel.sourceChannel) && channel.sourceChannel >= 0);
  }

  function metaValid(meta) {
    return (!meta.proxy || fs.existsSync(meta.proxy))
      && (meta.channels || []).every(channel => fs.existsSync(channel.file))
      && (!meta.wave || fs.existsSync(meta.wave));
  }

  function writeMeta(metaPath, meta) {
    try {
      const temporaryPath = metaPath + '.tmp';
      fs.writeFileSync(temporaryPath, JSON.stringify(metaToStore(meta)));
      fs.renameSync(temporaryPath, metaPath);
    } catch (error) {}
  }

  function readCache(src) {
    for (const dir of cacheCandidates(src)) {
      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir);
        if (!metaValid(meta)) continue;
        fileAuthority.grantManagedCacheDirectory(dir);
        return { dir, meta, routingMetadataComplete: hasRoutingMetadata(meta) };
      } catch (error) {}
    }
    return null;
  }

  function isDirWritable(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const testPath = path.join(dir, '.wtest_' + process.pid);
      fs.writeFileSync(testPath, 'x');
      fs.unlinkSync(testPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  function writeCacheDir(src) {
    for (const dir of cacheCandidates(src)) {
      if (!isDirWritable(dir)) continue;
      fileAuthority.grantManagedCacheDirectory(dir);
      return dir;
    }
    const fallback = path.join(cacheRoot(), cacheKeyFor(src));
    fileAuthority.grantManagedCacheDirectory(fallback);
    return fallback;
  }

  function dirSize(dir) {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSize(entryPath);
        else {
          try { total += fs.statSync(entryPath).size; } catch (error) {}
        }
      }
    } catch (error) {}
    return total;
  }

  function cacheInfo() {
    const root = cacheRoot();
    let folders = 0;
    let bytes = 0;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        folders++;
        bytes += dirSize(path.join(root, entry.name));
      }
    } catch (error) {}
    return { root, folders, bytes };
  }

  function cleanOrphans() {
    const root = cacheRoot();
    let removed = 0;
    let bytes = 0;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const metaPath = path.join(dir, 'meta.json');
        let remove = false;
        if (!fs.existsSync(metaPath)) remove = true;
        else {
          try {
            const meta = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir);
            if (!metaValid(meta)) remove = true;
          } catch (error) {
            remove = false;
          }
        }
        if (!remove) continue;
        const size = dirSize(dir);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
          bytes += size;
        } catch (error) {}
      }
    } catch (error) {}
    return { removed, bytes };
  }

  function clearAll(currentSrc) {
    const root = cacheRoot();
    let bytes = dirSize(root);
    try {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
    } catch (error) {}
    if (currentSrc && fileAuthority.canRead(currentSrc)) {
      try {
        const sidecarDir = path.join(
          path.dirname(currentSrc),
          '.subtool_Cache',
          cacheKeyFor(currentSrc),
        );
        if (fs.existsSync(sidecarDir)) {
          bytes += dirSize(sidecarDir);
          fs.rmSync(sidecarDir, { recursive: true, force: true });
        }
      } catch (error) {}
    } else if (currentSrc) {
      options.log?.('[sec] cache clear source blocked:', currentSrc);
    }
    return { bytes };
  }

  function cleanupGeneratedFile(file) {
    let target;
    try { target = path.resolve(file); } catch (error) { return false; }
    if (!fileAuthority.canManageInternalFile(target)) {
      options.log?.('[sec] ffmpeg:cleanup blocked (outside cache):', file);
      return false;
    }
    try {
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
    if (basename !== 'proxy.mp4' && !/^ch\d+\.m4a$/i.test(basename)) return false;
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

  async function ensureStreamServer() {
    if (streamServer) return streamPort;
    return new Promise((resolve, reject) => {
      streamServer = http.createServer((request, response) => {
        const id = decodeURIComponent(request.url.slice(1).split('?')[0]);
        const job = streamJobs.get(id);
        if (!job?.filePath) {
          response.writeHead(404);
          response.end();
          return;
        }
        const range = request.headers.range;
        if (!range) {
          response.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          const reader = fs.createReadStream(job.filePath);
          reader.pipe(response, { end: false });
          reader.on('end', () => {
            if (job.done) {
              response.end();
              return;
            }
            const poll = () => {
              if (job.done || job.error) response.end();
              else setTimeout(poll, 400);
            };
            poll();
          });
          request.on('close', () => reader.destroy());
          return;
        }
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (!match) {
          response.writeHead(400);
          response.end();
          return;
        }
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : undefined;
        /* Proxy 多半在素材旁的 .subtool_Cache；SMB 上的 Range 輪詢必須用
           非同步 stat，否則每 500ms 會鎖住 Electron 主執行緒與原生檔案對話框。 */
        const tryRange = async attempt => {
          let size = 0;
          try { size = (await fsp.stat(job.filePath)).size; } catch (error) {}
          if (size <= start && !job.done && attempt < 120) {
            setTimeout(() => { void tryRange(attempt + 1); }, 500);
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
          fs.createReadStream(job.filePath, { start, end }).pipe(response);
        };
        void tryRange(0).catch(error => {
          options.log?.('[HTTP] range 供應失敗：', error);
          try {
            if (!response.headersSent) {
              response.writeHead(500);
              response.end();
            }
          } catch (ignored) {}
        });
      });
      streamServer.listen(0, '127.0.0.1', () => {
        streamPort = streamServer.address().port;
        resolve(streamPort);
      });
      streamServer.on('error', reject);
    });
  }

  async function ingest({ src, duration, needsProxy, audio }, session = {}) {
    const audioSources = Array.isArray(audio) ? audio : [];
    const ingestLabel = needsProxy && audioSources.length
      ? '正在轉檔 Proxy 與分析音訊'
      : (needsProxy ? '正在轉檔 Proxy' : '正在分析音訊');
    const hit = readCache(src);
    if (hit
      && (!audioSources.length || hit.routingMetadataComplete)
      && (!needsProxy || (hit.meta?.proxy && fs.existsSync(hit.meta.proxy)))) {
      options.sendProgress?.(session.progressTarget, {
        jobId: 'ingest', label: '使用既有快取', pct: 100, done: true,
      });
      return Object.assign({ cached: true }, hit.meta);
    }

    const dir = writeCacheDir(src);
    const metaPath = path.join(dir, 'meta.json');
    fs.mkdirSync(dir, { recursive: true });
    const audioPlan = buildAudioIngestPlan(audioSources);
    const channels = audioPlan.channels.map(channel => ({ ...channel, file: path.join(dir, channel.file) }));
    const proxy = needsProxy ? path.join(dir, 'proxy.mp4') : null;
    const wave = audioPlan.waveLabel ? path.join(dir, 'wave.wav') : null;
    const args = buildIngestArgs({
      src,
      needsProxy,
      proxyPath: proxy,
      fc: audioPlan.filters,
      channels,
      chMaps: audioPlan.channelMaps,
      waveLabel: audioPlan.waveLabel,
      wavePath: wave,
      encoder: getEncoder(),
      isStream: false,
    });

    await delay(1000);
    if (cancelled(session)) throw new Error('媒體轉檔已被較新的載入取代');
    await ffmpegExecution.execute(args, {
      sender: session.progressTarget,
      duration,
      jobId: 'ingest',
      label: ingestLabel,
      onProcess: process => session.ownProcess?.(process),
      shouldSend: () => !cancelled(session),
    });
    if (cancelled(session)) throw new Error('媒體轉檔已被較新的載入取代');
    const meta = { proxy, channels, wave };
    writeMeta(metaPath, meta);
    return Object.assign({ cached: false }, meta);
  }

  async function stream({ src, duration, audio }, session = {}) {
    const audioSources = Array.isArray(audio) ? audio : [];
    const port = await ensureStreamServer();
    if (cancelled(session)) return { response: null, completion: null };
    const hit = readCache(src);
    if (hit
      && (!audioSources.length || hit.routingMetadataComplete)
      && hit.meta.proxy
      && fs.existsSync(hit.meta.proxy)) {
      options.sendProgress?.(session.progressTarget, {
        jobId: 'ingest', label: '使用既有快取', pct: 100, done: true,
      });
      const id = createStreamId('c-');
      streamJobs.set(id, { filePath: hit.meta.proxy, done: true, error: null });
      return Object.assign({
        cached: true,
        streamUrl: `http://127.0.0.1:${port}/${id}`,
        streamLeaseId: id,
      }, hit.meta);
    }

    const dir = writeCacheDir(src);
    const metaPath = path.join(dir, 'meta.json');
    fs.mkdirSync(dir, { recursive: true });
    const audioPlan = buildAudioIngestPlan(audioSources);
    const channels = audioPlan.channels.map(channel => ({ ...channel, file: path.join(dir, channel.file) }));
    const proxy = path.join(dir, 'proxy.mp4');
    const wave = audioPlan.waveLabel ? path.join(dir, 'wave.wav') : null;
    const args = buildIngestArgs({
      src,
      needsProxy: true,
      proxyPath: proxy,
      fc: audioPlan.filters,
      channels,
      chMaps: audioPlan.channelMaps,
      waveLabel: audioPlan.waveLabel,
      wavePath: wave,
      encoder: getEncoder(),
      isStream: true,
    });

    const id = createStreamId('l-');
    const job = { filePath: proxy, done: false, error: null };
    streamJobs.set(id, job);
    if (cancelled(session)) {
      job.done = true;
      job.error = '媒體轉檔已被較新的載入取代';
      streamJobs.delete(id);
      return { response: null, completion: null };
    }
    const completion = ffmpegExecution.execute(args, {
      sender: session.progressTarget,
      duration,
      jobId: id,
      label: '正在背景轉檔 Proxy 與分析音訊',
      onProcess: process => session.ownProcess?.(process),
      shouldSend: () => !cancelled(session),
    }).then(() => {
      job.done = true;
      if (!cancelled(session)) writeMeta(metaPath, { proxy, channels, wave });
    }).catch(error => {
      job.done = true;
      job.error = error.message;
    });

    const startedAt = Date.now();
    /* 可播門檻的 300ms 輪詢也可能打到 SMB sidecar，因此只用 fsp.stat。 */
    while (Date.now() - startedAt < 60000) {
      if (cancelled(session)) {
        streamJobs.delete(id);
        return { response: null, completion };
      }
      try {
        if ((await fsp.stat(proxy)).size >= 131072) break;
      } catch (error) {}
      if (cancelled(session)) {
        streamJobs.delete(id);
        return { response: null, completion };
      }
      if (job.error) throw new Error('轉檔失敗：' + job.error);
      await delay(300);
      if (cancelled(session)) {
        streamJobs.delete(id);
        return { response: null, completion };
      }
    }

    return {
      response: {
        cached: false,
        streamUrl: `http://127.0.0.1:${port}/${id}`,
        streamLeaseId: id,
        proxy,
        channels,
        wave,
        ingestJobId: id,
      },
      completion,
    };
  }

  function close() {
    if (!streamServer) return Promise.resolve();
    const server = streamServer;
    streamServer = null;
    streamPort = null;
    streamJobs.clear();
    return new Promise(resolve => server.close(() => resolve()));
  }

  function releaseStream(streamLeaseId) {
    return typeof streamLeaseId === 'string' && streamJobs.delete(streamLeaseId);
  }

  return Object.freeze({
    cacheInfo,
    cleanOrphans,
    cleanupGeneratedFile,
    clearAll,
    close,
    ingest,
    isPreviewCacheMedia,
    releaseStream,
    stream,
  });
}

module.exports = { createMediaIntakeRuntime };

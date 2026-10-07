'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { sourceChannelCount, flattenSourceChannels, channelFileName } = require('../shared/channel-layout.cjs');
const { buildIngestArgs } = require('./ffmpeg-execution-engine');

function cacheKeyFor(src) {
  const resolved = path.resolve(src);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('快取來源不是檔案');
  // v2 隔離舊 key：只看 basename、大小與前 1 MiB 會把同名素材或原地改寫
  // 後段的素材誤認成同一份，直接播放舊 Proxy／聲道。
  const sourcePath = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash('sha256').update(JSON.stringify([
    'source-v2', sourcePath, stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino,
  ]));
  const sample = (fd, position, length) => {
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, bytes, read, length - read, position + read);
      if (!n) throw new Error('快取來源在讀取時變更');
      read += n;
    }
    hash.update(String(position)).update(':').update(bytes);
  };
  if (stat.size > 0) {
    const fd = fs.openSync(resolved, 'r');
    try {
      const firstLength = Math.min(1024 * 1024, stat.size);
      sample(fd, 0, firstLength);
      if (stat.size > firstLength) {
        const window = Math.min(65536, stat.size - firstLength);
        const middle = Math.floor((stat.size - window) / 2);
        sample(fd, middle, window);
        sample(fd, stat.size - window, window);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const after = fs.statSync(resolved);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
    || after.dev !== stat.dev || after.ino !== stat.ino) {
    throw new Error('快取來源在讀取時變更');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * ffprobe audio[] → 單次 ffmpeg ingest 的跨平台音訊規劃。
 */
function buildAudioIngestPlan(audio) {
  const filters = [];
  const channels = [];
  const channelMaps = [];
  const waveContribs = [];
  const audioArr = Array.isArray(audio) ? audio : [];
  let channelIndex = 0;

  audioArr.forEach((stream, streamIndex) => {
    const count = sourceChannelCount(stream);
    const base = (stream && (stream.title || stream.lang)) || `音軌 ${streamIndex + 1}`;

    if (count === 1) {
      filters.push(`[0:a:${streamIndex}]asplit=2[co${channelIndex}][wv${streamIndex}]`);
      channels.push({
        label: base,
        file: channelFileName(channelIndex),
        sourceStream: streamIndex,
        sourceChannel: 0,
      });
      channelMaps.push(`[co${channelIndex}]`);
      waveContribs.push(`[wv${streamIndex}]`);
      channelIndex++;
      return;
    }

    const splitPads = Array.from({ length: count }, (_, sourceChannel) => `sp${streamIndex}_${sourceChannel}`);
    filters.push(
      `[0:a:${streamIndex}]asplit=${count + 1}${splitPads.map(pad => `[${pad}]`).join('')}[wv${streamIndex}]`,
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
    const average = (1 / count).toFixed(4);
    const sum = Array.from({ length: count }, (_, sourceChannel) => `${average}*c${sourceChannel}`).join('+');
    filters.push(`[wv${streamIndex}]pan=mono|c0=${sum}[wm${streamIndex}]`);
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
  const createStreamId = options.createStreamId
    || (prefix => prefix + crypto.randomBytes(12).toString('hex'));
  let streamServer = null;
  let streamServerReady = null;
  let streamPort = null;
  let closed = false;
  const streamJobs = new Map();
  const activeCacheDirs = new Map();
  const cacheRoot = () => {
    const value = typeof options.cacheRoot === 'function' ? options.cacheRoot() : options.cacheRoot;
    return value || tempRoot;
  };

  function protectCacheDir(dir) {
    activeCacheDirs.set(dir, (activeCacheDirs.get(dir) || 0) + 1);
    return () => {
      const count = activeCacheDirs.get(dir) || 0;
      if (count <= 1) activeCacheDirs.delete(dir);
      else activeCacheDirs.set(dir, count - 1);
    };
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
    const resolveFile = file => {
      if (!file) return file;
      // 舊 meta 只存 basename；補建的完整元件可位於同一 cache 的 generation。
      const relative = path.isAbsolute(file) ? path.basename(file) : file;
      const resolved = path.resolve(dir, relative);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('快取元件超出目錄');
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
      wave: relative(meta.wave),
      channels: (meta.channels || []).map(channel => ({
        label: channel.label,
        file: relative(channel.file),
        sourceStream: Number.isInteger(channel.sourceStream) ? channel.sourceStream : null,
        sourceChannel: Number.isInteger(channel.sourceChannel) ? channel.sourceChannel : null,
      })),
    };
  }

  function fileState(file) {
    if (!file) return 'missing';
    try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0 ? 'complete' : 'missing'; }
    catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unknown'; }
  }

  function completeFile(file) {
    return fileState(file) === 'complete';
  }

  // 同一份檔案證據決定重用與清理；暫時 I/O 錯誤不能等同可刪除。
  function inspectMeta(meta) {
    const proxyState = fileState(meta.proxy);
    const waveState = fileState(meta.wave);
    const channelStates = meta.channels.map(channel => fileState(channel.file));
    return {
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

  function writeMeta(metaPath, meta) {
    const temporaryPath = metaPath + '.tmp-' + crypto.randomBytes(12).toString('hex');
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(metaToStore(meta, path.dirname(metaPath))));
      fs.renameSync(temporaryPath, metaPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (ignored) {}
      throw error;
    }
  }

  function readCache(src, audio, needsProxy) {
    let partial = null;
    for (const dir of cacheCandidates(src)) {
      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const inspected = inspectMeta(resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir));
        const hit = { dir, ...inspected };
        if (coversAudioRequest(hit.meta, audio) && (!needsProxy || hit.meta.proxy)) {
          fileAuthority.grantManagedCacheDirectory(dir);
          return hit;
        }
        partial ||= hit;
      } catch (error) {}
    }
    if (partial) fileAuthority.grantManagedCacheDirectory(partial.dir);
    return partial;
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
        if (activeCacheDirs.has(dir)) continue;
        const metaPath = path.join(dir, 'meta.json');
        let remove = false;
        if (!fs.existsSync(metaPath)) remove = true;
        else {
          try {
            const meta = resolveMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')), dir);
            if (!inspectMeta(meta).retained) remove = true;
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
    const canonical = file => {
      const resolved = path.resolve(file);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const removeUnleased = target => {
      const resolved = canonical(target);
      const writers = [...activeCacheDirs.keys()].map(canonical);
      if (writers.includes(resolved)) return 0;
      if (writers.some(writer => writer.startsWith(resolved + path.sep))) {
        let removed = 0;
        try {
          for (const entry of fs.readdirSync(target)) removed += removeUnleased(path.join(target, entry));
        } catch (error) {}
        return removed;
      }
      let size = dirSize(target);
      try { const stat = fs.statSync(target); if (stat.isFile()) size = stat.size; } catch (error) {}
      try { fs.rmSync(target, { recursive: true, force: true }); return size; }
      catch (error) { return 0; }
    };
    let bytes = removeUnleased(root);
    try { fs.mkdirSync(root, { recursive: true }); } catch (error) {}
    if (currentSrc && fileAuthority.canRead(currentSrc)) {
      try {
        const sidecarDir = path.join(
          path.dirname(currentSrc),
          '.subtool_Cache',
          cacheKeyFor(currentSrc),
        );
        if (fs.existsSync(sidecarDir)) {
          bytes += removeUnleased(sidecarDir);
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
    // channelFileName() 產生 ch_01.m4a；舊版無底線聲道與混音波形也只供預覽。
    if (basename !== 'proxy.mp4' && basename !== 'wave.wav' && !/^ch_?\d+\.m4a$/i.test(basename)) return false;
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
        const pipe = (streamOptions, end = true) => {
          if (!live()) return;
          reader = fs.createReadStream(job.filePath, streamOptions);
          reader.once('error', error => fail(error));
          reader.pipe(response, { end });
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
          response.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          let offset = 0;
          const pump = async () => {
            if (!live()) return;
            const size = (await fsp.stat(job.filePath)).size;
            if (!live()) return;
            if (job.error) { fail(new Error(job.error)); return; }
            if (size <= offset) {
              if (job.done) response.end();
              else schedule(pump, 400);
              return;
            }
            // 非 Range 請求也須供應後續增長的 bytes，不能只等 writer 完成後
            // 關閉最初的短回應，否則會交付截斷的 fragmented MP4。
            pipe({ start: offset, end: size - 1 }, false);
            reader.on('data', chunk => { offset += chunk.length; });
            reader.once('end', () => { void pump().catch(error => fail(error)); });
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
          try { size = (await fsp.stat(job.filePath)).size; } catch (error) {}
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
          pipe({ start, end });
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
  function planIntake({ src, needsProxy, audio }, isStream) {
    const audioSources = Array.isArray(audio) ? audio : [];
    let hit = readCache(src, audioSources, needsProxy);
    if (hit
      && coversAudioRequest(hit.meta, audioSources)
      && (!needsProxy || hit.meta.proxy)) {
      return { cached: true, dir: hit.dir, meta: hit.meta };
    }
    if (hit && !isDirWritable(hit.dir)) hit = null;
    const dir = hit ? hit.dir : writeCacheDir(src);
    const metaPath = path.join(dir, 'meta.json');
    // 初建也只寫私有 generation：不同程式共用 sidecar 時，失敗 writer
    // 不能覆寫另一個已提交 writer 的檔案。
    const outputDir = path.join(dir, 'generation-' + crypto.randomBytes(12).toString('hex'));
    fs.mkdirSync(outputDir, { recursive: true });
    const buildProxy = needsProxy && !hit?.meta.proxy;
    const expected = flattenSourceChannels(audioSources);
    const sameAudioLayout = hit && hit.audioLayout.length === expected.length
      && expected.every((channel, index) => hit.audioLayout[index].sourceStream === channel.sourceStream
        && hit.audioLayout[index].sourceChannel === channel.sourceChannel);
    const reuseWave = !audioSources.length || (sameAudioLayout && hit.meta.wave);
    const reuseChannels = expected.map((_, index) => sameAudioLayout && completeFile(hit.audioLayout[index].file));
    const reuseAudio = reuseWave && reuseChannels.every(Boolean);
    const audioPlan = buildAudioIngestPlan(reuseAudio ? [] : audioSources);
    const channels = !audioSources.length ? (hit?.meta.channels || []) : expected.map((_, index) =>
      reuseChannels[index] ? hit.audioLayout[index]
        : { ...audioPlan.channels[index], file: path.join(outputDir, audioPlan.channels[index].file) });
    const buildChannels = [];
    const channelMaps = [];
    audioPlan.channelMaps.forEach((pad, index) => {
      if (reuseChannels[index]) audioPlan.filters.push(`${pad}anullsink`);
      else { buildChannels.push(channels[index]); channelMaps.push(pad); }
    });
    if (reuseWave && audioPlan.waveLabel) audioPlan.filters.push(`${audioPlan.waveLabel}anullsink`);
    const proxy = hit?.meta.proxy || (buildProxy ? path.join(outputDir, 'proxy.mp4') : null);
    const wave = reuseWave ? (hit?.meta.wave || null) : (audioPlan.waveLabel ? path.join(outputDir, 'wave.wav') : null);
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
      encoder: getEncoder(),
      isStream,
    });
    let committed = false;
    return {
      cached: false, dir, args, meta,
      label: buildProxy && audioPlan.channels.length ? '正在轉檔 Proxy 與分析音訊'
        : (buildProxy ? '正在轉檔 Proxy' : '正在分析音訊'),
      commit() {
        if (cacheKeyFor(src) !== path.basename(dir)) throw new Error('母素材在轉檔期間變更，請重新載入');
        if (!metaValid(meta)) throw new Error('媒體轉檔沒有產生完整快取');
        writeMeta(metaPath, meta);
        committed = true;
      },
      dispose() {
        if (!committed) fs.rmSync(outputDir, { recursive: true, force: true });
      },
    };
  }

  function reportCacheHit(session) {
    reportCompletion(session, 'ingest', '使用既有快取');
  }

  function reportCompletion(session, jobId, label, error) {
    if (cancelled(session)) return;
    try {
      options.sendProgress?.(session.progressTarget, {
        jobId, label, done: true, outcome: error ? 'failed' : 'success',
        ...(error ? { errorCode: error.code || 'MEDIA_CACHE_FAILED', errorMsg: error.message || String(error) } : { pct: 100 }),
      });
    } catch (ignored) {}
  }

  async function ingest(request, session = {}) {
    if (cancelled(session)) throw new IngestSupersededError();
    const plan = planIntake(request, false);
    if (plan.cached) {
      reportCacheHit(session);
      return Object.assign({ cached: true }, plan.meta);
    }

    const unprotect = protectCacheDir(plan.dir);
    try {
      await delay(1000);
      if (cancelled(session)) throw new Error('媒體轉檔已被較新的載入取代');
      await ffmpegExecution.execute(plan.args, {
        executionKind: 'direct',
        deferTerminal: true,
        sender: session.progressTarget,
        duration: request.duration,
        jobId: 'ingest',
        label: plan.label,
        onProcess: process => session.ownProcess?.(process),
        shouldSend: () => !cancelled(session),
      });
      if (cancelled(session)) throw new Error('媒體轉檔已被較新的載入取代');
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
    if (cancelled(session)) return { response: null, completion: null };
    const plan = planIntake({ src, needsProxy: true, audio }, true);
    if (plan.cached) {
      reportCacheHit(session);
      const id = createStreamId('c-');
      streamJobs.set(id, {
        filePath: plan.meta.proxy, done: true, error: null,
        releaseCache: protectCacheDir(plan.dir),
      });
      return Object.assign({
        cached: true,
        streamUrl: `http://127.0.0.1:${port}/${id}`,
        streamLeaseId: id,
      }, plan.meta);
    }

    const { proxy, channels, wave } = plan.meta;

    const id = createStreamId('l-');
    // HTTP reader 與 writer 各自持有引用；writer 完成不代表播放端已釋放。
    const job = { filePath: proxy, done: false, error: null, releaseCache: protectCacheDir(plan.dir) };
    streamJobs.set(id, job);
    if (cancelled(session)) {
      job.done = true;
      job.error = '媒體轉檔已被較新的載入取代';
      releaseStream(id);
      plan.dispose();
      return { response: null, completion: null };
    }
    const unprotect = protectCacheDir(plan.dir);
    let execution;
    try {
      execution = ffmpegExecution.execute(plan.args, {
        executionKind: 'direct',
        deferTerminal: true,
        sender: session.progressTarget,
        duration,
        jobId: id,
        label: plan.label,
        onProcess: process => session.ownProcess?.(process),
        shouldSend: () => !cancelled(session),
      });
    } catch (error) {
      execution = Promise.reject(error);
    }
    const completion = Promise.resolve(execution).then(() => {
      job.done = true;
      if (!cancelled(session)) {
        plan.commit();
        reportCompletion(session, id, plan.label);
      }
    }).catch(error => {
      job.done = true;
      job.error = error.message;
      reportCompletion(session, id, plan.label, error);
    }).finally(() => { try { plan.dispose(); } finally { unprotect(); } });

    const startedAt = Date.now();
    let published = false;
    try {
      /* 可播門檻的 300ms 輪詢也可能打到 SMB sidecar，因此只用 fsp.stat。 */
      while (Date.now() - startedAt < 60000) {
        if (cancelled(session)) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
        let size = 0;
        try { size = (await fsp.stat(proxy)).size; } catch (error) {}
        if (cancelled(session)) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
        if (size >= 131072 || (job.done && size > 0)) break;
        await delay(300);
        if (cancelled(session)) return { response: null, completion };
      }

      published = true;
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
    } catch (error) {
      // 未交付的exception也必須等writer settle，不能讓coordinator提前准入下一個。
      await completion;
      throw error;
    } finally {
      if (!published) releaseStream(id);
    }
  }

  async function close() {
    closed = true;
    if (!streamServer) return;
    const server = streamServer;
    await streamServerReady.catch(() => {});
    streamServer = null;
    streamServerReady = null;
    streamPort = null;
    for (const id of streamJobs.keys()) releaseStream(id);
    streamJobs.clear();
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  function releaseStream(streamLeaseId) {
    if (typeof streamLeaseId !== 'string') return false;
    const job = streamJobs.get(streamLeaseId);
    if (!job) return false;
    for (const cancel of job.requests || []) cancel();
    job.releaseCache?.();
    return streamJobs.delete(streamLeaseId);
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
        const lease = { cancelled: false, process: null };
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
          ticket.reject(error);
        } finally {
          if (active === lease) active = null;
        }
      }
    } finally {
      draining = false;
      if (resumeWhenIdle && !pending.length) closing = false;
      finishDrain();
      if (pending.length) void drain();
    }
  };

  const submit = (work, { replace = false } = {}) => new Promise((resolve, reject) => {
    if (closing) { reject(new IngestSupersededError()); return; }
    if (typeof work !== 'function') {
      reject(new TypeError('media ingest work must be a function'));
      return;
    }
    if (replace) {
      const superseded = new IngestSupersededError();
      while (pending.length) pending.shift().reject(superseded);
      cancel(active);
    }
    const ticket = { work, resolve, reject };
    if (replace) pending.unshift(ticket);
    else pending.push(ticket);
    void drain();
  });

  return Object.freeze({
    /** 取代目前所有等待與執行中的轉檔工作，優先執行新任務 */
    replace: work => submit(work, { replace: true }),
    /** 將新轉檔工作依序加入排隊佇列 */
    enqueue: work => submit(work),
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
  flattenSourceChannels,
  channelFileName,
};

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { motherSourceFingerprintSync, portableSourceFingerprint } = require('./mother-source-evidence');
const { sourceChannelCount, flattenSourceChannels, channelFileName } = require('../shared/channel-layout.cjs');
const { buildIngestArgs } = require('./ffmpeg-execution-engine');
const { sourceAudioClockFilter } = require('./media-source-clock');
const SOURCE_CACHE_VERSION = 'source-v3';
const PORTABLE_SOURCE_FORMAT = SOURCE_CACHE_VERSION + '-sha256';

function cacheKeyFor(src) {
  // v3 隔離未對齊影片來源 PTS 的舊音訊／Proxy；母素材取樣規則保持單一 owner。
  return motherSourceFingerprintSync(src, { namespace: SOURCE_CACHE_VERSION, digestLength: 16 });
}

function ownsMediaIntake(owner, scope) {
  return !!owner && owner.sender === scope.sender
    && (scope.sessionId === undefined || owner.sessionId === scope.sessionId)
    && (scope.requestId === undefined || owner.requestId === scope.requestId);
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
    // 所有聲道／波形在 split、pan 或 mix 前共用來源秒數：正 PTS 補靜音，
    // 負 PTS 去除來源起點以前的 samples，decoder 已裁掉的 primer 不重裁。
    filters.push(`[0:a:${streamIndex}]${sourceAudioClockFilter(stream)}[at${streamIndex}]`);

    if (count === 1) {
      filters.push(`[at${streamIndex}]asplit=2[co${channelIndex}][wv${streamIndex}]`);
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
  const now = options.now || (() => Date.now());
  const createStreamId = options.createStreamId
    || (prefix => prefix + crypto.randomBytes(12).toString('hex'));
  let streamServer = null;
  let streamServerReady = null;
  let streamPort = null;
  let closed = false;
  const streamJobs = new Map();
  const activeCacheDirs = new Map();
  const portableHits = new Map();
  const portableHashes = new Set();
  const inspectedCacheOwners = new WeakMap();
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

  function cacheCandidates(src, key = cacheKeyFor(src)) {
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
      const current = inspectCacheDirectory(portable.dir);
      if (!current.error && sameSourceContent(current.sourceContent, portable.sourceContent)) {
        if (!candidates.includes(portable.dir)) candidates.push(portable.dir);
      } else if (!current.error) portableHits.delete(key);
      // 暫時讀不到 metadata 不代表映射永久失效；保留它供稍後重試，本次不准入。
    }
    return candidates;
  }

  const canonicalCachePath = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const withinCachePath = (root, file) => {
    const directory = canonicalCachePath(root), target = canonicalCachePath(file);
    return target === directory || target.startsWith(directory + path.sep);
  };
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
  function bindPortableCache(dir, sourceContent, sourceKey) {
    try {
      const realDirectory = realCacheDirectory(dir);
      const receipt = path.join(dir, 'source-' + sourceKey + '.json');
      checkCacheComponent(realDirectory, receipt);
      writeRawMeta(receipt, { sourceContent, sourceKey });
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

  function inspectCacheDirectory(dir, audio = []) {
    try {
      const owner = cacheDirectoryOwner(dir);
      const realDirectory = realCacheDirectory(dir);
      const records = [];
      let uncertain = false;
      for (const entry of metadataEntries(fs.readdirSync(dir, { withFileTypes: true }))) {
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
        return inspected;
      });
      if (!variants.length) return { dir, files: [], error: 'CACHE_METADATA_MISSING', metadataMissing: !uncertain };
      const expected = flattenSourceChannels(audio);
      const chosen = (expected.length && variants.find(variant => sameAudioLayout(variant.audioLayout, expected)))
        || variants.reduce((best, variant) => variant.audioLayout.length > best.audioLayout.length ? variant : best);
      const matching = variants.filter(variant => sameAudioLayout(variant.audioLayout, chosen.audioLayout));
      const audioLayout = chosen.audioLayout.map((channel, index) =>
        matching.find(variant => variant.meta.channels.some(valid => valid.file === variant.audioLayout[index].file))?.audioLayout[index] || channel);
      const validChannels = new Set(matching.flatMap(variant => variant.meta.channels.map(channel => channel.file)));
      const files = [...new Map(variants.flatMap(variant => variant.files).map(entry => [entry.file, entry])).values()];
      const result = { dir, files, retained: uncertain || variants.some(variant => variant.retained), audioLayout,
        meta: { proxy: variants.find(variant => variant.meta.proxy)?.meta.proxy || null,
          wave: matching.find(variant => variant.meta.wave)?.meta.wave || null,
          channels: audioLayout.filter(channel => validChannels.has(channel.file)) }, sourceContent, sourceKeys };
      if (!sameCacheDirectory(owner, cacheDirectoryOwner(dir))) throw cacheDirectoryChanged();
      inspectedCacheOwners.set(result, owner);
      return result;
    } catch (error) {
      return { dir, files: [], error: error.code || error.message, metadataMissing: ['ENOENT', 'ENOTDIR'].includes(error.code) };
    }
  }

  function inspectCache(src) {
    const key = cacheKeyFor(src), portable = portableHits.get(key);
    return cacheCandidates(src, key).map(dir => inspectSourceCache(dir, [], key, portable));
  }

  function inspectSourceCache(dir, audio, key, portable) {
    const hit = inspectCacheDirectory(dir, audio);
    if (hit.error) return hit;
    const mapped = portable && canonicalCachePath(dir) === canonicalCachePath(portable.dir);
    if (mapped && !sameSourceContent(hit.sourceContent, portable.sourceContent)) {
      if (portableHits.get(key) === portable) portableHits.delete(key);
      return { dir, files: [], error: 'CACHE_SOURCE_MISMATCH' };
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
      // 候選只是路徑提示；實際讀到的這份 metadata 仍須符合當次來源證據。
      const hit = inspectSourceCache(dir, audio, key, portable);
      if (hit.error) continue;
      if (coversAudioRequest(hit.meta, audio) && (!needsProxy || hit.meta.proxy)) {
        fileAuthority.grantManagedCacheDirectory(dir);
        return hit;
      }
      partial ||= hit;
    }
    if (partial) fileAuthority.grantManagedCacheDirectory(partial.dir);
    return partial;
  }

  async function preparePortableCache({ src, audio = [], needsProxy }, session) {
    const sourceKey = cacheKeyFor(src);
    const current = () => !closed && !cancelled(session);
    const ensureCurrent = () => { if (!current()) throw new IngestSupersededError(); };
    const check = () => {
      ensureCurrent();
      if (cacheKeyFor(src) !== sourceKey) throw new Error('母素材在轉檔期間變更，請重新載入');
    };
    check();
    const direct = readCache(src, audio, needsProxy);
    const knownContent = direct?.sourceContent?.size === fs.statSync(src).size ? direct.sourceContent : null;
    const directComplete = direct && coversAudioRequest(direct.meta, audio) && (!needsProxy || direct.meta.proxy);
    if (directComplete && knownContent) return { sourceKey, sourceContent: knownContent };
    const candidates = [];
    if (!directComplete) {
      const roots = [cacheRoot()];
      if (allowSidecarCache) roots.unshift(path.join(path.dirname(src), '.subtool_Cache'));
      const size = fs.statSync(src).size;
      for (const root of new Set(roots)) {
        let entries;
        try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (error) { entries = []; }
        ensureCurrent();
        for (const entry of entries) {
          // 不追逐 symlink 或任意 metadata 路徑，只查看原本位置的 cache key 目錄。
          if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
          const dir = path.join(root, entry.name), records = [];
          try {
            for (const metadata of metadataEntries(await fsp.readdir(dir, { withFileTypes: true }))) {
              ensureCurrent();
              let file;
              try {
                file = await openCacheComponent(dir, path.join(dir, metadata.file));
                ensureCurrent();
                if ((await file.stat()).size > 1024 * 1024) continue;
                const raw = JSON.parse(await file.readFile('utf8'));
                if (acceptedRecord(metadata, raw)) records.push({ ...metadata, raw });
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
          candidates.push({ dir, sourceContent, sourceKeys });
        }
      }
      check();
      // 這台電腦已完整驗證過且來源 strict key 未變，免重讀整支大型素材。
      for (const candidate of candidates) {
        if (!Array.isArray(candidate.sourceKeys) || !candidate.sourceKeys.includes(sourceKey)) continue;
        const hit = inspectCacheDirectory(candidate.dir, audio);
        if (hit.error || !sameSourceContent(hit.sourceContent, candidate.sourceContent)
          || !hit.sourceKeys.includes(sourceKey) || !coversAudioRequest(hit.meta, audio) || (needsProxy && !hit.meta.proxy)) continue;
        portableHits.set(sourceKey, { dir: candidate.dir, sourceContent: candidate.sourceContent });
        return { sourceKey, sourceContent: candidate.sourceContent };
      }
    }
    let sha256 = knownContent?.sha256;
    if (!sha256) {
      reportProgress(session, { jobId: 'ingest', label: '驗證共用 Proxy 的母素材', pct: 0 });
      const hash = portableSourceFingerprint(src, { shouldContinue: current });
      portableHashes.add(hash);
      try { sha256 = await hash; } finally { portableHashes.delete(hash); }
    }
    check();
    const sourceContent = { format: PORTABLE_SOURCE_FORMAT, size: fs.statSync(src).size, sha256 };
    if (direct && (!sameSourceContent(direct.sourceContent, sourceContent) || !direct.sourceKeys.includes(sourceKey))) {
      bindPortableCache(direct.dir, sourceContent, sourceKey);
    }
    if (!directComplete) {
      let partial = null;
      for (const candidate of candidates) {
        if (candidate.sourceContent.sha256 !== sha256) continue;
        const hit = inspectCacheDirectory(candidate.dir, audio);
        if (hit.error || !sameSourceContent(hit.sourceContent, sourceContent)) continue;
        if (coversAudioRequest(hit.meta, audio) && (!needsProxy || hit.meta.proxy)) { partial = hit; break; }
        partial ||= hit;
      }
      if (partial) {
        portableHits.set(sourceKey, { dir: partial.dir, sourceContent });
        if (!partial.sourceKeys.includes(sourceKey)) bindPortableCache(partial.dir, sourceContent, sourceKey);
      }
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
    const admitted = dir => {
      const hit = inspectSourceCache(dir, [], key, portable);
      return !hit.error || hit.metadataMissing;
    };
    for (const dir of cacheCandidates(src, key)) {
      if (!admitted(dir) || !isDirWritable(dir) || !admitted(dir)) continue;
      fileAuthority.grantManagedCacheDirectory(dir);
      return dir;
    }
    const fallback = path.join(cacheRoot(), key);
    if (!admitted(fallback) || !isDirWritable(fallback) || !admitted(fallback)) {
      throw new Error('無法建立媒體快取，請確認快取目錄權限與來源');
    }
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
        const inspected = inspectCacheDirectory(dir);
        const remove = inspected.metadataMissing || (!inspected.error && !inspected.retained);
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
        const sidecarRoot = canonical(path.join(path.dirname(currentSrc), '.subtool_Cache'));
        const key = cacheKeyFor(currentSrc), portable = portableHits.get(key);
        const removeSidecar = dir => {
          const target = canonical(dir);
          if ([...activeCacheDirs.keys()].some(active => {
            const writer = canonical(active);
            return writer === target || writer.startsWith(target + path.sep);
          })) return 0;
          const quarantine = path.join(path.dirname(dir), '.subtool-clear-' + crypto.randomBytes(12).toString('hex'));
          if (canonical(path.dirname(quarantine)) !== sidecarRoot) return 0;
          let moved = false;
          const restore = () => {
            if (!moved) return;
            // 另一個 writer 已重建原路徑時保留私有隔離目錄，不能覆蓋它的新內容。
            try { if (!fs.existsSync(dir)) { fs.renameSync(quarantine, dir); moved = false; } } catch (error) {}
          };
          const sameDirectory = (left, right) => left.isDirectory() && !left.isSymbolicLink()
            && right.isDirectory() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino;
          try {
            const before = fs.lstatSync(dir, { bigint: true });
            if (!before.isDirectory() || before.isSymbolicLink()) return 0;
            const accepted = inspectSourceCache(dir, [], key, portable);
            if (accepted.error && !accepted.metadataMissing) return 0;
            // 先原子取得將刪除的目錄物件，再核對身分與來源；不對先前候選路徑直接刪除。
            fs.renameSync(dir, quarantine);
            moved = true;
            const claimed = fs.lstatSync(quarantine, { bigint: true });
            const current = inspectCacheDirectory(quarantine);
            if (!sameDirectory(before, claimed)
              || (accepted.sourceContent && (current.error || !sameSourceContent(current.sourceContent, accepted.sourceContent)))
              || (current.sourceContent && !accepted.sourceContent)
              || (current.error && !current.metadataMissing)) { restore(); return 0; }
            const size = dirSize(quarantine);
            if (!sameDirectory(claimed, fs.lstatSync(quarantine, { bigint: true }))) { restore(); return 0; }
            fs.rmSync(quarantine, { recursive: true, force: true });
            moved = false;
            return size;
          } catch (error) { restore(); return 0; }
        };
        for (const dir of cacheCandidates(currentSrc, key)) {
          // 可攜命中仍在原 key 目錄；清理只接受目前素材旁已驗證的 cache 目錄。
          if (canonical(path.dirname(dir)) !== sidecarRoot || !/^[a-f0-9]{16}$/.test(path.basename(dir))) continue;
          if (fs.existsSync(dir)) bytes += removeSidecar(dir);
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
        const openStreamFile = () => openCacheComponent(cacheDirectory, job.filePath);
        const streamStat = async () => {
          const file = await openStreamFile();
          try { return await file.stat(); } finally { await file.close(); }
        };
        const pipe = async (streamOptions, end = true) => {
          if (!live()) return;
          const file = await openStreamFile();
          try {
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
          catch (error) { if (error.code === 'CACHE_PATH_ESCAPE') { fail(error, 403); return; } }
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
  function planIntake({ src, needsProxy, audio }, isStream, description = null, portable = null) {
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
      return { cached: true, dir: hit.dir, meta: hit.meta };
    }
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
      encoder: getEncoder(),
      isStream,
      video,
    });
    let committed = false;
    return {
      cached: false, dir, args, meta,
      readDirs: copyCompleted ? [hit.dir] : [],
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
      label: buildProxy && audioPlan.channels.length ? '正在轉檔 Proxy 與分析音訊'
        : (buildProxy ? '正在轉檔 Proxy' : '正在分析音訊'),
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
        if (committed) return;
        // 失敗只收回自己建立的實體 generation；同名路徑可已被另一個 writer 接手。
        const quarantine = path.join(dir, '.subtool-discard-' + crypto.randomBytes(12).toString('hex'));
        let moved = false;
        try {
          if (!sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))
            || !sameCacheDirectory(outputOwner, cacheDirectoryOwner(outputDir))) return;
          fs.renameSync(outputDir, quarantine);
          moved = true;
          if (!sameCacheDirectory(directoryOwner, cacheDirectoryOwner(dir))
            || !sameCacheDirectory(outputOwner, cacheDirectoryOwner(quarantine))) return;
          fs.rmSync(quarantine, { recursive: true, force: true });
          moved = false;
        } catch (error) {}
        finally {
          if (moved) {
            try { if (!fs.existsSync(outputDir)) fs.renameSync(quarantine, outputDir); } catch (error) {}
          }
        }
      },
    };
  }

  function protectPlan(plan) {
    const releases = [...new Set([plan.dir, ...(plan.readDirs || [])])].map(protectCacheDir);
    return () => { for (const release of releases) release(); };
  }

  function reportCacheHit(session) {
    reportCompletion(session, 'ingest', '使用既有快取');
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

  async function ingest(request, session = {}) {
    if (closed || cancelled(session)) throw new IngestSupersededError();
    const portable = await preparePortableCache(request, session);
    const description = request.needsProxy && options.describeVideo ? await describeMissingProxy(request.src, request.audio) : null;
    if (closed || cancelled(session)) throw new IngestSupersededError();
    let plan = planIntake(request, false, description, portable);
    if (plan.needsVideoDescription) {
      const replacementDescription = await describeMissingProxy(request.src, request.audio, true);
      if (closed || cancelled(session)) throw new IngestSupersededError();
      plan = planIntake(request, false, replacementDescription, portable);
    }
    if (plan.cached) {
      reportCacheHit(session);
      return Object.assign({ cached: true }, plan.meta);
    }

    const unprotect = protectPlan(plan);
    try {
      await delay(1000);
      if (cancelled(session)) throw new IngestSupersededError();
      if (plan.prepare) await plan.prepare(() => !cancelled(session));
      if (closed || cancelled(session)) throw new IngestSupersededError();
      await ffmpegExecution.execute(plan.args, {
        executionKind: 'direct',
        deferTerminal: true,
        onProgress: payload => reportProgress(session, payload),
        duration: request.duration,
        jobId: 'ingest',
        label: plan.label,
        onProcess: process => session.ownProcess?.(process),
        shouldSend: () => !cancelled(session),
      });
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
    let portable;
    try { portable = await preparePortableCache({ src, duration, audio, needsProxy: true }, session); }
    catch (error) {
      if (closed || cancelled(session)) return { response: null, completion: null };
      throw error;
    }
    const description = options.describeVideo ? await describeMissingProxy(src, audio) : null;
    if (closed || cancelled(session)) return { response: null, completion: null };
    let plan = planIntake({ src, needsProxy: true, audio }, true, description, portable);
    if (plan.needsVideoDescription) {
      const replacementDescription = await describeMissingProxy(src, audio, true);
      if (closed || cancelled(session)) return { response: null, completion: null };
      plan = planIntake({ src, needsProxy: true, audio }, true, replacementDescription, portable);
    }
    if (plan.cached) {
      reportCacheHit(session);
      if (closed || cancelled(session)) return { response: null, completion: null };
      const id = createStreamId('c-');
      streamJobs.set(id, {
        filePath: plan.meta.proxy, done: true, error: null,
        owner: session.owner,
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
    const job = { filePath: proxy, done: false, error: null, owner: session.owner,
      releaseCache: protectCacheDir(plan.dir) };
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
    const unprotect = protectPlan(plan);
    let execution;
    let writer = null;
    let readinessError = null;
    let preparationReady = !plan.prepare;
    const stopUnreadyWriter = () => { try { writer?.kill?.(); } catch (error) {} };
    try {
      const startWriter = () => ffmpegExecution.execute(plan.args, {
        executionKind: 'direct',
        deferTerminal: true,
        onProgress: payload => reportProgress(session, payload),
        duration,
        jobId: id,
        label: plan.label,
        onProcess: process => {
          writer = process;
          session.ownProcess?.(process);
          if (readinessError) stopUnreadyWriter();
        },
        shouldSend: () => !cancelled(session),
      });
      execution = plan.prepare ? plan.prepare(() => !cancelled(session)).then(() => {
        if (closed || cancelled(session)) throw new IngestSupersededError();
        preparationReady = true;
        return startWriter();
      }) : startWriter();
    } catch (error) {
      execution = Promise.reject(error);
    }
    const completion = Promise.resolve(execution).then(() => {
      job.done = true;
      if (readinessError) {
        reportCompletion(session, id, plan.label, readinessError);
      } else if (!cancelled(session)) {
        plan.commit();
        reportCompletion(session, id, plan.label);
      }
    }).catch(error => {
      job.done = true;
      const failure = readinessError || error;
      job.error = failure.message;
      reportCompletion(session, id, plan.label, failure);
    }).finally(() => { try { plan.dispose(); } finally { unprotect(); } });

    const startedAt = now();
    let published = false;
    let ready = false;
    try {
      /* 可播門檻的 300ms 輪詢也可能打到 SMB sidecar，因此只用 fsp.stat。 */
      while (now() - startedAt < 60000) {
        if (!ownsStream()) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
        let size = 0;
        try { size = (await fsp.stat(proxy)).size; } catch (error) {}
        if (!ownsStream()) return { response: null, completion };
        if (job.error) throw new Error('轉檔失敗：' + job.error);
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
    await Promise.allSettled([...portableHashes]);
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
    clearAll,
    close,
    ingest,
    inspectCache,
    isDirWritable,
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

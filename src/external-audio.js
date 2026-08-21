/* ==============================================================================
   SUB Tool — 外部音訊素材庫（"src/external-audio.js"）
   ==============================================================================
   時間軸上獨立於影片的音檔素材：建立、查詢、移動、修剪、切割點、啟用切換、
   序列化，以及「這個時間軸時間對應到來源的哪一秒」。

   【這個模組為什麼存在】
   這些全是資料運算，但它們原本是 Media 上的 15 個方法，和序列播放時鐘、
   WebCodecs 接管、Web Audio 增益、波形快取共用同一個物件與同一個介面
   （Media 對外可見 67 個名稱）。於是：
     - 呼叫端要編修素材，得先有一個能播放的 Media；
     - 測試「修剪不能把素材裁到 0 長」得先造出 AudioContext 與 DOM；
     - 誰都可以直接改 asset 欄位，正規化不變量沒有守門人。

   【職責邊界】
   這裡只管【素材資料】。實際的 AudioElement、增益、波形、重繪、History
   一律留在 Media —— 那些才是它的本業。所以本模組：
     - 不 import Media、Wave、Seq、DOM；
     - 不發事件、不重繪；
     - 回傳純資料（或 null），由呼叫端決定要不要記 history、要不要重畫。

   【不變量】
     ① 範圍永遠正規化：0 ≤ in ≤ out ≤ duration，且 out=0 是合法的空範圍
        （不能用 `|| duration` 回退，那會讓空範圍突然變成整段）。
     ② 淡入／淡出不超過素材本身的長度。
     ③ audioSourceId 永不由檔名或 runtime id 推導，否則同名檔會互相覆蓋路由。
     ④ 對外吐出的資料絕不帶 File／AudioElement／波形（_file 一律剝掉）。
============================================================================== */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nonNeg = v => Math.max(0, Number(v) || 0);

let _audioSourceSeq = 1;
function makeAudioSourceId(){
  const uuid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : null;
  return uuid ? `asset-${uuid}` : `asset-${Date.now().toString(36)}-${_audioSourceSeq++}`;
}

/* 來源聲道座標。沒有明細時依 fallbackCount 產生 0..n-1 的預設值。 */
function sourceChannelDescriptors(channels, fallbackCount = 0){
  const list = Array.isArray(channels) ? channels : [];
  if (list.length) return list.map((ch, index) => ({
    sourceStream: Math.max(0, Math.floor(Number(ch?.sourceStream ?? 0) || 0)),
    sourceChannel: Math.max(0, Math.floor(Number(ch?.sourceChannel ?? index) || 0)),
  }));
  return Array.from({ length: Math.max(0, Math.floor(Number(fallbackCount) || 0)) },
    (_, index) => ({ sourceStream: 0, sourceChannel: index }));
}

/* 已正規化的來源範圍。不變量①的唯一實作。 */
function assetRange(asset){
  const duration = nonNeg(asset?.duration);
  const offset = nonNeg(asset?.offset);
  const rawIn = Number(asset?.in ?? asset?.trimStart);
  const inPoint = Math.min(duration || Infinity, Math.max(0, Number.isFinite(rawIn) ? rawIn : 0));
  const rawOut = Number(asset?.out ?? asset?.trimEnd);
  let outPoint = Number.isFinite(rawOut) ? Math.max(inPoint, rawOut) : duration;
  if (duration > 0) outPoint = Math.min(outPoint, duration);
  return { offset, in: inPoint, out: outPoint, length: Math.max(0, outPoint - inPoint), duration };
}

/* 對 State / History 暴露的只會是純資料（不變量④）。 */
function serializeAsset(asset){
  if (!asset) return null;
  const { _file, ...plain } = asset;
  return { ...plain, descriptors: (asset.descriptors || []).map(channel => ({ ...channel })) };
}

class ExternalAudioLibrary {
  constructor(){ this.assets = []; }

  /* ── 查詢 ───────────────────────────────────────────────────────────── */

  /* key 可以是 id / audioSourceId / audioSrc / source 任何一種——呼叫端手上
     拿到的是哪一種，取決於它是從 DOM、選單還是路由來的。 */
  find(key){
    const value = String(key || '');
    return this.assets.find(asset =>
      asset.id === value || asset.audioSourceId === value || asset.audioSrc === value || asset.source === value || asset.timelineLaneId === value
    ) || null;
  }
  has(asset){ return this.assets.includes(asset); }
  get(key){ return serializeAsset(this.find(key)); }
  list(){ return this.assets.map(serializeAsset); }
  bySource(source){
    return this.assets.find(item => item.audioSrc === source || item.source === source) || null;
  }
  byAudioSourceId(sourceId){
    return this.assets.find(asset => asset.audioSourceId === sourceId) || null;
  }
  range(asset){ return assetRange(asset); }

  /* ── 建立與移除 ─────────────────────────────────────────────────────── */

  add(details = {}){
    const duration = nonNeg(details.duration);
    const fallbackCount = Math.max(0, Math.floor(Number(details.fallbackCount) || 0));
    const descriptors = sourceChannelDescriptors(details.descriptors, fallbackCount);
    const requestedId = typeof details.audioSourceId === 'string' ? details.audioSourceId.trim() : '';
    // 不變量③：要求的 id 只有在沒被佔用時才採納，其餘一律另發。
    const audioSourceId = requestedId && !this.assets.some(asset => asset.audioSourceId === requestedId)
      ? requestedId : makeAudioSourceId();
    // 切開同一檔音訊時，每個片段仍要有獨立的 AudioElement 以便同時播放，
    // 但時間軸 UI 應把它們留在同一條素材列。這個 ID 只管顯示分列，絕不參與 routing。
    const requestedLaneId = typeof details.timelineLaneId === 'string' ? details.timelineLaneId.trim() : '';
    const timelineLaneId = requestedLaneId || audioSourceId;
    const source = 'ext-' + audioSourceId;
    const inPoint = Math.max(0, Number(details.in ?? details.trimStart) || 0);
    const requestedOut = Number(details.out ?? details.trimEnd);
    const out = Number.isFinite(requestedOut) && requestedOut >= inPoint
      ? (duration ? Math.min(requestedOut, duration) : requestedOut) : duration;
    const asset = {
      id: 'external:' + audioSourceId,
      kind: 'external-audio',
      name: (typeof details.name === 'string' && details.name.trim()) || '外部音訊',
      path: typeof details.path === 'string' && details.path ? details.path : null,
      audioSourceId,
      timelineLaneId,
      audioSrc: source,
      source,
      offset: nonNeg(details.offset),
      in: inPoint,
      out,
      duration,
      gain: Math.max(0, Number(details.gain == null ? 1 : details.gain) || 0),
      fadeIn: nonNeg(details.fadeIn),
      fadeOut: nonNeg(details.fadeOut),
      enabled: details.enabled !== false,
      ...(Number.isFinite(Number(details.height)) ? { height: clamp(Number(details.height), 32, 160) } : {}),
      // 影片容器（例如 MXF／部分 MOV）未必能被 Chromium 的 <audio> 解碼。
      // 這個旗標會隨專案保存，讓它在重開後直接復用 ffmpeg 的逐聲道快取，
      // 而不是再次嘗試載入原始影片容器後才失敗。
      preferCache: details.preferCache === true,
      descriptors,
      // 瀏覽器版切割同一個 File 時需要保留來源；此欄位永不寫入專案檔。
      _file: details.file || null,
    };
    this.assets.push(asset);
    return asset;
  }

  /* 只從清單移除。AudioElement 的拆除、波形快取、選取狀態由 Media 負責。 */
  remove(asset){
    if (!asset) return false;
    const before = this.assets.length;
    this.assets = this.assets.filter(item => item !== asset);
    return this.assets.length !== before;
  }

  clear(){ this.assets = []; }

  /* ── 編輯（全部回傳序列化後的 asset，或 null 表示 key 找不到）────────── */

  normalize(asset){
    if (!asset) return null;
    const range = assetRange(asset);
    asset.offset = range.offset;
    asset.in = range.in;
    asset.out = range.out;
    asset.gain = Math.max(0, Number(asset.gain == null ? 1 : asset.gain) || 0);
    // 不變量②
    asset.fadeIn = Math.min(range.length, nonNeg(asset.fadeIn));
    asset.fadeOut = Math.min(range.length, nonNeg(asset.fadeOut));
    asset.enabled = asset.enabled !== false;
    if (asset.height != null) {
      if (Number.isFinite(Number(asset.height))) asset.height = clamp(Number(asset.height), 32, 160);
      else delete asset.height;
    }
    return asset;
  }

  move(key, offset){
    const asset = this.find(key);
    if (!asset) return null;
    asset.offset = nonNeg(offset);
    return asset;
  }

  /* edge 可用 start/left/in/head 或其他（＝結尾）；timelineTime 一律是時間軸秒數。
     修剪【永遠】留下至少 MIN 長度，否則素材會被拖成 0 長而從時間軸上消失。 */
  trim(key, edge, timelineTime){
    const asset = this.find(key);
    if (!asset) return null;
    const range = assetRange(asset);
    const MIN = this.minLength(range);
    if (range.length <= MIN) return asset; // 已經太短，不再修剪
    const t = nonNeg(timelineTime);
    const isStart = ['start', 'left', 'in', 'head'].includes(String(edge || '').toLowerCase());
    if (isStart) {
      const newOffset = clamp(t, 0, range.offset + range.length - MIN);
      asset.in = clamp(range.in + (newOffset - range.offset), 0, range.out - MIN);
      asset.offset = newOffset;
    } else {
      asset.out = clamp(range.in + (t - range.offset), range.in + MIN, range.duration || Infinity);
    }
    return asset;
  }

  setEnabled(key, enabled){
    const asset = this.find(key);
    if (!asset) return null;
    asset.enabled = typeof enabled === 'boolean' ? enabled : asset.enabled === false;
    return asset;
  }

  setHeight(targetOrKey, height){
    const target = (typeof targetOrKey === 'object' && targetOrKey !== null)
      ? (this.has(targetOrKey) ? targetOrKey : this.find(targetOrKey.id || targetOrKey.audioSourceId || targetOrKey.timelineLaneId || targetOrKey.audioSrc || targetOrKey.source))
      : this.find(targetOrKey);
    if (!target) return null;
    const laneId = target.timelineLaneId || target.audioSourceId;
    const val = (height == null || !Number.isFinite(Number(height))) ? undefined : clamp(Number(height), 32, 160);
    for (const asset of this.assets) {
      if (asset.timelineLaneId === laneId || asset.audioSourceId === target.audioSourceId || asset.id === target.id) {
        if (val === undefined) delete asset.height;
        else asset.height = val;
      }
    }
    return target;
  }

  updateDuration(asset, rawDuration){
    if (!asset || !this.has(asset)) return null;
    const duration = nonNeg(rawDuration);
    if (!duration) return null;
    const previous = nonNeg(asset.duration);
    asset.duration = duration;
    // 尚未被時間軸編輯修剪過時，out 跟著實際 metadata 長度更新。
    if (!(asset.out > 0) || Math.abs(Number(asset.out) - previous) < 0.000001) asset.out = duration;
    else asset.out = Math.min(Number(asset.out), duration);
    return this.normalize(asset);
  }

  /* 修剪／切割的最小長度：短素材也留一半，長素材固定 0.2 秒。 */
  minLength(range){ return Math.min(0.2, Math.max(0.02, range.length / 2)); }

  /* 切割【只算數字】：回傳左段要改成什麼、右段該用什麼規格建立。
     真正把右段載進來（桌面走路徑、網頁走 File）是 Media 的事，因為那要開檔。
     null＝切點太靠近邊界，不該切。 */
  planSplit(key, timelineTime){
    const asset = this.find(key);
    if (!asset) return null;
    const range = assetRange(asset);
    const t = nonNeg(timelineTime);
    const MIN = this.minLength(range);
    if (range.length <= MIN || t <= range.offset + MIN || t >= range.offset + range.length - MIN) return null;
    const cut = range.in + (t - range.offset);
    return {
      asset,
      cut,
      // 還原用：右段建立失敗時要能把左段原封不動放回去
      previous: { out: asset.out, fadeOut: asset.fadeOut },
      left: { out: cut, fadeOut: 0 },
      right: {
        name: asset.name,
        timelineLaneId: asset.timelineLaneId || asset.audioSourceId,
        height: asset.height,
        duration: asset.duration,
        offset: t,
        in: cut,
        out: range.out,
        gain: asset.gain,
        fadeIn: 0,
        fadeOut: asset.fadeOut,
        enabled: asset.enabled,
        preferCache: asset.preferCache === true,
        descriptors: (asset.descriptors || []).map(channel => ({ ...channel })),
        fallbackCount: (asset.descriptors || []).length,
        _internalSplit: true,
      },
    };
  }

  /* ── 時間軸 ─────────────────────────────────────────────────────────── */

  /* 把外部素材的時間軸位置換算成來源秒數；null 表示這個時間點不該播放。
     沒有 asset metadata 的舊 ext-* runtime track 保持原本「從 0 秒跟 timeline」行為。 */
  sourceTime(source, timelineTime){
    const asset = this.bySource(source);
    if (!asset) return nonNeg(timelineTime);
    if (asset.enabled === false) return null;
    const range = assetRange(asset);
    const t = nonNeg(timelineTime);
    if (t < range.offset || !(range.length > 0) || t >= range.offset + range.length) return null;
    return range.in + (t - range.offset);
  }

  /* 即使被靜音，素材仍佔著時間軸長度——輸出的黑畫面／總長不能因 Mute 縮短。 */
  timelineEnd(){
    return this.assets.reduce((end, asset) => {
      const range = assetRange(asset);
      return Math.max(end, range.offset + range.length);
    }, 0);
  }

  /* ── 序列化與還原 ───────────────────────────────────────────────────── */

  serialize(){ return this.list(); }

  /* History 還原：算出「哪些留下並套用新值、哪些要移除、哪些得非同步重建」。
     這裡刻意【只做決定】，實際移除與重建由 Media 執行——移除要拆 AudioElement，
     重建要開檔，兩者都是它的本業。 */
  planRestore(rawSources){
    const wanted = (Array.isArray(rawSources) ? rawSources : []).filter(source =>
      source && typeof source === 'object' && typeof source.audioSourceId === 'string' && source.audioSourceId
    ).map(serializeAsset);
    const wantedIds = new Set(wanted.map(source => source.audioSourceId));
    const removed = this.assets.filter(asset => !wantedIds.has(asset.audioSourceId));
    const pending = [];
    const kept = [];
    for (const source of wanted) {
      const asset = this.byAudioSourceId(source.audioSourceId);
      if (asset) { kept.push({ asset, source }); }
      else if (source.path) pending.push(source);
    }
    return {
      wanted,
      removed,
      kept,
      pending,
      // 尚未完成非同步重建前仍用快照的總長，避免 undo 後時間軸立刻縮短。
      timelineEnd: wanted.reduce((end, source) => {
        const range = assetRange(source);
        return Math.max(end, range.offset + range.length);
      }, 0),
    };
  }

  /* 把快照的欄位套回仍存在的 asset。只碰資料，不碰 runtime。 */
  applyRestored(asset, source){
    if (!asset || !source) return null;
    asset.name = source.name || asset.name;
    if (source.path) asset.path = source.path;
    if (typeof source.timelineLaneId === 'string' && source.timelineLaneId.trim()) asset.timelineLaneId = source.timelineLaneId.trim();
    if (source.height != null && Number.isFinite(Number(source.height))) {
      asset.height = clamp(Number(source.height), 32, 160);
    } else {
      delete asset.height;
    }
    asset.offset = source.offset;
    asset.in = source.in;
    asset.out = source.out;
    asset.duration = Math.max(0, Number(source.duration) || asset.duration || 0);
    asset.gain = source.gain;
    asset.fadeIn = source.fadeIn;
    asset.fadeOut = source.fadeOut;
    asset.enabled = source.enabled !== false;
    asset.preferCache = source.preferCache === true;
    if (Array.isArray(source.descriptors) && source.descriptors.length) asset.descriptors = source.descriptors.map(channel => ({ ...channel }));
    return this.normalize(asset);
  }
}

export { ExternalAudioLibrary, makeAudioSourceId, sourceChannelDescriptors, serializeAsset, assetRange };

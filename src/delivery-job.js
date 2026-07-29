/* ==============================================================================
   SUB Tool — 匯出工作組建（"src/delivery-job.js"）
   ==============================================================================
   把「專案目前的樣子」壓成一份**匯出工作**要用的快照：扁平片段清單、視訊軌疊層
   順序、總長，以及專案音軌路由編譯出來的 audioPlan。送出之後這份快照與專案脫鉤
   （見 CONTEXT.md「匯出工作」）。

   【這個模組為什麼存在】
   這些全是純計算，但它們原本長在 subio.js 裡——那個檔案同時是字幕匯入／匯出、
   匯出對話框、FPS 轉換與時碼位移，共 21 個 import。於是「測一個純函式」得先
   vi.mock 掉 dom／ui／timeline／notes／project／tcparse…十個模組，而且為了讓測試
   構得到它們，subio.js 的對外清單被迫多掛五個底線名稱。介面被測試需求撐寬，
   locality 是零。

   【鐵律】
   - 這個模組【不 import State、Media、Seq，也不碰 DOM】。所有輸入由呼叫端傳進來，
     輸出是純資料。加任何 import 之前先想清楚：那會讓這裡重新變回要 mock 才能測。
   - 匯出【只准】讀母素材（CONTEXT.md：母素材／Proxy）。Media 的逐聲道 m4a 是
     播放與波形用的快取，任何情況下都不可以出現在回傳的 file 欄位裡。缺座標時
     寧可標成 unresolved 擋下匯出，也不要偷偷退回快取。
   - 對外只有兩個名稱。其餘都是實作。
============================================================================== */

/* ── 內部工具 ───────────────────────────────────────────────────────────── */

const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const ratio = (value, fallback) => Math.max(0, Math.min(1, finite(value, fallback)));
const nonNeg = value => Math.max(0, Number(value) || 0);

/* 素材的修剪區間。外部音檔用 in/out，舊資料用 trimStart/trimEnd，
   都沒有時退回 duration —— 三種欄位名稱在專案檔裡都出現過。 */
function trimRange(asset){
  const trimStart = nonNeg(asset.in ?? asset.trimStart);
  const rawEnd = Number(asset.out ?? asset.trimEnd ?? asset.duration);
  return { trimStart, trimEnd: Number.isFinite(rawEnd) ? Math.max(trimStart, rawEnd) : trimStart };
}

/* 依混音器狀態算出某影片段要輸出哪些聲道（比照 applyGains：有獨奏則只留獨奏，
   否則留未靜音；套用音量）。預覽用的逐聲道 AAC 快取只拿來讀 M/S/音量與來源聲道
   座標；匯出一律改讀 clip.path 的母素材。
   回傳 []＝全靜音；沒有逐聲道資訊時回 undefined，主程序會直接讀同一支母素材的原始音訊。 */
function clipAudioSpec(clip, mediaTracks){
  const srcKey = clip.audioSrc || (clip.primary ? 'video' : 'clip:' + clip.id);
  const tks = mediaTracks.filter(t => (t.source || 'video') === srcKey && t.file && (t.kind === 'element' || t.kind === 'buffer'));
  if (!tks.length) return undefined; // 無逐聲道檔 → 回退來源原音
  const masterPath = typeof clip?.path === 'string' && clip.path ? clip.path : null;
  if (!masterPath) return []; // 不可改以播放用 cache 匯出。
  const anySolo = tks.some(t => t.solo);
  return tks.filter(t => (anySolo ? t.solo : !t.muted) && (t.volume || 0) > 0)
            .map(t => {
              const hasSourceCoordinates = Number.isInteger(t.sourceStream) && Number.isInteger(t.sourceChannel);
              return {
                // 即使舊專案尚未記錄 sourceStream/sourceChannel，也只讀母素材；
                // 少了座標時 main process 會讀該母素材的預設 audio stream，絕不回退 m4a cache。
                file: masterPath,
                ...(hasSourceCoordinates ? { sourceStream: t.sourceStream, sourceChannel: t.sourceChannel } : {}),
                volume: +(t.volume != null ? t.volume : 1).toFixed(3),
              };
            });
}

/* 外部音檔素材 → 與影片段共用的 placement 形狀。enabled=false 的不進音訊輸入。 */
function externalAudioPlacements(externalSources){
  return (Array.isArray(externalSources) ? externalSources : [])
    .filter(asset => asset && asset.enabled !== false)
    .map(asset => {
      const { trimStart, trimEnd } = trimRange(asset);
      return {
        source: asset,
        offset: nonNeg(asset.offset),
        trimStart,
        trimEnd,
        fadeIn: nonNeg(asset.fadeIn),
        fadeOut: nonNeg(asset.fadeOut),
        gain: Math.max(0, Number(asset.gain == null ? 1 : asset.gain) || 0),
      };
    })
    .filter(placement => placement.trimEnd > placement.trimStart);
}

/* 即使來源被靜音，它仍是時間軸上的素材；輸出影片的黑畫面／總長不能因 Mute 縮短。
   所以這裡【不看 enabled】——音訊輸入的過濾由 externalAudioPlacements 負責。 */
function externalAudioTimelineEnd(externalSources){
  return (Array.isArray(externalSources) ? externalSources : []).reduce((end, asset) => {
    if (!asset) return end;
    const { trimStart, trimEnd } = trimRange(asset);
    return Math.max(end, nonNeg(asset.offset) + Math.max(0, trimEnd - trimStart));
  }, 0);
}

/* runtime 已重建的音檔以 Media registry 為準；尚未能重開（例如檔案暫時離線）的
   source 則保留 State 的可序列化 placement。如此匯出前會被標成 unresolved，
   不會悄悄少掉一段音訊或把總長縮短。 */
function mergeExternalSources(persisted, live){
  const byId = new Map();
  for (const source of (Array.isArray(persisted) ? persisted : [])) {
    const id = typeof source?.audioSourceId === 'string' ? source.audioSourceId : '';
    if (id) byId.set(id, source);
  }
  for (const source of (Array.isArray(live) ? live : [])) {
    const id = typeof source?.audioSourceId === 'string' ? source.audioSourceId : '';
    if (id) byId.set(id, source); // runtime 有實體檔與最新編輯資料，優先採用
  }
  return [...byId.values()];
}

/* ── 對外 ①：專案音軌路由 → audioPlan ─────────────────────────────────── */

/* 將專案層的 sourceMaps（來源聲道→專案音軌）轉成 Electron 匯出端可直接編譯的
   audioPlan。Media 的暫存單聲道檔案只提供目前混音器的 M/S/音量狀態與聲道準備情況；
   真正的 input.file 必須是每個素材的母檔 path，並帶 sourceStream/sourceChannel
   讓主程序直接解碼該聲道。
   audioSourceId / sourceStream / sourceChannel 全部採 0-based，與 state.js 的
   持久化格式一致。

   clips 與外部 audio asset 都先正規化為 placement，再共用同一條 bus/input 編譯流程。
   外部 asset 沒有視訊，但它的 offset/in/out 是時間軸域資料，故輸出能與預覽同位置對齊。 */
function buildProjectAudioPlan({ audioProject, mediaTracks = [], clips = [], externalSources = [] } = {}){
  const project = audioProject;
  if (!project || !Array.isArray(project.buses) || !project.buses.length || !project.sourceMaps || !project.exportLayout)
    return null; // 尚未進入專案音訊模式時，由主程序沿用舊版 stereo 匯出
  const buses = project.buses.map(bus => ({ id: bus.id, inputs: [] }));
  const busById = new Map(project.buses.map((bus, i) => [bus.id, { bus, plan: buses[i] }]));
  const anySolo = project.buses.some(bus => bus.solo);
  const busGain = new Map(project.buses.map(bus => {
    const audible = anySolo ? !!bus.solo : !bus.muted;
    return [bus.id, audible ? Math.max(0, Number(bus.volume == null ? 1 : bus.volume) || 0) : 0];
  }));
  const unresolvedSources = new Map();

  const placements = [
    ...(Array.isArray(clips) ? clips : []).filter(clip => !clip.audioDetached).map(clip => ({
      source: clip,
      offset: nonNeg(clip.offset),
      trimStart: nonNeg(clip.in),
      trimEnd: nonNeg(clip.out),
      fadeIn: nonNeg(clip.fadeIn),
      fadeOut: nonNeg(clip.fadeOut),
      gain: 1,
    })),
    ...externalAudioPlacements(externalSources),
  ];

  for (const placement of placements) {
    const source = placement.source;
    const sourceId = source.audioSourceId;
    if (typeof sourceId !== 'string' || !sourceId) continue;
    if (!(placement.trimEnd > placement.trimStart) || placement.gain <= 0) continue;
    const masterPath = typeof source.path === 'string' && source.path ? source.path : '';
    const routes = project.sourceMaps[sourceId]?.channels;
    if (!Array.isArray(routes) || !routes.length) continue;
    // 同一來源在 Media.tracks 可能有非匯出用的 native track；快取 track 只負責讀取
    // 使用者在混音器做的 M/S/音量，不能再把它的低碼率 m4a 路徑交給匯出。
    const tracksByDescriptor = new Map();
    const sourceTracks = mediaTracks.filter(track => track?.file && track.audioSourceId === sourceId && Number.isInteger(track.sourceStream) && Number.isInteger(track.sourceChannel));
    // 保留既有混音器的逐聲道 M/S/音量行為。專案音軌的 M/S/音量會在下方再疊加，
    // 兩層控制與播放預覽一致；同一來源內有 Solo 時只輸出該來源被 Solo 的聲道。
    const sourceHasSolo = sourceTracks.some(track => track.solo);
    for (const track of sourceTracks) {
      const key = track.sourceStream + ':' + track.sourceChannel;
      if (!tracksByDescriptor.has(key)) tracksByDescriptor.set(key, track);
    }
    for (const route of routes) {
      if (!route || route.enabled === false || !Array.isArray(route.busIds)) continue;
      // 被靜音／未指派的專案音軌本來就不會輸出，不需要因為它的快取尚未完成而阻擋匯出。
      const activeBusIds = [...new Set(route.busIds)].filter(busId => busGain.get(busId) > 0 && busById.has(busId));
      if (!activeBusIds.length) continue;
      const sourceStream = Number.isInteger(route.sourceStream) ? route.sourceStream : null;
      const sourceChannel = Number.isInteger(route.sourceChannel) ? route.sourceChannel : null;
      const sourceTrack = sourceStream != null && sourceChannel != null
        ? tracksByDescriptor.get(sourceStream + ':' + sourceChannel) : null;
      if (!masterPath || sourceStream == null || sourceChannel == null) {
        // 沒有可重新讀取的母素材時不能偷偷退回 proxy／AAC cache；明確阻擋匯出。
        unresolvedSources.set(sourceId, source.name || '未命名音訊來源');
        continue;
      }
      // 快取尚未建立時，sourceMaps 已有完整聲道座標，仍可由母素材直接輸出；此時採預設
      // 未靜音、音量 1。快取就緒後才將使用者已設定的個別 M/S/音量一併反映。
      const trackAudible = sourceTrack ? (sourceHasSolo ? !!sourceTrack.solo : !sourceTrack.muted) : !sourceHasSolo;
      const trackGain = sourceTrack ? Math.max(0, Number(sourceTrack.volume == null ? 1 : sourceTrack.volume) || 0) : 1;
      if (!trackAudible || trackGain <= 0) continue;
      const routeGain = Math.max(0, Number(route.gain == null ? 1 : route.gain) || 0);
      for (const busId of activeBusIds) {
        const target = busById.get(busId);
        const volume = trackGain * routeGain * placement.gain * (busGain.get(busId) || 0);
        if (!target || volume <= 0) continue;
        target.plan.inputs.push({
          // 這是母素材，絕不使用 sourceTrack.file（播放／波形的 AAC cache）。
          file: masterPath,
          sourceStream,
          sourceChannel,
          offset: +placement.offset.toFixed(6),
          trimStart: +placement.trimStart.toFixed(6),
          trimEnd: +placement.trimEnd.toFixed(6),
          volume: +volume.toFixed(6),
          fadeIn: +placement.fadeIn.toFixed(6),
          fadeOut: +placement.fadeOut.toFixed(6),
        });
      }
    }
  }
  return {
    buses,
    unresolvedSources: [...unresolvedSources.entries()].map(([audioSourceId, name]) => ({ audioSourceId, name })),
    streams: (Array.isArray(project.exportLayout.streams) ? project.exportLayout.streams : []).map(stream => ({
      id: stream.id,
      layout: stream.layout,
      busIds: Array.isArray(stream.busIds) ? [...stream.busIds] : [],
      ...(typeof stream.name === 'string' && stream.name.trim() ? { name: stream.name.trim() } : {}),
    })),
  };
}

/* ── 對外 ②：整份匯出快照 ─────────────────────────────────────────────── */

/* 匯出資料（v4.11.0 多軌合成）：送扁平片段清單（各含 vtrack 與音訊規格）＋視訊軌
   順序（由下而上）＋總長。主程序據此：每視訊軌各建整條時間軸（片段放 offset、
   間隙透明），由下而上 overlay 疊層；所有片段音訊各自 adelay 到 offset 後 amix
   （全軌混音）。單軌序列為此法之特例，結果與舊版一致。

   輸入全部由呼叫端傳入：
     state                 專案狀態（clips／exportIn／exportOut／externalAudioState／
                           audioProject／videoTracks）
     mediaTracks           Media.tracks（只用來讀 M/S/音量與聲道座標）
     liveExternalSources   Media 目前實際持有的外部音檔素材
     sequenceEnd           影片序列結尾（Seq.end()）

   回傳 null＝沒有任何可匯出的素材。 */
function buildExportSnapshot({ state, mediaTracks = [], liveExternalSources = [], sequenceEnd = 0 } = {}){
  if (!state) return null;
  const rawSourceClips = (Array.isArray(state.clips) ? state.clips : []).filter(c => c.path || c.name || c.web);
  const rawExternalSources = mergeExternalSources(state.externalAudioState, liveExternalSources);

  const expIn = state.exportIn != null ? state.exportIn : 0;
  const rawDur = Math.max(Number(sequenceEnd) || 0, externalAudioTimelineEnd(rawExternalSources));
  let expOut = state.exportOut != null ? state.exportOut : rawDur;
  if (expOut <= expIn) expOut = expIn + 0.1;

  /* 把素材裁到 [expIn, expOut) 並把 offset 歸零到匯出起點。完全在範圍外的回 null。 */
  function slice(c){
    const startProp = c.in != null ? c.in : (c.trimStart || 0);
    const endProp = c.out != null ? c.out : (c.trimEnd != null ? c.trimEnd : c.duration);
    const cDur = endProp - startProp;
    const cEnd = (c.offset || 0) + cDur;
    if (cEnd <= expIn || (c.offset || 0) >= expOut) return null;
    let newIn = startProp, newOut = endProp, newOffset = (c.offset || 0) - expIn;
    if (newOffset < 0) { newIn += (-newOffset); newOffset = 0; }
    const newDur = newOut - newIn;
    if (newOffset + newDur > (expOut - expIn)) newOut = newIn + ((expOut - expIn) - newOffset);
    return { ...c, in: newIn, out: newOut, trimStart: newIn, trimEnd: newOut, offset: newOffset };
  }

  const sourceClips = rawSourceClips.map(slice).filter(Boolean);
  const externalSources = rawExternalSources.map(slice).filter(Boolean);

  const audibleVideoClips = sourceClips.filter(c => !c.audioDetached);
  const externalPlacements = externalAudioPlacements(externalSources);
  if (!sourceClips.length && !externalPlacements.length) return null;

  const audioPlan = buildProjectAudioPlan({
    audioProject: state.audioProject,
    mediaTracks,
    clips: audibleVideoClips,
    externalSources,
  });

  const list = sourceClips.map(c => {
    /* 圖片不是一格影片：主程序必須收到 type=image，才能為該輸入加上
       `-loop 1`。若在這裡遺失型別，ffmpeg 只會讀 PNG/JPG 的第一格，
       看起來就像整支輸出停在開頭。圖片的個別縮放／位置也要一併交給
       匯出 filtergraph，才會和預覽一致。 */
    const image = c.type === 'image';
    return {
      name: c.name, web: c.web,
      path: c.path, type: image ? 'image' : 'video',
      in: +c.in.toFixed(3), out: +c.out.toFixed(3),
      offset: +c.offset.toFixed(3), vtrack: c.vtrack || 0,
      audio: c.audioDetached ? [] : clipAudioSpec(c, mediaTracks),
      fadeIn: +(c.fadeIn || 0).toFixed(3), fadeOut: +(c.fadeOut || 0).toFixed(3), // 轉場：淡入/淡出（秒）
      ...(image ? {
        scale: Math.max(0.01, finite(c.scale, 1)),
        posX: ratio(c.posX, 0.5), posY: ratio(c.posY, 0.5),
        /* 原生尺寸讓主程序能用【與預覽同一條公式】算出精確的 contain 尺寸
           （見 electron/export-plan.js imageBoxForExport ≡ src/imagegeom.js imageBox）。
           舊專案可能沒有這兩個值，主程序會退回讓 ffmpeg 自己算 —— 結果相同，
           只是少了「兩邊用同一份實作」的保證。 */
        natW: Math.max(0, finite(c.natW, 0)), natH: Math.max(0, finite(c.natH, 0)),
      } : {}),
    };
  });

  const vtOrder = [...new Set(list.map(c => c.vtrack))].sort((a, b) => a - b); // 由下而上（vtrack 小＝底層先畫）
  const videoTracks = vtOrder.map(vt => {
    const t = (state.videoTracks || [])[vt] || {};
    return {
      vt,
      scale: +(t.scale != null ? t.scale : 1),
      posX: +(t.posX != null ? t.posX : 0.5),
      posY: +(t.posY != null ? t.posY : 0.5),
      opacity: +(t.opacity != null ? t.opacity : 1),
    };
  });

  return {
    clips: list,
    videoTracks,
    // 匯出會把片段 offset 歸零；保留原始時間軸起點供 burn-in 時碼等交付資訊使用。
    // 不四捨五入：23.976／29.97 的單格不足 0.04 秒，保留完整值才不會讓第一格差一格。
    timelineStart: expIn,
    duration: +(expOut - expIn).toFixed(3),
    audioPlan,
    audioOnly: list.length === 0,
    externalAudioCount: externalPlacements.length,
  };
}

export { buildExportSnapshot, buildProjectAudioPlan };

/* ==============================================================================
   SUB Tool — 專案音訊解讀器（Project Audio Interpretation）
   ==============================================================================
   專案音訊同時存在三層資料：母素材聲道、專案 bus 配線、時間軸 placement。
   預覽、電平表與交付若各自解讀一次，Solo／Mute／gain 很容易在其中一路漂移。

   這個模組是三路共用的純資料邊界：不 import State、Media 或 DOM。呼叫端只交入
   audioProject、目前的媒體聲道與外部素材；所有可聽性與交付 audioPlan 都由這裡
   推導。播放用的逐聲道檔只提供控制狀態，交付永遠重新讀母素材 path。
============================================================================== */

const nonNeg = value => Math.max(0, Number(value) || 0);
const gainValue = (value, fallback = 1) => {
  const numeric = Number(value);
  return Math.max(0, Number.isFinite(numeric) ? numeric : fallback);
};
const descriptorKey = (sourceStream, sourceChannel) => `${sourceStream}:${sourceChannel}`;

function trimRange(asset){
  const trimStart = nonNeg(asset?.in ?? asset?.trimStart);
  const rawEnd = Number(asset?.out ?? asset?.trimEnd ?? asset?.duration);
  return {
    trimStart,
    trimEnd: Number.isFinite(rawEnd) ? Math.max(trimStart, rawEnd) : trimStart,
  };
}

/* enabled=false 的素材仍留在時間軸長度，但不會成為可聽的 placement。 */
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
        gain: gainValue(asset.gain),
      };
    })
    .filter(placement => placement.trimEnd > placement.trimStart);
}

function clipPlacements(clips){
  return (Array.isArray(clips) ? clips : [])
    .filter(clip => clip && !clip.audioDetached)
    .map(clip => ({
      source: clip,
      offset: nonNeg(clip.offset),
      trimStart: nonNeg(clip.in),
      trimEnd: nonNeg(clip.out),
      fadeIn: nonNeg(clip.fadeIn),
      fadeOut: nonNeg(clip.fadeOut),
      gain: 1,
    }));
}

class ProjectAudioInterpretation {
  constructor({ audioProject, mediaTracks = [], externalSources = [] } = {}){
    this.project = audioProject || null;
    this.mediaTracks = Array.isArray(mediaTracks) ? mediaTracks : [];
    this.externalSources = Array.isArray(externalSources) ? externalSources : [];

    /* Solo 是整個專案的聲道狀態，不是「每支母素材各算一次」。_srcHidden 只是
       監聽畫面的暫時來源篩選：預覽須忽略被篩掉來源的 Solo，交付則保留持久語意。 */
    this.anySourceSolo = this.mediaTracks.some(track => !!track?.solo);
    this.anyVisibleSourceSolo = this.mediaTracks.some(track => !!track?.solo && !track?._srcHidden);
    this.externalBySourceId = new Map(this.externalSources
      .filter(asset => typeof asset?.audioSourceId === 'string')
      .map(asset => [asset.audioSourceId, asset]));
    this.busById = new Map((this.project?.buses || []).map(bus => [String(bus.id), bus]));
    this.anyBusSolo = (this.project?.buses || []).some(bus => !!bus?.solo);
  }

  sourceTrackState(track, { respectHidden = true } = {}){
    if (!track || (respectHidden && track._srcHidden)) return { audible: false, gain: 0 };
    const anySolo = respectHidden ? this.anyVisibleSourceSolo : this.anySourceSolo;
    const audible = anySolo ? !!track.solo : !track.muted;
    const gain = audible ? gainValue(track.volume) : 0;
    return { audible: audible && gain > 0, gain };
  }

  busState(busId){
    const bus = this.busById.get(String(busId));
    if (!bus || bus.muted || (this.anyBusSolo && !bus.solo)) return { audible: false, gain: 0 };
    const gain = gainValue(bus.volume);
    return { audible: gain > 0, gain };
  }

  routeForTrack(track){
    const sourceId = track?.audioSourceId;
    if (!sourceId) return null;
    return this.project?.sourceMaps?.[sourceId]?.channels?.find(route =>
      route?.sourceStream === track.sourceStream && route?.sourceChannel === track.sourceChannel
    ) || null;
  }

  placementGain(sourceId){
    const external = this.externalBySourceId.get(sourceId);
    if (!external) return 1;
    return external.enabled === false ? 0 : gainValue(external.gain);
  }

  /* 立體聲監聽會把同一聲道送往多個 bus；取最大有效增益，避免瀏覽器預覽
     把同一個聲道疊加多次。交付端則在 buildDeliveryPlan 逐 bus 完整編譯。 */
  projectRouteState(track){
    const sourceId = track?.audioSourceId;
    const placementGain = this.placementGain(sourceId);
    if (!this.project || !sourceId || !this.project.sourceMaps?.[sourceId]) {
      return { audible: placementGain > 0, gain: placementGain };
    }
    const route = this.routeForTrack(track);
    if (!route || route.enabled === false || placementGain <= 0) return { audible: false, gain: 0 };
    let gain = 0;
    for (const busId of (Array.isArray(route.busIds) ? route.busIds : [])) {
      const bus = this.busState(busId);
      if (!bus.audible) continue;
      gain = Math.max(gain, gainValue(route.gain) * bus.gain);
    }
    gain *= placementGain;
    return { audible: gain > 0, gain };
  }

  trackState(track, options){
    const source = this.sourceTrackState(track, options);
    const route = this.projectRouteState(track);
    const gain = source.gain * route.gain;
    return { audible: source.audible && route.audible && gain > 0, gain };
  }

  routedTracksForBus(busId, { requireAnalyser = true } = {}){
    return this.routedTrackStatesForBus(busId, { requireAnalyser }).map(state => state.track);
  }

  /* 電平表必須吃「該 bus 的編譯結果」，不能拿裸 track 後再猜一次 gain。
     gain 包含來源控制、route、外部 placement 與 bus 四層，與交付編譯同源。 */
  routedTrackStatesForBus(busId, { requireAnalyser = true } = {}){
    const id = String(busId || '');
    const bus = this.busState(id);
    if (!id || !bus.audible) return [];
    const states = [];
    for (const track of this.mediaTracks) {
      if ((requireAnalyser && !track?.analyser) || !track?.audioSourceId) continue;
      const source = this.sourceTrackState(track);
      if (!source.audible) continue;
      const route = this.routeForTrack(track);
      if (!route || route.enabled === false || !Array.isArray(route.busIds)
        || !route.busIds.some(rawId => String(rawId) === id)) continue;
      const gain = source.gain * gainValue(route.gain) * this.placementGain(track.audioSourceId) * bus.gain;
      if (gain > 0) states.push({ track, gain });
    }
    return states;
  }

  buildDeliveryPlan({ clips = [], externalSources = this.externalSources } = {}){
    const project = this.project;
    if (!project || !Array.isArray(project.buses) || !project.buses.length
      || !project.sourceMaps || !project.exportLayout) return null;

    const buses = project.buses.map(bus => ({ id: bus.id, inputs: [] }));
    const planBusById = new Map(project.buses.map((bus, index) => [String(bus.id), buses[index]]));
    const unresolvedSources = new Map();
    const tracksBySource = new Map();

    /* runtime 控制軌一建立就能提供 Solo／Mute／volume；逐聲道 cache 只負責播放，
       不能成為控制狀態是否有效的條件。cache 路徑本身絕不進入 audioPlan。 */
    for (const track of this.mediaTracks) {
      if (!track || typeof track.audioSourceId !== 'string'
        || !Number.isInteger(track.sourceStream) || !Number.isInteger(track.sourceChannel)) continue;
      let tracks = tracksBySource.get(track.audioSourceId);
      if (!tracks) {
        tracks = new Map();
        tracksBySource.set(track.audioSourceId, tracks);
      }
      const key = descriptorKey(track.sourceStream, track.sourceChannel);
      if (!tracks.has(key)) tracks.set(key, track);
    }

    const placements = [
      ...clipPlacements(clips),
      ...externalAudioPlacements(externalSources),
    ];

    for (const placement of placements) {
      const source = placement.source;
      const sourceId = source?.audioSourceId;
      if (typeof sourceId !== 'string' || !sourceId
        || !(placement.trimEnd > placement.trimStart) || placement.gain <= 0) continue;
      const masterPath = typeof source.path === 'string' && source.path ? source.path : '';
      const routes = project.sourceMaps[sourceId]?.channels;
      if (!Array.isArray(routes) || !routes.length) continue;
      const sourceTracks = tracksBySource.get(sourceId) || new Map();

      for (const route of routes) {
        if (!route || route.enabled === false || !Array.isArray(route.busIds)) continue;
        const activeBusIds = [...new Set(route.busIds.map(String))]
          .filter(busId => this.busState(busId).audible && planBusById.has(busId));
        if (!activeBusIds.length) continue;

        const sourceStream = Number.isInteger(route.sourceStream) ? route.sourceStream : null;
        const sourceChannel = Number.isInteger(route.sourceChannel) ? route.sourceChannel : null;
        if (!masterPath || sourceStream == null || sourceChannel == null) {
          unresolvedSources.set(sourceId, source.name || '未命名音訊來源');
          continue;
        }

        const sourceTrack = sourceTracks.get(descriptorKey(sourceStream, sourceChannel));
        /* 如果專案中任何母素材聲道被 Solo，沒有 cache 的其他聲道也必須保持靜音；
           這正是過去交付端按母素材各算一次 Solo 時發生的漂移。 */
        const sourceState = sourceTrack
          ? this.sourceTrackState(sourceTrack, { respectHidden: false })
          : { audible: !this.anySourceSolo, gain: this.anySourceSolo ? 0 : 1 };
        if (!sourceState.audible) continue;
        const routeGain = gainValue(route.gain);

        for (const busId of activeBusIds) {
          const target = planBusById.get(busId);
          const bus = this.busState(busId);
          const volume = sourceState.gain * routeGain * placement.gain * bus.gain;
          if (!target || volume <= 0) continue;
          target.inputs.push({
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
      unresolvedSources: [...unresolvedSources.entries()]
        .map(([audioSourceId, name]) => ({ audioSourceId, name })),
      streams: (Array.isArray(project.exportLayout.streams) ? project.exportLayout.streams : [])
        .map(stream => ({
          id: stream.id,
          layout: stream.layout,
          busIds: Array.isArray(stream.busIds) ? [...stream.busIds] : [],
          ...(typeof stream.name === 'string' && stream.name.trim() ? { name: stream.name.trim() } : {}),
        })),
    };
  }
}

function createProjectAudioInterpretation(options){
  return new ProjectAudioInterpretation(options);
}

function buildProjectAudioPlan({ audioProject, mediaTracks = [], clips = [], externalSources = [] } = {}){
  return createProjectAudioInterpretation({ audioProject, mediaTracks, externalSources })
    .buildDeliveryPlan({ clips, externalSources });
}

export {
  buildProjectAudioPlan,
  createProjectAudioInterpretation,
  externalAudioPlacements,
  trimRange,
};

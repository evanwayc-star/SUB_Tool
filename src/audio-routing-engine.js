/* ==============================================================================
   SUB Tool — Audio Routing & Layout Engine ("src/audio-routing-engine.js")
   ==============================================================================
   深層音訊路由拓撲、聲道佈局與串流引擎 (Audio Routing Engine)。
   嚴格守護鐵律 §0.8（素材聲道／專案總線／匯出串流三者分離）：
   1. 來源聲道展開與標籤生成 (flattenSourceChannels / channelFileName / sourceChannelLabels)
   2. 匯出音訊 Stream 聲道佈局修復器 (OUTPUT_LAYOUT_WIDTH / repairAudioExportStreams)
   3. 媒體播放音訊路由協調器 (MediaAudioRouter)
   ============================================================================== */

import { flattenSourceChannels, channelFileName } from '../shared/channel-layout.cjs';
import { AudioEngine } from './audio-engine.js';
import { Seq } from './sequence.js';
import { scheduleScrub } from './audio-engine.js';
import { normalizeAudioProject, pruneRemovedAudioBuses, ensureAudioSourceMap } from './state.js';
import { MAX_DELIVERY_AUDIO_BUSES, ensureDeliveryAudioExportDefaults, resizeDeliveryAudioBuses } from './export-job-engine.js';
import { sourceChannelDescriptors } from './external-audio.js';

export { flattenSourceChannels, channelFileName };

/**
 * 取得展開後各聲道於 UI 介面上的繁體中文顯示標籤清單。
 */
export function sourceChannelLabels(audio) {
  return flattenSourceChannels(audio).map(c => `聲道${c.index + 1}`);
}

/** 各聲道佈局名稱與所需聲道數寬度對應表 */
export const OUTPUT_LAYOUT_WIDTH = Object.freeze({
  mono: 1,
  stereo: 2,
  stereoLtRt: 2,
  '5.1': 6,
});

/**
 * 檢查並修復音訊匯出 Stream 清單中的佈局配置。
 */
export function repairAudioExportStreams(rawStreams) {
  const streams = Array.isArray(rawStreams) ? rawStreams : [];
  const reservedIds = new Set(streams.map(stream => stream?.id).filter(Boolean));
  const emittedIds = new Set();

  const uniqueGeneratedId = base => {
    let index = 1;
    let id = `${base}-mono-${index}`;
    while (reservedIds.has(id) || emittedIds.has(id)) {
      id = `${base}-mono-${++index}`;
    }
    emittedIds.add(id);
    return id;
  };

  const withoutMisleadingName = stream => {
    const { name, ...rest } = stream || {};
    return rest;
  };

  const repaired = [];
  for (const stream of streams) {
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (!busIds.length) continue;

    const expected = OUTPUT_LAYOUT_WIDTH[stream?.layout];
    if (expected === busIds.length) {
      repaired.push(stream);
      if (stream.id) emittedIds.add(stream.id);
      continue;
    }

    const base = withoutMisleadingName(stream);
    if (busIds.length === 1) {
      repaired.push({ ...base, layout: 'mono', busIds: [busIds[0]] });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    if (busIds.length === 2) {
      repaired.push({ ...base, layout: 'stereo', busIds: busIds.slice() });
      if (base.id) emittedIds.add(base.id);
      continue;
    }

    busIds.forEach((busId, index) => {
      const id = index === 0 && base.id ? base.id : uniqueGeneratedId(base.id || 'out');
      emittedIds.add(id);
      repaired.push({ ...base, id, layout: 'mono', busIds: [busId] });
    });
  }

  return repaired;
}

export class MediaAudioRouter {
  constructor(media, video, stateObj) {
    this.media = media;
    this.video = video;
    this.state = stateObj;
    this._audioEngineBound = false;
  }

  bindEngine() {
    if (this._audioEngineBound) return;
    this._audioEngineBound = true;
    AudioEngine.bind({
      tracks: () => this.media.tracks,
      seqOn: () => this.media.seqOn(),
      playing: () => this.media.playing,
      muted: () => this.state.muted,
      activeSource: () => this.media.activeSource,
      activeClipId: () => this.media.activeClipId,
      playbackRate: () => this.video.playbackRate || 1,
      timelineTime: () => this.media.tlTime(),
      sourceTimeFor: (s, t) => this.media._srcLocalT(s, t),
      externalSourceTimeFor: (s, t) => this.media.externalAudio.sourceTime(s, t),
      clipSourceTimeFor: (t, c) => this.media._transport.sourceTime(t, c),
    });
  }

  ensureCtx() {
    this.bindEngine();
    return AudioEngine.ensureCtx();
  }

  startElementSources(localT, tlT) {
    AudioEngine.startElements(localT, tlT);
  }

  stopElementSources() {
    AudioEngine.stopElements();
  }

  restartElements() {
    if (!this.media.playing) return;
    const c = this.media.seqOn() ? this.media._activeClip() : null;
    const tl = this.media.tlTime();
    this.startElementSources(c ? Seq.toSource(tl, c) : this.media.vTime(), tl);
  }

  startBufferSources(offset) {
    AudioEngine.startBuffers(offset);
  }

  stopBufferSources() {
    AudioEngine.stopBuffers();
  }

  scrubAudio(t, duration = 0.15) {
    const res = AudioEngine.scrub(t, duration);
    if (res && res.scrubMainVideo) {
      if (!this.video.src) return;
      const rate = this.video.playbackRate || 1;
      const preservesPitch = rate >= 0.25 && rate <= 4;
      scheduleScrub(this.video, res.localT, {
        rate,
        preservesPitch,
        isMuted: this.state.muted,
        durationMs: duration * 1000,
      });
    }
  }

  syncDrift() {
    // 呈現切換期間，video/mpv 的來源時間仍可能停在舊畫格。若拿這個停止的
    // clock 校正元素／buffer 音訊，會把同一小段聲音反覆拉回播放。
    if (this.media.presenterClockMoving?.() === false) return;
    if (this.media.tracks.some(t => t.kind === 'buffer' && !t._srcHidden)) {
      AudioEngine.syncBuffers(this.media.vTime(), { inGap: this.media.inGap() });
    }
    for (const tr of this.media.tracks) {
      if (tr.kind === 'element' && tr.el && !tr.el.paused) {
        const s = tr.source || '';
        let ref;
        if (s.startsWith('ext-')) {
          const st = this.media.externalAudio?.sourceTime?.(s, this.media.tlTime());
          if (st == null) {
            try { tr.el.pause(); } catch (e) {}
            continue;
          }
          ref = st;
        } else if (this.media.seqOn()) {
          const lt = this.media.sourceLocalTime(s || 'video', this.media.tlTime());
          if (lt == null) continue;
          ref = lt;
        } else {
          ref = this.media.vTime();
        }

        if (Math.abs(tr.el.currentTime - ref) > 0.12) {
          try { tr.el.currentTime = ref; } catch (e) {}
        }
      }
    }
  }
}

export const LAYOUTS = {
  mono: { label: 'Mono', channels: 1 },
  stereo: { label: 'Stereo (Lt, Rt)', channels: 2 },
  '5.1': { label: '5.1 (L, R, C, LFE, Ls, Rs)', channels: 6 }
};
export const MAX_AUDIO_BUSES = MAX_DELIVERY_AUDIO_BUSES;

export const DELIVERY_PRESETS = [
  { id: '2-fm', label: '２軌道｜2.0-FM', count: 2, streams: [{ layout: 'stereo', name: '2.0-FM' }] },
  { id: '2-me', label: '２軌道(ME)｜2.0-ME', count: 2, streams: [{ layout: 'stereo', name: '2.0-ME' }] },
  { id: '4-me', label: '４軌道(ME)｜2.0FM + 2.0-ME', count: 4, streams: [
    { layout: 'stereo', name: '2.0FM' }, { layout: 'stereo', name: '2.0-ME' }
  ]},
  { id: '4-bi', label: '４軌道(雙語)｜2.0-FM + 2.0-FM', count: 4, streams: [
    { layout: 'stereo', name: '2.0-FM' }, { layout: 'stereo', name: '2.0-FM' }
  ]},
  { id: '6-fm', label: '６軌道｜5.1-FM', count: 6, streams: [{ layout: '5.1', name: '5.1-FM' }] },
  { id: '6-bi-me', label: '６軌道(雙語_ME)｜2.0-FM + 2.0-FM + 2.0-ME', count: 6, streams: [
    { layout: 'stereo', name: '2.0-FM' }, { layout: 'stereo', name: '2.0-FM' }, { layout: 'stereo', name: '2.0-ME' }
  ]},
  { id: '8-fm', label: '８軌道｜5.1-FM + 2.0-FM', count: 8, streams: [
    { layout: '5.1', name: '5.1-FM' }, { layout: 'stereo', name: '2.0-FM' }
  ]},
  { id: '8-fm-rev', label: '８軌道｜2.0-FM + 5.1-FM', count: 8, streams: [
    { layout: 'stereo', name: '2.0-FM' }, { layout: '5.1', name: '5.1-FM' }
  ]},
  { id: '10-me', label: '１０軌道(ME)｜5.1-FM + 2.0-FM + 2.0-ME', count: 10, streams: [
    { layout: '5.1', name: '5.1-FM' }, { layout: 'stereo', name: '2.0-FM' }, { layout: 'stereo', name: '2.0-ME' }
  ]},
  { id: '12-bi', label: '１２軌道(雙語)｜5.1-FM + 5.1-FM', count: 12, streams: [
    { layout: '5.1', name: '5.1-FM' }, { layout: '5.1', name: '5.1-FM' }
  ]},
  { id: '16-bi', label: '１６軌道(雙語)｜5.1-FM + 2.0-FM + 5.1-FM + 2.0-FM', count: 16, streams: [
    { layout: '5.1', name: '5.1-FM' }, { layout: 'stereo', name: '2.0-FM' },
    { layout: '5.1', name: '5.1-FM' }, { layout: 'stereo', name: '2.0-FM' }
  ]}
];

export function layoutWidth(layout) {
  return LAYOUTS[layout]?.channels || 1;
}

export function monoStreamsForBuses(buses) {
  return buses.map((bus, index) => ({
    id: `mono-${index + 1}`,
    layout: 'mono',
    name: `A${index + 1} Mono`,
    busIds: [bus.id]
  }));
}

export function deliveryStreamsForPreset(preset, buses) {
  let cursor = 0;
  return preset.streams.map((spec, index) => {
    const width = layoutWidth(spec.layout);
    const busIds = buses.slice(cursor, cursor + width).map(bus => bus.id);
    cursor += width;
    return {
      id: `delivery-${preset.id}-${index + 1}`,
      layout: spec.layout,
      name: spec.name,
      busIds
    };
  });
}

export function resizeProjectAudioBuses(projectDraft, rawCount) {
  const original = structuredClone(projectDraft || {});
  let project = normalizeAudioProject(original);
  const normalizedChanged = JSON.stringify(project) !== JSON.stringify(original);
  project.buses = Array.isArray(project.buses) ? project.buses : [];
  const count = Math.max(0, Math.min(MAX_AUDIO_BUSES, Math.floor(Number(rawCount) || 0)));
  if (count === project.buses.length) return { changed: normalizedChanged, project };

  if (count > project.buses.length) {
    project.mode = 'manual';
    const hadLayout = !!project.exportLayout?.streams?.length;
    while (project.buses.length < count) project.buses.push({});
    project = normalizeAudioProject(project);
    if (!hadLayout) {
      project.exportLayout = {
        streams: [{
          id: 'out1',
          layout: count === 1 ? 'mono' : 'stereo',
          busIds: project.buses.slice(0, count === 1 ? 1 : 2).map(bus => bus.id),
        }],
      };
    }
    return { changed: true, project };
  }

  const removedIds = new Set(project.buses.slice(count).map(bus => bus.id));
  pruneRemovedAudioBuses(project, removedIds);
  project.mode = 'manual';
  project.buses = project.buses.slice(0, count);
  project.exportLayout = {
    ...(project.exportLayout || {}),
    streams: repairAudioExportStreams(project.exportLayout?.streams),
  };
  return { changed: true, project };
}

export class AudioRoutingModel {
  static createProjectAdapter(projectDraft) {
    let p = structuredClone(projectDraft);
    
    return {
      current() { return p; },
      
      setBusCount(rawCount) {
        const transition = resizeProjectAudioBuses(p, rawCount);
        p = transition.project;
        return transition.changed;
      },
      
      setStreams(streams) {
        p.exportLayout = { streams: structuredClone(streams) };
      },
      
      applyAllMonoLayout() {
        if (!p.buses.length) return false;
        p.exportLayout = { streams: monoStreamsForBuses(p.buses) };
        return true;
      },
      
      applyDeliveryPreset(preset) {
        const oldLayout = structuredClone(p.exportLayout);
        if (p.buses.length > preset.count) {
          p.exportLayout = { streams: deliveryStreamsForPreset(preset, p.buses.slice(0, preset.count)) };
          if (!this.setBusCount(preset.count)) {
            p.exportLayout = oldLayout;
            return false;
          }
        } else if (p.buses.length < preset.count) {
          this.setBusCount(preset.count);
        } else {
          p.mode = 'manual';
        }
        p.exportLayout = { streams: deliveryStreamsForPreset(preset, p.buses) };
        return true;
      },
      
      addStream() {
        const used = new Set(p.exportLayout.streams.map(stream => stream.id));
        let n = 1, id = 'out' + n;
        while (used.has(id)) { n++; id = 'out' + n; }
        p.exportLayout.streams.push({ id, layout: 'mono', busIds: [] });
      }
    };
  }

  static createDeliveryAdapter(deliveryDraft) {
    let draft = structuredClone(deliveryDraft || { buses: [], streams: [] });
    draft = ensureDeliveryAudioExportDefaults(draft, { appendMissing: false });
    
    return {
      current() { return { mode: 'manual', buses: draft.buses || [], exportLayout: { streams: draft.streams || [] } }; },
      result() { return structuredClone(draft); },
      
      setBusCount(rawCount) {
        const beforeCount = (draft.buses || []).length;
        const before = JSON.stringify(draft.buses || []);
        draft = resizeDeliveryAudioBuses(draft, rawCount);
        if ((draft.buses || []).length > beforeCount) {
          draft = ensureDeliveryAudioExportDefaults(draft, { appendMissing: true });
        }
        return JSON.stringify(draft.buses || []) !== before;
      },
      
      setStreams(streams) {
        draft = { ...draft, streams: structuredClone(streams) };
      },
      
      applyAllMonoLayout() {
        if (!(draft.buses || []).length) return false;
        draft = { ...draft, streams: monoStreamsForBuses(draft.buses) };
        return true;
      },
      
      applyDeliveryPreset(preset) {
        const candidate = resizeDeliveryAudioBuses(draft, preset.count);
        if ((candidate.buses || []).length < preset.count) {
          return { error: `此專案只有 ${(candidate.availableBuses || candidate.buses || []).length} 條可用音訊軌，無法套用 ${preset.label}。` };
        }
        draft = { ...candidate, streams: deliveryStreamsForPreset(preset, candidate.buses) };
        return true;
      },
      
      addStream() {
        const used = new Set((draft.streams || []).map(stream => String(stream.id)));
        let n = 1, id = 'delivery-out-' + n;
        while (used.has(id)) { n++; id = 'delivery-out-' + n; }
        draft = { ...draft, streams: [...(draft.streams || []), { id, layout: 'mono', busIds: [] }] };
      },
      
      syncWavBusIds() {
        const seen = new Set();
        draft = {
          ...draft,
          wavBusIds: (draft.streams || [])
            .flatMap(stream => Array.isArray(stream?.busIds) ? stream.busIds : [])
            .map(id => String(id))
            .filter(id => id && !seen.has(id) && (seen.add(id), true))
        };
      }
    };
  }
}

class AudioPipelineManager {
  /**
   * 登錄某素材的來源聲道，回傳正規化後的 descriptor 陣列。
   * @param {object} clip 素材（需有 audioSourceId 或 audioSrc）
   * @param {Array} channels ffprobe／ingest 得到的聲道清單
   * @param {number} fallbackCount channels 為空時的聲道數推測值
   */
  registerSource(clip, channels, fallbackCount = 0) {
    if (!clip) return [];
    const sourceId = clip.audioSourceId || clip.audioSrc || null;
    if (!sourceId) return [];
    const descriptors = sourceChannelDescriptors(channels, fallbackCount);
    ensureAudioSourceMap(sourceId, descriptors);
    return descriptors;
  }

  /** 由聲道 descriptor 導出 track 上的來源座標（audioSourceId / sourceStream / sourceChannel）。 */
  sourceDescriptorFor(clip, channel, index = 0) {
    const sourceId = clip?.audioSourceId || clip?.audioSrc || null;
    return {
      audioSourceId: sourceId,
      sourceStream: Math.max(0, Math.floor(Number(channel?.sourceStream ?? 0) || 0)),
      sourceChannel: Math.max(0, Math.floor(Number(channel?.sourceChannel ?? index) || 0)),
    };
  }

  /**
   * 取得專案音訊總線之標準化串流佈局。
   * @param {object} audioProject 專案音訊物件（可選，預設讀取 State.audioProject）
   */
  getStreamLayout(audioProject = null) {
    const proj = audioProject || null;
    return proj?.exportLayout?.streams || [];
  }
}

export const AudioPipeline = new AudioPipelineManager();
export { AudioPipelineManager };

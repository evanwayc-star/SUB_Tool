/* ensureAudioBusCount / ensureAudioExportDefaults 曾在這裡被 import 卻從未使用
   （本專案刻意關閉 no-unused-vars，所以沒有任何東西會提醒）。已移除。 */
import { normalizeAudioProject, pruneRemovedAudioBuses } from './state.js';
import { MAX_DELIVERY_AUDIO_BUSES, ensureDeliveryAudioExportDefaults, resizeDeliveryAudioBuses } from './delivery-audio.js';
import { repairAudioExportStreams } from './audio-stream-layout.js';

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

/* 專案音訊 bus 的增減只有這一份 transition。來源配線對話框與輸出設定對話框
   都必須經過它，否則「同樣改成 6 軌」會在不同入口留下不同 exportLayout。 */
export function resizeProjectAudioBuses(projectDraft, rawCount) {
  const original = structuredClone(projectDraft || {});
  let project = normalizeAudioProject(original);
  const normalizedChanged = JSON.stringify(project) !== JSON.stringify(original);
  project.buses = Array.isArray(project.buses) ? project.buses : [];
  const count = Math.max(0, Math.min(MAX_AUDIO_BUSES, Math.floor(Number(rawCount) || 0)));
  if (count === project.buses.length) return { changed: normalizedChanged, project };

  if (count > project.buses.length) {
    project.mode = 'manual';
    /* 【不要自己捏 bus】
       state.js 是 id、名稱、音量與高度的唯一擁有者；推空物件再正規化，才能避免
       某個 UI 路徑產生不完整 bus、另一個 UI 路徑產生完整 bus。 */
    const hadLayout = !!project.exportLayout?.streams?.length;
    while (project.buses.length < count) project.buses.push({});
    project = normalizeAudioProject(project);
    /* 專案原本完全沒有輸出設定時，1 bus 建立 mono、2 bus 以上維持本編輯器
       既有的 stereo 預設；已有編組則必須原樣保留，不能因「增加 bus」偷換 layout。 */
    if (!hadLayout) {
      project.exportLayout = {
        streams: [{
          id: 'out1',
          // A 1-bus project is a valid mono delivery, not malformed stereo.
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

/**
 * Pure model for AudioRouting state transitions
 */
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

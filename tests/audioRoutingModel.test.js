import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AudioRoutingModel, DELIVERY_PRESETS, resizeProjectAudioBuses } from '../src/audio-routing-engine.js';
import { normalizeAudioProject } from '../src/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _normalizeAudioPlan } = require('../electron/export-plan.js');

/* 餵給模型的 bus 必須是 state.js 真的會產生的形狀。

   這支測試以前餵的是 `{ id: 'bus-1', locked: false }`——一個 state.js
   **從來不會產生**的形狀（真的那份是 `{id:'abN', name, visible, locked,
   muted, solo, volume, height}`）。而模型內部也自己捏了同樣的假形狀，
   於是測試與被測程式互相印證同一份分叉，跟真正的呼叫端不相交。
   那正是 docs/技術架構說明.md §0.1 記過的反模式：
   「契約測試必須執行到真的那一份實作」。

   現在改用 normalizeAudioProject() 產生初始狀態——它就是 State 的擁有者。 */
const realProject = busCount => normalizeAudioProject({
  mode: 'manual',
  buses: Array.from({ length: busCount }, () => ({})),
  exportLayout: { streams: [] },
});

describe('AudioRoutingModel - Project Adapter', () => {
  it('clones state and applies preset safely', () => {
    const initialState = { ...realProject(2), exportLayout: { streams: [] } };

    const adapter = AudioRoutingModel.createProjectAdapter(initialState);
    const preset = DELIVERY_PRESETS.find(p => p.id === '6-fm'); // requires 6 buses
    
    const success = adapter.applyDeliveryPreset(preset);
    expect(success).toBe(true);
    
    const result = adapter.current();
    expect(result.buses.length).toBe(6);
    expect(result.exportLayout.streams.length).toBe(1);
    expect(result.exportLayout.streams[0].name).toBe('5.1-FM');
    expect(result.exportLayout.streams[0].layout).toBe('5.1');
    expect(result.exportLayout.streams[0].busIds.length).toBe(6);
    
    // Ensure original state is untouched
    expect(initialState.buses.length).toBe(2);
  });

  it('can manually add a stream', () => {
    const adapter = AudioRoutingModel.createProjectAdapter({
      buses: [{ id: 'bus-1' }],
      exportLayout: { streams: [] }
    });
    
    adapter.addStream();
    const result = adapter.current();
    expect(result.exportLayout.streams.length).toBe(1);
    expect(result.exportLayout.streams[0].id).toBe('out1');
  });
});

describe('AudioRoutingModel - Delivery Adapter', () => {
  it('applies mono layout to delivery draft', () => {
    const adapter = AudioRoutingModel.createDeliveryAdapter({
      buses: [{ id: 'bus-1' }, { id: 'bus-2' }],
      streams: []
    });
    
    adapter.applyAllMonoLayout();
    const res = adapter.result();
    expect(res.streams.length).toBe(2);
    expect(res.streams[0].layout).toBe('mono');
    expect(res.streams[1].layout).toBe('mono');
  });
});

/* 模型產生的 bus 必須與 state.js 的擁有者同形。

   壞掉的樣子（v6.1.2 之前的真實狀態）：使用者把專案音訊軌從 2 條加到 6 條，
   新的四條被寫進 State 時長這樣 `{id:'bus-3', locked:false}`——沒有 name、
   沒有 volume、沒有 height。混音器讀 volume 得到 undefined、讀 name 得到空白。
   而且 state.js 的 _cleanId 會保留 'bus-3' 當合法 id，所以它不會被修正；
   直到某條路徑碰巧呼叫 normalizeAudioProject()，那四條才突然改名成
   「音訊軌 N」、音量被重設成 1——使用者看到的是「設定自己跳掉了」。 */
describe('新增的 bus 與 state.js 的擁有者同形', () => {
  const FIELDS = ['id', 'name', 'visible', 'locked', 'muted', 'solo', 'volume', 'height'];

  it('setBusCount 加出來的 bus 具備全部欄位，且 id 是 state.js 的格式', () => {
    const adapter = AudioRoutingModel.createProjectAdapter(realProject(2));
    expect(adapter.setBusCount(5)).toBe(true);

    const buses = adapter.current().buses;
    expect(buses.length).toBe(5);
    for (const bus of buses) {
      expect(Object.keys(bus).sort()).toEqual([...FIELDS].sort());
      expect(bus.id, `id 應為 state.js 的 ab<N> 格式，實際是 ${bus.id}`).toMatch(/^ab\d+$/);
      expect(typeof bus.name).toBe('string');
      expect(bus.name.length).toBeGreaterThan(0);
      expect(typeof bus.volume).toBe('number');
      expect(typeof bus.height).toBe('number');
    }
  });

  it('id 不重複（_normalBus 以 used 集合避開既有 id）', () => {
    const adapter = AudioRoutingModel.createProjectAdapter(realProject(3));
    adapter.setBusCount(8);
    const ids = adapter.current().buses.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('再跑一次 normalizeAudioProject 不會改變任何東西（已經是正規形狀）', () => {
    const adapter = AudioRoutingModel.createProjectAdapter(realProject(2));
    adapter.setBusCount(6);
    const after = adapter.current();
    expect(normalizeAudioProject(after).buses).toEqual(after.buses);
  });

  it('原本就沒有輸出設定時，仍套用本編輯器的 stereo 預設（行為未變）', () => {
    const adapter = AudioRoutingModel.createProjectAdapter({ ...realProject(0), exportLayout: { streams: [] } });
    adapter.setBusCount(4);
    const layout = adapter.current().exportLayout;
    expect(layout.streams.length).toBe(1);
    expect(layout.streams[0].layout).toBe('stereo');
    expect(layout.streams[0].busIds.length).toBe(2);
  });

  it('只有一條 bus 時建立可交付的 mono stream，而不是壞掉的單聲道 stereo', () => {
    const transition = resizeProjectAudioBuses({ ...realProject(0), exportLayout: { streams: [] } }, 1);
    const layout = transition.project.exportLayout;
    expect(layout.streams).toEqual([{ id: 'out1', layout: 'mono', busIds: [transition.project.buses[0].id] }]);
    expect(() => _normalizeAudioPlan({
      buses: transition.project.buses.map(bus => ({ id: bus.id, inputs: [] })),
      streams: layout.streams,
    })).not.toThrow();
  });

  it('Stereo 從兩條 bus 縮成一條時同步降為可交付的 Mono', () => {
    const project = realProject(2);
    project.exportLayout = {
      streams: [{ id: 'out1', layout: 'stereo', name: '2.0-FM', busIds: project.buses.map(bus => bus.id) }],
    };
    const transition = resizeProjectAudioBuses(project, 1);
    const streams = transition.project.exportLayout.streams;

    expect(streams).toEqual([{ id: 'out1', layout: 'mono', busIds: [transition.project.buses[0].id] }]);
    expect(() => _normalizeAudioPlan({
      buses: transition.project.buses.map(bus => ({ id: bus.id, inputs: [] })),
      streams,
    })).not.toThrow();
  });

  it('載入舊專案時修復單 bus Stereo，即使 bus 數沒有再變動', () => {
    const base = realProject(1);
    const bus = base.buses[0];
    const legacy = {
      ...base,
      exportLayout: { streams: [{ id: 'out1', layout: 'stereo', name: '舊 2.0', busIds: [bus.id] }] },
    };
    const normalized = normalizeAudioProject(legacy);
    expect(normalized.exportLayout.streams).toEqual([{ id: 'out1', layout: 'mono', busIds: [bus.id] }]);
    expect(() => _normalizeAudioPlan({
      buses: normalized.buses.map(item => ({ id: item.id, inputs: [] })),
      streams: normalized.exportLayout.streams,
    })).not.toThrow();

    const transition = resizeProjectAudioBuses(legacy, 1);
    expect(transition.changed).toBe(true);
    expect(transition.project.exportLayout.streams[0]).toMatchObject({ layout: 'mono', busIds: [bus.id] });
  });

  it('5.1 縮成非標準聲道數時拆成有效 Mono streams，不遺失存活 bus', () => {
    const project = realProject(6);
    project.exportLayout = {
      streams: [{ id: 'surround', layout: '5.1', name: '5.1-FM', busIds: project.buses.map(bus => bus.id) }],
    };
    const transition = resizeProjectAudioBuses(project, 5);
    const streams = transition.project.exportLayout.streams;

    expect(streams).toHaveLength(5);
    expect(streams.every(stream => stream.layout === 'mono' && stream.busIds.length === 1)).toBe(true);
    expect(streams.flatMap(stream => stream.busIds)).toEqual(transition.project.buses.map(bus => bus.id));
    expect(() => _normalizeAudioPlan({
      buses: transition.project.buses.map(bus => ({ id: bus.id, inputs: [] })),
      streams,
    })).not.toThrow();
  });

  it('已有兩條 bus 的不完整 5.1 會安全修復為 Stereo，不會被 mono 預設蓋掉', () => {
    const base = realProject(2);
    base.exportLayout = { streams: [{ id: 'out1', layout: '5.1', busIds: base.buses.map(b => b.id) }] };
    const adapter = AudioRoutingModel.createProjectAdapter(base);
    adapter.setBusCount(6);
    const layout = adapter.current().exportLayout;
    expect(layout.streams.length).toBe(1);
    expect(layout.streams[0].layout).toBe('stereo');
    expect(layout.streams[0].busIds).toEqual(base.buses.map(bus => bus.id));
  });
});

describe('專案 bus 數量只有一個 transition', () => {
  it('來源配線與輸出設定共用 resize 規則，會保留既有輸出編組', () => {
    const project = realProject(2);
    project.exportLayout = {
      streams: [{ id: 'program', layout: 'stereo', busIds: project.buses.map(bus => bus.id) }],
    };

    const direct = resizeProjectAudioBuses(project, 6);
    const editor = AudioRoutingModel.createProjectAdapter(project);
    expect(editor.setBusCount(6)).toBe(true);

    expect(direct.changed).toBe(true);
    expect(direct.project.buses).toHaveLength(6);
    expect(editor.current().buses).toHaveLength(6);
    expect(direct.project.buses.map(bus => bus.id)).toEqual(expect.arrayContaining(project.buses.map(bus => bus.id)));
    expect(editor.current().buses.map(bus => bus.id)).toEqual(expect.arrayContaining(project.buses.map(bus => bus.id)));
    expect(direct.project.exportLayout.streams).toEqual([
      { id: 'program', layout: 'stereo', busIds: project.buses.map(bus => bus.id) },
    ]);
    expect(editor.current().exportLayout.streams).toEqual(direct.project.exportLayout.streams);
  });

  it('來源配線面板委派給共享 transition，而不是再手寫一套增減規則', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'audio-routing.js'), 'utf8');
    const body = source.slice(source.indexOf('function setBusCount'));
    const fn = body.slice(0, body.indexOf('\nfunction routeTableHtml'));

    expect(fn).toMatch(/resizeProjectAudioBuses\(project\(\),rawCount\)/);
    expect(fn).not.toMatch(/ensureAudioBusCount\(/);
    expect(fn).not.toMatch(/pruneRemovedAudioBuses\(/);
  });
});

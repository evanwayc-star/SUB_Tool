import { describe, it, expect } from 'vitest';
import { AudioRoutingModel, DELIVERY_PRESETS } from '../src/audio-routing-model.js';
import { normalizeAudioProject } from '../src/state.js';

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

  it('已有輸出設定時不可被正規化器的 mono 預設蓋掉', () => {
    const base = realProject(2);
    base.exportLayout = { streams: [{ id: 'out1', layout: '5.1', busIds: base.buses.map(b => b.id) }] };
    const adapter = AudioRoutingModel.createProjectAdapter(base);
    adapter.setBusCount(6);
    const layout = adapter.current().exportLayout;
    expect(layout.streams.length).toBe(1);
    expect(layout.streams[0].layout).toBe('5.1');
  });
});

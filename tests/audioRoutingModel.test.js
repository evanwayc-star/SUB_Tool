import { describe, it, expect } from 'vitest';
import { AudioRoutingModel, DELIVERY_PRESETS } from '../src/audio-routing-model.js';

describe('AudioRoutingModel - Project Adapter', () => {
  it('clones state and applies preset safely', () => {
    const initialState = {
      mode: 'manual',
      buses: [{ id: 'bus-1', locked: false }, { id: 'bus-2', locked: false }],
      exportLayout: { streams: [] }
    };
    
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

import { describe, expect, it } from 'vitest';
import {
  MAX_DELIVERY_AUDIO_BUSES,
  applyDeliveryAudioSpec,
  composeDeliveryAudioPlan,
  createDeliveryAudioSpec,
  ensureDeliveryAudioExportDefaults,
  resizeDeliveryAudioBuses,
} from '../src/export-job-engine.js';

describe('交付音訊規格', () => {
  it('從專案與交付列建立彼此獨立的音訊規格快照', () => {
    const project = {
      buses: [
        { id: 'a1', name: 'A1', volume: 1 },
        { id: 'a2', name: 'A2', volume: 1 },
      ],
      exportLayout: {
        streams: [{ id: 'project-stereo', layout: 'stereo', busIds: ['a1', 'a2'] }],
      },
    };
    const record = {
      audioBuses: [{ id: 'a2', name: 'Right', volume: 0.8 }],
      audioPlan: { streams: [{ id: 'delivery-mono', layout: 'mono', busIds: ['a2'] }] },
      wavBusIds: ['a2'],
    };

    const spec = createDeliveryAudioSpec(project, record);

    expect(spec).toEqual({
      buses: [{ id: 'a2', name: 'Right', volume: 0.8 }],
      streams: [{ id: 'delivery-mono', layout: 'mono', busIds: ['a2'] }],
      wavBusIds: ['a2'],
      availableBuses: [
        { id: 'a1', name: 'A1', volume: 1 },
        { id: 'a2', name: 'A2', volume: 1 },
      ],
    });
    spec.buses[0].name = 'Edited only in delivery';
    spec.streams[0].busIds.push('a1');
    expect(record.audioBuses[0].name).toBe('Right');
    expect(record.audioPlan.streams[0].busIds).toEqual(['a2']);
    expect(project.buses).toHaveLength(2);
    expect(spec.availableBuses.map(bus => bus.id)).toEqual(['a1', 'a2']);
  });

  it('以交付列的 Stereo 編組重組 A7/A8 時保留母素材聲道 inputs', () => {
    const compiled = {
      buses: Array.from({ length: 8 }, (_, index) => ({
        id: `a${index + 1}`,
        inputs: [{
          file: 'C:/master/program.mxf', sourceStream: 0, sourceChannel: index,
          offset: 0, trimStart: 0, trimEnd: 10, volume: 1, fadeIn: 0, fadeOut: 0,
        }],
      })),
      streams: [{ id: 'all-mono', layout: 'mono', busIds: ['a1'] }],
    };
    const delivery = {
      audioBuses: compiled.buses.map(bus => ({ id: bus.id, name: bus.id, volume: 1 })),
      audioPlan: { streams: [{ id: 'program', layout: 'stereo', busIds: ['a7', 'a8'] }] },
    };

    const finalPlan = composeDeliveryAudioPlan(compiled, delivery);

    expect(finalPlan.buses[6].inputs[0]).toMatchObject({
      file: 'C:/master/program.mxf', sourceStream: 0, sourceChannel: 6,
    });
    expect(finalPlan.buses[7].inputs[0]).toMatchObject({
      file: 'C:/master/program.mxf', sourceStream: 0, sourceChannel: 7,
    });
    expect(finalPlan.streams).toEqual([{ id: 'program', layout: 'stereo', busIds: ['a7', 'a8'] }]);
    expect(compiled.buses[6].inputs[0].sourceChannel).toBe(6);
    expect(compiled.streams).toEqual([{ id: 'all-mono', layout: 'mono', busIds: ['a1'] }]);
  });

  it('在交付列縮減 bus 時只產生新規格，不會改動專案的 buses 或來源配線', () => {
    const project = {
      buses: [
        { id: 'a1', name: 'A1' },
        { id: 'a2', name: 'A2' },
        { id: 'a3', name: 'A3' },
      ],
      sourceMaps: {
        source: { channels: [{ sourceStream: 0, sourceChannel: 0, busIds: ['a3'] }] },
      },
      exportLayout: {
        streams: [
          { id: 'one', layout: 'mono', busIds: ['a1'] },
          { id: 'three', layout: 'mono', busIds: ['a3'] },
        ],
      },
    };
    const spec = createDeliveryAudioSpec(project, {});

    const resized = resizeDeliveryAudioBuses(spec, 2);
    const record = applyDeliveryAudioSpec({ format: 'h264', customName: 'delivery.mp4' }, resized);

    expect(resized.buses.map(bus => bus.id)).toEqual(['a1', 'a2']);
    expect(resized.streams).toEqual([{ id: 'one', layout: 'mono', busIds: ['a1'] }]);
    expect(record).toMatchObject({
      format: 'h264', customName: 'delivery.mp4',
      audioBuses: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
      audioPlan: { streams: [{ id: 'one', layout: 'mono', busIds: ['a1'] }] },
    });
    expect(project.buses.map(bus => bus.id)).toEqual(['a1', 'a2', 'a3']);
    expect(project.sourceMaps.source.channels[0].busIds).toEqual(['a3']);
  });

  it('空白交付規格只在自己的草稿建立 Mono 預設，不會補回專案設定', () => {
    const project = { buses: [{ id: 'a1' }, { id: 'a2' }], exportLayout: { streams: [] } };
    const spec = createDeliveryAudioSpec(project, {});

    const withDefaults = ensureDeliveryAudioExportDefaults(spec, { appendMissing: false });

    expect(withDefaults.streams).toEqual([
      { id: 'delivery-stream-1', layout: 'mono', busIds: ['a1'] },
      { id: 'delivery-stream-2', layout: 'mono', busIds: ['a2'] },
    ]);
    expect(spec.streams).toEqual([]);
    expect(project.exportLayout.streams).toEqual([]);
  });

  it('交付列 bus 數量與專案層共用硬上限，且只能取用編譯前已存在的 bus', () => {
    const availableBuses = Array.from({ length: MAX_DELIVERY_AUDIO_BUSES + 1000 }, (_, index) => ({ id: `a${index + 1}` }));
    const resized = resizeDeliveryAudioBuses({ buses: [], streams: [], availableBuses }, MAX_DELIVERY_AUDIO_BUSES + 1000);

    expect(resized.buses).toHaveLength(MAX_DELIVERY_AUDIO_BUSES);
    expect(resized.buses.at(-1).id).toBe(`a${MAX_DELIVERY_AUDIO_BUSES}`);
  });

  it('不會讓交付列憑空建立無聲 bus，舊草稿引用未知 bus 時明確拒絕', () => {
    const project = { buses: [{ id: 'a1' }, { id: 'a2' }], exportLayout: { streams: [] } };
    const spec = createDeliveryAudioSpec(project, {});
    const resized = resizeDeliveryAudioBuses(spec, 8);
    expect(resized.buses.map(bus => bus.id)).toEqual(['a1', 'a2']);

    expect(() => composeDeliveryAudioPlan({
      buses: [{ id: 'a1', inputs: [{ file: 'master.mxf' }] }, { id: 'a2', inputs: [{ file: 'master.mxf' }] }],
      streams: [],
    }, {
      audioBuses: [{ id: 'a1' }, { id: 'a2' }, { id: 'delivery-bus-3' }],
    })).toThrow('不存在的專案音軌');
  });
});

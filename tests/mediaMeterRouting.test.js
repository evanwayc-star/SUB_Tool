// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ readAudioMeter: vi.fn(), stopAudioMeter: vi.fn() }));
vi.mock('../src/state.js', async original => ({ ...await original(), DESK: bridge }));
vi.mock('../src/dom.js', () => ({ video: { style: {}, playbackRate: 1, hasAttribute: () => false }, $: () => null }));
vi.mock('../src/ui.js', () => ({ renderCurrentTimecode: vi.fn(), setStatus: vi.fn(), showToast: vi.fn(),
  openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
let Media, State, clock;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  ({ Media } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
  vi.spyOn(Media, 'mpvMode', 'get').mockReturnValue(true);
  vi.spyOn(Media, 'presenterClockMoving').mockReturnValue(true);
  vi.spyOn(Media, 'presentationPending').mockReturnValue(false);
  vi.spyOn(Media, 'inGap').mockReturnValue(false);
  vi.spyOn(Media, 'sourceMuted').mockReturnValue(false);
  vi.spyOn(Media, 'vTime').mockReturnValue(10);
  vi.spyOn(Media, 'tlTime').mockReturnValue(10);
  vi.spyOn(Media, 'audioSourceRate').mockReturnValue(1);
  State.muted = false;
  State.clips = [{ id: 'clip', primary: true, path: 'C:/mother.mov', audioSourceId: 'mother', in: 0, out: 20 }];
  Media.activeClipId = 'clip'; Media.activeSource = null; Media.externalAudioSources = [];
  State.audioProject = {
    buses: [{ id: 'a', volume: .5 }, { id: 'b', volume: 1 }],
    sourceMaps: {
      mother: { channels: [
        { sourceStream: 0, sourceChannel: 0, gain: .25, enabled: true, busIds: ['a', 'b'] },
        { sourceStream: 1, sourceChannel: 0, gain: .5, enabled: true, busIds: ['a'] },
      ] },
      external: { channels: [{ sourceStream: 0, sourceChannel: 0, gain: 1, enabled: true, busIds: ['a'] }] },
    },
  };
  Media.tracks = [
    ...[.5, .25].map((volume, sourceStream) => ({ kind: 'native', source: 'video', audioSourceId: 'mother',
      sourceStream, sourceChannel: 0, volume })),
    { kind: 'element', source: 'external', audioSourceId: 'external', sourceStream: 0, sourceChannel: 0,
      volume: 1, analyser: {} },
  ];
  bridge.readAudioMeter.mockImplementation(async request => ({ time: request.time,
    levels: [0, 1].map(sourceStream => ({ sourceStream, sourceChannel: 0, level: .6 })),
    busLevels: request.mixes.map(({ busId, inputs }) => ({ busId, level: inputs.reduce((sum, input) => sum + input.gain * .6, 0) })),
  }));
});
afterEach(() => { Media?.clearNativeMeter(); vi.restoreAllMocks(); });

describe('原生音量表使用同一份專案 bus 配線', () => {
  it('完整增益送入 native 混音，只保留目前母素材 inputs，snapshot 不寫回持久聲道', async () => {
    const original = [...Media.tracks];
    Media.projectAudioInterpretation({ metering: true }); await flush();
    expect(bridge.readAudioMeter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: 'C:/mother.mov', time: 10, rate: 1,
      mixes: [
        { busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: .0625 }, { sourceStream: 1, sourceChannel: 0, gain: .0625 }] },
        { busId: 'b', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: .125 }] },
      ],
    }));
    const inputs = Media.projectAudioInterpretation({ metering: true }).routedTrackStatesForBus('a', { requireAnalyser: false });
    expect(inputs).toHaveLength(3);
    const native = inputs.filter(({ track }) => track.kind === 'native');
    expect(native).toHaveLength(2);
    expect(native[0].track.meterBusLevels).toBe(native[1].track.meterBusLevels);
    expect(native[0].track.meterBusLevels[0]).toEqual({ busId: 'a', level: .075 });
    expect(Media.tracks).toEqual(original);
    expect(Media.tracks.every(track => !('meterBusLevels' in track) && !('meterPeak' in track))).toBe(true);

    clock = 100; State.audioProject.buses[1].solo = true;
    Media.projectAudioInterpretation({ metering: true }); await flush();
    expect(bridge.readAudioMeter.mock.calls[1][0].mixes).toEqual([
      { busId: 'b', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: .125 }] },
    ]);
    expect(bridge.stopAudioMeter).not.toHaveBeenCalled();
  });

  it.each(['mute', 'pause', 'cache'])('%s 清理原生取樣且重複畫面更新不重送停止', async reason => {
    Media.projectAudioInterpretation({ metering: true }); await flush();
    if (reason === 'mute') State.muted = true;
    if (reason === 'pause') Media.presenterClockMoving.mockReturnValue(false);
    if (reason === 'cache') Media.tracks.push({ ...Media.tracks[0], kind: 'element', analyser: {} });
    for (let index = 0; index < 5; index++) Media.projectAudioInterpretation({ metering: true });
    expect(bridge.stopAudioMeter).toHaveBeenCalledOnce();
    expect(bridge.readAudioMeter).toHaveBeenCalledOnce();
  });

  it.each(['bus-mute', 'bus-zero', 'route-disabled'])('%s 令原生 meter 無輸入時停止取樣，重新開啟後只恢復當前配線', async reason => {
    const original = [...Media.tracks], external = original[2];
    Media.projectAudioInterpretation({ metering: true }); await flush();
    if (reason === 'bus-mute') for (const bus of State.audioProject.buses) bus.muted = true;
    if (reason === 'bus-zero') for (const bus of State.audioProject.buses) bus.volume = 0;
    if (reason === 'route-disabled') for (const route of State.audioProject.sourceMaps.mother.channels) route.enabled = false;
    for (let index = 1; index <= 4; index++) {
      clock = index * 100;
      const view = Media.projectAudioInterpretation({ metering: true });
      await flush();
      expect(view.mediaTracks).toContain(external);
      const audible = view.routedTrackStatesForBus('a', { requireAnalyser: false });
      expect(audible.map(({ track }) => track)).toEqual(reason === 'route-disabled' ? [external] : []);
    }
    expect(bridge.stopAudioMeter).toHaveBeenCalledOnce();
    expect(bridge.readAudioMeter).toHaveBeenCalledOnce();
    expect(Media.tracks).toEqual(original);
    expect(original.every(track => !('meterBusLevels' in track) && !('meterPeak' in track))).toBe(true);

    // One source/channel becomes observable again, while every other route
    // stays unavailable. The decoder receives only this current interpretation.
    State.audioProject.buses[0].muted = false;
    State.audioProject.buses[0].volume = .5;
    State.audioProject.buses[1].muted = true;
    State.audioProject.sourceMaps.mother.channels[0].enabled = true;
    State.audioProject.sourceMaps.mother.channels[1].enabled = false;
    clock = 500;
    Media.projectAudioInterpretation({ metering: true }); await flush();
    expect(bridge.readAudioMeter).toHaveBeenCalledTimes(2);
    expect(bridge.readAudioMeter.mock.calls[1][0].mixes).toEqual([
      { busId: 'a', inputs: [{ sourceStream: 0, sourceChannel: 0, gain: .0625 }] },
    ]);
    const restored = Media.projectAudioInterpretation({ metering: true });
    const measured = restored.routedTrackStatesForBus('a', { requireAnalyser: false }).find(({ track }) => track.kind === 'native');
    expect(measured.track.meterBusLevels).toEqual([{ busId: 'a', level: .0375 }]);
    expect(restored.mediaTracks).toContain(external);
    expect(Media.tracks).toEqual(original);
  });
});

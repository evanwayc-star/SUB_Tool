// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { State, ensureAudioSourceMap, resetAudioProject } from '../src/state.js';
import { AudioRouting } from '../src/audio-routing.js';

const modal = vi.hoisted(() => ({ actions: [] }));
vi.mock('../src/media.js', () => ({ Media: { applyGains: vi.fn(), tracks: [] } }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  openModal: (_title, html, actions) => { document.body.innerHTML = html; modal.actions = actions; },
  closeModal: vi.fn(), showToast: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetAudioProject();
  ensureAudioSourceMap('master', Array.from({ length: 8 }, (_, sourceChannel) => ({ sourceStream: 0, sourceChannel })));
  ensureAudioSourceMap('second', [{ sourceStream: 1, sourceChannel: 0 }]);
  State.audioProject.sourceMaps.second.channels[0].busIds = [State.audioProject.buses[7].id];
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

it('輸出設定縮減專案音軌後取消，恢復所有來源配線', () => {
  const initial = structuredClone(State.audioProject);
  AudioRouting.openOutputSettings();
  vi.runAllTimers();
  document.querySelector('.audio-output-count-preset[data-count="4"]').click();
  vi.runAllTimers();
  expect(State.audioProject.buses).toHaveLength(4);
  modal.actions.find(action => action.label === '取消').act();
  expect(State.audioProject).toEqual(initial);
});

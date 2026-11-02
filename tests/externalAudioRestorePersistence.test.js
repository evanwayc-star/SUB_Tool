// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let Media, State, History, Project, resetProject, desk;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const source = id => ({ audioSourceId: id, name: id, path: `C:/${id}.wav`, duration: 8, in: 0, out: 8, offset: 0 });
const decode = call => JSON.parse(Buffer.from(call[1], 'base64').subarray(2).toString('utf16le'));

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}) }));
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 }, channelCount: 1 });
  vi.stubGlobal('AudioContext', class {
    constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    createGain() { return node(); }
    createAnalyser() { return { ...node(), fftSize: 1024 }; }
    createMediaElementSource() { return node(); }
    createChannelSplitter() { return node(); }
    createChannelMerger() { return node(); }
    resume() {}
  });
  vi.stubGlobal('Audio', class extends EventTarget {
    constructor() { super(); this.src = ''; this.readyState = 1; this.duration = 8; this.currentTime = 0; this.playbackRate = 1; }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    removeAttribute() {}
  });
  desk = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    saveProject: vi.fn(async () => 'C:/project.subtool'), writeProject: vi.fn(async file => file),
    probe: vi.fn(), fileURL: vi.fn(async file => `file:///${file}`) };
  window.subtool = desk;
  ({ State } = await import('../src/state.js'));
  ({ Media } = await import('../src/media.js'));
  ({ History } = await import('../src/history.js'));
  ({ Project, resetProject } = await import('../src/project.js'));
  Media.reset(); State.cues = []; State.notes = []; State.duration = 0;
});

afterEach(() => {
  Media.reset(); resetProject();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete window.subtool; delete HTMLElement.prototype.scrollIntoView;
});

function undoTwoSources() {
  const first = source('first'), second = { ...source('second'), offset: 20 };
  const gates = new Map([['first', deferred()], ['second', deferred()]]);
  // Only the native probe and browser audio primitives are substituted. Undo,
  // source loaders, runtime synchronization and Project.saveAs remain real.
  desk.probe.mockImplementation(file => gates.get(file.includes('first') ? 'first' : 'second').promise);
  Media.externalAudio.add(first); Media.externalAudio.add(second);
  Media.recomputeTimelineDuration(); Project.establishCleanBaseline(); History.reset();
  for (const asset of [...Media.externalAudioSources]) Media.removeExternalAudio(asset.id, { record: false });
  History.record('刪除兩筆外音'); History.undo();
  expect(State.externalAudioState.map(item => item.audioSourceId)).toEqual(['first', 'second']);
  return { gates, ready: id => gates.get(id).resolve({ duration: 8, audio: [{ channels: 1 }] }) };
}

it('Undo 復原兩筆外音時，先完成一筆仍須將另一筆待重建來源保存到專案', async () => {
  const { ready } = undoTwoSources();
  ready('first');
  await vi.waitFor(() => expect(Media.externalAudioSources.map(item => item.audioSourceId)).toEqual(['first']));
  expect(State.externalAudioEnd).toBe(28);
  expect(State.duration).toBe(28);
  await Project.saveAs();
  const saved = decode(desk.saveProject.mock.calls.at(-1));
  expect(saved.duration).toBe(28);
  desk.fileURL.mockRejectedValueOnce(new Error('來源暫時離線'));
  ready('second');
  await vi.waitFor(() => expect(desk.fileURL).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(1);
  expect(Media.externalAudioSources.map(item => item.audioSourceId)).toEqual(['first']);
  expect(State.externalAudioEnd).toBe(28);
  expect(State.duration).toBe(28);
  expect(saved.externalAudioSources.map(item => item.audioSourceId)).toEqual(['first', 'second']);
  expect(History.snap().externalAudioState.map(item => item.audioSourceId)).toEqual(['first', 'second']);
  await Project.saveAs();
  expect(decode(desk.saveProject.mock.calls.at(-1)).externalAudioSources.map(item => item.audioSourceId)).toEqual(['first', 'second']);
});

it('來源已登錄但音訊節點建立失敗時，清理半成品仍須保留待復原的專案資料', async () => {
  const { ready } = undoTwoSources();
  ready('first');
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const remove = vi.spyOn(Media, 'removeExternalAudio');
  const { AudioEngine } = await import('../src/audio-engine.js');
  const split = vi.spyOn(AudioEngine.context, 'createChannelSplitter').mockImplementationOnce(() => { throw new Error('音訊節點建立失敗'); });
  ready('second');
  await vi.waitFor(() => expect(split).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1);
  expect(remove).toHaveBeenCalledWith('external:second', { record: false });
  expect(warning).toHaveBeenCalled();
  expect(Media.externalAudioSources.map(item => item.audioSourceId)).toEqual(['first']);
  await Project.saveAs();
  const saved = decode(desk.saveProject.mock.calls.at(-1));
  expect(saved.externalAudioSources.map(item => item.audioSourceId)).toEqual(['first', 'second']);
  expect(saved.duration).toBe(28);
});

it('待重建來源保留期間明確刪除已就緒外音，後續完成與保存都不補回已刪除來源', async () => {
  const { ready } = undoTwoSources();
  ready('first');
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  Media.removeExternalAudio(Media.externalAudioSources[0].id);
  History.record('明確刪除 first');
  ready('second');
  await vi.waitFor(() => expect(Media.externalAudioSources.map(item => item.audioSourceId)).toEqual(['second']));
  await Project.saveAs();
  expect(decode(desk.saveProject.mock.calls.at(-1)).externalAudioSources.map(item => item.audioSourceId)).toEqual(['second']);
  expect(History.snap().externalAudioState.map(item => item.audioSourceId)).toEqual(['second']);
});

it.each(['redo', 'reset', 'keep-external'])('待重建外音在 %s 後晚到，依工作區政策保留或移除專案內容', async action => {
  const { ready } = undoTwoSources();
  if (action === 'redo') History.redo();
  else if (action === 'keep-external') Media.reset({ keepExternalAudio: true });
  else { Media.reset(); resetProject(); }
  ready('first'); ready('second');
  await Promise.all(desk.probe.mock.results.map(result => result.value));
  await vi.advanceTimersByTimeAsync(1);
  await Project.saveAs();
  expect(Media.externalAudioSources).toHaveLength(0);
  const expected = action === 'keep-external' ? ['first', 'second'] : [];
  expect(decode(desk.saveProject.mock.calls.at(-1)).externalAudioSources.map(item => item.audioSourceId)).toEqual(expected);
  expect(History.snap().externalAudioState.map(item => item.audioSourceId)).toEqual(expected);
});

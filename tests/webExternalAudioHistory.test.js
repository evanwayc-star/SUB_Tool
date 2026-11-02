// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/decode/source-frame-index.js', async importOriginal => ({
  ...await importOriginal(), sourcePresentationMetadata: async () => null,
}));

let Media, State, History, Wave;
const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 }, channelCount: 1 });

beforeEach(async () => {
  vi.resetModules();
  delete window.subtool;
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}) }));
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
    constructor() { super(); this.tagName = 'AUDIO'; this.src = ''; this.readyState = 4; this.duration = 8; this.currentTime = 0; this.playbackRate = 1; }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    removeAttribute() {}
  });
  let nextURL = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:web-audio-${++nextURL}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  ({ State } = await import('../src/state.js'));
  ({ Media } = await import('../src/media.js'));
  ({ History } = await import('../src/history.js'));
  ({ Wave } = await import('../src/waveform-decoder.js'));
  vi.spyOn(Wave, 'fromFile').mockResolvedValue(true);
  Media.reset(); State.cues = []; State.notes = []; State.duration = 0;
  History.reset();
});

afterEach(() => {
  Media.reset();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete HTMLElement.prototype.scrollIntoView;
});

it('網頁外音刪除後 Undo 及 Redo 重新加入，保留原 File、範圍與實際播放軌', async () => {
  const file = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  const asset = await Media.addAudioFile(file, { in: 1, out: 6, offset: 2, speed: 2, reverse: true, height: 96 });
  History.record('加入音訊');
  const saved = History.snap().externalAudioState[0];
  const oldElement = Media.tracks[0].el;
  expect(saved).not.toHaveProperty('_file');
  expect(asset._file).toBe(file);
  expect(Media.removeExternalAudio(asset.id)).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:web-audio-1');
  expect(Media.objectURLs).toHaveLength(0);
  History.record('刪除音訊');
  History.undo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]).toMatchObject({ audioSourceId: saved.audioSourceId, in: 1, out: 6, offset: 2, speed: 2, reverse: true, height: 96 });
  expect(Media.externalAudioSources[0]._file).toBe(file);
  expect(Media.tracks).toHaveLength(1);
  expect(Media.tracks[0].el).not.toBe(oldElement);
  History.redo();
  expect(Media.externalAudioSources).toHaveLength(0);
  expect(Media.objectURLs).toHaveLength(0);
  History.undo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]._file).toBe(file);
  History.undo();
  expect(Media.externalAudioSources).toHaveLength(0);
  History.redo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]._file).toBe(file);
  expect(Media.tracks).toHaveLength(1);
  expect(Media.objectURLs).toHaveLength(1);
});

it('網頁音訊匯入的 Undo／Redo 保留 File，但輸出快照及專案純資料不含 runtime 參照', async () => {
  const file = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  const asset = await Media.addAudioFile(file);
  History.record('加入音訊');
  History.undo();
  expect(Media.externalAudioSources).toHaveLength(0);
  expect(Media.objectURLs).toHaveLength(0);
  History.redo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]._file).toBe(file);
  expect(Media.tracks).toHaveLength(1);
  expect(History.snap().externalAudioState[0]).toMatchObject({ audioSourceId: asset.audioSourceId, path: null });
  expect(JSON.stringify(History.stack)).not.toMatch(/_file|_objectURL|blob:web-audio/);
  expect(JSON.stringify(State.externalAudioState)).not.toMatch(/_file|_objectURL|blob:web-audio/);
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

it('等待 File 重建期間的字幕編輯快照繼承來源資格，之後仍可 Undo 刪除', async () => {
  const file = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  const asset = await Media.addAudioFile(file);
  History.record('加入音訊');
  Media.removeExternalAudio(asset.id); History.record('刪除音訊');
  const metadata = await import('../src/decode/source-frame-index.js');
  const gate = deferred();
  const inspect = vi.spyOn(metadata, 'sourcePresentationMetadata').mockImplementationOnce(() => gate.promise);
  History.undo();
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
  expect(Media.externalAudioSources).toHaveLength(0);
  State.cues.push({ id: 'new-line', text: '等待期間編輯', start: 0, end: 1, track: 0 });
  History.record('字幕編輯');
  gate.resolve(null);
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  Media.removeExternalAudio(asset.id); History.record('再次刪除音訊');
  History.undo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]._file).toBe(file);
  expect(State.cues[0].text).toBe('等待期間編輯');
  expect(Media.tracks).toHaveLength(1);
});

it('換工作區清除 File 資格並撤銷尚未完成的舊 Undo，舊快照不能復活音訊', async () => {
  const file = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  const asset = await Media.addAudioFile(file);
  History.record('加入音訊');
  const oldSnapshot = History.stack.at(-1).snap;
  Media.removeExternalAudio(asset.id); History.record('刪除音訊');
  const metadata = await import('../src/decode/source-frame-index.js');
  const gate = deferred();
  const inspect = vi.spyOn(metadata, 'sourcePresentationMetadata').mockImplementationOnce(() => gate.promise);
  History.undo();
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
  Media.reset(); History.reset();
  gate.resolve(null);
  await vi.waitFor(() => expect(Media.objectURLs).toHaveLength(0));
  expect(Media.externalAudioSources).toHaveLength(0);
  expect(Media.tracks).toHaveLength(0);
  Media.restoreExternalAudioEditState(oldSnapshot.externalAudioState, oldSnapshot);
  await Promise.resolve();
  expect(Media.externalAudioSources).toHaveLength(0);
  expect(Media.tracks).toHaveLength(0);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
});

it('同工作區先刪外音再載入第一支影片，既有 History 仍能 Undo 復原原 File', async () => {
  const file = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  const asset = await Media.addAudioFile(file);
  History.record('加入音訊');
  Media.removeExternalAudio(asset.id); History.record('刪除音訊');
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(8);
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (tag === 'video') queueMicrotask(() => element.dispatchEvent(new Event('loadedmetadata')));
    return element;
  });
  vi.spyOn(Media, 'probeAndMaybeExtract').mockResolvedValue(true);
  await Media.loadVideoFile(new File(['video'], 'first.mp4', { type: 'video/mp4' }));
  expect(State.clips).toHaveLength(1);
  History.undo();
  await vi.waitFor(() => expect(Media.externalAudioSources).toHaveLength(1));
  expect(Media.externalAudioSources[0]._file).toBe(file);
  expect(Media.tracks.some(track => track.source === asset.audioSrc)).toBe(true);
});

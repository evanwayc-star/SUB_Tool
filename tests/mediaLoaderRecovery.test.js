// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const dom = vi.hoisted(() => {
  const video = { style: {}, src: '', readyState: 1, duration: 12, videoWidth: 1920, videoHeight: 1080,
    playbackRate: 1, currentTime: 0, muted: false, hasAttribute: () => false, pause: vi.fn() };
  const elements = new Map();
  return { video, $(id) {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '', value: '',
      addEventListener: vi.fn(), removeEventListener: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() },
      querySelectorAll: () => [], querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) });
    return elements.get(id);
  } };
});
const desk = vi.hoisted(() => ({
  stat: vi.fn(async () => ({ exists: true, size: 1024 })),
  probe: vi.fn(async () => ({ duration: 12, video: { codec: 'prores', fps: 25 }, audio: [] })),
  mediaSourceKey: vi.fn(async () => 'a'.repeat(16)),
  ingest: vi.fn(), fileURL: vi.fn(), cancelMediaIntake: vi.fn(async () => 1), releaseStream: vi.fn(async () => {}),
}));
vi.mock('../src/dom.js', () => dom);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', async original => ({ renderCurrentTimecode: (await original()).renderCurrentTimecode,
  setStatus: vi.fn(), showToast: vi.fn(), showOsd: vi.fn(), openModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));
vi.mock('../src/subtitles.js', () => ({ selectCueSingle: vi.fn(), commitCueTimeEdit: vi.fn() }));
vi.mock('../src/subtitle-model.js', () => ({ addCue: vi.fn(), cueTrackLocked: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/notes.js', () => ({ updateNoteActive: vi.fn() }));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let Media, State, jobs, adapter, resetPlayerAdapter, recordHistory, setStatus;
beforeAll(async () => {
  Object.defineProperty(window, 'subtool', { configurable: true, value: { isDesktop: true, ...desk } });
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
    createAnalyser() { return { connect: vi.fn(), fftSize: 0 }; }
    createMediaElementSource() { return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
    createChannelSplitter() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createChannelMerger() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    resume() {}
  };
  ({ Media } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
  ({ MediaIntakeJobs: jobs } = await import('../src/media-intake-jobs.js'));
  ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
  ({ recordHistory } = await import('../src/history.js'));
  ({ setStatus } = await import('../src/ui.js'));
});
beforeEach(() => {
  vi.clearAllMocks();
  Media.reset(); State.clips = []; State.mediaPath = null;
  State.cues = [{ id: 'keep', start: 1, end: 2, text: '保留字幕', track: 0 }];
  Media.ctx = null; Media.master = null; Media.tracks = [];
  dom.video.src = ''; dom.video.readyState = 1; dom.video.onerror = null;
  delete window.subtool.streamIngest;
  desk.ingest.mockResolvedValue({ cached: true, proxy: 'C:/cache/proxy.mp4', channels: [] });
  desk.fileURL.mockImplementation(async file => `file:///${file}`);
  adapter = resetPlayerAdapter(window.subtool, dom.video);
});
afterEach(() => { Media.reset(); vi.restoreAllMocks(); });

const cases = [
  ['stream', 'activate'], ['stream', 'metadata'],
  ['batch', 'url'], ['batch', 'activate'], ['batch', 'metadata'], ['batch', 'seek'],
];
function useStream() {
  window.subtool.streamIngest = vi.fn(async () => ({ cached: true, streamUrl: 'http://127.0.0.1/stream', streamLeaseId: 'owned-stream', channels: [] }));
}
it.each(cases)('%s IPC 成功後 %s 失敗仍保留重試，成功重試不改字幕或 History', async (branch, phase) => {
  if (branch === 'stream') useStream();
  const message = `fixture ${phase} failed`;
  if (phase === 'url') desk.fileURL.mockRejectedValueOnce(new Error(message));
  if (phase === 'activate') vi.spyOn(adapter, 'enterHtml5').mockRejectedValueOnce(new Error(message));
  if (phase === 'seek') vi.spyOn(adapter, 'seekElement').mockRejectedValueOnce(new Error(message));
  if (phase === 'metadata') dom.video.readyState = 0;
  const cues = structuredClone(State.cues), history = recordHistory.mock.calls.length;
  const loading = Media.loadDesktopMedia('C:/media/movie.mxf').catch(error => error);
  if (phase === 'metadata') {
    await vi.waitFor(() => expect(dom.video.onerror).toBeTypeOf('function'));
    dom.video.onerror();
  }
  await loading;
  const recovery = jobs.snapshot().recoveries[0];
  expect(recovery).toMatchObject({ path: 'C:/media/movie.mxf', status: 'failed' });
  expect(recovery.message).toContain(phase === 'metadata' ? 'metadata' : message);
  expect(State.clips).toEqual([]);
  if (branch === 'stream') expect(desk.releaseStream).toHaveBeenCalledWith('owned-stream');
  dom.video.readyState = 1;
  expect(await jobs.retry(recovery.id)).toBe(true);
  await vi.waitFor(() => expect(jobs.snapshot().recoveries).toEqual([]));
  expect(State.clips).toHaveLength(1);
  expect(State.clips[0].path).toBe('C:/media/movie.mxf');
  expect(State.cues).toEqual(cues);
  expect(recordHistory.mock.calls).toHaveLength(history);
});

it.each(['new-source', 'new-workspace'])('舊 Proxy URL 失敗晚於 %s 不回寫舊 recovery 或狀態', async mode => {
  const gate = deferred(); desk.fileURL.mockImplementationOnce(() => gate.promise);
  const old = Media.loadDesktopMedia('C:/media/old.mxf').catch(error => error);
  await vi.waitFor(() => expect(desk.fileURL).toHaveBeenCalled());
  if (mode === 'new-source') await Media.loadDesktopMedia('C:/media/new.mxf');
  else { Media.reset(); State.mediaPath = 'C:/workspace/new.mxf'; State.clips = []; }
  const path = State.mediaPath, clips = [...State.clips], calls = setStatus.mock.calls.length;
  gate.reject(new Error('old URL failure')); await old;
  expect(jobs.snapshot().recoveries).toEqual([]);
  expect(State.mediaPath).toBe(path); expect(State.clips).toEqual(clips);
  expect(setStatus.mock.calls).toHaveLength(calls);
});

it.each(['stream', 'batch'])('%s 音訊載入失敗後原地替換母素材，舊重試不得把原檔掛回新來源', async branch => {
  const channels = [{ file: 'C:/cache/audio.wav', sourceStream: 0, sourceChannel: 0 }];
  if (branch === 'stream') {
    useStream(); window.subtool.streamIngest.mockResolvedValue({ cached: true, streamUrl: 'http://127.0.0.1/stream', channels });
  } else desk.ingest.mockResolvedValueOnce({ cached: true, proxy: 'C:/cache/proxy.mp4', channels });
  vi.spyOn(Media._intakeSession, 'materializeAudioElements').mockRejectedValueOnce(new Error('audio metadata unavailable'));
  await Media.loadDesktopMedia('C:/media/original.mxf');
  await vi.waitFor(() => expect(jobs.snapshot().recoveries).toHaveLength(1));
  const recovery = jobs.snapshot().recoveries[0], primary = State.clips[0], count = desk.ingest.mock.calls.length;
  primary.path = 'C:/media/replacement.mxf';
  expect(await jobs.retry(recovery.id)).toBe(false);
  expect(desk.ingest.mock.calls).toHaveLength(count);
  expect(jobs.snapshot().recoveries).toEqual([]);
  expect(primary.path).toBe('C:/media/replacement.mxf');
});

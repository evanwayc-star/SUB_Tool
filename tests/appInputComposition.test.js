// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Project, Media, addCue, status, startup, api;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function finishStatus() {
  status.resolve({ ffmpeg: true, venc: 'libx264' });
  await vi.waitFor(() => expect(api.getStartupFile).toHaveBeenCalledOnce());
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) }));
  status = deferred(); startup = deferred();
  api = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [],
    status: vi.fn(() => status.promise), getStartupFile: vi.fn(() => startup.promise),
    onProgress: vi.fn(), onQueueStatus: vi.fn(), onOpenFile: vi.fn(), onAppRequestClose: vi.fn(),
    stat: async () => ({ exists: false }) };
  window.subtool = api;
  ({ State } = await import('../src/state.js'));
  ({ Project } = await import('../src/project.js'));
  ({ Media } = await import('../src/media.js'));
  ({ addCue } = await import('../src/subtitle-model.js'));
  vi.spyOn(Project, '_isFontAvailable').mockReturnValue(true);
  await import('../src/app.js');
  await vi.waitFor(() => expect(api.status).toHaveBeenCalledOnce());
});

afterEach(() => {
  if (Media) { Media.playing = false; Media.resetPresentationSession('test-finished'); }
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete window.subtool;
  delete HTMLElement.prototype.scrollIntoView;
});


it.each([
  ['note', { isComposing: true }], ['note', { keyCode: 229 }],
  ['player', { isComposing: true }], ['player', { keyCode: 229 }],
])('%s 時碼的組字按鍵保留草稿與時間，一般 Enter 才提交 (%j)', async (mode, composition) => {
  await finishStatus(); startup.resolve(null); await vi.advanceTimersByTimeAsync(100);
  const { History } = await import('../src/history.js');
  State.fps = 25; State.dropFrame = false; State.duration = 20;
  State.notes = [{ id: 'note', time: 10, text: '備註', done: false }];
  await Media.seek(5); History.reset();
  window.SUB.renderNotes();
  const target = document.querySelector(mode === 'note' ? '.nt-time' : '#tcCur');
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const input = target.querySelector('input'); expect(input).toBeTruthy(); input.value = '12';
  for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown']) {
    const event = new KeyboardEvent('keydown', { key, ...composition, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(input.isConnected).toBe(true);
    expect(input.value).toBe('12'); expect(State.notes[0].time).toBe(10);
    expect(Media.displayTime()).toBe(5); expect(History.stack).toHaveLength(1);
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(input.isConnected).toBe(false);
  expect(State.notes[0].time).toBe(mode === 'note' ? 12 / 25 : 10);
  expect(Media.displayTime()).toBe(mode === 'player' ? 12 / 25 : 5);
  expect(History.stack).toHaveLength(mode === 'note' ? 2 : 1);
  if (mode === 'note') { History.undo(); expect(State.notes[0].time).toBe(10); }
});

it.each(['searchInput', 'replaceInput'])('%s 舊式組字 Enter 不導覽或取代，一般 Enter 仍執行', async id => {
  await finishStatus(); startup.resolve(null); await vi.advanceTimersByTimeAsync(100);
  const { History } = await import('../src/history.js');
  State.fps = 25; State.duration = 20;
  addCue(1, 2, '原文一', 0); addCue(3, 4, '原文二', 0); History.reset();
  const search = document.getElementById('searchInput');
  search.value = '原文'; search.dispatchEvent(new Event('input', { bubbles: true }));
  const initialSelection = State.selectedId;
  const input = document.getElementById(id); if (id === 'replaceInput') input.value = '新文';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  expect(State.selectedId).toBe(initialSelection);
  expect(State.cues.map(cue => cue.text)).toEqual(['原文一', '原文二']);
  expect(History.stack).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  if (id === 'searchInput') expect(State.selectedId).not.toBe(initialSelection);
  else {
    expect(State.cues.find(cue => cue.id === initialSelection).text).toBe('新文二');
    expect(State.cues[0].text).toBe('原文一'); expect(History.stack).toHaveLength(2);
  }
});

it.each([{ isComposing: true }, { keyCode: 229 }])('百分比欄組字 Enter 不批次修改字幕時長 (%j)', async composition => {
  await finishStatus(); startup.resolve(null); await vi.advanceTimersByTimeAsync(100);
  const { History } = await import('../src/history.js');
  State.fps = 25; State.duration = 20;
  addCue(1, 2, '字幕', 0); History.reset();
  const input = document.getElementById('durAdjPctInput'); input.value = '200';
  const event = new KeyboardEvent('keydown', { key: 'Enter', ...composition, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(State.cues[0].end).toBe(2); expect(History.stack).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(State.cues[0].end).toBe(3); expect(History.stack).toHaveLength(2);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Project, Media, addCue, isProjectDirty, status, startup, api;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function project(text) {
  const data = { app: 'SUB Tool', version: 3, fps: 25, tracks: [{ name: '對白', visible: true }],
    cues: [{ start: 1, end: 2, text, track: 1 }], notes: [], clips: [], videoTracks: [], media: {} };
  return { path: `C:/${text}.subtool`, b64: Buffer.concat([
    Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64') };
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
  ({ Project, isProjectDirty } = await import('../src/project.js'));
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

it.each(['engine-status', 'startup-read'])('啟動等待 %s 期間提交的字幕必須先確認才能捨棄', async phase => {
  if (phase === 'startup-read') await finishStatus();
  addCue(0, 2, 'USER_EDIT', 0);
  expect(isProjectDirty()).toBe(true);
  if (phase === 'engine-status') await finishStatus();
  startup.resolve(project('FROM_STARTUP'));
  await vi.waitFor(() => expect(document.getElementById('modalBody').textContent).toContain('未儲存'));
  const cancel = [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '取消');
  cancel.click();
  expect(State.cues.map(cue => cue.text)).toEqual(['USER_EDIT']);
  expect(isProjectDirty()).toBe(true);
});

it('沒有較新操作的冷啟動仍直接載入並建立乾淨基線', async () => {
  await finishStatus(); startup.resolve(project('FROM_STARTUP'));
  await vi.waitFor(() => expect(State.cues.map(cue => cue.text)).toEqual(['FROM_STARTUP']));
  expect(isProjectDirty()).toBe(false);
  expect(document.getElementById('modalBody').textContent).not.toContain('未儲存');
});

it('等待引擎狀態期間較新的開檔意圖保有權威', async () => {
  await Project.open(async () => project('NEWER_PROJECT'));
  await finishStatus(); startup.resolve(project('STALE_STARTUP'));
  await vi.advanceTimersByTimeAsync(100);
  expect(State.cues.map(cue => cue.text)).toEqual(['NEWER_PROJECT']);
  expect(isProjectDirty()).toBe(false);
});

it('沒有啟動檔時不對等待期間新增的字幕顯示無效捨棄確認', async () => {
  addCue(0, 2, 'USER_EDIT', 0);
  await finishStatus(); startup.resolve(null);
  await vi.advanceTimersByTimeAsync(100);
  expect(State.cues.map(cue => cue.text)).toEqual(['USER_EDIT']);
  expect(document.getElementById('modalBody').textContent).not.toContain('未儲存');
});

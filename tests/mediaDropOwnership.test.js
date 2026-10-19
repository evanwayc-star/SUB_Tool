// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Project, Media, resetProject, closeModal, authorization;
const desktop = { isDesktop: true, authorizeDroppedFile: vi.fn(), getFilePath: vi.fn() };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function drop(file) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  document.dispatchEvent(event);
}

function projectRequest(text) {
  const data = { app: 'SUB Tool', version: 3, fps: 25, tracks: [{ name: 'S1' }],
    cues: [{ start: 0, end: 1, text, track: 1 }], notes: [], clips: [], videoTracks: [], media: {} };
  return { path: 'C:/newer.subtool', b64: Buffer.concat([
    Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64') };
}

beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  Object.defineProperty(window, 'subtool', { configurable: true, value: desktop });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) }));
  ({ State } = await import('../src/state.js'));
  ({ Project, resetProject } = await import('../src/project.js'));
  ({ Media } = await import('../src/media.js'));
  ({ closeModal } = await import('../src/ui.js'));
  await import('../src/subio.js');
  // Only native/browser media loading is substituted; drop routing, project ownership,
  // the incoming-media choice, subtitle model and History are production modules.
  vi.spyOn(Media, 'loadDesktopMedia').mockResolvedValue(true);
  vi.spyOn(Media, 'loadVideoFile').mockResolvedValue(true);
  vi.spyOn(Project, '_isFontAvailable').mockReturnValue(true);
});

beforeEach(() => {
  closeModal(); resetProject();
  delete desktop.openDroppedProject;
  Object.assign(State, { clips: [], cues: [], tracks: [{ name: 'S1', visible: true, locked: false }],
    trackCount: 1, videoTracks: [{ name: 'V1', visible: true }], notes: [],
    externalAudioState: [], duration: 0, mediaName: null, mediaPath: null });
  Project.establishCleanBaseline();
  Media.loadDesktopMedia.mockClear(); Media.loadVideoFile.mockClear();
  authorization = deferred();
  desktop.authorizeDroppedFile.mockReset().mockImplementation(() => authorization.promise);
  desktop.getFilePath.mockReset().mockReturnValue('C:/legacy.mov');
});

afterAll(() => {
  closeModal(); resetProject(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete window.subtool; delete HTMLElement.prototype.scrollIntoView;
});

it.each(['reset', 'newer-project-load'])('原生授權期間 %s 撤銷舊 drop，授權路徑與 File fallback 都不得入載', async replacement => {
  for (const authorizedPath of ['C:/old-workspace/old.mov', null]) {
    drop(new File(['old video'], 'old.mov', { type: 'video/quicktime' }));
    expect(desktop.authorizeDroppedFile).toHaveBeenCalled();
    if (replacement === 'reset') {
      resetProject(); State.cues = [{ id: 'new', start: 0, end: 1, text: 'NEW_PROJECT', track: 0 }];
    } else await Project.loadDesktop(projectRequest('NEW_PROJECT'));
    authorization.resolve(authorizedPath);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(Media.loadDesktopMedia).not.toHaveBeenCalled();
    expect(Media.loadVideoFile).not.toHaveBeenCalled();
    expect(State.cues.map(cue => cue.text)).toEqual(['NEW_PROJECT']);
    authorization = deferred();
  }
});

it.each(['C:/current.mov', null])('同一工作區仍接受正常授權結果 %s', async authorizedPath => {
  const file = new File(['video'], 'current.mov', { type: 'video/quicktime' });
  drop(file); authorization.resolve(authorizedPath);
  await vi.waitFor(() => expect(authorizedPath ? Media.loadDesktopMedia : Media.loadVideoFile).toHaveBeenCalledOnce());
  if (authorizedPath) expect(Media.loadDesktopMedia).toHaveBeenCalledWith(authorizedPath);
  else expect(Media.loadVideoFile).toHaveBeenCalledWith(file);
});

it('原生授權完成後，已開啟的加入/取代選擇仍保有原 drop 的工作區資格', async () => {
  State.clips = [{ id: 'existing', type: 'video', name: 'existing.mov', in: 0, out: 1, offset: 0 }];
  drop(new File(['video'], 'incoming.mov')); authorization.resolve('C:/incoming.mov');
  await vi.waitFor(() => expect(document.getElementById('modalTitle').textContent).toBe('已載入影片'));
  const replace = [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '取代目前影片');
  resetProject(); replace.click();
  await Promise.resolve();
  expect(Media.loadDesktopMedia).not.toHaveBeenCalled();
});

it('沒有原生授權介面的舊桌面 bridge 仍可從 getFilePath 入載', async () => {
  const authorizeDroppedFile = desktop.authorizeDroppedFile;
  delete desktop.authorizeDroppedFile;
  try {
    drop(new File(['video'], 'legacy.mov'));
    await vi.waitFor(() => expect(Media.loadDesktopMedia).toHaveBeenCalledWith('C:/legacy.mov'));
  } finally { desktop.authorizeDroppedFile = authorizeDroppedFile; }
});

it('文字字幕 drop 的讀檔等待也不能把舊稿匯入替換後的工作區', async () => {
  State.mediaName = 'current.mov';
  drop(new File(['OLD_TRANSCRIPT'], 'old.txt', { type: 'text/plain' }));
  resetProject(); State.cues = [{ id: 'new', start: 0, end: 1, text: 'NEW_PROJECT', track: 0 }];
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(State.cues.map(cue => cue.text)).toEqual(['NEW_PROJECT']);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
});

it('較新的專案 drop 等待 native reader 時，同 generation 的舊 runtime 完成不撤銷它', async () => {
  const fonts = deferred(), nativeRead = deferred();
  const checkFonts = vi.spyOn(Project, '_checkMissingFonts').mockImplementationOnce(() => fonts.promise);
  desktop.openDroppedProject = vi.fn(() => nativeRead.promise);
  try {
    const loadingA = Project.loadDesktop(projectRequest('RUNTIME_A'));
    await vi.waitFor(() => expect(checkFonts).toHaveBeenCalled());
    drop(new File(['project'], 'NEWER_DROP.subtool'));
    await vi.waitFor(() => expect(desktop.openDroppedProject).toHaveBeenCalledOnce());
    fonts.resolve([]); await loadingA;
    expect(State.cues.map(cue => cue.text)).toEqual(['RUNTIME_A']);
    nativeRead.resolve(projectRequest('NEWER_DROP'));
    await vi.waitFor(() => expect(State.cues.map(cue => cue.text)).toEqual(['NEWER_DROP']));
  } finally { checkFonts.mockRestore(); }
});

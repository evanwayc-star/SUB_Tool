// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/media.js', () => ({ Media: {
  externalAudio: { list: () => [] }, reset: vi.fn(), displayTime: () => 0, mpvMode: false,
} }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));

let State, Project, resetProject, isProjectDirty, History, showProjectSettings, canvas, events, save, nativeCanvas;
const select = (id, value) => {
  const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
};
const applySize = async (width, height) => {
  showProjectSettings(); select('projectCanvasMode', 'custom');
  document.getElementById('projectCanvasWidth').value = width;
  document.getElementById('projectCanvasHeight').value = height;
  const button = document.getElementById('projectCanvasApply'); button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
};
const savedDocument = () => JSON.parse(Buffer.from(save.mock.calls.at(-1)[1], 'base64').subarray(2).toString('utf16le'));

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><h2 id="modalTitle"></h2><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="historyList"></div><div id="toast"></div><span id="stMsg"></span>';
  save = vi.fn().mockResolvedValue('C:/test/project.subtool');
  nativeCanvas = vi.fn().mockResolvedValue({ok:true});
  window.subtool = { isDesktop: true, saveProject: save, mpv: {setProjectCanvas:nativeCanvas} };
  ({ State } = await import('../src/state.js'));
  ({ Project, resetProject, isProjectDirty } = await import('../src/project.js'));
  ({ History } = await import('../src/history.js'));
  ({ showProjectSettings } = await import('../src/project-settings.js'));
  canvas = await import('../src/project-canvas.js');
  events = await import('../src/events.js');
  Object.assign(State, { projectCanvas: null, videoWidth: 3840, videoHeight: 2160, clips: [], cues: [], notes: [], duration: 0 });
  History.reset(); Project.establishCleanBaseline();
});
afterEach(() => { resetProject?.(); delete window.subtool; });

describe('project canvas settings and persistence', () => {
  it('locks the submitted draft while native apply is pending; Cancel restores Auto and revokes the late result', async () => {
    let complete;
    nativeCanvas.mockImplementationOnce(() => new Promise(resolve => {complete=resolve;}));
    const session=showProjectSettings(); select('projectCanvasPreset','1080x1920');
    const button=document.getElementById('projectCanvasApply'); button.click();
    expect(button.disabled).toBe(true);
    for(const id of ['projectCanvasMode','projectCanvasWidth','projectCanvasHeight','projectCanvasPreset'])
      expect(document.getElementById(id).disabled).toBe(true);
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
    session.close();
    expect(nativeCanvas).toHaveBeenLastCalledWith(null);
    complete({ok:true}); await Promise.resolve(); await Promise.resolve();
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
  });

  it('reports native failure, keeps the draft editable, and does not create an undo entry', async () => {
    nativeCanvas.mockRejectedValueOnce(new Error('filter rejected'));
    await applySize('1080','1920');
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
    expect(document.getElementById('projectCanvasError').textContent).toContain('filter rejected');
    expect(document.getElementById('projectCanvasWidth').disabled).toBe(false);
    await document.getElementById('projectCanvasApply').onclick();
    expect(State.projectCanvas).toEqual({width:1080,height:1920});
    expect(History.stack).toHaveLength(2);
  });

  it('does not send a second native apply after committing the same successful draft', async () => {
    await applySize('1080','1920');
    expect(nativeCanvas).toHaveBeenCalledTimes(1);
    showProjectSettings(); await document.getElementById('projectCanvasApply').onclick();
    expect(nativeCanvas).toHaveBeenCalledTimes(1); expect(History.stack).toHaveLength(2);
  });
  it('applies an arbitrary portrait canvas, records exactly one edit, and restores Auto through undo', async () => {
    const changed = vi.fn(); events.on('project:canvasChanged', changed);
    const routes = structuredClone(State.audioProject);
    await applySize('1440', '2560');
    expect(State.projectCanvas).toEqual({ width: 1440, height: 2560 });
    expect(canvas.projectCanvasSize()).toEqual({ width: 1440, height: 2560 });
    expect(State.videoWidth).toBe(3840);
    expect(State.audioProject).toEqual(routes);
    expect(History.stack).toHaveLength(2);
    expect(isProjectDirty()).toBe(true);
    History.undo();
    expect(State.projectCanvas).toBeNull();
    expect(canvas.projectCanvasSize()).toEqual({ width: 3840, height: 2160 });
    expect(isProjectDirty()).toBe(false);
    History.redo();
    expect(canvas.projectCanvasSize()).toEqual({ width: 1440, height: 2560 });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('saves the explicit canvas and reopens it without a media dependency; legacy documents return to Auto', async () => {
    await applySize('1920', '1080');
    await Project.saveAs(); const data = savedDocument();
    expect(data.projectCanvas).toEqual({ width: 1920, height: 1080 });
    expect(isProjectDirty()).toBe(false);
    State.projectCanvas = { width: 1080, height: 1920 };
    expect(Project.apply(data)).toBe(true);
    expect(canvas.projectCanvasSize()).toEqual({ width: 1920, height: 1080 });
    await Project.saveAs(); expect(savedDocument().projectCanvas).toEqual(data.projectCanvas);
    delete data.projectCanvas; Project.apply(data);
    expect(State.projectCanvas).toBeNull();
    expect(canvas.projectCanvasSize()).toEqual({ width: 1920, height: 1080 });
    State.videoWidth = 2048; State.videoHeight = 858;
    expect(canvas.projectCanvasSize()).toEqual({ width: 2048, height: 858 });
  });

  it('discards a draft on Cancel, changed workspace, or Undo without overwriting newer work', async () => {
    const first = showProjectSettings(); select('projectCanvasPreset', '1080x1920'); first.close();
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
    showProjectSettings(); select('projectCanvasPreset', '1080x1920');
    const oldApply = document.getElementById('projectCanvasApply');
    resetProject(); oldApply.click();
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
    await applySize('1080', '1080');
    showProjectSettings(); select('projectCanvasPreset', '1080x1920');
    History.undo(); document.getElementById('projectCanvasApply').click();
    expect(State.projectCanvas).toBeNull();
  });

  it.each([['', '1080'], ['0', '1080'], ['1920.5', '1080'], ['9999999999999999', '1080'], ['8192', '8192']])('rejects unsafe UI dimensions %s × %s without mutation', async (w, h) => {
    await applySize(w, h);
    expect(State.projectCanvas).toBeNull(); expect(History.stack).toHaveLength(1);
    expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
    expect(document.getElementById('projectCanvasError').textContent).toContain('整數');
  });

  it.each([{}, [], { width: '1920', height: 1080 }, { width: -1, height: 1080 }, { width: 1920.5, height: 1080 }, { width: 8192, height: 8192 }])('rejects malformed persisted canvas %j before changing the workspace', projectCanvas => {
    const owns = Project.captureWorkspaceOwnership();
    State.cues = [{ id: 'retained', start: 0, end: 2, text: 'keep', track: 0 }];
    expect(Project.apply({ version: 3, projectCanvas, tracks: [], cues: [], clips: [] })).toBe(false);
    expect(State.cues[0].text).toBe('keep'); expect(owns()).toBe(true);
  });

  it('keeps source metadata, fixed subtitle coordinates, and viewport geometry independent', async () => {
    await applySize('1080', '1920');
    State.videoWidth = 2048; State.videoHeight = 858;
    expect(canvas.projectCanvasRect(960, 540)).toEqual({ x: 328, y: 0, w: 304, h: 540 });
    const { ASS_PLAY_RES, posToPx } = await import('../src/substyle.js');
    expect(ASS_PLAY_RES).toEqual({ x: 1920, y: 1080 });
    expect(posToPx({ posX: 50, posY: 75 })).toEqual({ x: 540, y: 1440, VW: 1080, VH: 1920 });
    showProjectSettings(); select('projectCanvasMode', 'auto'); await document.getElementById('projectCanvasApply').onclick();
    expect(canvas.projectCanvasSize()).toEqual({ width: 2048, height: 858 });
  });
});

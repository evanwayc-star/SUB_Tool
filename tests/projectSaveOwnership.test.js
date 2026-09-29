// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/media.js', () => ({ Media: {
  displayTime: () => 0,
  externalAudio: { list: () => [], get: () => null },
} }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => ({ openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn(), setStatus: vi.fn() }));

let State, Project, resetProject, isProjectDirty, getProjectDir, desk;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const savedText = call => JSON.parse(Buffer.from(call[1], 'base64').subarray(2).toString('utf16le')).cues[0]?.text;

beforeEach(async () => {
  vi.resetModules();
  desk = {
    isDesktop: true,
    saveProject: vi.fn().mockResolvedValue('C:/projects/a.subtool'),
    writeProject: vi.fn().mockImplementation(async path => path),
  };
  Object.defineProperty(window, 'subtool', { configurable: true, value: desk });
  ({ State } = await import('../src/state.js'));
  ({ Project, resetProject, isProjectDirty, getProjectDir } = await import('../src/project.js'));
  State.cues = [{ id: 'a', start: 0, end: 1, text: 'original', track: 0 }];
  State.notes = [];
  State.clips = [];
});

afterEach(() => resetProject?.());

describe('project save ownership', () => {
  it('keeps edits made during disk IO dirty against the exact saved bytes', async () => {
    const io = deferred();
    desk.saveProject.mockReturnValue(io.promise);
    const saving = Project.saveAs();
    await vi.waitFor(() => expect(desk.saveProject).toHaveBeenCalledOnce());
    State.cues[0].text = 'new edit';
    io.resolve('C:/projects/a.subtool');
    await saving;
    expect(savedText(desk.saveProject.mock.calls[0])).toBe('original');
    expect(isProjectDirty()).toBe(true);
    await Project.save();
    expect(savedText(desk.writeProject.mock.calls[0])).toBe('new edit');
    expect(isProjectDirty()).toBe(false);
  });

  it('does not attach an old save result to a new project', async () => {
    const io = deferred();
    desk.saveProject.mockReturnValue(io.promise);
    const saving = Project.saveAs();
    await vi.waitFor(() => expect(desk.saveProject).toHaveBeenCalledOnce());
    resetProject();
    State.cues[0].text = 'another project';
    io.resolve('C:/projects/old.subtool');
    await expect(saving).resolves.toBeNull();
    expect(getProjectDir()).toBeNull();
    expect(isProjectDirty()).toBe(true);
  });

  it('serializes saves and captures each requested snapshot before waiting', async () => {
    await Project.saveAs();
    const io = deferred();
    desk.writeProject.mockReturnValueOnce(io.promise);
    State.cues[0].text = 'first';
    const first = Project.save();
    State.cues[0].text = 'second';
    const second = Project.save();
    await vi.waitFor(() => expect(desk.writeProject).toHaveBeenCalledOnce());
    expect(savedText(desk.writeProject.mock.calls[0])).toBe('first');
    io.resolve('C:/projects/a.subtool');
    await Promise.all([first, second]);
    expect(savedText(desk.writeProject.mock.calls[1])).toBe('second');
    expect(isProjectDirty()).toBe(false);
  });

  it('returns null on write rejection and allows a later retry', async () => {
    await Project.saveAs();
    State.cues[0].text = 'unsaved';
    desk.writeProject.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(Project.save()).resolves.toBeNull();
    expect(isProjectDirty()).toBe(true);
    await expect(Project.save()).resolves.toBe('C:/projects/a.subtool');
    expect(isProjectDirty()).toBe(false);
  });

  it('treats deleting all saved content as a change', async () => {
    await Project.saveAs();
    State.cues = [];
    expect(isProjectDirty()).toBe(true);
  });
});

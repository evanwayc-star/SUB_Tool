// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 0),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  loadDesktopMedia: vi.fn(),
  reset: vi.fn(),
  restorePendingImageClips: vi.fn().mockResolvedValue({ restored: 0, pending: 0 }),
  seek: vi.fn(),
  waitForPendingProjectRestore: vi.fn().mockResolvedValue(),
}));

const uiMock = vi.hoisted(() => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => uiMock);

let History;
let Project;
let resetProject;
let State;
let desk;
let on;
let emit;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function projectB64(data) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify(data), 'utf16le'),
  ]).toString('base64');
}

function projectFile(data) {
  const bytes = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify(data), 'utf16le'),
  ]);
  return new File([bytes], 'browser.subtool', { type: 'application/json' });
}

function projectData(label, mediaPath, playhead = null) {
  return {
    app: 'SUB Tool',
    version: 3,
    media: { name: `${label}.mov`, size: 100, path: mediaPath },
    duration: 20,
    fps: 25,
    tracks: [],
    cues: [{ start: 1, end: 2, text: label, track: 1 }],
    notes: [],
    clips: [{
      id: `clip-${label}`,
      name: `${label}.mov`,
      path: mediaPath,
      dur: 20,
      in: 0,
      out: 20,
      offset: 0,
      vtrack: 0,
      primary: true,
    }],
    ...(playhead == null ? {} : { playhead }),
  };
}

function request(label, mediaPath, playhead = null) {
  return {
    path: `C:/projects/${label}.subtool`,
    b64: projectB64(projectData(label, mediaPath, playhead)),
  };
}

describe('project load transactions', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="historyList"></div>';
    desk = {
      isDesktop: true,
      stat: vi.fn(),
      openMedia: vi.fn(),
    };
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: desk,
    });

    ({ State } = await import('../src/state.js'));
    ({ History } = await import('../src/history.js'));
    ({ Project, resetProject } = await import('../src/project.js'));
    ({ on, emit } = await import('../src/events.js'));

    History.stack = [];
    History.hi = -1;
    State.clips = [];
    State.cues = [];
    State.notes = [];
    mediaMock.reset.mockClear();
    mediaMock.loadDesktopMedia.mockReset();
    mediaMock.waitForPendingProjectRestore.mockReset();
    mediaMock.waitForPendingProjectRestore.mockResolvedValue();
    mediaMock.seek.mockClear();
    uiMock.openModal.mockClear();
    uiMock.closeModal.mockClear();
    uiMock.setStatus.mockClear();
  });

  it('skips stale work when a newer project is requested during the first stat', async () => {
    const statA = deferred();
    desk.stat.mockImplementation(path => {
      if (path === 'C:/media/A.mov') return statA.promise;
      return Promise.resolve({ exists: true });
    });
    const resetHistory = vi.spyOn(History, 'reset');

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    expect(desk.stat).not.toHaveBeenCalledWith('C:/media/B.mov');

    statA.resolve({ exists: true });
    await Promise.all([loadingA, loadingB]);

    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov', expect.any(Object));
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('serializes a newer project behind an in-flight media load and only finalizes the winner', async () => {
    const mediaA = deferred();
    const callOrder = [];
    desk.stat.mockResolvedValue({ exists: true });
    mediaMock.loadDesktopMedia.mockImplementation(path => {
      callOrder.push(`start:${path}`);
      if (path === 'C:/media/A.mov') {
        return mediaA.promise.then(() => {
          callOrder.push(`finish:${path}`);
        });
      }
      callOrder.push(`finish:${path}`);
      return Promise.resolve();
    });
    const resetHistory = vi.spyOn(History, 'reset');

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov', 11));
    await vi.waitFor(() => expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/A.mov', expect.any(Object)));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov', 22));
    expect(mediaMock.loadDesktopMedia).not.toHaveBeenCalledWith('C:/media/B.mov', expect.any(Object));

    mediaA.resolve();
    await Promise.all([loadingA, loadingB]);

    expect(callOrder).toEqual([
      'start:C:/media/A.mov',
      'finish:C:/media/A.mov',
      'start:C:/media/B.mov',
      'finish:C:/media/B.mov',
    ]);
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(mediaMock.seek).toHaveBeenCalledTimes(1);
    expect(mediaMock.seek).toHaveBeenCalledWith(22);
    expect(resetHistory).toHaveBeenCalledTimes(1);
  });

  it('invalidates a missing-media modal callback after another project wins', async () => {
    desk.stat.mockImplementation(path => Promise.resolve({
      exists: path === 'C:/media/B.mov',
    }));
    mediaMock.loadDesktopMedia.mockResolvedValue();

    await Project.loadDesktop(request('A', 'C:/media/missing-A.mov'));
    const actions = uiMock.openModal.mock.calls.at(-1)?.[2];
    expect(actions?.[0]?.act).toBeTypeOf('function');

    await Project.loadDesktop(request('B', 'C:/media/B.mov'));
    await actions[0].act();

    expect(desk.openMedia).not.toHaveBeenCalled();
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov', expect.any(Object));
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
  });

  it('does not restore a missing project playhead when a later project media becomes ready', async () => {
    desk.stat.mockImplementation(path => Promise.resolve({
      exists: path === 'C:/media/B.mov',
    }));
    mediaMock.loadDesktopMedia.mockImplementation(async () => {
      emit('media:projectReady', { clips: [] });
    });

    await Project.loadDesktop(request('A', 'C:/media/missing-A.mov', 13));
    await Project.loadDesktop(request('B', 'C:/media/B.mov'));

    expect(mediaMock.seek).not.toHaveBeenCalled();
  });

  it('does not restore a saved playhead after starting a new project before media becomes ready', async () => {
    desk.stat.mockResolvedValue({ exists: false });

    await Project.loadDesktop(request('A', 'C:/media/missing-A.mov', 13));
    await Project.startNewProject(() => resetProject());
    emit('media:projectReady', { clips: [] });

    expect(mediaMock.seek).not.toHaveBeenCalled();
  });

  it('keeps the transaction tail usable after an older load rejects', async () => {
    const statA = deferred();
    desk.stat.mockImplementation(path => {
      if (path === 'C:/media/A.mov') return statA.promise;
      return Promise.resolve({ exists: true });
    });
    mediaMock.loadDesktopMedia.mockResolvedValue();

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    statA.reject(new Error('磁碟暫時不可用'));

    await expect(loadingA).rejects.toThrow('磁碟暫時不可用');
    await loadingB;

    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov', expect.any(Object));
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
  });

  it('invalidates a browser relink picker when a newer project is requested while it is open', async () => {
    const picker = deferred();
    const continuationStarted = deferred();
    let continuation;
    let imported = false;
    let restorePlan;
    on('project:relinkBrowserMedia', (generation, plan) => {
      restorePlan = plan;
      continuation = Project.continueLoad(generation, async isCurrent => {
        continuationStarted.resolve();
        await picker.promise;
        if (!isCurrent()) return;
        imported = true;
      });
    });
    desk.stat.mockResolvedValue({ exists: true });
    // 真實 Media._registerPrimary() 會在成功建立主片段時消耗這個 restore plan 的
    // relink flag；mock 也要維持同一個 completion 邊界，才能檢驗 A 不會殘留。
    mediaMock.loadDesktopMedia.mockImplementation((_path, plan) => {
      plan?.consumeMediaRelink?.();
      return Promise.resolve();
    });

    await Project.load(projectFile(projectData('A', 'C:/media/A.mov')));
    const actions = uiMock.openModal.mock.calls.at(-1)?.[2];
    actions[0].act();
    await continuationStarted.promise;
    expect(restorePlan.pendingClips()).toEqual([expect.objectContaining({ id: 'clip-A' })]);

    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    picker.resolve();
    await Promise.all([continuation, loadingB]);

    expect(imported).toBe(false);
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(Project.pendingMediaRelink()).toBeNull();
  });

  it('完成瀏覽器媒體重新連結後才還原並消耗該專案的播放點', async () => {
    let generation;
    let restorePlan;
    on('project:relinkBrowserMedia', (nextGeneration, plan) => {
      generation = nextGeneration;
      restorePlan = plan;
    });

    await Project.load(projectFile(projectData('A', 'C:/media/A.mov', 13)));
    const actions = uiMock.openModal.mock.calls.at(-1)?.[2];
    // 使用者先選「稍後」再從一般開啟媒體流程回來時，app 會從這個明確 hand-off
    // 取得同一份 restore plan；不能把資料藏回 State 或重新建立一份。
    const pending = Project.pendingMediaRelink();
    expect(pending).toMatchObject({ generation: expect.any(Number), plan: expect.any(Object) });
    expect(pending.plan.peekPlayhead()).toBe(13);
    actions[0].act();
    expect(restorePlan).toBe(pending.plan);
    expect(generation).toBe(pending.generation);

    expect(mediaMock.seek).not.toHaveBeenCalled();
    await Project.finishBrowserMediaRelink(generation, restorePlan);

    expect(mediaMock.waitForPendingProjectRestore).toHaveBeenCalledTimes(1);
    expect(mediaMock.seek).toHaveBeenCalledWith(13);
    expect(restorePlan.peekPlayhead()).toBeNull();
  });

  it('開新專案會撤銷尚未完成的瀏覽器重新連結 hand-off', async () => {
    await Project.load(projectFile(projectData('A', 'C:/media/A.mov', 13)));
    expect(Project.pendingMediaRelink()).toMatchObject({ plan: expect.any(Object) });

    await Project.startNewProject(() => resetProject());

    expect(Project.pendingMediaRelink()).toBeNull();
  });

  it('invalidates an in-flight load before starting a new empty project transaction', async () => {
    const statA = deferred();
    desk.stat.mockReturnValue(statA.promise);
    let cleared = false;

    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const startingNew = Project.startNewProject(() => {
      State.cues = [];
      cleared = true;
    });
    expect(cleared).toBe(false);

    statA.resolve({ exists: true });
    await Promise.all([loadingA, startingNew]);

    expect(mediaMock.loadDesktopMedia).not.toHaveBeenCalled();
    expect(cleared).toBe(true);
    expect(State.cues).toEqual([]);
  });
});

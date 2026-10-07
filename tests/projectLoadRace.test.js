// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 0),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  externalAudioSources: [],
  loadDesktopMedia: vi.fn(),
  removeExternalAudio: vi.fn(),
  reset: vi.fn(),
  restoreExternalAudioSource: vi.fn(),
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
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
vi.mock('../src/ui.js', () => uiMock);

let History;
let Project;
let resetProject;
let isProjectDirty;
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
    ({ Project, resetProject, isProjectDirty } = await import('../src/project.js'));
    ({ on, emit } = await import('../src/events.js'));

    History.stack = [];
    History.hi = -1;
    State.clips = [];
    State.cues = [];
    State.notes = [];
    mediaMock.reset.mockClear();
    mediaMock.loadDesktopMedia.mockReset();
    mediaMock.removeExternalAudio.mockReset();
    mediaMock.restoreExternalAudioSource.mockReset();
    mediaMock.externalAudioSources.length = 0;
    mediaMock.waitForPendingProjectRestore.mockReset();
    mediaMock.waitForPendingProjectRestore.mockResolvedValue();
    mediaMock.seek.mockClear();
    uiMock.openModal.mockClear();
    uiMock.closeModal.mockClear();
    uiMock.setStatus.mockClear();
  });

  it('開啟入口依使用者請求順序，較早 picker 晚返回不得蓋掉最新專案', async () => {
    const a=deferred(), b=deferred();
    desk.stat.mockResolvedValue({exists:true});
    desk.openProject=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const {openProject}=await import('../src/project.js');
    const openingA=openProject();
    await vi.waitFor(()=>expect(desk.openProject).toHaveBeenCalledTimes(1));
    const openingB=openProject();
    await vi.waitFor(()=>expect(desk.openProject).toHaveBeenCalledTimes(2));
    b.resolve(request('B','C:/media/B.mov'));
    await openingB;
    a.resolve(request('A','C:/media/A.mov'));
    await openingA;
    expect(State.cues.map(c=>c.text)).toEqual(['B']);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledOnce();
  });

  it('較晚取消開啟仍使較早等待中的讀檔失效，保留目前專案', async () => {
    const a=deferred(), started=deferred();
    const old=Project.open(()=>{started.resolve();return a.promise;});
    await started.promise;
    await expect(Project.open(async()=>null)).resolves.toBe(false);
    a.resolve(request('A','C:/media/A.mov'));
    await expect(old).resolves.toBe(false);
    expect(State.cues).toEqual([]);
    expect(mediaMock.reset).not.toHaveBeenCalled();
  });

  it('跨入口載入新工作區後，舊 reader 的錯誤不干擾目前專案', async () => {
    const a=deferred(), started=deferred();
    const old=Project.open(()=>{started.resolve();return a.promise;});
    await started.promise;
    desk.stat.mockResolvedValue({exists:true});
    await Project.loadDesktop(request('B','C:/media/B.mov'));
    a.reject(new Error('舊專案網路讀取失敗'));
    await expect(old).resolves.toBe(false);
    expect(State.cues.map(c=>c.text)).toEqual(['B']);
  });

  it('目前 reader 的錯誤仍交給原入口顯示', async () => {
    await expect(Project.open(async()=>{throw new Error('讀檔失敗');})).rejects.toThrow('讀檔失敗');
    expect(mediaMock.reset).not.toHaveBeenCalled();
  });

  it('已開始的舊 runtime 完成時，不撤銷較新的等待中開啟意圖', async () => {
    const statA=deferred(),readB=deferred(),started=deferred();
    desk.stat.mockImplementation(file=>file==='C:/media/A.mov'?statA.promise:Promise.resolve({exists:true}));
    const loadingA=Project.loadDesktop(request('A','C:/media/A.mov'));
    await vi.waitFor(()=>expect(desk.stat).toHaveBeenCalledWith('C:/media/A.mov'));
    const openingB=Project.open(()=>{started.resolve();return readB.promise;});
    await started.promise;
    statA.resolve({exists:true});
    await loadingA;
    expect(State.cues.map(c=>c.text)).toEqual(['A']);
    readB.resolve(request('B','C:/media/B.mov'));
    await openingB;
    expect(State.cues.map(c=>c.text)).toEqual(['B']);
  });

  it.each(['reset','apply'])('工作區 %s 不容許尚在讀取的舊意圖提交', async action => {
    const input=deferred(),started=deferred();
    const pending=Project.open(()=>{started.resolve();return input.promise;});
    await started.promise;
    if(action==='reset') resetProject();
    else Project.apply(projectData('Replacement',''));
    input.resolve(request('Old','C:/media/Old.mov'));
    await expect(pending).resolves.toBe(false);
    expect(State.cues.some(c=>c.text==='Old')).toBe(false);
  });

  it('同一開啟 owner 接受 browser File，保持真 FileReader 解析與還原', async () => {
    const file=projectFile({...projectData('Browser',''),media:{name:'',path:null},clips:[]});
    await Project.open(async()=>file);
    expect(State.cues.map(c=>c.text)).toEqual(['Browser']);
    expect(isProjectDirty()).toBe(false);
    expect(mediaMock.reset).toHaveBeenCalledOnce();
  });

  it('讀檔期間新增的內容要重新確認，取消不得丟棄合法修改', async () => {
    const a=deferred(), started=deferred();
    const opening=Project.open(()=>{started.resolve();return a.promise;});
    await started.promise;
    State.cues=[{id:'new-edit',track:0,start:0,end:1,text:'讀取期間新增'}];
    a.resolve(request('A','C:/media/A.mov'));
    await vi.waitFor(()=>expect(uiMock.openModal).toHaveBeenCalled());
    uiMock.openModal.mock.calls.at(-1)[2].find(b=>b.label==='取消').act();
    await expect(opening).resolves.toBe(false);
    expect(State.cues.map(c=>c.text)).toEqual(['讀取期間新增']);
    expect(mediaMock.reset).not.toHaveBeenCalled();
  });

  it('drop 專案也需確認未存內容，取消時不讀檔且不改字幕', async () => {
    State.cues=[{id:'unsaved',track:0,start:0,end:1,text:'未存檔'}];
    desk.openDroppedProject=vi.fn().mockResolvedValue(request('Dropped','C:/media/Dropped.mov'));
    await import('../src/subio.js');
    const event=new Event('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['unused'],'Dropped.subtool')]}});
    document.dispatchEvent(event);
    await vi.waitFor(()=>expect(uiMock.openModal).toHaveBeenCalledWith('開啟另一個專案',expect.any(String),expect.any(Array),expect.any(Object)));
    expect(desk.openDroppedProject).not.toHaveBeenCalled();
    uiMock.openModal.mock.calls.at(-1)[2].find(b=>b.label==='取消').act();
    await Promise.resolve();
    expect(State.cues.map(c=>c.text)).toEqual(['未存檔']);
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

  it('drops an old media-less project after its auto-relink await loses ownership', async () => {
    const relinkA = deferred();
    desk.findRelinkTarget = vi.fn((projectPath, oldPath) => {
      if (oldPath === 'C:/audio/A.wav') return relinkA.promise;
      return Promise.resolve(null);
    });
    desk.stat.mockImplementation(path => Promise.resolve({
      exists: path === 'C:/media/B.mov',
    }));
    mediaMock.loadDesktopMedia.mockResolvedValue();
    const dataA = {
      app: 'SUB Tool', version: 3, media: { name: '', path: null }, duration: 8, fps: 25,
      tracks: [], cues: [{ start: 1, end: 2, text: 'A', track: 0 }], notes: [], clips: [],
      externalAudioSources: [{ audioSourceId: 'audio-A', name: 'A', path: 'C:/audio/A.wav' }],
    };

    const loadingA = Project.loadDesktop({
      path: 'C:/projects/A.subtool',
      b64: projectB64(dataA),
    });
    await vi.waitFor(() => expect(desk.findRelinkTarget).toHaveBeenCalledWith(
      'C:/projects/A.subtool', 'C:/audio/A.wav',
    ));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    relinkA.resolve(null);
    await Promise.all([loadingA, loadingB]);

    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledTimes(1);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith('C:/media/B.mov', expect.any(Object));
    expect(mediaMock.reset).toHaveBeenCalledTimes(1);
  });

  it('marks auto-relinked media paths unsaved until the new paths reach the project file', async () => {
    const oldPath = 'C:/media/A.mov';
    const newPath = 'C:/projects/media/A.mov';
    desk.stat.mockImplementation(path => Promise.resolve({ exists: path === newPath || path === 'C:/media/B.mov' }));
    desk.findRelinkTarget = vi.fn().mockResolvedValue(newPath);
    desk.writeProject = vi.fn().mockResolvedValue('C:/projects/A.subtool');
    mediaMock.loadDesktopMedia.mockResolvedValue();

    await Project.loadDesktop(request('A', oldPath));

    expect(desk.findRelinkTarget).toHaveBeenCalledWith('C:/projects/A.subtool', oldPath);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledWith(newPath, expect.any(Object));
    expect(State.mediaPath).toBe(newPath);
    expect(isProjectDirty()).toBe(true);

    await Project.save();
    const saved = JSON.parse(Buffer.from(desk.writeProject.mock.calls[0][1], 'base64').subarray(2).toString('utf16le'));
    expect(saved.media.path).toBe(newPath);
    expect(saved.clips[0].path).toBe(newPath);
    expect(isProjectDirty()).toBe(false);

    await Project.loadDesktop(request('B', 'C:/media/B.mov'));
    expect(isProjectDirty()).toBe(false);
  });

  it('does not commit external-audio metadata after a rejected restore loses the project plan', async () => {
    const restoreA = deferred();
    desk.stat.mockResolvedValue({ exists: true });
    mediaMock.restoreExternalAudioSource.mockReturnValueOnce(restoreA.promise);
    mediaMock.loadDesktopMedia.mockResolvedValue();
    const dataA = {
      app: 'SUB Tool', version: 3, media: { name: '', path: null }, duration: 8, fps: 25,
      tracks: [], cues: [{ start: 1, end: 2, text: 'A', track: 0 }], notes: [], clips: [],
      externalAudioSources: [{
        audioSourceId: 'audio-A', name: 'A', path: 'C:/audio/A.wav', duration: 8, out: 8,
      }],
    };

    const loadingA = Project.loadDesktop({
      path: 'C:/projects/A.subtool',
      b64: projectB64(dataA),
    });
    await vi.waitFor(() => expect(mediaMock.restoreExternalAudioSource).toHaveBeenCalledTimes(1));
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    restoreA.reject(new Error('A source disappeared'));
    await Promise.all([loadingA, loadingB]);

    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(State.externalAudioState).toEqual([]);
    expect(State.externalAudioEnd).toBe(0);
    expect(mediaMock.restoreExternalAudioSource).toHaveBeenCalledWith(
      expect.objectContaining({ audioSourceId: 'audio-A', _restore: true }),
      null,
      expect.any(Function),
    );
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

  it.each(['稍後', '重新匯入', '取消選取'])('缺主素材後修改字幕，%s 完成不得重設 Undo 或將修改標為已保存', async action => {
    desk.stat.mockImplementation(path => Promise.resolve({ exists: path !== 'C:/media/missing-A.mov' }));
    const data = projectData('A', 'C:/media/missing-A.mov', 13);
    data.externalAudioSources = [{ audioSourceId: 'audio-A', path: 'C:/audio/A.wav', in: 0, out: 10, offset: 2, duration: 10 }];
    mediaMock.restoreExternalAudioSource.mockImplementation(async source => source);
    await Project.loadDesktop({ path: 'C:/projects/A.subtool', b64: projectB64(data) });
    const buttons = uiMock.openModal.mock.calls.at(-1)[2];
    const plan = Project.pendingMediaRelink().plan;
    State.cues[0].text = '等待期間修改';
    History.record('修改字幕');
    const historyLength = History.stack.length;
    const reset = vi.spyOn(History, 'reset');
    expect(isProjectDirty()).toBe(true);
    if (action !== '稍後') {
      desk.openMedia.mockResolvedValue(action === '重新匯入' ? 'C:/media/found-A.mov' : null);
      mediaMock.loadDesktopMedia.mockImplementation(async (_path, restorePlan) => {
        restorePlan.consumeMediaRelink();
        const clip = { ...restorePlan.pendingClips()[0], id: 'relinked-primary', path: _path };
        State.clips = [clip];
        restorePlan.replaceClips([]);
        emit('media:projectReady', { clips: [clip] });
      });
    }
    await buttons[action === '稍後' ? 1 : 0].act();
    expect(reset).not.toHaveBeenCalled();
    expect(History.stack).toHaveLength(historyLength);
    expect(State.cues[0].text).toBe('等待期間修改');
    expect(isProjectDirty()).toBe(true);
    expect(plan.peekPlayhead()).toBe(action === '重新匯入' ? null : 13);
    if (action === '重新匯入') expect(mediaMock.seek).toHaveBeenCalledWith(13);
    else expect(mediaMock.seek).not.toHaveBeenCalled();
    History.undo();
    expect(State.cues[0].text).toBe('A');
    if (action === '重新匯入') expect(State.clips.map(clip => clip.id)).toEqual(['relinked-primary']);
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

  it('browser File 重連保留等待期間的字幕 Undo 與 dirty，使用既有 projectReady rebase', async () => {
    await Project.load(projectFile(projectData('Browser', null, 13)));
    const { generation, plan } = Project.pendingMediaRelink();
    State.cues[0].text = '瀏覽器等待期間修改';
    History.record('修改字幕');
    const reset = vi.spyOn(History, 'reset');
    const clip = { ...plan.pendingClips()[0], id: 'browser-primary', path: null, web: { url: 'blob:relinked' } };
    State.clips = [clip];
    plan.replaceClips([]);
    plan.consumeMediaRelink();
    emit('media:projectReady', { clips: [clip] });
    await Project.finishBrowserMediaRelink(generation, plan);
    expect(reset).not.toHaveBeenCalled();
    expect(History.stack).toHaveLength(2);
    expect(isProjectDirty()).toBe(true);
    expect(plan.peekPlayhead()).toBeNull();
    History.undo();
    expect(State.cues[0].text).toBe('Browser');
    expect(State.clips.map(item => item.id)).toEqual(['browser-primary']);
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

  it('cancels a missing-font prompt when a newer project is requested', async () => {
    vi.spyOn(Project, '_checkMissingFonts').mockImplementation(async data => data.cues[0].text === 'A' ? ['Missing Font'] : []);
    desk.stat.mockResolvedValue({ exists: true });
    mediaMock.loadDesktopMedia.mockResolvedValue();
    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(uiMock.openModal).toHaveBeenCalledWith('缺少字體', expect.any(String), expect.any(Array), expect.any(Object)));
    const oldButtons = uiMock.openModal.mock.calls.at(-1)[2];
    const loadingB = Project.loadDesktop(request('B', 'C:/media/B.mov'));
    await Promise.all([loadingA, loadingB]);
    oldButtons.find(button => button.label === '強制繼續開啟').act();
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
    expect(mediaMock.loadDesktopMedia).toHaveBeenCalledOnce();
  });

  it('dismisses a missing-font prompt without blocking later loads', async () => {
    vi.spyOn(Project, '_checkMissingFonts').mockResolvedValueOnce(['Missing Font']).mockResolvedValue([]);
    desk.stat.mockResolvedValue({ exists: true });
    const loadingA = Project.loadDesktop(request('A', 'C:/media/A.mov'));
    await vi.waitFor(() => expect(uiMock.openModal).toHaveBeenCalled());
    uiMock.openModal.mock.calls.at(-1)[3].onDismiss();
    await loadingA;
    expect(mediaMock.reset).not.toHaveBeenCalled();
    await Project.loadDesktop(request('B', 'C:/media/B.mov'));
    expect(State.cues.map(cue => cue.text)).toEqual(['B']);
  });

  it('does not apply a browser project after its font check loses ownership', async () => {
    const fonts = deferred();
    vi.spyOn(Project, '_checkMissingFonts').mockReturnValueOnce(fonts.promise).mockResolvedValue([]);
    const loadingA = Project.load(projectFile(projectData('A', 'C:/media/A.mov')));
    await vi.waitFor(() => expect(Project._checkMissingFonts).toHaveBeenCalled());
    const startingNew = Project.startNewProject(() => resetProject());
    fonts.resolve([]);
    await Promise.all([loadingA, startingNew]);
    expect(mediaMock.reset).not.toHaveBeenCalled();
    expect(State.cues).toEqual([]);
  });
});

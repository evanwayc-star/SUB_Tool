// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 105),
  vTime: vi.fn(() => 15),
  seek: vi.fn(),
  requestPresentation: vi.fn(target => Promise.resolve({ status: 'presented', presentedTime: target })),
  cancelPresentation: vi.fn(),
  presentedTime: vi.fn(() => null),
  scrubAudio: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
  setRate: vi.fn(),
  setPlaybackDirection: vi.fn().mockResolvedValue(true),
  setReverseShuttleMuted: vi.fn(),
  supportsNativeReverse: vi.fn(() => false),
  capturePlaybackTargetOwnership: vi.fn(() => () => true),
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) },
  playing: false,
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/subtitles.js', () => ({
  addCue: vi.fn(),
  selectCue: vi.fn(),
  selectCueSingle: vi.fn(),
  commitCueTimeEdit: vi.fn(),
  deleteSelected: vi.fn(),
  addCueRelative: vi.fn(),
  sortCues: vi.fn(),
  cancelSwapMode: vi.fn(),
  refreshSelectionUI: vi.fn(),
  copyCues: vi.fn(),
  pasteCues: vi.fn(),
}));
vi.mock('../src/timeline-renderer.js', () => ({
  updatePlayhead: vi.fn(),
  zoomFit: vi.fn(),
  zoomFitVideo: vi.fn(),
  setZoom: vi.fn(),
  drawTimeline: vi.fn(),
  deleteSelectedClip: vi.fn(),
  clearClipSelection: vi.fn(),
  closeClipGapLeft: vi.fn(),
}));
vi.mock('../src/project.js', () => ({
  Project: {},
  ensureProjectSaved: vi.fn().mockResolvedValue(),
}));
vi.mock('../src/history.js', () => ({
  History: {},
  recordHistory: vi.fn(),
  renderHistory: vi.fn(),
}));
vi.mock('../src/notes.js', () => ({
  addNote: vi.fn(),
  renderNotes: vi.fn(),
  updateNoteActive: vi.fn(),
}));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(),
  closeModal: vi.fn(),
  showOsd: vi.fn(),
  showToast: vi.fn(),
  openModal: vi.fn(),
}));

let State;
let jklReset;
let getJklSpeed;
let shuttleRewind;
let shuttleForward;
let togglePlayPause;
let stepFrame;

describe('JKL reverse shuttle time domain', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <video id="video"></video>
      <div id="modalBg"></div>
      <div id="ctxmenu"></div>
      <div id="speedIndicator"></div>
      <div id="tcCur"></div>
      <input id="seekBar" value="0">
    `;
    ({ State } = await import('../src/state.js'));
    ({ jklReset } = await import('../src/keyboard.js'));
    ({ getJklSpeed, shuttleRewind, shuttleForward, togglePlayPause, stepFrame } = await import('../src/transport-controller.js'));
    State.keymap = { rewind: [{ key: 'j' }] };
    State.clips = [{
      id: 'offset-clip',
      in: 10,
      out: 30,
      offset: 100,
      dur: 40,
      vtrack: 0,
      primary: true,
    }];
    mediaMock.displayTime.mockClear();
    mediaMock.vTime.mockClear();
    mediaMock.seek.mockClear();
    mediaMock.requestPresentation.mockReset().mockImplementation(target => Promise.resolve({
      status: 'presented', presentedTime: target,
    }));
    mediaMock.cancelPresentation.mockClear();
    mediaMock.presentedTime.mockReset().mockReturnValue(null);
    mediaMock.scrubAudio.mockClear();
    mediaMock.pause.mockReset();
    mediaMock.play.mockClear();
    mediaMock.setRate.mockClear();
    mediaMock.setPlaybackDirection.mockReset().mockResolvedValue(true);
    mediaMock.setReverseShuttleMuted.mockClear();
    mediaMock.supportsNativeReverse.mockReset().mockReturnValue(false);
    mediaMock.capturePlaybackTargetOwnership.mockReset().mockImplementation(() => () => true);
    mediaMock.playing = false;
  });

  afterEach(() => {
    jklReset?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('持續倒帶走時間軸 presentation，但不播放正向 scrub 音訊', async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    await vi.advanceTimersByTimeAsync(60);

    expect(mediaMock.requestPresentation).toHaveBeenCalledWith(expect.any(Number));
    expect(mediaMock.requestPresentation.mock.calls[0][0]).toBeLessThan(105);
    expect(mediaMock.scrubAudio).not.toHaveBeenCalled();
    expect(mediaMock.setReverseShuttleMuted).toHaveBeenCalledWith(true);
    expect(mediaMock.displayTime).toHaveBeenCalled();
    expect(mediaMock.vTime).not.toHaveBeenCalled();
  });

  it('mpv 原生倒播不建立 absolute seek 迴圈，停止時恢復 forward', async () => {
    State.keymap = {
      rewind: [{ key: 'j' }],
      pause: [{ key: 'k' }],
    };
    mediaMock.supportsNativeReverse.mockReturnValue(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    await vi.advanceTimersByTimeAsync(250);

    expect(mediaMock.setPlaybackDirection).toHaveBeenCalledWith('backward');
    expect(mediaMock.setRate).toHaveBeenCalledWith(1);
    expect(mediaMock.play).toHaveBeenCalled();
    expect(mediaMock.seek).not.toHaveBeenCalled();
    expect(mediaMock.scrubAudio).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(mediaMock.pause).toHaveBeenCalled();
    expect(mediaMock.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
    expect(mediaMock.setRate).toHaveBeenLastCalledWith(1);
  });

  it.each(['false', 'reject'])('J 轉 L 的正向還原 %s 時保持暫停並回報，不在錯誤方向起播', async failure => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true);
    if (failure === 'false') mediaMock.setPlaybackDirection.mockResolvedValueOnce(false);
    else mediaMock.setPlaybackDirection.mockRejectedValueOnce(new Error('forward command failed'));
    shuttleRewind();
    await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    shuttleForward();
    await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    expect(mediaMock.playing).toBe(false);
    expect(getJklSpeed()).toBe(0);
    const { setStatus } = await import('../src/ui.js');
    expect(setStatus).toHaveBeenLastCalledWith(expect.stringContaining('還原'), 'err');
  });

  it.each([true, false])('J 轉 L 等待還原時再按 L，最新正播仍等同一份來源結果 %s', async restored => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    let finish;
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
    shuttleForward(); await vi.advanceTimersByTimeAsync(0);
    shuttleForward(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    finish(restored); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(restored ? 2 : 1);
    expect(mediaMock.playing).toBe(restored);
    expect(getJklSpeed()).toBe(restored ? 1.5 : 0);
  });

  it('J 轉 L 的還原失敗後，明確再按 L 會重試還原而非沿失敗來源直接播放', async () => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
    shuttleForward(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    shuttleForward(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.setPlaybackDirection.mock.calls.map(([value]) => value)).toEqual(['backward', 'forward', 'forward']);
    expect(mediaMock.play).toHaveBeenCalledTimes(2);
    expect(getJklSpeed()).toBe(1);
  });

  it.each(['success', 'false', 'reject'])('J→K 後播放鍵也等待正向還原 %s，失敗不能直接起播', async outcome => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    let finish;
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => outcome === 'reject' ? reject(new Error('restore failed')) : resolve(outcome === 'success');
      }));
    shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
    jklReset(); togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(outcome === 'success' ? 2 : 1);
    expect(mediaMock.playing).toBe(outcome === 'success');
  });

  it.each([true, false])('J→K 還原中連按兩次播放鍵，晚到結果 %s 不反悔重新起播或報錯', async restored => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    let finish;
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
    jklReset(); togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    togglePlayPause(); const {setStatus}=await import('../src/ui.js'); setStatus.mockClear();
    finish(restored); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1); expect(mediaMock.playing).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('無倒帶交接時播放鍵維持正常播放／暫停與狀態提示', async () => {
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    const {setStatus}=await import('../src/ui.js');
    togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.playing).toBe(true);expect(setStatus).toHaveBeenLastCalledWith('▶ 正播','ok');
    togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.playing).toBe(false);expect(setStatus).toHaveBeenLastCalledWith('⏸ 暫停','');
    expect(mediaMock.setPlaybackDirection).not.toHaveBeenCalled();
  });

  it('還原失敗後再按播放鍵，須等明確重試成功才起播', async () => {
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    let finish;
    mediaMock.setPlaybackDirection.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
    shuttleForward(); await vi.advanceTimersByTimeAsync(0);
    togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(1);
    finish(true); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.play).toHaveBeenCalledTimes(2); expect(mediaMock.playing).toBe(true);
  });

  it('工作區失權撤銷舊 JKL 狀態，新工作區第一次播放鍵即可正常播放', async () => {
    let workspace = 1;
    mediaMock.capturePlaybackTargetOwnership.mockImplementation(() => {
      const captured = workspace; return () => captured === workspace;
    });
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    shuttleRewind(); await vi.advanceTimersByTimeAsync(50);
    mediaMock.requestPresentation.mockClear(); mediaMock.pause.mockClear(); mediaMock.setRate.mockClear();
    workspace += 1;
    await vi.advanceTimersByTimeAsync(200);
    expect(mediaMock.requestPresentation).not.toHaveBeenCalled();
    expect(mediaMock.pause).not.toHaveBeenCalled(); expect(mediaMock.setRate).not.toHaveBeenCalled();
    expect(getJklSpeed()).toBe(0);
    togglePlayPause(); await vi.advanceTimersByTimeAsync(0);
    expect(mediaMock.playing).toBe(true); expect(mediaMock.play).toHaveBeenCalledTimes(1);
  });

  it.each(['pause', 'rewind', 'source'].flatMap(action => [true, false].map(restored => [action, restored])))(
    'J 轉 L 的舊還原晚到 %s／%s，不起播或回報舊操作錯誤', async (action, restored) => {
      mediaMock.supportsNativeReverse.mockReturnValue(true);
      mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
      mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
      let finish, current = true;
      mediaMock.capturePlaybackTargetOwnership.mockImplementation(() => () => current);
      mediaMock.setPlaybackDirection.mockResolvedValueOnce(true)
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      shuttleRewind(); await vi.advanceTimersByTimeAsync(0);
      shuttleForward(); await vi.advanceTimersByTimeAsync(0);
      if (action === 'pause') jklReset();
      if (action === 'rewind') shuttleRewind();
      if (action === 'source') current = false;
      const { setStatus } = await import('../src/ui.js'); setStatus.mockClear();
      finish(restored); await vi.advanceTimersByTimeAsync(0);
      expect(mediaMock.play).toHaveBeenCalledTimes(action === 'rewind' ? 2 : 1);
      expect(mediaMock.playing).toBe(action === 'rewind');
      expect(setStatus).not.toHaveBeenCalled();
      if (action === 'rewind') expect(getJklSpeed()).toBe(-1);
    },
  );

  it('原生倒播中按播放暫停鍵只停止，不會緊接著切成正播', async () => {
    State.keymap = {
      rewind: [{ key: 'j' }],
      toggle_play_pause: [{ key: ' ' }],
    };
    mediaMock.supportsNativeReverse.mockReturnValue(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    await vi.advanceTimersByTimeAsync(0);
    mediaMock.playing = true;
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    mediaMock.pause.mockClear();
    const reversePlayCount = mediaMock.play.mock.calls.length;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(mediaMock.pause).toHaveBeenCalledTimes(1);
    expect(mediaMock.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
    expect(mediaMock.play).toHaveBeenCalledTimes(reversePlayCount);
  });

  it('fallback 倒帶中按播放暫停鍵只停止，不會意外開始正播', async () => {
    State.keymap = {
      rewind: [{ key: 'j' }],
      toggle_play_pause: [{ key: ' ' }],
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    const reversePlayCount = mediaMock.play.mock.calls.length;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    await Promise.resolve();

    expect(mediaMock.play).toHaveBeenCalledTimes(reversePlayCount);
    expect(mediaMock.setReverseShuttleMuted).toHaveBeenLastCalledWith(false);
  });

  it('原生倒播 IPC 尚未完成就按 K，晚到結果也會恢復 forward', async () => {
    State.keymap = {
      rewind: [{ key: 'j' }],
      pause: [{ key: 'k' }],
    };
    mediaMock.supportsNativeReverse.mockReturnValue(true);
    let finishBackward;
    mediaMock.setPlaybackDirection.mockImplementationOnce(() => new Promise(resolve => {
      finishBackward = resolve;
    }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' }));
    finishBackward(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mediaMock.setPlaybackDirection).toHaveBeenLastCalledWith('forward');
  });

  it('原生倒播停在同一格時會自動改用逐格 fallback', async () => {
    State.keymap = { rewind: [{ key: 'j' }] };
    mediaMock.supportsNativeReverse.mockReturnValue(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' }));
    await Promise.resolve();
    await Promise.resolve();
    // 長 GOP 第一次反向畫格允許 1.2 秒暖機；超過後仍完全沒進度才 fallback。
    await vi.advanceTimersByTimeAsync(1300);

    expect(mediaMock.requestPresentation).toHaveBeenCalled();
  });

  it('播放時按下左右鍵會先暫停並往左/右移動一格', async () => {
    State.keymap = {
      nudge_left_1f: [{ key: 'arrowleft' }],
      nudge_right_1f: [{ key: 'arrowright' }],
    };
    mediaMock.playing = true;
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(mediaMock.pause).toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(
      expect.closeTo(105 - 1 / State.fps, 8),
      { presentationTolerance: expect.closeTo(0.45 / State.fps, 8) },
    );
    expect(mediaMock.scrubAudio).toHaveBeenCalledWith(
      expect.closeTo(105 - 1 / State.fps, 8), 0.08,
    );

    mediaMock.pause.mockClear();
    mediaMock.seek.mockClear();
    mediaMock.playing = true;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(mediaMock.pause).toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(
      expect.closeTo(105 + 1 / State.fps, 8),
      { presentationTolerance: expect.closeTo(0.45 / State.fps, 8) },
    );
  });

  it('秒級微調保留一般 seek 容差，不套用逐格的嚴格門檻', () => {
    State.keymap = { nudge_right_1s: [{ key: 'd' }] };

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD' }));

    expect(mediaMock.seek).toHaveBeenCalledWith(106);
  });

  it('P 時間碼位移不能修改鎖定字幕軌的 In/Out', async () => {
    State.keymap = { shift_timecode: [{ key: 'p' }] };
    State.tracks = [{ name: '鎖定字幕', locked: true }];
    State.cues = [{ id: 'locked-cue', start: 100, end: 102, text: '內容', track: 0, timed: true }];
    State.selectedId = 'locked-cue';
    State.selectedIds = ['locked-cue'];
    const { recordHistory } = await import('../src/history.js');
    const { showToast } = await import('../src/ui.js');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP' }));

    expect({ start: State.cues[0].start, end: State.cues[0].end }).toEqual({ start: 100, end: 102 });
    expect(recordHistory).not.toHaveBeenCalled();
    expect(showToast.mock.calls.at(-1)?.[0]).toContain('修改字幕時間');
  });

  it('長按方向鍵維持平滑逐格步進，不誤啟動 shuttle，放開時零管線抖動', () => {
    State.keymap = { nudge_right_1f: [{ key: 'arrowright' }] };
    mediaMock.play.mockImplementation(() => { mediaMock.playing = true; });
    mediaMock.pause.mockImplementation(() => { mediaMock.playing = false; });
    mediaMock.seek.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(mediaMock.seek).toHaveBeenCalled();
    expect(mediaMock.play).not.toHaveBeenCalled();
    expect(getJklSpeed()).toBe(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true }));
    expect(mediaMock.play).not.toHaveBeenCalled();
    expect(getJklSpeed()).toBe(0);

    mediaMock.pause.mockClear();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
    // 零抖動：未進入 shuttle，放開時無需重複觸發 pause 或重載母素材
    expect(mediaMock.playing).toBe(false);
  });

  it('長按左鍵的 repeat 維持逐格步進，不觸發倒帶 session', () => {
    mediaMock.setReverseShuttleMuted.mockClear();
    stepFrame(-1, false);
    stepFrame(-1, true);
    stepFrame(-1, true);

    // 絕不誤切入倒帶穿梭 session
    expect(mediaMock.setReverseShuttleMuted).not.toHaveBeenCalled();
    expect(getJklSpeed()).toBe(0);
  });

  it('J/L 穿梭倍率依文件上限固定在正負 5x', () => {
    for(let i=0;i<20;i++) shuttleRewind();
    expect(getJklSpeed()).toBe(-5);
    jklReset();
    for(let i=0;i<20;i++) shuttleForward();
    expect(getJklSpeed()).toBe(5);
  });
  it('匯出 In/Out 接受重綁快捷鍵，預設括號組合仍清除範圍',async()=>{
    const {on}=await import('../src/events.js');
    const actions=[];on('action',action=>actions.push(action));
    State.keymap={exp_in:[{key:'h'}],exp_out:[{key:'o'}]};
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'h',cancelable:true}));
    window.dispatchEvent(new KeyboardEvent('keyup',{key:'h'}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'o',cancelable:true}));
    expect(actions).toEqual(['exp-in','exp-out']);
    actions.length=0;window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'['}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:']'}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'h'}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'o'}));
    expect(actions).toEqual(['exp-in','exp-out']);
    State.keymap={exp_in:[{key:'h'}],exp_out:[{key:']'}]};
    actions.length=0;window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'['}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:']'}));
    expect(actions).toEqual(['exp-out']);
    State.keymap={exp_in:[{key:'['}],exp_out:[{key:']'}]};
    actions.length=0;window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'['}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:']'}));
    expect(actions).toEqual(['exp-in','exp-clear']);
    window.dispatchEvent(new Event('blur'));actions.length=0;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:']'}));
    expect(actions).toEqual(['exp-out']);
  });
});

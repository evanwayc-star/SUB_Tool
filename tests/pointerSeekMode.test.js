// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  displayTime: vi.fn(() => 10),
  seek: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
  setRate: vi.fn(),
  playing: false,
}));

const statusMock = vi.hoisted(() => vi.fn());

vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/subtitles.js', () => ({
  selectCueSingle: vi.fn(),
  commitCueTimeEdit: vi.fn(),
}));
vi.mock('../src/timeline.js', () => ({ updatePlayhead: vi.fn(), drawTimeline: vi.fn() }));
vi.mock('../src/project.js', () => ({ ensureProjectSaved: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/notes.js', () => ({ updateNoteActive: vi.fn() }));
vi.mock('../src/ui.js', () => ({ setStatus: statusMock, showOsd: vi.fn() }));

let State;
let requestPointerSeek;
let renderPointerSeekControl;
let togglePointerSeekMode;
let getJklSpeed;
let setJklSpeed;

describe('滑鼠跳轉的播放狀態政策', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = `
      <video id="video"></video>
      <div id="speedIndicator"></div>
      <button class="pointer-seek-btn" aria-pressed="false">跳轉繼續</button>
    `;
    mediaMock.displayTime.mockClear();
    mediaMock.seek.mockClear();
    mediaMock.pause.mockReset().mockImplementation(() => { mediaMock.playing = false; });
    mediaMock.play.mockClear();
    mediaMock.setRate.mockClear();
    mediaMock.playing = false;
    statusMock.mockClear();

    ({ State } = await import('../src/state.js'));
    ({ getJklSpeed, setJklSpeed } = await import('../src/transport-controller.js'));
    ({ requestPointerSeek, renderPointerSeekControl, togglePointerSeekMode } = await import('../src/pointer-seek-control.js'));
    State.pointerSeekPauses = false;
  });

  it('跳轉繼續：播放中定位不暫停、不重設播放速度', () => {
    mediaMock.playing = true;

    requestPointerSeek(42);

    expect(mediaMock.pause).not.toHaveBeenCalled();
    expect(mediaMock.setRate).not.toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(42);
  });

  it('跳轉暫停：播放中先完整停止 transport，再定位', () => {
    State.pointerSeekPauses = true;
    mediaMock.playing = true;

    requestPointerSeek(24);

    expect(mediaMock.setRate).toHaveBeenCalledWith(1);
    expect(mediaMock.pause).toHaveBeenCalledOnce();
    expect(mediaMock.seek).toHaveBeenCalledWith(24);
    expect(mediaMock.pause.mock.invocationCallOrder[0])
      .toBeLessThan(mediaMock.seek.mock.invocationCallOrder[0]);
  });

  it('原本已暫停時只定位，不重複暫停也不會啟動播放', () => {
    State.pointerSeekPauses = true;

    requestPointerSeek(12);

    expect(mediaMock.pause).not.toHaveBeenCalled();
    expect(mediaMock.play).not.toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(12);
  });

  it('跳轉暫停也會停掉 Media.playing=false 的反向 seek fallback', () => {
    State.pointerSeekPauses = true;
    setJklSpeed(-2);

    requestPointerSeek(8);

    expect(getJklSpeed()).toBe(0);
    expect(mediaMock.setRate).toHaveBeenCalledWith(1);
    expect(mediaMock.pause).not.toHaveBeenCalled();
    expect(mediaMock.seek).toHaveBeenCalledWith(8);
  });

  it('工具列按鈕在兩個狀態間切換，並將選擇寫入 config', async () => {
    renderPointerSeekControl();
    const button = document.querySelector('.pointer-seek-btn');
    expect(button.textContent).toBe('跳轉繼續');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    togglePointerSeekMode();
    await Promise.resolve();

    expect(State.pointerSeekPauses).toBe(true);
    expect(button.textContent).toBe('跳轉暫停');
    expect(button.classList.contains('pause')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('subtool_config')).pointerSeekPauses).toBe(true);
  });

});

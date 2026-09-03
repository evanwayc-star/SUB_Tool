// @vitest-environment jsdom
/* 網頁版不能把超過 ffmpeg.wasm 上限的大型多音軌檔案誤呈現成完整音訊。
   這支測試執行真的 Media.probeAndMaybeExtract() 與 mixer render，鎖住使用者看得到的
   持續警告；不是掃原始碼裡有沒有某段文字。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

let Media, Wave, State, renderAudioTracks;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  document.body.innerHTML =
    '<video id="video"></video>' +
    '<div id="noVideo"></div>' +
    '<span id="atHint" hidden></span>' +
    '<div id="atList" hidden></div>' +
    '<input id="projectAudioTracksCount" value="2">' +
    '<div id="mixerPanel"></div>';

  ({ Media, Wave } = await import('../src/media.js'));
  ({ State } = await import('../src/state.js'));
  ({ renderAudioTracks } = await import('../src/mixer.js'));
  const { initMediaView } = await import('../src/video-renderer.js');
  initMediaView();
  State.audioProject = {
    mode: 'auto',
    buses: [
      { id: 'ab1', name: '音訊軌 1', muted: false, solo: false, volume: 1 },
      { id: 'ab2', name: '音訊軌 2', muted: false, solo: false, volume: 1 },
    ],
    sourceMaps: {},
    exportLayout: { streams: [] },
  };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('網頁版大型多音軌提示', () => {
  it('6GB 檔案只宣告 Stereo 預覽並持續引導使用桌面版', async () => {
    await Media.probeAndMaybeExtract({ name: '5.1FM+2.0FM.mp4', size: 6_000_000_000 });

    const hint = document.getElementById('atHint');
    expect(hint.hidden).toBe(false);
    expect(getComputedStyle(hint).display).not.toBe('none');
    expect(hint.textContent).toContain('Stereo 預覽');
    expect(hint.textContent).toContain('macOS 或 Windows 桌面版');
    expect(hint.textContent).toContain('全部 Mono 聲道');

    renderAudioTracks();
    expect(hint.textContent).toContain('Stereo 預覽');

    Wave.initLive();
    expect(hint.textContent).toContain('Stereo 預覽');
  });

  it('即使瀏覽器列出多個 audioTracks，也不能略過大型檔警告', async () => {
    Object.defineProperty(document.getElementById('video'), 'audioTracks', {
      configurable: true,
      value: [{ language: '', enabled: false }, { language: '', enabled: false }],
    });

    await Media.probeAndMaybeExtract({ name: 'multi-track.mp4', size: 6_000_000_000 });

    const hint = document.getElementById('atHint');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Stereo 預覽');
    expect(hint.textContent).toContain('全部 Mono 聲道');
  });

  it('6GB 非原生格式走實際 loadVideoFile 分支時明確說明無法載入', async () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:large-mxf') });
    const transcode = vi.spyOn(Media, 'transcodeAndExtract').mockResolvedValue();
    try{
      await Media.loadVideoFile({ name: 'large.mxf', size: 6_000_000_000 });
    }finally{
      if(originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      else delete URL.createObjectURL;
    }

    const hint = document.getElementById('atHint');
    expect(transcode).toHaveBeenCalledOnce();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('無法載入此大型非原生格式');
    expect(hint.textContent).not.toContain('Stereo 預覽');
    expect(hint.textContent).toContain('macOS 或 Windows 桌面版');
  });

  it('卸載媒體時會清除舊警告，不污染下一支檔案', async () => {
    await Media.probeAndMaybeExtract({ name: 'large.mp4', size: 6_000_000_000 });
    Media.reset();
    renderAudioTracks();

    const hint = document.getElementById('atHint');
    expect(Media.audioPanelNotice).toBeNull();
    expect(hint.hidden).toBe(true);
  });
});

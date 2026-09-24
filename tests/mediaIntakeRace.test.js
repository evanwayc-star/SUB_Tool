// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const domMock = vi.hoisted(() => {
  const video = {
    style: {},
    src: '',
    readyState: 1,
    duration: 12,
    videoWidth: 1920,
    videoHeight: 1080,
    playbackRate: 1,
    currentTime: 0,
    muted: false,
    hasAttribute: () => false,
    pause: vi.fn(),
  };
  const elements = new Map();
  return {
    video,
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, textContent: '', innerHTML: '', value: '',
          classList: { add: vi.fn(), remove: vi.fn() },
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
        });
      }
      return elements.get(id);
    },
  };
});

const deskMock = vi.hoisted(() => ({
  stat: vi.fn(async () => ({ exists: true, size: 1024 })),
  probe: vi.fn(async () => ({
    duration: 12,
    video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
    audio: [{ channels: 6, channelLayout: '5.1' }],
  })),
  ingest: vi.fn(),
  fileURL: vi.fn(async path => `file:///${String(path).replaceAll('\\', '/')}`),
  waveAudio: vi.fn(),
  cleanupAudio: vi.fn(),
}));

vi.mock('../src/dom.js', () => domMock);
vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), openModal: vi.fn(), closeModal: vi.fn(),
}));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn(), clearMeterStrips: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn() }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

let Media;
let Wave;
let State;
let resetAudioProject;
let resetPlayerAdapter;
let setStatus;
let showToast;
let pending;

describe('desktop mother-source intake ownership', () => {
  beforeAll(async () => {
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { isDesktop: true, ...deskMock },
    });
    window.AudioContext = class {
      constructor(){ this.state = 'running'; this.destination = {}; this.currentTime = 0; }
      createGain(){ return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createAnalyser(){ return { connect: vi.fn(), fftSize: 0 }; }
      createMediaElementSource(){ return { channelCount: 2, connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelSplitter(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      createChannelMerger(){ return { connect: vi.fn(), disconnect: vi.fn() }; }
      resume(){}
    };
    ({ Media, Wave } = await import('../src/media.js'));
    ({ State, resetAudioProject } = await import('../src/state.js'));
    ({ resetPlayerAdapter } = await import('../src/media-player-adapter.js'));
    ({ setStatus, showToast } = await import('../src/ui.js'));
  });

  beforeEach(() => {
    pending = new Map();
    deskMock.stat.mockClear();
    deskMock.probe.mockClear();
    deskMock.fileURL.mockClear();
    deskMock.ingest.mockReset();
    deskMock.waveAudio.mockReset();
    deskMock.cleanupAudio.mockReset();
    setStatus.mockClear();
    showToast.mockClear();
    deskMock.ingest.mockImplementation(({ path }) => {
      const work = deferred();
      pending.set(path, work);
      return work.promise;
    });
    Media.reset();
    Media.ctx = null;
    Media.master = null;
    Media.tracks = [];
    State.cues = [];
    State.clips = [];
    State.mediaPath = null;
    resetAudioProject();
    domMock.video.src = '';
    domMock.video.readyState = 1;
    domMock.video.duration = 12;
    delete window.subtool.streamIngest;
  });

  it('原生預覽 metadata 較短時保留 ffprobe 母素材片長', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/native.webm');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it('邊轉邊播 Proxy 的暫時片長不縮短母素材', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    window.subtool.streamIngest = vi.fn(async () => ({
      streamUrl: 'file:///C:/cache/growing-proxy.mp4', cached: true, channels: [],
    }));
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/growing.mov');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it('一般 ingest Proxy 的 metadata 較短時保留母素材片長', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 6, channelLayout: '5.1' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [] });
    domMock.video.duration = 30;

    await Media.loadDesktopMedia('C:/media/multichannel.webm');

    expect(State.duration).toBe(120);
    expect(State.clips[0].dur).toBe(120);
  });

  it('切到另一段原生影片時不讓較短 metadata 覆寫其已探測片長', async () => {
    const info = {
      duration: 120,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [],
    };
    deskMock.probe.mockResolvedValueOnce(info).mockResolvedValueOnce(info);
    await Media.loadDesktopMedia('C:/media/first.webm');
    const second = await Media.addClipDesktop('C:/media/second.webm');
    domMock.video.duration = 30;

    await Media._ensureClip(second, 0, false);

    expect(second.dur).toBe(120);
    expect(second.out).toBe(120);
  });

  it('一般 ingest 音訊 metadata 失敗時保留影片並顯示錯誤', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'vp9', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 6, channelLayout: '5.1' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [{ file: 'C:/cache/bad.wav' }] });
    const audio = vi.spyOn(Media._intakeSession, 'materializeAudioElements')
      .mockRejectedValueOnce(new Error('metadata 讀取失敗'));

    try {
      await Media.loadDesktopMedia('C:/media/audio-error.webm');
      expect(State.clips[0].path).toBe('C:/media/audio-error.webm');
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('metadata 讀取失敗'));
      expect(setStatus).toHaveBeenLastCalledWith('影片已載入，但音訊預覽載入失敗', 'err');
    } finally {
      audio.mockRestore();
    }
  });

  it('邊轉邊播音訊 metadata 失敗時顯示錯誤', async () => {
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    window.subtool.streamIngest = vi.fn(async () => ({
      streamUrl: 'file:///C:/cache/growing-proxy.mp4', cached: true,
      channels: [{ file: 'C:/cache/bad.wav' }],
    }));
    const audio = vi.spyOn(Media._intakeSession, 'materializeAudioElements')
      .mockRejectedValueOnce(new Error('metadata 讀取失敗'));

    try {
      await Media.loadDesktopMedia('C:/media/audio-error.mov');
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith(
        '影片已載入，但音訊預覽載入失敗', 'err'));
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('metadata 讀取失敗'));
    } finally {
      audio.mockRestore();
    }
  });

  it('discarding A after B starts prevents late ingest results from replacing B', async () => {
    const loadA = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/A.mp4')).toBe(true));

    const loadB = Media.loadDesktopMedia('C:/media/B.mp4');
    await vi.waitFor(() => expect(pending.has('C:/media/B.mp4')).toBe(true));

    pending.get('C:/media/B.mp4').resolve({ channels: [] });
    await loadB;
    pending.get('C:/media/A.mp4').resolve({ channels: [] });
    await loadA;

    expect(State.mediaPath).toBe('C:/media/B.mp4');
    expect(domMock.video.src).toBe('file:///C:/media/B.mp4');
    expect(State.clips).toHaveLength(1);
    expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mp4', primary: true });
  });

  it('does not attach stale background channels to the new primary after proxy URL lookup', async () => {
    const proxyURL = deferred();
    deskMock.ingest.mockResolvedValueOnce({
      proxy: 'C:/cache/A-proxy.mp4',
      channels: [{ file: 'C:/cache/A-ch1.m4a', sourceStream: 0, sourceChannel: 0 }],
    });
    deskMock.fileURL.mockImplementation(path => path === 'C:/cache/A-proxy.mp4'
      ? proxyURL.promise
      : Promise.resolve(`file:///${String(path).replaceAll('\\', '/')}`));

    const primaryA = Media._registerPrimary({
      name: 'A.mp4', path: 'C:/media/A.mp4', dur: 12, audioSourceId: 'source-a',
    });
    const stale = Media._bgAudioIngest('C:/media/A.mp4', [{ channels: 1 }], 12, primaryA);
    await vi.waitFor(() => expect(deskMock.fileURL).toHaveBeenCalledWith('C:/cache/A-proxy.mp4'));

    Media.reset();
    resetAudioProject();
    State.mediaName = 'B.mp4';
    Media._registerPrimary({
      name: 'B.mp4', path: 'C:/media/B.mp4', dur: 12, audioSourceId: 'source-b',
    });
    proxyURL.resolve('file:///C:/cache/A-proxy.mp4');
    await stale;

    expect(State.audioProject.sourceMaps['source-b']).toBeUndefined();
    expect(Media.tracks).toEqual([]);
  });

  it('does not commit desktop native waveform data after the last source placement is deleted', async () => {
    const wavePath = deferred();
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [{ channels: 2, channelLayout: 'stereo' }],
    });
    deskMock.ingest.mockResolvedValueOnce({ channels: [] });
    deskMock.waveAudio.mockReturnValueOnce(wavePath.promise);

    const loading = Media.loadDesktopMedia('C:/media/A.mp4');
    await vi.waitFor(() => expect(deskMock.waveAudio).toHaveBeenCalledTimes(1));
    const primary = State.clips[0];
    expect(Media.removeClip(primary.id)).toBe(true);
    wavePath.resolve('C:/cache/A-wave.wav');
    await loading;

    expect(Wave._sourceState(primary, false)).toBeNull();
    expect(deskMock.cleanupAudio).toHaveBeenCalledWith('C:/cache/A-wave.wav');
  });

  it('uses mpv preview for a native MP4 when frame-accurate preview is available', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect(Media.mpvMode).toBe(true);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('maps mpv source time through the active clip and ignores stale time-pos in a gap', async () => {
    let notifyMpv = () => {};
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => { notifyMpv = callback; }),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/offset-clip.mp4');
      const clip = State.clips[0];
      Object.assign(clip, { in: 1, out: 11, offset: 10 });
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 2 });
      expect(Media.displayTime()).toBe(11);
      expect(domMock.$('tcCur').textContent).toBe('00:00:11:00');
      expect(domMock.$('seekBar').value).toBe(11000);

      Media._gap = true;
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 5 });
      expect(Media._mpvTime).toBe(2);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('大型 Canopus AVI 初次匯入只建音訊快取，加入第二支影片才補做主影片 Proxy', async () => {
    const source='C:/media/large-canopus.avi';
    let notifyMpv=()=>{};
    const mpv={
      detect:vi.fn(async()=>({available:true})),
      launch:vi.fn(async()=>({duration:7400})),
      quit:vi.fn(async()=>{}), onEvent:vi.fn(callback=>{ notifyMpv=callback; }), setBounds:vi.fn(async()=>{}),
      seek:vi.fn(async()=>{}), mute:vi.fn(async()=>{}),
    };
    window.subtool.mpv=mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.stat.mockResolvedValueOnce({exists:true,size:116_524_384_242});
    deskMock.probe.mockResolvedValueOnce({
      duration:7448.441,
      video:{codec:'hq_hqa',fps:30000/1001,width:1920,height:1080},
      audio:[{channels:2,codec:'pcm_s16le'}],
    });
    deskMock.ingest.mockImplementation(async ({path,needsProxy})=>({
      channels:[],
      ...(path===source&&needsProxy?{proxy:'C:/cache/canopus-proxy.mp4'}:{}),
    }));

    try{
      await Media.loadDesktopMedia(source);
      expect(State.duration).toBe(7448.441);
      notifyMpv({event:'property-change',name:'duration',data:7400});
      expect(State.duration).toBe(7448.441);
      expect(State.clips[0].dur).toBe(7448.441);
      expect(deskMock.ingest).not.toHaveBeenCalled();
      Media._commitPresentedTarget(0);
      await vi.waitFor(()=>expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
        path:source,needsProxy:false,
      })));
      expect(Media.webCodecsProxyPath()).toBeNull();

      await Media.addClipDesktop('C:/media/second.mp4');
      await vi.waitFor(()=>expect(Media.webCodecsProxyPath()).toBe(source));
      expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({
        path:source,needsProxy:true,
      }));
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('短 GOP Proxy 就緒後倒播切到 Proxy，停止時在同一來源時間切回母素材', async () => {
    let notifyMpv = () => {};
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      loadfile: vi.fn(async () => ({ ok: true, duration: 12 })),
      seek: vi.fn(async () => {}),
      direction: vi.fn(async () => true),
      mute: vi.fn(async () => {}),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => { notifyMpv = callback; }),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });
    deskMock.ingest.mockResolvedValueOnce({ proxy: 'C:/cache/short-gop-proxy.mp4', channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/long-gop.mp4');
      await vi.waitFor(() => expect(Media.reverseShuttleProxyReady()).toBe(true));
      expect(deskMock.ingest).toHaveBeenCalledWith(expect.objectContaining({ needsProxy: true }));

      Media._mpvTime = 8;
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(true);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(1, 'C:/cache/short-gop-proxy.mp4');
      expect(mpv.seek).toHaveBeenLastCalledWith(8, undefined);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 0 });
      expect(Media._mpvTime).toBe(8);
      expect(Media.presentedTime()).toBeNull();
      notifyMpv({ event: 'property-change', name: 'duration', data: 11 });
      expect(State.duration).toBe(12);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 8 });
      expect(Media.presentedTime()).toBe(8);

      Media._mpvTime = 7.5;
      await expect(Media.setPlaybackDirection('forward')).resolves.toBe(true);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(2, 'C:/media/long-gop.mp4');
      expect(mpv.seek).toHaveBeenLastCalledWith(7.5, undefined);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 0 });
      expect(Media._mpvTime).toBe(7.5);

      mpv.seek.mockRejectedValueOnce(new Error('seek failed'));
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(false);
      expect(mpv.loadfile).toHaveBeenNthCalledWith(3, 'C:/cache/short-gop-proxy.mp4');
      expect(mpv.loadfile).toHaveBeenNthCalledWith(4, 'C:/media/long-gop.mp4');
      expect(Media._reverseProxyActive).toBe(false);
      notifyMpv({ event: 'property-change', name: 'time-pos', data: 7.5 });
      expect(Media.mpvSourceTransitionPending()).toBe(false);

      mpv.loadfile.mockResolvedValueOnce({ ok: false });
      await expect(Media.setPlaybackDirection('backward')).resolves.toBe(false);
      expect(Media.mpvSourceTransitionPending()).toBe(false);
      expect(Media._reverseProxyActive).toBe(false);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('uses mpv preview for a native H.265 MP4 when frame-accurate preview is available', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      present: vi.fn(async time => ({ backend: 'mpv', presentedSourceTime: time })),
      direction: vi.fn(async () => true),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'hevc', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate-h265.mp4');
      await Media.seek(3.96);

      expect(Media.mpvMode).toBe(true);
      expect(mpv.present.mock.calls.at(-1)[0]).toBeCloseTo(3.94, 8);
      expect(mpv.present.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ exact: true }));
      expect(Media.supportsNativeReverse()).toBe(false);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('restores normal mpv seeking without shortening a probed clip after source switch', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      loadfile: vi.fn(async () => ({ ok: true, duration: 8 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      mute: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'hevc', fps: 25, width: 1920, height: 1080 },
        audio: [],
      })
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
        audio: [],
      });

    try {
      await Media.loadDesktopMedia('C:/media/primary-h265.mp4');
      const h264 = await Media.addClipDesktop('C:/media/following-h264.mp4');
      mpv.seek.mockClear();

      Media.seek(h264.offset + 3.96);
      await vi.waitFor(() => expect(mpv.seek).toHaveBeenCalled());

      expect(mpv.seek).toHaveBeenLastCalledWith(3.96, undefined);
      expect(h264.dur).toBe(12);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('keeps a compositable source URL for frame-accurate MP4 mpv preview', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect(State.clips[0].web?.url).toBe('file:///C:/media/frame-accurate.mp4');
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('falls back to HTML5 when frame-accurate MP4 mpv preview cannot launch', async () => {
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => { throw new Error('mpv pipe failed'); }),
      quit: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValueOnce({
      duration: 12,
      video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      await Media.loadDesktopMedia('C:/media/frame-accurate.mp4');

      expect({ mode: Media.mpvMode, source: domMock.video.src }).toEqual({
        mode: false,
        source: 'file:///C:/media/frame-accurate.mp4',
      });
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('serializes overlapping mpv launches and cleans the stale native runtime before B starts', async () => {
    const launches = new Map();
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(({ src }) => {
        const work = deferred();
        launches.set(src, work);
        return work.promise;
      }),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe.mockResolvedValue({
      duration: 12,
      video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
      audio: [],
    });

    try {
      const loadA = Media.loadDesktopMedia('C:/media/A.mov');
      await vi.waitFor(() => expect(launches.has('C:/media/A.mov')).toBe(true));
      const loadB = Media.loadDesktopMedia('C:/media/B.mov');
      await Promise.resolve();
      expect(mpv.launch).toHaveBeenCalledTimes(1);

      // 主程序可能已建立 native window/process，卻在 pipe 連線階段失敗。
      launches.get('C:/media/A.mov').reject(new Error('mpv pipe failed'));
      await vi.waitFor(() => expect(launches.has('C:/media/B.mov')).toBe(true));
      const staleRuntimeWasCleaned = mpv.quit.mock.calls.length === 1;
      launches.get('C:/media/B.mov').resolve({ duration: 12 });
      await Promise.all([loadA, loadB]);

      expect(staleRuntimeWasCleaned).toBe(true);
      expect(State.mediaPath).toBe('C:/media/B.mov');
      expect(State.clips).toHaveLength(1);
      expect(State.clips[0]).toMatchObject({ path: 'C:/media/B.mov', primary: true });
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });

  it('ignores late events from an mpv intake after a newer HTML media load owns the timeline', async () => {
    const callbacks = [];
    const mpv = {
      detect: vi.fn(async () => ({ available: true })),
      launch: vi.fn(async () => ({ duration: 12 })),
      quit: vi.fn(async () => {}),
      onEvent: vi.fn(callback => callbacks.push(callback)),
      setBounds: vi.fn(async () => {}),
    };
    window.subtool.mpv = mpv;
    resetPlayerAdapter(window.subtool);
    deskMock.probe
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'prores', fps: 25, width: 1920, height: 1080 },
        audio: [],
      })
      .mockResolvedValueOnce({
        duration: 12,
        video: { codec: 'h264', fps: 25, width: 1920, height: 1080 },
        audio: [{ channels: 6, channelLayout: '5.1' }],
      });
    deskMock.ingest.mockResolvedValue({ channels: [] });

    try {
      await Media.loadDesktopMedia('C:/media/A.mov');
      expect(callbacks).toHaveLength(1);
      await Media.loadDesktopMedia('C:/media/B.mp4');
      const current = State.clips[0];

      callbacks[0]({ event: 'property-change', name: 'duration', data: 99 });

      expect(State.mediaPath).toBe('C:/media/B.mp4');
      expect(current).toMatchObject({ path: 'C:/media/B.mp4', dur: 12, out: 12 });
      expect(State.duration).toBe(12);
    } finally {
      Media.reset();
      delete window.subtool.mpv;
      resetPlayerAdapter(window.subtool);
    }
  });
});

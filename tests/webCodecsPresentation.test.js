// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipA = { id: 'a', web: { url: 'a.mp4' }, in: 10, out: 20, offset: 100, vtrack: 0 };
const clipB = { id: 'b', web: { url: 'b.mp4' }, in: 0, out: 10, offset: 102, vtrack: 1 };

const stateMock = vi.hoisted(() => ({
  State: {
    clips: [], videoTracks: [], videoWidth: 1920, videoHeight: 1080,
  },
}));
const mediaMock = vi.hoisted(() => ({
  mpvMode: false,
  seqOn: vi.fn(() => true),
  tlTime: vi.fn(() => 104),
  inGap: vi.fn(() => false),
  webCodecsTakeover: vi.fn(() => true),
  setWebCodecsTakeover: vi.fn(),
  setWebCodecsComposited: vi.fn(),
  reportWebCodecsPresentation: vi.fn(),
}));
const contextMock = vi.hoisted(() => ({
  fillRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
  beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
  fillStyle: '', globalAlpha: 1,
}));
const compositeMock = vi.hoisted(() => vi.fn(() => true));
const fadeMock = vi.hoisted(() => vi.fn(() => 1));
const canvasMock = vi.hoisted(() => ({
  style: { display: 'block' }, width: 640, height: 360,
  parentElement: { clientWidth: 640, clientHeight: 360 },
  getContext: vi.fn(() => contextMock),
}));

vi.mock('../src/state.js', () => stateMock);
vi.mock('../src/media.js', () => ({ Media: mediaMock }));
vi.mock('../src/dom.js', () => ({
  video: { currentSrc: '', src: '' },
  $: id => id === 'previewCanvas' ? canvasMock : null,
}));
vi.mock('../src/sequence.js', () => ({
  Seq: {
    clipsAt: vi.fn(() => [clipA, clipB]),
    clipEnd: clip => clip.offset + clip.out - clip.in,
    toSource: (timeline, clip) => timeline - clip.offset + clip.in,
    toTimeline: (source, clip) => source - clip.in + clip.offset,
  },
}));
vi.mock('../src/media-player-adapter.js', () => ({ getPlayerAdapter: () => ({}) }));
vi.mock('../src/events.js', () => ({ emit: vi.fn() }));
vi.mock('../src/ui.js', () => ({ showToast: vi.fn() }));
vi.mock('../src/image-compositor-engine.js', () => ({
  fadeAlphaAtTimeline: fadeMock,
  needsComposite: compositeMock,
  stageBox: ({ canvasW, canvasH }) => ({ x: 0, y: 0, w: canvasW, h: canvasH }),
  imageBoxOnStage: ({ stageW, stageH }) => ({ x: 0, y: 0, w: stageW, h: stageH }),
  trackFrame: ({ stageW, stageH }) => ({ x: 0, y: 0, w: stageW, h: stageH }),
}));
vi.mock('../src/decode/demux.js', () => ({
  demuxFile: vi.fn(), demuxIndex: vi.fn(), SampleReader: class {}, MemReader: class {},
}));
vi.mock('../src/decode/sample-index.js', () => ({ keyIndexBefore: vi.fn(() => 0) }));

const { WCPreview } = await import('../src/decode/player.js');
const { Seq } = await import('../src/sequence.js');

describe('WebCodecs presentation acknowledgement', () => {
  beforeEach(() => {
    stateMock.State.clips = [clipA, clipB];
    stateMock.State.videoTracks = [
      { visible: true, opacity: 1, scale: 1, posX: 0.5, posY: 0.5 },
      { visible: true, opacity: 1, scale: 1, posX: 0.5, posY: 0.5 },
    ];
    mediaMock.reportWebCodecsPresentation.mockClear();
    mediaMock.mpvMode = false;
    mediaMock.tlTime.mockReturnValue(104);
    compositeMock.mockImplementation(() => true);
    fadeMock.mockReturnValue(1);
    Seq.clipsAt.mockImplementation(() => [clipA,clipB]);
    contextMock.drawImage.mockClear();
    WCPreview.canvas = canvasMock;
    WCPreview.ctx = contextMock;
    WCPreview.enabled = true;
    WCPreview._sourceUse = new Map();
    WCPreview.sources = new Map([
      ['a.mp4#0', { state: 'ready', request: vi.fn(() => ({ timestamp: 14e6, displayWidth: 1920, displayHeight: 1080 })) }],
      ['b.mp4#1', { state: 'ready', request: vi.fn(() => ({ timestamp: 2e6, displayWidth: 1920, displayHeight: 1080 })) }],
    ]);
  });

  it('所有可見層 drawImage 成功後才回報各層映回的時間軸 PTS', () => {
    WCPreview.tick();

    expect(contextMock.drawImage).toHaveBeenCalledTimes(2);
    expect(mediaMock.reportWebCodecsPresentation).toHaveBeenCalledWith([104, 104]);
  });

  it('仍由 mpv 播單片段時，提前解出即將開始的疊層畫格', () => {
    clipA.proxyUrl='a.mp4'; clipB.proxyUrl='b.mp4';
    mediaMock.mpvMode=true;
    mediaMock.tlTime.mockReturnValue(100.5);
    Seq.clipsAt.mockImplementation(t=>t<102 ? [clipA] : [clipA,clipB]);
    compositeMock.mockImplementation(acts=>acts.length>1);
    const a=WCPreview.sources.get('a.mp4#0');
    const b=WCPreview.sources.get('b.mp4#1');
    try{
      WCPreview.tick();
      expect(a.request).toHaveBeenCalledWith(12001000);
      expect(b.request).toHaveBeenCalledWith(1000);
      expect(WCPreview.mode).toBe('mpv');
      expect(mediaMock.setWebCodecsTakeover).not.toHaveBeenCalledWith(true);
    }finally{
      delete clipA.proxyUrl; delete clipB.proxyUrl;
    }
  });

  it('淘汰不再鄰近播放點的解碼來源，保留作用層', () => {
    const dispose=vi.fn();
    const now=performance.now();
    WCPreview.sources=new Map([
      ['active',{url:'a.mp4',dispose}],
      ['old',{url:'old.mp4',dispose}],
    ]);
    WCPreview._sourceUse=new Map([['active',now],['old',now-3000]]);
    WCPreview._pruneSources(new Set(['active']));
    expect([...WCPreview.sources.keys()]).toEqual(['active']);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('疊層缺少畫格時不以不完整畫面接管 mpv', () => {
    clipA.proxyUrl='a.mp4'; clipB.proxyUrl='b.mp4';
    mediaMock.mpvMode=true;
    mediaMock.webCodecsTakeover.mockReturnValueOnce(false);
    WCPreview.sources.get('b.mp4#1').request.mockReturnValue(null);
    try{
      WCPreview.tick();
      expect(WCPreview.mode).toBe('off');
      expect(canvasMock.style.display).toBe('none');
      expect(mediaMock.reportWebCodecsPresentation).not.toHaveBeenCalled();
    }finally{
      delete clipA.proxyUrl; delete clipB.proxyUrl;
    }
  });

  it('所有層全透明時即使畫格未就緒也呈現正確黑畫面', () => {
    clipA.proxyUrl='a.mp4'; clipB.proxyUrl='b.mp4';
    mediaMock.mpvMode=true;
    fadeMock.mockReturnValue(0);
    WCPreview.sources.get('a.mp4#0').request.mockReturnValue(null);
    WCPreview.sources.get('b.mp4#1').request.mockReturnValue(null);
    try{
      WCPreview.tick();
      expect(WCPreview.mode).toBe('black');
      expect(mediaMock.reportWebCodecsPresentation).toHaveBeenCalledWith([104]);
    }finally{
      delete clipA.proxyUrl; delete clipB.proxyUrl;
    }
  });
});

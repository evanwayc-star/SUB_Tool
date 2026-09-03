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
  fadeAlphaAtTimeline: () => 1,
  needsComposite: () => true,
  stageBox: ({ canvasW, canvasH }) => ({ x: 0, y: 0, w: canvasW, h: canvasH }),
  imageBoxOnStage: ({ stageW, stageH }) => ({ x: 0, y: 0, w: stageW, h: stageH }),
  trackFrame: ({ stageW, stageH }) => ({ x: 0, y: 0, w: stageW, h: stageH }),
}));
vi.mock('../src/decode/demux.js', () => ({
  demuxFile: vi.fn(), demuxIndex: vi.fn(), SampleReader: class {}, MemReader: class {},
}));
vi.mock('../src/decode/sample-index.js', () => ({ keyIndexBefore: vi.fn(() => 0) }));

const { WCPreview } = await import('../src/decode/player.js');

describe('WebCodecs presentation acknowledgement', () => {
  beforeEach(() => {
    stateMock.State.clips = [clipA, clipB];
    stateMock.State.videoTracks = [
      { visible: true, opacity: 1, scale: 1, posX: 0.5, posY: 0.5 },
      { visible: true, opacity: 1, scale: 1, posX: 0.5, posY: 0.5 },
    ];
    mediaMock.reportWebCodecsPresentation.mockClear();
    contextMock.drawImage.mockClear();
    WCPreview.canvas = canvasMock;
    WCPreview.ctx = contextMock;
    WCPreview.enabled = true;
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
});

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
const publishContext = vi.hoisted(() => ({drawImage:vi.fn(),fillRect:vi.fn(),fillStyle:''}));
const canvasMock = vi.hoisted(() => ({
  style: { display: 'block' }, width: 640, height: 360,
  parentElement: { clientWidth: 640, clientHeight: 360 },
  getContext: vi.fn(() => publishContext),
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
    vi.clearAllMocks();
    mediaMock.mpvMode = false;
    mediaMock.webCodecsTakeover.mockReturnValue(true);
    mediaMock.tlTime.mockReturnValue(104);
    Seq.clipsAt.mockImplementation(() => [clipA,clipB]);
    contextMock.drawImage.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(contextMock);
    canvasMock.width=640;canvasMock.height=360;canvasMock.style.display='block';
    WCPreview.canvas = canvasMock;
    WCPreview.ctx = publishContext;
    WCPreview._renderCanvas=null;
    WCPreview._images=new Map();
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
    mediaMock.webCodecsTakeover.mockReturnValue(false);
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
    stateMock.State.videoTracks.forEach(track=>{track.opacity=0;});
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

  it('圖片與影片依同一軌序合成，圖片不提供影片呈現 timestamp',()=>{
    const lower={id:'img-low',type:'image',path:'blob:green',in:0,out:20,offset:100,vtrack:0};
    const upper={...clipB,vtrack:1};
    Seq.clipsAt.mockReturnValue([upper,lower]);
    const bitmap={naturalWidth:640,naturalHeight:360};
    WCPreview._images.set('blob:green',{state:'ready',image:bitmap});
    const videoFrame=WCPreview.sources.get('b.mp4#1').request();
    WCPreview.sources.get('b.mp4#1').request.mockReturnValue(videoFrame);

    WCPreview.tick();

    expect(contextMock.drawImage.mock.calls.map(([source])=>source)).toEqual([bitmap,videoFrame]);
    expect(publishContext.drawImage).toHaveBeenCalledOnce();
    expect(mediaMock.reportWebCodecsPresentation).toHaveBeenCalledWith([104]);
    expect(mediaMock.setWebCodecsComposited).toHaveBeenLastCalledWith(true,{time:104,imageIds:['img-low'],imagesComposited:true});
  });

  it('上層圖片可留在 native guide，不強制解碼單一滿版影片',()=>{
    const upper={id:'img-high',type:'image',path:'blob:green',in:0,out:20,offset:100,vtrack:1};
    clipA.proxyUrl='a.mp4';mediaMock.mpvMode=true;
    Seq.clipsAt.mockReturnValue([clipA,upper]);
    try{
      WCPreview.tick();
      expect(WCPreview.mode).toBe('mpv');
      expect(contextMock.drawImage).not.toHaveBeenCalled();
      expect(mediaMock.setWebCodecsComposited).toHaveBeenLastCalledWith(false);
    }finally{delete clipA.proxyUrl;}
  });

  it('缺少圖片 bitmap 時保留上一張完整畫格與 snapshot，不畫半個 stack',()=>{
    const lower={id:'img',type:'image',path:'blob:pending',in:0,out:20,offset:100,vtrack:0};
    Seq.clipsAt.mockReturnValue([lower,clipB]);
    WCPreview._images.set('blob:pending',{state:'loading',image:{}});

    WCPreview.tick();

    expect(publishContext.fillRect).not.toHaveBeenCalled();
    expect(publishContext.drawImage).not.toHaveBeenCalled();
    expect(contextMock.drawImage).not.toHaveBeenCalled();
    expect(mediaMock.setWebCodecsComposited).toHaveBeenLastCalledWith(true);
    expect(mediaMock.reportWebCodecsPresentation).not.toHaveBeenCalled();
  });

  it('取得完整畫格後 bitmap 繪製失敗，不發布不完整畫面或冒充呈現完成',()=>{
    const lower={id:'img',type:'image',path:'blob:failed-draw',in:0,out:20,offset:100,vtrack:0};
    Seq.clipsAt.mockReturnValue([lower,clipB]);
    WCPreview._images.set('blob:failed-draw',{state:'ready',image:{naturalWidth:640,naturalHeight:360}});
    contextMock.drawImage.mockImplementationOnce(()=>{throw new Error('bitmap released');});

    WCPreview.tick();

    expect(publishContext.drawImage).not.toHaveBeenCalled();
    expect(mediaMock.setWebCodecsComposited).not.toHaveBeenCalled();
    expect(mediaMock.reportWebCodecsPresentation).not.toHaveBeenCalled();
  });

  it('snapshot 的時間使用實際影片 PTS，不能用尚未命中的要求時間',()=>{
    WCPreview.sources.get('b.mp4#1').request.mockReturnValue({timestamp:1.99e6,displayWidth:1920,displayHeight:1080});
    WCPreview.tick();
    expect(mediaMock.setWebCodecsComposited).toHaveBeenLastCalledWith(true,{time:103.99,imageIds:[],imagesComposited:false});
    expect(mediaMock.reportWebCodecsPresentation).toHaveBeenCalledWith([104,103.99]);
  });
});

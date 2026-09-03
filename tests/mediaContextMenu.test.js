// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  State: {
    clips: [],
    videoTracks: [],
    externalAudioState: [],
    selectedIds: [],
    selectedId: null,
    clipboard: [],
    trackCount: 0,
    tracks: [],
    duration: 30,
    mediaName: null,
    mediaPath: null,
    activeEdge: 'start',
  },
  showSourceInFolder: vi.fn().mockResolvedValue(true),
  showToast: vi.fn(),
  emit: vi.fn(),
  selectClip: vi.fn(),
  getExternalAudioSource: vi.fn(),
  displayTime: vi.fn(() => 5),
  splitClipAt: vi.fn(),
  splitExternalAudio: vi.fn(),
  removeExternalAudio: vi.fn(),
  toggleExternalAudioEnabled: vi.fn(),
  sourceChannels: vi.fn(() => []),
  getSourceWaveOptions: vi.fn(() => ['mix']),
  getSourceWaveSelection: vi.fn(() => 'mix'),
  setSourceWaveSelection: vi.fn(),
}));

vi.mock('../src/state.js', () => ({
  State: mocks.State,
  IS_DESKTOP: true,
  isSel: vi.fn(() => false),
  setSelection: vi.fn(),
  deselect: vi.fn(),
}));

vi.mock('../src/media.js', () => ({
  Media: {
    displayTime: mocks.displayTime,
    getExternalAudioSource: mocks.getExternalAudioSource,
    sourceChannels: mocks.sourceChannels,
    splitClipAt: mocks.splitClipAt,
    splitExternalAudio: mocks.splitExternalAudio,
    removeExternalAudio: mocks.removeExternalAudio,
    toggleExternalAudioEnabled: mocks.toggleExternalAudioEnabled,
  },
  Wave: {
    getSourceWaveOptions: mocks.getSourceWaveOptions,
    getSourceWaveSelection: mocks.getSourceWaveSelection,
    setSourceWaveSelection: mocks.setSourceWaveSelection,
  },
}));

vi.mock('../src/subtitles.js', () => ({
  selectCue: vi.fn(),
  refreshSelectionUI: vi.fn(),
  enterSwapMode: vi.fn(),
  deleteSelected: vi.fn(),
  copySelectedStyle: vi.fn(),
  pasteStyleToSelected: vi.fn(),
  hasClipboardStyle: vi.fn(() => false),
}));

vi.mock('../src/subtitle-model.js', () => ({
  addCue: vi.fn(),
  addCueRelative: vi.fn(),
  clearSelectedCuesTime: vi.fn(),
  shiftTextsDown: vi.fn(),
  shiftTextsUp: vi.fn(),
  swapAdjacentCues: vi.fn(),
  mergeAdjacentCues: vi.fn(),
  copyCues: vi.fn(),
  pasteCues: vi.fn(),
}));

vi.mock('../src/timeline-interaction-engine.js', () => ({
  moveSelectedToTrack: vi.fn(),
  xToTime: vi.fn(() => 0),
  trackFromY: vi.fn(() => 0),
  tracksTop: vi.fn(() => 0),
  drawTimeline: vi.fn(),
  selectClip: mocks.selectClip,
  showClipFade: vi.fn(),
  showCrossfade: vi.fn(),
  showImageGeom: vi.fn(),
  showClipDuration: vi.fn(),
}));

vi.mock('../src/sequence.js', () => ({
  Seq: {
    byId: vi.fn(id => mocks.State.clips.find(clip => clip.id === id) || null),
    clipAt: vi.fn(() => null),
    trackClips: vi.fn(track => mocks.State.clips.filter(clip => (clip.vtrack || 0) === track)),
    clipEnd: vi.fn(clip => clip.offset + (clip.out - clip.in)),
    len: vi.fn(clip => clip.out - clip.in),
    moveToTrack: vi.fn(),
    sort: vi.fn(),
    recomputeDuration: vi.fn(),
  },
}));

vi.mock('../src/ui.js', () => ({ showToast: mocks.showToast, promptModal: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/events.js', () => ({ emit: mocks.emit }));
vi.mock('../src/audio-routing.js', () => ({ AudioRouting: { openForSource: vi.fn(), openForClip: vi.fn() } }));
vi.mock('../src/keyboard.js', () => ({ setManualPlaybackSpeed: vi.fn() }));

vi.mock('../src/speech-recognition.js', () => ({ openSpeechRecognitionDialog: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ requestPointerSeek: vi.fn() }));

function resetState() {
  Object.assign(mocks.State, {
    clips: [],
    videoTracks: [],
    externalAudioState: [],
    selectedIds: [],
    selectedId: null,
    clipboard: [],
    trackCount: 0,
    tracks: [],
    duration: 30,
    mediaName: null,
    mediaPath: null,
    activeEdge: 'start',
  });
}

function installTimelineDom() {
  document.body.innerHTML = `
    <video id="video"></video>
    <div id="videoWrap"></div>
    <div id="speedIndicator"></div>
    <div id="tlScroll"></div>
    <div id="tlLayer"></div>
    <div id="tlAtracks"></div>
    <div id="tlGutterAtracks"></div>
    <div id="ctxmenu"></div>
    <div id="stSel"></div>
  `;
}

async function loadMenus() {
  await import('../src/menus.js');
}

function openContextMenu(element) {
  element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
  }));
}

function revealItem() {
  return document.querySelector('#ctxmenu [data-menu-id="reveal_source"]');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resetState();
  installTimelineDom();
  mocks.displayTime.mockReturnValue(5);
  mocks.getExternalAudioSource.mockReturnValue(null);
  mocks.sourceChannels.mockReturnValue([]);
  mocks.getSourceWaveOptions.mockReturnValue(['mix']);
  mocks.getSourceWaveSelection.mockReturnValue('mix');
  Object.defineProperty(window, 'subtool', {
    configurable: true,
    value: { showSourceInFolder: mocks.showSourceInFolder },
  });
});

describe('時間軸媒體右鍵選單', () => {
  it('鎖定視訊軌仍可從右鍵選單在檔案管理器顯示母素材', async () => {
    const path = 'C:\\Media\\locked-program.mov';
    mocks.State.clips = [{
      id: 'locked-video', name: 'locked-program.mov', path,
      vtrack: 0, offset: 0, in: 0, out: 20, dur: 20,
    }];
    mocks.State.videoTracks = [{ name: '視訊軌 1', locked: true }];
    const block = document.createElement('div');
    block.className = 'clip-block';
    block.dataset.clipId = 'locked-video';
    document.getElementById('tlLayer').appendChild(block);
    await loadMenus();

    openContextMenu(block);
    const reveal = revealItem();
    const lockStatus = document.querySelector('#ctxmenu [data-menu-id="locked_status"]');
    expect(reveal).not.toBeNull();
    expect(lockStatus?.getAttribute('role')).toBe('status');
    expect(lockStatus?.getAttribute('role')).not.toBe('menuitem');
    reveal.click();

    expect(mocks.showSourceInFolder).toHaveBeenCalledWith(path);
  });

  it('主影片沒有 clip.path 時以 State.mediaPath 定位母素材', async () => {
    const path = 'C:\\Media\\primary-fallback.mov';
    mocks.State.mediaPath = path;
    mocks.State.clips = [{
      id: 'primary-video', name: 'primary-fallback.mov', primary: true,
      vtrack: 0, offset: 0, in: 0, out: 20, dur: 20,
    }];
    mocks.State.videoTracks = [{ name: '視訊軌 1', locked: true }];
    const block = document.createElement('div');
    block.className = 'clip-block';
    block.dataset.clipId = 'primary-video';
    document.getElementById('tlLayer').appendChild(block);
    await loadMenus();

    openContextMenu(block);
    revealItem().click();

    expect(mocks.showSourceInFolder).toHaveBeenCalledWith(path);
  });

  it('影片原音片段可從右鍵選單在檔案管理器顯示同一支影片', async () => {
    const path = 'D:\\Footage\\interview-main.mxf';
    mocks.State.clips = [{
      id: 'video-with-audio', name: 'interview-main.mxf', path,
      audioSourceId: 'source-video', audioSrc: 'video',
      vtrack: 0, offset: 0, in: 0, out: 20, dur: 20,
    }];
    mocks.State.videoTracks = [{ name: '視訊軌 1', locked: false }];
    const block = document.createElement('div');
    block.className = 'audio-clip-block';
    Object.assign(block.dataset, {
      audioKind: 'clip',
      clipId: 'video-with-audio',
      audioSourceId: 'source-video',
      audioSourceName: 'interview-main.mxf',
      audioStart: '0',
      audioEnd: '20',
      audioEnabled: 'true',
    });
    document.getElementById('tlAtracks').appendChild(block);
    await loadMenus();

    openContextMenu(block);
    const reveal = revealItem();
    expect(reveal).not.toBeNull();
    reveal.click();

    expect(mocks.showSourceInFolder).toHaveBeenCalledWith(path);
  });

  it('鎖定外部音訊仍可顯示母素材，但不提供切割或移除', async () => {
    const path = 'E:\\Audio\\locked-dialogue.wav';
    const source = {
      id: 'external-locked',
      kind: 'external-audio',
      name: 'locked-dialogue.wav',
      path,
      locked: true,
      audioSourceId: 'source-external',
      audioSrc: 'ext-locked',
      offset: 0,
      in: 0,
      out: 10,
    };
    mocks.State.externalAudioState = [source];
    mocks.getExternalAudioSource.mockReturnValue(source);
    const block = document.createElement('div');
    block.className = 'audio-clip-block';
    Object.assign(block.dataset, {
      audioKind: 'external',
      audioAssetId: source.id,
      audioSourceId: source.audioSourceId,
      audioSrc: source.audioSrc,
      audioSourceName: source.name,
      audioStart: '0',
      audioEnd: '10',
      audioEnabled: 'true',
    });
    document.getElementById('tlAtracks').appendChild(block);
    await loadMenus();

    openContextMenu(block);
    const reveal = revealItem();
    expect(reveal).not.toBeNull();
    expect(document.querySelector('[data-menu-id="split_at_playhead"]')).toBeNull();
    expect(document.querySelector('[data-menu-id="remove_audio"]')).toBeNull();
    reveal.click();

    expect(mocks.showSourceInFolder).toHaveBeenCalledWith(path);
  });

  it('左側 .agtrack 軌頭可打開含母素材定位入口的音訊列選單', async () => {
    const path = 'F:\\Rushes\\camera-a.mov';
    mocks.State.clips = [{
      id: 'camera-a', name: 'camera-a.mov', path,
      audioSourceId: 'source-camera-a', audioSrc: 'clip:camera-a',
      vtrack: 0, offset: 0, in: 0, out: 12, dur: 12,
    }];
    const gutter = document.createElement('div');
    gutter.className = 'agtrack';
    Object.assign(gutter.dataset, {
      audioKind: 'clip',
      clipId: 'camera-a',
      audioSourceId: 'source-camera-a',
      audioSourceName: 'camera-a.mov',
    });
    document.getElementById('tlGutterAtracks').appendChild(gutter);
    await loadMenus();

    openContextMenu(gutter);
    const reveal = revealItem();
    expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(true);
    expect(reveal).not.toBeNull();
    reveal.click();

    expect(mocks.showSourceInFolder).toHaveBeenCalledWith(path);
  });
});

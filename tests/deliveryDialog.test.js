// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  openModal: vi.fn((title, html) => {
    document.body.innerHTML = html;
  }),
  closeModal: vi.fn(),
  openOutputSettings: vi.fn(),
}));

const mediaMock = vi.hoisted(() => ({
  tracks: [],
  getExternalAudioSources: () => [],
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), showOsd: vi.fn(),
  openModal: spies.openModal, closeModal: spies.closeModal,
}));
vi.mock('../src/formats.js', () => ({ SubFormats: {} }));
vi.mock('../src/substyle.js', () => ({
  ASS_PLAY_RES: { x: 1920, y: 1080 }, getAllPresets: () => [], loadFonts: vi.fn(),
}));
vi.mock('../src/subimport.js', () => ({ buildSubtitleImportPlan: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/subtitles.js', () => ({ sortCues: vi.fn() }));
vi.mock('../src/timeline.js', () => ({ drawTimeline: vi.fn(), layoutTimeline: vi.fn() }));
vi.mock('../src/project.js', () => ({ Project: {} }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn() }));
vi.mock('../src/xlsxExport.js', () => ({ buildXLSX: vi.fn() }));
vi.mock('../src/notes.js', () => ({ getNotesGeneralFileData: vi.fn(), getNotesEdiusFileData: vi.fn() }));
vi.mock('../src/audio-routing.js', () => ({ AudioRouting: { openOutputSettings: spies.openOutputSettings } }));

let State;
let resetAudioProject;
let ensureAudioBusCount;
let showExportVideoDialog;

beforeAll(async () => {
  window.subtool = {
    isDesktop: true,
    exportVideo: vi.fn(),
    getStartupFile: vi.fn().mockResolvedValue(null),
    listDir: vi.fn().mockResolvedValue([]),
  };
  ({ State, resetAudioProject, ensureAudioBusCount } = await import('../src/state.js'));
  ({ showExportVideoDialog } = await import('../src/subio.js'));
});

beforeEach(() => {
  document.body.innerHTML = '';
  spies.openModal.mockClear();
  spies.closeModal.mockClear();
  spies.openOutputSettings.mockClear();
  resetAudioProject();
  ensureAudioBusCount(2);
  State.cues = [];
  State.clips = [{
    id: 'program', path: 'C:/master/program.mov', primary: true,
    in: 0, out: 900, offset: 0, vtrack: 0,
  }];
  State.videoTracks = [{ name: 'V1', visible: true, locked: false }];
  State.mediaName = 'ST_交付測試.mov';
  State.videoWidth = 1920;
  State.videoHeight = 1080;
  State.fps = 25;
  State.dropFrame = false;
  State.duration = 900;
  State.exportIn = 12;
  State.exportOut = 32;
  State.externalAudioState = [];
  mediaMock.tracks = [];
});

describe('匯出交付清單', () => {
  it('WAV 列仍可設定音軌，並顯示實際輸出範圍的時長', async () => {
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));

    const duration = document.getElementById('evOutputDuration');
    expect(duration?.dataset.seconds).toBe('20');
    expect(duration?.textContent).toContain('00:00:20:00');
    expect(duration?.textContent).not.toContain('00:15:00:00');

    const format = document.querySelector('.ev-format');
    format.value = 'wav';
    format.dispatchEvent(new Event('change', { bubbles: true }));

    const audioButton = document.querySelector('.ev-audio-btn');
    expect(audioButton).not.toBeNull();
    expect(audioButton.disabled).toBe(false);
    audioButton.click();
    expect(spies.openOutputSettings).toHaveBeenCalledWith(
      expect.any(Function), null, null, { deliveryFormat: 'wav' }
    );
  });
});

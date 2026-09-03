// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  openModal: vi.fn((title, html) => {
    document.body.innerHTML = html;
  }),
  closeModal: vi.fn(),
  openOutputSettings: vi.fn(),
  openDeliveryOutputSettings: vi.fn(),
}));

const mediaMock = vi.hoisted(() => ({
  tracks: [],
  externalAudio: { list: () => [], get: () => null },
}));

vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));
vi.mock('../src/ui.js', () => ({
  setStatus: vi.fn(), showToast: vi.fn(), showOsd: vi.fn(),
  openModal: spies.openModal, closeModal: spies.closeModal,
}));
vi.mock('../src/formats.js', () => ({ SubFormats: {} }));
vi.mock('../src/substyle.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ASS_PLAY_RES: { x: 1920, y: 1080 }, getAllPresets: () => [], loadFonts: vi.fn(),
  };
});
vi.mock('../src/project-intake-engine.js', () => ({ buildSubtitleImportPlan: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/subtitles.js', () => ({ sortCues: vi.fn() }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), layoutTimeline: vi.fn() }));
vi.mock('../src/project.js', () => ({ Project: {} }));
vi.mock('../src/tcparse.js', () => ({ parseTimecodeInput: vi.fn() }));
vi.mock('../src/xlsx-export.js', () => ({ buildXLSX: vi.fn() }));
vi.mock('../src/notes.js', () => ({ getNotesGeneralFileData: vi.fn(), getNotesEdiusFileData: vi.fn() }));
vi.mock('../src/audio-routing.js', () => ({
  AudioRouting: {
    openOutputSettings: spies.openOutputSettings,
    openDeliveryOutputSettings: spies.openDeliveryOutputSettings,
  },
}));

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
  spies.openDeliveryOutputSettings.mockClear();
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
  window.subtool.getStartupFile.mockResolvedValue(null);
});

describe('匯出交付清單', () => {
  it('不把 startup 專案所在資料夾誤當成已授權的交付輸出目錄', async () => {
    window.subtool.getStartupFile.mockResolvedValue('C:\\Projects\\cut.subtool');

    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(document.querySelector('.ev-outdir')?.value).toBe('');
  });

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
    expect(spies.openDeliveryOutputSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        buses: State.audioProject.buses,
        streams: State.audioProject.exportLayout.streams,
      }),
      expect.any(Function), { deliveryFormat: 'wav' }
    );
    // 交付列的設定視窗只拿深複製草稿，不暫時覆寫正在播放專案的 State。
    expect(State.audioProject.buses).toHaveLength(2);
    expect(State.audioProject.exportLayout.streams).toHaveLength(2);
  });

  /* 交付檔名常常很長（專案代號＋fps＋聲道編組），和其他控制項擠在同一列時尾端會被
     截掉。三列的分工：格式／解析度／碼率／燒入TC ｜ 檔名＋輸出目錄 ｜ 音軌。
     這條鎖住那個分列，避免日後有人為了省高度又併回去。 */
  it('檔名與輸出目錄獨佔一列，燒入TC 在格式列，音軌自成一列', async () => {
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));

    const nameRow = document.querySelector('.ev-name').parentElement;
    expect(nameRow.querySelector('.ev-outdir'), '輸出目錄應與檔名同列').not.toBeNull();
    expect(nameRow.querySelector('.ev-dir-btn'), '瀏覽鈕應與檔名同列').not.toBeNull();
    expect(nameRow.querySelector('.ev-audio-btn'), '音軌不該和檔名同列').toBeNull();
    expect(nameRow.querySelector('.ev-tc'), '燒入TC 不該和檔名同列').toBeNull();

    // 燒入TC 與格式／解析度／碼率同列
    const formatRow = document.querySelector('.ev-format').parentElement;
    expect(formatRow.querySelector('.ev-tc'), '燒入TC 應在格式列').not.toBeNull();
    expect(formatRow.querySelector('.ev-del'), '刪除鈕仍在格式列最右').not.toBeNull();

    const audioRow = document.querySelector('.ev-audio-btn').parentElement.parentElement;
    expect(audioRow.querySelector('.ev-tc'), '燒入TC 已移走，不該還在音軌列').toBeNull();
    expect(audioRow.querySelector('.ev-name'), '檔名不該和音軌同列').toBeNull();

    // 檔名欄位要拿到比目錄更大的份額，長檔名才看得到全貌
    expect(document.querySelector('.ev-name').style.flexGrow).toBe('3');
    expect(document.querySelector('.ev-outdir').style.flexGrow).toBe('2');
  });
});

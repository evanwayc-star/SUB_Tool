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
  window.subtool.listDir.mockResolvedValue([]);
});

describe('匯出交付清單', () => {
  it.each([
    ['airline-s3k', '352×240p', '.m1v', 'MPEG-1 Audio Layer-2 / CRC'],
    ['airline-dmpes', '720×480p', '.h264', 'AAC-LC / ADTS'],
  ])('%s 提供固定循序掃描規格與 Manzanita 合成說明', async (formatName, resolutionText, extension, audioLabel) => {
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));
    const format = document.querySelector('.ev-format');
    format.value = formatName;
    format.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('.ev-format').value).toBe(formatName);
    const resolution = document.querySelector('.ev-res');
    expect(resolution.selectedOptions[0].textContent).toBe(resolutionText);
    expect(resolution.disabled).toBe(true);
    expect(document.querySelector('.ev-fps').value).toBe('29.97');
    expect(document.querySelector('.ev-fps').disabled).toBe(true);
    expect(document.querySelector('.ev-kbps').value).toBe('1500');
    expect(document.querySelector('.ev-kbps').disabled).toBe(true);
    expect(document.querySelector('.ev-name').value.endsWith(extension)).toBe(true);
    expect(document.body.textContent).toContain(audioLabel);
    expect(document.body.textContent).toContain('48 kHz / 128 kbps');
    expect(document.querySelector('.delivery-airline-handoff').textContent).toContain('Manzanita MP2TSME');
    expect(document.querySelector('.delivery-airline-handoff').textContent).toContain('合成 .mpg');
    expect(State.fps).toBe(25);
  });

  it('航空輸出的音訊或設定檔已存在時，即使影像不存在也顯示覆寫警告', async () => {
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));
    const format = document.querySelector('.ev-format');
    format.value = 'airline-dmpes';
    format.dispatchEvent(new Event('change', { bubbles: true }));
    const name = document.querySelector('.ev-name');
    name.value = 'flight.h264';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    window.subtool.listDir.mockResolvedValue(['flight.aac', 'flight.manzanita.cfg']);
    const outDir = document.querySelector('.ev-outdir');
    outDir.value = 'D:/交付';
    outDir.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 25));
    const message = document.getElementById('evConflictMsg');
    expect(message.textContent).toContain('flight.aac');
    expect(message.textContent).toContain('flight.manzanita.cfg');
    expect(message.textContent).not.toContain('flight.h264');
    expect(getComputedStyle(message).display).not.toBe('none');
  });

  it('MOD-FHD 顯示鎖定規格、TS 檔名與 AAC 音訊，仍可指定 bus 與燒入 TC', async () => {
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));
    const format = document.querySelector('.ev-format');
    format.value = 'mod-fhd';
    format.dispatchEvent(new Event('change', { bubbles: true }));

    const resolution = document.querySelector('.ev-res');
    expect(resolution.value).toBe('1080');
    expect(resolution.selectedOptions[0].textContent).toBe('1920×1080i');
    expect(resolution.disabled).toBe(true);
    expect(document.querySelector('.ev-fps').value).toBe('29.97');
    expect(document.querySelector('.ev-fps').disabled).toBe(true);
    expect(document.querySelector('.ev-kbps').value).toBe('7280');
    expect(document.querySelector('.ev-kbps').disabled).toBe(true);
    expect(document.querySelector('.ev-name').value).toBe('ST_交付測試_MOD-FHD_1080i_29.97fps.ts');
    expect(document.body.textContent).toContain('MPEG-2 AAC-LC / ADTS');
    expect(document.body.textContent).toContain('48 kHz / 256 kbps');

    const timecode = document.querySelector('.ev-tc');
    timecode.checked = true;
    timecode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('.ev-name').value).toBe('ST_交付測試_MOD-FHD_1080i_29.97fps_TC.ts');
    document.querySelector('.ev-audio-btn').click();
    expect(spies.openDeliveryOutputSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        streams: [expect.objectContaining({ layout: 'stereo', busIds: State.audioProject.buses.map(bus => bus.id) })],
      }),
      expect.any(Function), { deliveryFormat: 'mod-fhd' },
    );
    expect(State.audioProject.exportLayout.streams).toHaveLength(2);
    expect(State.fps).toBe(25);

    spies.openDeliveryOutputSettings.mock.calls[0][1]({ saved: false });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(document.querySelector('.ev-format').value).toBe('mod-fhd');
    expect(document.querySelector('.ev-fps').disabled).toBe(true);
    expect(document.querySelector('.ev-tc').checked).toBe(true);
    const backToMp4 = document.querySelector('.ev-format');
    backToMp4.value = 'h264';
    backToMp4.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('.ev-res').disabled).toBe(false);
    expect(document.querySelector('.ev-fps').disabled).toBe(false);
    expect(document.querySelector('.ev-kbps').disabled).toBe(false);
  });

  it('MOD-FHD 的多串流音訊顯示阻擋訊息並保留音軌修正入口', async () => {
    ensureAudioBusCount(6);
    await showExportVideoDialog();
    await new Promise(resolve => setTimeout(resolve, 25));
    const outDir = document.querySelector('.ev-outdir');
    outDir.value = 'D:/交付';
    outDir.dispatchEvent(new Event('change', { bubbles: true }));
    const format = document.querySelector('.ev-format');
    format.value = 'mod-fhd';
    format.dispatchEvent(new Event('change', { bubbles: true }));

    const message = document.getElementById('evConflictMsg');
    expect(message.textContent).toContain('MOD-FHD 需要單一 Stereo');
    expect(getComputedStyle(message).display).toBe('flex');
    expect(document.querySelector('.ev-audio-btn').disabled).toBe(false);
    expect(State.audioProject.exportLayout.streams).toHaveLength(6);
  });

  it('可逐列選 FPS，折返音軌設定仍保留，WAV 隱藏 FPS', async () => {
    await showExportVideoDialog();
    await new Promise(resolve=>setTimeout(resolve,25));
    const select = document.querySelector('.ev-fps');
    expect(select.value).toBe('0');
    expect([...select.options].map(o=>o.value)).toEqual(['0','23.976','24','25','29.97','30','48','50','59.94','60']);
    select.value='29.97';select.dispatchEvent(new Event('change',{bubbles:true}));
    expect(document.querySelector('.ev-name').value).toContain('_29.97fps');
    document.querySelector('.ev-audio-btn').click();
    const callback=spies.openDeliveryOutputSettings.mock.calls[0][1];
    callback({saved:false});
    await new Promise(resolve=>setTimeout(resolve,25));
    expect(document.querySelector('.ev-fps').value).toBe('29.97');
    const format=document.querySelector('.ev-format');format.value='wav';format.dispatchEvent(new Event('change',{bubbles:true}));
    expect(document.querySelector('.ev-fps')).toBeNull();
    expect(State.fps).toBe(25);expect(State.exportIn).toBe(12);expect(State.exportOut).toBe(32);
  });
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

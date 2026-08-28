// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { State } from '../src/state.js';

const engineMocks = vi.hoisted(() => ({
  transcribeAudioStream: vi.fn(),
  decodeAudioData: vi.fn(async () => ({
    duration: 12,
    numberOfChannels: 1,
    sampleRate: 16000,
    getChannelData: () => new Float32Array(16000 * 12)
  }))
}));

const uiMocks = vi.hoisted(() => ({
  openModal: vi.fn(),
  closeModal: vi.fn(),
  showToast: vi.fn()
}));

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));

vi.mock('../src/speech-recognition-engine.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    transcribeAudioStream: engineMocks.transcribeAudioStream
  };
});

vi.mock('../src/audio.js', () => ({
  AudioEngine: {
    decodeAudioData: engineMocks.decodeAudioData
  }
}));

vi.mock('../src/ui.js', () => ({
  openModal: uiMocks.openModal,
  closeModal: uiMocks.closeModal,
  showToast: uiMocks.showToast
}));

import {
  openSpeechRecognitionDialog,
  openAsrMonitorDialog,
  saveAsrConfig,
  getAsrConfig,
  getAsrSession,
  clearAsrSession
} from '../src/speech-recognition.js';

function renderModalFromMock() {
  const lastCall = uiMocks.openModal.mock.calls.at(-1);
  if (!lastCall) return;
  const [_title, html, buttons] = lastCall;
  document.body.innerHTML = `<div class="modal">${html}<div id="modalFoot"></div></div>`;
  const foot = document.getElementById('modalFoot');
  for (const definition of buttons) {
    const button = document.createElement('button');
    button.textContent = definition.label;
    if (definition.primary) button.className = 'primary';
    if (definition.id) button.id = definition.id;
    if (definition.hidden) button.style.display = 'none';
    button.onclick = definition.act;
    foot.appendChild(button);
  }
}

describe('語音辨識背景執行與進度視窗切換', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAsrSession();
    localStorage.clear();
    saveAsrConfig({
      ...getAsrConfig(),
      provider: 'builtin',
      builtinModel: 'onnx-community/whisper-tiny'
    });
    document.body.innerHTML = '';
    State.cues = [];
    State.tracks = [{ id: 'track-1', name: '預設軌' }];
    State.clips = [{
      id: 'clip-1',
      name: 'voice.wav',
      in: 0,
      out: 10,
      dur: 10,
      audioBuffer: { duration: 10 }
    }];
  });

  it('啟動辨識後可點擊「縮小至背景」，遮罩關閉但背景推論持續進行', async () => {
    let progressCallback;
    let finishRecognition;
    engineMocks.transcribeAudioStream.mockImplementation(options => {
      progressCallback = options.onProgress;
      return new Promise(resolve => {
        finishRecognition = resolve;
      });
    });

    openSpeechRecognitionDialog();
    renderModalFromMock();

    const [cancelBtn, startBtn, minimizeBtn] = document.querySelectorAll('#modalFoot button');
    expect(minimizeBtn.style.display).toBe('none');

    // 點擊開始辨識
    startBtn.click();
    expect(startBtn.disabled).toBe(true);
    expect(minimizeBtn.style.display).toBe('');
    expect(document.querySelector('.asr-config-workspace').getAttribute('aria-busy')).toBe('true');
    expect(document.getElementById('asrModeTranscribe').disabled).toBe(true);
    expect(getComputedStyle(document.getElementById('asrProgressContainer')).display).toBe('flex');
    expect(document.getElementById('asrProgressBar').classList.contains('indeterminate')).toBe(true);

    const session = getAsrSession();
    expect(session).toBeTruthy();
    expect(session.dialogOpen).toBe(true);

    // 點擊縮小至背景
    minimizeBtn.click();
    expect(uiMocks.closeModal).toHaveBeenCalledWith({ committed: true });
    expect(session.dialogOpen).toBe(false);

    await vi.waitFor(() => expect(engineMocks.transcribeAudioStream).toHaveBeenCalledTimes(1));

    // 推論在背景持續進行
    progressCallback({
      status: 'transcribing',
      percent: 50,
      indeterminate: false,
      message: '本機 AI 正在推論 (50%)…'
    });

    expect(session.progress.percent).toBe(50);
    expect(session.statusText).toContain('50%');

    // 背景推論完成，自動注入字幕軌並發出通知
    finishRecognition([
      { start: 1, end: 3, text: '第一句字幕' },
      { start: 4, end: 7, text: '第二句字幕' }
    ]);

    await vi.waitFor(() => expect(State.cues.length).toBe(2));
    expect(State.tracks.at(-1).name).toBe('語音辨識');
    expect(uiMocks.showToast).toHaveBeenCalledWith(expect.stringContaining('語音辨識完成'));
  });

  it('在背景執行期間可隨時透過 openSpeechRecognitionDialog 喚回進度監控視窗', async () => {
    let progressCallback;
    engineMocks.transcribeAudioStream.mockImplementation(options => {
      progressCallback = options.onProgress;
      return new Promise(() => {});
    });

    openSpeechRecognitionDialog();
    renderModalFromMock();

    const [_cancelBtn, startBtn, minimizeBtn] = document.querySelectorAll('#modalFoot button');
    startBtn.click();
    minimizeBtn.click();

    expect(getAsrSession().dialogOpen).toBe(false);

    // 使用者點擊頂部工具列按鈕 (呼叫 openSpeechRecognitionDialog)
    openSpeechRecognitionDialog();
    expect(getAsrSession().dialogOpen).toBe(true);
    expect(uiMocks.openModal).toHaveBeenCalledWith(
      expect.stringContaining('進度'),
      expect.stringContaining('asr-form'),
      expect.any(Array),
      expect.any(Object)
    );

    renderModalFromMock();
    expect(document.querySelector('.asr-monitor-workspace')).toBeTruthy();
    expect(document.getElementById('asrProgressBar').getAttribute('role')).toBe('progressbar');
    expect(document.getElementById('asrStatus').getAttribute('aria-live')).toBe('polite');
    const [cancelModalBtn] = document.querySelectorAll('#modalFoot button');
    expect(cancelModalBtn.textContent).toContain('取消');

    // 點擊取消辨識
    cancelModalBtn.click();
    expect(getAsrSession()).toBeNull();
    expect(uiMocks.showToast).toHaveBeenCalledWith(expect.stringContaining('已取消'));
  });
});

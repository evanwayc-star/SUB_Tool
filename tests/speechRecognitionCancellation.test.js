// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  transcribeAudioStream: vi.fn()
}));

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({ openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn() }));
vi.mock('../src/speech-recognition-engine.js', async importOriginal => ({
  ...(await importOriginal()),
  transcribeAudioStream: engineMocks.transcribeAudioStream
}));

import { State } from '../src/state.js';
import { closeModal, openModal, showToast } from '../src/ui.js';
import {
  getClipAudioBuffer,
  getAsrConfig,
  openSpeechRecognitionDialog,
  saveAsrConfig
} from '../src/speech-recognition.js';

function renderModal(_title, html, buttons) {
  document.body.innerHTML = `<div class="modal">${html}<div id="modalFoot"></div></div>`;
  const foot = document.getElementById('modalFoot');
  for (const definition of buttons) {
    const button = document.createElement('button');
    button.textContent = definition.label;
    if (definition.primary) button.className = 'primary';
    button.onclick = definition.act;
    foot.appendChild(button);
  }
}

describe('本機語音辨識進行中的回饋與取消', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineMocks.transcribeAudioStream.mockReset();
    localStorage.clear();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
    State.clips = [];
    State.externalAudioState = [];
    State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
    State.cues = [];
    State.fps = 30;
    State.dropFrame = false;
    openModal.mockImplementation(renderModal);
  });

  it('取消會中止仍在 fetch 的音訊準備工作', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('已取消', 'AbortError'));
      }, { once: true });
    }));

    const pending = getClipAudioBuffer({
      id: 'pending-audio-fetch',
      web: { url: 'blob:pending-audio' }
    }, {
      fetchImpl,
      decodeAudioData: vi.fn(),
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledWith('blob:pending-audio', { signal: controller.signal });
  });

  async function beginPendingBuiltinRecognition() {
    saveAsrConfig({
      ...getAsrConfig(),
      provider: 'builtin',
      builtinModel: 'onnx-community/whisper-small'
    });

    let receivedSignal;
    engineMocks.transcribeAudioStream.mockImplementation(options => {
      receivedSignal = options.signal;
      options.onProgress({
        status: 'transcribing',
        percent: 10,
        indeterminate: true,
        message: '本機 AI 正在聆聽與分析語音…'
      });
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('辨識已取消', 'AbortError'));
        }, { once: true });
      });
    });

    openSpeechRecognitionDialog({
      id: 'local-cancel-repro',
      name: 'local-cancel-repro.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });

    const [cancelButton, startButton] = document.querySelectorAll('#modalFoot button');
    startButton.click();
    await vi.waitFor(() => expect(engineMocks.transcribeAudioStream).toHaveBeenCalledTimes(1));

    return { cancelButton, startButton, receivedSignal };
  }

  it('推論等待期間不會假裝固定在 10%', async () => {
    await beginPendingBuiltinRecognition();

    expect(document.getElementById('asrProgressPercent').textContent).not.toBe('10%');
    expect(document.getElementById('asrProgressBar').classList.contains('indeterminate')).toBe(true);
  });

  it('推論等待期間取消按鈕仍可用，且會中止本次辨識', async () => {
    const { cancelButton, startButton, receivedSignal } = await beginPendingBuiltinRecognition();

    expect(cancelButton.disabled).toBe(false);
    expect(startButton.disabled).toBe(true);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);

    cancelButton.click();
    await vi.waitFor(() => expect(receivedSignal.aborted).toBe(true));
    expect(closeModal).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('Esc 或點背景關閉時可透過 onDismiss 中止同一工作', async () => {
    const { receivedSignal } = await beginPendingBuiltinRecognition();
    const modalOptions = openModal.mock.calls[0][3];

    expect(modalOptions.onDismiss).toBeTypeOf('function');
    modalOptions.onDismiss();

    await vi.waitFor(() => expect(receivedSignal.aborted).toBe(true));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('即使引擎忽略 abort 並晚到成功，也不會寫字幕、toast 或再次關閉 modal', async () => {
    let resolveTranscription;
    let receivedSignal;
    engineMocks.transcribeAudioStream.mockImplementation(options => {
      receivedSignal = options.signal;
      return new Promise(resolve => { resolveTranscription = resolve; });
    });
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin' });
    openSpeechRecognitionDialog({
      id: 'late-local-result',
      name: 'late-local-result.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });

    const [cancelButton, startButton] = document.querySelectorAll('#modalFoot button');
    startButton.click();
    await vi.waitFor(() => expect(engineMocks.transcribeAudioStream).toHaveBeenCalledTimes(1));
    cancelButton.click();
    expect(receivedSignal.aborted).toBe(true);
    const closeCountAfterCancel = closeModal.mock.calls.length;

    resolveTranscription([{ start: 0, end: 1, text: '不應寫入' }]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(State.cues).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    expect(closeModal).toHaveBeenCalledTimes(closeCountAfterCancel);
  });

  it('真正失敗仍顯示錯誤並只重新啟用開始按鈕', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    engineMocks.transcribeAudioStream.mockRejectedValue(new Error('模型損毀'));
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin' });
    openSpeechRecognitionDialog({
      id: 'local-error',
      name: 'local-error.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });

    const [cancelButton, startButton] = document.querySelectorAll('#modalFoot button');
    startButton.click();
    await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('模型損毀'));

    expect(startButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('成功時以 committed 狀態關閉，避免 onDismiss 反向觸發 abort', async () => {
    engineMocks.transcribeAudioStream.mockResolvedValue([{ start: 0, end: 1, text: '完成' }]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin' });
    openSpeechRecognitionDialog({
      id: 'local-success',
      name: 'local-success.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });

    const startButton = document.querySelector('#modalFoot button.primary');
    startButton.click();

    await vi.waitFor(() => expect(closeModal).toHaveBeenCalledWith({ committed: true }));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('文本匹配以使用者每一行為字幕內容，只採用辨識結果的時間證據', async () => {
    engineMocks.transcribeAudioStream.mockResolvedValue([
      {
        start: 0.2,
        end: 1.2,
        text: '辨識正確',
        words: [{ text: '辨識正確', start: 0.2, end: 1.2 }]
      },
      {
        start: 1.5,
        end: 2.8,
        text: 'second line exact',
        words: [
          { text: 'second', start: 1.5, end: 1.9 },
          { text: 'line', start: 2, end: 2.3 },
          { text: 'exact', start: 2.4, end: 2.8 }
        ]
      }
    ]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-success',
      name: 'alignment-success.wav',
      offset: 10,
      in: 0,
      out: 3,
      duration: 3,
      audioBuffer: { duration: 3 }
    });
    document.getElementById('asrTranscript').value = '  辨識正確。  \n  Second line exact.  ';

    document.querySelector('#modalFoot button.primary').click();
    await vi.waitFor(() => expect(closeModal).toHaveBeenCalledWith({ committed: true }));

    expect(State.tracks.at(-1).name).toBe('文本匹配');
    expect(State.cues.map(cue => ({ text: cue.text, start: cue.start, end: cue.end }))).toEqual([
      { text: '辨識正確。', start: 10.2, end: 11.2 },
      { text: 'Second line exact.', start: 11.5, end: 12.8 }
    ]);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('文本匹配完成'));
    expect(localStorage.getItem('subtool_asr_config')).not.toContain('辨識正確。');
  });

  it('只有部分行的逐字時間重疊時，錯誤訊息只回報真正有疑義的行數', async () => {
    engineMocks.transcribeAudioStream.mockResolvedValue([{
      start: 0,
      end: 2,
      text: '紐約大學第三行',
      words: [
        { text: '紐約大學', start: 0, end: 1 },
        { text: '第三行', start: 1.2, end: 2 }
      ]
    }]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-partial-ambiguity',
      name: 'alignment-partial-ambiguity.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });
    document.getElementById('asrTranscript').value = '紐約\n大學\n第三行';

    document.querySelector('#modalFoot button.primary').click();
    await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('無法可靠匹配'));

    expect(document.getElementById('asrStatus').textContent).toContain('2/3 行');
    expect(State.tracks.map(track => track.name)).toEqual(['軌道 1']);
  });

  it('文本匹配只有句級時間證據時會提醒使用者抽查時間碼', async () => {
    engineMocks.transcribeAudioStream.mockResolvedValue([{
      start: 0,
      end: 3,
      text: '第一行 second line'
    }]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-segment-evidence',
      name: 'alignment-segment-evidence.wav',
      in: 0,
      out: 3,
      duration: 3,
      audioBuffer: { duration: 3 }
    });
    document.getElementById('asrTranscript').value = '第一行。\nSecond line.';

    document.querySelector('#modalFoot button.primary').click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('句級估算，請抽查'));
  });

  it('文本匹配沒有貼入逐行文字稿時不會啟動聲音分析', async () => {
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-empty-transcript',
      name: 'alignment-empty-transcript.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });

    document.querySelector('#modalFoot button.primary').click();

    expect(engineMocks.transcribeAudioStream).not.toHaveBeenCalled();
    expect(document.getElementById('asrStatus').textContent).toContain('請貼上文字稿');
    expect(document.activeElement).toBe(document.getElementById('asrTranscript'));
  });

  it('文本匹配一次選到多個素材時不會重複套用同一份文字稿', async () => {
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog([
      { id: 'alignment-source-1', name: 'one.wav', in: 0, out: 1, duration: 1, audioBuffer: { duration: 1 } },
      { id: 'alignment-source-2', name: 'two.wav', in: 0, out: 1, duration: 1, audioBuffer: { duration: 1 } }
    ]);
    document.getElementById('asrTranscript').value = '固定的一行';

    document.querySelector('#modalFoot button.primary').click();

    expect(engineMocks.transcribeAudioStream).not.toHaveBeenCalled();
    expect(document.getElementById('asrStatus').textContent).toContain('一次只能處理一個音訊來源');
  });

  it('文字稿與聲音差異過大時整批不建立字幕軌', async () => {
    engineMocks.transcribeAudioStream.mockResolvedValue([{
      start: 0,
      end: 2,
      text: '完全不同內容'
    }]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-low-coverage',
      name: 'alignment-low-coverage.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: { duration: 2 }
    });
    document.getElementById('asrTranscript').value = 'This transcript does not match.';

    document.querySelector('#modalFoot button.primary').click();
    await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('無法可靠匹配'));

    expect(State.tracks.map(track => track.name)).toEqual(['軌道 1']);
    expect(State.cues).toHaveLength(0);
    expect(closeModal).not.toHaveBeenCalledWith({ committed: true });
    expect(showToast).not.toHaveBeenCalled();
  });
});

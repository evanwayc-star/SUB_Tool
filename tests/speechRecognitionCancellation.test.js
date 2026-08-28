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
  getAsrSession,
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

  it('推論中關閉視窗時透過 onDismiss 轉入背景執行而不中止工作', async () => {
    const { receivedSignal } = await beginPendingBuiltinRecognition();
    const modalOptions = openModal.mock.calls[0][3];

    expect(modalOptions.closeOnBackdrop).toBe(false);
    expect(modalOptions.onDismiss).toBeTypeOf('function');
    modalOptions.onDismiss();

    expect(receivedSignal.aborted).toBe(false);
    expect(getAsrSession()?.dialogOpen).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('背景執行'));
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

  it.each(['builtin', 'groq', 'openai', 'azure', 'google'])(
    '%s 文本匹配引擎整體失敗時仍建立每一行未定時原稿',
    async provider => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      engineMocks.transcribeAudioStream.mockRejectedValue(new Error('辨識服務暫時不可用'));
      saveAsrConfig({
        ...getAsrConfig(),
        provider,
        taskMode: 'align',
        groqApiKey: 'test-groq-key',
        openaiApiKey: 'test-openai-key',
        azureApiKey: 'test-azure-key',
        googleApiKey: 'test-google-key'
      });
      openSpeechRecognitionDialog({
        id: `alignment-provider-failure-${provider}`,
        name: `alignment-provider-failure-${provider}.wav`,
        in: 0,
        out: 3,
        duration: 3,
        audioBuffer: { duration: 3 }
      });
      document.getElementById('asrTranscript').value = 'Line one.\nLine two.\nLine three.';

      document.querySelector('#modalFoot button.primary').click();
      await vi.waitFor(() => expect(State.cues).toHaveLength(3));

      expect(State.cues.map(cue => cue.text)).toEqual(['Line one.', 'Line two.', 'Line three.']);
      expect(State.cues.every(cue => cue.timed === false && cue.start === 0 && cue.end === 0)).toBe(true);
      expect(document.getElementById('asrStatus').textContent).toContain('聲音分析失敗');
      expect(document.getElementById('asrStatus').textContent).toContain('3 句無時間碼');
      consoleError.mockRestore();
    }
  );

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

  it('辨識來源選單依來源座標排序，並把指定單軌而非全部平均送入辨識引擎', async () => {
    const makeBuffer = value => ({
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 16,
      duration: 0.001,
      getChannelData: channel => {
        if (channel !== 0) throw new RangeError('mono');
        return new Float32Array(16).fill(value);
      }
    });
    const scrambled = [7, 1, 5, 0, 6, 3, 2, 4].map(sourceStream => ({
      sourceStream,
      sourceChannel: 0,
      buffer: makeBuffer((sourceStream + 1) / 10)
    }));
    engineMocks.transcribeAudioStream.mockResolvedValue([{ start: 0, end: 0.001, text: 'done' }]);
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'transcribe' });
    openSpeechRecognitionDialog({
      id: 'eight-source-channels',
      name: 'eight-source-channels.mxf',
      in: 0,
      out: 0.001,
      duration: 0.001,
      recognitionTracks: scrambled
    });

    const sourceSelect = document.getElementById('asrRecognitionAudioSource');
    const optionLabels = [...sourceSelect.options].map(option => option.textContent.trim());
    expect(sourceSelect.selectedOptions[0].textContent.trim()).toBe('全部來源聲道混音（8 軌）');
    expect(optionLabels).toEqual([
      '全部來源聲道混音（8 軌）',
      '最後兩軌組（來源聲道 7 + 8）',
      '來源聲道 1', '來源聲道 2', '來源聲道 3', '來源聲道 4',
      '來源聲道 5', '來源聲道 6', '來源聲道 7', '來源聲道 8'
    ]);

    sourceSelect.value = [...sourceSelect.options]
      .find(option => option.textContent.trim() === '來源聲道 3').value;
    document.querySelector('#modalFoot button.primary').click();
    await vi.waitFor(() => expect(engineMocks.transcribeAudioStream).toHaveBeenCalledTimes(1));

    const sentBuffer = engineMocks.transcribeAudioStream.mock.calls[0][0].audioBuffer;
    expect(sentBuffer.numberOfChannels).toBe(1);
    expect(sentBuffer.getChannelData(0)[0]).toBeCloseTo(0.3, 6);
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

  it('零星漏句恢復後建立完整初稿並保留需校對行號與診斷入口', async () => {
    const transcriptLines = Array.from({ length: 20 }, (_, index) => (
      index === 10 ? 'missing phrase' : `anchor${index} a b c d e f g h i`
    ));
    engineMocks.transcribeAudioStream.mockResolvedValue(transcriptLines.flatMap((text, index) => (
      index === 10 ? [] : [{ start: index * 2, end: (index * 2) + 1, text }]
    )));
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
    openSpeechRecognitionDialog({
      id: 'alignment-recovered',
      name: 'alignment-recovered.wav',
      in: 0,
      out: 39,
      duration: 39,
      audioBuffer: { duration: 39 }
    });
    document.getElementById('asrTranscript').value = transcriptLines.join('\n');

    const [closeButton, startButton] = document.querySelectorAll('#modalFoot button');
    startButton.click();
    await vi.waitFor(() => expect(State.cues).toHaveLength(20));

    expect(State.tracks.at(-1).name).toBe('文本匹配');
    expect(State.cues.map(cue => cue.text)).toEqual(transcriptLines);
    expect(document.getElementById('asrStatus').textContent).toContain('1 行使用推估時間');
    expect(document.getElementById('asrStatus').textContent).toContain('共 20 行需人工校對');
    expect(document.getElementById('asrStatus').textContent).toContain('不是精準對齊');
    expect(document.getElementById('asrUnreliableLineNumbers').textContent).toContain('第 1、2');
    expect(document.getElementById('asrUnreliableLineNumbers').textContent).toContain('、11、');
    expect(document.getElementById('asrUnreliableLineNumbers').textContent).toContain('20 行');
    expect(getComputedStyle(document.getElementById('asrAlignmentDiagnostic')).display).not.toBe('none');
    expect(closeButton.textContent).toBe('關閉');
    expect(startButton.disabled).toBe(true);
    expect(startButton.textContent).toBe('已建立');
    expect(closeModal).not.toHaveBeenCalledWith({ committed: true });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('需人工校對'));

    startButton.click();
    expect(State.cues).toHaveLength(20);
  });

  it('只有部分行的逐字時間重疊時，仍建立可靠行並只回報真正有疑義的行數', async () => {
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
    await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('已建立 3 句'));

    expect(document.getElementById('asrStatus').textContent).toContain('2 句無時間碼');
    expect(State.tracks.map(track => track.name)).toEqual(['軌道 1', '文本匹配']);
    expect(State.cues.map(cue => cue.text)).toEqual(['紐約', '大學', '第三行']);
    expect(State.cues.map(cue => cue.timed !== false)).toEqual([false, false, true]);
  });

  it('文本匹配失敗時列出實際行號，並可下載不含 Azure Key 的安全診斷 JSON', async () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    let downloadedBlob = null;
    let downloadedName = '';
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(blob => { downloadedBlob = blob; return 'blob:alignment-diagnostic'; })
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      downloadedName = this.download;
    });

    try {
      engineMocks.transcribeAudioStream.mockResolvedValue([{
        start: 0,
        end: 2,
        text: '紐約大學第三行',
        words: [
          { text: '紐約大學', start: 0, end: 1 },
          { text: '第三行', start: 1.2, end: 2 }
        ],
        apiKey: 'nested-secret'
      }]);
      saveAsrConfig({
        ...getAsrConfig(),
        provider: 'azure',
        taskMode: 'align',
        azureApiKey: 'diagnostic-secret',
        azureRegion: 'japaneast',
        language: 'zh'
      });
      openSpeechRecognitionDialog({
        id: 'alignment-diagnostic',
        name: 'C:\\private\\alignment-diagnostic.wav',
        in: 0,
        out: 2,
        duration: 2,
        audioBuffer: { duration: 2 }
      });
      document.getElementById('asrTranscript').value = '紐約\n大學\n第三行';

      document.querySelector('#modalFoot button.primary').click();
      await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('已建立 3 句'));

      const diagnosticRow = document.getElementById('asrAlignmentDiagnostic');
      const lineNumbers = document.getElementById('asrUnreliableLineNumbers');
      const downloadButton = document.getElementById('asrDownloadAlignmentDiagnostic');
      expect(getComputedStyle(diagnosticRow).display).not.toBe('none');
      expect(lineNumbers.textContent).toContain('第 1、2 行');
      expect(downloadButton.textContent).toBe('匯出診斷 JSON');

      downloadButton.click();
      expect(downloadedName).toMatch(/^SUBTool_文本匹配診斷_.*\.json$/u);
      expect(downloadedBlob?.type).toBe('application/json');
      const serialized = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(downloadedBlob);
      });
      const diagnostic = JSON.parse(serialized);
      expect(diagnostic.unreliableLines.map(line => line.lineNumber)).toEqual([1, 2]);
      expect(diagnostic.audioSelection).toEqual({ mode: 'all-source-channels' });
      expect(serialized).not.toContain('diagnostic-secret');
      expect(serialized).not.toContain('nested-secret');
      expect(serialized).not.toContain('C:\\private');
    } finally {
      anchorClick.mockRestore();
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      else delete URL.createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      else delete URL.revokeObjectURL;
    }
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
    expect(document.getElementById('asrTranscriptError').hidden).toBe(false);
    expect(document.getElementById('asrTranscriptError').textContent).toContain('請貼上文字稿');
    expect(document.getElementById('asrTranscript').getAttribute('aria-invalid')).toBe('true');
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

  it('文字稿與聲音完全不同時仍建立原稿行並標成未定時字幕', async () => {
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
    await vi.waitFor(() => expect(document.getElementById('asrStatus').textContent).toContain('已建立 1 句'));

    expect(State.tracks.map(track => track.name)).toEqual(['軌道 1', '文本匹配']);
    expect(State.cues).toEqual([
      expect.objectContaining({
        start: 0,
        end: 0,
        timed: false,
        text: 'This transcript does not match.'
      })
    ]);
    expect(closeModal).not.toHaveBeenCalledWith({ committed: true });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('1 句為無時間碼'));
  });

  it.each(['builtin', 'groq', 'openai', 'azure', 'google'])(
    '%s 文本匹配部分失敗時仍建立所有可靠字幕並列出未建立行',
    async provider => {
      const missingIndexes = [4, 5];
      const transcriptLines = Array.from({ length: 10 }, (_, index) => (
        missingIndexes.includes(index)
          ? `missing line ${index}`
          : `anchor${index} a b c d e f g h i`
      ));
      engineMocks.transcribeAudioStream.mockResolvedValue(transcriptLines.flatMap((text, index) => (
        missingIndexes.includes(index)
          ? []
          : [{
              start: index === 0 ? 0.001 : index * 2,
              end: index === 0 ? 0.01 : (index * 2) + 1,
              text
            }]
      )));
      saveAsrConfig({
        ...getAsrConfig(),
        provider,
        taskMode: 'align',
        groqApiKey: 'test-groq-key',
        openaiApiKey: 'test-openai-key',
        azureApiKey: 'test-azure-key',
        googleApiKey: 'test-google-key'
      });
      openSpeechRecognitionDialog({
        id: `alignment-partial-${provider}`,
        name: `alignment-partial-${provider}.wav`,
        in: 0,
        out: 20,
        duration: 20,
        audioBuffer: { duration: 20 }
      });
      document.getElementById('asrTranscript').value = transcriptLines.join('\n');

      document.querySelector('#modalFoot button.primary').click();
      await vi.waitFor(() => expect(State.cues).toHaveLength(10));

      expect(State.tracks.map(track => track.name)).toEqual(['軌道 1', '文本匹配']);
      expect(State.cues.map(cue => cue.text)).toEqual(transcriptLines);
      expect(State.cues.map(cue => cue.timed !== false)).toEqual([
        false, true, true, true, false, false, true, true, true, true
      ]);
      expect(document.getElementById('asrStatus').textContent).toContain('已建立 10 句');
      expect(document.getElementById('asrStatus').textContent).toContain('3 句無時間碼');
      expect(document.getElementById('asrUnreliableLineNumbers').textContent).toContain('第 1、5、6 行');
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('10 句'));
      expect(closeModal).not.toHaveBeenCalledWith({ committed: true });
    }
  );
});

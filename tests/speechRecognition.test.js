// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/events.js', () => ({ emit: vi.fn(), on: vi.fn() }));
vi.mock('../src/history.js', () => ({ recordHistory: vi.fn() }));
vi.mock('../src/ui.js', () => ({ openModal: vi.fn(), closeModal: vi.fn(), showToast: vi.fn() }));

import { State } from '../src/state.js';
import { emit } from '../src/events.js';
import { openModal } from '../src/ui.js';
import {
  BUILTIN_MODELS,
  extractClipFloat32Mono16k,
  encodeWav16kMono,
  insertAsrSubtitles,
  getAsrConfig,
  saveAsrConfig,
  getAsrGuidanceMeta,
  resolveAsrGuidance,
  convertAsrSegmentsToTraditionalChinese,
  callWhisperApi,
  getClipAudioBuffer,
  getRecognitionAudioSourceChoices,
  openSpeechRecognitionDialog
} from '../src/speech-recognition.js';

describe('語音辨識與字幕生成模組', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Object.defineProperty(window, 'subtool', { configurable: true, value: undefined });
    document.body.innerHTML = '';
    localStorage.clear();
    State.tracks = [{ name: '軌道 1', visible: true, locked: false }];
    State.cues = [];
    State.fps = 30;
    State.dropFrame = false;
  });

  it('為右鍵指定的音訊來源開啟可選 Azure Speech 的辨識視窗', () => {
    State.clips = [];
    State.externalAudioState = [];
    const source = {
      id: 'external:dialogue',
      name: 'dialogue.wav',
      offset: 12,
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: {}
    };

    openSpeechRecognitionDialog(source);

    expect(openModal).toHaveBeenCalledTimes(1);
    const [, html] = openModal.mock.calls[0];
    expect(html).toContain('dialogue.wav');
    expect(html).toContain('value="azure"');
    expect(html).toContain('id="asrAzureRegion"');
    expect(html).toContain('placeholder="例如 japaneast"');
  });

  it('可切換為文本匹配並顯示固定逐行文字稿輸入框', () => {
    State.clips = [];
    State.externalAudioState = [];
    saveAsrConfig({ ...getAsrConfig(), taskMode: 'align' });

    openSpeechRecognitionDialog({
      id: 'alignment-dialogue',
      name: 'alignment-dialogue.wav',
      in: 0,
      out: 2,
      duration: 2,
      audioBuffer: {}
    });

    const [, html] = openModal.mock.calls[0];
    document.body.innerHTML = html;
    expect(document.getElementById('asrTaskMode').value).toBe('align');
    expect(getComputedStyle(document.getElementById('asrTranscriptRow')).display).toBe('flex');
    expect(document.getElementById('asrTranscript')).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.getElementById('asrTranscriptRow').textContent).toContain('每個非空白行固定為一條字幕');
    expect(document.getElementById('asrTargetSummary').value).toContain('文本匹配');
  });

  it('生成方式切換只顯示或隱藏文字稿，不會改寫已貼入的行', async () => {
    State.clips = [];
    State.externalAudioState = [];
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'transcribe' });
    openModal.mockImplementation((title, html) => { document.body.innerHTML = html; });

    openSpeechRecognitionDialog({
      id: 'alignment-mode-switch',
      name: 'alignment-mode-switch.wav',
      in: 0,
      out: 1,
      duration: 1,
      audioBuffer: {}
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const mode = document.getElementById('asrTaskMode');
    const transcript = document.getElementById('asrTranscript');
    const row = document.getElementById('asrTranscriptRow');
    transcript.value = '第一行。第二句仍在同一行！';
    mode.value = 'align';
    mode.onchange();
    expect(getComputedStyle(row).display).toBe('flex');
    expect(transcript.value).toBe('第一行。第二句仍在同一行！');

    mode.value = 'transcribe';
    mode.onchange();
    expect(getComputedStyle(row).display).toBe('none');
    expect(transcript.value).toBe('第一行。第二句仍在同一行！');
  });

  it('可從 TXT 匯入大量逐行文字稿並顯示檔名與有效行數', async () => {
    const sourceLines = Array.from({ length: 5000 }, (_, index) => `Line ${index + 1}.`);
    const importedText = `  ${sourceLines[0]}  \r\n\r\n${sourceLines.slice(1).join('\r\n')}\r\n`;
    const bytes = new Uint8Array(2 + importedText.length * 2);
    bytes[0] = 0xFF;
    bytes[1] = 0xFE;
    for (let index = 0; index < importedText.length; index++) {
      const code = importedText.charCodeAt(index);
      bytes[2 + index * 2] = code & 0xFF;
      bytes[3 + index * 2] = code >> 8;
    }
    class ImmediateFileReader {
      readAsArrayBuffer() {
        this.result = bytes.buffer;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader);

    try {
      State.clips = [];
      State.externalAudioState = [];
      saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', taskMode: 'align' });
      openModal.mockImplementation((_title, html) => { document.body.innerHTML = html; });

      openSpeechRecognitionDialog({
        id: 'alignment-import-txt',
        name: 'alignment-import-txt.wav',
        in: 0,
        out: 1,
        duration: 1,
        audioBuffer: {}
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      const importButton = document.getElementById('asrImportTranscriptButton');
      const fileInput = document.getElementById('asrTranscriptFileInput');
      const transcript = document.getElementById('asrTranscript');
      const fileSummary = document.getElementById('asrTranscriptFileSummary');
      const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});

      importButton.click();
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(fileInput.accept).toContain('.txt');

      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [{ name: 'many-lines.txt', size: bytes.byteLength }]
      });
      fileInput.dispatchEvent(new Event('change'));

      await vi.waitFor(() => expect(transcript.value).toContain('Line 5000.'));
      expect(transcript.value.startsWith('  Line 1.  \n\nLine 2.')).toBe(true);
      expect(fileSummary.textContent).toContain('many-lines.txt');
      expect(fileSummary.textContent).toContain('5000 行');

      transcript.value += '手動新增的一行';
      transcript.dispatchEvent(new Event('input', { bubbles: true }));
      expect(getComputedStyle(fileSummary).display).toBe('none');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('依指定順序排列辨識服務，並以無圖示文字維持左側對齊', () => {
    State.clips = [];
    State.externalAudioState = [];

    openSpeechRecognitionDialog({
      id: 'provider-order',
      name: 'provider-order.wav',
      in: 0,
      out: 1,
      duration: 1,
      audioBuffer: {}
    });

    const [, html] = openModal.mock.calls[0];
    document.body.innerHTML = html;
    const providerEl = document.getElementById('asrProvider');
    const options = [...providerEl.options];

    expect(providerEl.classList.contains('asr-provider-select')).toBe(true);
    expect(options.map(option => option.value)).toEqual([
      'builtin',
      'groq',
      'openai',
      'azure',
      'google'
    ]);
    expect(options.map(option => option.textContent.trim())).toEqual([
      '程式內建本機 AI 引擎 (免設定・100% 離線)',
      'Groq (Whisper-large-v3，極速雲端・免費)',
      'OpenAI (Whisper-1 官方雲端)',
      'Azure Speech (專業語音辨識・逐句時間碼)',
      'Google Gemini (大語言模型・繁體中文理解力最強)'
    ]);
  });

  it('只替實際支援的辨識服務提供提示詞或專有名詞欄位', () => {
    expect(getAsrGuidanceMeta('builtin')).toBeNull();
    expect(getAsrGuidanceMeta('google')).toMatchObject({ kind: 'prompt' });
    expect(getAsrGuidanceMeta('groq')).toMatchObject({ kind: 'prompt' });
    expect(getAsrGuidanceMeta('openai')).toMatchObject({ kind: 'prompt' });
    expect(getAsrGuidanceMeta('azure')).toMatchObject({ kind: 'phrases' });
    expect(resolveAsrGuidance('google', '逐字轉錄')).toEqual({ prompt: '逐字轉錄' });
    expect(resolveAsrGuidance('azure', 'SUB Tool， Evan; MXF\n字幕')).toEqual({
      azurePhraseList: 'SUB Tool， Evan; MXF\n字幕',
      azurePhrases: ['SUB Tool', 'Evan', 'MXF', '字幕']
    });
  });

  it('本機辨識隱藏提示詞欄位且不會暗中送出舊提示詞', () => {
    State.clips = [];
    State.externalAudioState = [];
    saveAsrConfig({ ...getAsrConfig(), provider: 'builtin', prompt: '不應送給本機模型' });

    openSpeechRecognitionDialog({
      id: 'local-dialogue',
      name: 'local-dialogue.wav',
      in: 0,
      out: 1,
      duration: 1,
      audioBuffer: {}
    });

    const [, html] = openModal.mock.calls[0];
    document.body.innerHTML = html;
    expect(getComputedStyle(document.getElementById('asrPromptRow')).display).toBe('none');
    expect(resolveAsrGuidance('builtin', '不應送給本機模型')).toEqual({});
  });

  it('切換辨識服務時依能力更新提示欄位', async () => {
    State.clips = [];
    State.externalAudioState = [];
    saveAsrConfig({
      ...getAsrConfig(),
      provider: 'builtin',
      prompt: '保留給雲端的提示詞',
      azurePhraseList: 'SUB Tool, Evan'
    });
    openModal.mockImplementation((title, html) => {
      document.body.innerHTML = html;
    });

    openSpeechRecognitionDialog({
      id: 'switch-dialogue',
      name: 'switch-dialogue.wav',
      in: 0,
      out: 1,
      duration: 1,
      audioBuffer: {}
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const providerEl = document.getElementById('asrProvider');
    const promptRow = document.getElementById('asrPromptRow');
    const promptLabel = document.getElementById('asrPromptLabel');
    const promptEl = document.getElementById('asrPrompt');
    expect(getComputedStyle(promptRow).display).toBe('none');

    providerEl.value = 'google';
    providerEl.onchange();
    expect(getComputedStyle(promptRow).display).toBe('flex');
    expect(promptLabel.textContent).toBe('提示詞（Prompt）：');
    expect(promptEl.value).toBe('保留給雲端的提示詞');

    providerEl.value = 'azure';
    providerEl.onchange();
    expect(getComputedStyle(promptRow).display).toBe('flex');
    expect(promptLabel.textContent).toContain('Phrase List');
    expect(promptEl.value).toBe('SUB Tool, Evan');

    providerEl.value = 'builtin';
    providerEl.onchange();
    expect(getComputedStyle(promptRow).display).toBe('none');
    expect(promptEl.value).toBe('');
  });

  it('能從桌面核發的素材 URL 載入右鍵指定音訊', async () => {
    const decoded = { duration: 2, sampleRate: 48000 };
    const decodeAudioData = vi.fn().mockResolvedValue(decoded);
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { fileURL: vi.fn().mockResolvedValue('subtool-local://resource/audio-token') }
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16)
    });

    await expect(getClipAudioBuffer({
      name: 'dialogue.wav',
      path: 'C:\\media\\dialogue.wav'
    }, { decodeAudioData, fetchImpl })).resolves.toBe(decoded);

    expect(window.subtool.fileURL).toHaveBeenCalledWith('C:\\media\\dialogue.wav');
    expect(fetchImpl).toHaveBeenCalledWith('subtool-local://resource/audio-token');
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('優先合併 ffmpeg runtime 聲道快取，不回頭解碼原始 MXF 容器', async () => {
    const makeBuffer = value => ({
      sampleRate: 48000,
      numberOfChannels: 1,
      length: 48000,
      duration: 1,
      getChannelData: () => new Float32Array(48000).fill(value)
    });
    const decodeAudioData = vi.fn()
      .mockResolvedValueOnce(makeBuffer(0.2))
      .mockResolvedValueOnce(makeBuffer(0.4));
    const fetchImpl = vi.fn().mockImplementation(async url => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(url).buffer
    }));
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { fileURL: vi.fn() }
    });

    const result = await getClipAudioBuffer({
      name: 'interview.mxf',
      path: 'C:\\media\\interview.mxf',
      preferCache: true,
      recognitionTracks: [
        { el: { src: 'subtool-local://resource/cache-ch1' } },
        { el: { src: 'subtool-local://resource/cache-ch1' } },
        { el: { src: 'subtool-local://resource/cache-ch2' } }
      ]
    }, { decodeAudioData, fetchImpl });

    expect(result).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, length: 16000, duration: 1 });
    expect(result.getChannelData(0)[0]).toBeCloseTo(0.3, 5);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'subtool-local://resource/cache-ch1',
      'subtool-local://resource/cache-ch2'
    ]);
    expect(window.subtool.fileURL).not.toHaveBeenCalled();
  });

  it('全部、單一與最後兩軌來源會產生三組不同且可驗證的 WAV PCM', async () => {
    const patterns = [
      [0.8, 0], [0, 0.8], [0.8, 0.8], [0.8, -0.8],
      [0, 0], [0, 0], [0.8, 0], [0, 0.8]
    ];
    const clip = {
      recognitionTracks: patterns.map((pattern, sourceStream) => ({
        sourceStream,
        sourceChannel: 0,
        buffer: {
          sampleRate: 16000,
          numberOfChannels: 1,
          length: 2,
          duration: 2 / 16000,
          getChannelData: () => new Float32Array(pattern)
        }
      }))
    };
    const choices = getRecognitionAudioSourceChoices(clip);
    const byLabel = label => choices.find(choice => choice.label === label).selection;
    const firstSamples = async selection => {
      const selected = await getClipAudioBuffer(clip, { recognitionSelection: selection });
      const wav = encodeWav16kMono(selected, 0, selected.duration);
      const view = new DataView(await wav.arrayBuffer());
      return [view.getInt16(44, true), view.getInt16(46, true)];
    };

    expect(await firstSamples(byLabel('來源聲道 1'))).toEqual([31128, 0]);
    expect(await firstSamples(byLabel('最後兩軌組（來源聲道 7 + 8）'))).toEqual([31128, 31128]);
    expect(await firstSamples(byLabel('全部來源聲道混音（8 軌）'))).toEqual([31128, 15564]);
  });

  it('全部模式會把 6 聲道與 2 聲道資源展開成 8 軌等權平均', async () => {
    const makeBuffer = patterns => ({
      sampleRate: 16000,
      numberOfChannels: patterns.length,
      length: 2,
      duration: 2 / 16000,
      getChannelData: channel => new Float32Array(patterns[channel])
    });
    const surround = makeBuffer(Array.from({ length: 6 }, () => [0.8, 0]));
    const stereo = makeBuffer(Array.from({ length: 2 }, () => [0, 0.8]));
    const clip = {
      recognitionTracks: [
        ...Array.from({ length: 6 }, (_, sourceChannel) => ({
          sourceStream: 0,
          sourceChannel,
          buffer: surround
        })),
        ...Array.from({ length: 2 }, (_, sourceChannel) => ({
          sourceStream: 1,
          sourceChannel,
          buffer: stereo
        }))
      ]
    };

    const mixed = await getClipAudioBuffer(clip);
    const wav = encodeWav16kMono(mixed, 0, mixed.duration);
    const view = new DataView(await wav.arrayBuffer());
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([31128, 10376]);
  });

  it('共用的多聲道快取可選真實聲道，但共用單聲道 URL 不製造假的單軌選項', async () => {
    const sharedStereo = {
      sampleRate: 16000,
      numberOfChannels: 2,
      length: 2,
      duration: 2 / 16000,
      getChannelData: channel => [
        new Float32Array([0.7, 0]),
        new Float32Array([0, 0.5])
      ][channel]
    };
    const multichannelClip = {
      recognitionTracks: [
        { sourceStream: 0, sourceChannel: 1, buffer: sharedStereo },
        { sourceStream: 0, sourceChannel: 0, buffer: sharedStereo }
      ]
    };
    const choices = getRecognitionAudioSourceChoices(multichannelClip);
    expect(choices.map(choice => choice.label)).toEqual([
      '全部來源聲道混音（2 軌）',
      '來源聲道 1',
      '來源聲道 2'
    ]);

    const second = await getClipAudioBuffer(multichannelClip, {
      recognitionSelection: choices.find(choice => choice.label === '來源聲道 2').selection
    });
    expect([...second.getChannelData(0)]).toEqual([0, 0.5]);

    const duplicatedMonoURL = getRecognitionAudioSourceChoices({
      recognitionTracks: [
        { sourceStream: 0, sourceChannel: 0, el: { src: 'subtool-local://resource/shared-mono' } },
        { sourceStream: 1, sourceChannel: 0, el: { src: 'subtool-local://resource/shared-mono' } }
      ]
    });
    expect(duplicatedMonoURL.map(choice => choice.label)).toEqual(['全部來源聲道混音（2 軌）']);
  });

  it('單一來源聲道選項只投影指定 sourceChannel，不會混入同 buffer 的其他聲道', async () => {
    const selectedBuffer = {
      sampleRate: 16000,
      numberOfChannels: 2,
      length: 2,
      duration: 2 / 16000,
      getChannelData: channel => new Float32Array(channel === 0 ? [0.8, 0] : [0, 0.8])
    };
    const clip = {
      recognitionTracks: [
        { sourceStream: 0, sourceChannel: 0, buffer: selectedBuffer },
        {
          sourceStream: 1,
          sourceChannel: 0,
          buffer: {
            ...selectedBuffer,
            getChannelData: () => new Float32Array([0, 0])
          }
        }
      ]
    };
    const selection = getRecognitionAudioSourceChoices(clip)
      .find(choice => choice.label === '來源聲道 1').selection;
    const selected = await getClipAudioBuffer(clip, { recognitionSelection: selection });
    const wav = encodeWav16kMono(selected, 0, selected.duration);
    const view = new DataView(await wav.arrayBuffer());
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([31128, 0]);
  });

  it('標記 preferCache 的素材快取未就緒時不讀取母容器', async () => {
    const fetchImpl = vi.fn();
    Object.defineProperty(window, 'subtool', {
      configurable: true,
      value: { fileURL: vi.fn() }
    });

    await expect(getClipAudioBuffer({
      id: 'external:mxf',
      name: 'interview.mxf',
      path: 'C:\\media\\interview.mxf',
      preferCache: true,
      recognitionTracks: []
    }, { decodeAudioData: vi.fn(), fetchImpl })).rejects.toThrow('音訊快取仍在準備中');

    expect(window.subtool.fileURL).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('全部模式遇到任一 preferCache 來源聲道未就緒時不會靜默只混其餘聲道', async () => {
    const readyBuffer = {
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 2,
      duration: 2 / 16000,
      getChannelData: () => new Float32Array([0.8, 0])
    };

    await expect(getClipAudioBuffer({
      id: 'partial-cache',
      name: 'partial-cache.mxf',
      preferCache: true,
      recognitionTracks: [
        { sourceStream: 0, sourceChannel: 0, buffer: readyBuffer },
        { sourceStream: 1, sourceChannel: 0 }
      ]
    })).rejects.toThrow('來源聲道快取仍在準備中');
  });

  describe('設定管理 (Configuration)', () => {
    it('提供預設的 ASR 設定，預設為 Google 語音辨識', () => {
      const conf = getAsrConfig();
      expect(conf.taskMode).toBe('transcribe');
      expect(conf.provider).toBe('google');
      expect(conf.builtinModel).toBe('onnx-community/whisper-large-v3-turbo');
      expect(conf.language).toBe('zh');
      expect(conf.prompt).toContain('繁體中文');
      expect(conf.azureRegion).toBe('japaneast');
    });

    it('內建模型清單提供 Tiny, Base, Small 等級', () => {
      expect(BUILTIN_MODELS['onnx-community/whisper-tiny']).toBeDefined();
      expect(BUILTIN_MODELS['onnx-community/whisper-base']).toBeDefined();
      expect(BUILTIN_MODELS['onnx-community/whisper-small']).toMatchObject({
        webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        wasmDtype: 'q8'
      });
      expect(BUILTIN_MODELS['onnx-community/whisper-large-v3-turbo']).toMatchObject({
        webgpuDtype: 'q4',
        wasmDtype: 'q8'
      });
    });

    it('能夠儲存並讀回自訂的 ASR 設定', () => {
      saveAsrConfig({
        taskMode: 'align',
        provider: 'builtin',
        builtinModel: 'onnx-community/whisper-small',
        openaiApiKey: 'sk-test-key-1234',
        groqApiKey: 'gsk-groq-key-5678',
        language: 'en',
        prompt: 'Testing prompt'
      });
      const conf = getAsrConfig();
      expect(conf.taskMode).toBe('align');
      expect(conf.provider).toBe('builtin');
      expect(conf.builtinModel).toBe('onnx-community/whisper-small');
      expect(conf.openaiApiKey).toBe('sk-test-key-1234');
      expect(conf.groqApiKey).toBe('gsk-groq-key-5678');
      expect(conf.language).toBe('en');
    });

    it('支援將可選 Prompt 清空，不會重新塞回預設文字', () => {
      saveAsrConfig({ ...getAsrConfig(), prompt: '' });
      expect(getAsrConfig().prompt).toBe('');
    });

    it('能夠儲存並讀回 Azure Speech 的 Key、Region 與專有名詞', () => {
      saveAsrConfig({
        provider: 'azure',
        azureApiKey: 'azure-key',
        azureRegion: 'southeastasia',
        azurePhraseList: 'SUB Tool, Evan',
        language: 'zh'
      });

      const conf = getAsrConfig();
      expect(conf).toMatchObject({
        provider: 'azure',
        azureApiKey: 'azure-key',
        azureRegion: 'southeastasia',
        azurePhraseList: 'SUB Tool, Evan',
        language: 'zh'
      });
    });
  });

  it('選擇中文時把各辨識服務的簡體輸出轉為台灣繁體，且保留時間碼資料', () => {
    const original = [{
      start: 1.25,
      end: 3.5,
      text: '我来不及了，还没回来。软件和鼠标。',
      confidence: 0.9
    }];
    expect(convertAsrSegmentsToTraditionalChinese(original, 'zh')).toEqual([{
      start: 1.25,
      end: 3.5,
      text: '我來不及了，還沒回來。軟體和滑鼠。',
      confidence: 0.9
    }]);
    expect(convertAsrSegmentsToTraditionalChinese(original, 'en')).toBe(original);
  });

  describe('16kHz PCM Float32 萃取 (extractClipFloat32Mono16k)', () => {
    it('將任意取樣率之立體聲 AudioBuffer 轉換並重採樣為 16kHz 單聲道 Float32Array 並自動正規化峰值', () => {
      const sampleRate = 48000;
      const duration = 2; // 2 seconds (48000 * 2 = 96000 samples)
      const length = sampleRate * duration;
      const ch1 = new Float32Array(length).fill(0.6);
      const ch2 = new Float32Array(length).fill(0.4);

      const audioBuffer = {
        sampleRate,
        numberOfChannels: 2,
        length,
        duration,
        getChannelData: (ch) => (ch === 0 ? ch1 : ch2)
      };

      const float32 = extractClipFloat32Mono16k(audioBuffer, 0, 2);
      expect(float32).toBeInstanceOf(Float32Array);
      // 2 seconds @ 16000 Hz = 32000 samples
      expect(float32.length).toBe(32000);
      // Normalized peak is scaled up to 0.95 for Whisper acoustic clarity
      expect(float32[0]).toBeCloseTo(0.95, 2);
    });

    it('長度為 0 時回傳 null', () => {
      const audioBuffer = {
        sampleRate: 48000,
        numberOfChannels: 1,
        length: 48000,
        duration: 1,
        getChannelData: () => new Float32Array(48000)
      };
      expect(extractClipFloat32Mono16k(audioBuffer, 1, 1)).toBeNull();
    });
  });

  describe('16kHz Mono WAV 編碼 (encodeWav16kMono)', () => {
    it('將 AudioBuffer 區間轉換為標準 16kHz 16-bit Mono WAV', async () => {
      const sampleRate = 48000;
      const duration = 2; // 2 seconds
      const length = sampleRate * duration;
      const ch1 = new Float32Array(length).fill(0.5);
      const ch2 = new Float32Array(length).fill(-0.5);

      const audioBuffer = {
        sampleRate,
        numberOfChannels: 2,
        length,
        duration,
        getChannelData: (ch) => (ch === 0 ? ch1 : ch2)
      };

      const wavBlob = encodeWav16kMono(audioBuffer, 0, 2);
      expect(wavBlob).toBeInstanceOf(Blob);
      expect(wavBlob.type).toBe('audio/wav');

      const arrayBuf = await wavBlob.arrayBuffer();
      const view = new DataView(arrayBuf);

      // Check RIFF header
      const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      expect(riff).toBe('RIFF');

      const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      expect(wave).toBe('WAVE');

      // Check sample rate = 16000
      expect(view.getUint32(24, true)).toBe(16000);
      // Check channels = 1 (Mono)
      expect(view.getUint16(22, true)).toBe(1);
      // Check bit depth = 16
      expect(view.getUint16(34, true)).toBe(16);
    });
  });

  describe('字幕時碼映射與軌道注入 (insertAsrSubtitles)', () => {
    it('完成字幕軌注入後立即使時間軸失效，不必等待視窗 resize 才顯示', () => {
      const clip = { id: 'timeline-redraw', offset: 0, in: 0, out: 2 };

      insertAsrSubtitles([{
        clip,
        segments: [{ start: 0, end: 1, text: '立即顯示' }]
      }]);

      expect(emit).toHaveBeenCalledWith('timeline:invalidate');
    });

    it('自動建立專屬語音辨識軌道並將相對時碼轉換為時間軸絕對時碼', () => {
      const clip = {
        id: 'clip-1',
        name: '對白_A.mp4',
        offset: 10.0, // Timeline position 10.0s
        in: 2.0,      // Trimmed source in
        out: 12.0     // Trimmed source out (duration 10s)
      };

      const segments = [
        { start: 1.0, end: 3.5, text: '第一句字幕' },
        { start: 4.0, end: 7.2, text: '第二句字幕' }
      ];

      const count = insertAsrSubtitles([{ clip, segments }]);
      expect(count).toBe(2);

      // 檢查新軌道
      expect(State.tracks.length).toBe(2);
      expect(State.tracks[1].name).toBe('語音辨識');
      expect(State.listTrack).toBe(1);

      // 檢查字幕時碼
      expect(State.cues.length).toBe(2);
      expect(State.cues[0].track).toBe(1);
      expect(State.cues[0].text).toBe('第一句字幕');
      // 10.0 + 1.0 = 11.0s
      expect(State.cues[0].start).toBeCloseTo(11.0, 2);
      expect(State.cues[0].end).toBeCloseTo(13.5, 2);

      // 10.0 + 4.0 = 14.0s
      expect(State.cues[1].start).toBeCloseTo(14.0, 2);
      expect(State.cues[1].end).toBeCloseTo(17.2, 2);
    });

    it('多片段辨識時，所有字幕依時間軸順序整合至同一個新軌道', () => {
      const clip1 = { id: 'c1', offset: 0.0, in: 0, out: 5.0 };
      const clip2 = { id: 'c2', offset: 20.0, in: 0, out: 5.0 };

      const results = [
        { clip: clip1, segments: [{ start: 0.5, end: 2.0, text: '片段一對白' }] },
        { clip: clip2, segments: [{ start: 1.0, end: 3.0, text: '片段二對白' }] }
      ];

      const count = insertAsrSubtitles(results);
      expect(count).toBe(2);
      expect(State.tracks.length).toBe(2);
      expect(State.cues[0].text).toBe('片段一對白');
      expect(State.cues[0].start).toBeCloseTo(0.5, 2);
      expect(State.cues[1].text).toBe('片段二對白');
      expect(State.cues[1].start).toBeCloseTo(21.0, 2);
    });
  });

  describe('Whisper API 調用 (callWhisperApi)', () => {
    it('呼叫 Groq API 端點與參數格式正確', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: '測試對白',
          segments: [{ id: 0, start: 0.0, end: 2.0, text: '測試對白' }]
        })
      });
      global.fetch = mockFetch;

      const dummyBlob = new Blob(['mock-wav'], { type: 'audio/wav' });
      const result = await callWhisperApi({
        audioBlob: dummyBlob,
        provider: 'groq',
        apiKey: 'gsk-123456',
        language: 'zh',
        prompt: '繁體中文'
      });

      expect(result.segments.length).toBe(1);
      expect(result.segments[0].text).toBe('測試對白');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer gsk-123456' }
        })
      );
    });

    it('未輸入 API Key 時拋出清晰錯誤', async () => {
      const dummyBlob = new Blob(['mock-wav'], { type: 'audio/wav' });
      await expect(callWhisperApi({
        audioBlob: dummyBlob,
        provider: 'groq',
        apiKey: ''
      })).rejects.toThrow(/API Key/);
    });

    it('支援呼叫 OpenAI Whisper 官方雲端 API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'OpenAI 辨識字幕',
          segments: [{ id: 0, start: 0.0, end: 1.5, text: 'OpenAI 辨識字幕' }]
        })
      });
      global.fetch = mockFetch;

      const dummyBlob = new Blob(['mock-wav'], { type: 'audio/wav' });
      const result = await callWhisperApi({
        audioBlob: dummyBlob,
        provider: 'openai',
        apiKey: 'test-openai-key',
        language: 'zh',
        prompt: ''
      });

      expect(result.segments[0].text).toBe('OpenAI 辨識字幕');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-openai-key'
          })
        })
      );
    });
  });

  describe('Google Gemini 1.5 語音辨識 (Google Gemini API)', () => {
    it('成功呼叫 Gemini API 並解析回傳的字幕 JSON 陣列', async () => {
      const { callGeminiAudioTranscription } = await import('../src/speech-recognition.js');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      { start: 0.2, end: 2.1, text: 'Google 辨識第一句' },
                      { start: 2.5, end: 4.8, text: 'Google 辨識第二句' }
                    ])
                  }
                ]
              }
            }
          ]
        })
      });
      global.fetch = mockFetch;

      const dummyBlob = new Blob(['wav-content'], { type: 'audio/wav' });
      const result = await callGeminiAudioTranscription({
        audioBlob: dummyBlob,
        apiKey: 'test-google-key',
        language: 'zh',
        prompt: '繁體中文'
      });

      expect(result.segments.length).toBe(2);
      expect(result.segments[0].text).toBe('Google 辨識第一句');
      expect(result.segments[0].start).toBe(0.2);
      expect(result.segments[0].end).toBe(2.1);
      expect(result.segments[1].text).toBe('Google 辨識第二句');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://generativelanguage.googleapis.com/v1beta/models/'),
        expect.objectContaining({
          method: 'POST'
        })
      );
    });

    it('未輸入 Google API Key 時拋出錯誤', async () => {
      const { callGeminiAudioTranscription } = await import('../src/speech-recognition.js');
      const dummyBlob = new Blob(['wav-content'], { type: 'audio/wav' });
      await expect(callGeminiAudioTranscription({
        audioBlob: dummyBlob,
        apiKey: ''
      })).rejects.toThrow(/Google Gemini API Key/);
    });
  });

  describe('深層推論入口 (transcribeAudioStream)', () => {
    it('接收 AudioBuffer 並透過 Google Gemini 成功辨識串流', async () => {
      const { transcribeAudioStream } = await import('../src/speech-recognition-engine.js');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify([{ start: 0.1, end: 1.5, text: '測試推論' }]) }]
              }
            }
          ]
        })
      });
      global.fetch = mockFetch;

      const sampleRate = 48000;
      const audioBuffer = {
        sampleRate,
        numberOfChannels: 1,
        length: sampleRate * 2,
        duration: 2,
        getChannelData: () => new Float32Array(sampleRate * 2).fill(0.5)
      };

      const segments = await transcribeAudioStream({
        audioBuffer,
        inT: 0,
        outT: 2,
        provider: 'google',
        apiKey: 'test-google-key'
      });

      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe('測試推論');
    });

    it('未提供音訊時拋出例外', async () => {
      const { transcribeAudioStream } = await import('../src/speech-recognition-engine.js');
      await expect(transcribeAudioStream({
        audioBuffer: null,
        provider: 'google',
        apiKey: 'test-key'
      })).rejects.toThrow(/未提供有效的音訊來源/);
    });
  });
});

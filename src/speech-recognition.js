/* ==============================================================================
   SUB Tool — Speech Recognition UI Module (src/speech-recognition.js)
   ==============================================================================
   語音辨識／逐行文本匹配使用者介面（UI Modal）與時間軸字幕軌生成協調器。
   推論核心由 src/speech-recognition-engine.js 提供，本模組專注於：
   1. 互動式對話框表單（模型、API Key、提示詞、語言選擇）
   2. 進度條回饋與狀態提示
   3. 辨識結果或固定逐行文字稿轉為標準時間軸字幕軌（Subtitle Track / Cues）
   ============================================================================== */
import { State, newTrack, syncTrackCount, newId, setSelection, IS_DESKTOP } from './state.js';
import { AudioEngine } from './audio-engine.js';
import { snapTimeToFrame, secToEncore } from './time.js';
import { sortCues } from './subtitle-model.js';
import { recordHistory } from './history.js';
import { openModal, closeModal, showToast } from './ui.js';
import { emit } from './events.js';
import { escapeHTML } from './util.js';
import { alignTranscriptToEvidence, parseTranscriptLines } from './transcript-alignment.js';
import {
  BUILTIN_MODELS,
  DEFAULT_AZURE_SPEECH_REGION,
  blobToBase64,
  extractClipFloat32Mono16k,
  combineRecognitionAudioBuffers,
  encodeWav16kMono,
  convertAsrSegmentsToTraditionalChinese,
  loadTransformersPipeline,
  transcribeWithBuiltinModel,
  resolveGeminiModel,
  callGeminiAudioTranscription,
  parseAzureTranscriptionResponse,
  callAzureSpeechTranscription,
  callWhisperApi,
  transcribeAudioStream
} from './speech-recognition-engine.js';

// Re-export 推論模組介面以維持向下相容
export {
  BUILTIN_MODELS,
  DEFAULT_AZURE_SPEECH_REGION,
  blobToBase64,
  extractClipFloat32Mono16k,
  combineRecognitionAudioBuffers,
  encodeWav16kMono,
  convertAsrSegmentsToTraditionalChinese,
  loadTransformersPipeline,
  transcribeWithBuiltinModel,
  resolveGeminiModel,
  callGeminiAudioTranscription,
  parseAzureTranscriptionResponse,
  callAzureSpeechTranscription,
  callWhisperApi,
  transcribeAudioStream
};

const ASR_CONFIG_KEY = 'subtool_asr_config';
const DEFAULT_ASR_PROMPT = '以下是影音對話，請以繁體中文輸出完整字幕，精準保留標點符號。';
const CLOUD_PROVIDER_META = Object.freeze({
  google: Object.freeze({
    keyField: 'googleApiKey',
    name: 'Google Gemini',
    keyLabel: 'Google Gemini API Key：',
    helpLabel: '取得 Google 免費 API Key ↗',
    helpURL: 'https://aistudio.google.com/app/apikey'
  }),
  azure: Object.freeze({
    keyField: 'azureApiKey',
    name: 'Azure Speech',
    keyLabel: 'Azure Speech API Key：',
    helpLabel: '建立 Azure Speech 資源 ↗',
    helpURL: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices'
  }),
  groq: Object.freeze({
    keyField: 'groqApiKey',
    name: 'Groq',
    keyLabel: 'Groq API Key：',
    helpLabel: '取得 Groq 免費 API Key ↗',
    helpURL: 'https://console.groq.com/keys'
  }),
  openai: Object.freeze({
    keyField: 'openaiApiKey',
    name: 'OpenAI',
    keyLabel: 'OpenAI API Key：',
    helpLabel: '取得 OpenAI API Key ↗',
    helpURL: 'https://platform.openai.com/api-keys'
  })
});

const ASR_GUIDANCE_META = Object.freeze({
  google: Object.freeze({
    kind: 'prompt',
    label: '提示詞（Prompt）：',
    placeholder: '選填，例如：逐字轉錄並保留標點符號。'
  }),
  azure: Object.freeze({
    kind: 'phrases',
    label: 'Azure 專有名詞（Phrase List，以逗號分隔）：',
    placeholder: '選填，例如：SUB Tool, Evan'
  }),
  groq: Object.freeze({
    kind: 'prompt',
    label: '前文／專有名詞導引（Prompt）：',
    placeholder: '選填，例如：China Airlines, EES, Kiosk'
  }),
  openai: Object.freeze({
    kind: 'prompt',
    label: '前文／專有名詞導引（Prompt）：',
    placeholder: '選填，例如：China Airlines, EES, Kiosk'
  })
});

/** 取得 provider 真正支援的提示詞／專有名詞欄位；本機辨識沒有此欄位。 */
export function getAsrGuidanceMeta(provider) {
  return ASR_GUIDANCE_META[provider] || null;
}

/** 將畫面欄位正規化成 provider 可接受的參數，避免隱藏欄位仍被暗中送出。 */
export function resolveAsrGuidance(provider, rawValue = '') {
  const meta = getAsrGuidanceMeta(provider);
  const value = typeof rawValue === 'string' ? rawValue : '';
  if (!meta) return {};
  if (meta.kind === 'phrases') {
    return {
      azurePhraseList: value,
      azurePhrases: value.split(/[,，;；\n]+/u).map(item => item.trim()).filter(Boolean)
    };
  }
  return { prompt: value };
}

/**
 * 讀取已儲存的 ASR 設定
 */
export function getAsrConfig() {
  try {
    const raw = localStorage.getItem(ASR_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          taskMode: parsed.taskMode === 'align' ? 'align' : 'transcribe',
          provider: parsed.provider || 'google',
          builtinModel: parsed.builtinModel || 'onnx-community/whisper-large-v3-turbo',
          googleApiKey: parsed.googleApiKey || '',
          groqApiKey: parsed.groqApiKey || '',
          openaiApiKey: parsed.openaiApiKey || '',
          azureApiKey: parsed.azureApiKey || '',
          azureRegion: parsed.azureRegion || DEFAULT_AZURE_SPEECH_REGION,
          azurePhraseList: parsed.azurePhraseList || '',
          language: parsed.language || 'zh',
          prompt: typeof parsed.prompt === 'string' ? parsed.prompt : DEFAULT_ASR_PROMPT
        };
      }
    }
  } catch (_) {}
  return {
    taskMode: 'transcribe',
    provider: 'google',
    builtinModel: 'onnx-community/whisper-large-v3-turbo',
    googleApiKey: '',
    groqApiKey: '',
    openaiApiKey: '',
    azureApiKey: '',
    azureRegion: DEFAULT_AZURE_SPEECH_REGION,
    azurePhraseList: '',
    language: 'zh',
    prompt: DEFAULT_ASR_PROMPT
  };
}

/**
 * 儲存 ASR 設定
 */
export function saveAsrConfig(conf) {
  try {
    localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(conf));
  } catch (_) {}
}

/**
 * 取得指定素材的完整 AudioBuffer
 */
export async function getClipAudioBuffer(clip, {
  decodeAudioData = data => AudioEngine.decodeAudioData(data),
  fetchImpl = (...args) => fetch(...args),
  signal = null
} = {}) {
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('語音辨識已取消');
    error.name = 'AbortError';
    throw error;
  };
  throwIfAborted();
  if (clip.audioBuffer) return clip.audioBuffer;

  const decodeURL = async url => {
    throwIfAborted();
    const response = signal ? await fetchImpl(url, { signal }) : await fetchImpl(url);
    if (response?.ok === false) throw new Error(`無法讀取素材音訊 (HTTP ${response.status})`);
    const data = await response.arrayBuffer();
    throwIfAborted();
    const decoded = await decodeAudioData(data);
    throwIfAborted();
    return decoded;
  };

  const recognitionTracks = Array.isArray(clip.recognitionTracks) ? clip.recognitionTracks : [];
  if (recognitionTracks.length) {
    const decoded = [];
    const seenBuffers = new Set();
    const seenURLs = new Set();
    for (const track of recognitionTracks) {
      throwIfAborted();
      if (track?.buffer && !seenBuffers.has(track.buffer)) {
        seenBuffers.add(track.buffer);
        decoded.push(track.buffer);
        continue;
      }
      let url = track?.el?.src || track?.audioElement?.src || '';
      if (!url && track?.file && typeof window !== 'undefined' && window.subtool?.fileURL) {
        url = await window.subtool.fileURL(track.file);
        throwIfAborted();
      }
      if (!url || seenURLs.has(url)) continue;
      seenURLs.add(url);
      decoded.push(await decodeURL(url));
    }
    const combined = combineRecognitionAudioBuffers(decoded);
    if (combined) return combined;
  }

  if (clip.preferCache) {
    throw new Error(`素材「${clip.name || clip.id}」的音訊快取仍在準備中，請稍後再辨識`);
  }

  if (clip.audioElement) {
    const url = clip.audioElement.src || clip.src;
    if (url) return decodeURL(url);
  }

  const file = clip.file || clip._file || clip.blob;
  if (file && typeof file.arrayBuffer === 'function') {
    const data = await file.arrayBuffer();
    throwIfAborted();
    const decoded = await decodeAudioData(data);
    throwIfAborted();
    return decoded;
  }

  if (clip.web?.url) return decodeURL(clip.web.url);

  if (clip.path && typeof window !== 'undefined' && window.subtool?.fileURL) {
    const authorizedURL = await window.subtool.fileURL(clip.path);
    throwIfAborted();
    if (authorizedURL) return decodeURL(authorizedURL);
  }

  throw new Error(`無法載入素材「${clip.name || clip.id}」的音訊資料`);
}

/**
 * 將辨識結果結構轉換為字幕軌並加入時間軸
 */
export function insertAsrSubtitles(results, {
  trackName = '語音辨識',
  historyLabel = '🎙 語音辨識生成字幕'
} = {}) {
  if (!results || results.length === 0) return 0;

  const fps = State.fps || 24;
  const dropFrame = State.dropFrame || false;
  const newCues = [];
  const trackObj = newTrack(trackName);
  State.tracks.push(trackObj);
  const trackIdx = State.tracks.length - 1;
  State.listTrack = trackIdx;

  for (const item of results) {
    const clip = item.clip;
    const segments = item.segments || [];
    const clipStartTimeline = (clip.offset != null ? Number(clip.offset) : Number(clip.start)) || 0;

    for (const seg of segments) {
      if (!seg.text || !seg.text.trim()) continue;

      const segStart = Number(seg.start) || 0;
      const segEnd = Number(seg.end) || (segStart + 1.5);

      const timelineStartRaw = clipStartTimeline + segStart;
      const timelineEndRaw = clipStartTimeline + segEnd;

      const start = Math.max(0, snapTimeToFrame(timelineStartRaw, fps, dropFrame));
      let end = snapTimeToFrame(timelineEndRaw, fps, dropFrame);
      if (end <= start) {
        end = snapTimeToFrame(start + (1 / fps), fps, dropFrame);
      }

      newCues.push({
        id: newId(),
        track: trackIdx,
        start,
        end,
        text: seg.text.trim(),
        style: null
      });
    }
  }

  if (newCues.length === 0) {
    syncTrackCount();
    emit('timeline:invalidate');
    emit('render:listTrackSel');
    emit('render:all');
    return 0;
  }

  recordHistory(historyLabel);

  State.cues.push(...newCues);
  sortCues();
  setSelection(newCues[0].id);
  syncTrackCount();

  emit('timeline:invalidate');
  emit('render:listTrackSel');
  emit('render:all');

  return newCues.length;
}

/**
 * 開啟語音辨識設定與執行對話框
 */
export function openSpeechRecognitionDialog(preferredSource = null) {
  const clips = [];
  const requested = Array.isArray(preferredSource) ? preferredSource : (preferredSource ? [preferredSource] : []);
  for (const source of requested) {
    if (source && typeof source === 'object' && !clips.includes(source)) clips.push(source);
  }
  if (clips.length === 0 && State.selectedClipId) {
    const c = State.clips.find(item => item.id === State.selectedClipId);
    if (c) clips.push(c);
  }
  if (clips.length === 0 && State.selectedAudioClipId) {
    const c = (State.externalAudioState || []).find(item => item.id === State.selectedAudioClipId);
    if (c && !clips.includes(c)) clips.push(c);
  }

  if (clips.length === 0) {
    if (State.clips && State.clips.length > 0) {
      clips.push(State.clips[0]);
    } else if (State.externalAudioState && State.externalAudioState.length > 0) {
      clips.push(State.externalAudioState[0]);
    }
  }

  if (clips.length === 0) {
    showToast('⚠️ 目前時間軸上無任何音訊或視訊素材可供辨識。', 3500);
    return;
  }

  const conf = getAsrConfig();
  const initialProviderMeta = CLOUD_PROVIDER_META[conf.provider] || null;
  const initialTaskMode = conf.taskMode === 'align' ? 'align' : 'transcribe';
  const initialGuidanceMeta = getAsrGuidanceMeta(conf.provider);
  const initialGuidanceValue = initialGuidanceMeta?.kind === 'phrases'
    ? (conf.azurePhraseList || '')
    : (initialGuidanceMeta ? (conf.prompt || '') : '');
  const cloudProvider = !!initialProviderMeta;
  const selectedApiKey = initialProviderMeta ? (conf[initialProviderMeta.keyField] || '') : '';

  const totalDur = clips.reduce((acc, c) => {
    const inT = Number(c.in) || 0;
    const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (State.duration || 0)));
    return acc + Math.max(0, outT - inT);
  }, 0);

  const clipsSummary = clips.map((c, i) => {
    const inT = Number(c.in) || 0;
    const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (State.duration || 0)));
    const durStr = secToEncore(Math.max(0, outT - inT), State.fps, State.dropFrame);
    return `<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>${i + 1}. ${escapeHTML(c.name || '音訊素材')}</span><span style="color:var(--text-faint)">${durStr}</span></div>`;
  }).join('');

  const html = `
    <div class="asr-form" style="display:flex;flex-direction:column;gap:12px;">
      <div style="background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:10px;">
        <div style="font-weight:600;margin-bottom:6px;color:var(--text);">已選取 ${clips.length} 個音訊來源（總長度約 ${secToEncore(totalDur, State.fps, State.dropFrame)}）：</div>
        <div style="max-height:80px;overflow-y:auto;font-size:12px;color:var(--text-dim);">${clipsSummary}</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">生成方式：</label>
        <select id="asrTaskMode" style="width:100%;">
          <option value="transcribe" ${initialTaskMode === 'transcribe' ? 'selected' : ''}>語音辨識（由聲音產生文字與時間碼）</option>
          <option value="align" ${initialTaskMode === 'align' ? 'selected' : ''}>文本匹配（保留逐行文字稿，只匹配時間碼）</option>
        </select>
      </div>

      <div id="asrTranscriptRow" style="display:${initialTaskMode === 'align' ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">逐行文字稿：</label>
        <textarea id="asrTranscript" rows="7" placeholder="在此貼上已分行的文字稿…" style="width:100%;resize:vertical;min-height:120px;box-sizing:border-box;line-height:1.5;"></textarea>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">每個非空白行固定為一條字幕；只裁掉行首、行尾空白，不會重新分行、分句或改寫內容。</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">聲音分析引擎：</label>
        <select id="asrProvider" class="asr-provider-select" style="width:100%;">
          <option value="builtin" ${conf.provider === 'builtin' ? 'selected' : ''}>程式內建本機 AI 引擎 (免設定・100% 離線)</option>
          <option value="groq" ${conf.provider === 'groq' ? 'selected' : ''}>Groq (Whisper-large-v3，極速雲端・免費)</option>
          <option value="openai" ${conf.provider === 'openai' ? 'selected' : ''}>OpenAI (Whisper-1 官方雲端)</option>
          <option value="azure" ${conf.provider === 'azure' ? 'selected' : ''}>Azure Speech (專業語音辨識・逐句時間碼)</option>
          <option value="google" ${conf.provider === 'google' ? 'selected' : ''}>Google Gemini (大語言模型・繁體中文理解力最強)</option>
        </select>
      </div>

      <!-- 內建模型選擇 -->
      <div id="asrBuiltinRow" style="display:${conf.provider === 'builtin' ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">內建 AI 模型等級：</label>
        <select id="asrBuiltinModel" style="width:100%;">
          <option value="onnx-community/whisper-tiny" ${conf.builtinModel === 'onnx-community/whisper-tiny' ? 'selected' : ''}>Whisper Tiny (最快；CPU 約 39MB／GPU 約 150MB)</option>
          <option value="onnx-community/whisper-base" ${conf.builtinModel === 'onnx-community/whisper-base' ? 'selected' : ''}>Whisper Base (平衡；CPU 約 73MB／GPU 約 290MB)</option>
          <option value="onnx-community/whisper-small" ${conf.builtinModel === 'onnx-community/whisper-small' ? 'selected' : ''}>Whisper Small (中文佳；CPU 約 240MB／GPU 約 560MB)</option>
          <option value="onnx-community/whisper-large-v3-turbo" ${conf.builtinModel === 'onnx-community/whisper-large-v3-turbo' ? 'selected' : ''}>Whisper Large v3 Turbo q4 (速度優先，約 800MB)</option>
        </select>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">
          💡 首次使用特定模型時會自動下載並快取；下載量會依 GPU／CPU 執行版本而不同。本機電腦有獨立顯卡時可自動啟用 WebGPU 加速。若需應對嘈雜背景音樂電影，建議改用 Azure Speech 或 Google，並人工抽查結果。
        </div>
      </div>

      <!-- 雲端 API Key -->
      <div id="asrKeyRow" style="display:${cloudProvider ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);display:flex;justify-content:space-between;">
          <span id="asrKeyLabel">API Key：</span>
          <span id="asrKeyHelp" style="font-size:11px;color:var(--accent);cursor:pointer;"></span>
        </label>
        <input type="password" id="asrApiKey" placeholder="輸入您的 API Key…" value="${escapeHTML(selectedApiKey || '')}" style="width:100%;">
      </div>

      <div id="asrAzureRegionRow" style="display:${conf.provider === 'azure' ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">Azure Speech Region：</label>
        <input type="text" id="asrAzureRegion" placeholder="例如 ${DEFAULT_AZURE_SPEECH_REGION}" value="${escapeHTML(conf.azureRegion || DEFAULT_AZURE_SPEECH_REGION)}" style="width:100%;">
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">Region 必須與 Speech Key 的資源相同；新設定預設 ${DEFAULT_AZURE_SPEECH_REGION}，其他資源請依 Azure 入口網站顯示填寫。</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="display:flex;flex-direction:column;gap:5px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-dim);">語言：</label>
          <select id="asrLanguage" style="width:100%;">
            <option value="zh" ${conf.language === 'zh' ? 'selected' : ''}>繁體中文 (Chinese)</option>
            <option value="en" ${conf.language === 'en' ? 'selected' : ''}>英文 (English)</option>
            <option value="ja" ${conf.language === 'ja' ? 'selected' : ''}>日文 (Japanese)</option>
            <option value="ko" ${conf.language === 'ko' ? 'selected' : ''}>韓文 (Korean)</option>
            <option value="auto" ${conf.language === 'auto' ? 'selected' : ''}>自動偵測 (Auto)</option>
          </select>
        </div>

        <div style="display:flex;flex-direction:column;gap:5px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-dim);">生成目標：</label>
          <input type="text" id="asrTargetSummary" value="自動建立「${initialTaskMode === 'align' ? '文本匹配' : '語音辨識'}」新軌" disabled style="width:100%;opacity:0.75;">
        </div>
      </div>

      <div id="asrPromptRow" style="display:${initialGuidanceMeta ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label id="asrPromptLabel" style="font-size:12px;font-weight:600;color:var(--text-dim);">${escapeHTML(initialGuidanceMeta?.label || '')}</label>
        <input type="text" id="asrPrompt" placeholder="${escapeHTML(initialGuidanceMeta?.placeholder || '')}" value="${escapeHTML(initialGuidanceValue)}" style="width:100%;">
      </div>

      <div id="asrProgressContainer" style="display:none;flex-direction:column;gap:4px;">
        <div id="asrProgressLabel" style="font-size:11px;color:var(--text-dim);display:flex;justify-content:space-between;">
          <span>正在進行語音辨識推論…</span>
          <span id="asrProgressPercent" style="font-weight:600;color:var(--accent);">0%</span>
        </div>
        <div style="width:100%;height:6px;background:var(--border2);border-radius:3px;overflow:hidden;">
          <div id="asrProgressBar" style="width:0%;height:100%;background:var(--accent);transition:width 0.2s ease;"></div>
        </div>
      </div>

      <div id="asrStatus" style="font-size:12px;color:var(--accent);display:none;padding:6px 0;"></div>
    </div>
  `;

  let activeRecognitionController = null;
  const abortActiveRecognition = () => {
    if (activeRecognitionController && !activeRecognitionController.signal.aborted) {
      activeRecognitionController.abort();
    }
  };
  const cancelRecognition = () => {
    abortActiveRecognition();
    closeModal();
  };

  openModal('🎙 音訊辨識／文本匹配生成字幕', html, [
    { label: '取消', act: cancelRecognition },
    {
      label: initialTaskMode === 'align' ? '開始匹配' : '🚀 開始辨識',
      primary: true,
      act: async () => {
        const taskModeEl = document.getElementById('asrTaskMode');
        const transcriptEl = document.getElementById('asrTranscript');
        const providerEl = document.getElementById('asrProvider');
        const builtinModelEl = document.getElementById('asrBuiltinModel');
        const apiKeyEl = document.getElementById('asrApiKey');
        const azureRegionEl = document.getElementById('asrAzureRegion');
        const langEl = document.getElementById('asrLanguage');
        const promptEl = document.getElementById('asrPrompt');
        const statusEl = document.getElementById('asrStatus');
        const progressContainer = document.getElementById('asrProgressContainer');
        const progressLabel = document.getElementById('asrProgressLabel')?.firstElementChild;
        const progressPercent = document.getElementById('asrProgressPercent');
        const progressBar = document.getElementById('asrProgressBar');
        const modalFoot = document.getElementById('modalFoot');

        const taskMode = taskModeEl?.value === 'align' ? 'align' : 'transcribe';
        const transcript = transcriptEl?.value || '';
        const transcriptLines = taskMode === 'align' ? parseTranscriptLines(transcript) : [];
        const provider = providerEl?.value || 'google';
        const builtinModel = builtinModelEl?.value || 'onnx-community/whisper-large-v3-turbo';
        const apiKey = apiKeyEl?.value?.trim() || '';
        const azureRegion = azureRegionEl?.value?.trim() || DEFAULT_AZURE_SPEECH_REGION;
        const language = langEl?.value || 'zh';
        const guidance = resolveAsrGuidance(provider, promptEl?.value || '');
        const prompt = guidance.prompt || '';
        const azurePhrases = guidance.azurePhrases || [];
        const providerMeta = CLOUD_PROVIDER_META[provider] || null;

        const showValidationError = (message, focusTarget = null) => {
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = message;
          }
          focusTarget?.focus();
        };

        if (taskMode === 'align' && clips.length !== 1) {
          showValidationError('文本匹配目前一次只能處理一個音訊來源；請只選取一個素材後再試。');
          return;
        }
        if (taskMode === 'align' && transcriptLines.length === 0) {
          showValidationError('請貼上文字稿；每個非空白行會固定建立一條字幕。', transcriptEl);
          return;
        }

        if (providerMeta && !apiKey) {
          showValidationError(`請先輸入 ${providerMeta.name} API Key`, apiKeyEl);
          return;
        }
        if (provider === 'azure' && !/^[a-z][a-z0-9-]{1,62}$/i.test(azureRegion)) {
          showValidationError(`請輸入正確的 Azure Speech Region，例如 ${DEFAULT_AZURE_SPEECH_REGION}`, azureRegionEl);
          return;
        }

        // 儲存設定
        const currentConf = getAsrConfig();
        currentConf.taskMode = taskMode;
        currentConf.provider = provider;
        currentConf.builtinModel = builtinModel;
        if (providerMeta) currentConf[providerMeta.keyField] = apiKey;
        if (provider === 'azure') {
          currentConf.azureRegion = azureRegion.toLowerCase();
          currentConf.azurePhraseList = guidance.azurePhraseList;
        }
        currentConf.language = language;
        if (getAsrGuidanceMeta(provider)?.kind === 'prompt') currentConf.prompt = prompt;
        saveAsrConfig(currentConf);

        const recognitionController = new AbortController();
        const { signal } = recognitionController;
        activeRecognitionController = recognitionController;
        const recognitionIsActive = () => (
          activeRecognitionController === recognitionController && !signal.aborted
        );

        // 進行中只鎖定「開始辨識」；取消必須一直可用。
        if (modalFoot) {
          const startButtons = modalFoot.querySelectorAll('button.primary');
          startButtons.forEach(button => { button.disabled = true; });
        }
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.style.color = 'var(--accent)';
          statusEl.textContent = '正在準備音訊並進行分析…';
        }

        try {
          const results = [];
          let alignmentReviewCount = 0;
          for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            if (statusEl) {
              statusEl.textContent = `[${i + 1}/${clips.length}] 正在萃取「${c.name || '音訊素材'}」之音訊資料…`;
            }
            const audioBuffer = await getClipAudioBuffer(c, { signal });
            if (!recognitionIsActive()) return;
            const inT = Number(c.in) || 0;
            const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (audioBuffer.duration || 0)));

            if (provider === 'builtin' && progressContainer) {
              progressContainer.style.display = 'flex';
            }

            const evidenceSegments = await transcribeAudioStream({
              audioBuffer,
              inT,
              outT,
              provider,
              builtinModel,
              apiKey,
              azureRegion,
              language,
              ...('azurePhrases' in guidance ? { azurePhrases } : {}),
              ...('prompt' in guidance ? { prompt } : {}),
              signal,
              onProgress: (pInfo) => {
                if (!recognitionIsActive()) return;
                if (pInfo.status === 'progress' && typeof pInfo.progress === 'number') {
                  const pct = Math.round(pInfo.progress);
                  progressBar?.classList.remove('indeterminate');
                  if (progressBar) progressBar.style.width = pct + '%';
                  if (progressPercent) progressPercent.textContent = pct + '%';
                  if (progressLabel) progressLabel.textContent = `正在下載 AI 模型檔案 (${pInfo.file || ''})…`;
                } else if (pInfo.status === 'transcribing') {
                  if (progressContainer) progressContainer.style.display = 'flex';
                  const hasMeasuredPercent = Number.isFinite(pInfo.percent) && !pInfo.indeterminate;
                  if (hasMeasuredPercent) {
                    const pct = Math.max(0, Math.min(100, Math.round(pInfo.percent)));
                    progressBar?.classList.remove('indeterminate');
                    if (progressBar) progressBar.style.width = pct + '%';
                    if (progressPercent) progressPercent.textContent = pct + '%';
                  } else {
                    progressBar?.classList.add('indeterminate');
                    if (progressPercent) progressPercent.textContent = '運算中';
                  }
                  if (progressLabel) progressLabel.textContent = pInfo.message || '本機 AI 正在推論…';
                  if (statusEl) statusEl.textContent = `[${i + 1}/${clips.length}] ${pInfo.message || '本機推論中…'}`;
                } else if (pInfo.status === 'ready' || pInfo.status === 'info' || pInfo.status === 'loading' || pInfo.status === 'fallback') {
                  if (progressLabel) progressLabel.textContent = pInfo.message || '模型已就緒，開始本機推論…';
                }
              }
            });
            if (!recognitionIsActive()) return;

            let segments = evidenceSegments;
            if (taskMode === 'align') {
              if (statusEl) statusEl.textContent = '聲音分析完成，正在逐行匹配文字稿時間…';
              const aligned = alignTranscriptToEvidence({
                transcript,
                evidenceSegments
              });
              if (aligned.status !== 'aligned') {
                const unreliableLines = new Set([
                  ...(aligned.summary?.unmatchedLines || []),
                  ...(aligned.summary?.ambiguousLines || [])
                ]);
                const mismatchSummary = unreliableLines.size > 0
                  ? `文字稿有 ${unreliableLines.size}/${transcriptLines.length} 行無法可靠匹配`
                  : '文字稿與聲音的整體相似度不足';
                throw new Error(`${mismatchSummary}，未建立字幕；請確認稿件版本、語言或改用較準確的聲音分析引擎。`);
              }
              alignmentReviewCount += Number(aligned.summary?.reviewCount) || 0;
              segments = aligned.segments;
            }

            results.push({
              clip: c,
              segments
            });
          }

          if (statusEl) {
            statusEl.textContent = taskMode === 'align'
              ? '文本匹配完成，正在寫入專屬字幕軌…'
              : '辨識完成，正在寫入專屬字幕軌…';
          }

          if (!recognitionIsActive()) return;
          const count = insertAsrSubtitles(results, taskMode === 'align' ? {
            trackName: '文本匹配',
            historyLabel: '📝 文本匹配生成字幕'
          } : undefined);
          activeRecognitionController = null;
          closeModal({ committed: true });
          if (taskMode === 'align') {
            const reviewHint = alignmentReviewCount > 0 ? ' 目前為句級估算，請抽查時間碼。' : '';
            showToast(`文本匹配完成！已保留逐行文字稿並生成 ${count} 句時間碼。${reviewHint}`);
          } else {
            showToast(`🎙 語音辨識完成！已新增字幕軌並生成 ${count} 句字幕。`);
          }
        } catch (err) {
          if (signal.aborted || err?.name === 'AbortError' || activeRecognitionController !== recognitionController) {
            return;
          }
          console.error('ASR error:', err);
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = '❌ 辨識失敗：' + (err.message || String(err));
          }
          if (modalFoot) {
            const startButtons = modalFoot.querySelectorAll('button.primary');
            startButtons.forEach(button => { button.disabled = false; });
          }
          activeRecognitionController = null;
        }
      }
    }
  ], { width: '480px', onDismiss: abortActiveRecognition });

  // 監聽 Provider 切換以自動更新介面
  setTimeout(() => {
    const taskModeEl = document.getElementById('asrTaskMode');
    const transcriptRow = document.getElementById('asrTranscriptRow');
    const targetSummary = document.getElementById('asrTargetSummary');
    const providerEl = document.getElementById('asrProvider');
    const apiKeyEl = document.getElementById('asrApiKey');
    const keyLabelEl = document.getElementById('asrKeyLabel');
    const helpEl = document.getElementById('asrKeyHelp');
    const azureRegionRow = document.getElementById('asrAzureRegionRow');
    const promptRowEl = document.getElementById('asrPromptRow');
    const promptEl = document.getElementById('asrPrompt');
    const promptLabelEl = document.getElementById('asrPromptLabel');
    const builtinRow = document.getElementById('asrBuiltinRow');
    const keyRow = document.getElementById('asrKeyRow');

    const updateTaskUI = () => {
      const alignMode = taskModeEl?.value === 'align';
      if (transcriptRow) transcriptRow.style.display = alignMode ? 'flex' : 'none';
      if (targetSummary) targetSummary.value = `自動建立「${alignMode ? '文本匹配' : '語音辨識'}」新軌`;
      const primaryButton = document.querySelector('#modalFoot button.primary');
      if (primaryButton) primaryButton.textContent = alignMode ? '開始匹配' : '🚀 開始辨識';
    };

    if (taskModeEl) {
      taskModeEl.onchange = updateTaskUI;
      updateTaskUI();
    }

    if (providerEl) {
      const updateProviderUI = () => {
        const p = providerEl.value;
        const c = getAsrConfig();
        const meta = CLOUD_PROVIDER_META[p] || null;

        if (builtinRow) builtinRow.style.display = p === 'builtin' ? 'flex' : 'none';
        if (keyRow) keyRow.style.display = meta ? 'flex' : 'none';
        if (azureRegionRow) azureRegionRow.style.display = p === 'azure' ? 'flex' : 'none';
        const guidanceMeta = getAsrGuidanceMeta(p);
        if (promptRowEl) promptRowEl.style.display = guidanceMeta ? 'flex' : 'none';

        if (meta) {
          if (apiKeyEl) apiKeyEl.value = c[meta.keyField] || '';
          if (keyLabelEl) keyLabelEl.textContent = meta.keyLabel;
          if (helpEl) {
            helpEl.textContent = meta.helpLabel;

            helpEl.onclick = (e) => {
              if (e) e.preventDefault();
              const url = meta.helpURL;
              if (IS_DESKTOP && window.subtool?.openExternal) {
                window.subtool.openExternal(url).catch(() => {
                  window.open(url, '_blank');
                });
              } else {
                window.open(url, '_blank');
              }
            };
          }
        }
        if (promptLabelEl) promptLabelEl.textContent = guidanceMeta?.label || '';
        if (promptEl) {
          promptEl.placeholder = guidanceMeta?.placeholder || '';
          promptEl.value = guidanceMeta?.kind === 'phrases'
            ? (c.azurePhraseList || '')
            : (guidanceMeta ? (c.prompt || '') : '');
        }
      };

      providerEl.onchange = updateProviderUI;
      updateProviderUI();
    }
  }, 0);
}

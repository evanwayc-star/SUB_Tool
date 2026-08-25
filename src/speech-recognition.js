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
import { decodeText, downloadBytes, escapeHTML, readFile } from './util.js';
import { alignTranscriptToEvidence, parseTranscriptLines } from './transcript-alignment.js';
import { buildTranscriptAlignmentDiagnostic } from './transcript-alignment-diagnostic.js';
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

const ALL_RECOGNITION_SOURCE_CHANNELS = Object.freeze({ mode: 'all-source-channels' });

function recognitionTrackEntries(clip) {
  return (Array.isArray(clip?.recognitionTracks) ? clip.recognitionTracks : [])
    .map((track, index) => ({
      track,
      sourceStream: Number.isInteger(Number(track?.sourceStream))
        ? Math.max(0, Number(track.sourceStream))
        : index,
      sourceChannel: Number.isInteger(Number(track?.sourceChannel))
        ? Math.max(0, Number(track.sourceChannel))
        : 0,
      inputIndex: index
    }))
    .sort((a, b) => a.sourceStream - b.sourceStream || a.sourceChannel - b.sourceChannel || a.inputIndex - b.inputIndex);
}

function recognitionTrackResourceKey(track) {
  if (track?.buffer) return track.buffer;
  const url = track?.el?.src || track?.audioElement?.src || '';
  if (url) return `url:${url}`;
  if (track?.file) return `file:${track.file}`;
  return null;
}

function independentlySelectableRecognitionEntry(entry, entries) {
  const key = recognitionTrackResourceKey(entry.track);
  if (!key) return false;
  const sharing = entries.filter(candidate => recognitionTrackResourceKey(candidate.track) === key);
  if (sharing.length === 1) return true;
  const buffer = entry.track?.buffer;
  if (!buffer || Number(buffer.numberOfChannels) <= 1) return false;
  const channelIndexes = new Set(sharing.map(candidate => candidate.sourceChannel));
  return channelIndexes.size === sharing.length &&
    [...channelIndexes].every(channel => channel >= 0 && channel < buffer.numberOfChannels);
}

function recognitionAudioEntries(clip) {
  const trackEntries = recognitionTrackEntries(clip);
  if (trackEntries.length) return trackEntries;
  const channelCount = Math.max(0, Math.floor(Number(clip?.audioBuffer?.numberOfChannels) || 0));
  return Array.from({ length: channelCount }, (_, sourceChannel) => ({
    track: null,
    sourceStream: 0,
    sourceChannel,
    inputIndex: sourceChannel
  }));
}

export function getRecognitionAudioSourceChoices(clip) {
  const entries = recognitionAudioEntries(clip);
  if (entries.length <= 1) {
    return [{
      value: 'all',
      label: '全部來源聲道混音',
      selection: ALL_RECOGNITION_SOURCE_CHANNELS
    }];
  }
  const trackEntries = recognitionTrackEntries(clip);
  const selectable = trackEntries.length
    ? entries.filter(entry => independentlySelectableRecognitionEntry(entry, entries))
    : entries;
  const choices = [{
    value: 'all',
    label: `全部來源聲道混音（${entries.length} 軌）`,
    selection: ALL_RECOGNITION_SOURCE_CHANNELS
  }];
  const tail = entries.slice(-2);
  if (entries.length > 2 && tail.every(entry => selectable.includes(entry))) {
    choices.push({
      value: 'tail',
      label: `最後兩軌組（來源聲道 ${entries.length - 1} + ${entries.length}）`,
      selection: {
        mode: 'source-channels',
        channels: tail.map(({ sourceStream, sourceChannel }) => ({ sourceStream, sourceChannel }))
      }
    });
  }
  selectable.forEach(entry => {
    const ordinal = entries.indexOf(entry) + 1;
    choices.push({
      value: `channel-${ordinal}`,
      label: `來源聲道 ${ordinal}`,
      selection: {
        mode: 'source-channels',
        channels: [{ sourceStream: entry.sourceStream, sourceChannel: entry.sourceChannel }]
      }
    });
  });
  return choices;
}

function selectedRecognitionEntries(entries, selection) {
  if (!selection || selection.mode === 'all-source-channels') return entries;
  if (selection.mode !== 'source-channels' || !Array.isArray(selection.channels) || !selection.channels.length) {
    throw new Error('辨識音訊來源設定無效');
  }
  const wanted = new Set(selection.channels.map(channel => `${channel.sourceStream}:${channel.sourceChannel}`));
  const selected = entries.filter(entry => wanted.has(`${entry.sourceStream}:${entry.sourceChannel}`));
  if (selected.length !== wanted.size) throw new Error('選取的來源聲道不存在或尚未就緒');
  return selected;
}

function monoChannelView(audioBuffer, sourceChannel) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') return null;
  const channelCount = Math.max(0, Math.floor(Number(audioBuffer.numberOfChannels) || 0));
  const channel = channelCount === 1 ? 0 : sourceChannel;
  if (channel < 0 || channel >= channelCount) return null;
  return {
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: 1,
    length: audioBuffer.length,
    duration: audioBuffer.duration,
    getChannelData: requested => {
      if (requested !== 0) throw new RangeError('ASR 來源聲道只有一個聲道');
      return audioBuffer.getChannelData(channel);
    }
  };
}

/**
 * 取得指定素材的完整 AudioBuffer
 */
export async function getClipAudioBuffer(clip, {
  decodeAudioData = data => AudioEngine.decodeAudioData(data),
  fetchImpl = (...args) => fetch(...args),
  signal = null,
  recognitionSelection = ALL_RECOGNITION_SOURCE_CHANNELS
} = {}) {
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('語音辨識已取消');
    error.name = 'AbortError';
    throw error;
  };
  throwIfAborted();
  if (clip.audioBuffer) {
    if (recognitionSelection?.mode !== 'source-channels') return clip.audioBuffer;
    const entries = selectedRecognitionEntries(recognitionAudioEntries(clip), recognitionSelection);
    const selectedBuffers = entries
      .map(entry => monoChannelView(clip.audioBuffer, entry.sourceChannel))
      .filter(Boolean);
    const combined = combineRecognitionAudioBuffers(selectedBuffers);
    if (combined) return combined;
    throw new Error('選取的來源聲道不存在或尚未就緒');
  }

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
    const allEntries = recognitionTrackEntries(clip);
    const entries = selectedRecognitionEntries(allEntries, recognitionSelection);
    const selectingChannels = recognitionSelection?.mode === 'source-channels';
    const decoded = [];
    const decodedByResource = new Map();
    const mixedResources = new Set();
    for (const entry of entries) {
      throwIfAborted();
      const track = entry.track;
      const resourceKey = recognitionTrackResourceKey(track);
      let sourceBuffer = resourceKey ? decodedByResource.get(resourceKey) : null;
      if (!sourceBuffer && track?.buffer) sourceBuffer = track.buffer;
      let url = track?.el?.src || track?.audioElement?.src || '';
      if (!url && track?.file && typeof window !== 'undefined' && window.subtool?.fileURL) {
        url = await window.subtool.fileURL(track.file);
        throwIfAborted();
      }
      if (!sourceBuffer && url) sourceBuffer = await decodeURL(url);
      if (!sourceBuffer) {
        if (selectingChannels || clip.preferCache) {
          throw new Error('辨識來源聲道快取仍在準備中，請稍後再辨識');
        }
        continue;
      }
      if (resourceKey) decodedByResource.set(resourceKey, sourceBuffer);
      if (!selectingChannels) {
        const mixedResourceKey = resourceKey || sourceBuffer;
        if (mixedResources.has(mixedResourceKey)) continue;
        mixedResources.add(mixedResourceKey);
        const channelCount = Math.max(0, Math.floor(Number(sourceBuffer.numberOfChannels) || 0));
        for (let sourceChannel = 0; sourceChannel < channelCount; sourceChannel++) {
          const mono = monoChannelView(sourceBuffer, sourceChannel);
          if (mono) decoded.push(mono);
        }
        continue;
      }
      const mono = monoChannelView(sourceBuffer, entry.sourceChannel);
      if (!mono) {
        throw new Error('選取的來源聲道不存在或尚未就緒');
      }
      decoded.push(mono);
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
function hasValidSubtitleTime(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

export function insertAsrSubtitles(results, {
  trackName = '語音辨識',
  historyLabel = '🎙 語音辨識生成字幕',
  requireValidTimes = false,
  allowPartialValidTimes = false,
  preserveUntimedSegments = false,
  onSkippedSegment = null
} = {}) {
  if (!results || results.length === 0) return 0;

  // FPS-SYNC（詳見 FPS_時碼一致性.md）：文本匹配只在寫入時間軸前走唯一影格格網，
  // strict 模式必須在吸附後重新拒絕零長度或重疊 cue，不可自行補成一格。
  const fps = State.fps || 24;
  const dropFrame = State.dropFrame || false;
  const plannedCues = [];

  for (const item of results) {
    const clip = item.clip;
    const segments = item.segments || [];
    const clipStartTimeline = (clip.offset != null ? Number(clip.offset) : Number(clip.start)) || 0;

    for (const seg of segments) {
      if (!seg.text || !seg.text.trim()) continue;
      const planUntimed = () => plannedCues.push({
        start: 0,
        end: 0,
        text: seg.text.trim(),
        style: null,
        timed: false,
        sourceSegment: seg
      });
      if (preserveUntimedSegments && seg.timed === false) {
        planUntimed();
        continue;
      }

      const rawStart = Number(seg.start);
      const rawEnd = Number(seg.end);
      if (requireValidTimes && !hasValidSubtitleTime(rawStart, rawEnd)) {
        if (preserveUntimedSegments) {
          planUntimed();
          onSkippedSegment?.(seg);
          continue;
        }
        if (allowPartialValidTimes) {
          onSkippedSegment?.(seg);
          continue;
        }
        throw new Error('文本匹配包含無效字幕時間，未建立字幕軌');
      }
      const segStart = Number.isFinite(rawStart) ? rawStart : 0;
      const segEnd = Number.isFinite(rawEnd) ? rawEnd : (segStart + 1.5);

      const timelineStartRaw = clipStartTimeline + segStart;
      const timelineEndRaw = clipStartTimeline + segEnd;

      const start = Math.max(0, snapTimeToFrame(timelineStartRaw, fps, dropFrame));
      let end = snapTimeToFrame(timelineEndRaw, fps, dropFrame);
      if (end <= start && !requireValidTimes) {
        end = snapTimeToFrame(start + (1 / fps), fps, dropFrame);
      }
      if (requireValidTimes && end <= start && allowPartialValidTimes) {
        onSkippedSegment?.(seg);
        continue;
      }
      if (requireValidTimes && end <= start && preserveUntimedSegments) {
        planUntimed();
        onSkippedSegment?.(seg);
        continue;
      }

      plannedCues.push({
        start,
        end,
        text: seg.text.trim(),
        style: null,
        timed: true,
        sourceSegment: seg
      });
    }
  }

  if (plannedCues.length === 0) return 0;

  if (requireValidTimes) {
    const ordered = plannedCues
      .filter(cue => cue.timed !== false)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const accepted = [];
    for (let index = 0; index < ordered.length; index++) {
      const cue = ordered[index];
      const previous = (allowPartialValidTimes || preserveUntimedSegments)
        ? accepted.at(-1)
        : ordered[index - 1];
      if (!hasValidSubtitleTime(cue.start, cue.end) || (previous && cue.start < previous.end - 0.000001)) {
        if (preserveUntimedSegments) {
          cue.start = 0;
          cue.end = 0;
          cue.timed = false;
          onSkippedSegment?.(cue.sourceSegment);
          continue;
        }
        if (allowPartialValidTimes) {
          onSkippedSegment?.(cue.sourceSegment);
          continue;
        }
        throw new Error('影格吸附後無法維持有效且不重疊的字幕時間，未建立字幕軌');
      }
      accepted.push(cue);
    }
    if (allowPartialValidTimes) {
      plannedCues.length = 0;
      plannedCues.push(...accepted);
    }
  }

  if (plannedCues.length === 0) return 0;

  const trackObj = newTrack(trackName);
  State.tracks.push(trackObj);
  const trackIdx = State.tracks.length - 1;
  State.listTrack = trackIdx;
  const newCues = plannedCues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    style: cue.style,
    timed: cue.timed !== false,
    id: newId(),
    track: trackIdx
  }));

  State.cues.push(...newCues);
  sortCues();
  setSelection(newCues[0].id);
  syncTrackCount();
  recordHistory(historyLabel);

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
  const recognitionAudioChoices = clips.length === 1
    ? getRecognitionAudioSourceChoices(clips[0])
    : [{ value: 'all', label: '全部來源聲道混音', selection: ALL_RECOGNITION_SOURCE_CHANNELS }];
  const recognitionAudioSelectionByValue = new Map(
    recognitionAudioChoices.map(choice => [choice.value, choice.selection])
  );
  const recognitionAudioOptions = recognitionAudioChoices
    .map(choice => `<option value="${escapeHTML(choice.value)}">${escapeHTML(choice.label)}</option>`)
    .join('');

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

      <div id="asrRecognitionAudioSourceRow" style="display:${recognitionAudioChoices.length > 1 ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">辨識音訊來源：</label>
        <select id="asrRecognitionAudioSource" style="width:100%;">${recognitionAudioOptions}</select>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">預設「全部」會逐來源聲道等權平均成 mono；只影響本次辨識，不改變播放、波形、專案音軌或輸出。</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">生成方式：</label>
        <select id="asrTaskMode" style="width:100%;">
          <option value="transcribe" ${initialTaskMode === 'transcribe' ? 'selected' : ''}>語音辨識（由聲音產生文字與時間碼）</option>
          <option value="align" ${initialTaskMode === 'align' ? 'selected' : ''}>文本匹配（保留逐行文字稿，只匹配時間碼）</option>
        </select>
      </div>

      <div id="asrTranscriptRow" style="display:${initialTaskMode === 'align' ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-dim);">逐行文字稿：</label>
          <button type="button" id="asrImportTranscriptButton" style="padding:4px 9px;font-size:11px;">匯入 TXT</button>
        </div>
        <input type="file" id="asrTranscriptFileInput" accept=".txt,text/plain" hidden>
        <textarea id="asrTranscript" rows="7" placeholder="在此貼上已分行的文字稿…" style="width:100%;resize:vertical;min-height:120px;box-sizing:border-box;line-height:1.5;"></textarea>
        <div id="asrTranscriptFileSummary" style="display:none;font-size:11px;color:var(--accent);"></div>
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
          <option value="onnx-community/whisper-tiny" ${conf.builtinModel === 'onnx-community/whisper-tiny' ? 'selected' : ''}>Whisper Tiny 逐字時間版 (最快；CPU 約 39MB／GPU 約 150MB)</option>
          <option value="onnx-community/whisper-base" ${conf.builtinModel === 'onnx-community/whisper-base' ? 'selected' : ''}>Whisper Base 逐字時間版 (平衡；CPU 約 73MB／GPU 約 290MB)</option>
          <option value="onnx-community/whisper-small" ${conf.builtinModel === 'onnx-community/whisper-small' ? 'selected' : ''}>Whisper Small 逐字時間版 (中文佳；CPU 約 240MB／GPU 約 560MB)</option>
          <option value="onnx-community/whisper-large-v3-turbo" ${conf.builtinModel === 'onnx-community/whisper-large-v3-turbo' ? 'selected' : ''}>Whisper Large v3 Turbo q4 逐字時間版 (速度優先，約 800MB)</option>
        </select>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">
          💡 首次使用特定模型時會自動下載並快取逐字時間版模型；下載量會依 GPU／CPU 執行版本而不同。本機電腦有獨立顯卡時可自動啟用 WebGPU 加速。逐字時間是 Whisper 推估值；文本匹配會保留可靠錨點並標示需要校對的補時行。
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
      <div id="asrAlignmentDiagnostic" style="display:none;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--red);border-radius:5px;background:color-mix(in srgb,var(--red) 8%,transparent);">
        <div id="asrUnreliableLineNumbers" style="font-size:11px;line-height:1.5;color:var(--text);max-height:72px;overflow:auto;"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:10px;line-height:1.4;color:var(--text-faint);">診斷檔含完整稿件與辨識文字／時間；不從素材或設定帶入名稱、路徑、URL、API Key、HTTP 標頭或音訊。文字本身仍可能含敏感內容，分享前請確認。</span>
          <button type="button" id="asrDownloadAlignmentDiagnostic" style="flex:none;padding:4px 9px;font-size:11px;">匯出診斷 JSON</button>
        </div>
      </div>
    </div>
  `;

  let activeRecognitionController = null;
  let latestAlignmentDiagnostic = null;
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
        const recognitionAudioSourceEl = document.getElementById('asrRecognitionAudioSource');
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
        const alignmentDiagnosticEl = document.getElementById('asrAlignmentDiagnostic');
        const unreliableLineNumbersEl = document.getElementById('asrUnreliableLineNumbers');

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
        const recognitionSelection = recognitionAudioSelectionByValue.get(recognitionAudioSourceEl?.value || 'all')
          || ALL_RECOGNITION_SOURCE_CHANNELS;

        const showValidationError = (message, focusTarget = null) => {
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = message;
          }
          focusTarget?.focus();
        };

        latestAlignmentDiagnostic = null;
        if (alignmentDiagnosticEl) {
          alignmentDiagnosticEl.style.display = 'none';
          alignmentDiagnosticEl.style.borderColor = 'var(--red)';
        }
        if (unreliableLineNumbersEl) unreliableLineNumbersEl.textContent = '';

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
          let recoveredAlignmentLineNumbers = [];
          let recoveredEstimatedLineCount = 0;
          let failedAlignmentLineNumbers = [];
          let alignmentProviderFailure = false;
          for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            if (statusEl) {
              statusEl.textContent = `[${i + 1}/${clips.length}] 正在萃取「${c.name || '音訊素材'}」之音訊資料…`;
            }
            const audioBuffer = await getClipAudioBuffer(c, { signal, recognitionSelection });
            if (!recognitionIsActive()) return;
            const inT = Number(c.in) || 0;
            const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (audioBuffer.duration || 0)));

            if (provider === 'builtin' && progressContainer) {
              progressContainer.style.display = 'flex';
            }

            let evidenceSegments;
            try {
              evidenceSegments = await transcribeAudioStream({
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
            } catch (error) {
              if (taskMode !== 'align' || signal.aborted || error?.name === 'AbortError') throw error;
              console.error('文本匹配的聲音分析失敗，改建完整未定時原稿：', error);
              alignmentProviderFailure = true;
              evidenceSegments = [];
            }
            if (!recognitionIsActive()) return;

            let segments = evidenceSegments;
            if (taskMode === 'align') {
              if (statusEl) statusEl.textContent = '聲音分析完成，正在逐行匹配文字稿時間…';
              const aligned = alignTranscriptToEvidence({
                transcript,
                evidenceSegments
              });
              if (aligned.status === 'failed') {
                const unreliableLines = new Set([
                  ...(aligned.summary?.unmatchedLines || []),
                  ...(aligned.summary?.ambiguousLines || []),
                  ...(aligned.summary?.lowCoverageLines || [])
                ]);
                latestAlignmentDiagnostic = buildTranscriptAlignmentDiagnostic({
                  provider,
                  language,
                  audioSelection: recognitionSelection,
                  transcript,
                  evidenceSegments,
                  alignmentResult: aligned
                });
                const lineNumbers = latestAlignmentDiagnostic.unreliableLines
                  .map(line => line.lineNumber);
                if (alignmentDiagnosticEl) alignmentDiagnosticEl.style.display = 'flex';
                if (unreliableLineNumbersEl) {
                  unreliableLineNumbersEl.textContent = lineNumbers.length
                    ? `不可靠行號：第 ${lineNumbers.join('、')} 行`
                    : '未找到可列出的行號；請匯出診斷資料檢查整體相似度。';
                }
                const mismatchSummary = unreliableLines.size > 0
                  ? `文字稿有 ${unreliableLines.size}/${transcriptLines.length} 行無法可靠匹配`
                  : '文字稿與聲音的整體相似度不足';
                failedAlignmentLineNumbers = lineNumbers;
                if (statusEl) statusEl.textContent = `${mismatchSummary}；將保留全部原稿行，無法匹配者使用無時間碼。`;
              }
              if (aligned.status === 'recovered') {
                recoveredEstimatedLineCount = (aligned.summary?.estimatedLines || []).length;
                const reviewIndexes = [...new Set([
                  ...(aligned.segments || []).flatMap((segment, index) => (
                    segment.alignment?.status === 'review' ? [index] : []
                  )),
                  ...(aligned.summary?.estimatedLines || []),
                  ...(aligned.summary?.partialEvidenceLines || []),
                  ...(aligned.summary?.discontinuousEvidenceLines || [])
                ])].sort((a, b) => a - b);
                recoveredAlignmentLineNumbers = reviewIndexes.map(index => index + 1);
                latestAlignmentDiagnostic = buildTranscriptAlignmentDiagnostic({
                  provider,
                  language,
                  audioSelection: recognitionSelection,
                  transcript,
                  evidenceSegments,
                  alignmentResult: aligned
                });
                if (alignmentDiagnosticEl) {
                  alignmentDiagnosticEl.style.display = 'flex';
                  alignmentDiagnosticEl.style.borderColor = 'var(--accent)';
                }
                if (unreliableLineNumbersEl) {
                  unreliableLineNumbersEl.textContent = recoveredAlignmentLineNumbers.length
                    ? `需校對行號：第 ${recoveredAlignmentLineNumbers.join('、')} 行`
                    : '部分時間使用估算，請人工校對。';
                }
              }
              alignmentReviewCount += Number(aligned.summary?.reviewCount) || 0;
              segments = aligned.completeSegments || aligned.segments;
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
          const timelineRejectedLineNumbers = [];
          const count = insertAsrSubtitles(results, taskMode === 'align' ? {
            trackName: '文本匹配',
            historyLabel: '📝 文本匹配生成字幕',
            requireValidTimes: true,
            preserveUntimedSegments: true,
            onSkippedSegment: segment => {
              if (Number.isInteger(segment?.transcriptLineIndex)) {
                timelineRejectedLineNumbers.push(segment.transcriptLineIndex + 1);
              }
            }
          } : undefined);
          if (timelineRejectedLineNumbers.length) {
            failedAlignmentLineNumbers = [...new Set([
              ...failedAlignmentLineNumbers,
              ...timelineRejectedLineNumbers
            ])].sort((a, b) => a - b);
            if (unreliableLineNumbersEl) {
              unreliableLineNumbersEl.textContent = `無時間碼行號：第 ${failedAlignmentLineNumbers.join('、')} 行`;
            }
          }
          activeRecognitionController = null;
          const partialAlignment = taskMode === 'align' && failedAlignmentLineNumbers.length > 0;
          const recoveredAlignment = taskMode === 'align' && recoveredAlignmentLineNumbers.length > 0;
          const alignmentNeedsReview = partialAlignment || recoveredAlignment;
          if (!alignmentNeedsReview) closeModal({ committed: true });
          if (taskMode === 'align') {
            if (partialAlignment) {
              if (unreliableLineNumbersEl) {
                unreliableLineNumbersEl.textContent = `無時間碼行號：第 ${failedAlignmentLineNumbers.join('、')} 行`;
              }
              if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--accent)';
                statusEl.textContent = `${alignmentProviderFailure ? '聲音分析失敗，但' : ''}已建立 ${count} 句完整原稿；其中 ${failedAlignmentLineNumbers.length} 句無時間碼，請依上方行號自行補上 In／Out。`;
              }
              if (modalFoot) {
                const buttons = [...modalFoot.querySelectorAll('button')];
                const closeButton = buttons.find(button => !button.classList.contains('primary'));
                const primaryButton = buttons.find(button => button.classList.contains('primary'));
                if (closeButton) closeButton.textContent = '關閉';
                if (primaryButton) {
                  primaryButton.disabled = true;
                  primaryButton.dataset.alignmentCommitted = 'true';
                  primaryButton.textContent = '已建立完整原稿';
                }
              }
              showToast(`文本匹配已建立 ${count} 句完整原稿；${failedAlignmentLineNumbers.length} 句為無時間碼。`);
            } else if (recoveredAlignment) {
              const estimatedMessage = recoveredEstimatedLineCount > 0
                ? `${recoveredEstimatedLineCount} 行使用推估時間`
                : '沒有整行使用推估時間';
              if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--accent)';
                statusEl.textContent = `已建立 ${count} 句完整初稿；${estimatedMessage}，共 ${recoveredAlignmentLineNumbers.length} 行需人工校對，這不是精準對齊。`;
              }
              if (modalFoot) {
                const buttons = [...modalFoot.querySelectorAll('button')];
                const closeButton = buttons.find(button => !button.classList.contains('primary'));
                const primaryButton = buttons.find(button => button.classList.contains('primary'));
                if (closeButton) closeButton.textContent = '關閉';
                if (primaryButton) {
                  primaryButton.disabled = true;
                  primaryButton.dataset.alignmentCommitted = 'true';
                  primaryButton.textContent = '已建立';
                }
              }
              showToast(`文本匹配已生成 ${count} 句完整初稿；其中 ${recoveredAlignmentLineNumbers.length} 行需人工校對。`);
            } else {
              const reviewHint = alignmentReviewCount > 0 ? ' 目前為句級估算，請抽查時間碼。' : '';
              showToast(`文本匹配完成！已保留逐行文字稿並生成 ${count} 句時間碼。${reviewHint}`);
            }
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
    const transcriptEl = document.getElementById('asrTranscript');
    const transcriptFileInput = document.getElementById('asrTranscriptFileInput');
    const importTranscriptButton = document.getElementById('asrImportTranscriptButton');
    const transcriptFileSummary = document.getElementById('asrTranscriptFileSummary');
    const statusEl = document.getElementById('asrStatus');
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
    const downloadAlignmentDiagnostic = document.getElementById('asrDownloadAlignmentDiagnostic');

    if (downloadAlignmentDiagnostic) {
      downloadAlignmentDiagnostic.onclick = () => {
        if (!latestAlignmentDiagnostic) return;
        const timestamp = latestAlignmentDiagnostic.generatedAt
          .replace(/[:.]/gu, '-')
          .replace('T', '_')
          .replace(/Z$/u, '');
        const bytes = new TextEncoder().encode(`${JSON.stringify(latestAlignmentDiagnostic, null, 2)}\n`);
        downloadBytes(bytes, `SUBTool_文本匹配診斷_${timestamp}.json`, 'application/json');
      };
    }

    const updateTaskUI = () => {
      const alignMode = taskModeEl?.value === 'align';
      if (transcriptRow) transcriptRow.style.display = alignMode ? 'flex' : 'none';
      if (targetSummary) targetSummary.value = `自動建立「${alignMode ? '文本匹配' : '語音辨識'}」新軌`;
      const primaryButton = document.querySelector('#modalFoot button.primary');
      if (primaryButton && primaryButton.dataset.alignmentCommitted !== 'true') {
        primaryButton.textContent = alignMode ? '開始匹配' : '🚀 開始辨識';
      }
    };

    if (taskModeEl) {
      taskModeEl.onchange = updateTaskUI;
      updateTaskUI();
    }

    if (importTranscriptButton && transcriptFileInput && transcriptEl) {
      const showTranscriptImportError = message => {
        if (!statusEl) return;
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = message;
      };
      transcriptEl.addEventListener('input', () => {
        if (!transcriptFileSummary) return;
        transcriptFileSummary.style.display = 'none';
        transcriptFileSummary.textContent = '';
      });
      importTranscriptButton.onclick = () => {
        transcriptFileInput.value = '';
        transcriptFileInput.click();
      };
      transcriptFileInput.onchange = async () => {
        const file = transcriptFileInput.files?.[0];
        if (!file) return;
        if (!/\.txt$/i.test(file.name || '')) {
          showTranscriptImportError('請選擇 .txt 純文字檔案。');
          return;
        }
        importTranscriptButton.disabled = true;
        if (transcriptFileSummary) {
          transcriptFileSummary.style.display = 'block';
          transcriptFileSummary.textContent = `正在讀取 ${file.name}…`;
        }
        try {
          const text = decodeText(await readFile(file));
          if (!document.contains(transcriptEl)) return;
          transcriptEl.value = text;
          const lineCount = parseTranscriptLines(text).length;
          if (transcriptFileSummary) {
            transcriptFileSummary.textContent = `${file.name} · ${lineCount} 行`;
          }
          if (statusEl) {
            statusEl.style.display = 'none';
            statusEl.textContent = '';
          }
        } catch (error) {
          if (!document.contains(transcriptEl)) return;
          if (transcriptFileSummary) transcriptFileSummary.style.display = 'none';
          showTranscriptImportError(`無法匯入文字稿：${error?.message || String(error)}`);
        } finally {
          importTranscriptButton.disabled = false;
        }
      };
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

/* ==============================================================================
   SUB Tool — Speech Recognition UI Module (src/speech-recognition.js)
   ==============================================================================
   語音辨識／逐行文本匹配使用者介面（UI Modal）與時間軸字幕軌生成協調器。
   推論核心由 src/speech-recognition-engine.js 提供，本模組專注於：
   1. 互動式對話框表單（引擎、API Key、語言與文字稿）
   2. 進度條回饋與狀態提示
   3. 辨識結果或固定逐行文字稿轉為標準時間軸字幕軌（Subtitle Track / Cues）
   ============================================================================== */
import { State, newTrack, syncTrackCount, newId, setSelection, IS_DESKTOP } from './state.js';
import { AudioEngine } from './audio-engine.js';
import { createRecognitionRangeSource } from './speech-recognition-source.js';
import { openSpeechWaveSource } from './speech-wave-source.js';
import { recognitionCheckpoints } from './speech-recognition-checkpoints.js';
import { storedSpeechKey } from './speech-cloud.js';
import { sourcePresentationMetadata } from './decode/source-frame-index.js';
import { resolveRecognitionRange, sliceRecognitionClip, getRecognitionClipRange } from './recognition-range.js';
import { openRecognitionReview, stageRecognitionReview } from './recognition-review.js';
import { normalizeRecognitionTerms } from './recognition-terms.js';
import { normalizeRecognitionEvidence, attachAlignmentEvidence } from './recognition-evidence.js';
import { createProjectAudioInterpretation } from './project-audio.js';
import { isStillClip } from '../shared/clip-visual.cjs';
import { audioMotherPath } from '../shared/audio-loudness.cjs';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { getExactFps, snapTimeToFrame, secToEncore } from './time.js';
import { sortCues, hasActiveCueEdit, extendDurationForCues } from './subtitle-model.js';
import { recordHistory } from './history.js';
import { Project } from './project.js';
import { openModal, closeModal, showToast, setStatus } from './ui.js';
import { emit } from './events.js';
import { decodeText, downloadBytes, escapeHTML, readFile, encodeUTF16LE } from './util.js';
import { parseTranscriptLines, buildTranscriptAlignmentDiagnostic } from './transcript-alignment.js';
import { matchRecognitionTranscript } from './transcript-alignment-client.js';
import {
  getAsrSession,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  onAsrSessionChange,
  clearAsrSession,
  startAsrWork
} from './speech-recognition-session.js';
import {
  DEFAULT_AZURE_SPEECH_REGION,
  isAzureSpeechRegion,
  parseAzureSpeechCredential,
  combineRecognitionAudioBuffers,
  encodeWav16kMono,
  transcribeAudioStream
} from './speech-recognition-engine.js';

export {
  getAsrSession,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  onAsrSessionChange,
  clearAsrSession,
  startAsrWork
};

const ASR_CONFIG_KEY = 'subtool_asr_config';
const providerTimingAvailable = () => Date.now() < Date.UTC(2027, 1, 26);
const ASR_PROVIDER_UI_META = Object.freeze({
  builtin: {
    badge: '本機離線',
    speechHint: '使用 Whisper Large v3 在這台電腦上處理音訊；首次使用會下載模型。',
    hint: '使用 Whisper Large v3 Turbo 在這台電腦上取得逐字時間。首次使用會下載模型。'
  },
  groq: {
    badge: '高速雲端',
    hint: '使用 Whisper large-v3；本次所選音訊會傳送至 Groq 進行辨識。'
  },
  openai: {
    badge: '雲端辨識',
    speechHint: '使用 GPT-4o 語音辨識與片段時間碼；本次所選音訊會傳送至 OpenAI。',
    hint: '使用 Whisper-1 取得字幕文字與逐字時間；本次所選音訊會傳送至 OpenAI。'
  },
  azure: {
    badge: '專業雲端',
    hint: '新金鑰預設使用 japaneast。其他區域可在 API Key 欄填入「區域:金鑰」，例如 eastus:…。'
  },
  google: {
    badge: '專用語音辨識',
    hint: '使用 Gemini 3.5 Transcribe 辨識原文與逐字時間；完成後仍可抽查字幕邊界。'
  },
  elevenlabs: {
    badge: '高精準雲端',
    hint: '使用 Scribe v3 辨識多語言對話與逐字時間。'
  }
});

const ASR_ICONS = Object.freeze({
  source: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10m4-13v16m4-12v8m4-5v2"/></svg>',
  mode: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v5H5zM5 15h6v5H5zm10 0h4v5h-4z"/></svg>',
  transcript: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16H6zM9 8h6m-6 4h6m-6 4h4"/></svg>',
  engine: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V7l3-1z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  progress: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 8-8M4 4v6h6"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg>'
});

function asrIcon(name) {
  return `<span class="asr-section-icon">${ASR_ICONS[name] || ASR_ICONS.info}</span>`;
}
export const CLOUD_PROVIDER_META = Object.freeze({
  google: Object.freeze({ keyField: 'googleApiKey', name: 'Google Gemini', keyLabel: 'Google Gemini API Key：', helpLabel: '取得 Google 免費 API Key ↗', helpURL: 'https://aistudio.google.com/app/apikey' }),
  azure: Object.freeze({ keyField: 'azureApiKey', name: 'Azure Speech', keyLabel: 'Azure Speech API Key：', helpLabel: '建立 Azure Speech 資源 ↗', helpURL: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices' }),
  groq: Object.freeze({ keyField: 'groqApiKey', name: 'Groq', keyLabel: 'Groq API Key：', helpLabel: '取得 Groq 免費 API Key ↗', helpURL: 'https://console.groq.com/keys' }),
  openai: Object.freeze({ keyField: 'openaiApiKey', name: 'OpenAI', keyLabel: 'OpenAI API Key：', helpLabel: '取得 OpenAI API Key ↗', helpURL: 'https://platform.openai.com/api-keys' }),
  elevenlabs: Object.freeze({ keyField: 'elevenlabsApiKey', name: 'ElevenLabs', keyLabel: 'ElevenLabs API Key：', helpLabel: '取得 ElevenLabs API Key ↗', helpURL: 'https://elevenlabs.io/app/settings/api-keys' })
});

const ASR_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko']);

function asrLanguage(value) {
  return ASR_LANGUAGES.has(value) ? value : 'auto';
}

let tabSpeechKeys = {};
function storedAsrPreferences() {
  try { return JSON.parse(localStorage.getItem(ASR_CONFIG_KEY)) || {}; }
  catch { return {}; }
}
async function loadDesktopCredentials(bridge) {
  const old = storedAsrPreferences();
  const status = await bridge.speechKeyStatus();
  const keys = {};
  for (const [provider, {keyField}] of Object.entries(CLOUD_PROVIDER_META)) {
    if (old[keyField] && !status[provider]) keys[provider] = old[keyField];
  }
  const ready = Object.keys(keys).length ? await bridge.saveSpeechKeys(keys) : status;
  const latest = storedAsrPreferences();
  let migrated = false;
  for (const [provider, {keyField}] of Object.entries(CLOUD_PROVIDER_META)) {
    if (old[keyField] && latest[keyField] === old[keyField] && ready[provider]) {
      delete latest[keyField];
      migrated = true;
    }
  }
  if (migrated) localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(latest));
  return ready;
}
export function getAsrConfig() {
  const saved = storedAsrPreferences();
  const desktop = !!globalThis.window?.subtool?.speechKeyStatus;
  if (!desktop) {
    let migrated = false;
    for (const {keyField} of Object.values(CLOUD_PROVIDER_META)) {
      if (!saved[keyField]) continue;
      tabSpeechKeys[keyField] = saved[keyField];
      delete saved[keyField];
      migrated = true;
    }
    if (migrated) {
      try { localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(saved)); } catch { /* still usable this session */ }
    }
  }
  const taskMode = saved.taskMode === 'align' ? 'align' : 'transcribe';
  // Older versions stored zh even when the user had never chosen a language.
  const legacyLanguage = saved.language === 'zh' ? 'auto' : asrLanguage(saved.language);
  const legacyAlignment = taskMode === 'align' || saved.speechLanguage ? legacyLanguage : 'auto';
  return {
    taskMode,
    openaiTiming:saved.openaiTiming === 'local' || !providerTimingAvailable() ? 'local' : 'provider',
    provider: Object.hasOwn(ASR_PROVIDER_UI_META, saved.provider) ? saved.provider : 'google',
    alignmentLanguage: asrLanguage(saved.alignmentLanguage ?? legacyAlignment),
    speechLanguage: asrLanguage(saved.speechLanguage ?? (taskMode === 'transcribe' ? legacyLanguage : 'auto')),
    ...Object.fromEntries(Object.values(CLOUD_PROVIDER_META).map(({keyField}) => [keyField, desktop ? '' : tabSpeechKeys[keyField] || ''])),
    azureRegion: saved.azureRegion || DEFAULT_AZURE_SPEECH_REGION
  };
}

/**
 * 儲存 ASR 設定
 */
export function saveAsrConfig(conf) {
  const preferences = { ...conf };
  const desktop = !!globalThis.window?.subtool?.speechKeyStatus;
  const old = desktop ? storedAsrPreferences() : {};
  tabSpeechKeys = {};
  for (const {keyField} of Object.values(CLOUD_PROVIDER_META)) {
    if (!desktop && preferences[keyField]) tabSpeechKeys[keyField] = preferences[keyField];
    delete preferences[keyField];
    if (desktop && old[keyField]) preferences[keyField] = old[keyField]; // Pending legacy migration.
  }
  try {
    localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(preferences));
  } catch (_) {}
}

const ALL_RECOGNITION_SOURCE_CHANNELS = Object.freeze({ mode: 'all-source-channels' });

// Every caller supplies a source, not playback-track knowledge. Resolve again
// when accepting work so caches completed after opening the dialog are included.
function captureRecognitionSource(source, interpretation = null) {
  const runtimeSource=source.audioSrc||source.source||(source.primary?'video':source.id?'clip:'+source.id:null);
  const live=(Media.tracks||[]).filter(track=>source.audioSourceId
    ? track.audioSourceId===source.audioSourceId
    : runtimeSource&&(track.source||'video')===runtimeSource);
  let tracks=live.length?live:(Array.isArray(source.recognitionTracks)?source.recognitionTracks:[]);
  let recognitionSelection;
  if (interpretation) {
    if (!tracks.length) {
      tracks = State.audioProject?.sourceMaps?.[source.audioSourceId]?.channels || [];
      if (source.muted || interpretation.anySourceSolo) return null;
    }
    if (tracks.length) {
      const entries = recognitionTrackEntries({ recognitionTracks:tracks });
      const audible = entries.filter(({ track, sourceStream, sourceChannel }) => interpretation.trackState({
        ...track, audioSourceId:source.audioSourceId || track.audioSourceId, sourceStream, sourceChannel
      }, { respectHidden:false }).audible);
      if (!audible.length) return null;
      if (audible.length < entries.length) recognitionSelection = {
        mode:'source-channels', channels:audible.map(({ sourceStream, sourceChannel }) => ({ sourceStream, sourceChannel }))
      };
    }
  }
  const master = interpretation ? audioMotherPath(source) : source.path;
  const replacingProxy = master && master !== source.path && !source.preferCache;
  return {...source,
    ...(replacingProxy ? { path:master, web:null } : {}),
    ...(recognitionSelection ? { recognitionSelection } : {}),
    ...(source.audioElement?{audioElement:{src:source.audioElement.currentSrc||source.audioElement.src||''}}:{}),
    recognitionTracks:tracks.map(track=>({
    sourceStream:track.sourceStream,sourceChannel:track.sourceChannel,
    buffer:track.buffer,file:replacingProxy && !track._audioEffect && track.file === source.path ? master : track.file,
    _audioEffect:track._audioEffect,
    // Playback may dispose or replace an element while another source in this
    // accepted work is being analyzed. Its accepted URL remains source evidence.
    ...(track.el?{el:{src:track.el.currentSrc||track.el.src||''}}:{}),
    ...(track.audioElement?{audioElement:{src:track.audioElement.currentSrc||track.audioElement.src||''}}:{}),
  }))};
}

function recognitionRangePlan(mode, selected) {
  if (mode === 'clip') return { clips:selected.map(source => captureRecognitionSource(source)) };
  const liveExternalSources = Media.externalAudioSources || [];
  const range = resolveRecognitionRange(mode, State, { liveExternalSources, pendingClips:Project.unrestoredClips?.() || [] });
  if (range.error) return { clips:[], range, error:range.error };
  const external = new Map();
  for (const source of [...(State.externalAudioState || []), ...liveExternalSources]) {
    external.set(source.audioSourceId || source.id, source);
  }
  const externalSources = [...external.values()];
  const interpretation = createProjectAudioInterpretation({
    audioProject:State.audioProject, mediaTracks:Media.tracks, externalSources
  });
  const placements = [
    ...(State.clips || []).filter(source => !source.audioDetached && !isStillClip(source)),
    ...externalSources.filter(source => source.enabled !== false && Number(source.gain ?? 1) > 0)
  ];
  const clips = placements.map(source => sliceRecognitionClip(source, range)).filter(Boolean)
    .map(source => captureRecognitionSource(source, interpretation)).filter(Boolean)
    .sort((a, b) => a.offset - b.offset);
  return { clips, range, error:clips.length ? '' : '這個辨識範圍內沒有可辨識的音訊。' };
}

function retainRecognitionSources(clips){
  const urls=[];
  for(const clip of clips){
    urls.push(clip.web?.url,clip.audioElement?.src,clip.src,typeof clip.file==='string'?clip.file:null);
    for(const track of clip.recognitionTracks||[]){
      urls.push(track.el?.src,track.audioElement?.src,typeof track.file==='string'?track.file:null);
    }
  }
  return Media.retainObjectURLs?.(urls.filter(Boolean))||(()=>{});
}

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
  return AudioEngine.inheritSourceAudioClock(audioBuffer, {
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: 1,
    length: audioBuffer.length,
    duration: audioBuffer.duration,
    getChannelData: requested => {
      if (requested !== 0) throw new RangeError('ASR 來源聲道只有一個聲道');
      return audioBuffer.getChannelData(channel);
    }
  });
}

/**
 * 取得指定素材的完整 AudioBuffer
 */
export async function getClipAudioBuffer(clip, {
  decodeAudioData = data => AudioEngine.decodeAudioData(data),
  fetchImpl = (...args) => fetch(...args),
  signal = null,
  owns = () => true,
  recognitionSelection = ALL_RECOGNITION_SOURCE_CHANNELS
} = {}) {
  const throwIfAborted = () => {
    if (!signal?.aborted && owns()) return;
    if (typeof signal?.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('語音辨識已取消');
    error.name = 'AbortError';
    throw error;
  };
  throwIfAborted();
  const file = clip.file || clip._file || clip.blob;
  const sourceFile = typeof file?.slice === 'function' && typeof URL.createObjectURL === 'function' ? file : null;
  const normalizeOriginal = async (buffer, { url = clip.web?.url || clip.audioElement?.src || clip.src,
    sourceStream = 0, processed = false } = {}) => {
    throwIfAborted();
    url ||= clip.web?.url || clip.audioElement?.src || clip.src;
    if (!processed && !url && !sourceFile && clip.path && typeof window !== 'undefined' && window.subtool?.fileURL) {
      url = await window.subtool.fileURL(clip.path);
      throwIfAborted();
    }
    // Native channel caches and effect WAVs already begin at source zero.
    // Original decoded Mono tracks inherit the AudioEngine clock proof.
    const normalized = processed ? AudioEngine.markSourceAudioBuffer(buffer)
      : await AudioEngine.normalizeSourceAudioBuffer(buffer, { url, file: sourceFile, sourceStream,
        signal, owns: () => !signal?.aborted && owns() });
    throwIfAborted();
    return normalized;
  };
  const processedTrack = track => clip.preferCache || track?._audioEffect
    || (typeof track?.file === 'string' && track.file !== clip.path && track.file !== clip.web?.url);
  const fromOriginal = async () => {
    if (file && typeof file.arrayBuffer === 'function') {
      const data = await file.arrayBuffer();
      throwIfAborted();
      const decoded = await decodeAudioData(data);
      throwIfAborted();
      return normalizeOriginal(decoded);
    }
    const url = clip.web?.url || (clip.path && await globalThis.window?.subtool?.fileURL?.(clip.path));
    throwIfAborted();
    if (url) return decodeURL(url);
    throw new Error(`無法載入素材「${clip.name || clip.id}」的音訊資料`);
  };
  if (clip.audioBuffer) {
    const buffer = await normalizeOriginal(clip.audioBuffer, { processed: clip.preferCache });
    if (recognitionSelection?.mode !== 'source-channels') return buffer;
    const entries = selectedRecognitionEntries(recognitionAudioEntries(clip), recognitionSelection);
    const selectedBuffers = entries
      .map(entry => monoChannelView(buffer, entry.sourceChannel))
      .filter(Boolean);
    const combined = combineRecognitionAudioBuffers(selectedBuffers);
    if (combined) return combined;
    throw new Error('選取的來源聲道不存在或尚未就緒');
  }

  const decodeURL = async (url, options = {}) => {
    throwIfAborted();
    const response = signal ? await fetchImpl(url, { signal }) : await fetchImpl(url);
    if (response?.ok === false) throw new Error(`無法讀取素材音訊 (HTTP ${response.status})`);
    const data = await response.arrayBuffer();
    throwIfAborted();
    const decoded = await decodeAudioData(data);
    throwIfAborted();
    return normalizeOriginal(decoded, { url, ...options });
  };

  const recognitionTracks = Array.isArray(clip.recognitionTracks) ? clip.recognitionTracks : [];
  let originalAudio;
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
      const processed = !!processedTrack(track);
      const stream = processed ? 0 : entry.sourceStream;
      let sourceBuffer = resourceKey ? decodedByResource.get(resourceKey)?.get(stream) : null;
      let url = track?.el?.src || track?.audioElement?.src || '';
      if (!url && track?.file && typeof window !== 'undefined' && window.subtool?.fileURL) {
        url = await window.subtool.fileURL(track.file);
        throwIfAborted();
      }
      if (!sourceBuffer && track?.buffer) sourceBuffer = await normalizeOriginal(track.buffer,
        { url, sourceStream: stream, processed });
      if (!sourceBuffer && url) sourceBuffer = await decodeURL(url, { sourceStream: stream, processed });
      if (!sourceBuffer && selectingChannels && !processed && entry.sourceStream === 0) {
        originalAudio ||= await fromOriginal();
        sourceBuffer = originalAudio;
      }
      if (!sourceBuffer) {
        if (selectingChannels || clip.preferCache) {
          throw new Error('辨識來源聲道快取仍在準備中，請稍後再辨識');
        }
        continue;
      }
      if (resourceKey) {
        if (!decodedByResource.has(resourceKey)) decodedByResource.set(resourceKey, new Map());
        decodedByResource.get(resourceKey).set(stream, sourceBuffer);
      }
      if (!selectingChannels) {
        const mixedResourceKey = sourceBuffer;
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

  return fromOriginal();
}

/** Desktop reads bounded, source-local PCM; browsers retain their decoder. */
export async function getClipRecognitionSource(clip, options = {}) {
  const bridge = typeof window !== 'undefined' ? window.subtool : null;
  if (typeof bridge?.speechAudioRead !== 'function' || typeof bridge?.speechAudioCancel !== 'function') {
    try {
      const tracks=clip.recognitionTracks||[];
      const original=clip.file||clip._file||clip.blob||tracks.find(track=>typeof track.file?.slice==='function')?.file;
      if(!clip.preferCache&&!clip.audioBuffer&&tracks.every(track=>!track.buffer&&!track._audioEffect&&(!track.file||track.file===original))){
        const bounded=await openSpeechWaveSource(original,options);
        if(bounded)return bounded;
      }
      return await getClipAudioBuffer(clip, options);
    } catch (error) {
      // Web Audio reports the same decoding failure for a silent video and a
      // broken audio stream. A parsed MP4/WebM track list distinguishes them.
      if (!options.skipSilentVideo || error?.name !== 'EncodingError' || !clip.web?.url) throw error;
      const owns = () => !options.signal?.aborted && options.owns?.() !== false;
      const metadata = await sourcePresentationMetadata(clip.web.url, { owns });
      if (!owns()) throw new DOMException('語音辨識已取消', 'AbortError');
      if (metadata && !metadata.audioPresentationTimestampOffsets?.length) return null;
      throw error;
    }
  }
  const { signal, owns = () => true, recognitionSelection = ALL_RECOGNITION_SOURCE_CHANNELS } = options;
  const assertCurrent = () => {
    if (signal?.aborted || !owns()) throw new DOMException('語音辨識已取消', 'AbortError');
  };
  assertCurrent();
  // Copy mutable descriptors before the first asynchronous metadata read.
  const accepted = { ...clip, ...(clip.web ? { web: { ...clip.web } } : {}),
    ...(clip.audioElement ? { audioElement: { src: clip.audioElement.src } } : {}),
    recognitionTracks: (clip.recognitionTracks || []).map(track => ({ ...track,
    ...(track.el ? { el: { src: track.el.src } } : {}),
    ...(track.audioElement ? { audioElement: { src: track.audioElement.src } } : {})
  })) };
  const selection = recognitionSelection?.mode === 'source-channels'
    ? { mode: recognitionSelection.mode, channels: recognitionSelection.channels?.map(channel => ({ ...channel })) }
    : recognitionSelection;
  const selecting = selection?.mode === 'source-channels';
  const inputs = [], buffers = new Map(), nativeResources = new Set();
  const file = accepted.file || accepted._file || accepted.blob;
  const sourceFile = typeof file?.slice === 'function' ? file : null;
  const originalPath = accepted.path || (sourceFile ? bridge.getFilePath?.(sourceFile) : null);
  // Whole-timeline work may include a video-only file between spoken clips.
  let originalStreams;
  if (!accepted.audioBuffer && !accepted.recognitionTracks.length && originalPath && !accepted.preferCache && bridge.probe) {
    const info = await bridge.probe(originalPath);
    assertCurrent();
    if (Array.isArray(info?.audio) && !info.audio.length) {
      if(options.skipSilentVideo)return null;
      throw new Error('選取的素材沒有可辨識的音訊串流');
    }
    originalStreams = info?.audio;
  }
  const addBuffer = async (buffer, channel, { processed = false, sourceStream = 0, url } = {}) => {
    const clockKey = `${processed}:${sourceStream}`;
    let clock = buffers.get(buffer)?.get(clockKey);
    if (!clock) {
      url ||= accepted.web?.url || accepted.audioElement?.src || accepted.src;
      if (!processed && !url && !sourceFile && originalPath && bridge.fileURL) {
        url = await bridge.fileURL(originalPath); assertCurrent();
      }
      clock = await AudioEngine.getSourceAudioBufferClock(buffer, { processed, sourceStream, url, file: sourceFile, signal, owns });
      assertCurrent();
      if (!buffers.has(buffer)) buffers.set(buffer, new Map());
      buffers.get(buffer).set(clockKey, clock);
    }
    const channels = selecting ? [buffer.numberOfChannels === 1 ? 0 : channel]
      : Array.from({ length: buffer.numberOfChannels }, (_, index) => index);
    for (const selected of channels) {
      if (!Number.isInteger(selected) || selected < 0 || selected >= buffer.numberOfChannels) throw new Error('選取的來源聲道不存在或尚未就緒');
      if (!selecting && inputs.some(input => input.buffer === buffer && input.channel === selected
        && input.clock.shiftSamples === clock.shiftSamples && input.clock.length === clock.length)) continue;
      inputs.push({ buffer, channel: selected, clock });
    }
  };
  const addNative = (path, sourceStream, sourceChannel, processed, weight = 1) => {
    const key = JSON.stringify([path, sourceStream, sourceChannel]);
    if (!selecting && nativeResources.has(key)) return;
    nativeResources.add(key);
    inputs.push({ request: { path, sourceStream, sourceChannel, processed }, weight });
  };
  if (accepted.audioBuffer) {
    if (selecting) {
      for (const entry of selectedRecognitionEntries(recognitionAudioEntries(accepted), selection)) {
        await addBuffer(accepted.audioBuffer, entry.sourceChannel, { processed: !!accepted.preferCache });
      }
    } else await addBuffer(accepted.audioBuffer, 0, { processed: !!accepted.preferCache });
  } else {
    const allEntries = recognitionTrackEntries(accepted);
    const entries = selectedRecognitionEntries(allEntries, selection);
    for (const entry of entries) {
      const track = entry.track;
      const processed = !!(accepted.preferCache || track._audioEffect
        || (typeof track.file === 'string' && track.file !== originalPath && track.file !== accepted.web?.url));
      if (track.buffer) {
        await addBuffer(track.buffer, entry.sourceChannel, { processed, sourceStream: processed ? 0 : entry.sourceStream,
          url: track.el?.src || track.audioElement?.src });
        continue;
      }
      const path = typeof track.file === 'string' ? track.file : processed ? null : originalPath;
      if (!path) throw new Error('辨識來源聲道快取仍在準備中，請稍後再辨識');
      if (processed) {
        // Intake caches are split mono; effects preserve a whole stream.
        const count = track._audioEffect ? Math.max(...allEntries.filter(candidate => candidate.track.file === path)
          .map(candidate => candidate.sourceChannel)) + 1 : 1;
        addNative(path, 0, selecting ? (count === 1 ? 0 : entry.sourceChannel) : null, true, selecting ? 1 : count);
      } else addNative(path, entry.sourceStream, entry.sourceChannel, false);
    }
    if (!inputs.length) {
      if (accepted.preferCache) throw new Error('素材音訊快取仍在準備中，請稍後再辨識');
      if (!originalPath) throw new Error('無法取得辨識素材的本機音訊來源');
      if (Array.isArray(originalStreams) && originalStreams.length) {
        originalStreams.forEach((stream, index) => addNative(originalPath, index, null, false, Number(stream.channels) || 1));
      } else addNative(originalPath, 0, null, false);
    }
  }
  assertCurrent();
  const bufferDuration = Math.max(0, ...inputs.map(input => input.clock?.duration || 0));
  const declaredDuration = Number(accepted.duration) > 0 ? Number(accepted.duration)
    : Number(accepted.out) > 0 ? Number(accepted.out) : 0;
  const duration = Math.max(bufferDuration, declaredDuration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('無法確認辨識素材的來源片長');
  return createRecognitionRangeSource({ duration, inputs, bridge, signal, owns });
}

/**
 * 將辨識結果結構轉換為字幕軌並加入時間軸
 */
function hasValidSubtitleTime(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function downloadAlignmentDiagnostic(diagnostic) {
  if (!diagnostic) return false;
  const timestamp = String(diagnostic.generatedAt || new Date().toISOString())
    .replace(/[:.]/gu, '-')
    .replace('T', '_')
    .replace(/Z$/u, '');
  const bytes = encodeUTF16LE(`${JSON.stringify(diagnostic, null, 2)}\n`);
  downloadBytes(bytes, `SUBTool_文本匹配診斷_${timestamp}.json`, 'application/json;charset=utf-16le');
  return true;
}

export function insertAsrSubtitles(results, {
  trackName = '語音辨識',
  trackNameForSegment = null,
  historyLabel = '🎙 語音辨識生成字幕',
  requireValidTimes = false,
  allowPartialValidTimes = false,
  allowOverlap = false,
  preserveUntimedSegments = false,
  recognition = null,
  preserveSelection = false,
  boundToPlacement = false,
  onSkippedSegment = null,
  timelineFps = State.fps || 24,
  timelineDropFrame = State.dropFrame || false
} = {}) {
  if (!results || results.length === 0) return 0;

  // FPS-SYNC（詳見 FPS_時碼一致性.md）：文本匹配只在寫入時間軸前走唯一影格格網，
  // strict 模式必須在吸附後重新拒絕零長度或重疊 cue，不可自行補成一格。
  const fps = Number(timelineFps) || 24;
  const dropFrame = !!timelineDropFrame;
  let plannedCues = [];

  for (const item of results) {
    const clip = item.clip;
    const segments = item.segments || [];
    const clipStartTimeline = (clip.offset != null ? Number(clip.offset) : Number(clip.start)) || 0;
    const sourceStart = Number(clip.in ?? clip.trimStart) || 0;
    const placement = {
      ...clip,
      offset: clipStartTimeline,
      in: sourceStart,
      out: Number(clip.out ?? clip.trimEnd ?? clip.duration ?? clip.dur) || sourceStart
    };
    const timelineLimit = Seq.toTimeline(placement.reverse ? placement.in : placement.out, placement);
    const exactFps = getExactFps(fps);
    const firstFrame = Math.ceil(clipStartTimeline * exactFps - 1e-8) / exactFps;
    const lastFrame = Math.floor(timelineLimit * exactFps + 1e-8) / exactFps;

    for (const seg of segments) {
      if (!seg.text || !seg.text.trim()) continue;
      const evidence = normalizeRecognitionEvidence(seg.recognition || (recognition && {
        ...recognition, sourceId:clip.audioSourceId || clip.id, originalText:seg.originalText ?? seg.text, heardText:seg.heardText,
        ...(seg.timed !== false && Number.isFinite(seg.start) && Number.isFinite(seg.end) && {
          sourceStart:sourceStart + seg.start, sourceEnd:sourceStart + seg.end }),
        timingEvidence:seg.alignment?.timingEvidence || (seg.words?.length ? 'word' : seg.timed === false ? 'none' : 'segment'),
        speaker:seg.speaker, speakerScope:seg.speaker != null ? seg.speakerScope ?? recognition.speakerScope : undefined,
        transcriptLineIndex:seg.transcriptLineIndex, words:seg.words?.map(word => ({
          ...word, start:sourceStart + word.start, end:sourceStart + word.end
        }))
      }));
      const planUntimed = () => plannedCues.push({
        start: 0,
        end: 0,
        text: seg.text.trim(),
        style: null,
        timed: false,
        sourceSegment: seg, evidence
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
      if (boundToPlacement && segEnd <= segStart) continue;

      // FPS-SYNC: ASR 秒數相對於裁切後的母素材；時間域換算只交給序列層。
      const first = Seq.toTimeline(sourceStart + segStart, placement);
      const last = Seq.toTimeline(sourceStart + segEnd, placement);
      let timelineStartRaw = Math.min(first, last);
      let timelineEndRaw = Math.max(first, last);
      if (boundToPlacement) {
        timelineStartRaw = Math.max(clipStartTimeline, timelineStartRaw);
        timelineEndRaw = Math.min(timelineLimit, timelineEndRaw);
        if (timelineEndRaw <= timelineStartRaw) continue;
      }

      let start = Math.max(0, snapTimeToFrame(timelineStartRaw, fps, dropFrame));
      let end = snapTimeToFrame(timelineEndRaw, fps, dropFrame);
      if (boundToPlacement) start = Math.max(firstFrame, start);
      if (end <= start && !requireValidTimes) {
        end = snapTimeToFrame(start + (1 / fps), fps, dropFrame);
      }
      if (boundToPlacement) {
        end = Math.min(lastFrame, end);
        if (end <= start) continue;
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
        sourceSegment: seg, evidence
      });
    }
  }

  if (plannedCues.length === 0) return 0;

  if (requireValidTimes) {
    const ordered = plannedCues
      .filter(cue => cue.timed !== false)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const accepted = [];
    const lastByTrack = new Map();
    for (let index = 0; index < ordered.length; index++) {
      const cue = ordered[index];
      const name = trackNameForSegment?.(cue.sourceSegment) || trackName;
      const previous = lastByTrack.get(name);
      if (!hasValidSubtitleTime(cue.start, cue.end) || (!allowOverlap && previous && cue.start < previous.end - 0.000001)) {
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
      lastByTrack.set(name, cue);
    }
    if (allowPartialValidTimes) plannedCues = accepted;
  }

  if (plannedCues.length === 0) return 0;

  const selectNewTrack = !preserveSelection && !hasActiveCueEdit();
  const tracks = new Map();
  for (const cue of plannedCues) {
    const name = trackNameForSegment?.(cue.sourceSegment) || trackName;
    if (!tracks.has(name)) tracks.set(name, { index:State.tracks.length + tracks.size, track:newTrack(name) });
  }
  for (const { track } of tracks.values()) State.tracks.push(track);
  if (selectNewTrack) State.listTrack = tracks.values().next().value.index;
  const newCues = plannedCues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    style: cue.style,
    timed: cue.timed !== false,
    id: newId(),
    ...(cue.evidence && {recognition:cue.evidence}),
    track: tracks.get(trackNameForSegment?.(cue.sourceSegment) || trackName).index,
    ...(trackNameForSegment && ['card','dialogue'].includes(cue.sourceSegment.kind) ? { kind:cue.sourceSegment.kind } : {})
  }));

  for (const cue of newCues) State.cues.push(cue);
  sortCues();
  if (selectNewTrack) {
    setSelection({ kind:'sub', ids:[newCues[0].id] });
    State.activeEdge='start';
  }
  syncTrackCount();
  // 背景工作使用已接受的 placement；期間移除／縮短素材後，新字幕仍須可定位。
  extendDurationForCues(newCues);
  recordHistory(historyLabel);

  emit('timeline:invalidate');
  emit('render:listTrackSel');
  emit('render:all');

  return newCues.length;
}

/**
 * 開啟進行中的語音辨識／文本匹配進度視窗
 */
export function openAsrMonitorDialog(session) {
  if (openRecognitionReview('speech')) return;
  if (!session) return;
  setAsrSessionDialogOpen(true, session.id);
  const terminalStatus = ['completed', 'failed', 'cancelled'].includes(session.progress?.status);

  const durStr = secToEncore(
    session.clips.reduce((acc, c) => {
      const inT = Number(c.in) || 0;
      const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (State.duration || 0)));
      return acc + Math.max(0, outT - inT);
    }, 0),
    session.timelineFps || State.fps,
    session.timelineDropFrame ?? State.dropFrame
  );

  const providerName = CLOUD_PROVIDER_META[session.provider]?.name || (session.provider === 'builtin' ? '程式內建 AI' : session.provider);
  const taskTitle = session.taskMode === 'align' ? '文本匹配' : '語音辨識';

  const percent = Number.isFinite(session.progress?.percent)
    ? Math.max(0, Math.min(100, Math.round(session.progress.percent)))
    : null;
  const statusClass = session.progress?.status === 'failed'
    ? 'is-error'
    : (session.progress?.status === 'completed' ? 'is-success' : 'is-running');
  const statusRole = session.progress?.status === 'failed' ? 'alert' : 'status';
  const outcomeCopy = snapshot => {
    const status=snapshot.progress?.status;
    if(status==='completed'){
      const count=Math.max(0,Number(snapshot.result?.count)||0);
      return count>0
        ? {title:`已建立 ${count} 句字幕`,help:'字幕已加入專案；請查看結果與需校對的行號。關閉後清除這筆工作通知。'}
        : {title:'未產生字幕',help:'這次工作沒有可建立的字幕。關閉後可重新選擇音訊或調整辨識設定。'};
    }
    if(status==='failed') return {title:'工作未完成',help:'請查看上方錯誤並確認專案內的字幕；關閉後可從素材右鍵重新開啟辨識設定。'};
    if(status==='cancelled') return {title:'工作已取消',help:'請確認專案內的字幕；關閉後可從素材右鍵重新開啟辨識設定。'};
    return {title:'可以繼續剪輯',help:'縮小視窗後工作仍會在背景執行；完成時會自動建立字幕軌並通知你。'};
  };
  const outcome=outcomeCopy(session);
  const html = `
    <div class="asr-form asr-workspace asr-monitor-workspace">
      <section class="asr-card asr-monitor-summary" aria-labelledby="asrMonitorSummaryTitle">
        <div class="asr-card-heading">
          ${asrIcon('progress')}
          <div class="asr-heading-copy">
            <h4 id="asrMonitorSummaryTitle">${taskTitle}</h4>
          </div>
          <span class="asr-provider-badge">${escapeHTML(providerName)}</span>
        </div>
        <div class="asr-monitor-meta">
          ${session.range ? `<span>${session.rangeMode === 'export' ? '輸出 In／Out' : '全片'}　${secToEncore(session.range.start, session.timelineFps, session.timelineDropFrame)} – ${secToEncore(session.range.end, session.timelineFps, session.timelineDropFrame)}</span><span aria-hidden="true">·</span>` : ''}
          <span><strong>${session.clips.length}</strong> 個音訊來源</span>
          <span aria-hidden="true">·</span>
          <span>總長度約 <strong>${durStr}</strong></span>
        </div>
      </section>

      <section id="asrProgressContainer" class="asr-card asr-progress-card" role="region" aria-label="辨識進度">
        <div id="asrProgressLabel" class="asr-progress-label">
          <span>${escapeHTML(session.progress?.message || '正在進行語音辨識推論…')}</span>
          <span id="asrProgressPercent" class="asr-progress-percent">
            ${percent !== null ? `${percent}%` : (session.progress?.indeterminate ? '推論中' : '0%')}
          </span>
        </div>
        <div class="asr-progress-track">
          <div id="asrProgressBar" class="asr-progress-bar ${session.progress?.indeterminate ? 'indeterminate' : ''}"
            role="progressbar" aria-label="辨識完成比例" aria-valuemin="0" aria-valuemax="100"
            ${percent !== null ? `aria-valuenow="${percent}"` : ''} style="width:${percent !== null ? `${percent}%` : '0%'};"></div>
        </div>
        <div id="asrStatus" class="asr-status ${statusClass}" role="${statusRole}" aria-live="polite">
          ${escapeHTML(session.statusText || session.progress?.message || '辨識進行中…')}
        </div>
      </section>

      <div class="asr-callout">
        ${asrIcon('info')}
        <div>
          <strong id="asrMonitorOutcomeTitle">${escapeHTML(outcome.title)}</strong>
          <span id="asrMonitorOutcomeHelp">${escapeHTML(outcome.help)}</span>
        </div>
      </div>

      <div id="asrAlignmentDiagnostic" class="asr-diagnostic" style="display:${session.diagnostic ? 'flex' : 'none'};">
        <div id="asrUnreliableLineNumbers" class="asr-diagnostic-lines"></div>
        <div class="asr-diagnostic-actions">
          <span>診斷檔含完整稿件與辨識文字／時間；分享前請先檢查內容。</span>
          <button type="button" id="asrDownloadAlignmentDiagnostic" class="asr-compact-button">匯出診斷 JSON</button>
        </div>
      </div>
    </div>
  `;

  let modalSession=null;
  let alive=true;
  let unsub=()=>{};
  const ownsDialog=()=>alive&&(modalSession?.isCurrent?.()??true);
  const closeOwned=()=>{
    if(!ownsDialog()) return;
    if(modalSession?.close) modalSession.close({committed:true}); else closeModal({committed:true});
    alive=false; unsub();
  };
  const releaseDialog=()=>{
    alive=false; unsub();
    setAsrSessionDialogOpen(false,session.id);
  };
  const cancelSession = () => {
    if(!ownsDialog()) return;
    cancelActiveAsrSession(session.id);
    closeOwned();
    showToast('已取消語音辨識。');
  };

  const minimizeSession = () => {
    if(!ownsDialog()) return;
    setAsrSessionDialogOpen(false, session.id);
    closeOwned();
    showToast('語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
  };

  const acknowledgeSession = () => {
    if(!ownsDialog()) return;
    clearAsrSession(session.id);
    closeOwned();
  };

  const monitorButtons = terminalStatus
    ? [{ label: '關閉', primary: true, act: acknowledgeSession }]
    : [
      { label: '取消工作', act: cancelSession, className: 'asr-danger-button' },
      { label: '縮小至背景', primary: true, act: minimizeSession }
    ];

  modalSession=openModal(`${taskTitle}進度`, html, monitorButtons, {
    width: '620px',
    closeOnBackdrop: false,
    onDismiss:releaseDialog,onReplaced:releaseDialog,
  });
  setAsrSessionDialogOpen(true,session.id);

  const bindMonitorDiagnostic = snapshot => {
    if(!ownsDialog()) return;
    const diagnosticRow = document.getElementById('asrAlignmentDiagnostic');
    const lineNumbers = document.getElementById('asrUnreliableLineNumbers');
    const downloadButton = document.getElementById('asrDownloadAlignmentDiagnostic');
    const failed = snapshot?.failedAlignmentLineNumbers || [];
    const recovered = snapshot?.recoveredAlignmentLineNumbers || [];
    if (diagnosticRow) diagnosticRow.style.display = snapshot?.diagnostic ? 'flex' : 'none';
    if (lineNumbers) {
      lineNumbers.textContent = failed.length
        ? `無時間碼行號：第 ${failed.join('、')} 行`
        : (recovered.length ? `需校對行號：第 ${recovered.join('、')} 行` : '');
    }
    if (downloadButton) {
      downloadButton.disabled = !snapshot?.diagnostic;
      downloadButton.onclick = () => downloadAlignmentDiagnostic(snapshot?.diagnostic);
    }
  };
  bindMonitorDiagnostic(session);

  unsub = onAsrSessionChange(s => {
    if (!ownsDialog()) {
      unsub();
      return;
    }
    if (!s || s.id !== session.id) {
      closeOwned();
      return;
    }
    const progressBar = document.getElementById('asrProgressBar');
    const progressPercent = document.getElementById('asrProgressPercent');
    const progressLabel = document.getElementById('asrProgressLabel')?.firstElementChild;
    const statusEl = document.getElementById('asrStatus');
    const modalFoot = document.getElementById('modalFoot');
    bindMonitorDiagnostic(s);
    const nextOutcome=outcomeCopy(s);
    const outcomeTitle=document.getElementById('asrMonitorOutcomeTitle');
    const outcomeHelp=document.getElementById('asrMonitorOutcomeHelp');
    if(outcomeTitle) outcomeTitle.textContent=nextOutcome.title;
    if(outcomeHelp) outcomeHelp.textContent=nextOutcome.help;

    if (progressBar && s.progress) {
      if (s.progress.indeterminate) {
        progressBar.classList.add('indeterminate');
        progressBar.removeAttribute('aria-valuenow');
      } else {
        progressBar.classList.remove('indeterminate');
        if (Number.isFinite(s.progress.percent)) {
          const nextPercent = Math.max(0, Math.min(100, Math.round(s.progress.percent)));
          progressBar.style.width = nextPercent + '%';
          progressBar.setAttribute('aria-valuenow', String(nextPercent));
        }
      }
    }
    if (progressPercent && s.progress) {
      if (s.progress.indeterminate) {
        progressPercent.textContent = s.progress.status === 'transcribing' ? '運算中' : '準備中';
      } else if (Number.isFinite(s.progress.percent)) {
        progressPercent.textContent = Math.round(s.progress.percent) + '%';
      }
    }
    if (progressLabel && s.progress?.message) {
      progressLabel.textContent = s.progress.message;
    }
    if (statusEl) {
      if (s.progress?.status === 'failed') {
        statusEl.className = 'asr-status is-error';
        statusEl.setAttribute('role', 'alert');
      } else {
        statusEl.className = s.progress?.status === 'completed'
          ? 'asr-status is-success'
          : 'asr-status is-running';
        statusEl.setAttribute('role', 'status');
      }
      statusEl.textContent = s.statusText || s.progress?.message || '';
    }

    if (s.progress?.status === 'completed' || s.progress?.status === 'failed' || s.progress?.status === 'cancelled') {
      if (modalFoot) {
        modalFoot.innerHTML = '';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        closeBtn.className = 'primary';
        closeBtn.onclick = acknowledgeSession;
        modalFoot.appendChild(closeBtn);
      }
      unsub();
    }
  });
}

/**
 * 開啟語音辨識設定與執行對話框
 */
export function openSpeechRecognitionDialog(preferredSource = null) {
  if (openRecognitionReview('speech')) return;
  const ownsWorkspace=Project.captureWorkspaceOwnership();
  let transcriptImportRevision = 0;
  const activeSession = getAsrSession();
  const isRunning = activeSession &&
    activeSession.progress?.status !== 'completed' &&
    activeSession.progress?.status !== 'failed' &&
    activeSession.progress?.status !== 'cancelled';

  if (!preferredSource && activeSession) {
    openAsrMonitorDialog(activeSession);
    return;
  }
  if (!isRunning && activeSession) {
    clearAsrSession();
  }

  // Keep live source references until Start. Background metadata completion may
  // still update their bounds; display-only channel snapshots do not accept work.
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
  const secureBridge = globalThis.window?.subtool?.speechKeyStatus ? window.subtool : null;
  let secureKeys = {}, keyError = '';
  const keyReady = secureBridge && loadDesktopCredentials(secureBridge).then(status => {
    secureKeys = status;
    if (ownsDialog()) {
      const field = document.getElementById('asrApiKey');
      if (field) field.placeholder = secureKeys[document.getElementById('asrProvider')?.value] ? '已安全儲存，留空即可沿用' : '輸入 API Key…';
    }
  }).catch(error => { keyError = error.message; });
  const keyDrafts = new Map(Object.entries(CLOUD_PROVIDER_META).map(([provider, meta]) => [provider, conf[meta.keyField]]));
  const initialProviderMeta = CLOUD_PROVIDER_META[conf.provider] || null;
  const initialTaskMode = conf.taskMode === 'align' ? 'align' : 'transcribe';
  const languages = {align:conf.alignmentLanguage, transcribe:conf.speechLanguage};
  const initialLanguage = languages[initialTaskMode];
  const providerHintText = (provider, mode, timing=conf.openaiTiming) => {
    if(provider==='openai' && timing==='local')return 'OpenAI 辨識選定音訊的原文，本機 Whisper 提供時間。沒有可靠時間的句子會保留為未定時。';
    const meta = ASR_PROVIDER_UI_META[provider];
    return (mode === 'transcribe' && meta?.speechHint) || meta?.hint || '';
  };
  const cloudProvider = !!initialProviderMeta;
  const selectedApiKey = initialProviderMeta ? (conf[initialProviderMeta.keyField] || '') : '';
  const recognitionAudioChoices = clips.length === 1
    ? getRecognitionAudioSourceChoices(captureRecognitionSource(clips[0]))
    : [{ value: 'all', label: '全部來源聲道混音', selection: ALL_RECOGNITION_SOURCE_CHANNELS }];
  const recognitionAudioSelectionByValue = new Map(
    recognitionAudioChoices.map(choice => [choice.value, choice.selection])
  );
  const recognitionAudioOptions = recognitionAudioChoices
    .map(choice => `<option value="${escapeHTML(choice.value)}">${escapeHTML(choice.label)}</option>`)
    .join('');

  function sourceSummary(sources, range = null){
    let totalDur=0;
    const items=sources.map((c,i)=>{
      const inT=Number(c.in)||0;
      const outT=(c.out&&c.out>inT)?c.out:(inT+(Number(c.dur??c.duration)||(State.duration||0)));
      const duration=Math.max(0,outT-inT);
      totalDur+=duration;
      const sourceName=escapeHTML(c.name||'音訊素材');
      return `<div class="asr-source-item" role="listitem"><span class="asr-source-index">${i+1}</span><span class="asr-source-name" title="${sourceName}">${sourceName}</span><span class="asr-source-duration">${secToEncore(duration,State.fps,State.dropFrame)}</span></div>`;
    }).join('');
    const total=range && !range.error
      ? `<span class="asr-duration-pill">${secToEncore(range.start,State.fps,State.dropFrame)} – ${secToEncore(range.end,State.fps,State.dropFrame)}</span>`
      : sources.length>1?`<span class="asr-duration-pill">總計約 ${secToEncore(totalDur,State.fps,State.dropFrame)}</span>`:'';
    return {
      heading:`${asrIcon('source')}<div class="asr-heading-copy"><h4 id="asrSourceTitle">已選取 ${sources.length} 個音訊來源</h4></div>${total}`,
      items,
    };
  }
  const initialSourceSummary=sourceSummary(clips);

  const allAvailableClips = [
    ...(Array.isArray(State.clips) ? State.clips : []),
    ...(Array.isArray(State.externalAudioState) ? State.externalAudioState : [])
  ];
  const clipChoicesHtml = allAvailableClips.map(c => {
    const isVideo = (State.clips || []).includes(c);
    const typeLabel = isVideo ? '視訊音訊' : '外部音軌';
    const isCurrent = clips.some(item => item.id === c.id);
    return `<option value="${escapeHTML(c.id)}" ${isCurrent ? 'selected' : ''}>[${typeLabel}] ${escapeHTML(c.name || '音訊素材')}</option>`;
  }).join('');

  const html = `
    <div class="asr-form asr-workspace asr-config-workspace">
      <section class="asr-card asr-source-card" aria-labelledby="asrSourceTitle">
        <div class="asr-card-heading">
          ${initialSourceSummary.heading}
        </div>
        <div class="asr-source-list" role="list">${initialSourceSummary.items}</div>
        <div class="asr-field asr-source-selector">
          <label for="asrRecognitionRange">辨識範圍</label>
          <select id="asrRecognitionRange">
            <option value="clip">選取的片段</option>
            <option value="all">全片</option>
            <option value="export">輸出 In／Out 範圍</option>
          </select>
          <div id="asrRangeHelp" class="asr-helper" aria-live="polite"></div>
        </div>
        <div id="asrClipSelectorRow" class="asr-field asr-source-selector" style="display:${allAvailableClips.length > 1 ? 'flex' : 'none'};">
          <label for="asrClipSelect">選擇辨識素材</label>
          <select id="asrClipSelect">${clipChoicesHtml}</select>
          <div class="asr-helper">可選擇主要視訊聲音或已匯入的人聲分離軌道（例如 Demucs / UVR 分離之 vocals.wav）。</div>
        </div>
        <details class="asr-inline-help">
          <summary>人聲分離提示</summary>
          <p>伴奏或環境音蓋過人聲時，可先用 UVR5 或 Demucs 分離人聲。將 vocals.wav 匯入時間軸後，在上方選為辨識素材。</p>
        </details>
        <div id="asrRecognitionAudioSourceRow" class="asr-field asr-source-selector" style="display:${recognitionAudioChoices.length > 1 ? 'flex' : 'none'};">
          <label for="asrRecognitionAudioSource">辨識音訊來源</label>
          <select id="asrRecognitionAudioSource">${recognitionAudioOptions}</select>
          <div class="asr-helper">預設會把來源聲道等權混合為 mono；只影響這次辨識。</div>
        </div>
      </section>

      <section class="asr-mode-panel" aria-label="工作方式">
        <div class="asr-mode-options" role="group" aria-label="選擇語音辨識或文本匹配">
          <button type="button" id="asrModeTranscribe" class="asr-mode-option" data-asr-mode="transcribe" aria-pressed="${initialTaskMode === 'transcribe'}">
            <span class="asr-mode-option-title">語音辨識</span>
            <span class="asr-mode-option-copy">從聲音產生字幕文字與時間碼</span>
          </button>
          <button type="button" id="asrModeAlign" class="asr-mode-option" data-asr-mode="align" aria-pressed="${initialTaskMode === 'align'}">
            <span class="asr-mode-option-title">文本匹配</span>
            <span class="asr-mode-option-copy">保留逐行原稿，只分析對應時間</span>
          </button>
        </div>
        <select id="asrTaskMode" class="asr-native-mode-select" aria-label="生成方式" tabindex="-1">
          <option value="transcribe" ${initialTaskMode === 'transcribe' ? 'selected' : ''}>語音辨識（由聲音產生文字與時間碼）</option>
          <option value="align" ${initialTaskMode === 'align' ? 'selected' : ''}>文本匹配（保留逐行文字稿，只匹配時間碼）</option>
        </select>
      </section>

      <div class="asr-settings-grid ${initialTaskMode === 'align' ? 'is-align' : 'is-transcribe'}">
        <section id="asrContentCard" class="asr-card asr-content-card" aria-labelledby="asrContentTitle" style="display:${initialTaskMode === 'align' ? 'flex' : 'none'};">
          <div class="asr-card-heading asr-card-heading-compact">
            ${asrIcon('transcript')}
            <div class="asr-heading-copy">
              <h4 id="asrContentTitle">${initialTaskMode === 'align' ? '逐行文字稿' : '辨識輸出'}</h4>
            </div>
          </div>

          <div id="asrTranscriptRow" class="asr-field asr-transcript-field" style="display:${initialTaskMode === 'align' ? 'flex' : 'none'};">
            <div class="asr-field-heading">
              <label for="asrTranscript">逐行文字稿</label>
              <div class="asr-transcript-actions">
                <span id="asrTranscriptLineCount" class="asr-line-count" aria-live="polite">0 行</span>
                <button type="button" id="asrImportTranscriptButton" class="asr-compact-button">匯入 TXT</button>
              </div>
            </div>
            <input type="file" id="asrTranscriptFileInput" accept=".txt,text/plain" hidden>
            <textarea id="asrTranscript" rows="8" placeholder="貼上已校對、已分行的文字稿…" aria-describedby="asrTranscriptHelp asrTranscriptError"></textarea>
            <div id="asrTranscriptFileSummary" class="asr-file-summary" style="display:none;"></div>
            <div id="asrTranscriptError" class="asr-field-error" role="alert" hidden></div>
            <div id="asrTranscriptHelp" class="asr-helper">每個非空白行固定為一條字幕；只裁掉行首、行尾空白，不會重新分行、分句或改寫內容。</div>
          </div>
        </section>

        <section class="asr-card asr-engine-card" aria-labelledby="asrEngineTitle">
          <div class="asr-card-heading asr-card-heading-compact">
            ${asrIcon('engine')}
            <div class="asr-heading-copy">
              <h4 id="asrEngineTitle">辨識引擎</h4>
            </div>
            <span id="asrProviderBadge" class="asr-provider-badge">${escapeHTML(ASR_PROVIDER_UI_META[conf.provider]?.badge || '')}</span>
          </div>

          <div class="asr-field asr-provider-field">
            <label for="asrProvider">聲音分析引擎</label>
            <select id="asrProvider" class="asr-provider-select">
          <option value="builtin" ${conf.provider === 'builtin' ? 'selected' : ''}>程式內建本機 AI 引擎</option>
          <option value="groq" ${conf.provider === 'groq' ? 'selected' : ''}>Groq</option>
          <option value="openai" ${conf.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="azure" ${conf.provider === 'azure' ? 'selected' : ''}>Azure Speech</option>
          <option value="google" ${conf.provider === 'google' ? 'selected' : ''}>Google Gemini</option>
          <option value="elevenlabs" ${conf.provider === 'elevenlabs' ? 'selected' : ''}>ElevenLabs</option>
        </select>
            <div id="asrProviderHint" class="asr-helper">${escapeHTML(providerHintText(conf.provider, initialTaskMode))}</div>
          </div>


      <!-- 雲端 API Key -->
          <div id="asrKeyRow" class="asr-field" style="display:${cloudProvider ? 'flex' : 'none'};">
            <div class="asr-field-heading">
              <label id="asrKeyLabel" for="asrApiKey">API Key</label>
              <button type="button" id="asrKeyHelp" class="asr-inline-link"></button>
            </div>
            <div class="asr-secret-input">
              <input type="password" id="asrApiKey" placeholder="輸入 API Key…" value="${escapeHTML(selectedApiKey || '')}" autocomplete="off" aria-describedby="asrApiKeyError">
              <button type="button" id="asrToggleApiKey" aria-pressed="false" aria-label="顯示 API Key">顯示</button>
            </div>
            <div id="asrApiKeyError" class="asr-field-error" role="alert" hidden></div>
          </div>


          <div class="asr-field asr-language-field">
            <label for="asrLanguage">音訊語言</label>
            <select id="asrLanguage">
            <option value="auto" ${initialLanguage === 'auto' ? 'selected' : ''}>自動偵測 (Auto)</option>
            <option value="zh" ${initialLanguage === 'zh' ? 'selected' : ''}>繁體中文 (Chinese)</option>
            <option value="en" ${initialLanguage === 'en' ? 'selected' : ''}>英文 (English)</option>
            <option value="ja" ${initialLanguage === 'ja' ? 'selected' : ''}>日文 (Japanese)</option>
            <option value="ko" ${initialLanguage === 'ko' ? 'selected' : ''}>韓文 (Korean)</option>
          </select>
          </div>

        </section>
      </div>
      <div class="asr-field"><label for="asrResultMode">結果處理</label><select id="asrResultMode"><option value="apply">直接加入新字幕軌</option><option value="review">先複核，再加入新軌</option><option value="trial">辨識播放點附近 20 秒，先看候選</option></select></div>
      <details class="asr-inline-details"><summary>試聽與專案詞表</summary><div class="asr-field">
        <button type="button" id="asrListen" class="asr-compact-button">試聽選定聲道的 20 秒音訊</button><audio id="asrTrialAudio" controls hidden></audio><p id="asrTrialStatus" role="status"></p>
        <label for="asrProjectTerms">專案人名與術語（每行一詞）</label><textarea rows="3" id="asrProjectTerms" maxlength="8000">${escapeHTML((State.recognitionTerms||[]).join('\n'))}</textarea>
        <p class="asr-helper">支援提示的服務會收到詞表。正式辨識時保存到本專案。</p>
      </div></details>
      <div id="asrOpenAiTimingField" class="asr-field" hidden><label for="asrOpenAiTiming">OpenAI 時間依據</label><select id="asrOpenAiTiming"><option value="provider" ${providerTimingAvailable()?'':'disabled'}>供應商時間（聽寫可保留說話者）</option><option value="local" ${conf.openaiTiming==='local'?'selected':''}>GPT 原文＋本機 Whisper 對時</option></select>
      <p class="asr-helper">${providerTimingAvailable()?'供應商時間使用的模型預定於 2027-02-26 停用。':'供應商時間使用的模型已於 2027-02-26 停用。'}選擇本機對時並開始辨識後，首次使用會下載 Whisper。結果沒有說話者標籤。</p></div>
      <input type="hidden" id="asrTargetSummary" value="自動建立「${initialTaskMode === 'align' ? '文本匹配' : '語音辨識'}」新軌">

      <section id="asrProgressContainer" class="asr-card asr-progress-card" role="region" aria-label="辨識進度" style="display:none;">
        <div id="asrProgressLabel" class="asr-progress-label">
          <span>正在進行語音辨識推論…</span>
          <span id="asrProgressPercent" class="asr-progress-percent">0%</span>
        </div>
        <div class="asr-progress-track">
          <div id="asrProgressBar" class="asr-progress-bar" role="progressbar" aria-label="辨識完成比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width:0%;"></div>
        </div>
      </section>

      <div id="asrStatus" class="asr-status" role="status" aria-live="polite" style="display:none;"></div>
      <div id="asrAlignmentDiagnostic" class="asr-diagnostic" style="display:none;">
        <div id="asrUnreliableLineNumbers" class="asr-diagnostic-lines"></div>
        <div class="asr-diagnostic-actions">
          <span>診斷檔含完整稿件與辨識文字／時間；文字仍可能含敏感內容，分享前請確認。</span>
          <button type="button" id="asrDownloadAlignmentDiagnostic" class="asr-compact-button">匯出診斷 JSON</button>
        </div>
      </div>
    </div>
  `;

  let latestAlignmentDiagnostic = null;
  let modalSession=null;
  let alive=true;
  let workId=null;
  let releaseWorkSubscription=()=>{};
  let sampleJob, sampleUrl;
  const stopSample=()=>{
    sampleJob?.abort();sampleJob=null;
    if(sampleUrl){const audio=document.getElementById('asrTrialAudio');audio?.pause();audio?.removeAttribute('src');URL.revokeObjectURL(sampleUrl);sampleUrl=null;}
    const audio=document.getElementById('asrTrialAudio'), status=document.getElementById('asrTrialStatus');
    if(audio)audio.hidden=true;
    if(status)status.textContent='';
  };
  const trialClip=source=>{
    const bounds=getRecognitionClipRange(source);
    if(!bounds)throw new Error('無法取得這段素材的有效時間');
    const cursor=Number(Media.displayTime?.());
    const start=cursor>=bounds.start&&cursor<bounds.end?cursor:bounds.start;
    const speed=Number(source.speed)>0?Number(source.speed):1;
    return sliceRecognitionClip(source,{start,end:Math.min(bounds.end,start+20/speed)});
  };
  const ownsDialog=()=>alive&&ownsWorkspace()&&(modalSession?.isCurrent?.()??true);
  const closeOwned=()=>{
    if(!ownsDialog()) return;
    stopSample();
    if(modalSession?.close) modalSession.close({committed:true}); else closeModal({committed:true});
    alive=false;releaseWorkSubscription();
  };
  const abortActiveRecognition = () => {
    stopSample();
    alive=false;releaseWorkSubscription();
    const session = getAsrSession();
    if(!workId||session?.id!==workId) return;
    if (session && session.progress?.status !== 'completed' && session.progress?.status !== 'failed' && session.progress?.status !== 'cancelled') {
      setAsrSessionDialogOpen(false, session.id);
      showToast('🎙 語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
      return;
    }
    clearAsrSession(workId);
  };
  const cancelRecognition = () => {
    if(!ownsDialog()) return;
    if(workId){
      const session=getAsrSession();
      if(session?.id===workId && ['completed','failed','cancelled'].includes(session.progress?.status)) clearAsrSession(workId);
      else cancelActiveAsrSession(workId);
    }
    closeOwned();
  };
  const minimizeToBackground = () => {
    if(!ownsDialog()) return;
    if(workId) setAsrSessionDialogOpen(false, workId);
    closeOwned();
    showToast('語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
  };
  let startPending = false;
  const startOnce = action => async () => {
    if (startPending || !ownsDialog()) return;
    startPending = true;
    try { await action(); } finally { startPending = false; }
  };

  modalSession=openModal('音訊辨識與文本匹配', html, [
    { label: '取消', act: cancelRecognition },
    {
      label: initialTaskMode === 'align' ? '開始匹配' : '開始辨識',
      primary: true,
      act: startOnce(async () => {
        const taskModeEl = document.getElementById('asrTaskMode');
        const transcriptEl = document.getElementById('asrTranscript');
        const recognitionAudioSourceEl = document.getElementById('asrRecognitionAudioSource');
        const providerEl = document.getElementById('asrProvider');
        const apiKeyEl = document.getElementById('asrApiKey');
        const langEl = document.getElementById('asrLanguage');
        const statusEl = document.getElementById('asrStatus');
        const progressContainer = document.getElementById('asrProgressContainer');
        const progressLabel = document.getElementById('asrProgressLabel')?.firstElementChild;
        const progressPercent = document.getElementById('asrProgressPercent');
        const progressBar = document.getElementById('asrProgressBar');
        const modalFoot = document.getElementById('modalFoot');
        const alignmentDiagnosticEl = document.getElementById('asrAlignmentDiagnostic');
        const unreliableLineNumbersEl = document.getElementById('asrUnreliableLineNumbers');
        const workspaceEl = document.querySelector('.asr-config-workspace');

        const taskMode = taskModeEl?.value === 'align' ? 'align' : 'transcribe';
        const alignMode = taskMode === 'align';
        const transcript = alignMode ? transcriptEl?.value || '' : '';
        const transcriptLines = taskMode === 'align' ? parseTranscriptLines(transcript) : [];
        const provider = providerEl?.value || 'google';
        const providerMeta = CLOUD_PROVIDER_META[provider] || null;
        let apiKey = providerMeta ? apiKeyEl?.value?.trim() || '' : '';
        const language = asrLanguage(langEl?.value);
        const rangeEl = document.getElementById('asrRecognitionRange');
        const rangeMode = rangeEl?.value || 'clip';
        const plan = recognitionRangePlan(rangeMode, clips);
        const resultMode=document.getElementById('asrResultMode')?.value||'apply';
        const projectTerms=normalizeRecognitionTerms((document.getElementById('asrProjectTerms')?.value||'').split(/\r?\n/));
        const recognitionSelection = (rangeMode === 'clip' && recognitionAudioSelectionByValue.get(recognitionAudioSourceEl?.value || 'all'))
          || ALL_RECOGNITION_SOURCE_CHANNELS;

        const clearValidationErrors = () => {
          document.querySelectorAll('.asr-field-error').forEach(errorEl => {
            errorEl.hidden = true;
            errorEl.textContent = '';
          });
          document.querySelectorAll('.asr-field [aria-invalid="true"]').forEach(fieldEl => {
            fieldEl.removeAttribute('aria-invalid');
            fieldEl.classList.remove('input-error');
          });
        };
        const showValidationError = (message, focusTarget = null) => {
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.className = 'asr-status is-error';
            statusEl.setAttribute('role', 'alert');
            statusEl.textContent = message;
          }
          const fieldError = focusTarget?.closest('.asr-field')?.querySelector('.asr-field-error');
          if (fieldError) {
            fieldError.hidden = false;
            fieldError.textContent = message;
          }
          focusTarget?.setAttribute('aria-invalid', 'true');
          focusTarget?.classList.add('input-error');
          focusTarget?.focus();
        };
        const setFormProcessing = processing => {
          if (processing) transcriptImportRevision++;
          workspaceEl?.setAttribute('aria-busy', String(processing));
          workspaceEl?.querySelectorAll('input, select, textarea, button').forEach(control => {
            control.disabled = processing;
          });
        };

        clearValidationErrors();
        latestAlignmentDiagnostic = null;
        if (alignmentDiagnosticEl) {
          alignmentDiagnosticEl.style.display = 'none';
          alignmentDiagnosticEl.style.borderColor = 'var(--red)';
        }
        if (unreliableLineNumbersEl) unreliableLineNumbersEl.textContent = '';

        if (plan.error) {
          showValidationError(plan.error, rangeEl);
          return;
        }
        if(resultMode==='trial'){
          if(plan.clips.length!==1){showValidationError('短段試跑需要一個音訊來源，請選取片段。',rangeEl);return;}
          try{plan.clips=[trialClip(plan.clips[0])];}
          catch(error){showValidationError(error.message,rangeEl);return;}
        }
        if (taskMode === 'align' && plan.clips.length !== 1) {
          showValidationError('文本匹配目前一次只能處理一個音訊來源；請只選取一個素材後再試。');
          return;
        }
        if (taskMode === 'align' && transcriptLines.length === 0) {
          showValidationError('請貼上文字稿；每個非空白行會固定建立一條字幕。', transcriptEl);
          return;
        }

        if (keyReady && providerMeta) {
          await keyReady;
          if (!ownsDialog()) return;
          if (!apiKey && secureKeys[provider]) apiKey = storedSpeechKey(provider);
          if (!apiKey && keyError) { showValidationError(keyError, apiKeyEl); return; }
        }
        if (providerMeta && !apiKey) {
          showValidationError(`請先輸入 ${providerMeta.name} API Key`, apiKeyEl);
          return;
        }
        const currentConf = getAsrConfig();
        let azureRegion;
        if (provider === 'azure') {
          const knownRegion = (apiKey === currentConf.azureApiKey || apiKey === storedSpeechKey(provider)) && isAzureSpeechRegion(currentConf.azureRegion)
            ? currentConf.azureRegion : DEFAULT_AZURE_SPEECH_REGION;
          try {
            ({apiKey, region:azureRegion} = parseAzureSpeechCredential(apiKey, knownRegion));
          } catch (error) {
            showValidationError(error.message, apiKeyEl);
            return;
          }
          currentConf.azureRegion = azureRegion;
        }

        currentConf.taskMode = taskMode;
        currentConf.provider = provider;
        if(provider==='openai')currentConf.openaiTiming=document.getElementById('asrOpenAiTiming').value;
        if (providerMeta && secureBridge && apiKey !== storedSpeechKey(provider)) {
          try { secureKeys = await secureBridge.saveSpeechKeys({[provider]:apiKey}); }
          catch (error) { showValidationError(error.message, apiKeyEl); return; }
          if (!ownsDialog()) return;
          apiKey = storedSpeechKey(provider);
        }
        if (providerMeta && !secureBridge) currentConf[providerMeta.keyField] = apiKey;
        if (alignMode) currentConf.alignmentLanguage = language;
        else currentConf.speechLanguage = language;
        saveAsrConfig(currentConf);

        // UI 只負責把外部系統接到辨識工作；identity、取消、迴圈、對齊與提交由 session 擁有。
        if (modalFoot) {
          const startButtons = modalFoot.querySelectorAll('button.primary');
          startButtons.forEach(button => {
            button.disabled = true;
            button.textContent = '處理中…';
          });
          const minimizeBtn = document.getElementById('asrMinimizeBtn');
          if (minimizeBtn) minimizeBtn.style.display = '';
        }
        setFormProcessing(true);
        if (progressContainer) progressContainer.style.display = 'flex';
        progressBar?.classList.add('indeterminate');
        progressBar?.removeAttribute('aria-valuenow');
        if (progressPercent) progressPercent.textContent = '準備中';
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.className = 'asr-status is-running';
          statusEl.setAttribute('role', 'status');
          statusEl.textContent = '正在準備音訊並進行分析…';
        }

        const renderWorkSnapshot = session => {
          if(!ownsDialog()) return;
          if (!session) return;
          const progress = session.progress || {};
          if (progressBar) {
            progressBar.classList.toggle('indeterminate', !!progress.indeterminate);
            if (progress.indeterminate || !Number.isFinite(progress.percent)) {
              progressBar.removeAttribute('aria-valuenow');
            } else {
              const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
              progressBar.style.width = percent + '%';
              progressBar.setAttribute('aria-valuenow', String(percent));
            }
          }
          if (progressPercent) {
            progressPercent.textContent = progress.indeterminate
              ? (progress.status === 'transcribing' ? '運算中' : '準備中')
              : (Number.isFinite(progress.percent) ? Math.round(progress.percent) + '%' : '準備中');
          }
          if (progressLabel && progress.message) progressLabel.textContent = progress.message;
          if (statusEl) statusEl.textContent = session.statusText || progress.message || '';
        };

        const acceptedClips=plan.clips;
        stopSample();
        const liveSources=()=>[...(State.clips||[]),...(Media.externalAudioSources||[]),...(State.externalAudioState||[])];
        const liveClip=id=>liveSources().find(item=>item.id===id);
        const shape=c=>c&&JSON.stringify([c.path||c.name,c.audioSourceId,c.offset??c.start,c.in??c.trimStart,c.out??c.trimEnd,c.speed||1,!!c.reverse,!!c.audioDetached,c.enabled??true,c.gain??1]);
        const stamps=acceptedClips.map(c=>({id:c.id,shape:shape(liveClip(c.id))}));
        const rangeStamp=()=>rangeMode==='clip'?'':JSON.stringify(recognitionRangePlan(rangeMode,clips).clips.map(c=>[c.id,shape(c),c.recognitionSelection]));
        const acceptedRange=rangeStamp();
        const changed=()=>stamps.some(item=>item.shape && item.shape!==shape(liveClip(item.id)))||rangeStamp()!==acceptedRange;
        if(resultMode!=='trial' && JSON.stringify(projectTerms)!==JSON.stringify(State.recognitionTerms||[])){
          State.recognitionTerms=projectTerms;recordHistory('修改專案辨識詞表');
        }
        const releaseSources=retainRecognitionSources(acceptedClips);
        let work;
        try{ work = startAsrWork({
          taskMode,
          provider,
          language,
          projectTerms,
          openaiTiming:document.getElementById('asrOpenAiTiming')?.value,
          rangeMode,
          range:plan.range,
          clips:acceptedClips,
          transcript,
          transcriptLines,
          recognitionSelection,
          apiKey,
          azureRegion,
          timelineFps: State.fps || 24,
          timelineDropFrame: State.dropFrame || false,
          dialogOpen: true
        }, {
          releaseResources:releaseSources,
          extractAudio: (clip, { signal, recognitionSelection: selectedAudio }) => (
            getClipRecognitionSource(clip, { signal, recognitionSelection: selectedAudio, skipSilentVideo:rangeMode !== 'clip' })
          ),
          transcribe: ({ clip, audioBuffer, inT, outT, spec, signal, onProgress }) => transcribeAudioStream({
            audioBuffer,
            checkpoints: recognitionCheckpoints,
            channelSelection: clip.recognitionSelection || spec.recognitionSelection,
            inT,
            outT,
            provider: spec.provider,
            taskMode: spec.taskMode,
            language: spec.language,
            ...(spec.projectTerms.length ? {projectTerms:spec.projectTerms} : {}),
            ...(spec.provider==='openai' ? {openaiTiming:spec.openaiTiming} : {}),
            ...(spec.provider !== 'builtin' ? {apiKey:spec.apiKey} : {}),
            ...(spec.provider === 'azure' ? {azureRegion:spec.azureRegion} : {}),
            signal,
            onProgress
          }),
          resolveAlignment: matchRecognitionTranscript,
          buildDiagnostic: buildTranscriptAlignmentDiagnostic,
          commit: (results, { taskMode: mode, timelineFps: frozenFps, timelineDropFrame: frozenDropFrame, openaiTiming }) => {
            if(!ownsWorkspace())throw new DOMException('辨識所屬的專案已切換','AbortError');
            const timelineRejectedLineNumbers = [];
            const options = mode === 'align' ? {
              trackName: '文本匹配',
              historyLabel: '📝 文本匹配生成字幕',
              requireValidTimes: true,
              preserveUntimedSegments: true,
              timelineFps: frozenFps,
              timelineDropFrame: frozenDropFrame,
              onSkippedSegment: segment => {
                if (Number.isInteger(segment?.transcriptLineIndex)) {
                  timelineRejectedLineNumbers.push(segment.transcriptLineIndex + 1);
                }
              }
            } : {
              preserveUntimedSegments:provider==='openai' && openaiTiming==='local',
              boundToPlacement:rangeMode !== 'clip',
              timelineFps: frozenFps,
              timelineDropFrame: frozenDropFrame
            };
            if(mode==='align')results=results.map(group=>({...group,segments:attachAlignmentEvidence(group.segments,group.evidenceSegments)}));
            options.recognition={kind:mode==='align'?'alignment':'speech',provider,speakerScope:workId};
            if(!results.some(group=>group.segments.some(segment=>segment.text?.trim())))return {count:0};
            if(resultMode!=='apply'||changed()){
              const count=stageRecognitionReview('speech',{groups:results,fps:frozenFps,dropFrame:frozenDropFrame,terms:projectTerms,changed,
                apply:groups=>insertAsrSubtitles(groups,options),onResolve:()=>clearAsrSession(workId),
                retry:()=>openSpeechRecognitionDialog(liveClip(acceptedClips[0].id)),
                rerunLabel:mode==='align'?'用已有語音在本機重對附近幾行':provider==='builtin'?'用本機模型重跑這段':'僅重跑這段（雲端可能計費）',
                rerun:async(group,index,signal)=>{
                  const segments=group.segments, selected=segments[index];
                  const base=Number(group.clip.in??group.clip.trimStart)||0;
                  const duration=Number(group.clip.out??group.clip.trimEnd??group.clip.dur)-base;
                  const timed=s=>s?.timed!==false && Number.isFinite(s?.start) && Number.isFinite(s?.end);
                  const previous=segments.slice(0,index).findLast(timed), next=segments.slice(index+1).find(timed);
                  const anchor=timed(selected)?selected.start:previous?.end??next?.start;
                  if(!Number.isFinite(anchor))throw new Error('附近沒有已定時行，請以播放點選取一段音訊再試跑。');
                  const start=Math.max(0,anchor-2),end=Math.min(duration,Math.max(anchor+2,timed(selected)?selected.end+2:next?.start??anchor+8),start+30);
                  if(!(end>start))return null;
                  if(mode==='align'){
                    const first=Math.max(0,index-1), last=Math.min(segments.length-1,index+1);
                    const from=Math.max(0,Math.min(start,timed(previous)?previous.start:start)-1);
                    const to=Math.min(duration,Math.max(end,timed(next)?next.end:end)+1);
                    const evidence=group.evidenceSegments.filter(s=>s.end>from && s.start<to);
                    if(!evidence.length)throw new Error('附近沒有語音時間依據，請試聽來源或重新辨識這段。');
                    const result=await matchRecognitionTranscript({taskMode:'align',transcript:segments.slice(first,last+1).map(s=>s.text).join('\n'),
                      evidenceSegments:evidence,signal});
                    const candidate=result.segments[index-first];
                    return timed(candidate)?{...selected,...candidate,transcriptLineIndex:selected.transcriptLineIndex}:null;
                  }
                  const selection=group.clip.recognitionSelection||recognitionSelection;
                  const source=await getClipRecognitionSource(group.clip,{signal,recognitionSelection:selection});
                  if(!source)throw new Error('目前無法取得這段音訊。');
                  try{
                    const fresh=await transcribeAudioStream({audioBuffer:source,checkpoints:recognitionCheckpoints,channelSelection:selection,
                      inT:base+start,outT:base+end,provider,language,taskMode:mode,openaiTiming,projectTerms,apiKey,azureRegion,signal});
                    const candidates=fresh.filter(timed).map(s=>({...s,start:s.start+start,end:s.end+start}));
                    const overlap=s=>Math.min(s.end,selected.end)-Math.max(s.start,selected.start);
                    return candidates.sort((a,b)=>timed(selected)?overlap(b)-overlap(a):Math.abs(a.start-anchor)-Math.abs(b.start-anchor))[0]||null;
                  }finally{await source.close?.();}
                },
                rebase:groups=>{
                  const updated=[];
                  for(const group of groups){
                    const live=liveClip(group.clip.id);
                    if(!live || (live.path||live.name)!==(group.clip.path||group.clip.name) || live.audioSourceId!==group.clip.audioSourceId)return null;
                    const base=Number(group.clip.in??group.clip.trimStart)||0, start=Number(live.in??live.trimStart)||0;
                    const end=Number(live.out??live.trimEnd??live.duration??live.dur);
                    if(group.segments.some(s=>s.timed!==false&&(base+s.start<start-1e-6||base+s.end>end+1e-6)))return null;
                    updated.push({clip:live,segments:group.segments.map(s=>s.timed===false?s:{...s,start:base+s.start-start,end:base+s.end-start})});
                  }return updated;
                }});
              return {count,review:true};
            }
            const count=insertAsrSubtitles(results,options);
            return { count, timelineRejectedLineNumbers };
          }
        }); }catch(error){releaseSources();throw error;}
        workId=work.id;
        const unsubscribe = onAsrSessionChange(session => {
          if (session?.id === work.id) renderWorkSnapshot(session);
        });
        releaseWorkSubscription=unsubscribe;
        renderWorkSnapshot(getAsrSession());

        try {
          const outcome = await work.promise;
          if (outcome.status !== 'completed') return;
          if(outcome.review){
            if(ownsDialog()){closeOwned();openRecognitionReview('speech');}else showToast(`有 ${outcome.count} 則候選字幕待複核`);
            return;
          }
          if(!ownsDialog()){
            showToast(`${taskMode==='align'?'文本匹配':'語音辨識'}完成，已生成 ${outcome.count} 句字幕。`);
            return;
          }

          latestAlignmentDiagnostic = outcome.diagnostic || null;
          workspaceEl?.setAttribute('aria-busy', 'false');
          const diagnosticButton = document.getElementById('asrDownloadAlignmentDiagnostic');
          if (diagnosticButton) diagnosticButton.disabled = !latestAlignmentDiagnostic;

          const failedAlignmentLineNumbers = outcome.quality?.untimedLineNumbers || [];
          const recoveredAlignmentLineNumbers = outcome.quality?.recoveredLineNumbers || [];
          const recoveredEstimatedLineCount = outcome.quality?.estimatedLineCount || 0;
          const alignmentReviewCount = outcome.quality?.reviewCount || 0;
          const alignmentProviderFailure = !!outcome.quality?.providerFailure;
          const partialAlignment = taskMode === 'align' && failedAlignmentLineNumbers.length > 0;
          const recoveredAlignment = taskMode === 'align' && recoveredAlignmentLineNumbers.length > 0;
          const alignmentNeedsReview = partialAlignment || recoveredAlignment;
          const isModalShowing = ownsDialog();

          if (latestAlignmentDiagnostic && alignmentDiagnosticEl) {
            alignmentDiagnosticEl.style.display = 'flex';
            alignmentDiagnosticEl.style.borderColor = recoveredAlignment ? 'var(--accent)' : 'var(--red)';
          }
          if (unreliableLineNumbersEl) {
            if (partialAlignment) {
              unreliableLineNumbersEl.textContent = `無時間碼行號：第 ${failedAlignmentLineNumbers.join('、')} 行`;
            } else if (recoveredAlignment) {
              unreliableLineNumbersEl.textContent = recoveredAlignmentLineNumbers.length
                ? `需校對行號：第 ${recoveredAlignmentLineNumbers.join('、')} 行`
                : '部分時間使用估算，請人工校對。';
            }
          }

          if (!alignmentNeedsReview && isModalShowing) closeOwned();
          if (taskMode === 'align') {
            if (partialAlignment) {
              const summaryMsg = `${alignmentProviderFailure ? '聲音分析失敗，但' : ''}已建立 ${outcome.count} 句完整原稿；其中 ${failedAlignmentLineNumbers.length} 句無時間碼，請依上方行號自行補上 In／Out。`;
              if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.className = 'asr-status is-warning';
                statusEl.setAttribute('role', 'status');
                statusEl.textContent = summaryMsg;
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
              showToast(`文本匹配已建立 ${outcome.count} 句完整原稿；${failedAlignmentLineNumbers.length} 句為無時間碼。`);
            } else if (recoveredAlignment) {
              const estimatedMessage = recoveredEstimatedLineCount > 0
                ? `${recoveredEstimatedLineCount} 行使用推估時間`
                : '沒有整行使用推估時間';
              const summaryMsg = `已建立 ${outcome.count} 句完整初稿；${estimatedMessage}，共 ${recoveredAlignmentLineNumbers.length} 行需人工校對，這不是精準對齊。`;
              if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.className = 'asr-status is-warning';
                statusEl.setAttribute('role', 'status');
                statusEl.textContent = summaryMsg;
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
              showToast(`文本匹配已生成 ${outcome.count} 句完整初稿；其中 ${recoveredAlignmentLineNumbers.length} 行需人工校對。`);
            } else {
              const reviewHint = alignmentReviewCount > 0 ? ' 目前為句級估算，請抽查時間碼。' : '';
              showToast(`文本匹配完成！已保留逐行文字稿並生成 ${outcome.count} 句時間碼。${reviewHint}`);
            }
          } else {
            showToast(`🎙 語音辨識完成！已新增字幕軌並生成 ${outcome.count} 句字幕。`);
          }
        } catch (err) {
          console.error('ASR error:', err);
          if(!ownsDialog()){ showToast('❌ 語音辨識失敗：'+(err.message||String(err)),'error'); return; }
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.className = 'asr-status is-error';
            statusEl.setAttribute('role', 'alert');
            statusEl.textContent = '❌ 辨識失敗：' + (err.message || String(err));
          }
          if (modalFoot) {
            const startButtons = modalFoot.querySelectorAll('button.primary');
            startButtons.forEach(button => {
              button.disabled = false;
              button.textContent = taskMode === 'align' ? '開始匹配' : '開始辨識';
            });
          }
          setFormProcessing(false);
          progressBar?.classList.remove('indeterminate');
          // Cancellation/replacement resolves in the session, without entering
          // this catch. Record a real failure once, preserving the dialog alert.
          if (!getAsrSession()?.dialogOpen) {
            showToast('❌ 語音辨識失敗：'+(err.message||String(err)),'error');
          } else setStatus('語音辨識失敗','err',false,err.message||String(err));
        } finally {
          unsubscribe();
        }
      })
    },
    { label: '縮小至背景', act: minimizeToBackground, id: 'asrMinimizeBtn', hidden: true }
  ], { width: '860px', closeOnBackdrop: false, onDismiss: abortActiveRecognition,onReplaced:abortActiveRecognition });

  // 監聽 Provider 切換以自動更新介面
  setTimeout(() => {
    if(!ownsDialog()) return;
    const taskModeEl = document.getElementById('asrTaskMode');
    const transcriptRow = document.getElementById('asrTranscriptRow');
    const transcriptEl = document.getElementById('asrTranscript');
    const transcriptFileInput = document.getElementById('asrTranscriptFileInput');
    const importTranscriptButton = document.getElementById('asrImportTranscriptButton');
    const transcriptFileSummary = document.getElementById('asrTranscriptFileSummary');
    const transcriptLineCount = document.getElementById('asrTranscriptLineCount');
    const contentCard = document.getElementById('asrContentCard');
    const contentTitle = document.getElementById('asrContentTitle');
    const settingsGrid = document.querySelector('.asr-settings-grid');
    const modeButtons = [...document.querySelectorAll('[data-asr-mode]')];
    const statusEl = document.getElementById('asrStatus');
    const targetSummary = document.getElementById('asrTargetSummary');
    const providerEl = document.getElementById('asrProvider');
    const apiKeyEl = document.getElementById('asrApiKey');
    const toggleApiKey = document.getElementById('asrToggleApiKey');
    const keyLabelEl = document.getElementById('asrKeyLabel');
    const helpEl = document.getElementById('asrKeyHelp');
    const providerBadge = document.getElementById('asrProviderBadge');
    const providerHint = document.getElementById('asrProviderHint');
    const languageEl = document.getElementById('asrLanguage');
    const keyRow = document.getElementById('asrKeyRow');
    const downloadAlignmentDiagnosticButton = document.getElementById('asrDownloadAlignmentDiagnostic');

    if (downloadAlignmentDiagnosticButton) {
      downloadAlignmentDiagnosticButton.onclick = () => {
        if (!latestAlignmentDiagnostic) return;
        downloadAlignmentDiagnostic(latestAlignmentDiagnostic);
      };
    }

    const updateTranscriptCount = () => {
      if (!transcriptLineCount) return;
      const count = parseTranscriptLines(transcriptEl?.value || '').length;
      transcriptLineCount.textContent = `${count} 行`;
    };

    const updateTaskUI = () => {
      const alignMode = taskModeEl?.value === 'align';
      if (transcriptRow) transcriptRow.style.display = alignMode ? 'flex' : 'none';
      if (contentCard) contentCard.style.display = alignMode ? 'flex' : 'none';
      if (contentTitle) contentTitle.textContent = alignMode ? '逐行文字稿' : '辨識輸出';
      settingsGrid?.classList.toggle('is-align', alignMode);
      settingsGrid?.classList.toggle('is-transcribe', !alignMode);
      if (targetSummary) targetSummary.value = `自動建立「${alignMode ? '文本匹配' : '語音辨識'}」新軌`;
      modeButtons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.asrMode === (alignMode ? 'align' : 'transcribe')));
      });
      const primaryButton = document.querySelector('#modalFoot button.primary');
      if (primaryButton && primaryButton.dataset.alignmentCommitted !== 'true') {
        primaryButton.textContent = alignMode ? '開始匹配' : '開始辨識';
      }
    };

    if (taskModeEl) {
      taskModeEl.onchange = updateTaskUI;
      modeButtons.forEach(button => {
        button.onclick = () => {
          taskModeEl.value = button.dataset.asrMode === 'align' ? 'align' : 'transcribe';
          taskModeEl.dispatchEvent(new Event('change', { bubbles: true }));
        };
      });
      updateTaskUI();
    }

    if (toggleApiKey && apiKeyEl) {
      toggleApiKey.onclick = () => {
        const reveal = apiKeyEl.type === 'password';
        apiKeyEl.type = reveal ? 'text' : 'password';
        toggleApiKey.textContent = reveal ? '隱藏' : '顯示';
        toggleApiKey.setAttribute('aria-pressed', String(reveal));
        toggleApiKey.setAttribute('aria-label', reveal ? '隱藏 API Key' : '顯示 API Key');
        apiKeyEl.focus();
      };
    }

    if (importTranscriptButton && transcriptFileInput && transcriptEl) {
      const showTranscriptImportError = message => {
        if (!statusEl) return;
        statusEl.style.display = 'block';
        statusEl.className = 'asr-status is-error';
        statusEl.setAttribute('role', 'alert');
        statusEl.textContent = message;
      };
      transcriptEl.addEventListener('input', () => {
        transcriptImportRevision++;
        if (transcriptEl.closest('.asr-workspace')?.getAttribute('aria-busy') !== 'true') {
          importTranscriptButton.disabled = false;
        }
        updateTranscriptCount();
        if (transcriptFileSummary) {
          transcriptFileSummary.style.display = 'none';
          transcriptFileSummary.textContent = '';
        }
      });
      importTranscriptButton.onclick = () => {
        transcriptFileInput.value = '';
        transcriptFileInput.click();
      };
      transcriptFileInput.onchange = async () => {
        const file = transcriptFileInput.files?.[0];
        if (!file) return;
        const revision = ++transcriptImportRevision;
        const ownsImport = () => ownsDialog() && document.contains(transcriptEl)
          && transcriptImportRevision === revision;
        if (!/\.txt$/i.test(file.name || '')) {
          importTranscriptButton.disabled = false;
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
          if (!ownsImport()) return;
          transcriptEl.value = text;
          const lineCount = parseTranscriptLines(text).length;
          updateTranscriptCount();
          if (transcriptFileSummary) {
            transcriptFileSummary.textContent = `${file.name} · ${lineCount} 行`;
          }
          if (statusEl) {
            statusEl.style.display = 'none';
            statusEl.textContent = '';
          }
        } catch (error) {
          if (!ownsImport()) return;
          if (transcriptFileSummary) transcriptFileSummary.style.display = 'none';
          showTranscriptImportError(`無法匯入文字稿：${error?.message || String(error)}`);
        } finally {
          if (ownsImport()) importTranscriptButton.disabled = false;
        }
      };
      updateTranscriptCount();
    }

    if (providerEl) {
      let lastProvider = null;
      let lastMode = initialTaskMode;
      const updateProviderUI = () => {
        document.getElementById('asrOpenAiTimingField').hidden=providerEl.value!=='openai';
        if (lastProvider && keyDrafts.has(lastProvider)) keyDrafts.set(lastProvider, apiKeyEl.value);
        if (languageEl) languages[lastMode] = languageEl.value;
        const p = providerEl.value;
        lastProvider = p;
        const taskMode = taskModeEl?.value === 'align' ? 'align' : 'transcribe';
        lastMode = taskMode;
        if (languageEl) languageEl.value = languages[taskMode];
        const meta = CLOUD_PROVIDER_META[p] || null;
        const uiMeta = ASR_PROVIDER_UI_META[p] || { badge: '', hint: '' };

        if (keyRow) keyRow.style.display = meta ? 'flex' : 'none';
        if (apiKeyEl) {
          apiKeyEl.value = keyDrafts.get(p) || '';
          apiKeyEl.placeholder = secureKeys[p] ? '已安全儲存，留空即可沿用' : '輸入 API Key…';
        }
        if (providerBadge) providerBadge.textContent = uiMeta.badge;
        if (providerHint) providerHint.textContent = providerHintText(p, taskMode, document.getElementById('asrOpenAiTiming').value);

        if (meta) {
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
        } else if (helpEl) {
          helpEl.textContent = '';
          helpEl.onclick = null;
        }
      };

      providerEl.onchange = updateProviderUI;
      taskModeEl?.addEventListener('change', updateProviderUI);
      document.getElementById('asrOpenAiTiming')?.addEventListener('change', updateProviderUI);
      updateProviderUI();
    }

    const clipSelectEl = document.getElementById('asrClipSelect');
    const rangeEl = document.getElementById('asrRecognitionRange');
    const resultModeEl=document.getElementById('asrResultMode');
    const listen=document.getElementById('asrListen');
    if(listen)listen.onclick=async()=>{
      stopSample();
      const status=document.getElementById('asrTrialStatus'), audio=document.getElementById('asrTrialAudio');
      const job=new AbortController();sampleJob=job;
      const selected=recognitionRangePlan(rangeEl.value,clips).clips;
      if(selected.length!==1){status.textContent='請選取單一音訊來源試聽。';return;}
      const clip=trialClip(selected[0]);
      const selection=clip.recognitionSelection || recognitionAudioSelectionByValue.get(document.getElementById('asrRecognitionAudioSource')?.value)||'all';
      status.textContent='正在準備本機試聽…';audio.hidden=true;
      let source;
      try{
        source=await getClipRecognitionSource(clip,{signal:job.signal,recognitionSelection:selection});
        if(!source)throw new Error('沒有可試聽的聲音');
        const start=clip.in, end=Math.min(clip.out,source.duration);
        const data=source.readRange?await source.readRange(start,end,{signal:job.signal}):source;
        const blob=encodeWav16kMono(data,source.readRange?0:start,source.readRange?data.duration:end);
        if(job.signal.aborted||!ownsDialog())return;
        sampleUrl=URL.createObjectURL(blob);audio.src=sampleUrl;audio.hidden=false;
        status.textContent=`試聽 ${Math.round((end-start)*10)/10} 秒，尚未送出辨識。`;
        void audio.play().catch(()=>{});
      }catch(error){if(!job.signal.aborted&&ownsDialog())status.textContent=error.message;}
      finally{await source?.close?.();}
    };
    const refreshScope = () => {
      if (!ownsDialog()) return;
      const mode = rangeEl.value;
      const plan = recognitionRangePlan(mode, clips);
      const summary = sourceSummary(plan.clips, plan.range);
      const card = rangeEl.closest('.asr-source-card');
      card.querySelector('.asr-card-heading').innerHTML = summary.heading;
      card.querySelector('.asr-source-list').innerHTML = summary.items;
      const single = mode === 'clip';
      document.getElementById('asrClipSelectorRow').style.display = single && allAvailableClips.length > 1 ? 'flex' : 'none';
      document.getElementById('asrRecognitionAudioSourceRow').style.display = single && recognitionAudioSelectionByValue.size > 1 ? 'flex' : 'none';
      const trial=resultModeEl?.value==='trial';
      const restriction=(taskModeEl?.value==='align'||trial)&&plan.clips.length!==1;
      let sampleRange='';
      if(trial&&!restriction&&!plan.error){
        const bounds=getRecognitionClipRange(plan.clips[0]);
        if(bounds){
          const interval=getRecognitionClipRange(trialClip(plan.clips[0]));
          sampleRange=`此次試跑 In ${secToEncore(interval.start,State.fps,State.dropFrame)}　Out ${secToEncore(interval.end,State.fps,State.dropFrame)}。`;
        }
      }
      const primary=document.querySelector('#modalFoot button.primary');
      if(primary&&!workId){primary.disabled=restriction||!!plan.error;
        primary.textContent=resultModeEl?.value==='trial'?'辨識這段':taskModeEl?.value==='align'?'開始匹配':'開始辨識';}
      document.getElementById('asrRangeHelp').textContent = plan.error || sampleRange || (restriction?'這個模式需要一個音訊來源，請選取單一片段。':single ? '' :
        '依序辨識範圍內的影片原音與已啟用的外部音訊，每個來源各自混合可聽聲道。');
    };
    if (rangeEl) rangeEl.onchange = refreshScope;
    resultModeEl?.addEventListener('change',refreshScope);
    taskModeEl?.addEventListener('change',refreshScope);
    document.getElementById('asrRecognitionAudioSource')?.addEventListener('change',stopSample);
    rangeEl?.addEventListener('change',stopSample);
    clipSelectEl?.addEventListener('change',stopSample);
    if (clipSelectEl) {
      clipSelectEl.onchange = () => {
        if(!ownsDialog()) return;
        const chosenId = clipSelectEl.value;
        const chosen = allAvailableClips.find(c => c.id === chosenId);
        if (chosen) {
          clips.length = 0;
          clips.push(chosen);
          const newChoices = getRecognitionAudioSourceChoices(captureRecognitionSource(chosen));
          const audioSourceSelect = document.getElementById('asrRecognitionAudioSource');
          const audioSourceRow = document.getElementById('asrRecognitionAudioSourceRow');
          if (audioSourceSelect && audioSourceRow) {
            audioSourceRow.style.display = newChoices.length > 1 ? 'flex' : 'none';
            audioSourceSelect.innerHTML = newChoices
              .map(choice => `<option value="${escapeHTML(choice.value)}">${escapeHTML(choice.label)}</option>`)
              .join('');
          }
          recognitionAudioSelectionByValue.clear();
          newChoices.forEach(choice => recognitionAudioSelectionByValue.set(choice.value, choice.selection));
          refreshScope();
        }
      };
    }
    if(rangeEl)refreshScope();
  }, 0);
}

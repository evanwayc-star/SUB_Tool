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
import { resolveRecognitionAlignment } from './recognition-alignment-result.js';
import { CLOUD_PROVIDER_META, getAsrGuidanceMeta, resolveAsrGuidance } from './recognition-guidance.js';
import {
  getAsrSession,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  onAsrSessionChange,
  clearAsrSession,
  startAsrWork
} from './speech-recognition-session.js';
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
  parseElevenLabsTranscriptionResponse,
  callElevenLabsSpeechTranscription,
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
  parseElevenLabsTranscriptionResponse,
  callElevenLabsSpeechTranscription,
  callWhisperApi,
  transcribeAudioStream,
  getAsrSession,
  setAsrSessionDialogOpen,
  cancelActiveAsrSession,
  onAsrSessionChange,
  clearAsrSession,
  startAsrWork
};

const ASR_CONFIG_KEY = 'subtool_asr_config';
const DEFAULT_ASR_PROMPT = '以下是影音對話，請以繁體中文輸出完整字幕，精準保留標點符號。';
const ASR_PROVIDER_UI_META = Object.freeze({
  builtin: {
    badge: '本機離線',
    hint: '音訊留在這台電腦上處理；第一次使用模型時需要下載模型檔。'
  },
  groq: {
    badge: '高速雲端',
    hint: '適合快速建立初稿；本次所選音訊會傳送至 Groq 進行辨識。'
  },
  openai: {
    badge: '雲端逐字時間',
    hint: '使用 Whisper-1 取得字幕文字與逐字時間；本次所選音訊會傳送至 OpenAI。'
  },
  azure: {
    badge: '專業雲端',
    hint: '支援 Phrase List 與逐句／逐字時間；Region 必須和 Speech Key 所屬資源一致。'
  },
  google: {
    badge: '語意理解',
    hint: '適合繁體中文語意與上下文理解；時間邊界仍建議在完成後抽查。'
  },
  elevenlabs: {
    badge: '高精準雲端',
    hint: 'Scribe v2 支援多語言、逐字時間與專有名詞 Keyterms。'
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
export { CLOUD_PROVIDER_META, getAsrGuidanceMeta, resolveAsrGuidance } from './recognition-guidance.js';

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
          elevenlabsApiKey: parsed.elevenlabsApiKey || '',
          azureRegion: parsed.azureRegion || DEFAULT_AZURE_SPEECH_REGION,
          azurePhraseList: parsed.azurePhraseList || '',
          elevenlabsKeyterms: parsed.elevenlabsKeyterms || '',
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
    elevenlabsApiKey: '',
    azureRegion: DEFAULT_AZURE_SPEECH_REGION,
    azurePhraseList: '',
    elevenlabsKeyterms: '',
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

function downloadAlignmentDiagnostic(diagnostic) {
  if (!diagnostic) return false;
  const timestamp = String(diagnostic.generatedAt || new Date().toISOString())
    .replace(/[:.]/gu, '-')
    .replace('T', '_')
    .replace(/Z$/u, '');
  const bytes = new TextEncoder().encode(`${JSON.stringify(diagnostic, null, 2)}\n`);
  downloadBytes(bytes, `SUBTool_文本匹配診斷_${timestamp}.json`, 'application/json');
  return true;
}

export function insertAsrSubtitles(results, {
  trackName = '語音辨識',
  historyLabel = '🎙 語音辨識生成字幕',
  requireValidTimes = false,
  allowPartialValidTimes = false,
  preserveUntimedSegments = false,
  onSkippedSegment = null,
  timelineFps = State.fps || 24,
  timelineDropFrame = State.dropFrame || false
} = {}) {
  if (!results || results.length === 0) return 0;

  // FPS-SYNC（詳見 FPS_時碼一致性.md）：文本匹配只在寫入時間軸前走唯一影格格網，
  // strict 模式必須在吸附後重新拒絕零長度或重疊 cue，不可自行補成一格。
  const fps = Number(timelineFps) || 24;
  const dropFrame = !!timelineDropFrame;
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
 * 開啟進行中的語音辨識／文本匹配進度視窗
 */
export function openAsrMonitorDialog(session) {
  if (!session) return;
  setAsrSessionDialogOpen(true, session.id);
  const terminalStatus = ['completed', 'failed', 'cancelled'].includes(session.progress?.status);

  const durStr = secToEncore(
    session.clips.reduce((acc, c) => {
      const inT = Number(c.in) || 0;
      const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur ?? c.duration) || (State.duration || 0)));
      return acc + Math.max(0, outT - inT);
    }, 0),
    State.fps,
    State.dropFrame
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
  const html = `
    <div class="asr-form asr-workspace asr-monitor-workspace">
      <section class="asr-card asr-monitor-summary" aria-labelledby="asrMonitorSummaryTitle">
        <div class="asr-card-heading">
          ${asrIcon('progress')}
          <div class="asr-heading-copy">
            <span class="asr-eyebrow">背景工作</span>
            <h4 id="asrMonitorSummaryTitle">${taskTitle}</h4>
          </div>
          <span class="asr-provider-badge">${escapeHTML(providerName)}</span>
        </div>
        <div class="asr-monitor-meta">
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
          <strong>${terminalStatus ? '結果已保留' : '可以繼續剪輯'}</strong>
          <span>${terminalStatus
            ? '確認結果與診斷後按「關閉」即可清除這筆工作通知。'
            : '縮小視窗後工作仍會在背景執行；完成時會自動建立字幕軌並通知你。'}</span>
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

  const cancelSession = () => {
    cancelActiveAsrSession(session.id);
    closeModal({ committed: true });
    showToast('已取消語音辨識。');
  };

  const minimizeSession = () => {
    setAsrSessionDialogOpen(false, session.id);
    closeModal({ committed: true });
    showToast('語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
  };

  const acknowledgeSession = () => {
    clearAsrSession(session.id);
    closeModal({ committed: true });
  };

  const monitorButtons = terminalStatus
    ? [{ label: '關閉', primary: true, act: acknowledgeSession }]
    : [
      { label: '取消工作', act: cancelSession, className: 'asr-danger-button' },
      { label: '縮小至背景', primary: true, act: minimizeSession }
    ];

  openModal(`${taskTitle}進度`, html, monitorButtons, {
    width: '620px',
    closeOnBackdrop: false,
    onDismiss: () => {
      setAsrSessionDialogOpen(false, session.id);
    }
  });

  const bindMonitorDiagnostic = snapshot => {
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

  const unsub = onAsrSessionChange(s => {
    if (!s || s.id !== session.id) {
      unsub();
      return;
    }
    const progressBar = document.getElementById('asrProgressBar');
    const progressPercent = document.getElementById('asrProgressPercent');
    const progressLabel = document.getElementById('asrProgressLabel')?.firstElementChild;
    const statusEl = document.getElementById('asrStatus');
    const modalFoot = document.getElementById('modalFoot');
    bindMonitorDiagnostic(s);

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
    : (initialGuidanceMeta?.kind === 'keyterms'
      ? (conf.elevenlabsKeyterms || '')
      : (initialGuidanceMeta ? (conf.prompt || '') : ''));
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
    const sourceName = escapeHTML(c.name || '音訊素材');
    return `<div class="asr-source-item" role="listitem"><span class="asr-source-index">${i + 1}</span><span class="asr-source-name" title="${sourceName}">${sourceName}</span><span class="asr-source-duration">${durStr}</span></div>`;
  }).join('');

  const html = `
    <div class="asr-form asr-workspace asr-config-workspace">
      <section class="asr-card asr-source-card" aria-labelledby="asrSourceTitle">
        <div class="asr-card-heading">
          ${asrIcon('source')}
          <div class="asr-heading-copy">
            <span class="asr-eyebrow">本次輸入</span>
            <h4 id="asrSourceTitle">已選取 ${clips.length} 個音訊來源</h4>
          </div>
          <span class="asr-duration-pill">約 ${secToEncore(totalDur, State.fps, State.dropFrame)}</span>
        </div>
        <div class="asr-source-list" role="list">${clipsSummary}</div>
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
              <span class="asr-eyebrow">內容與輸出</span>
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
              <span class="asr-eyebrow">處理設定</span>
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
            <div id="asrProviderHint" class="asr-helper">${escapeHTML(ASR_PROVIDER_UI_META[conf.provider]?.hint || '')}</div>
          </div>

      <!-- 內建模型選擇 -->
          <div id="asrBuiltinRow" class="asr-field" style="display:${conf.provider === 'builtin' ? 'flex' : 'none'};">
            <label for="asrBuiltinModel">內建 AI 模型等級</label>
            <select id="asrBuiltinModel">
          <option value="onnx-community/whisper-tiny" ${conf.builtinModel === 'onnx-community/whisper-tiny' ? 'selected' : ''}>Whisper Tiny 逐字時間版</option>
          <option value="onnx-community/whisper-base" ${conf.builtinModel === 'onnx-community/whisper-base' ? 'selected' : ''}>Whisper Base 逐字時間版</option>
          <option value="onnx-community/whisper-small" ${conf.builtinModel === 'onnx-community/whisper-small' ? 'selected' : ''}>Whisper Small 逐字時間版</option>
          <option value="onnx-community/whisper-large-v3-turbo" ${conf.builtinModel === 'onnx-community/whisper-large-v3-turbo' ? 'selected' : ''}>Whisper Large v3 Turbo q4 逐字時間版</option>
        </select>
            <div class="asr-helper">首次使用會下載並快取模型；有獨立顯卡時可自動啟用 WebGPU。</div>
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

          <div id="asrAzureRegionRow" class="asr-field" style="display:${conf.provider === 'azure' ? 'flex' : 'none'};">
            <label for="asrAzureRegion">Azure Speech Region</label>
            <input type="text" id="asrAzureRegion" placeholder="例如 ${DEFAULT_AZURE_SPEECH_REGION}" value="${escapeHTML(conf.azureRegion || DEFAULT_AZURE_SPEECH_REGION)}" aria-describedby="asrAzureRegionHelp asrAzureRegionError">
            <div id="asrAzureRegionError" class="asr-field-error" role="alert" hidden></div>
            <div id="asrAzureRegionHelp" class="asr-helper">必須和 Speech Key 所屬資源的 Region 一致。</div>
          </div>

          <div class="asr-field">
            <label for="asrLanguage">音訊語言</label>
            <select id="asrLanguage">
            <option value="zh" ${conf.language === 'zh' ? 'selected' : ''}>繁體中文 (Chinese)</option>
            <option value="en" ${conf.language === 'en' ? 'selected' : ''}>英文 (English)</option>
            <option value="ja" ${conf.language === 'ja' ? 'selected' : ''}>日文 (Japanese)</option>
            <option value="ko" ${conf.language === 'ko' ? 'selected' : ''}>韓文 (Korean)</option>
            <option value="auto" ${conf.language === 'auto' ? 'selected' : ''}>自動偵測 (Auto)</option>
          </select>
          </div>

          <div id="asrPromptRow" class="asr-field asr-guidance-field" style="display:${initialGuidanceMeta ? 'flex' : 'none'};">
            <label id="asrPromptLabel" for="asrPrompt">${escapeHTML(initialGuidanceMeta?.label || '')}</label>
            <input type="text" id="asrPrompt" placeholder="${escapeHTML(initialGuidanceMeta?.placeholder || '')}" value="${escapeHTML(initialGuidanceValue)}">
          </div>
        </section>
      </div>
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
  const abortActiveRecognition = () => {
    const session = getAsrSession();
    if (session && session.progress?.status !== 'completed' && session.progress?.status !== 'failed' && session.progress?.status !== 'cancelled') {
      setAsrSessionDialogOpen(false, session.id);
      showToast('🎙 語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
      return;
    }
    cancelActiveAsrSession();
  };
  const cancelRecognition = () => {
    cancelActiveAsrSession();
    closeModal({ committed: true });
  };
  const minimizeToBackground = () => {
    const session = getAsrSession();
    setAsrSessionDialogOpen(false, session?.id);
    closeModal({ committed: true });
    showToast('語音辨識已在背景執行，可隨時點擊頂部「🎙 辨識中」按鈕查看進度。');
  };

  openModal('音訊辨識與文本匹配', html, [
    { label: '取消', act: cancelRecognition },
    {
      label: initialTaskMode === 'align' ? '開始匹配' : '開始辨識',
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
        const workspaceEl = document.querySelector('.asr-config-workspace');

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
        if (provider === 'elevenlabs') {
          currentConf.elevenlabsKeyterms = guidance.elevenlabsKeytermsText;
        }
        currentConf.language = language;
        if (getAsrGuidanceMeta(provider)?.kind === 'prompt') currentConf.prompt = prompt;
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

        const work = startAsrWork({
          taskMode,
          provider,
          builtinModel,
          language,
          clips,
          transcript,
          transcriptLines,
          recognitionSelection,
          guidance,
          apiKey,
          azureRegion,
          timelineFps: State.fps || 24,
          timelineDropFrame: State.dropFrame || false,
          dialogOpen: true
        }, {
          extractAudio: (clip, { signal, recognitionSelection: selectedAudio }) => (
            getClipAudioBuffer(clip, { signal, recognitionSelection: selectedAudio })
          ),
          transcribe: ({ audioBuffer, inT, outT, spec, signal, onProgress }) => transcribeAudioStream({
            audioBuffer,
            inT,
            outT,
            provider: spec.provider,
            builtinModel: spec.builtinModel,
            apiKey: spec.apiKey,
            azureRegion: spec.azureRegion,
            language: spec.language,
            ...('azurePhrases' in spec.guidance ? { azurePhrases: spec.guidance.azurePhrases } : {}),
            ...('keyterms' in spec.guidance ? { keyterms: spec.guidance.keyterms } : {}),
            ...('prompt' in spec.guidance ? { prompt: spec.guidance.prompt } : {}),
            signal,
            onProgress
          }),
          resolveAlignment: ({ taskMode: mode, transcript: fixedTranscript, evidenceSegments }) => (
            resolveRecognitionAlignment({
              taskMode: mode,
              transcript: fixedTranscript,
              evidenceSegments,
              alignTranscriptToEvidence
            })
          ),
          buildDiagnostic: buildTranscriptAlignmentDiagnostic,
          commit: (results, { taskMode: mode, timelineFps: frozenFps, timelineDropFrame: frozenDropFrame }) => {
            const timelineRejectedLineNumbers = [];
            const count = insertAsrSubtitles(results, mode === 'align' ? {
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
              timelineFps: frozenFps,
              timelineDropFrame: frozenDropFrame
            });
            return { count, timelineRejectedLineNumbers };
          }
        });
        const unsubscribe = onAsrSessionChange(session => {
          if (session?.id === work.id) renderWorkSnapshot(session);
        });
        renderWorkSnapshot(getAsrSession());

        try {
          const outcome = await work.promise;
          if (outcome.status !== 'completed') return;

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
          const isModalShowing = document.getElementById('asrStatus') !== null;

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

          if (!alignmentNeedsReview && isModalShowing) closeModal({ committed: true });
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
          if (!getAsrSession()?.dialogOpen) {
            showToast('❌ 語音辨識失敗：' + (err.message || String(err)), 4000);
          }
        } finally {
          unsubscribe();
        }
      }
    },
    { label: '縮小至背景', act: minimizeToBackground, id: 'asrMinimizeBtn', hidden: true }
  ], { width: '860px', closeOnBackdrop: false, onDismiss: abortActiveRecognition });

  // 監聽 Provider 切換以自動更新介面
  setTimeout(() => {
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
    const azureRegionRow = document.getElementById('asrAzureRegionRow');
    const promptRowEl = document.getElementById('asrPromptRow');
    const promptEl = document.getElementById('asrPrompt');
    const promptLabelEl = document.getElementById('asrPromptLabel');
    const builtinRow = document.getElementById('asrBuiltinRow');
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
          updateTranscriptCount();
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
      updateTranscriptCount();
    }

    if (providerEl) {
      const updateProviderUI = () => {
        const p = providerEl.value;
        const c = getAsrConfig();
        const meta = CLOUD_PROVIDER_META[p] || null;
        const uiMeta = ASR_PROVIDER_UI_META[p] || { badge: '', hint: '' };

        if (builtinRow) builtinRow.style.display = p === 'builtin' ? 'flex' : 'none';
        if (keyRow) keyRow.style.display = meta ? 'flex' : 'none';
        if (azureRegionRow) azureRegionRow.style.display = p === 'azure' ? 'flex' : 'none';
        const guidanceMeta = getAsrGuidanceMeta(p);
        if (promptRowEl) promptRowEl.style.display = guidanceMeta ? 'flex' : 'none';
        if (providerBadge) providerBadge.textContent = uiMeta.badge;
        if (providerHint) providerHint.textContent = uiMeta.hint;

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
        } else if (helpEl) {
          helpEl.textContent = '';
          helpEl.onclick = null;
        }
        if (promptLabelEl) promptLabelEl.textContent = guidanceMeta?.label || '';
        if (promptEl) {
          promptEl.placeholder = guidanceMeta?.placeholder || '';
          promptEl.value = guidanceMeta?.kind === 'phrases'
            ? (c.azurePhraseList || '')
            : (guidanceMeta?.kind === 'keyterms'
              ? (c.elevenlabsKeyterms || '')
              : (guidanceMeta ? (c.prompt || '') : ''));
        }
      };

      providerEl.onchange = updateProviderUI;
      updateProviderUI();
    }
  }, 0);
}

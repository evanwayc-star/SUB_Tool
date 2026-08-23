/* ==============================================================================
   SUB Tool — Speech Recognition UI Module (src/speech-recognition.js)
   ==============================================================================
   語音辨識使用者介面（UI Modal）與時間軸字幕軌生成協調器。
   推論核心由 src/speech-recognition-engine.js 提供，本模組專注於：
   1. 互動式對話框表單（模型、API Key、提示詞、語言選擇）
   2. 進度條回饋與狀態提示
   3. 辨識結果轉為標準時間軸字幕軌（Subtitle Track / Cues）
   ============================================================================== */
import { State, newTrack, syncTrackCount, newId, setSelection, IS_DESKTOP } from './state.js';
import { AudioEngine } from './audio-engine.js';
import { snapTimeToFrame, secToEncore } from './time.js';
import { sortCues } from './subtitle-model.js';
import { recordHistory } from './history.js';
import { openModal, closeModal, showToast } from './ui.js';
import { emit } from './events.js';
import { escapeHTML } from './util.js';
import {
  BUILTIN_MODELS,
  blobToBase64,
  extractClipFloat32Mono16k,
  encodeWav16kMono,
  loadTransformersPipeline,
  transcribeWithBuiltinModel,
  resolveGeminiModel,
  callGeminiAudioTranscription,
  callWhisperApi,
  transcribeAudioStream
} from './speech-recognition-engine.js';

// Re-export 推論模組介面以維持向下相容
export {
  BUILTIN_MODELS,
  blobToBase64,
  extractClipFloat32Mono16k,
  encodeWav16kMono,
  loadTransformersPipeline,
  transcribeWithBuiltinModel,
  resolveGeminiModel,
  callGeminiAudioTranscription,
  callWhisperApi,
  transcribeAudioStream
};

const ASR_CONFIG_KEY = 'subtool_asr_config';

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
          provider: parsed.provider || 'google',
          builtinModel: parsed.builtinModel || 'onnx-community/whisper-large-v3-turbo',
          googleApiKey: parsed.googleApiKey || '',
          groqApiKey: parsed.groqApiKey || '',
          openaiApiKey: parsed.openaiApiKey || '',
          language: parsed.language || 'zh',
          prompt: parsed.prompt || '以下是影音對話，請以繁體中文輸出完整字幕，精準保留標點符號。'
        };
      }
    }
  } catch (_) {}
  return {
    provider: 'google',
    builtinModel: 'onnx-community/whisper-large-v3-turbo',
    googleApiKey: '',
    groqApiKey: '',
    openaiApiKey: '',
    language: 'zh',
    prompt: '以下是影音對話，請以繁體中文輸出完整字幕，精準保留標點符號。'
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
export async function getClipAudioBuffer(clip) {
  if (clip.audioBuffer) return clip.audioBuffer;

  if (clip.audioElement) {
    const actx = AudioEngine.getAudioContext();
    const resp = await fetch(clip.audioElement.src || clip.src);
    const ab = await resp.arrayBuffer();
    const decoded = await actx.decodeAudioData(ab);
    return decoded;
  }

  if (clip.file) {
    const actx = AudioEngine.getAudioContext();
    const ab = await clip.file.arrayBuffer();
    const decoded = await actx.decodeAudioData(ab);
    return decoded;
  }

  throw new Error(`無法載入素材「${clip.name || clip.id}」的音訊資料`);
}

/**
 * 將辨識結果結構轉換為字幕軌並加入時間軸
 */
export function insertAsrSubtitles(results) {
  if (!results || results.length === 0) return 0;

  const fps = State.fps || 24;
  const dropFrame = State.dropFrame || false;
  const newCues = [];
  const trackObj = newTrack('語音辨識');
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
    emit('render:listTrackSel');
    emit('render:all');
    return 0;
  }

  recordHistory('🎙 語音辨識生成字幕');

  State.cues.push(...newCues);
  sortCues();
  setSelection(newCues[0].id);
  syncTrackCount();

  emit('render:listTrackSel');
  emit('render:all');

  return newCues.length;
}

/**
 * 開啟語音辨識設定與執行對話框
 */
export function openSpeechRecognitionDialog() {
  const clips = [];
  if (State.selectedClipId) {
    const c = State.clips.find(item => item.id === State.selectedClipId);
    if (c) clips.push(c);
  }
  if (State.selectedAudioClipId) {
    const c = (State.audioClips || []).find(item => item.id === State.selectedAudioClipId);
    if (c && !clips.includes(c)) clips.push(c);
  }

  if (clips.length === 0) {
    if (State.clips && State.clips.length > 0) {
      clips.push(State.clips[0]);
    } else if (State.audioClips && State.audioClips.length > 0) {
      clips.push(State.audioClips[0]);
    }
  }

  if (clips.length === 0) {
    showToast('⚠️ 目前時間軸上無任何音訊或視訊素材可供辨識。', 3500);
    return;
  }

  const conf = getAsrConfig();

  const totalDur = clips.reduce((acc, c) => {
    const inT = Number(c.in) || 0;
    const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur) || (State.duration || 0)));
    return acc + Math.max(0, outT - inT);
  }, 0);

  const clipsSummary = clips.map((c, i) => {
    const inT = Number(c.in) || 0;
    const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur) || (State.duration || 0)));
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
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">語音辨識模式：</label>
        <select id="asrProvider" style="width:100%;">
          <option value="google" ${conf.provider === 'google' ? 'selected' : ''}>🌟 Google Gemini (大語言模型・繁體中文理解力最強)</option>
          <option value="groq" ${conf.provider === 'groq' ? 'selected' : ''}>⚡ Groq (Whisper-large-v3，極速雲端・免費)</option>
          <option value="builtin" ${conf.provider === 'builtin' ? 'selected' : ''}>💻 程式內建本機 AI 引擎 (免設定・100% 離線)</option>
          <option value="openai" ${conf.provider === 'openai' ? 'selected' : ''}>OpenAI (Whisper-1 官方雲端)</option>
        </select>
      </div>

      <!-- 內建模型選擇 -->
      <div id="asrBuiltinRow" style="display:${conf.provider === 'builtin' ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">內建 AI 模型等級：</label>
        <select id="asrBuiltinModel" style="width:100%;">
          <option value="onnx-community/whisper-tiny" ${conf.builtinModel === 'onnx-community/whisper-tiny' ? 'selected' : ''}>Whisper Tiny (超輕量 39MB，速度最快)</option>
          <option value="onnx-community/whisper-base" ${conf.builtinModel === 'onnx-community/whisper-base' ? 'selected' : ''}>Whisper Base (標準推薦 73MB，速度與平衡)</option>
          <option value="onnx-community/whisper-small" ${conf.builtinModel === 'onnx-community/whisper-small' ? 'selected' : ''}>Whisper Small (高精度 240MB，中文佳)</option>
          <option value="onnx-community/whisper-large-v3-turbo" ${conf.builtinModel === 'onnx-community/whisper-large-v3-turbo' ? 'selected' : ''}>Whisper Large v3 Turbo (旗艦極速 800MB，最新頂級精度)</option>
        </select>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.4;">
          💡 首次使用特定模型時會自動由快取下載。本機電腦有獨立顯卡時可自動啟用 WebGPU 加速。若需應對嘈雜背景音樂電影，強烈推薦選擇 Large v3 Turbo 或 Google Gemini 模式。
        </div>
      </div>

      <!-- 雲端 API Key -->
      <div id="asrKeyRow" style="display:${(conf.provider === 'google' || conf.provider === 'groq' || conf.provider === 'openai') ? 'flex' : 'none'};flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);display:flex;justify-content:space-between;">
          <span id="asrKeyLabel">API Key：</span>
          <span id="asrKeyHelp" style="font-size:11px;color:var(--accent);cursor:pointer;"></span>
        </label>
        <input type="password" id="asrApiKey" placeholder="輸入您的 API Key…" value="${escapeHTML(conf.provider === 'google' ? (conf.googleApiKey || '') : (conf.provider === 'groq' ? (conf.groqApiKey || '') : (conf.openaiApiKey || '')))}" style="width:100%;">
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
          <input type="text" value="自動建立「語音辨識」新軌" disabled style="width:100%;opacity:0.75;">
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-dim);">提示詞（Prompt / 專有名詞導引）：</label>
        <input type="text" id="asrPrompt" placeholder="選填，例如：請以繁體中文輸出字幕，包含標點符號。" value="${escapeHTML(conf.prompt || '')}" style="width:100%;">
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

  openModal('🎙 音訊語音辨識生成字幕', html, [
    { label: '取消', act: closeModal },
    {
      label: '🚀 開始辨識',
      primary: true,
      act: async () => {
        const providerEl = document.getElementById('asrProvider');
        const builtinModelEl = document.getElementById('asrBuiltinModel');
        const apiKeyEl = document.getElementById('asrApiKey');
        const langEl = document.getElementById('asrLanguage');
        const promptEl = document.getElementById('asrPrompt');
        const statusEl = document.getElementById('asrStatus');
        const progressContainer = document.getElementById('asrProgressContainer');
        const progressLabel = document.getElementById('asrProgressLabel')?.firstElementChild;
        const progressPercent = document.getElementById('asrProgressPercent');
        const progressBar = document.getElementById('asrProgressBar');
        const modalFoot = document.getElementById('modalFoot');

        const provider = providerEl?.value || 'google';
        const builtinModel = builtinModelEl?.value || 'onnx-community/whisper-large-v3-turbo';
        const apiKey = apiKeyEl?.value?.trim() || '';
        const language = langEl?.value || 'zh';
        const prompt = promptEl?.value || '';

        if ((provider === 'google' || provider === 'groq' || provider === 'openai') && !apiKey) {
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--red)';
            const name = provider === 'google' ? 'Google Gemini' : (provider === 'groq' ? 'Groq' : 'OpenAI');
            statusEl.textContent = `請先輸入 ${name} API Key`;
          }
          apiKeyEl?.focus();
          return;
        }

        // 儲存設定
        const currentConf = getAsrConfig();
        currentConf.provider = provider;
        currentConf.builtinModel = builtinModel;
        if (provider === 'google') currentConf.googleApiKey = apiKey;
        else if (provider === 'groq') currentConf.groqApiKey = apiKey;
        else if (provider === 'openai') currentConf.openaiApiKey = apiKey;
        currentConf.language = language;
        currentConf.prompt = prompt;
        saveAsrConfig(currentConf);

        // 鎖定 UI
        if (modalFoot) {
          const btns = modalFoot.querySelectorAll('button');
          btns.forEach(b => b.disabled = true);
        }
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.style.color = 'var(--accent)';
          statusEl.textContent = '正在準備音訊並進行分析…';
        }

        try {
          const results = [];
          for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            if (statusEl) {
              statusEl.textContent = `[${i + 1}/${clips.length}] 正在萃取「${c.name || '音訊素材'}」之音訊資料…`;
            }
            const audioBuffer = await getClipAudioBuffer(c);
            const inT = Number(c.in) || 0;
            const outT = (c.out && c.out > inT) ? c.out : (inT + (Number(c.dur) || (audioBuffer.duration || 0)));

            if (provider === 'builtin' && progressContainer) {
              progressContainer.style.display = 'flex';
            }

            const segments = await transcribeAudioStream({
              audioBuffer,
              inT,
              outT,
              provider,
              builtinModel,
              apiKey,
              language,
              prompt,
              onProgress: (pInfo) => {
                if (pInfo.status === 'progress' && typeof pInfo.progress === 'number') {
                  const pct = Math.round(pInfo.progress);
                  if (progressBar) progressBar.style.width = pct + '%';
                  if (progressPercent) progressPercent.textContent = pct + '%';
                  if (progressLabel) progressLabel.textContent = `正在下載 AI 模型檔案 (${pInfo.file || ''})…`;
                } else if (pInfo.status === 'transcribing') {
                  if (progressContainer) progressContainer.style.display = 'flex';
                  if (progressBar) progressBar.style.width = (pInfo.percent || 50) + '%';
                  if (progressPercent) progressPercent.textContent = (pInfo.percent || 50) + '%';
                  if (progressLabel) progressLabel.textContent = pInfo.message || `正在推論 (${pInfo.percent || 50}%)…`;
                  if (statusEl) statusEl.textContent = `[${i + 1}/${clips.length}] ${pInfo.message || '本機推論中…'}`;
                } else if (pInfo.status === 'ready' || pInfo.status === 'info') {
                  if (progressLabel) progressLabel.textContent = pInfo.message || '模型已就緒，開始本機推論…';
                }
              }
            });

            results.push({
              clip: c,
              segments
            });
          }

          if (statusEl) {
            statusEl.textContent = '辨識完成，正在寫入專屬字幕軌…';
          }

          const count = insertAsrSubtitles(results);
          closeModal();
          showToast(`🎙 語音辨識完成！已新增字幕軌並生成 ${count} 句字幕。`);
        } catch (err) {
          console.error('ASR error:', err);
          if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = '❌ 辨識失敗：' + (err.message || String(err));
          }
          if (modalFoot) {
            const btns = modalFoot.querySelectorAll('button');
            btns.forEach(b => b.disabled = false);
          }
        }
      }
    }
  ], { width: '480px' });

  // 監聽 Provider 切換以自動更新介面
  setTimeout(() => {
    const providerEl = document.getElementById('asrProvider');
    const apiKeyEl = document.getElementById('asrApiKey');
    const keyLabelEl = document.getElementById('asrKeyLabel');
    const helpEl = document.getElementById('asrKeyHelp');
    const builtinRow = document.getElementById('asrBuiltinRow');
    const keyRow = document.getElementById('asrKeyRow');

    if (providerEl) {
      const updateProviderUI = () => {
        const p = providerEl.value;
        const c = getAsrConfig();

        if (builtinRow) builtinRow.style.display = p === 'builtin' ? 'flex' : 'none';
        if (keyRow) keyRow.style.display = (p === 'google' || p === 'groq' || p === 'openai') ? 'flex' : 'none';

        if (p === 'google' || p === 'groq' || p === 'openai') {
          if (apiKeyEl) {
            apiKeyEl.value = p === 'google'
              ? (c.googleApiKey || '')
              : (p === 'groq' ? (c.groqApiKey || '') : (c.openaiApiKey || ''));
          }
          if (keyLabelEl) {
            keyLabelEl.textContent = p === 'google'
              ? 'Google Gemini API Key：'
              : (p === 'groq' ? 'Groq API Key：' : 'OpenAI API Key：');
          }
          if (helpEl) {
            helpEl.textContent = p === 'google'
              ? '取得 Google 免費 API Key ↗'
              : (p === 'groq' ? '取得 Groq 免費 API Key ↗' : '取得 OpenAI API Key ↗');

            helpEl.onclick = (e) => {
              if (e) e.preventDefault();
              const url = p === 'google'
                ? 'https://aistudio.google.com/app/apikey'
                : (p === 'groq' ? 'https://console.groq.com/keys' : 'https://platform.openai.com/api-keys');
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
      };

      providerEl.onchange = updateProviderUI;
      updateProviderUI();
    }
  }, 0);
}

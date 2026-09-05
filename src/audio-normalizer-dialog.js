/* ==============================================================================
   SUB Tool — 音訊強限制器與 ITU-R BS.1770 效果面板 (src/audio-normalizer-dialog.js)
   ==============================================================================
   致敬專業調音台介面風格，全繁體中文介面。
   支援自訂最大與最小聲音 (dB)、濾鏡啟用/關閉開關、無聲保護、非阻塞背景運算。
   即時顯示運算進度與濾鏡開啟狀態。
============================================================================== */

import { escapeHTML } from './util.js';
import { openModal, closeModal, showToast } from './ui.js';
import { Media, Wave } from './media.js';
import { AudioEngine } from './audio-engine.js';
import { State, IS_DESKTOP } from './state.js';
import { Seq } from './sequence.js';
import { drawTimeline } from './timeline-renderer.js';
import { recordHistory } from './history.js';
import { emit } from './events.js';
import {
  HARD_LIMITER_PRESETS,
  normalizeLimiterOptions,
  analyzePeaksLoudness,
} from '../shared/audio-loudness.cjs';

const DESK = typeof window !== 'undefined' ? window.subtool : null;

/**
 * 解析與當前音訊來源關聯的所有目標物件（包括外部音訊資產、Seq 片段與主影片）
 */
export function resolveAudioTargets(audioSource) {
  const targets = new Set();
  const rawTarget = audioSource?.target || audioSource?.source || audioSource?.asset || audioSource;
  if (rawTarget && typeof rawTarget === 'object') {
    targets.add(rawTarget);
  }

  const id = audioSource?.id || audioSource?.assetId || audioSource?.sourceId;
  const filePath = audioSource?.path || audioSource?.asset?.path;

  // 1. 外部音訊資產 (Media.externalAudio)
  if (Media?.externalAudio) {
    if (id) {
      const a = Media.externalAudio.find?.(id) || Media.externalAudio.get?.(id);
      if (a) targets.add(a);
    }
    for (const a of Media.externalAudio.list?.() || []) {
      if (a && ((id && (a.id === id || a.audioSourceId === id)) || (filePath && a.path === filePath))) {
        targets.add(a);
      }
    }
  }

  // 2. State.externalAudioState
  if (Array.isArray(State?.externalAudioState)) {
    for (const a of State.externalAudioState) {
      if (a && ((id && (a.id === id || a.audioSourceId === id)) || (filePath && a.path === filePath))) {
        targets.add(a);
      }
    }
  }

  // 3. 視訊/音訊片段 (State.clips)
  if (Array.isArray(State?.clips)) {
    for (const clip of State.clips) {
      if (!clip) continue;
      const isMatch = (id && (clip.id === id || clip.audioSourceId === id || clip.audioSrc === id))
        || (filePath && clip.path === filePath)
        || (audioSource?.isPrimary && (clip.primary || clip.audioSrc === 'video'))
        || (id === 'video' && (clip.primary || clip.audioSrc === 'video'));
      if (isMatch) {
        targets.add(clip);
      }
    }
  }

  // 4. Seq 片段
  if (id && typeof Seq?.byId === 'function') {
    const clip = Seq.byId(id);
    if (clip) targets.add(clip);
  }

  if (targets.size === 0 && audioSource) {
    targets.add(audioSource);
  }

  return Array.from(targets);
}

/**
 * 開啟強限制器／音訊平衡化對話框
 * @param {Object} audioSource { id, path, name, duration, asset, isPrimary, target }
 */
export function openHardLimiterDialog(audioSource) {
  if (!IS_DESKTOP || !DESK?.normalizeAudio) {
    showToast('音訊強限制器效果僅在桌面版提供');
    return;
  }

  const filePath = audioSource?.path || audioSource?.asset?.path;
  if (!filePath) {
    showToast('找不到音訊來源檔案路徑，無法套用效果');
    return;
  }

  const targets = resolveAudioTargets(audioSource);
  const appliedTarget = targets.find(t => t.hasAudioLimiter || t._originalPath);
  const hasApplied = Boolean(appliedTarget);
  const sourceName = audioSource?.name || targets[0]?.name || '音訊素材';

  // 取得既有波形進行 0ms 快速聲量估算
  const currentPeaks = targets.find(t => t.peaks)?.peaks || (audioSource.isPrimary ? Wave.peaks : null);
  const initialAnalysis = currentPeaks ? analyzePeaksLoudness(currentPeaks) : null;
  let latestAnalysis = initialAnalysis;

  let isFilterEnabled = hasApplied ? Boolean(appliedTarget.hasAudioLimiter) : true;
  let currentOptions;
  if (appliedTarget?.audioLimiterSpec) {
    const s = appliedTarget.audioLimiterSpec;
    currentOptions = normalizeLimiterOptions({
      maximumAmplitude: s.max,
      targetLoudness: s.min,
      inputBoost: +(Math.abs(s.max - s.min)).toFixed(1),
      lookAheadTime: s.lookAhead ?? 7,
      releaseTime: s.release ?? 100,
      isTruePeak: s.isTruePeak ?? true,
      linkChannels: s.linkChannels ?? true,
      silenceProtection: s.silenceProtection ?? true,
    });
  } else {
    currentOptions = normalizeLimiterOptions({
      preset: 'balance_minus_12_to_minus_6',
      maximumAmplitude: -6.0,
      inputBoost: 6.0,
      targetLoudness: -12.0,
      isTruePeak: true,
      lookAheadTime: 7,
      releaseTime: 100,
      linkChannels: true,
      silenceProtection: true,
    });
  }

  const presetOptionsHtml = HARD_LIMITER_PRESETS.map(p => `
    <option value="${escapeHTML(p.id)}" ${p.id === currentOptions.preset ? 'selected' : ''}>
      ${escapeHTML(p.label)}
    </option>
  `).join('');

  const html = `
    <div class="hard-limiter-panel" style="color:#d4d4d8;font-family:system-ui,-apple-system,sans-serif;padding:2px 4px;user-select:none;box-sizing:border-box;">
      <style>
        .hl-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
        .hl-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .hl-row:last-child { margin-bottom: 0; }
        .hl-title { font-size: 11px; font-weight: 700; color: #a1a1aa; letter-spacing: 0.05em; text-transform: uppercase; }
        .hl-label { font-size: 12px; color: #a1a1aa; flex: 0 0 135px; }
        .hl-ctrl { flex: 1; display: flex; align-items: center; gap: 8px; }
        .hl-slider { flex: 1; accent-color: #3b82f6; cursor: pointer; height: 4px; margin: 0; }
        .hl-input-num { width: 58px; height: 24px; background: #09090b; border: 1px solid #3f3f46; border-radius: 4px; color: #38bdf8; font-size: 12px; font-weight: 600; text-align: right; padding: 1px 4px; font-family: monospace; outline: none; }
        .hl-input-num:focus { border-color: #38bdf8; }
        .hl-unit { font-size: 11px; color: #71717a; width: 22px; }
        .hl-select { background: #18181b; color: #fafafa; border: 1px solid #3f3f46; border-radius: 5px; padding: 3px 8px; font-size: 12px; width: 100%; outline: none; }
        .hl-select:focus { border-color: #38bdf8; }
        .hl-chk-label { font-size: 12px; color: #e4e4e7; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      </style>

      <!-- 濾鏡當前狀態指示區（醒目膠囊） -->
      <div class="hl-card" id="hlStatusBanner" style="background:${hasApplied ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.03)'};border-color:${hasApplied ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.08)'};">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="hlStatusIcon" style="font-size:16px;">${hasApplied ? '🟢' : '⚪'}</span>
            <div>
              <div id="hlStatusTitle" style="font-size:13px;font-weight:700;color:${hasApplied ? '#4ade80' : '#e4e4e7'};">
                ${hasApplied ? `濾鏡目前狀態：已開啟 (${appliedTarget.audioLimiterLabel || currentOptions.maximumAmplitude + ' dB'})` : '濾鏡目前狀態：未開啟（原音）'}
              </div>
              <div id="hlStatusDesc" style="font-size:11px;color:#a1a1aa;margin-top:2px;">
                ${hasApplied ? '當前音訊正在使用強限制器平衡化處理。' : '目前音訊使用原始無失真波形與音質。'}
              </div>
            </div>
          </div>
          <div id="hlStatusBadge" style="font-size:11px;padding:2px 8px;border-radius:12px;font-weight:600;background:${hasApplied ? 'rgba(34,197,94,0.18)' : 'rgba(113,113,122,0.2)'};color:${hasApplied ? '#86efac' : '#a1a1aa'};border:1px solid ${hasApplied ? 'rgba(34,197,94,0.35)' : 'rgba(113,113,122,0.3)'};">
            ${hasApplied ? '已生效' : '未啟用'}
          </div>
        </div>
      </div>

      <!-- 濾鏡開關與預設集 -->
      <div class="hl-card">
        <div class="hl-row" style="margin-bottom:8px;">
          <label class="hl-chk-label" style="font-weight:600;color:#38bdf8;">
            <input type="checkbox" id="hlToggleEnable" ${isFilterEnabled ? 'checked' : ''}>
            開啟音訊平衡化濾鏡
          </label>
          <span style="font-size:11px;color:#71717a;">未啟用時還原原音</span>
        </div>
        <div class="hl-row">
          <span class="hl-title">預設集：</span>
          <div style="flex:1;">
            <select id="hlPresetSelect" class="hl-select">
              <option value="custom">自訂數值 (Custom)</option>
              ${presetOptionsHtml}
            </select>
          </div>
        </div>
      </div>

      <!-- 目前音訊聲量分析 -->
      <div class="hl-card" style="background:rgba(24,24,27,0.7);border-color:rgba(59,130,246,0.3);position:relative;">
        <div class="hl-row" style="margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="hl-title" style="color:#60a5fa;display:flex;align-items:center;gap:4px;">
              📊 目前音訊聲量分析
            </span>
            <span id="hlAnalysisStatus" style="font-size:10px;padding:1px 6px;border-radius:10px;border:1px solid rgba(59,130,246,0.3);color:#93c5fd;background:rgba(59,130,246,0.1);">
              ${initialAnalysis && initialAnalysis.maxDb > -90 ? '⚡ 快速預覽' : '⏳ 量測中…'}
            </span>
          </div>
          <button type="button" id="hlBtnApplySuggestion" style="font-size:11px;background:rgba(59,130,246,0.18);border:1px solid rgba(59,130,246,0.45);color:#bfdbfe;border-radius:4px;padding:2px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;" title="根據測得的聲量分佈，自動設定合理的最大與最小聲音參數">
            💡 帶入建議設定
          </button>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px;">
          <div style="background:#09090b;border:1px solid #27272a;border-radius:6px;padding:6px 2px;text-align:center;">
            <div style="font-size:10px;color:#71717a;margin-bottom:2px;">最大聲量</div>
            <div id="hlAnalyzedMax" style="font-size:13px;font-weight:700;color:#f87171;font-family:monospace;">
              ${initialAnalysis && initialAnalysis.maxDb > -90 ? initialAnalysis.maxDb + ' dB' : '-- dB'}
            </div>
          </div>
          <div style="background:#09090b;border:1px solid #27272a;border-radius:6px;padding:6px 2px;text-align:center;">
            <div style="font-size:10px;color:#71717a;margin-bottom:2px;">平均聲量</div>
            <div id="hlAnalyzedMean" style="font-size:13px;font-weight:700;color:#38bdf8;font-family:monospace;">
              ${initialAnalysis && initialAnalysis.meanDb > -90 ? initialAnalysis.meanDb + ' dB' : '-- dB'}
            </div>
          </div>
          <div style="background:#09090b;border:1px solid #27272a;border-radius:6px;padding:6px 2px;text-align:center;">
            <div style="font-size:10px;color:#71717a;margin-bottom:2px;">最小聲量</div>
            <div id="hlAnalyzedMin" style="font-size:13px;font-weight:700;color:#34d399;font-family:monospace;">
              ${initialAnalysis && initialAnalysis.minDb > -90 ? initialAnalysis.minDb + ' dB' : '-- dB'}
            </div>
          </div>
          <div style="background:#09090b;border:1px solid #27272a;border-radius:6px;padding:6px 2px;text-align:center;">
            <div style="font-size:10px;color:#71717a;margin-bottom:2px;">動態範圍</div>
            <div id="hlAnalyzedDR" style="font-size:13px;font-weight:700;color:#c084fc;font-family:monospace;">
              ${initialAnalysis ? initialAnalysis.dynamicRangeDb + ' dB' : '-- dB'}
            </div>
          </div>
        </div>

        <div id="hlAnalysisHint" style="font-size:11px;color:#a1a1aa;line-height:1.4;">
          ${initialAnalysis && initialAnalysis.maxDb > -90
            ? `目前最大 <b>${initialAnalysis.maxDb} dB</b>、平均 <b>${initialAnalysis.meanDb} dB</b>，建議最大限制於 <b>-6.0 dB</b>，最小平衡於 <b>${Math.max(-24, Math.min(-6, initialAnalysis.meanDb + 6)).toFixed(1)} dB</b>。`
            : '正在後台分析音訊整體響度與動態分佈…'}
        </div>
      </div>

      <!-- 核心聲音設定：最大與最小 dB -->
      <div class="hl-card">
        <div class="hl-row" style="margin-bottom:10px;">
          <span class="hl-title">聲音範圍與目標</span>
          <div style="display:flex;gap:14px;font-size:11px;">
            <label class="hl-chk-label">
              <input type="radio" name="hlPeakMode" id="hlTruePeakRadio" value="true_peak" checked> 真實峰值 (ITU 1770)
            </label>
            <label class="hl-chk-label">
              <input type="radio" name="hlPeakMode" id="hlPeakRadio" value="peak"> 一般峰值 (Peak)
            </label>
          </div>
        </div>

        <!-- 最大聲音 -->
        <div class="hl-row">
          <span class="hl-label" title="限制之最高聲音峰值上限，絕對不超出此數值">最大聲音 (上限)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlMaxAmp" class="hl-slider" min="-100" max="0" step="0.5" value="${currentOptions.maximumAmplitude}">
            <input type="number" id="hlMaxAmpNum" class="hl-input-num" min="-100" max="0" step="0.5" value="${currentOptions.maximumAmplitude}">
            <span class="hl-unit">dB</span>
          </div>
        </div>

        <!-- 最小聲音 -->
        <div class="hl-row">
          <span class="hl-label" title="整體音訊目標響度，較小聲音將被平衡提升至此">最小聲音 (目標)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlMinAmp" class="hl-slider" min="-70" max="-5" step="0.5" value="${currentOptions.targetLoudness}">
            <input type="number" id="hlMinAmpNum" class="hl-input-num" min="-70" max="-5" step="0.5" value="${currentOptions.targetLoudness}">
            <span class="hl-unit">dB</span>
          </div>
        </div>
      </div>

      <!-- 進階動態參數 -->
      <div class="hl-card" style="margin-bottom:8px;">
        <div class="hl-row">
          <span class="hl-label">預讀緩衝 (Look-Ahead)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlLookAhead" class="hl-slider" min="1" max="20" step="1" value="${currentOptions.lookAheadTime}">
            <input type="number" id="hlLookAheadNum" class="hl-input-num" min="1" max="20" step="1" value="${currentOptions.lookAheadTime}">
            <span class="hl-unit">ms</span>
          </div>
        </div>
        <div class="hl-row">
          <span class="hl-label">釋放時間 (Release)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlRelease" class="hl-slider" min="10" max="200" step="5" value="${currentOptions.releaseTime}">
            <input type="number" id="hlReleaseNum" class="hl-input-num" min="10" max="200" step="5" value="${currentOptions.releaseTime}">
            <span class="hl-unit">ms</span>
          </div>
        </div>
        <div class="hl-row" style="margin-top:6px;gap:16px;justify-content:flex-start;">
          <label class="hl-chk-label">
            <input type="checkbox" id="hlLinkChannels" checked> 聲道鏈結
          </label>
          <label class="hl-chk-label" title="若偵測為無聲段落，維持 0 dB 增益，絕不放大底噪">
            <input type="checkbox" id="hlSilenceProtection" checked> 無聲保護 (維持 0 dB)
          </label>
        </div>
      </div>
    </div>
  `;

  const buttons = [
    {
      label: '關閉',
      act: closeModal,
    },
  ];

  if (hasApplied) {
    buttons.push({
      label: '還原原音',
      act: () => {
        closeModal({ committed: true });
        revertAudioToOriginal(audioSource);
      },
    });
  }

  buttons.push({
    label: '套用',
    primary: true,
    act: () => {
      // 點擊「套用」立即關閉視窗，轉為背景非阻塞作業！
      closeModal({ committed: true });

      if (!isFilterEnabled) {
        // 若使用者關閉了濾鏡，則直接還原原音
        revertAudioToOriginal(audioSource);
        return;
      }

      // 背景執行平衡化運算
      runNormalizationInBackground(audioSource, currentOptions);
    },
  });

  openModal(`音訊效果 — 強限制器／平衡化 (ITU 1770) — ${escapeHTML(sourceName)}`, html, buttons, {
    width: '450px',
  });

  // 綁定雙向 UI 互動與即時輸入
  const toggleEnable = document.getElementById('hlToggleEnable');
  const presetSel = document.getElementById('hlPresetSelect');
  const maxAmpSlider = document.getElementById('hlMaxAmp');
  const maxAmpNum = document.getElementById('hlMaxAmpNum');
  const minAmpSlider = document.getElementById('hlMinAmp');
  const minAmpNum = document.getElementById('hlMinAmpNum');
  const lookSlider = document.getElementById('hlLookAhead');
  const lookNum = document.getElementById('hlLookAheadNum');
  const relSlider = document.getElementById('hlRelease');
  const relNum = document.getElementById('hlReleaseNum');
  const peakRadio = document.getElementById('hlPeakRadio');
  const truePeakRadio = document.getElementById('hlTruePeakRadio');
  const linkChk = document.getElementById('hlLinkChannels');
  const silenceChk = document.getElementById('hlSilenceProtection');

  // 狀態 Banner 元件
  const statusBanner = document.getElementById('hlStatusBanner');
  const statusIcon = document.getElementById('hlStatusIcon');
  const statusTitle = document.getElementById('hlStatusTitle');
  const statusDesc = document.getElementById('hlStatusDesc');
  const statusBadge = document.getElementById('hlStatusBadge');

  function updateStatusBanner() {
    if (!statusBanner) return;
    if (!isFilterEnabled) {
      statusBanner.style.background = 'rgba(234, 179, 8, 0.08)';
      statusBanner.style.borderColor = 'rgba(234, 179, 8, 0.35)';
      if (statusIcon) statusIcon.textContent = '⚪';
      if (statusTitle) {
        statusTitle.textContent = hasApplied ? '濾鏡目前狀態：準備關閉（套用後還原原音）' : '濾鏡目前狀態：未開啟（原音）';
        statusTitle.style.color = '#fbbf24';
      }
      if (statusDesc) {
        statusDesc.textContent = hasApplied ? '點擊「套用」將還原為原始無失真音訊。' : '目前音訊維持原始音質。';
      }
      if (statusBadge) {
        statusBadge.textContent = hasApplied ? '準備關閉' : '未啟用';
        statusBadge.style.color = '#fde047';
        statusBadge.style.background = 'rgba(234, 179, 8, 0.15)';
        statusBadge.style.borderColor = 'rgba(234, 179, 8, 0.3)';
      }
    } else {
      statusBanner.style.background = 'rgba(34, 197, 94, 0.08)';
      statusBanner.style.borderColor = 'rgba(34, 197, 94, 0.35)';
      if (statusIcon) statusIcon.textContent = '🟢';
      if (statusTitle) {
        statusTitle.textContent = `濾鏡目前狀態：${hasApplied ? '已開啟' : '準備開啟'} (${currentOptions.maximumAmplitude} dB)`;
        statusTitle.style.color = '#4ade80';
      }
      if (statusDesc) {
        statusDesc.textContent = `最大聲音限制於 ${currentOptions.maximumAmplitude} dB，目標聲音平衡於 ${currentOptions.targetLoudness} dB。`;
      }
      if (statusBadge) {
        statusBadge.textContent = hasApplied ? '已生效' : '準備開啟';
        statusBadge.style.color = '#86efac';
        statusBadge.style.background = 'rgba(34, 197, 94, 0.18)';
        statusBadge.style.borderColor = 'rgba(34, 197, 94, 0.35)';
      }
    }
  }

  function updateUi() {
    maxAmpSlider.value = currentOptions.maximumAmplitude;
    maxAmpNum.value = currentOptions.maximumAmplitude;
    minAmpSlider.value = currentOptions.targetLoudness;
    minAmpNum.value = currentOptions.targetLoudness;
    lookSlider.value = currentOptions.lookAheadTime;
    lookNum.value = currentOptions.lookAheadTime;
    relSlider.value = currentOptions.releaseTime;
    relNum.value = currentOptions.releaseTime;
    peakRadio.checked = !currentOptions.isTruePeak;
    truePeakRadio.checked = currentOptions.isTruePeak;
    linkChk.checked = currentOptions.linkChannels;
    silenceChk.checked = currentOptions.silenceProtection;
    updateStatusBanner();
  }

  toggleEnable.onchange = () => {
    isFilterEnabled = toggleEnable.checked;
    updateStatusBanner();
  };

  presetSel.onchange = () => {
    const found = HARD_LIMITER_PRESETS.find(p => p.id === presetSel.value);
    if (found) {
      currentOptions = normalizeLimiterOptions(found);
      updateUi();
    }
  };

  // 最大聲音滑桿與數值輸入框雙向綁定
  maxAmpSlider.oninput = () => {
    currentOptions.maximumAmplitude = +maxAmpSlider.value;
    maxAmpNum.value = currentOptions.maximumAmplitude;
    presetSel.value = 'custom';
    updateStatusBanner();
  };
  maxAmpNum.onchange = () => {
    const val = Math.max(-100, Math.min(0, Number(maxAmpNum.value) || -6));
    currentOptions.maximumAmplitude = +val.toFixed(1);
    maxAmpSlider.value = currentOptions.maximumAmplitude;
    maxAmpNum.value = currentOptions.maximumAmplitude;
    presetSel.value = 'custom';
    updateStatusBanner();
  };

  // 最小聲音滑桿與數值輸入框雙向綁定
  minAmpSlider.oninput = () => {
    currentOptions.targetLoudness = +minAmpSlider.value;
    minAmpNum.value = currentOptions.targetLoudness;
    currentOptions.inputBoost = +(Math.abs(currentOptions.maximumAmplitude - currentOptions.targetLoudness)).toFixed(1);
    presetSel.value = 'custom';
    updateStatusBanner();
  };
  minAmpNum.onchange = () => {
    const val = Math.max(-70, Math.min(-5, Number(minAmpNum.value) || -12));
    currentOptions.targetLoudness = +val.toFixed(1);
    minAmpSlider.value = currentOptions.targetLoudness;
    minAmpNum.value = currentOptions.targetLoudness;
    currentOptions.inputBoost = +(Math.abs(currentOptions.maximumAmplitude - currentOptions.targetLoudness)).toFixed(1);
    presetSel.value = 'custom';
    updateStatusBanner();
  };

  lookSlider.oninput = () => {
    currentOptions.lookAheadTime = +lookSlider.value;
    lookNum.value = currentOptions.lookAheadTime;
    presetSel.value = 'custom';
  };
  lookNum.onchange = () => {
    currentOptions.lookAheadTime = Math.max(1, Math.min(20, Math.round(Number(lookNum.value) || 7)));
    lookSlider.value = currentOptions.lookAheadTime;
    lookNum.value = currentOptions.lookAheadTime;
    presetSel.value = 'custom';
  };

  relSlider.oninput = () => {
    currentOptions.releaseTime = +relSlider.value;
    relNum.value = currentOptions.releaseTime;
    presetSel.value = 'custom';
  };
  relNum.onchange = () => {
    currentOptions.releaseTime = Math.max(10, Math.min(200, Math.round(Number(relNum.value) || 100)));
    relSlider.value = currentOptions.releaseTime;
    relNum.value = currentOptions.releaseTime;
    presetSel.value = 'custom';
  };

  peakRadio.onchange = () => {
    currentOptions.isTruePeak = false;
    presetSel.value = 'custom';
  };

  truePeakRadio.onchange = () => {
    currentOptions.isTruePeak = true;
    presetSel.value = 'custom';
  };

  linkChk.onchange = () => {
    currentOptions.linkChannels = linkChk.checked;
  };

  silenceChk.onchange = () => {
    currentOptions.silenceProtection = silenceChk.checked;
  };

  // 帶入建議設定按鈕
  const btnApplySuggestion = document.getElementById('hlBtnApplySuggestion');
  if (btnApplySuggestion) {
    btnApplySuggestion.onclick = () => {
      if (!latestAnalysis || latestAnalysis.maxDb <= -80) {
        showToast('目前尚無足夠的聲量分析數據可供參考');
        return;
      }
      const suggestedMax = -6.0;
      const rawMin = Math.round(latestAnalysis.meanDb + 6);
      const suggestedMin = Math.min(suggestedMax - 2, Math.max(-24, rawMin));

      currentOptions.maximumAmplitude = suggestedMax;
      currentOptions.targetLoudness = suggestedMin;
      currentOptions.inputBoost = +(Math.abs(currentOptions.maximumAmplitude - currentOptions.targetLoudness)).toFixed(1);
      presetSel.value = 'custom';
      updateUi();
      showToast(`已帶入建議設定：最大 ${suggestedMax} dB，目標 ${suggestedMin} dB`);
    };
  }

  // 非同步呼叫後台 FFmpeg 進行精準聲量量測 (ITU-R BS.1770)
  const duration = audioSource?.duration || audioSource?.asset?.duration || 0;
  if (DESK?.analyzeAudioLoudness && filePath) {
    DESK.analyzeAudioLoudness(filePath, duration).then(res => {
      if (!res) return;
      latestAnalysis = res;
      const maxEl = document.getElementById('hlAnalyzedMax');
      const meanEl = document.getElementById('hlAnalyzedMean');
      const minEl = document.getElementById('hlAnalyzedMin');
      const drEl = document.getElementById('hlAnalyzedDR');
      const tagEl = document.getElementById('hlAnalysisStatus');
      const hintEl = document.getElementById('hlAnalysisHint');

      if (maxEl) maxEl.textContent = `${res.maxDb > -90 ? res.maxDb : '無聲'} dB`;
      if (meanEl) meanEl.textContent = `${res.meanDb > -90 ? res.meanDb : '無聲'} dB`;
      if (minEl) minEl.textContent = `${res.minDb > -90 ? res.minDb : '極小'} dB`;
      if (drEl) drEl.textContent = `${res.dynamicRangeDb} dB`;
      if (tagEl) {
        tagEl.textContent = '🎯 精準量測 (ITU 1770)';
        tagEl.style.color = '#34d399';
        tagEl.style.borderColor = 'rgba(52,211,153,0.4)';
        tagEl.style.background = 'rgba(52,211,153,0.1)';
      }
      if (hintEl) {
        const suggestedMin = Math.max(-24, Math.min(-8, Math.round(res.meanDb + 6)));
        hintEl.innerHTML = `目前最大 <b>${res.maxDb} dB</b>、平均 <b>${res.meanDb} dB</b>，建議最大限制於 <b>-6.0 dB</b>，最小平衡於 <b>${suggestedMin} dB</b>。`;
      }
    }).catch(err => {
      console.warn('[HardLimiter] 背景量測失敗：', err);
    });
  }
}

/**
 * 在背景執行音訊平衡化運算（完全不阻塞視窗，即時回報進度）
 */
async function runNormalizationInBackground(audioSource, options) {
  const filePath = audioSource?.path || audioSource?.asset?.path;
  const targets = resolveAudioTargets(audioSource);

  // 1. 立即設定為運算中狀態，並觸發時間軸重繪
  for (const t of targets) {
    t.audioNormalizing = true;
    t.audioNormalizeProgress = 0;
    t.audioNormalizeLabel = '準備運算…';
  }
  drawTimeline();

  showToast(`🎧 正在背景執行音訊平衡化（最大 ${options.maximumAmplitude} dB，目標 ${options.targetLoudness} dB）…`, 3500);

  // 2. 監聽主行程回報之進度（Pass 1 0~45%, Pass 2 45~100%）
  let unsubscribe = null;
  if (DESK?.onAudioNormalizeProgress) {
    unsubscribe = DESK.onAudioNormalizeProgress(data => {
      if (data.src && data.src !== filePath) return;
      const pct = Math.max(0, Math.min(100, Math.round(Number(data.pct) || 0)));
      const stageLabel = data.label || (data.stage === 'pass1' ? '分析響度' : '平衡化處理');
      for (const t of targets) {
        t.audioNormalizeProgress = pct;
        t.audioNormalizeLabel = stageLabel;
      }

      // 高效局部更新 DOM，避免頻繁重繪整張時間軸造成畫面閃爍
      const blocks = document.querySelectorAll('.audio-clip-block.is-normalizing');
      for (const b of blocks) {
        const badge = b.querySelector('.audio-clip-fx-badge.processing');
        if (badge) {
          badge.innerHTML = `<span class="fx-spin">⏳</span> 運算中 ${pct}%`;
          badge.title = `正在進行音訊平衡化處理 (${pct}%)：${stageLabel}`;
        }
        let bar = b.querySelector('.audio-clip-progress-bar');
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'audio-clip-progress-bar';
          b.appendChild(bar);
        }
        bar.style.width = `${pct}%`;
      }

      // 同步更新全域狀態列
      const statusEl = document.getElementById('stStatus') || document.getElementById('stSel');
      if (statusEl) {
        statusEl.textContent = `⏳ 音訊平衡化處理中 ${pct}%（${stageLabel}）…`;
      }
    });
  }

  try {
    const duration = audioSource?.duration || audioSource?.asset?.duration || 0;
    const res = await DESK.normalizeAudio(filePath, options, duration);

    if (!res || !res.outputPath) {
      throw new Error('平衡化處理未傳回有效的輸出檔案');
    }

    const newPath = res.outputPath;

    // 重新取得 WAV 並重新計算波形
    const wavUrl = await DESK.fileURL(newPath);
    const buf = await fetch(wavUrl).then(r => r.arrayBuffer());
    let pk = Wave.calcFromWav(buf);
    if (!pk) {
      const ab = await AudioEngine.decodeAudioData(buf);
      pk = Wave.calcPeaks(ab, -1);
    }

    for (const target of targets) {
      const isVideoClip = target.primary || target.audioSrc === 'video' || (target.type && target.type !== 'audio');
      if (!isVideoClip) {
        if (!target._originalPath) target._originalPath = target.path || filePath;
        target.path = newPath;
      } else {
        // 視訊片段絕對不可更改 target.path！保留原始視訊路徑，僅記錄平衡化後的音訊路徑
        target.normalizedAudioPath = newPath;
        if (target._originalPath && target.path && target.path.toLowerCase().endsWith('.wav')) {
          target.path = target._originalPath;
        }
      }
      target.hasAudioLimiter = true;
      target.audioLimiterLabel = `${options.maximumAmplitude} dB`;
      target.audioLimiterSpec = {
        max: options.maximumAmplitude,
        min: options.targetLoudness,
        lookAhead: options.lookAheadTime,
        release: options.releaseTime,
        isTruePeak: options.isTruePeak,
        linkChannels: options.linkChannels,
        silenceProtection: options.silenceProtection,
      };

      if (pk) {
        target.peaks = pk;
        Wave.forgetSourceWaveforms(target);
        Wave.setSourceMixPeaks(target, pk, { mixPath: newPath, channels: target.descriptors });
      }
    }

    if (audioSource.isPrimary || audioSource.id === 'video' || targets.some(t => t.primary || t.audioSrc === 'video')) {
      if (pk) Wave.peaks = pk;
    }

    // 更新 Media 播放節點
    const targetIds = new Set(targets.map(t => t.id).concat([audioSource.id, audioSource.audioSourceId]).filter(Boolean));
    const trs = (Media.tracks || []).filter(t =>
      targetIds.has(t.audioSourceId) || targetIds.has(t.source) || (audioSource.isPrimary && (t.source === 'video' || t.audioSourceId === 'video'))
    );
    for (const t of trs) {
      t.file = newPath;
      if (t.el) t.el.src = wavUrl;
    }

    // 若為視訊來源且無 element 軌，建立 Web Audio element 接管平衡化音訊，確保 mpv 正常播視訊
    const isVideoSource = audioSource.isPrimary || audioSource.id === 'video' || targets.some(t => t.primary || t.audioSrc === 'video' || (t.type && t.type !== 'audio'));
    if (isVideoSource && AudioEngine.isReady) {
      const srcKey = audioSource.id || 'video';
      let tr = (Media.tracks || []).find(t => (t.source === srcKey || t.source === 'video') && t.kind === 'element');
      if (!tr) {
        try {
          const el = new Audio();
          el.src = wavUrl;
          el.preload = 'auto';
          const node = AudioEngine.createMediaElementSource(el);
          const g = AudioEngine.createGain();
          node.connect(g);
          AudioEngine.connectToMaster(g);
          tr = {
            id: 'limiter-' + srcKey,
            name: (audioSource.name || '主影片') + ' (平衡化)',
            kind: 'element',
            el,
            gain: g,
            muted: false,
            solo: false,
            volume: 1,
            source: srcKey,
            audioSourceId: srcKey,
            file: newPath,
            _limiterGenerated: true,
          };
          Media.tracks.push(tr);
        } catch (e) {
          console.warn('[HardLimiter] 建立 element 播放音軌失敗：', e);
        }
      } else {
        tr.file = newPath;
        if (tr.el) tr.el.src = wavUrl;
      }
      Media.syncMuteState?.();
      Media.applyGains?.();
    }

    emit('media:timeline');
    emit('media:audioTracks');
    recordHistory(`音訊平衡化：${options.maximumAmplitude} dB ~ ${options.targetLoudness} dB`);

    if (res.isSilence) {
      showToast('ℹ 偵測為無聲段落，已啟用無聲保護維持 0 dB 原音');
    } else {
      showToast(`✅ 音訊平衡化已完成（最大 ${options.maximumAmplitude} dB，目標 ${options.targetLoudness} dB）`);
    }
  } catch (err) {
    console.error('[HardLimiter] 背景處理失敗：', err);
    showToast('❌ 音訊平衡化處理失敗：' + (err.message || String(err)));
  } finally {
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (_) {}
    }
    for (const target of targets) {
      delete target.audioNormalizing;
      delete target.audioNormalizeProgress;
      delete target.audioNormalizeLabel;
    }
    drawTimeline();
  }
}

/**
 * 還原為原始音訊檔案
 */
async function revertAudioToOriginal(audioSource) {
  const targets = resolveAudioTargets(audioSource);
  const appliedTarget = targets.find(t => t._originalPath);
  const origPath = appliedTarget?._originalPath;
  if (!origPath) {
    showToast('目前為原始音訊，無須還原');
    return;
  }

  try {
    const wavUrl = await DESK.fileURL(origPath);
    const buf = await fetch(wavUrl).then(r => r.arrayBuffer());
    let pk = Wave.calcFromWav(buf);
    if (!pk) {
      const ab = await AudioEngine.decodeAudioData(buf);
      pk = Wave.calcPeaks(ab, -1);
    }

    for (const target of targets) {
      const isVideoClip = target.primary || target.audioSrc === 'video' || (target.type && target.type !== 'audio');
      if (!isVideoClip) {
        target.path = target._originalPath || origPath;
      } else {
        delete target.normalizedAudioPath;
        if (target._originalPath) {
          target.path = target._originalPath;
        }
      }
      delete target._originalPath;
      delete target.hasAudioLimiter;
      delete target.audioLimiterLabel;
      delete target.audioLimiterSpec;
      delete target.audioNormalizing;
      delete target.audioNormalizeProgress;
      delete target.audioNormalizeLabel;
      if (pk) {
        target.peaks = pk;
        Wave.forgetSourceWaveforms(target);
        Wave.setSourceMixPeaks(target, pk, { mixPath: origPath, channels: target.descriptors });
      }
    }

    if (audioSource.isPrimary || audioSource.id === 'video' || targets.some(t => t.primary || t.audioSrc === 'video')) {
      if (pk) Wave.peaks = pk;
    }

    const targetIds = new Set(targets.map(t => t.id).concat([audioSource.id, audioSource.audioSourceId]).filter(Boolean));
    const trs = (Media.tracks || []).filter(t =>
      targetIds.has(t.audioSourceId) || targetIds.has(t.source) || (audioSource.isPrimary && (t.source === 'video' || t.audioSourceId === 'video'))
    );
    for (const t of trs) {
      t.file = origPath;
      if (t.el) t.el.src = wavUrl;
    }

    // 移除由平衡化動態產生的 element 播放節點
    if (Array.isArray(Media.tracks)) {
      const idx = Media.tracks.findIndex(t => t._limiterGenerated);
      if (idx !== -1) {
        const tr = Media.tracks[idx];
        if (tr.el) { try { tr.el.pause(); tr.el.src = ''; } catch (_) {} }
        Media.tracks.splice(idx, 1);
      }
    }
    Media.syncMuteState?.();
    Media.applyGains?.();

    drawTimeline();
    emit('media:timeline');
    emit('media:audioTracks');
    recordHistory('還原原始音訊');
    showToast('✅ 已關閉濾鏡並還原原始音訊');
  } catch (err) {
    console.error('[HardLimiter] 還原原音失敗：', err);
    showToast('❌ 還原原音失敗：' + err.message);
  }
}

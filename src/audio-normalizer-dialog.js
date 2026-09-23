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
import { IS_DESKTOP } from './state.js';
import {
  HARD_LIMITER_PRESETS,
  LIMITER_DB_RANGE,
  normalizeLimiterOptions,
  analyzePeaksLoudness,
} from '../shared/audio-loudness.cjs';

const DESK = typeof window !== 'undefined' ? window.subtool : null;

/**
 * 解析與當前音訊來源關聯的所有目標物件（包括外部音訊資產、Seq 片段與主影片）
 */
export function resolveAudioTargets(audioSource) {
  const targets = Media.audioEffects.targets(audioSource);
  const raw = audioSource?.target || audioSource?.asset || audioSource;
  return targets.length ? targets : (raw ? [raw] : []);
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

  let isFilterEnabled = hasApplied ? Boolean(appliedTarget.hasAudioLimiter) : true;
  let currentOptions;
  if (appliedTarget?.audioLimiterSpec) {
    const s = appliedTarget.audioLimiterSpec;
    currentOptions = normalizeLimiterOptions({
      maximumAmplitude: s.max,
      targetLoudness: s.min,
      inputBoost: s.inputBoost ?? +(Math.abs(s.max - s.min)).toFixed(1),
      lookAheadTime: s.lookAhead ?? 7,
      releaseTime: s.release ?? 100,
      isTruePeak: s.isTruePeak ?? true,
      linkChannels: s.linkChannels ?? true,
    });
  } else {
    currentOptions = normalizeLimiterOptions({
      preset: 'custom',
      maximumAmplitude: -6.0,
      inputBoost: 6.0,
      targetLoudness: -12.0,
      isTruePeak: true,
      lookAheadTime: 7,
      releaseTime: 100,
      linkChannels: true,
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
        .hl-ctrl { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
        .hl-slider { --hl-progress: 0%; -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; cursor: pointer; height: 24px; margin: 0; padding: 0; border: 0;
          background: linear-gradient(to right, #3b82f6 0 var(--hl-progress), #3f3f46 var(--hl-progress) 100%) center / calc(100% - 14px) 4px no-repeat; }
        .hl-slider:focus { border: 0; box-shadow: none; }
        .hl-slider::-webkit-slider-runnable-track { height: 4px; background: transparent; border: 0; }
        .hl-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5px; border: 0; border-radius: 50%; background: #3b82f6; }
        .hl-slider::-moz-range-track { height: 4px; background: transparent; border: 0; }
        .hl-slider::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #3b82f6; }
        .hl-slider:focus-visible::-webkit-slider-thumb { outline: 2px solid #bae6fd; outline-offset: 2px; }
        .hl-slider:focus-visible::-moz-range-thumb { outline: 2px solid #bae6fd; outline-offset: 2px; }
        .hl-input-num { flex: 0 0 64px; width: 64px; height: 24px; background: #09090b; border: 1px solid #3f3f46; border-radius: 4px; color: #38bdf8; font-size: 12px; font-weight: 600; text-align: right; padding: 1px 4px; font-family: monospace; outline: none; }
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
              <option value="custom">自訂</option>
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

      </div>

      <!-- 核心聲音設定：最大與最小 dB -->
      <div class="hl-card">
        <div class="hl-row" style="margin-bottom:10px;">
          <span class="hl-title">聲音範圍與目標</span>
          <div style="display:flex;gap:14px;font-size:11px;">
            <label class="hl-chk-label">
              <input type="radio" name="hlPeakMode" id="hlTruePeakRadio" value="true_peak" ${currentOptions.isTruePeak ? 'checked' : ''}> 真實峰值 (ITU 1770)
            </label>
            <label class="hl-chk-label">
              <input type="radio" name="hlPeakMode" id="hlPeakRadio" value="peak" ${currentOptions.isTruePeak ? '' : 'checked'}> 一般峰值 (Peak)
            </label>
          </div>
        </div>

        <!-- 最大聲音 -->
        <div class="hl-row">
          <span class="hl-label" title="限制之最高聲音峰值上限，絕對不超出此數值">最大聲音 (上限)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlMaxAmp" class="hl-slider" min="${LIMITER_DB_RANGE.min}" max="${LIMITER_DB_RANGE.max}" step="0.5" value="${currentOptions.maximumAmplitude}" aria-label="最大聲音上限">
            <input type="number" id="hlMaxAmpNum" class="hl-input-num" min="${LIMITER_DB_RANGE.min}" max="${LIMITER_DB_RANGE.max}" step="0.5" value="${currentOptions.maximumAmplitude}" aria-label="最大聲音上限數值">
            <span class="hl-unit">dB</span>
          </div>
        </div>

        <!-- 最小聲音 -->
        <div class="hl-row">
          <span class="hl-label" title="整體音訊目標響度，較小聲音將被平衡提升至此">最小聲音 (目標)：</span>
          <div class="hl-ctrl">
            <input type="range" id="hlMinAmp" class="hl-slider" min="${LIMITER_DB_RANGE.min}" max="${LIMITER_DB_RANGE.max}" step="0.5" value="${currentOptions.targetLoudness}" aria-label="最小聲音目標">
            <input type="number" id="hlMinAmpNum" class="hl-input-num" min="${LIMITER_DB_RANGE.min}" max="${LIMITER_DB_RANGE.max}" step="0.5" value="${currentOptions.targetLoudness}" aria-label="最小聲音目標數值">
            <span class="hl-unit">dB</span>
          </div>
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
      // Enter 不會先觸發數字欄位的 change；提交前先同步仍在編輯的值。
      const active = document.activeElement;
      if (active?.id === 'hlMaxAmpNum' || active?.id === 'hlMinAmpNum') {
        active.dispatchEvent(new Event('change', { bubbles: true }));
      }
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
    width: '560px',
  });

  // 綁定雙向 UI 互動與即時輸入
  const toggleEnable = document.getElementById('hlToggleEnable');
  const presetSel = document.getElementById('hlPresetSelect');
  const maxAmpSlider = document.getElementById('hlMaxAmp');
  const maxAmpNum = document.getElementById('hlMaxAmpNum');
  const minAmpSlider = document.getElementById('hlMinAmp');
  const minAmpNum = document.getElementById('hlMinAmpNum');
  const peakRadio = document.getElementById('hlPeakRadio');
  const truePeakRadio = document.getElementById('hlTruePeakRadio');

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

  const levelControls = [
    { slider: maxAmpSlider, number: maxAmpNum, key: 'maximumAmplitude' },
    { slider: minAmpSlider, number: minAmpNum, key: 'targetLoudness' },
  ];

  function syncLevelControl({ slider, number, key }, value = currentOptions[key]) {
    // 以 range 的實際值為準，讓數字輸入、舊設定及預設集共用範圍與 0.5 dB 刻度。
    slider.value = Number.isFinite(value) ? value : currentOptions[key];
    const db = slider.valueAsNumber;
    currentOptions[key] = db;
    number.value = db;
    const progress = (db - LIMITER_DB_RANGE.min) / (LIMITER_DB_RANGE.max - LIMITER_DB_RANGE.min);
    slider.style.setProperty('--hl-progress', `${progress * 100}%`);
  }

  function updateUi() {
    levelControls.forEach(control => syncLevelControl(control));
    peakRadio.checked = !currentOptions.isTruePeak;
    truePeakRadio.checked = currentOptions.isTruePeak;
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

  // 滑桿與數字輸入使用同一條更新路徑，避免超界、空值或小數讓位置與數值分離。
  for (const control of levelControls) {
    syncLevelControl(control);
    const changeLevel = value => {
      syncLevelControl(control, value);
      currentOptions.inputBoost = +(Math.abs(currentOptions.maximumAmplitude - currentOptions.targetLoudness)).toFixed(1);
      presetSel.value = 'custom';
      updateStatusBanner();
    };
    control.slider.oninput = () => changeLevel(control.slider.valueAsNumber);
    control.number.onchange = () => changeLevel(control.number.valueAsNumber);
  }
  if (appliedTarget?.audioLimiterSpec && (appliedTarget.audioLimiterSpec.inputBoost == null
      || appliedTarget.audioLimiterSpec.max !== currentOptions.maximumAmplitude
      || appliedTarget.audioLimiterSpec.min !== currentOptions.targetLoudness)) {
    // 舊專案超界值收斂後，以畫面實際顯示的數值重算增益。
    currentOptions.inputBoost = +(Math.abs(currentOptions.maximumAmplitude - currentOptions.targetLoudness)).toFixed(1);
  }

  peakRadio.onchange = () => {
    currentOptions.isTruePeak = false;
    presetSel.value = 'custom';
  };

  truePeakRadio.onchange = () => {
    currentOptions.isTruePeak = true;
    presetSel.value = 'custom';
  };

  // 非同步呼叫後台 FFmpeg 進行精準聲量量測 (ITU-R BS.1770)
  const duration = audioSource?.duration || audioSource?.asset?.duration || 0;
  if (DESK?.analyzeAudioLoudness && filePath) {
    DESK.analyzeAudioLoudness(filePath, duration).then(res => {
      if (!res) return;
      const maxEl = document.getElementById('hlAnalyzedMax');
      const meanEl = document.getElementById('hlAnalyzedMean');
      const minEl = document.getElementById('hlAnalyzedMin');
      const drEl = document.getElementById('hlAnalyzedDR');
      const tagEl = document.getElementById('hlAnalysisStatus');

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
    }).catch(err => {
      console.warn('[HardLimiter] 背景量測失敗：', err);
    });
  }
}

/**
 * 在背景執行音訊平衡化運算（完全不阻塞視窗，即時回報進度）
 */
async function runNormalizationInBackground(audioSource, options) {
  const result = await Media.audioEffects.apply(audioSource, options);
  if (result.status === 'completed') showToast('已套用音訊平衡');
}

async function revertAudioToOriginal(audioSource) {
  const result = await Media.audioEffects.apply(audioSource, null);
  if (result.status === 'completed') showToast('已還原原始音訊');
}

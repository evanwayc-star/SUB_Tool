import { State, IS_DESKTOP, DESK } from './state.js';
import { $ } from './dom.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { sortCues, trackLocked } from './subtitle-model.js';
import { burnedSubtitleTrackNames } from './subtitle-track-names.js';
import { drawTimeline, layoutTimeline } from './timeline.js';
import { emit } from './events.js';
import { getNotesGeneralFileData, getNotesEdiusFileData } from './notes.js';
import { Seq } from './sequence.js';
import { AudioRouting } from './audio-routing.js';
import { applyDeliveryAudioSpec, composeDeliveryAudioPlan, createDeliveryAudioSpec } from './delivery-audio.js';
import { buildExportSnapshot } from './delivery-job.js';
import { anySourceSolo, sourceTrackAudible } from './project-audio.js';
import { createDeliveryList, projectTagFrom } from './delivery-list.js';
import { buildExportJobs, freezeExportSubmission, subtitleCuesForSubmission } from './export-job-builder.js';
import { runFrozenExportSubmission } from './export-submission-transaction.js';
import { videoExportCapability } from './export-capability.js';
import { escapeHTML } from './util.js';
import { Media } from './media.js';
import { measureSubtitleBackgroundLayouts } from './subtitle-background-layout.js';

// Domain imports
import { importSub, importDropped } from './sub-parse.js';
import { applyTcShift, applyDurAdjTc, applyDurAdjPct } from './timeline-edit-batch.js';
import { getFileData, getXLSXFileData, toASSFromState, executeBatchExport, doExportXLSX } from './ffmpeg-export.js';

function showFpsConvertDialog() {
  const tkIdx = State.listTrack;
  const tk = State.tracks[tkIdx];
  if (!tk) { showToast('請先選擇一個字幕軌道'); return; }
  if (trackLocked(tkIdx, '轉換字幕時間碼')) return;
  const FPS_OPTS = [23.976, 24, 25, 29.97, 30];
  const opts = FPS_OPTS.map(f => `<option value="${f}">${f === 23.976 ? '23.976 (23.98)' : f === 29.97 ? '29.97' : '' + f}</option>`).join('');
  const curFps = State.fps;
  openModal('FPS 時間碼轉換',
    `<div style="margin-bottom:12px;font-size:13px;color:var(--text-faint)">軌道：<b>${escapeHTML(tk.name)}</b></div>` +
    `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">` +
    `<div><div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">來源 FPS</div>` +
    `<select id="fpsFrom" style="font-size:14px;padding:4px 8px">${opts}</select></div>` +
    `<div style="padding-top:18px;display:flex;flex-direction:column;align-items:center;gap:2px"><span style="font-size:20px;color:var(--text-faint)">→</span><button id="fpsSwap" style="font-size:11px;padding:2px 6px;cursor:pointer" title="交換來源與目標">⇄ 交換</button></div>` +
    `<div><div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">目標 FPS</div>` +
    `<select id="fpsTo" style="font-size:14px;padding:4px 8px">${opts}</select></div>` +
    `</div>` +
    `<div id="fpsPreview" style="margin-top:14px;font-size:12px;color:var(--text-faint)"></div>`,
    [{
      label: '轉換', primary: true, act: () => {
        const from = +$('fpsFrom').value, to = +$('fpsTo').value;
        if (from === to) { closeModal(); return; }
        const ratio = from / to;
        const fr = 1 / Math.max(State.fps || 25, 1);
        const cues = State.cues.filter(c => (c.track || 0) === tkIdx);
        for (const c of cues) {
          c.start = snapTimeToFrame(Math.max(0, c.start * ratio), State.fps, State.dropFrame);
          let ne = snapTimeToFrame(c.end * ratio, State.fps, State.dropFrame);
          if (ne < c.start + fr) ne = c.start + fr;
          c.end = ne;
        }
        const maxEnd = State.cues.reduce((m, c) => c.end > m ? c.end : m, 0);
        if (maxEnd > State.duration) { State.duration = maxEnd; $('tcDur').textContent = secToEncore(maxEnd, State.fps, State.dropFrame); }
        closeModal(); sortCues(); emit('render:all'); layoutTimeline(); drawTimeline();
        recordHistory(`FPS 轉換 ${from}→${to}`);
        setStatus(`已將「${tk.name}」從 ${from}fps 轉換至 ${to}fps（${cues.length} 條）`, 'ok');
      }
    }, { label: '取消', act: closeModal }]);
  setTimeout(() => {
    const fromSel = $('fpsFrom'), toSel = $('fpsTo');
    const nearest = FPS_OPTS.reduce((a, b) => Math.abs(b - curFps) < Math.abs(a - curFps) ? b : a);
    if (toSel) toSel.value = String(nearest);

    if (fromSel && toSel) {
      const setFromDefault = () => {
        const t = +toSel.value;
        if (t === 29.97) fromSel.value = "30";
        else if (t === 23.976) fromSel.value = "24";
        else if (t === 30) fromSel.value = "29.97";
        else if (t === 24) fromSel.value = "23.976";
      };
      setFromDefault();
      toSel.addEventListener('change', setFromDefault);
    }

    const updatePreview = () => {
      const from = +fromSel?.value, to = +toSel?.value;
      const p = $('fpsPreview'); if (!p) return;
      if (from === to) { p.textContent = '來源與目標相同，無需轉換。'; return; }
      const ratio = from / to;
      p.innerHTML = `比例 <b>${from}/${to} = ${ratio.toFixed(6)}</b>　·　例：1:00:00 → ${new Date(3600 * ratio * 1000).toISOString().slice(11, 22)}`;
    };
    fromSel?.addEventListener('change', updatePreview);
    toSel?.addEventListener('change', updatePreview);
    $('fpsSwap')?.addEventListener('click', () => { const tmp = fromSel.value; fromSel.value = toSel.value; toSel.value = tmp; updatePreview(); });
    updatePreview();
  }, 30);
}

function showExportDialog() {
  if (!State.cues.length && !State.notes.length) { showToast('沒有字幕或備註可匯出'); return; }

  const sec = (title, body) => `<div style="margin-bottom:20px"><div style="font-size:14px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${title}</div>${body}</div>`;
  const cb = (attrs, label) => `<label style="display:flex;align-items:center;padding:6px 0;cursor:pointer;font-size:15px;color:#e2e2e2;"><input type="checkbox" ${attrs} style="transform:scale(1.2);margin-right:8px;"> ${label}</label>`;

  let html = sec('字幕格式',
    [['encore', 'Adobe Encore (.txt)', true, false], ['srt', 'SRT (.srt)', false, true], ['ass', 'ASS (.ass)', false, true], ['txt', '純文字 (.txt)', false, false], ['xlsx', 'Excel (.xlsx)', false, false]]
      .map(([v, l, d, supportMerge]) => {
        let row = cb(`data-fmt="${v}"${d ? ' checked' : ''}`, escapeHTML(l));
        if (supportMerge && State.cues.length && State.trackCount > 1) {
          row = `<div style="display:flex;align-items:center;gap:16px;">
            ${row}
            ${cb(`id="merge_${v}"`, '合成單一檔案')}
          </div>`;
        }
        return row;
      }).join(''));

  if (State.cues.length && State.trackCount > 1)
    html += sec('軌道',
      State.tracks.map((tk, i) => cb(`data-tk="${i}" checked`, `${escapeHTML(tk.name)} <span style="color:var(--text-faint)">(${State.cues.filter(c => (c.track || 0) === i).length} 條)</span>`)).join('')
      + `<div style="font-size:13px;color:var(--text-faint);margin-top:8px">Excel 會將所有勾選軌道合為一個檔案，每軌一個分頁</div>`);

  if (State.notes.length)
    html += sec(`備註（${State.notes.length} 條）`,
      cb('id="expNotesEdius"', 'Edius 格式') + cb('id="expNotesGeneral"', '一般格式'));

  openModal('匯出', html, [
    {
      label: '預設', act: () => {
        const fmts = document.querySelectorAll('[data-fmt]');
        for (let i = 0; i < fmts.length; i++) fmts[i].checked = (fmts[i].getAttribute('data-fmt') === 'encore');
        const tks = document.querySelectorAll('[data-tk]');
        for (let i = 0; i < tks.length; i++) tks[i].checked = true;
        const ne = document.getElementById('expNotesEdius'); if(ne) ne.checked = false;
        const ng = document.getElementById('expNotesGeneral'); if(ng) ng.checked = false;
      }
    },
    {
      label: '全選', act: () => {
        const fmts = document.querySelectorAll('[data-fmt]');
        for (let i = 0; i < fmts.length; i++) fmts[i].checked = true;
        const tks = document.querySelectorAll('[data-tk]');
        for (let i = 0; i < tks.length; i++) tks[i].checked = true;
        const ne = document.getElementById('expNotesEdius'); if(ne) ne.checked = true;
        const ng = document.getElementById('expNotesGeneral'); if(ng) ng.checked = true;
      }
    },
    {
      label: '匯出', primary: true, act: () => {
      const fmts = [...document.querySelectorAll('[data-fmt]')].filter(b => b.checked).map(b => b.dataset.fmt);
      const tks = State.cues.length && State.trackCount > 1 ? [...document.querySelectorAll('[data-tk]')].filter(b => b.checked).map(b => +b.dataset.tk) : null;
      const notesE = document.getElementById('expNotesEdius')?.checked;
      const notesG = document.getElementById('expNotesGeneral')?.checked;
      if (!fmts.length && !notesE && !notesG) { showToast('請至少勾選一個格式'); return; }
      if (fmts.length && tks !== null && !tks.length) { showToast('請至少勾選一個軌道'); return; }
      closeModal();
      const filesToExport = [];
      for (const fmt of fmts) {
        if (fmt === 'xlsx') {
          const list = tks ? tks.map(i => ({ name: State.tracks[i]?.name || ('軌道' + (i + 1)), cues: State.cues.filter(c => (c.track || 0) === i) })).filter(t => t.cues.length) : [{ name: State.tracks[0]?.name || '軌道 1', cues: State.cues }];
          const f = getXLSXFileData(list); if (f) filesToExport.push(f);
        } else {
          if (tks) {
            const shouldMerge = document.getElementById(`merge_${fmt}`)?.checked;
            if (shouldMerge) {
              const mergedCues = [];
              const mergedNames = [];
              for (const i of tks) {
                const cues = State.cues.filter(c => (c.track || 0) === i);
                if (cues.length) {
                  mergedCues.push(...cues);
                  mergedNames.push(State.tracks[i]?.name || ('軌道' + (i + 1)));
                }
              }
              if (mergedCues.length) {
                mergedCues.sort((a, b) => a.start - b.start);
                const f = getFileData(fmt, mergedCues, mergedNames.join('+'));
                if (f) filesToExport.push(f);
              }
            } else {
              for (const i of tks) {
                const cues = State.cues.filter(c => (c.track || 0) === i);
                if (cues.length) { const f = getFileData(fmt, cues, State.tracks[i]?.name); if (f) filesToExport.push(f); }
              }
            }
          } else {
            const f = getFileData(fmt, State.cues); if (f) filesToExport.push(f);
          }
        }
      }
      if (notesE) { const f = getNotesEdiusFileData(); if (f) filesToExport.push(f); }
      if (notesG) { const f = getNotesGeneralFileData(); if (f) filesToExport.push(f); }
      executeBatchExport(filesToExport);
    }
  }, { label: '取消', act: closeModal }]);

}

/* This is a display draft while the modal is open.  It becomes an actual
   submission only when the user presses \"全部送出\" below; that handler calls it
   again before any async conflict I/O starts. */
function _captureExportDraft(){
  let liveExternalSources=[];
  try{ liveExternalSources = Media.externalAudio?.list?.() || []; }catch(e){}
  const snapshot = buildExportSnapshot({
    state: State,
    mediaTracks: Media.tracks || [],
    liveExternalSources,
    sequenceEnd: Seq.end(),
  });
  return freezeExportSubmission(snapshot, {
    cues: State.cues,
    tracks: State.tracks,
    backgroundLayouts: measureSubtitleBackgroundLayouts(State.cues, State.tracks),
    fps: State.fps,
    dropFrame: State.dropFrame,
    mediaName: State.mediaName,
    canvasW: State.videoWidth || 1920,
    canvasH: State.videoHeight || 1080,
    audioProject: State.audioProject,
    defaultAudioLayout: State.audioProject?.exportLayout || {},
    hasCustomRange: State.exportIn != null || State.exportOut != null,
  });
}

const _VENC_LABEL = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel QuickSync', h264_amf: 'AMD AMF' };

function _suggestMbps(w = State.videoWidth || 1920, h = State.videoHeight || 1080) {
  const fps = State.fps || 30;
  const mbps = (w * h * fps * 0.12) / 1e6;
  return Math.round(Math.max(4, Math.min(120, mbps)));
}

let _lastVbrMbps = null; 

function _mixerSummary() {
  const srcs = new Set(State.clips.map(c => c.audioSrc || (c.primary ? 'video' : 'clip:' + c.id)));
  let audible = 0, total = 0, hasFileSrc = false;
  /* 專案級 Solo：與 delivery-job.js 的 clipAudioSpec 及 project-audio.js 的
     audioPlan 用同一份判準，否則對話框顯示的「幾條會發聲」會與實際輸出不符。
     原本在迴圈裡按每支母素材各算一次 Solo。 */
  const anySolo = anySourceSolo(Media.tracks);
  for (const s of srcs) {
    const tks = Media.tracks.filter(t => (t.source || 'video') === s && t.file);
    if (!tks.length) continue;
    hasFileSrc = true;
    total += tks.length;
    audible += tks.filter(t => sourceTrackAudible(t, anySolo) && (t.volume || 0) > 0).length;
  }
  if (!hasFileSrc) return '';
  return `：目前 <b>${audible}</b>/${total} 條聲道會發聲`;
}

import { validateSubtitlesBeforeExport } from './subtitle-validator.js';

async function showExportVideoDialog(initialDraft=null, skipValidation=false) {
  const capability = videoExportCapability(IS_DESKTOP);
  if (!capability.supported) { showToast(capability.message); return; }
  if (!skipValidation) {
    const cpLenInput = $('cpLenInput');
    const wordLimit = cpLenInput && cpLenInput.value ? parseInt(cpLenInput.value, 10) : null;
    const validationErrors = validateSubtitlesBeforeExport(wordLimit);
    if (validationErrors.length > 0) {
      const html = `<div style="font-size:14px;color:var(--text);margin-bottom:12px;">字幕檢查發現以下潛在問題：</div>
                    <ul style="max-height:200px;overflow-y:auto;background:var(--panel2);padding:10px 10px 10px 25px;border-radius:4px;color:var(--red);margin-bottom:15px;font-size:13px;line-height:1.6;">
                      ${validationErrors.map(e => `<li>${e}</li>`).join('')}
                    </ul>
                    <div style="font-size:13px;color:var(--text-dim);">確定要忽略警告並繼續匯出嗎？</div>`;
      
      openModal('⚠️ 匯出警告：字幕潛在問題', html, [
        { label: '取消', act: closeModal },
        { label: '繼續匯出', primary: true, act: () => {
          closeModal();
          showExportVideoDialog(initialDraft, true);
        }}
      ], { width: '700px' });
      return;
    }
  }

  if (!DESK.exportVideo) { showToast('桌面版匯出元件未就緒'); return; }
  const data = initialDraft?.draft || _captureExportDraft();
  if (!data) { showToast('沒有可匯出的影片或外部音訊'); return; }
  if (data.audioOnly && !data.audioPlan) { showToast('純音訊 WAV 匯出需要專案音軌路由'); return; }
  const unresolved = data.audioPlan?.unresolvedSources || [];
  if (IS_DESKTOP && unresolved.length) {
    showToast(`找不到可供匯出的音訊母素材：${unresolved.map(item=>item.name).join('、')}。請重新連結來源檔。`);
    return;
  }
  
  const audioOnly = !!data.audioOnly;
  const hasProjectAudio = !!data.audioPlan;

  const list = createDeliveryList({
    projectTag: projectTagFrom(data.mediaName),
    fps: data.fps || 25,
    canvasW: data.canvasW || 1920,
    canvasH: data.canvasH || 1080,
    audioOnly,
    defaultAudioLayout: data.defaultAudioLayout || {},
    desktop: IS_DESKTOP,
    initial: initialDraft?.deliverables || null,
  });

  let html = `
    <div style="font-size:13px;line-height:1.6;width:760px;display:flex;flex-direction:column;">

      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;">
        <div>
          <div style="font-weight:bold;font-size:14px;">交付清單</div>
          <div id="evOutputDuration" data-seconds="${data.duration}" style="font-size:11px;color:var(--text-dim);margin-top:1px;">本次輸出時長：<b style="color:var(--text);font-variant-numeric:tabular-nums;">${secToEncore(data.duration, data.fps, data.dropFrame)}</b>${data.hasCustomRange ? ' <span style="color:var(--text-dim);">(自訂範圍)</span>' : ''}</div>
        </div>
        <button id="evAddRowBtn" style="padding:2px 8px;font-size:11px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;">＋新增一列</button>
      </div>
      
      <div id="evRowsContainer" style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding-right:4px;flex:1;"></div>
      
      <div id="evConflictMsg" style="color:var(--red);font-weight:bold;margin-top:12px;display:none;"></div>
    </div>
  `;

  /* 軌道名稱判準只有 subtitle-track-names.js 一份——對話框、job payload 與佇列監控三個消費端
     必須顯示同一份清單，否則「說會燒哪幾軌」與「實際燒了哪幾軌」會不一致。 */
  const activeSubs = burnedSubtitleTrackNames(data.tracks, subtitleCuesForSubmission(data));

  function renderRow(r, i) {
    const isWav = r.format === 'wav';

    const ap = r.audioPlan;
    let audioDesc = '依專案音軌順序';
    const streams = ap?.streams || ap?.groups;
    if (isWav && Array.isArray(r.wavBusIds)) {
      const count=r.wavBusIds.length;
      audioDesc=count===1 ? '已設定 Mono（1 軌）'
        : count===2 ? '已設定 Stereo（2 軌）'
        : `已設定 ${count} 軌（依選擇順序）`;
    } else if (!isWav && Array.isArray(streams)) {
      const gCounts = streams.map(g => {
        if (g.layout === 'stereo' || g.layout === 'stereoLtRt') return '2.0';
        if (g.layout === '5.1') return '5.1';
        if (g.layout === 'mono') return '1.0';
        return g.layout || '2.0';
      });
      const tCount = streams.reduce((acc, g) => acc + (g.layout === '5.1' ? 6 : (g.layout === 'mono' ? 1 : 2)), 0);
      audioDesc = gCounts.length ? `${gCounts.join(' + ')} (${tCount} 軌)` : '無';
    }

    return `
      <div style="border:1px solid var(--border);background:var(--panel2);padding:8px;border-radius:4px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;align-items:center;">
          <select class="ev-format" data-idx="${i}" style="width:100px;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);">
            <option value="h264" ${r.format==='h264'?'selected':''} ${audioOnly?'disabled':''}>MP4 (H.264)</option>
            <option value="prores" ${r.format==='prores'?'selected':''} ${audioOnly?'disabled':''}>MOV (ProRes)</option>
            <option value="wav" ${r.format==='wav'?'selected':''} ${!hasProjectAudio?'disabled':''}>WAV (純音訊)</option>
          </select>
          ${!isWav ? `
            <select class="ev-res" data-idx="${i}" style="width:110px;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);">
              <option value="0" ${r.targetH===0?'selected':''}>來源解析度</option>
              <option value="2160" ${r.targetH===2160?'selected':''}>4K (2160p)</option>
              <option value="1080" ${r.targetH===1080?'selected':''}>1080p</option>
              <option value="720" ${r.targetH===720?'selected':''}>720p</option>
              <option value="custom" ${(r.targetH>0 && ![1080,720,2160].includes(r.targetH))?'selected':''}>自訂...</option>
            </select>
            ${(r.targetH>0 && ![1080,720,2160].includes(r.targetH)) ? 
              `<input type="number" class="ev-custom-res" data-idx="${i}" value="${r.targetH}" style="width:50px;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);">` 
              : ''}
            ${r.format==='h264' ? `
              <input type="number" class="ev-kbps" data-idx="${i}" value="${r.kbps}" style="width:60px;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);" title="目標視訊碼率 (kbps)"> kbps
            ` : ''}
            <label style="font-size:11px;display:flex;align-items:center;gap:4px;margin-left:8px;white-space:nowrap;" title="在畫面上燒入交付用時間碼"><input type="checkbox" class="ev-tc" data-idx="${i}" ${r.burnTimecode?'checked':''}>燒入TC</label>
            <span style="font-size:11px;color:var(--text-faint);margin-left:8px;white-space:nowrap;">${activeSubs.length ? '字幕: '+activeSubs.join(', ') : '無字幕'}</span>
          ` : ''}
          <div style="flex:1"></div>
          <button class="ev-del icon" data-idx="${i}" style="padding:2px;font-size:12px;cursor:pointer;color:var(--red);background:transparent;border:none;" title="刪除此列">✕</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;">
          <input type="text" class="ev-name" data-idx="${i}" value="${r.customName}" style="flex:3;min-width:0;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);" placeholder="檔名 (含副檔名)" title="${escapeHTML(r.customName || '')}">
          <input type="text" class="ev-outdir" data-idx="${i}" value="${r.outDir || ''}" style="flex:2;min-width:0;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);${!IS_DESKTOP?'display:none;':''}" title="${escapeHTML(r.outDir || '')}" placeholder="選擇輸出目錄...">
          <button class="ev-dir-btn" data-idx="${i}" style="flex:none;padding:2px 8px;font-size:12px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;${!IS_DESKTOP?'display:none;':''}">瀏覽...</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--text-dim);">音訊: ${audioDesc}</span>
            <button class="ev-audio-btn" data-idx="${i}" style="padding:2px 6px;font-size:11px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;" title="設定此列輸出的音軌">⚙ 音軌</button>
          </div>
        </div>
      </div>
    `;
  }

  function $$ (sel) { return document.querySelectorAll(sel); }

  function updateRows() {
    const c = $('evRowsContainer');
    if (!c) return;
    c.innerHTML = list.rows().map((r, i) => renderRow(r, i)).join('');
    
    const idxOf = e => +e.target.dataset.idx;
    const after = () => { updateRows(); checkConflicts(); };

    $$('.ev-format').forEach(el => el.onchange = e => { list.setFormat(idxOf(e), e.target.value); after(); });
    $$('.ev-res').forEach(el => el.onchange = e => {
      list.setTargetHeight(idxOf(e), e.target.value === 'custom' ? 480 : parseInt(e.target.value, 10));
      after();
    });
    $$('.ev-custom-res').forEach(el => el.onchange = e => { list.setTargetHeight(idxOf(e), parseInt(e.target.value, 10)); after(); });
    $$('.ev-kbps').forEach(el => el.onchange = e => list.setKbps(idxOf(e), e.target.value));
    $$('.ev-name').forEach(el => el.onchange = e => { list.setName(idxOf(e), e.target.value); after(); });
    $$('.ev-outdir').forEach(el => el.onchange = e => { list.setOutDir(idxOf(e), e.target.value); after(); });
    $$('.ev-tc').forEach(el => el.onchange = e => { list.setBurnTimecode(idxOf(e), e.target.checked); after(); });

    const pickDir = async e => {
      const idx = idxOf(e);
      const p = await DESK.exportDirectory([]);
      if (p) { list.setOutDir(idx, p); after(); }
    };
    $$('.ev-dir-btn').forEach(el => el.onclick = pickDir);
    $$('.ev-del').forEach(el => el.onclick = e => { list.removeAt(idxOf(e)); after(); });

    $$('.ev-audio-btn').forEach(el => el.onclick = e => {
      const idx = idxOf(e);
      const audioSpec = createDeliveryAudioSpec(data.audioProject, list.get(idx));
      closeModal();
      const deliveryFormat = list.get(idx).format;
      AudioRouting.openDeliveryOutputSettings(audioSpec, ({ saved, spec } = {}) => {
        if (saved && spec) list.applyRow(idx, applyDeliveryAudioSpec(list.get(idx), spec));
        void showExportVideoDialog({ deliverables: list.rows(), draft: data });
      }, { deliveryFormat });
    });
  }

  async function checkConflicts(isSubmitting = false, candidate = list) {
    const msg = $('evConflictMsg');
    if (!msg) return true;

    const blocking = candidate.problems().filter(p => p.kind === 'blocking')[0];
    if (blocking) {
      msg.textContent = blocking.message;
      msg.style.display = 'block';
      if (isSubmitting) alert(blocking.submitMessage || blocking.message);
      return false;
    }

    if (IS_DESKTOP) {
      try {
        const conflicts = [];
        for (const { dir, name } of candidate.outPaths()) {
          if (!dir) continue;
          const files = await DESK.listDir(dir);
          const existing = files.map(f => (typeof f === 'string' ? f : f.name).toLowerCase());
          if (existing.includes(name.toLowerCase())) conflicts.push(name);
        }
        if (conflicts.length > 0) {
          msg.textContent = `警告：硬碟上已存在同名檔案 (${conflicts.join(', ')})，匯出將會直接覆蓋。`;
          msg.style.display = 'block';
          if (isSubmitting) return confirm(`硬碟上已存在同名檔案：\n${conflicts.join(', ')}\n\n確定要直接覆蓋並繼續匯出嗎？`);
          return true;
        }
      } catch(e){}
    }

    msg.style.display = 'none';
    return true;
  }

  function freezeCurrentDeliveryList(submission) {
    return createDeliveryList({
      projectTag: projectTagFrom(submission.mediaName),
      fps: submission.fps || 25,
      canvasW: submission.canvasW || 1920,
      canvasH: submission.canvasH || 1080,
      audioOnly: !!submission.audioOnly,
      defaultAudioLayout: submission.defaultAudioLayout || {},
      desktop: IS_DESKTOP,
      // `rows()` is intentionally live while the dialog is editable.  Clone
      // once at click time so async conflict checks cannot let later UI edits
      // alter the jobs that this submission builds.
      initial: structuredClone(list.rows()),
    });
  }

  openModal('匯出交付清單', html, [
    { label: '取消', act: closeModal },
    { label: '全部送出', primary: true, act: async () => {
      try {
        const result = await runFrozenExportSubmission({
          // D3: capture project data and editable delivery rows synchronously,
          // before checkConflicts performs directory I/O.
          capture: () => {
            const submission = _captureExportDraft();
            return submission ? { submission, submittedList: freezeCurrentDeliveryList(submission) } : null;
          },
          validate: ({ submission, submittedList }) => {
            if (submission.audioOnly && !submission.audioPlan) return '純音訊 WAV 匯出需要專案音軌路由';
            const unresolved = submission.audioPlan?.unresolvedSources || [];
            if (unresolved.length) {
              return `找不到可供匯出的音訊母素材：${unresolved.map(item=>item.name).join('、')}。請重新連結來源檔。`;
            }
            if (!!submission.audioOnly !== audioOnly) return '匯出素材在交付清單開啟後已變更，請重新開啟清單確認交付格式。';
            if (submittedList.count() === 0) return '清單不能為空';
            return null;
          },
          checkConflicts: ({ submittedList }) => checkConflicts(true, submittedList),
          dispatch: async ({ submission, submittedList }) => {
            const jobs = buildExportJobs(submission, submittedList);
            for (const job of jobs) {
              const jobId = await DESK.exportVideo(job);
              if (jobId) showToast(`排入佇列: ${job.defaultName}`);
            }
            closeModal();
            if (typeof DESK.openQueueMonitor === 'function') {
              setTimeout(() => DESK.openQueueMonitor(), 150);
            }
            return jobs.length;
          },
        });
        if (result.status === 'invalid') {
          showToast(result.reason);
        }
      } catch (err) {
        showToast('送出失敗: ' + (err.message || err));
        console.error(err);
      }
    }}
  ], { width: '820px' });

  $('evAddRowBtn').onclick = () => { list.add(); updateRows(); checkConflicts(); };

  setTimeout(() => {
    updateRows();
    checkConflicts();
  }, 20);
}

// Global exports of the logic for external callers 
export { importSub, importDropped } from './sub-parse.js';
export { applyTcShift, applyDurAdjTc, applyDurAdjPct } from './timeline-edit-batch.js';
export { getFileData, getXLSXFileData, toASSFromState, executeBatchExport, doExportXLSX } from './ffmpeg-export.js';

export { showExportDialog, showFpsConvertDialog, showExportVideoDialog };

import { Project } from './project.js';

if (typeof document !== 'undefined') {
  ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('videoWrap')?.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop' && e.relatedTarget) return; $('videoWrap')?.classList.remove('dragover'); }));
  document.addEventListener('drop', async e => {
    e.preventDefault(); $('videoWrap')?.classList.remove('dragover');
    const f = e.dataTransfer.files[0]; if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (['subtool', 'json'].includes(ext)) {
      if(IS_DESKTOP&&typeof DESK.openDroppedProject==='function'){
        const project=await DESK.openDroppedProject(f);
        if(project) await Project.loadDesktop(project);
      }else await Project.load(f);
    }
    else if (['srt', 'ass', 'ssa', 'txt'].includes(ext)) { importDropped(f); }
    else if (IS_DESKTOP && (DESK.authorizeDroppedFile || DESK.getFilePath)) {
      const p = DESK.authorizeDroppedFile ? await DESK.authorizeDroppedFile(f) : DESK.getFilePath(f);
      if (p) Media.openIncoming({ path: p }); else Media.openIncoming({ file: f });
    }
    else Media.openIncoming({ file: f });
  });
}


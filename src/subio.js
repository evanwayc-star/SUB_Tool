import { State, IS_DESKTOP, DESK, setFps, newTrack, syncTrackCount, newId, deselect } from './state.js';
import { $ } from './dom.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { sortCues, trackLocked, cuesTrackLocked, burnedSubtitleTrackNames } from './subtitle-model.js';
import { renderASS, SubFormats } from './formats.js';
import { drawTimeline, layoutTimeline } from './timeline-renderer.js';
import { emit } from './events.js';
import { getNotesGeneralFileData, getNotesEdiusFileData } from './notes.js';
import { Seq } from './sequence.js';
import { AudioRouting } from './audio-routing.js';
import { applyDeliveryAudioSpec, composeDeliveryAudioPlan, createDeliveryAudioSpec, videoExportCapability } from './export-job-engine.js';
import { buildExportSnapshot } from './delivery-job.js';
import { anySourceSolo, sourceTrackAudible } from './project-audio.js';
import { createDeliveryList, projectTagFrom } from './delivery-list.js';
import { escapeHTML, encodeUTF16LE, bytesToB64, downloadBytes, baseName, b64ToBytes, decodeText, readFile, pickFile } from './util.js';
import { Media } from './media.js';
import { measureSubtitleBackgroundLayouts } from './subtitle-background-layout.js';
import { parseTimecodeInput } from './tcparse.js';
import { buildXLSX } from './xlsx-export.js';
import { getAllPresets, loadFonts } from './substyle.js';
import { buildSubtitleImportPlan } from './project-intake-engine.js';
import { Project } from './project.js';

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

import { validateSubtitlesBeforeExport } from './subtitle-audit.js';

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
  const unresolved = data.audioPlan?.unresolvedSources || [];
  if (IS_DESKTOP && unresolved.length) {
    showToast(`找不到可供匯出的音訊母素材：${unresolved.map(item=>item.name).join('、')}。請重新連結來源檔。`);
    return;
  }
  if (data.audioOnly && !data.audioPlan) { showToast('純音訊 WAV 匯出需要專案音軌路由'); return; }

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
    <div class="delivery-dialog">
      <div class="delivery-header">
        <div>
          <div class="delivery-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            交付清單
          </div>
          <div id="evOutputDuration" class="delivery-duration-pill" data-seconds="${data.duration}">
            本次輸出時長：<b>${secToEncore(data.duration, data.fps, data.dropFrame)}</b>${data.hasCustomRange ? ' <span class="delivery-tag-custom">(自訂範圍)</span>' : ''}
          </div>
        </div>
        <button id="evAddRowBtn" class="delivery-add-btn">＋ 新增一列</button>
      </div>
      
      <div id="evRowsContainer" class="delivery-rows"></div>
      
      <div id="evConflictMsg" class="delivery-conflict-banner"></div>
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
      <div class="delivery-card">
        <div class="delivery-ctrl-row">
          <select class="ev-format delivery-select" data-idx="${i}" style="width:116px;">
            <option value="h264" ${r.format==='h264'?'selected':''} ${audioOnly?'disabled':''}>MP4 (H.264)</option>
            <option value="prores" ${r.format==='prores'?'selected':''} ${audioOnly?'disabled':''}>MOV (ProRes)</option>
            <option value="wav" ${r.format==='wav'?'selected':''} ${!hasProjectAudio?'disabled':''}>WAV (純音訊)</option>
          </select>
          ${!isWav ? `
            <select class="ev-res delivery-select" data-idx="${i}" style="width:118px;">
              <option value="0" ${r.targetH===0?'selected':''}>來源解析度</option>
              <option value="2160" ${r.targetH===2160?'selected':''}>4K (2160p)</option>
              <option value="1080" ${r.targetH===1080?'selected':''}>1080p</option>
              <option value="720" ${r.targetH===720?'selected':''}>720p</option>
              <option value="custom" ${(r.targetH>0 && ![1080,720,2160].includes(r.targetH))?'selected':''}>自訂...</option>
            </select>
            ${(r.targetH>0 && ![1080,720,2160].includes(r.targetH)) ? 
              `<input type="number" class="ev-custom-res delivery-input" data-idx="${i}" value="${r.targetH}" style="width:60px;" placeholder="高度">` 
              : ''}
            ${r.format==='h264' ? `
              <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim);">
                <input type="number" class="ev-kbps delivery-input" data-idx="${i}" value="${r.kbps}" style="width:72px;" title="目標視訊碼率 (kbps)"> kbps
              </div>
            ` : ''}
            <label class="ev-tc-wrap delivery-tc-label" title="在畫面上燒入交付用時間碼"><input type="checkbox" class="ev-tc" data-idx="${i}" ${r.burnTimecode?'checked':''}> 燒入 TC</label>
            <span class="delivery-sub-chip" title="${activeSubs.length ? '將燒入字幕軌：'+activeSubs.join(', ') : '無字幕'}">${activeSubs.length ? '💬 字幕: '+activeSubs.join(', ') : '無字幕'}</span>
          ` : ''}
          <div style="flex:1"></div>
          <button class="ev-del delivery-btn-del icon" data-idx="${i}" title="刪除此列">✕</button>
        </div>
        <div class="delivery-ctrl-row" style="display:flex;gap:8px;align-items:center;">
          <input type="text" class="ev-name delivery-input" data-idx="${i}" value="${r.customName}" style="flex:3;min-width:0;" placeholder="檔名 (含副檔名)" title="${escapeHTML(r.customName || '')}">
          <input type="text" class="ev-outdir delivery-input" data-idx="${i}" value="${r.outDir || ''}" style="flex:2;min-width:0;${!IS_DESKTOP?'display:none;':''}" title="${escapeHTML(r.outDir || '')}" placeholder="選擇輸出目錄...">
          <button class="ev-dir-btn delivery-btn-browse" data-idx="${i}" style="flex:none;${!IS_DESKTOP?'display:none;':''}">瀏覽...</button>
        </div>
        <div class="delivery-ctrl-row" style="display:flex;gap:8px;align-items:center;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="delivery-audio-info">🎧 音訊: ${audioDesc}</span>
            <button class="ev-audio-btn delivery-btn-audio" data-idx="${i}" title="設定此列輸出的音軌">⚙ 音軌</button>
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
      msg.style.display = 'flex';
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

/* ==============================================================================
   字幕檔案解析與匯入 (Sub Parsing & Intake)
   ============================================================================== */

export function detectSubFormat(text, ext) {
  if (ext === 'srt') return 'srt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (/\[Script Info\]/i.test(text)) return 'ass';
  if (/^\d+\r?\n\d{2}:\d{2}:\d{2}[,\.]\d{3}/m.test(text)) return 'srt';
  if (/(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)[ \t]+(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)/m.test(text)) return 'encore';
  return 'txt';
}

export function _parseSubtitleText(text, kind) {
  if (kind === 'srt') return SubFormats.parseSRT(text);
  if (kind === 'ass') return SubFormats.parseASS(text);
  if (kind === 'encore') return SubFormats.parseEncore(text, State.fps, State.dropFrame);
  return SubFormats.parseTXT(text);
}

export function _subtoolFpsValue(parsed) {
  const metadata = parsed?.subtool;
  const fps = Number(metadata?.fps);
  if (!Number.isFinite(fps)) return null;
  if (Math.abs(fps - 23.976) < 0.01) return '23.976';
  if (Math.abs(fps - 24) < 0.01) return '24';
  if (Math.abs(fps - 25) < 0.01) return '25';
  if (Math.abs(fps - 29.97) < 0.01) return metadata.dropFrame ? '29.97df' : '29.97';
  if (Math.abs(fps - 30) < 0.01) return '30';
  return null;
}

export function _parsedSubtitleCount(parsed) {
  return Array.isArray(parsed?.subtool?.cues) ? parsed.subtool.cues.length : (parsed?.length || 0);
}

function _askFpsModal(defaultValue = '29.97', detectedSubtoolAss = false) {
  return new Promise(resolve => {
    const FPS_OPTS = [
      { v: '23.976', l: '23.98' }, { v: '24', l: '24' }, { v: '25', l: '25' },
      { v: '29.97df', l: '29.97 (Drop-frame)' }, { v: '29.97', l: '29.97 (Non-Drop-frame)' }, { v: '30', l: '30' },
    ];
    const opts = FPS_OPTS.map(o => `<option value="${o.v}"${o.v === defaultValue ? ' selected' : ''}>${o.l}</option>`).join('');
    openModal('選擇影格率 (FPS)',
      `<p style="margin:0 0 12px;font-size:13px;color:var(--text-faint)">${detectedSubtoolAss ? '已從 SUB Tool ASS 偵測原始影格率；可在此確認或改為其他值。' : '尚未載入影片，請先設定字幕的影格率。'}</p>` +
      `<label>FPS：<select id="importFpsSel" style="margin-left:6px">${opts}</select></label>`,
      [{ label: '確定', primary: true, act: () => { const val = $('importFpsSel').value; closeModal(); resolve(val); } },
      { label: '取消', act: () => { closeModal(); resolve(null); } }]
    );
  });
}

export async function _prepareSubtitleImport(text, kind) {
  if (kind === 'ass') await loadFonts();
  if (!State.mediaName && kind === 'encore') {
    const fpsVal = await _askFpsModal();
    if (fpsVal === null) return null;
    setFps(fpsVal);
  }
  let parsed;
  try { parsed = _parseSubtitleText(text, kind); }
  catch (e) { showToast('解析失敗：' + e.message); return null; }
  if (_parsedSubtitleCount(parsed) === 0) { showToast('未解析到字幕（檢查格式/編碼）'); return null; }
  if (!State.mediaName && kind !== 'encore') {
    const sourceFps = _subtoolFpsValue(parsed);
    const fpsVal = await _askFpsModal(sourceFps || '29.97', !!sourceFps);
    if (fpsVal === null) return null;
    setFps(fpsVal);
  }
  return parsed;
}

export function _openImportModal(title, parsed, kind) {
  const trackOpts = State.tracks.map((tk, i) => `<option value="${i}">軌道 ${i + 1}：${escapeHTML(tk.name)}</option>`).join('');
  const assImportPreview = kind === 'ass' ? buildSubtitleImportPlan(parsed, { fps: State.fps, target: 'new' }) : null;
  const hasRoundTripMetadata = assImportPreview?.usedMetadata === true;
  const suggestName = hasRoundTripMetadata && assImportPreview.trackPatch?.name
    ? assImportPreview.trackPatch.name : (kind.toUpperCase() + ' 字幕');
  const presets = getAllPresets();
  const presetOpts = '<option value="">— 不套用自訂樣式 —</option>' + presets.map(p => `<option value="${escapeHTML(p.name)}">${escapeHTML(p.name)}</option>`).join('');
  const styleControl = hasRoundTripMetadata
    ? `<p style="margin:0 0 8px;font-size:13px;color:var(--text-faint)">偵測到 SUB Tool ASS：會還原原始軌道與逐句樣式。${assImportPreview.usedFrameTiming ? '' : '目前專案 FPS 不同，將依原始秒數匯入。'}</p>`
    : `${assImportPreview?.usedLegacyTiming ? '<p style="margin:0 0 8px;font-size:13px;color:var(--text-faint)">偵測到舊版 SUB Tool ASS：會依目前 FPS 修正舊版百分秒造成的一格偏移。</p>' : ''}<label style="display:block;padding-bottom:8px">套用樣式：<select id="importPresetSel" style="margin-left:6px">${presetOpts}</select></label>`;
  
  openModal(title,
    `<label style="display:block;padding:8px 0">目標軌道：<select id="importTkSel" style="margin-left:6px">${trackOpts}<option value="new" selected>＋ 新增軌道…</option></select></label>` +
    `<div id="importNewTkRow" style="padding-bottom:8px">軌道名稱：<input type="text" id="importNewTkName" style="margin-left:6px;width:160px" value="${escapeHTML(suggestName)}"></div>` +
    styleControl +
    `<label style="display:block;padding-bottom:8px"><input type="checkbox" id="importAppend"> 附加（保留現有字幕）</label>`,
    [{
      label: '匯入', primary: true, act: () => {
        const selVal = $('importTkSel').value;
        if (selVal !== 'new' && trackLocked(+selVal, '匯入字幕')) return;
        const presetVal = hasRoundTripMetadata ? '' : $('importPresetSel').value;
        const selectedPreset = presetVal ? getAllPresets().find(p => p.name === presetVal) : null;
        const importPlan = kind === 'ass'
          ? buildSubtitleImportPlan(parsed, { fps: State.fps, target: selVal === 'new' ? 'new' : 'existing' }) : null;
        let targetTk;
        if (selVal === 'new') {
          const tkName = ($('importNewTkName').value.trim()) || importPlan?.trackPatch?.name || ('軌道 ' + (State.tracks.length + 1));
          const trk = newTrack(tkName);
          if (importPlan?.trackPatch) { Object.assign(trk, importPlan.trackPatch); trk.name = tkName; }
          else if (selectedPreset && selectedPreset.style) Object.assign(trk, selectedPreset.style);
          State.tracks.push(trk); syncTrackCount();
          targetTk = State.tracks.length - 1;
        } else { targetTk = +selVal; }
        const append = selVal === 'new' || $('importAppend').checked;
        closeModal();
        const sourceCues = importPlan?.cues || parsed;
        const newCues = sourceCues.map(p => {
          const s = Number.isFinite(Number(p.start)) ? Number(p.start) : 0;
          const e = Number.isFinite(Number(p.end)) ? Math.max(s, Number(p.end)) : s;
          const cue = { id: newId(), start: s, end: e, text: p.text || '', track: targetTk, timed: p.timed !== false && !(p.start === 0 && p.end === 0 && kind === 'txt') };
          if (p.style && typeof p.style === 'object') cue.style = Object.assign({}, p.style);
          else if (selVal !== 'new' && selectedPreset && selectedPreset.style) {
            cue.style = Object.assign({}, selectedPreset.style);
          }
          return cue;
        });
        if (kind === 'txt') newCues.forEach(c => c.timed = false);
        if (append) { State.cues.push(...newCues); }
        else {
          State.cues = State.cues.filter(c => (c.track || 0) !== targetTk);
          State.cues.push(...newCues);
        }
        
        newCues.forEach(c => {
          if (c.timed === false) return;
          c.start = snapTimeToFrame(c.start, State.fps, State.dropFrame);
          c.end = Math.max(c.start, snapTimeToFrame(c.end, State.fps, State.dropFrame));
        });
        
        State.listTrack = targetTk;
        if (!append) deselect('sub');
        sortCues(); emit('render:listTrackSel'); emit('render:all');
        {
          const maxEnd = State.cues.reduce((m, c) => c.timed !== false ? Math.max(m, c.end) : m, 0);
          if (maxEnd > State.duration) { State.duration = maxEnd; emit('duration:known'); } else drawTimeline();
        }
        recordHistory('匯入字幕 ' + kind.toUpperCase());
        setStatus(`已匯入 ${newCues.length} 條字幕到「${State.tracks[targetTk]?.name}」(${kind.toUpperCase()})`, 'ok');
        showToast(importPlan?.usedMetadata && !importPlan.usedFrameTiming
          ? `匯入 ${newCues.length} 條字幕（來源 FPS 不同，已依秒數轉換）`
          : importPlan?.usedLegacyTiming
            ? `匯入 ${newCues.length} 條字幕（已修正舊版 ASS 的一格偏移）`
            : `匯入 ${newCues.length} 條字幕`);
      }
    }, { label: '取消', act: closeModal }]);
  setTimeout(() => {
    const sel = $('importTkSel'), row = $('importNewTkRow'), nm = $('importNewTkName');
    if (sel) sel.addEventListener('change', () => {
      const isNew = sel.value === 'new';
      row.style.display = isNew ? 'block' : 'none';
      if (isNew) { nm.focus(); nm.select(); }
    });
  }, 20);
}

export async function importSub() {
  let text, fileName = '';
  if (IS_DESKTOP) {
    const r = await DESK.importSub('any'); if (!r) return;
    text = decodeText(b64ToBytes(r.b64).buffer); fileName = r.name || '';
  } else {
    const f = await pickFile($('fileSub')); if (!f) return;
    const buf = await readFile(f); text = decodeText(buf); fileName = f.name;
  }
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const kind = detectSubFormat(text, ext);
  const parsed = await _prepareSubtitleImport(text, kind); if (!parsed) return;
  _openImportModal(`匯入字幕到哪個軌道？（已辨識為 ${kind.toUpperCase()}，${_parsedSubtitleCount(parsed)} 條）`, parsed, kind);
}

export async function importDropped(f) {
  const buf = await readFile(f); const text = decodeText(buf);
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const kind = detectSubFormat(text, ext);
  const parsed = await _prepareSubtitleImport(text, kind); if (!parsed) return;
  _openImportModal(`拖入字幕（${kind.toUpperCase()}，${_parsedSubtitleCount(parsed)} 條）`, parsed, kind);
}

/* ==============================================================================
   時間軸字幕批次編輯 (Timeline Batch Edits)
   ============================================================================== */

export function _durAdjCues(scope) {
  if (scope === 'sel') {
    const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
    return ids.map(id => State.cues.find(c => c.id === id)).filter(c => c && c.timed !== false);
  } else if (scope === 'track') {
    return State.cues.filter(c => c.timed !== false && (c.track || 0) === State.listTrack);
  } else {
    return State.cues.filter(c => c.timed !== false);
  }
}

export function _nextInPoint(c) {
  const track = c.track || 0; let next = Infinity;
  for (const oc of State.cues) {
    if (oc.timed === false || oc.id === c.id || (oc.track || 0) !== track) continue;
    if (oc.start > c.start && oc.start < next) next = oc.start;
  }
  return next;
}

export function applyTcShift(sign) {
  const raw = ($('tcShiftInput').value || '').trim().replace(/^[+-]/, '');
  const t = parseTimecodeInput(raw);
  if (t == null || isNaN(t) || t <= 0) { showToast('請輸入有效的時間碼（例如 00:00:02:00）'); return; }
  const delta = sign * t;
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可以位移'); return; }
  if (cuesTrackLocked(cues, '修改字幕時間')) return;
  for (const c of cues) { c.start = Math.max(0, c.start + delta); c.end = Math.max(c.start + 0.001, c.end + delta); }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('時間碼位移');
  setStatus(`已位移 ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s（共 ${cues.length} 條）`, 'ok');
}

export function applyDurAdjTc(sign) {
  const raw = ($('durAdjTcInput').value || '').trim().replace(/^[+-]/, '');
  const t = parseTimecodeInput(raw);
  if (t == null || isNaN(t) || t <= 0) { showToast('請輸入有效的時間碼（例如 00:00:01:00）'); return; }
  const delta = sign * t;
  const minDur = 1 / Math.max(State.fps || 25, 1);
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可調整'); return; }
  if (cuesTrackLocked(cues, '修改字幕時間')) return;
  let adjusted = 0, skipped = 0;
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    if (delta > 0 && c.end > nextIn) { skipped++; continue; }
    let newEnd = c.end + delta;
    newEnd = Math.max(c.start + minDur, newEnd);
    newEnd = Math.min(nextIn, newEnd);
    if (newEnd !== c.end) { c.end = newEnd; adjusted++; }
  }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${adjusted} 條字幕的持續時間（${sign > 0 ? '+' : '−'}${t.toFixed(3)}s${skipped ? `，跳過 ${skipped} 條已重疊` : ''}）`, 'ok');
}

export function applyDurAdjPct() {
  const pct = +($('durAdjPctInput').value || '100');
  if (isNaN(pct) || pct <= 0) { showToast('請輸入有效的百分比（例如 150）'); return; }
  const ratio = pct / 100;
  const minDur = 1 / Math.max(State.fps || 25, 1);
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可調整'); return; }
  if (cuesTrackLocked(cues, '修改字幕時間')) return;
  let adjusted = 0, skipped = 0;
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    if (ratio > 1 && c.end > nextIn) { skipped++; continue; }
    let newEnd = snapTimeToFrame(c.start + (c.end - c.start) * ratio, State.fps, State.dropFrame);
    newEnd = Math.max(c.start + minDur, newEnd);
    newEnd = Math.min(nextIn, newEnd);
    if (newEnd !== c.end) { c.end = newEnd; adjusted++; }
  }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${adjusted} 條字幕的持續時間（${pct}%${skipped ? `，跳過 ${skipped} 條已重疊` : ''}）`, 'ok');
}

/* ==============================================================================
   字幕檔案匯出 (Subtitle Export)
   ============================================================================== */

export function getFileData(kind, cues, trackName) {
  if (!cues.length) return null;
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle').split('_')[0];
  const tkName = trackName ? trackName.replace(/[\\/:*?"<>|]/g, '_') : '軌道';
  let text, ext, fname;
  if (kind === 'srt') {
    text = SubFormats.toSRT(cues); ext = 'srt';
    fname = `ST_${projName}_SUB_${tkName}.srt`;
  }
  else if (kind === 'ass') {
    text = toASSFromState(cues, { includeMetadata: true }); ext = 'ass';
    fname = `ST_${projName}_SUB_${tkName}.ass`;
  }
  else if (kind === 'encore') {
    text = SubFormats.toEncore(cues, State.fps, State.dropFrame); ext = 'txt';
    fname = `ST_${projName}_SUB_${tkName}.txt`;
  }
  else {
    text = SubFormats.toTXT(cues); ext = 'txt';
    fname = `ST_${projName}_SUB_${tkName}-NoTC.txt`;
  }
  const bytes = encodeUTF16LE(text);
  return { name: fname, content: bytesToB64(bytes), ext: ext, mime: 'text/plain;charset=utf-16le' };
}

export function getXLSXFileData(trackDataList) {
  if (!trackDataList.length) return null;
  const bytes = buildXLSX(trackDataList, State.fps, State.dropFrame);
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle').split('_')[0];
  const fname = `ST_${projName}_SUB.xlsx`;
  return { name: fname, content: bytesToB64(bytes), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

export function toASSFromState(cues, options = {}) {
  const backgroundLayouts = options.backgroundLayouts ??
    measureSubtitleBackgroundLayouts(cues, State.tracks);
  return renderASS(cues, {
    ...options,
    backgroundLayouts,
    fps: State.fps,
    tracks: State.tracks,
    dropFrame: State.dropFrame,
  });
}

export function executeBatchExport(files) {
  if (!files.length) return;
  if (!IS_DESKTOP) {
    files.forEach(f => downloadBytes(b64ToBytes(f.content), f.name, f.mime || 'application/octet-stream'));
    setStatus(`已下載 ${files.length} 個檔案`, 'ok');
    showToast(`已下載 ${files.length} 個檔案`);
    return;
  }
  if (files.length === 1) {
    const f = files[0];
    DESK.exportSub(f.name, f.content, f.ext).then(pth => {
      if (pth) { setStatus(`已匯出：${pth}`, 'ok'); showToast(`已匯出 ${baseName(pth)}`); }
    });
  } else {
    DESK.exportDirectory(files).then(dir => {
      if (dir) { setStatus(`已批次匯出 ${files.length} 個檔案至：${dir}`, 'ok'); showToast(`已批次匯出 ${files.length} 個檔案`); }
    });
  }
}

export function doExportXLSX(trackDataList) {
  if (!trackDataList.length) { showToast('所選軌道沒有字幕'); return; }
  const bytes = buildXLSX(trackDataList, State.fps, State.dropFrame);
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle').split('_')[0];
  const fname = `ST_${projName}_SUB.xlsx`;
  if (IS_DESKTOP) {
    DESK.exportSub(fname, bytesToB64(bytes), 'xlsx').then(pth => { if (pth) { setStatus('已匯出：' + pth, 'ok'); showToast('已匯出 ' + baseName(pth)); } });
  } else {
    downloadBytes(bytes, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    setStatus('已匯出 XLSX（' + trackDataList.length + ' 個分頁）', 'ok');
    showToast('已匯出 ' + fname);
  }
}

export { showExportDialog, showFpsConvertDialog, showExportVideoDialog };


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





/* ==============================================================================
   匯出交付工作構建與事務邊界 (Export Delivery Engine)
   ============================================================================== */

/**
 * 凍結當前專案與匯出範圍快照。
 * 匯出的 DeliveryJob 絕不可往回讀取可變的 State。
 */
export function freezeExportSubmission(snapshot, {
  cues = [], tracks = [], fps = 25, dropFrame = false,
  backgroundLayouts = {},
  mediaName = '', canvasW = 1920, canvasH = 1080,
  audioProject = null, defaultAudioLayout = {}, hasCustomRange = false,
} = {}) {
  if (!snapshot) return null;
  return structuredClone({
    ...snapshot,
    cues,
    tracks,
    backgroundLayouts,
    fps,
    dropFrame,
    mediaName,
    canvasW,
    canvasH,
    audioProject,
    defaultAudioLayout,
    hasCustomRange,
  });
}

/**
 * 依據匯出時間範圍切片並過濾出可見字幕軌。
 */
export function subtitleCuesForSubmission(submission) {
  if (submission?.audioOnly) return [];
  const expIn = submission?.timelineStart != null ? submission.timelineStart : 0;
  const duration = Number(submission?.duration);
  const clipDuration = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
  const expOut = expIn + clipDuration;
  const tracks = Array.isArray(submission?.tracks) ? submission.tracks : [];
  return (Array.isArray(submission?.cues) ? submission.cues : [])
    .filter(cue => {
      if (!cue || cue.timed === false) return false;
      const trackIndex = Number.isInteger(cue.track) ? cue.track : 0;
      if (tracks[trackIndex]?.visible === false) return false;
      return Number(cue.end) > expIn && Number(cue.start) < expOut;
    })
    .map(cue => ({
      ...cue,
      start: Math.max(0, Number(cue.start) - expIn),
      end: Math.min(clipDuration, Number(cue.end) - expIn),
    }))
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start);
}

/**
 * 產出符合匯出範圍之 ASS 字串與字幕陣列。
 */
export function subtitlePayloadForSubmission(submission) {
  const cues = subtitleCuesForSubmission(submission);
  if (!cues.length) return { assText: null, cues };
  const assText = renderASS(cues, {
    fps: submission?.fps,
    tracks: submission?.tracks,
    dropFrame: submission?.dropFrame,
    backgroundLayouts: submission?.backgroundLayouts,
  });
  return { assText: /\nDialogue:/.test(assText) ? assText : null, cues };
}

/**
 * 依據凍結快照與 DeliveryList 編譯產出純淨的 ExportJob 清單。
 */
export function buildExportJobs(submission, list) {
  const expIn = submission.timelineStart != null ? submission.timelineStart : 0;
  const subtitlePayload = subtitlePayloadForSubmission(submission);

  return list.toJobs({
    clips: submission.clips,
    videoTracks: submission.videoTracks,
    duration: submission.duration,
    assText: subtitlePayload.assText,
    subtitleTracks: burnedSubtitleTrackNames(submission.tracks, subtitlePayload.cues),
    timelineStartTimecode: secToEncore(expIn, submission.fps, submission.dropFrame),
    composeAudioPlan: composeDeliveryAudioPlan,
    compiledAudioPlan: submission.audioPlan,
  });
}

/**
 * 執行凍結狀態的匯出送交事務流程。
 */
export async function runFrozenExportSubmission({
  capture,
  validate = () => null,
  checkConflicts = () => true,
  dispatch,
} = {}) {
  if (typeof capture !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('capture and dispatch are required');
  }

  const frozen = capture();
  if (!frozen) {
    return { status: 'invalid', reason: '目前沒有可匯出的影片或外部音訊' };
  }

  const invalidReason = validate(frozen);
  if (invalidReason) {
    return { status: 'invalid', reason: invalidReason };
  }

  if (!(await checkConflicts(frozen))) {
    return { status: 'cancelled' };
  }

  return { status: 'submitted', value: await dispatch(frozen) };
}

export { renderASS };

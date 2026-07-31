/* ==============================================================================
   SUB Tool — 字幕與影片 I/O 匯出模組 (I/O Layer)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (subio.js) 負責處理所有與外部檔案格式交握的邏輯。
   包含：字幕匯入 (解析)、字幕匯出 (生成字串)、以及影片/音訊匯出 (組裝 FFmpeg 參數)。
   
   1. 字幕格式與編碼安全 (Subtitles I/O)
      匯出時，處理了各種目標格式 (如 SRT, VTT, ASS, Encore TXT) 的特定要求
      (如時間碼精度、BOM 標記、UTF-16LE 轉碼)。所有解析後的資料都會被標準化
      為內部 `Cue` 結構。
      
   2. 影片匯出指令與 Filtergraph 組裝 (Video Export)
      負責在 `_runExportVideo` 中將目前時間軸的視訊軌、音軌、以及動態產生的
      ASS 字幕 (透過 `toASSFromState`) 編譯成 FFmpeg 可執行的 `filter_complex` 
      與輸入輸出參數。這也是本專案最容易因為參數順序或字元跳脫 (Escaping) 
      錯誤而導致匯出失敗的核心所在。

   【維護鐵律】
   - 修改 ASS 樣式或渲染尺寸時，請去 `substyle.js`。本檔的 `toASSFromState`
     只負責「套用樣式並生成檔案字串」，絕對不可在此處 Hardcode 字型設定。
   - 新增 FFmpeg 的 `-filter_complex` 濾鏡時，特別注意在 Windows 環境下
     對於 `\`, `:`, `'` 等特殊字元的雙層跳脫 (Double Escaping) 問題。
============================================================================== */
import { State, setFps, newTrack, syncTrackCount, newId, IS_DESKTOP, DESK, deselect } from './state.js';
import { $, video } from './dom.js';
import { decodeText, b64ToBytes, readFile, pickFile, encodeUTF16LE, bytesToB64, downloadBytes, baseName, escapeHTML } from './util.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { SubFormats } from './formats.js';
import { ASS_PLAY_RES, getAllPresets, loadFonts } from './substyle.js'; // ASS 虛擬畫布：與 HTML 預覽的縮放基準共用同一組
import { buildSubtitleImportPlan } from './subimport.js';
import { Media } from './media.js';
import { setStatus, showToast, showOsd, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { sortCues } from './subtitles.js';
import { drawTimeline, layoutTimeline } from './timeline.js';
import { Project } from './project.js';
import { emit } from './events.js';
import { parseTimecodeInput } from './tcparse.js';
import { buildXLSX } from './xlsxExport.js';
import { getNotesGeneralFileData, getNotesEdiusFileData } from './notes.js';
import { Seq } from './sequence.js';
import { AudioRouting } from './audio-routing.js';
import { applyDeliveryAudioSpec, composeDeliveryAudioPlan, createDeliveryAudioSpec } from './delivery-audio.js';
import { buildExportSnapshot } from './delivery-job.js';
import { createDeliveryList, projectTagFrom } from './delivery-list.js';
import { t } from './i18n.js';

/* 格式自動辨識 */
function detectSubFormat(text, ext) {
  if (ext === 'srt') return 'srt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (/\[Script Info\]/i.test(text)) return 'ass';
  if (/^\d+\r?\n\d{2}:\d{2}:\d{2}[,\.]\d{3}/m.test(text)) return 'srt';
  if (/(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)[ \t]+(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)/m.test(text)) return 'encore';
  return 'txt';
}
/* 匯入 / 匯出字幕 */
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
function _parseSubtitleText(text, kind) {
  if (kind === 'srt') return SubFormats.parseSRT(text);
  if (kind === 'ass') return SubFormats.parseASS(text);
  if (kind === 'encore') return SubFormats.parseEncore(text, State.fps, State.dropFrame);
  return SubFormats.parseTXT(text);
}
function _subtoolFpsValue(parsed) {
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
function _parsedSubtitleCount(parsed) {
  return Array.isArray(parsed?.subtool?.cues) ? parsed.subtool.cues.length : (parsed?.length || 0);
}
async function _prepareSubtitleImport(text, kind) {
  // ASS Style 的 Fontname 是檔內 family；先完成字型清單/FontFace 載入，解析時才能反查
  // 回 UI 資料夾名，避免舊自產 ASS 或無 metadata fallback 靜默退回系統字型。
  if (kind === 'ass') await loadFonts();
  // Encore 的時碼本身含「格」，必須先有 FPS 才能解析；ASS/SRT/TXT 則可先解析，
  // 讓自產 ASS 在空白專案時把原始 FPS 預選給使用者。
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
async function importSub() {
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
function _openImportModal(title, parsed, kind) {
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
        const presetVal = hasRoundTripMetadata ? '' : $('importPresetSel').value;
        const selectedPreset = presetVal ? getAllPresets().find(p => p.name === presetVal) : null;
        // ASS 一律走純規劃層：自產 metadata 可無損還原；外部 Style/override 與舊版
        // SUB Tool 的時間修正也會以完整逐句樣式/時間帶進來，不可只在 metadata 時才走它。
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
        else { State.cues = newCues; }
        
        // 只吸附本次匯入的 cue；附加到既有專案時不可順便改動其他字幕的影格位置。
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
function executeBatchExport(files) {
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

function getFileData(kind, cues, trackName) {
  if (!cues.length) return null;
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle').split('_')[0];
  const tkName = trackName ? trackName.replace(/[\\/:*?"<>|]/g, '_') : '軌道';
  let text, ext, fname;
  if (kind === 'srt') { 
    text = SubFormats.toSRT(cues); ext = 'srt'; 
    fname = `ST_${projName}_SUB_${tkName}.srt`;
  }
  else if (kind === 'ass') { 
    // 只有可獨立儲存的 ASS 帶無損 metadata。mpv live ASS 與 ffmpeg 燒錄仍只吃標準 ASS，
    // 避免每次刷新都夾帶整份專案資料。
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

function getXLSXFileData(trackDataList) {
  if (!trackDataList.length) return null;
  const bytes = buildXLSX(trackDataList, State.fps, State.dropFrame);
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle').split('_')[0];
  const fname = `ST_${projName}_SUB.xlsx`;
  return { name: fname, content: bytesToB64(bytes), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

// A3：toASS 的 8 個參數（含視窗/視訊尺寸後援）集中在一處，避免 app.js（mpv 預覽）與
// 此處（匯出 .ass）兩份引數列重複、後援值漂移導致預覽與匯出的字幕排版對不上。
// PlayRes 走 substyle 的 ASS_PLAY_RES 常數：HTML 預覽的縮放基準吃的是同一組數字，
// 兩邊各寫一份遲早會漂（字級／框線／陰影全都相對 PlayResY 換算）。
function toASSFromState(cues, options = {}) {
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(cues, State.fps, State.tracks, RX, RY, RX, RX, RY, {
    ...options,
    dropFrame: State.dropFrame,
  });
}

/* ===== 匯出影片（序列）：ProRes 422 HQ / MP4，燒錄可見軌字幕，音訊依混音器設定輸出 =====
   桌面版專屬（需系統 ffmpeg）。輸出時間軸＝序列時間軸，故字幕（時間軸時碼）與輸出對齊。 */
/* 匯出快照的組建已搬到 delivery-job.js —— 那裡不 import State／Media／DOM，
   所以可以不 mock 任何東西直接測（見該檔頭的說明與 tests/externalAudioPlan.test.js）。
   這裡只負責把目前的 State／Media／Seq 交給它。 */
function _exportSnapshot(){
  let liveExternalSources=[];
  try{ liveExternalSources = Media.externalAudio?.list?.() || []; }catch(e){}
  return buildExportSnapshot({
    state: State,
    mediaTracks: Media.tracks || [],
    liveExternalSources,
    sequenceEnd: Seq.end(),
  });
}
const _VENC_LABEL = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel QuickSync', h264_amf: 'AMD AMF' };
/* MP4 交付碼率的合理建議值（Mbps）＝像素數 × fps × 0.12 bit ÷ 1e6（H.264 中高品質經驗值）。
   ── v4.32：舊版固定預設 5Mbps、不看解析度 → 4K 用 5Mbps 會嚴重壓縮、畫面像被壓過
      （使用者回報「輸出像 proxy 品質」的真正成因之一）。實測 5Mbps→45Mbps 的 4K 匯出，
      前者的細節區明顯有色塊/馬賽克感。
   對照（0.12 係數）：720p@30≈4、1080p@30≈7、1080p@60≈15、4K@30≈30、4K@60≈60 Mbps。
   夾在 4~120 之間（下限 4 避免低解析度也被壓爛）。 */
function _suggestMbps(w = State.videoWidth || 1920, h = State.videoHeight || 1080) {
  const fps = State.fps || 30;
  const mbps = (w * h * fps * 0.12) / 1e6;
  return Math.round(Math.max(4, Math.min(120, mbps)));
}
let _lastVbrMbps = null; // 使用者手動改過的碼率（同一 session 記住）；null＝用依解析度的建議值
/* 對話框摘要：目前序列各來源會輸出幾條聲道（供使用者匯出前確認混音器狀態） */
function _mixerSummary() {
  const srcs = new Set(State.clips.map(c => c.audioSrc || (c.primary ? 'video' : 'clip:' + c.id)));
  let audible = 0, total = 0, hasFileSrc = false;
  for (const s of srcs) {
    const tks = Media.tracks.filter(t => (t.source || 'video') === s && t.file);
    if (!tks.length) continue;
    hasFileSrc = true;
    const anySolo = tks.some(t => t.solo);
    total += tks.length;
    audible += tks.filter(t => (anySolo ? t.solo : !t.muted) && (t.volume || 0) > 0).length;
  }
  if (!hasFileSrc) return '';
  return `：目前 <b>${audible}</b>/${total} 條聲道會發聲`;
}
async function showExportVideoDialog(initialDraft=null) {
  if (IS_DESKTOP && !DESK.exportVideo) { showToast('桌面版匯出元件未就緒'); return; }
  const data = _exportSnapshot();
  if (!data) { showToast('沒有可匯出的影片或外部音訊'); return; }
  if (data.audioOnly && !data.audioPlan) { showToast('純音訊 WAV 匯出需要專案音軌路由'); return; }
  const unresolved = data.audioPlan?.unresolvedSources || [];
  if (IS_DESKTOP && unresolved.length) {
    showToast(`找不到可供匯出的音訊母素材：${unresolved.map(item=>item.name).join('、')}。請重新連結來源檔。`);
    return;
  }
  
  const audioOnly = !!data.audioOnly;
  const hasProjectAudio = !!data.audioPlan;

  /* 清單與它的全部規則住在 delivery-list.js（純模組）。這支對話框只負責
     把清單畫成 DOM、把 DOM 事件轉成清單操作，以及做磁碟 I/O 的那一段檢查。 */
  const list = createDeliveryList({
    projectTag: projectTagFrom(State.mediaName),
    fps: State.fps || 25,
    canvasW: State.videoWidth || 1920,
    canvasH: State.videoHeight || 1080,
    audioOnly,
    defaultAudioLayout: State.audioProject?.exportLayout || {},
    desktop: IS_DESKTOP,
    initial: initialDraft?.deliverables || null,
  });

  let html = `
    <div style="font-size:13px;line-height:1.6;width:760px;display:flex;flex-direction:column;">

      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;">
        <div>
          <div style="font-weight:bold;font-size:14px;">交付清單</div>
          <!-- FPS-SYNC：交付時長和播放器／時間軸一律共用 secToEncore()，不可自行拼時碼。 -->
          <div id="evOutputDuration" data-seconds="${data.duration}" style="font-size:11px;color:var(--text-dim);margin-top:1px;">本次輸出時長：<b style="color:var(--text);font-variant-numeric:tabular-nums;">${secToEncore(data.duration, State.fps, State.dropFrame)}</b><span style="color:var(--text-faint);">（${data.duration.toFixed(3)} 秒）</span></div>
        </div>
        <button id="evAddRowBtn" style="padding:2px 8px;font-size:11px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;">＋新增一列</button>
      </div>
      
      <div id="evRowsContainer" style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding-right:4px;flex:1;"></div>
      
      <div id="evConflictMsg" style="color:var(--red);font-weight:bold;margin-top:12px;display:none;"></div>
    </div>
  `;

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
          ` : ''}
          <div style="flex:1"></div>
          <button class="ev-del icon" data-idx="${i}" style="padding:2px;font-size:12px;cursor:pointer;color:var(--red);background:transparent;border:none;" title="刪除此列">✕</button>
        </div>
        <!-- 檔名與輸出目錄自成一列：交付檔名常常很長（含專案代號、fps、聲道編組），
             和音軌／TC 擠在同一列時尾端會被截掉，看不到全貌。 -->
        <div style="display:flex;gap:12px;align-items:center;">
          <input type="text" class="ev-name" data-idx="${i}" value="${r.customName}" style="flex:3;min-width:0;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);" placeholder="檔名 (含副檔名)" title="${escapeHTML(r.customName || '')}">
          <input type="text" class="ev-outdir" data-idx="${i}" value="${r.outDir || ''}" readonly style="flex:2;min-width:0;padding:3px;font-size:12px;background:var(--bg-2);color:var(--text-dim);border:1px solid var(--border);cursor:pointer;${!IS_DESKTOP?'display:none;':''}" title="${escapeHTML(r.outDir || '點擊瀏覽選擇目錄')}" placeholder="選擇輸出目錄...">
          <button class="ev-dir-btn" data-idx="${i}" style="flex:none;padding:2px 8px;font-size:12px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;${!IS_DESKTOP?'display:none;':''}">瀏覽...</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--text-faint);">音訊: ${audioDesc}</span>
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
    $$('.ev-tc').forEach(el => el.onchange = e => list.setBurnTimecode(idxOf(e), e.target.checked));

    const pickDir = async e => {
      const idx = idxOf(e);
      const p = await DESK.exportDirectory([]);
      if (p) { list.setOutDir(idx, p); after(); }
    };
    $$('.ev-outdir').forEach(el => el.onclick = pickDir);
    $$('.ev-dir-btn').forEach(el => el.onclick = pickDir);
    $$('.ev-del').forEach(el => el.onclick = e => { list.removeAt(idxOf(e)); after(); });

    $$('.ev-audio-btn').forEach(el => el.onclick = e => {
      const idx = idxOf(e);
      // 交付列的編組是獨立草稿：不可為了重用設定視窗而暫時覆寫全域專案 buses，
      // 否則縮減交付 A 軌時會連來源聲道配線一起受到影響。
      const audioSpec = createDeliveryAudioSpec(State.audioProject, list.get(idx));
      closeModal();
      const deliveryFormat = list.get(idx).format;
      AudioRouting.openDeliveryOutputSettings(audioSpec, ({ saved, spec } = {}) => {
        if (saved && spec) list.applyRow(idx, applyDeliveryAudioSpec(list.get(idx), spec));
        void showExportVideoDialog({ deliverables: list.rows() });
      }, { deliveryFormat });
    });
  }

  /* 純規則由清單自己回答；這裡只剩「畫出訊息」與「問磁碟」兩件 I/O 的事。 */
  async function checkConflicts(isSubmitting = false) {
    const msg = $('evConflictMsg');
    if (!msg) return true;

    const blocking = list.problems().filter(p => p.kind === 'blocking')[0];
    if (blocking) {
      msg.textContent = blocking.message;
      msg.style.display = 'block';
      if (isSubmitting) alert(blocking.submitMessage || blocking.message);
      return false;
    }

    if (IS_DESKTOP) {
      try {
        const conflicts = [];
        for (const { dir, name } of list.outPaths()) {
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

  openModal('匯出交付清單', html, [
    { label: '取消', act: closeModal },
    { label: '全部送出', primary: true, act: async () => {
      if (list.count() === 0) { showToast('清單不能為空'); return; }
      if (!(await checkConflicts(true))) return;

      try {
        const expIn = data.timelineStart != null ? data.timelineStart : (State.exportIn != null ? State.exportIn : 0);
        const assText = !audioOnly && /\nDialogue:/.test(toASSFromState(State.cues))
          ? toASSFromState(State.cues.map(c => ({...c, start: Math.max(0, (c.start || 0) - expIn), end: Math.max(0, (c.end || 0) - expIn)})))
          : null;

        if (!IS_DESKTOP) {
          closeModal();
          await _exportVideoWeb(data, list.rows(), expIn, assText);
          return;
        }

        // 交付規格 → 匯出工作的轉換只有 toJobs() 一份；這裡只負責送出與回報。
        const jobs = list.toJobs({
          clips: data.clips,
          videoTracks: data.videoTracks,
          duration: data.duration,
          assText,
          timelineStartTimecode: secToEncore(expIn, State.fps, State.dropFrame),
          composeAudioPlan: composeDeliveryAudioPlan,
          compiledAudioPlan: data.audioPlan,
        });
        for (const job of jobs) {
          const jobId = await DESK.exportVideo(job);
          if (jobId) showToast(`排入佇列: ${job.defaultName}`);
        }
        closeModal();
        if (IS_DESKTOP && typeof DESK.openQueueMonitor === 'function') {
          setTimeout(() => DESK.openQueueMonitor(), 150);
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

async function _exportVideoWeb(data, deliverables, expIn, assText) {
  // 【修正】在載入 FFmpeg (可能耗時較長導致使用者手勢 Token 失效) 前，先檢查是否因重新整理遺失 File 物件
  if (!IS_DESKTOP) {
    for (const c of data.clips) {
      if (!c.path && !c.name && !c.web) continue;
      const base = baseName(c.path || c.name || '');
      const track = Media.tracks.find(t => (t.file && t.file.name === base) || (c.path && t.file?.path === c.path) || (c.path && t.file?.name === c.path) || (c.name && t.file?.name === c.name));
      if (!track || !track.file) {
        showToast(`請選擇遺失的媒體檔案：${base}`);
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,audio/*';
        const file = await pickFile(input);
        if (file) {
          Media.tracks.push({ file: file }); // 存入 Media.tracks 供後續匯出使用
        } else {
          showToast(`已取消匯出：未提供 ${base}`);
          return; // 使用者取消選擇，中斷匯出
        }
      }
    }
  }

  try {
    const ff = await Media.loadFFmpeg();
    
    // 如果有字幕，要求使用者提供一個本機字型檔，因為 WebAssembly 內沒有系統字型
    let fontSelected = false;
    if (assText) {
      alert('【網頁版字幕燒錄】\\n為使 ffmpeg.wasm 順利燒錄字幕 (libass)，請選擇一個本機字型檔 (.ttf 或 .otf)。\\n這將用作所有字幕的預設字型。');
      const inputEl = document.createElement('input');
      inputEl.type = 'file';
      inputEl.accept = '.ttf,.otf';
      const fontFile = await pickFile(inputEl);
      if (fontFile) {
        const fontData = await readFile(fontFile);
        try { ff.FS('mkdir', '/fonts'); } catch(e){}
        ff.FS('writeFile', '/fonts/default_font.ttf', new Uint8Array(fontData));
        // 強制替換 ASS 檔裡面的字型名稱為我們提供的預設字型，避免找不到
        assText = assText.replace(/Fontname: [^,]+,/g, 'Fontname: DefaultFont,');
        // 加入一條自訂字型的對應 (libass 可能需要 fonts.conf，但通常 fontsdir 下唯一字型會自動 fallback)
        ff.FS('writeFile', 'sub.ass', new TextEncoder().encode(assText));
        fontSelected = true;
      } else {
        showToast('未提供字型檔，本次匯出將不包含字幕');
        assText = null;
      }
    }

    for (const r of deliverables) {
      if (r.format === 'wav') { showToast('網頁版暫不支援純音訊 WAV 匯出'); continue; }
      if (r.format === 'prores') { showToast('網頁版暫不支援 ProRes 匯出'); continue; }
      
      const outName = r.customName || 'output.mp4';
      setStatus(`開始匯出 ${outName}...`, 'busy');
      
      const memInputs = [];
      const inputArgs = [];
      
      // 收集來源影片
      for (const [idx, c] of data.clips.entries()) {
        if (!c.path && !c.name && !c.web) continue;
        const base = baseName(c.path || c.name || '');
        const track = Media.tracks.find(t => (t.file && t.file.name === base) || (c.path && t.file?.path === c.path) || (c.path && t.file?.name === c.path) || (c.name && t.file?.name === c.name));
        if (!track || !track.file) continue;
        
        const fileName = `in_${idx}_${base.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        if (!memInputs.includes(fileName)) {
          const fileData = await readFile(track.file);
          ff.FS('writeFile', fileName, new Uint8Array(fileData));
          memInputs.push(fileName);
        }
        
        const start = Math.max(0, c.in);
        const duration = c.out - c.in;
        // 為了簡化，網頁版我們把每個 clip 當作獨立來源，後續用 filtergraph 串接或單純轉碼
        inputArgs.push('-ss', start.toString(), '-t', duration.toString(), '-i', fileName);
      }
      
      if (memInputs.length === 0) {
        showToast(`無法匯出 ${outName}：找不到原始媒體檔案 (File/Blob)`);
        continue;
      }
      
      const outPath = `out_${Date.now()}.mp4`;
      const kbps = r.kbps || 8000;
      
      let filtergraph = '';
      if (assText && fontSelected) {
        filtergraph = `ass=sub.ass:fontsdir=/fonts`;
      }
      
      let args = [...inputArgs];
      if (filtergraph) {
        args.push('-vf', filtergraph);
      }
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', kbps + 'k', outPath);
      
      await ff.run(...args);
      
      const outData = ff.FS('readFile', outPath);
      downloadBytes(outData.buffer, outName, 'video/mp4');
      
      // 清理 MEMFS
      for (const f of memInputs) { try { ff.FS('unlink', f); } catch(e){} }
      try { ff.FS('unlink', outPath); } catch(e){}
      
      setStatus(`已匯出 ${outName}`, 'ok');
      showToast(`已匯出 ${outName}`);
    }
  } catch (err) {
    setStatus('匯出失敗', '');
    showToast('匯出失敗: ' + (err.message || err));
    console.error(err);
  }
}

function doExportXLSX(trackDataList) {
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

/* 拖放檔案 */
['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('videoWrap').classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop' && e.relatedTarget) return; $('videoWrap').classList.remove('dragover'); }));
document.addEventListener('drop', async e => {
  e.preventDefault(); $('videoWrap').classList.remove('dragover');
  const f = e.dataTransfer.files[0]; if (!f) return;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (['subtool', 'json'].includes(ext)) Project.load(f);
  else if (['srt', 'ass', 'ssa', 'txt'].includes(ext)) { importDropped(f); }
  else if (IS_DESKTOP && (DESK.authorizeDroppedFile || DESK.getFilePath)) {
    // 桌面版：拖放影音必須與「🎬 影音」按鈕走同一條桌面路徑（ffprobe 實測 FPS、
    // 系統 ffmpeg 轉檔/多音軌、mpv 秒開）——否則 MXF 等非原生格式會落到
    // ffmpeg.wasm 的 1.6GB 上限而「沒有觸發轉檔」。路徑經 preload 的
    // webUtils.getPathForFile 解析（Electron 32 起 File.path 已移除）；
    // preload 會先把真實 File 的精確路徑授權給主程序；解析失敗時退回瀏覽器路徑。
    // 已有影片時 openIncoming 會詢問「加入序列」或「取代」。
    const p = DESK.authorizeDroppedFile ? await DESK.authorizeDroppedFile(f) : DESK.getFilePath(f);
    if (p) Media.openIncoming({ path: p }); else Media.openIncoming({ file: f });
  }
  else Media.openIncoming({ file: f });
});
async function importDropped(f) {
  const buf = await readFile(f); const text = decodeText(buf);
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const kind = detectSubFormat(text, ext);
  const parsed = await _prepareSubtitleImport(text, kind); if (!parsed) return;
  _openImportModal(`拖入字幕（${kind.toUpperCase()}，${_parsedSubtitleCount(parsed)} 條）`, parsed, kind);
}

/* ===== FPS 時間碼轉換 ===== */
function showFpsConvertDialog() {
  const tkIdx = State.listTrack;
  const tk = State.tracks[tkIdx];
  if (!tk) { showToast('請先選擇一個字幕軌道'); return; }
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
        // 縮放後務必對齊影格：否則列表時碼(四捨五入到整格)與時間軸區塊(原始秒數)會差一格
        for (const c of cues) {
          c.start = snapTimeToFrame(Math.max(0, c.start * ratio), State.fps, State.dropFrame);
          let ne = snapTimeToFrame(c.end * ratio, State.fps, State.dropFrame);
          if (ne < c.start + fr) ne = c.start + fr;
          c.end = ne;
        }
        // 更新 State.duration 為 max(影片片長, 最後字幕 end)
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

/* ===== 時間碼位移 / 持續時間調整 ===== */
function applyTcShift(sign) {
  const raw = ($('tcShiftInput').value || '').trim().replace(/^[+-]/, '');
  const t = parseTimecodeInput(raw);
  if (t == null || isNaN(t) || t <= 0) { showToast('請輸入有效的時間碼（例如 00:00:02:00）'); return; }
  const delta = sign * t;
  // A5：複用既有 _durAdjCues（Fix #13 已抽出），消除重複的 sel/track/all 取 cues 邏輯
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可以位移'); return; }
  for (const c of cues) { c.start = Math.max(0, c.start + delta); c.end = Math.max(c.start + 0.001, c.end + delta); }
  // v4.2.0 政策：位移不再自動裁切/刪除被重疊的鄰居字幕（keyboard.js 的 P 位移同此政策）
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('時間碼位移');
  setStatus(`已位移 ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s（共 ${cues.length} 條）`, 'ok');
}
// Fix #13：從隱含讀取 DOM 改為接受 scope 參數，方便測試與未來複用
function _durAdjCues(scope) {
  if (scope === 'sel') {
    const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
    return ids.map(id => State.cues.find(c => c.id === id)).filter(c => c && c.timed !== false);
  } else if (scope === 'track') {
    return State.cues.filter(c => c.timed !== false && (c.track || 0) === State.listTrack);
  } else {
    return State.cues.filter(c => c.timed !== false);
  }
}
function _nextInPoint(c) {
  const track = c.track || 0; let next = Infinity;
  for (const oc of State.cues) {
    if (oc.timed === false || oc.id === c.id || (oc.track || 0) !== track) continue;
    if (oc.start > c.start && oc.start < next) next = oc.start;
  }
  return next;
}
function applyDurAdjTc(sign) {
  const raw = ($('durAdjTcInput').value || '').trim().replace(/^[+-]/, '');
  const t = parseTimecodeInput(raw);
  if (t == null || isNaN(t) || t <= 0) { showToast('請輸入有效的時間碼（例如 00:00:01:00）'); return; }
  const delta = sign * t;
  const minDur = 1 / Math.max(State.fps || 25, 1);
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可調整'); return; }
  let adjusted = 0, skipped = 0;
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    // 只在「加長」時跳過已重疊的字幕——否則 min(nextIn) 夾限會反把它縮短；
    // 「縮短」（負 delta）照常執行，夾限順勢把重疊修復到 nextIn。
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
function applyDurAdjPct() {
  const pct = +($('durAdjPctInput').value || '100');
  if (isNaN(pct) || pct <= 0) { showToast('請輸入有效的百分比（例如 150）'); return; }
  const ratio = pct / 100;
  const minDur = 1 / Math.max(State.fps || 25, 1);
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可調整'); return; }
  let adjusted = 0, skipped = 0;
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    // 只在「放大」（>100%）時跳過已重疊的字幕；縮小照常執行，夾限順勢修復重疊
    if (ratio > 1 && c.end > nextIn) { skipped++; continue; }
    // 縮放後對齊影格，避免區塊邊緣落在格與格之間
    let newEnd = snapTimeToFrame(c.start + (c.end - c.start) * ratio, State.fps, State.dropFrame);
    newEnd = Math.max(c.start + minDur, newEnd);
    newEnd = Math.min(nextIn, newEnd);
    if (newEnd !== c.end) { c.end = newEnd; adjusted++; }
  }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${adjusted} 條字幕的持續時間（${pct}%${skipped ? `，跳過 ${skipped} 條已重疊` : ''}）`, 'ok');
}

/* 對外只有真正的字幕／匯出 I/O 動作。以前這裡還掛著五個底線名稱，
   純粹是為了讓測試構得到匯出計畫的純函式——那些已經搬到 delivery-job.js。 */
export { importSub, showExportDialog, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct, toASSFromState, executeBatchExport, showExportVideoDialog };

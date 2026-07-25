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
import { State, setFps, newTrack, syncTrackCount, newId, IS_DESKTOP, DESK } from './state.js';
import { $, video } from './dom.js';
import { decodeText, b64ToBytes, readFile, pickFile, encodeUTF16LE, bytesToB64, downloadBytes, baseName, escapeHTML } from './util.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { SubFormats } from './formats.js';
import { ASS_PLAY_RES, getAllPresets } from './substyle.js'; // ASS 虛擬畫布：與 HTML 預覽的縮放基準共用同一組
import { Media } from './media.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { snapAllCuesToFrames } from './subtitles.js';
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
import { t } from './i18n.js';

function convertLineBreaks(parsed) {
  for (const p of parsed) { if (p.text) p.text = p.text.replace(/\/\//g, '\n').replace(/\\\\/g, '\n'); }
  return parsed;
}
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
function _askFpsModal() {
  return new Promise(resolve => {
    const FPS_OPTS = [
      { v: '23.976', l: '23.98' }, { v: '24', l: '24' }, { v: '25', l: '25' },
      { v: '29.97df', l: '29.97 (Drop-frame)' }, { v: '29.97', l: '29.97 (Non-Drop-frame)' }, { v: '30', l: '30' },
    ];
    const opts = FPS_OPTS.map(o => `<option value="${o.v}"${o.v === '29.97' ? ' selected' : ''}>${o.l}</option>`).join('');
    openModal('選擇影格率 (FPS)',
      `<p style="margin:0 0 12px;font-size:13px;color:var(--text-faint)">尚未載入影片，請先設定字幕的影格率。</p>` +
      `<label>FPS：<select id="importFpsSel" style="margin-left:6px">${opts}</select></label>`,
      [{ label: '確定', primary: true, act: () => { const val = $('importFpsSel').value; closeModal(); resolve(val); } },
      { label: '取消', act: () => { closeModal(); resolve(null); } }]
    );
  });
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
  if (!State.mediaName) {
    const fpsVal = await _askFpsModal(); if (fpsVal === null) return;
    setFps(fpsVal);
  }
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const kind = detectSubFormat(text, ext);
  let parsed = [];
  try {
    if (kind === 'srt') parsed = SubFormats.parseSRT(text);
    else if (kind === 'ass') parsed = SubFormats.parseASS(text);
    else if (kind === 'encore') parsed = SubFormats.parseEncore(text, State.fps, State.dropFrame);
    else parsed = SubFormats.parseTXT(text);
  } catch (e) { showToast('解析失敗：' + e.message); return; }
  if (parsed.length === 0) { showToast('未解析到字幕（檢查格式/編碼）'); return; }
  convertLineBreaks(parsed);

  _openImportModal(`匯入字幕到哪個軌道？（已辨識為 ${kind.toUpperCase()}，${parsed.length} 條）`, parsed, kind);
}
function _openImportModal(title, parsed, kind) {
  const trackOpts = State.tracks.map((tk, i) => `<option value="${i}">軌道 ${i + 1}：${escapeHTML(tk.name)}</option>`).join('');
  const suggestName = kind.toUpperCase() + ' 字幕';
  const presets = getAllPresets();
  const presetOpts = '<option value="">— 不套用自訂樣式 —</option>' + presets.map(p => `<option value="${escapeHTML(p.name)}">${escapeHTML(p.name)}</option>`).join('');
  
  openModal(title,
    `<label style="display:block;padding:8px 0">目標軌道：<select id="importTkSel" style="margin-left:6px">${trackOpts}<option value="new" selected>＋ 新增軌道…</option></select></label>` +
    `<div id="importNewTkRow" style="padding-bottom:8px">軌道名稱：<input type="text" id="importNewTkName" style="margin-left:6px;width:160px" value="${escapeHTML(suggestName)}"></div>` +
    `<label style="display:block;padding-bottom:8px">套用樣式：<select id="importPresetSel" style="margin-left:6px">${presetOpts}</select></label>` +
    `<label style="display:block;padding-bottom:8px"><input type="checkbox" id="importAppend"> 附加（保留現有字幕）</label>`,
    [{
      label: '匯入', primary: true, act: () => {
        const selVal = $('importTkSel').value;
        const presetVal = $('importPresetSel').value;
        const selectedPreset = presetVal ? getAllPresets().find(p => p.name === presetVal) : null;
        let targetTk;
        if (selVal === 'new') {
          const tkName = ($('importNewTkName').value.trim()) || ('軌道 ' + (State.tracks.length + 1));
          const trk = newTrack(tkName);
          if (selectedPreset && selectedPreset.style) Object.assign(trk, selectedPreset.style);
          State.tracks.push(trk); syncTrackCount();
          targetTk = State.tracks.length - 1;
        } else { targetTk = +selVal; }
        const append = selVal === 'new' || $('importAppend').checked;
        closeModal();
        const newCues = parsed.map(p => {
          const s = p.start || 0;
          const e = p.end || 0;
          const cue = { id: newId(), start: s, end: e, text: p.text || '', track: targetTk, timed: p.timed !== false && !(p.start === 0 && p.end === 0 && kind === 'txt') };
          if (selVal !== 'new' && selectedPreset && selectedPreset.style) {
            cue.style = Object.assign({}, selectedPreset.style);
          }
          return cue;
        });
        if (kind === 'txt') newCues.forEach(c => c.timed = false);
        if (append) { State.cues.push(...newCues); }
        else { State.cues = newCues; }
        
        snapAllCuesToFrames();
        
        State.listTrack = targetTk;
        if (!append) { State.selectedId = null; State.selectedIds = []; }
        sortCues(); emit('render:listTrackSel'); emit('render:all');
        {
          const maxEnd = State.cues.reduce((m, c) => c.timed !== false ? Math.max(m, c.end) : m, 0);
          if (maxEnd > State.duration) { State.duration = maxEnd; emit('duration:known'); } else drawTimeline();
        }
        recordHistory('匯入字幕 ' + kind.toUpperCase());
        setStatus(`已匯入 ${parsed.length} 條字幕到「${State.tracks[targetTk]?.name}」(${kind.toUpperCase()})`, 'ok');
        showToast(`匯入 ${parsed.length} 條字幕`);
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
    [['encore', 'Adobe Encore (.txt)', true], ['srt', 'SRT (.srt)', false], ['ass', 'ASS (.ass)', false], ['txt', '純文字 (.txt)', false], ['xlsx', 'Excel (.xlsx)', false]]
      .map(([v, l, d]) => cb(`data-fmt="${v}"${d ? ' checked' : ''}`, escapeHTML(l))).join(''));

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
            for (const i of tks) {
              const cues = State.cues.filter(c => (c.track || 0) === i);
              if (cues.length) { const f = getFileData(fmt, cues, State.tracks[i]?.name); if (f) filesToExport.push(f); }
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
function exportSub(kind) {
  if (State.cues.length === 0) { showToast('沒有字幕可匯出'); return; }
  const filesToExport = [];
  if (kind === 'xlsx') {
    const list = State.tracks.map((tk, i) => ({ name: tk.name, cues: State.cues.filter(c => (c.track || 0) === i) })).filter(t => t.cues.length);
    const f = getXLSXFileData(list); if (f) filesToExport.push(f);
  } else {
    if (State.trackCount > 1) {
      for (let i = 0; i < State.tracks.length; i++) {
        const cues = State.cues.filter(c => (c.track || 0) === i);
        if (cues.length) { const f = getFileData(kind, cues, State.tracks[i]?.name); if (f) filesToExport.push(f); }
      }
    } else {
      const f = getFileData(kind, State.cues); if (f) filesToExport.push(f);
    }
  }
  executeBatchExport(filesToExport);
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
    text = toASSFromState(cues); ext = 'ass'; 
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
function toASSFromState(cues) {
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(cues, State.fps, State.tracks, RX, RY, RX, RX, RY);
}

/* ===== 匯出影片（序列）：ProRes 422 HQ / MP4，燒錄可見軌字幕，音訊依混音器設定輸出 =====
   桌面版專屬（需系統 ffmpeg）。輸出時間軸＝序列時間軸，故字幕（時間軸時碼）與輸出對齊。 */
/* 依混音器狀態算出某影片段要輸出哪些聲道（比照 applyGains：有獨奏則只留獨奏，否則留未靜音；套用音量）。
   預覽用的逐聲道 AAC 快取只拿來讀 M/S/音量與來源聲道座標；匯出一律改讀 c.path 的母素材。
   回傳 []＝全靜音；沒有逐聲道資訊時回 undefined，主程序會直接讀同一支母素材的原始音訊。 */
function _clipAudioSpec(c) {
  const srcKey = c.audioSrc || (c.primary ? 'video' : 'clip:' + c.id);
  const tks = Media.tracks.filter(t => (t.source || 'video') === srcKey && t.file && (t.kind === 'element' || t.kind === 'buffer'));
  if (!tks.length) return undefined; // 無逐聲道檔 → 回退來源原音
  const masterPath = typeof c?.path === 'string' && c.path ? c.path : null;
  if (!masterPath) return []; // 不可改以播放用 cache 匯出。
  const anySolo = tks.some(t => t.solo);
  return tks.filter(t => (anySolo ? t.solo : !t.muted) && (t.volume || 0) > 0)
            .map(t => {
              const hasSourceCoordinates = Number.isInteger(t.sourceStream) && Number.isInteger(t.sourceChannel);
              return {
                // 即使舊專案尚未記錄 sourceStream/sourceChannel，也只讀母素材；
                // 少了座標時 main process 會讀該母素材的預設 audio stream，絕不回退 m4a cache。
                file: masterPath,
                ...(hasSourceCoordinates ? { sourceStream:t.sourceStream, sourceChannel:t.sourceChannel } : {}),
                volume: +(t.volume != null ? t.volume : 1).toFixed(3)
              };
            });
}
/* 將專案層的 sourceMaps（來源聲道→bus）轉成 Electron 匯出端可直接編譯的 audioPlan。
   Media 的暫存單聲道檔案只提供目前混音器的 M/S/音量狀態與聲道準備情況；真正的 input.file
   必須是每個素材的母檔 path，並帶 sourceStream/sourceChannel 讓主程序直接解碼該聲道。
   audioSourceId / sourceStream / sourceChannel 全部採 0-based，與 state.js 的持久化格式一致。 */
function _externalAudioPlacements(externalSources) {
  const sources=Array.isArray(externalSources)
    ? externalSources : (typeof Media.getExternalAudioSources==='function' ? Media.getExternalAudioSources() : []);
  return sources.filter(asset=>asset&&asset.enabled!==false).map(asset=>{
    const trimStart=Math.max(0,Number(asset.in??asset.trimStart)||0);
    const rawEnd=Number(asset.out??asset.trimEnd??asset.duration);
    const trimEnd=Number.isFinite(rawEnd)?Math.max(trimStart,rawEnd):trimStart;
    return {
      source:asset,
      offset:Math.max(0,Number(asset.offset)||0),
      trimStart,
      trimEnd,
      fadeIn:Math.max(0,Number(asset.fadeIn)||0),
      fadeOut:Math.max(0,Number(asset.fadeOut)||0),
      gain:Math.max(0,Number(asset.gain==null?1:asset.gain)||0)
    };
  }).filter(placement=>placement.trimEnd>placement.trimStart);
}
/* 即使來源被靜音，它仍是時間軸上的素材；輸出影片的黑畫面／總長不能因 Mute 縮短。
   音訊輸入本身仍由 _externalAudioPlacements 過濾 enabled=false。 */
function _externalAudioTimelineEnd(externalSources){
  const sources=Array.isArray(externalSources)
    ? externalSources : (typeof Media.getExternalAudioSources==='function' ? Media.getExternalAudioSources() : []);
  return sources.reduce((end,asset)=>{
    if(!asset) return end;
    const offset=Math.max(0,Number(asset.offset)||0);
    const trimStart=Math.max(0,Number(asset.in??asset.trimStart)||0);
    const rawEnd=Number(asset.out??asset.trimEnd??asset.duration);
    const trimEnd=Number.isFinite(rawEnd)?Math.max(trimStart,rawEnd):trimStart;
    return Math.max(end,offset+Math.max(0,trimEnd-trimStart));
  },0);
}

/* runtime 已重建的音檔以 Media registry 為準；尚未能重開（例如檔案暫時離線）的
   source 則保留 State 的可序列化 placement。如此匯出前會被標成 unresolved，
   不會悄悄少掉一段音訊或把總長縮短。 */
function _projectExternalAudioSources(){
  let live=[];
  try{ live=typeof Media.getExternalAudioSources==='function'?Media.getExternalAudioSources():[]; }catch(e){}
  const byId=new Map();
  for(const source of (Array.isArray(State.externalAudioState)?State.externalAudioState:[])){
    const id=typeof source?.audioSourceId==='string'?source.audioSourceId:'';
    if(id) byId.set(id,source);
  }
  for(const source of (Array.isArray(live)?live:[])){
    const id=typeof source?.audioSourceId==='string'?source.audioSourceId:'';
    if(id) byId.set(id,source); // runtime 有實體檔與最新編輯資料，優先採用
  }
  return [...byId.values()];
}

/* clips 與外部 audio asset 都先正規化為 placement，再共用同一條 bus/input 編譯流程。
   外部 asset 沒有視訊，但它的 offset/in/out 是 timeline 域資料，故輸出能與預覽同位置對齊。 */
function _buildProjectAudioPlan(clips, externalSources=null) {
  const project = State.audioProject;
  if (!project || !Array.isArray(project.buses) || !project.buses.length || !project.sourceMaps || !project.exportLayout)
    return null; // 尚未進入專案音訊模式時，由主程序沿用舊版 stereo 匯出
  const buses = project.buses.map(bus => ({ id: bus.id, inputs: [] }));
  const busById = new Map(project.buses.map((bus, i) => [bus.id, { bus, plan: buses[i] }]));
  const anySolo = project.buses.some(bus => bus.solo);
  const busGain = new Map(project.buses.map(bus => {
    const audible = anySolo ? !!bus.solo : !bus.muted;
    return [bus.id, audible ? Math.max(0, Number(bus.volume == null ? 1 : bus.volume) || 0) : 0];
  }));
  const unresolvedSources=new Map();

  const placements=[
    ...(Array.isArray(clips)?clips:[]).filter(clip=>!clip.audioDetached).map(clip=>({
      source:clip,
      offset:Math.max(0,Number(clip.offset)||0),
      trimStart:Math.max(0,Number(clip.in)||0),
      trimEnd:Math.max(0,Number(clip.out)||0),
      fadeIn:Math.max(0,Number(clip.fadeIn)||0),
      fadeOut:Math.max(0,Number(clip.fadeOut)||0),
      gain:1
    })),
    ..._externalAudioPlacements(externalSources)
  ];

  for (const placement of placements) {
    const source=placement.source;
    const sourceId = source.audioSourceId;
    if (typeof sourceId !== 'string' || !sourceId) continue;
    if (!(placement.trimEnd>placement.trimStart) || placement.gain<=0) continue;
    const masterPath=typeof source.path==='string'&&source.path ? source.path : '';
    const routes = project.sourceMaps[sourceId]?.channels;
    if (!Array.isArray(routes) || !routes.length) continue;
    // 同一來源在 Media.tracks 可能有非匯出用的 native track；快取 track 只負責讀取
    // 使用者在混音器做的 M/S/音量，不能再把它的低碼率 m4a 路徑交給匯出。
    const tracksByDescriptor = new Map();
    const sourceTracks = Media.tracks.filter(track => track?.file && track.audioSourceId === sourceId && Number.isInteger(track.sourceStream) && Number.isInteger(track.sourceChannel));
    // 保留既有混音器的逐聲道 M/S/音量行為。專案 bus 的 M/S/音量會在下方再疊加，
    // 兩層控制與播放預覽一致；同一來源內有 Solo 時只輸出該來源被 Solo 的聲道。
    const sourceHasSolo = sourceTracks.some(track => track.solo);
    for (const track of sourceTracks) {
      const key = track.sourceStream + ':' + track.sourceChannel;
      if (!tracksByDescriptor.has(key)) tracksByDescriptor.set(key, track);
    }
    for (const route of routes) {
      if (!route || route.enabled === false || !Array.isArray(route.busIds)) continue;
      // 被靜音／未指派的 bus 本來就不會輸出，不需要因為它的快取尚未完成而阻擋匯出。
      const activeBusIds=[...new Set(route.busIds)].filter(busId=>busGain.get(busId)>0&&busById.has(busId));
      if(!activeBusIds.length) continue;
      const sourceStream=Number.isInteger(route.sourceStream)?route.sourceStream:null;
      const sourceChannel=Number.isInteger(route.sourceChannel)?route.sourceChannel:null;
      const sourceTrack = sourceStream!=null && sourceChannel!=null
        ? tracksByDescriptor.get(sourceStream + ':' + sourceChannel) : null;
      if (!masterPath || sourceStream==null || sourceChannel==null) {
        // 沒有可重新讀取的母素材時不能偷偷退回 proxy／AAC cache；明確阻擋匯出。
        unresolvedSources.set(sourceId,source.name||'未命名音訊來源');
        continue;
      }
      // 快取尚未建立時，sourceMaps 已有完整聲道座標，仍可由母素材直接輸出；此時採預設
      // 未靜音、音量 1。快取就緒後才將使用者已設定的個別 M/S/音量一併反映。
      const trackAudible = sourceTrack ? (sourceHasSolo ? !!sourceTrack.solo : !sourceTrack.muted) : !sourceHasSolo;
      const trackGain = sourceTrack ? Math.max(0, Number(sourceTrack.volume == null ? 1 : sourceTrack.volume) || 0) : 1;
      if (!trackAudible || trackGain <= 0) continue;
      const routeGain = Math.max(0, Number(route.gain == null ? 1 : route.gain) || 0);
      for (const busId of activeBusIds) {
        const target = busById.get(busId);
        const volume = trackGain * routeGain * placement.gain * (busGain.get(busId) || 0);
        if (!target || volume <= 0) continue;
        target.plan.inputs.push({
          // 這是母素材，絕不使用 sourceTrack.file（播放／波形的 AAC cache）。
          file: masterPath,
          sourceStream,
          sourceChannel,
          offset: +placement.offset.toFixed(6),
          trimStart: +placement.trimStart.toFixed(6),
          trimEnd: +placement.trimEnd.toFixed(6),
          volume: +volume.toFixed(6),
          fadeIn: +placement.fadeIn.toFixed(6),
          fadeOut: +placement.fadeOut.toFixed(6),
        });
      }
    }
  }
  return {
    buses,
    unresolvedSources:[...unresolvedSources.entries()].map(([audioSourceId,name])=>({audioSourceId,name})),
    streams: (Array.isArray(project.exportLayout.streams) ? project.exportLayout.streams : []).map(stream => ({
      id: stream.id,
      layout: stream.layout,
      busIds: Array.isArray(stream.busIds) ? [...stream.busIds] : [],
      ...(typeof stream.name==='string'&&stream.name.trim()?{name:stream.name.trim()}:{}),
    })),
  };
}
/* 匯出資料（v4.11.0 多軌合成）：送扁平片段清單（各含 vtrack 與音訊規格）＋視訊軌順序（由下而上）＋總長。
   主程序據此：每視訊軌各建整條時間軸（片段放 offset、間隙透明），由下而上 overlay 疊層；
   所有片段音訊各自 adelay 到 offset 後 amix（全軌混音）。單軌序列為此法之特例，結果與舊版一致。 */
function _buildExportData() {
  const rawSourceClips = [...State.clips].filter(c => c.path);
  const rawExternalSources=_projectExternalAudioSources();
  
  let expIn = State.exportIn != null ? State.exportIn : 0;
  let rawDur = Math.max(Seq.end(), _externalAudioTimelineEnd(rawExternalSources));
  let expOut = State.exportOut != null ? State.exportOut : rawDur;
  if (expOut <= expIn) expOut = expIn + 0.1;

  function _slice(c) {
    const startProp = c.in != null ? c.in : (c.trimStart || 0);
    const endProp = c.out != null ? c.out : (c.trimEnd != null ? c.trimEnd : c.duration);
    const cDur = endProp - startProp;
    const cEnd = (c.offset || 0) + cDur;
    if (cEnd <= expIn || (c.offset || 0) >= expOut) return null;
    let newIn = startProp, newOut = endProp, newOffset = (c.offset || 0) - expIn;
    if (newOffset < 0) { newIn += (-newOffset); newOffset = 0; }
    const newDur = newOut - newIn;
    if (newOffset + newDur > (expOut - expIn)) newOut = newIn + ((expOut - expIn) - newOffset);
    return { ...c, in: newIn, out: newOut, trimStart: newIn, trimEnd: newOut, offset: newOffset };
  }

  const sourceClips = rawSourceClips.map(_slice).filter(Boolean);
  const externalSources = rawExternalSources.map(_slice).filter(Boolean);

  const audibleVideoClips=sourceClips.filter(c=>!c.audioDetached);
  const externalPlacements=_externalAudioPlacements(externalSources);
  if (!sourceClips.length&&!externalPlacements.length) return null;
  const audioPlan = _buildProjectAudioPlan(audibleVideoClips,externalSources);
  const finite=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
  const ratio=(value,fallback)=>Math.max(0,Math.min(1,finite(value,fallback)));
  const list = sourceClips.map(c => {
    /* 圖片不是一格影片：主程序必須收到 type=image，才能為該輸入加上
       `-loop 1`。若在這裡遺失型別，ffmpeg 只會讀 PNG/JPG 的第一格，
       看起來就像整支輸出停在開頭。圖片的個別縮放／位置也要一併交給
       匯出 filtergraph，才會和預覽一致。 */
    const image=c.type==='image';
    return {
      path: c.path, type:image?'image':'video',
      in: +c.in.toFixed(3), out: +c.out.toFixed(3),
      offset: +c.offset.toFixed(3), vtrack: c.vtrack || 0, audio: c.audioDetached?[]:_clipAudioSpec(c),
      fadeIn: +(c.fadeIn || 0).toFixed(3), fadeOut: +(c.fadeOut || 0).toFixed(3), // 轉場：淡入/淡出（秒）
      ...(image?{
        scale:Math.max(0.01,finite(c.scale,1)),
        posX:ratio(c.posX,0.5), posY:ratio(c.posY,0.5),
        /* 原生尺寸讓主程序能用【與預覽同一條公式】算出精確的 contain 尺寸
           （見 electron/export-plan.js imageBoxForExport ≡ src/imagegeom.js imageBox）。
           舊專案可能沒有這兩個值，主程序會退回讓 ffmpeg 自己算 —— 結果相同，
           只是少了「兩邊用同一份實作」的保證。 */
        natW:Math.max(0,finite(c.natW,0)), natH:Math.max(0,finite(c.natH,0))
      }:{}),
    };
  });
  const vtOrder = [...new Set(list.map(c => c.vtrack))].sort((a, b) => a - b); // 由下而上（vtrack 小＝底層先畫）
  const videoTracks = vtOrder.map(vt => {
    const t = State.videoTracks[vt] || {};
    return { vt, scale: +(t.scale != null ? t.scale : 1), posX: +(t.posX != null ? t.posX : 0.5), posY: +(t.posY != null ? t.posY : 0.5), opacity: +(t.opacity != null ? t.opacity : 1) };
  });
  const externalEnd=_externalAudioTimelineEnd(externalSources);
  return {
    clips:list,
    videoTracks,
    // 匯出會把片段 offset 歸零；保留原始時間軸起點供 burn-in 時碼等交付資訊使用。
    // 不四捨五入：23.976／29.97 的單格不足 0.04 秒，保留完整值才不會讓第一格差一格。
    timelineStart:expIn,
    duration:+(expOut - expIn).toFixed(3),
    audioPlan,
    audioOnly:list.length===0,
    externalAudioCount:externalPlacements.length
  };
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
  if (!IS_DESKTOP || !DESK.exportVideo) { showToast('影片匯出僅在桌面版可用'); return; }
  const data = _buildExportData();
  if (!data) { showToast('沒有可匯出的影片或外部音訊'); return; }
  if (data.audioOnly && !data.audioPlan) { showToast('純音訊 WAV 匯出需要專案音軌路由'); return; }
  const unresolved = data.audioPlan?.unresolvedSources || [];
  if (unresolved.length) {
    showToast(`找不到可供匯出的音訊母素材：${unresolved.map(item=>item.name).join('、')}。請重新連結來源檔。`);
    return;
  }
  
  const projName = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'sequence').split('_')[0];
  const audioOnly = !!data.audioOnly;
  const hasProjectAudio = !!data.audioPlan;
  
  // draft initialization
  const draft = initialDraft || {
    outDir: '',
    deliverables: [{
      format: audioOnly ? 'wav' : 'h264',
      kbps: 8000,
      targetH: 0,
      burnTimecode: false,
      audioPlan: JSON.parse(JSON.stringify(AudioRouting.state.outputPlan || {})),
      customName: ''
    }]
  };
  
  // if this is the first open, try to use project path as outDir
  if (!initialDraft) {
    DESK.getStartupFile().then(p => {
      if (p) {
        draft.outDir = p.replace(/\\[^\\]+$/, '');
        const od = $('evOutDir');
        if (od) { od.value = draft.outDir; checkConflicts(); }
      }
    });
  }

  let html = `
    <div style="font-size:13px;line-height:1.6;width:680px;max-height:600px;display:flex;flex-direction:column;">
      <div style="margin-bottom:12px;font-weight:bold;font-size:14px;">輸出目錄</div>
      <div style="display:flex;gap:6px;margin-bottom:16px;">
        <input type="text" id="evOutDir" style="flex:1;padding:4px;font-size:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);" readonly>
        <button id="evChooseDirBtn" style="padding:4px 8px;font-size:12px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;">瀏覽...</button>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;">
        <div style="font-weight:bold;font-size:14px;">交付清單</div>
        <button id="evAddRowBtn" style="padding:2px 8px;font-size:11px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;">＋新增一列</button>
      </div>
      
      <div id="evRowsContainer" style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding-right:4px;flex:1;"></div>
      
      <div id="evConflictMsg" style="color:var(--red);font-weight:bold;margin-top:12px;display:none;"></div>
    </div>
  `;

  function renderRow(r, i) {
    const isWav = r.format === 'wav';
    
    if (!r.customName) {
      let ext = '.mp4';
      if (r.format === 'prores') ext = '.mov';
      if (r.format === 'wav') ext = '.wav';
      let tag = r.format === 'h264' ? '_H264' : (r.format === 'prores' ? '_ProRes' : '_WAV');
      if (!isWav && r.targetH > 0) tag += '_' + r.targetH + 'p';
      r.customName = projName + tag + ext;
    }

    const ap = r.audioPlan;
    let audioDesc = '依專案音軌順序';
    if (!isWav && ap && ap.groups) {
      const gCounts = ap.groups.map(g => {
        if (g.layout==='stereo') return '2.0';
        if (g.layout==='5.1') return '5.1';
        if (g.layout==='mono') return '1.0';
        return g.layout;
      });
      const tCount = ap.groups.reduce((acc,g) => acc + (g.layout==='5.1'?6:(g.layout==='stereo'?2:1)), 0);
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
          ` : ''}
          <div style="flex:1"></div>
          <button class="ev-del icon" data-idx="${i}" style="padding:2px;font-size:12px;cursor:pointer;color:var(--red);background:transparent;border:none;" title="刪除此列">✕</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;">
          <input type="text" class="ev-name" data-idx="${i}" value="${r.customName}" style="flex:1;padding:3px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);" placeholder="檔名 (含副檔名)">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--text-faint);">音訊: ${audioDesc}</span>
            ${!isWav ? `<button class="ev-audio-btn" data-idx="${i}" style="padding:2px 6px;font-size:11px;cursor:pointer;background:var(--panel3);border:1px solid var(--border);color:var(--text);border-radius:4px;">⚙ 聲道</button>` : ''}
          </div>
          ${!isWav ? `<label style="font-size:11px;display:flex;align-items:center;gap:4px;"><input type="checkbox" class="ev-tc" data-idx="${i}" ${r.burnTimecode?'checked':''}>燒入TC</label>` : ''}
        </div>
      </div>
    `;
  }

  function $ (sel) { return document.querySelectorAll(sel); }

  function updateRows() {
    const c = $('evRowsContainer');
    if (!c) return;
    c.innerHTML = draft.deliverables.map((r, i) => renderRow(r, i)).join('');
    
    $('.ev-format').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables[idx].format = e.target.value;
      draft.deliverables[idx].customName = ''; 
      updateRows();
      checkConflicts();
    });
    $('.ev-res').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      if (e.target.value === 'custom') {
        draft.deliverables[idx].targetH = 480;
      } else {
        draft.deliverables[idx].targetH = parseInt(e.target.value);
      }
      draft.deliverables[idx].customName = '';
      if (draft.deliverables[idx].format === 'h264') {
        let w = State.videoWidth || 1920, h = draft.deliverables[idx].targetH || 1080;
        if (draft.deliverables[idx].targetH > 0) {
          const aspect = w / (State.videoHeight || 1080);
          w = Math.round(h * aspect);
          w -= (w % 2); 
        }
        draft.deliverables[idx].kbps = Math.round((w * h * 30 * 0.1) / 1000);
      }
      updateRows();
      checkConflicts();
    });
    $('.ev-custom-res').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables[idx].targetH = parseInt(e.target.value);
      draft.deliverables[idx].customName = '';
      updateRows();
      checkConflicts();
    });
    $('.ev-kbps').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables[idx].kbps = parseInt(e.target.value);
    });
    $('.ev-name').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables[idx].customName = e.target.value;
      checkConflicts();
    });
    $('.ev-tc').forEach(el => el.onchange = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables[idx].burnTimecode = e.target.checked;
    });
    $('.ev-del').forEach(el => el.onclick = e => {
      const idx = +e.target.dataset.idx;
      draft.deliverables.splice(idx, 1);
      updateRows();
      checkConflicts();
    });
    $('.ev-audio-btn').forEach(el => el.onclick = e => {
      const idx = +e.target.dataset.idx;
      const oldPlan = JSON.parse(JSON.stringify(AudioRouting.state.outputPlan || {}));
      AudioRouting.state.outputPlan = JSON.parse(JSON.stringify(draft.deliverables[idx].audioPlan));
      closeModal();
      AudioRouting.openOutputSettings(() => {
        draft.deliverables[idx].audioPlan = JSON.parse(JSON.stringify(AudioRouting.state.outputPlan));
        AudioRouting.state.outputPlan = oldPlan;
        void showExportVideoDialog(draft);
      });
    });
  }

  async function checkConflicts() {
    const msg = $('evConflictMsg');
    if (!msg || !draft.outDir) return true;
    
    const names = draft.deliverables.map(r => r.customName.toLowerCase());
    const hasDupes = new Set(names).size !== names.length;
    if (hasDupes) {
      msg.textContent = '警告：交付清單內有重複的檔名！';
      msg.style.display = 'block';
      return false;
    }
    
    try {
      const files = await DESK.listDir(draft.outDir);
      const existing = files.map(f => f.name.toLowerCase());
      const conflicts = names.filter(n => existing.includes(n));
      if (conflicts.length > 0) {
        msg.textContent = `警告：硬碟上已存在同名檔案 (${conflicts.join(', ')})`;
        msg.style.display = 'block';
        return false;
      }
    } catch(e){}
    
    msg.style.display = 'none';
    return true;
  }

  openModal('匯出交付清單', html, [
    { label: '取消', act: closeModal },
    { label: '全部送出', primary: true, act: async () => {
      if (!draft.outDir) { showToast('請先選擇輸出目錄'); return; }
      if (draft.deliverables.length === 0) { showToast('清單不能為空'); return; }
      if (!(await checkConflicts())) return;
      
      const expIn = data.timelineStart != null ? data.timelineStart : (State.exportIn != null ? State.exportIn : 0);
      const assText = !audioOnly && /\nDialogue:/.test(toASSFromState(State.cues)) 
        ? toASSFromState(State.cues.map(c => ({...c, start: Math.max(0, (c.start || 0) - expIn), end: Math.max(0, (c.end || 0) - expIn)}))) 
        : null;
      
      for (const [idx, r] of draft.deliverables.entries()) {
        const isWav = r.format === 'wav';
        const outPath = draft.outDir + '\\' + r.customName;
        
        let w = State.videoWidth || 1920;
        let h = State.videoHeight || 1080;
        if (!isWav && r.targetH > 0) {
          h = r.targetH;
          const aspect = (State.videoWidth || 1920) / (State.videoHeight || 1080);
          w = Math.round(h * aspect);
          w -= (w % 2); 
        }

        const jobId = await DESK.exportVideo({
          clips: data.clips,
          videoTracks: data.videoTracks,
          width: w,
          height: h,
          fps: State.fps || 25,
          assText: assText,
          format: r.format,
          duration: data.duration,
          videoKbps: r.kbps,
          audioPlan: isWav ? null : r.audioPlan,
          timecodeWatermark: !isWav && r.burnTimecode ? { start: secToEncore(expIn, State.fps, State.dropFrame) } : null,
          defaultName: r.customName,
          outPath: outPath
        });
        
        if (jobId) showToast(`排入佇列: ${r.customName}`);
      }
      closeModal();
    }}
  ], { keepVideo: true });

  const od = $('evOutDir');
  if (od) od.value = draft.outDir;
  
  $('evChooseDirBtn').onclick = async () => {
    const p = await DESK.exportDirectory([]);
    if (p) {
      draft.outDir = p;
      od.value = p;
      checkConflicts();
    }
  };

  $('evAddRowBtn').onclick = () => {
    if (draft.deliverables.length === 0) {
      draft.deliverables.push({
        format: audioOnly ? 'wav' : 'h264', kbps: 8000, targetH: 0, burnTimecode: false,
        audioPlan: JSON.parse(JSON.stringify(AudioRouting.state.outputPlan || {})), customName: ''
      });
    } else {
      const last = draft.deliverables[draft.deliverables.length - 1];
      draft.deliverables.push({
        ...JSON.parse(JSON.stringify(last)),
        customName: ''
      });
    }
    updateRows();
    checkConflicts();
  };

  setTimeout(() => {
    updateRows();
    checkConflicts();
  }, 20);
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
  else if (IS_DESKTOP && DESK.getFilePath) {
    // 桌面版：拖放影音必須與「🎬 影音」按鈕走同一條桌面路徑（ffprobe 實測 FPS、
    // 系統 ffmpeg 轉檔/多音軌、mpv 秒開）——否則 MXF 等非原生格式會落到
    // ffmpeg.wasm 的 1.6GB 上限而「沒有觸發轉檔」。路徑經 preload 的
    // webUtils.getPathForFile 解析（Electron 32 起 File.path 已移除）；
    // 解析失敗時退回瀏覽器路徑。後續 ffprobe 會把該目錄加入 S1 白名單（main.js）。
    // 已有影片時 openIncoming 會詢問「加入序列」或「取代」。
    const p = DESK.getFilePath(f);
    if (p) Media.openIncoming({ path: p }); else Media.openIncoming({ file: f });
  }
  else Media.openIncoming({ file: f });
});
async function importDropped(f) {
  const buf = await readFile(f); const text = decodeText(buf);
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const kind = detectSubFormat(text, ext);
  let parsed;
  if (kind === 'srt') parsed = SubFormats.parseSRT(text);
  else if (kind === 'ass') parsed = SubFormats.parseASS(text);
  else if (kind === 'encore') parsed = SubFormats.parseEncore(text, State.fps, State.dropFrame);
  else parsed = SubFormats.parseTXT(text);
  if (!parsed.length) { showToast('未解析到字幕'); return; }
  convertLineBreaks(parsed);
  _openImportModal(`拖入字幕（${kind.toUpperCase()}，${parsed.length} 條）`, parsed, kind);
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

export { importSub, showExportDialog, exportSub, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct, toASSFromState, executeBatchExport, showExportVideoDialog,
  _buildProjectAudioPlan, _externalAudioPlacements, _externalAudioTimelineEnd, _buildExportData };

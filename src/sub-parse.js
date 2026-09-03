import { State, setFps, newTrack, syncTrackCount, newId, IS_DESKTOP, DESK, deselect } from './state.js';
import { $ } from './dom.js';
import { decodeText, b64ToBytes, readFile, pickFile, escapeHTML } from './util.js';
import { snapTimeToFrame } from './time.js';
import { SubFormats } from './formats.js';
import { getAllPresets, loadFonts } from './substyle.js';
import { buildSubtitleImportPlan } from './project-intake-engine.js';
import { setStatus, showToast, openModal, closeModal } from './ui.js';
import { recordHistory } from './history.js';
import { sortCues, trackLocked } from './subtitle-model.js';
import { drawTimeline } from './timeline.js';
import { emit } from './events.js';

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

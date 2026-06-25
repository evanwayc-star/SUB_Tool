/* SUB Tool — 字幕匯入 / 匯出 / 拖放 / FPS 轉換 / 時間碼位移 / 持續時間調整 */
import { State, setFps, newTrack, syncTrackCount, newId, IS_DESKTOP, DESK } from './state.js';
import { $, video } from './dom.js';
import { decodeText, b64ToBytes, readFile, pickFile, encodeUTF16LE, bytesToB64, downloadBytes, baseName, escapeHTML } from './util.js';
import { secToEncore, snapTimeToFrame } from './time.js';
import { SubFormats } from './formats.js';
import { Media } from './media.js';
import { openModal, closeModal, showToast, setStatus } from './ui.js';
import { recordHistory } from './history.js';
import { sortCues } from './subtitles.js';
import { drawTimeline, layoutTimeline } from './timeline.js';
import { Project } from './project.js';
import { emit } from './events.js';
import { parseTimecodeInput } from './tcparse.js';
import { buildXLSX } from './xlsxExport.js';
import { doExportNotesGeneral, doExportNotesEdius } from './notes.js';

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
  openModal(title,
    `<label style="display:block;padding:8px 0">目標軌道：<select id="importTkSel" style="margin-left:6px">${trackOpts}<option value="new" selected>＋ 新增軌道…</option></select></label>` +
    `<div id="importNewTkRow" style="padding-bottom:8px">軌道名稱：<input type="text" id="importNewTkName" style="margin-left:6px;width:160px" value="${escapeHTML(suggestName)}"></div>` +
    `<label style="display:block;padding-bottom:8px"><input type="checkbox" id="importAppend"> 附加（保留現有字幕）</label>`,
    [{
      label: '匯入', primary: true, act: () => {
        const selVal = $('importTkSel').value;
        let targetTk;
        if (selVal === 'new') {
          const tkName = ($('importNewTkName').value.trim()) || ('軌道 ' + (State.tracks.length + 1));
          State.tracks.push(newTrack(tkName)); syncTrackCount();
          targetTk = State.tracks.length - 1;
        } else { targetTk = +selVal; }
        const append = selVal === 'new' || $('importAppend').checked;
        closeModal();
        const newCues = parsed.map(p => {
          const s = snapTimeToFrame(p.start || 0, State.fps, State.dropFrame);
          const e = snapTimeToFrame(p.end || 0, State.fps, State.dropFrame);
          return { id: newId(), start: s, end: e, text: p.text || '', track: targetTk, timed: p.timed !== false && !(p.start === 0 && p.end === 0 && kind === 'txt') };
        });
        if (kind === 'txt') newCues.forEach(c => c.timed = false);
        if (append) { State.cues.push(...newCues); }
        else { State.cues = newCues; }
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

  const sec = (title, body) => `<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">${title}</div>${body}</div>`;
  const cb = (attrs, label) => `<label style="display:block;padding:3px 0;cursor:pointer"><input type="checkbox" ${attrs}> ${label}</label>`;

  let html = sec('字幕格式',
    [['encore', 'Adobe Encore (.txt)', true], ['srt', 'SRT (.srt)', false], ['ass', 'ASS (.ass)', false], ['txt', '純文字 (.txt)', false], ['xlsx', 'Excel (.xlsx)', false]]
      .map(([v, l, d]) => cb(`data-fmt="${v}"${d ? ' checked' : ''}`, escapeHTML(l))).join(''));

  if (State.cues.length && State.trackCount > 1)
    html += sec('軌道',
      State.tracks.map((tk, i) => cb(`data-tk="${i}" checked`, `${escapeHTML(tk.name)} <span style="color:var(--text-faint)">(${State.cues.filter(c => (c.track || 0) === i).length} 條)</span>`)).join('')
      + `<div style="font-size:11px;color:var(--text-faint);margin-top:4px">Excel 會將所有勾選軌道合為一個檔案，每軌一個分頁</div>`);

  if (State.notes.length)
    html += sec(`備註（${State.notes.length} 條）`,
      cb('id="expNotesEdius"', 'Edius 格式') + cb('id="expNotesGeneral"', '一般格式'));

  openModal('匯出', html, [{
    label: '匯出', primary: true, act: () => {
      const fmts = [...document.querySelectorAll('[data-fmt]')].filter(b => b.checked).map(b => b.dataset.fmt);
      const tks = State.cues.length && State.trackCount > 1 ? [...document.querySelectorAll('[data-tk]')].filter(b => b.checked).map(b => +b.dataset.tk) : null;
      const notesE = document.getElementById('expNotesEdius')?.checked;
      const notesG = document.getElementById('expNotesGeneral')?.checked;
      if (!fmts.length && !notesE && !notesG) { showToast('請至少勾選一個格式'); return; }
      if (fmts.length && tks !== null && !tks.length) { showToast('請至少勾選一個軌道'); return; }
      closeModal();
      for (const fmt of fmts) {
        if (fmt === 'xlsx') {
          const list = tks ? tks.map(i => ({ name: State.tracks[i]?.name || ('軌道' + (i + 1)), cues: State.cues.filter(c => (c.track || 0) === i) })).filter(t => t.cues.length) : [{ name: State.tracks[0]?.name || '軌道 1', cues: State.cues }];
          doExportXLSX(list);
        } else {
          if (tks) { for (const i of tks) { const cues = State.cues.filter(c => (c.track || 0) === i); if (cues.length) doExport(fmt, cues, State.tracks[i]?.name); } }
          else { doExport(fmt, State.cues); }
        }
      }
      if (notesE) doExportNotesEdius();
      if (notesG) doExportNotesGeneral();
    }
  }, { label: '取消', act: closeModal }]);
}
function exportSub(kind) {
  if (State.cues.length === 0) { showToast('沒有字幕可匯出'); return; }
  if (kind === 'xlsx') {
    const list = State.tracks.map((tk, i) => ({ name: tk.name, cues: State.cues.filter(c => (c.track || 0) === i) })).filter(t => t.cues.length);
    doExportXLSX(list); return;
  }
  if (State.trackCount > 1) {
    for (let i = 0; i < State.tracks.length; i++) {
      const cues = State.cues.filter(c => (c.track || 0) === i); if (cues.length) doExport(kind, cues, State.tracks[i]?.name);
    }
  } else doExport(kind, State.cues);
}
function doExport(kind, cues, trackName) {
  if (!cues.length) { showToast('所選軌道沒有字幕'); return; }
  const base = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle');
  const tkSuffix = trackName ? '_' + trackName.replace(/[\\/:*?"<>|]/g, '_') : '';
  let text, ext;
  if (kind === 'srt') { text = SubFormats.toSRT(cues); ext = '.srt'; }
  else if (kind === 'ass') { text = SubFormats.toASS(cues, State.fps, State.tracks, State.videoWidth || video.videoWidth || 1920, State.videoHeight || video.videoHeight || 1080, window.innerWidth || 1920, $('videoWrap')?.clientWidth || 1000, $('videoWrap')?.clientHeight || 562); ext = '.ass'; }
  else if (kind === 'encore') { text = SubFormats.toEncore(cues, State.fps, State.dropFrame); ext = '.txt'; }
  else { text = SubFormats.toTXT(cues); ext = '.txt'; }
  const bytes = encodeUTF16LE(text);
  const fname = base + tkSuffix + (kind === 'encore' ? '_encore' : '') + ext;
  if (IS_DESKTOP) {
    DESK.exportSub(fname, bytesToB64(bytes), ext.replace('.', '')).then(pth => { if (pth) { setStatus('已匯出：' + pth, 'ok'); showToast('已匯出 ' + baseName(pth)); } });
  } else {
    downloadBytes(bytes, fname, 'text/plain;charset=utf-16le');
    setStatus(`已匯出 ${kind.toUpperCase()}（UTF-16 LE）`, 'ok');
    showToast(`已匯出 ${fname}`);
  }
}

function doExportXLSX(trackDataList) {
  if (!trackDataList.length) { showToast('所選軌道沒有字幕'); return; }
  const bytes = buildXLSX(trackDataList, State.fps, State.dropFrame);
  const base = (State.mediaName ? State.mediaName.replace(/\.[^.]+$/, '') : 'subtitle');
  const fname = base + '.xlsx';
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
  else Media.loadVideoFile(f);
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
  const scope = $('tcShiftSel').value;
  let cues;
  if (scope === 'sel') {
    const ids = State.selectedIds.length ? State.selectedIds : [State.selectedId].filter(Boolean);
    cues = ids.map(id => State.cues.find(c => c.id === id)).filter(c => c && c.timed !== false);
  } else if (scope === 'track') {
    cues = State.cues.filter(c => c.timed !== false && (c.track || 0) === State.listTrack);
  } else {
    cues = State.cues.filter(c => c.timed !== false);
  }
  if (!cues.length) { showToast('沒有字幕可以位移'); return; }
  for (const c of cues) { c.start = Math.max(0, c.start + delta); c.end = Math.max(c.start + 0.001, c.end + delta); }
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
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    let newEnd = c.end + delta;
    newEnd = Math.max(c.start + minDur, newEnd);
    newEnd = Math.min(nextIn, newEnd);
    c.end = newEnd;
  }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${cues.length} 條字幕的持續時間（${sign > 0 ? '+' : '−'}${t.toFixed(3)}s）`, 'ok');
}
function applyDurAdjPct() {
  const pct = +($('durAdjPctInput').value || '100');
  if (isNaN(pct) || pct <= 0) { showToast('請輸入有效的百分比（例如 150）'); return; }
  const ratio = pct / 100;
  const minDur = 1 / Math.max(State.fps || 25, 1);
  const cues = _durAdjCues($('tcShiftSel').value);
  if (!cues.length) { showToast('沒有字幕可調整'); return; }
  for (const c of cues) {
    const nextIn = _nextInPoint(c);
    // 縮放後對齊影格，避免區塊邊緣落在格與格之間
    let newEnd = snapTimeToFrame(c.start + (c.end - c.start) * ratio, State.fps, State.dropFrame);
    newEnd = Math.max(c.start + minDur, newEnd);
    newEnd = Math.min(nextIn, newEnd);
    c.end = newEnd;
  }
  sortCues(); emit('render:all'); drawTimeline();
  recordHistory('調整持續時間');
  setStatus(`已調整 ${cues.length} 條字幕的持續時間（${pct}%）`, 'ok');
}

export { importSub, showExportDialog, exportSub, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct };

import { State, IS_DESKTOP, DESK } from './state.js';
import { encodeUTF16LE, bytesToB64, downloadBytes, baseName, b64ToBytes } from './util.js';
import { SubFormats } from './formats.js';
import { renderASS } from './ass-render.js';
import { setStatus, showToast } from './ui.js';
import { buildXLSX } from './xlsxExport.js';

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
  return renderASS(cues, {
    ...options,
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

import { State, IS_DESKTOP, DESK } from './state.js';
import { encodeUTF16LE, bytesToB64, downloadBytes, baseName, readFile, pickFile, b64ToBytes } from './util.js';
import { SubFormats } from './formats.js';
import { ASS_PLAY_RES } from './substyle.js';
import { setStatus, showToast } from './ui.js';
import { Media } from './media.js';
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
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(cues, State.fps, State.tracks, RX, RY, {
    ...options,
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

export async function _exportVideoWeb(data, deliverables, expIn, assText) {
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
          Media.tracks.push({ file: file }); 
        } else {
          showToast(`已取消匯出：未提供 ${base}`);
          return; 
        }
      }
    }
  }

  try {
    const ff = await Media.loadFFmpeg();
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
        /* 這裡原本有一行
             assText = assText.replace(/Fontname: [^,]+,/g, 'Fontname: DefaultFont,');
           它【永遠匹配不到】：產生的 ASS 裡不存在 `Fontname: `（冒號＋空格）這個字串。
           Style 行是 `Style: <名稱>,<家族名>,…`，而 `Fontname` 只出現在
           `Format: Name, Fontname, Fontsize, …` 標頭，前面是逗號＋空格。

           也不該「修好」它：把家族名改寫成 `DefaultFont` 正是鐵律 §0.3 記過的錯——
           libass 只認字型檔【內部】的家族名，填一個不存在的名字會讓它靜默退回系統字型。
           實際能運作的原因是 /fonts 裡只有這一支字型，libass 配不到指定家族時
           就會退回它。維持這個行為，但不要再假裝有在改寫。 */
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

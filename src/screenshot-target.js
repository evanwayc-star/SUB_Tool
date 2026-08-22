/* ==============================================================================
   SUB Tool — 截圖的存放位置與執行 (Screenshot Target & Capture)
   ==============================================================================
   截圖檔名規則純函式，以及 MPV / HTML5 Canvas 截圖編排實作。
   ============================================================================== */

/* 時間碼會進檔名，而 `:` 與 `;`（drop-frame 分隔）在 Windows 檔名裡是非法字元。
   換成 `-`：`01:23:45;06` → `_01-23-45-06`。沒有要求時間碼時回空字串。 */
export function timecodeSuffix(timecode) {
  if (!timecode) return '';
  return '_' + String(timecode).replace(/[:;]/g, '-');
}

/* 截圖要存到哪：優先用專案檔所在目錄，其次退回母素材所在目錄。
   兩者都沒有（未存檔的空白專案、網頁版）時回 null，由呼叫端走瀏覽器下載。
   結尾的分隔符一律去掉，避免後面接檔名時變成 `dir\\\\name`。 */
export function screenshotDir({ projectDir, mediaPath }) {
  let dir = projectDir || '';
  if (!dir && mediaPath) {
    const norm = String(mediaPath).replace(/\\/g, '/');
    const sep = norm.lastIndexOf('/');
    if (sep > 0) dir = String(mediaPath).substring(0, sep);
  }
  return dir ? dir.replace(/[\\/]+$/, '') : null;
}

/* 沒有目錄可用時（網頁版）的下載檔名。以播放點的整秒數命名，
   同一秒重複截圖會同名——瀏覽器會自己加 (1)，不需要在這裡處理。 */
export function fallbackScreenshotName(displaySeconds, suffix = '') {
  return `Shot-${Math.floor(Math.max(0, +displaySeconds || 0))}${suffix}.jpg`;
}

export async function takeScreenshot(withTimecode = false) {
  const { State, IS_DESKTOP, DESK } = await import('./state.js');
  const { Media } = await import('./media.js');
  const { getProjectDir } = await import('./project.js');
  const { showToast, setStatus } = await import('./ui.js');
  const { secToEncore } = await import('./time.js');
  const { getPlayerAdapter } = await import('./media-player-adapter.js');

  if (!State.duration && !State.mediaPath) { showToast('尚未載入影音'); return; }

  const tcStr = withTimecode ? secToEncore(Media.displayTime(), State.fps, State.dropFrame) : '';
  const tcSuffix = withTimecode ? timecodeSuffix(tcStr) : '';
  const dir = screenshotDir({ projectDir: getProjectDir(), mediaPath: State.mediaPath });

  let fullPath = '';
  let name = '';
  if (dir && IS_DESKTOP && DESK?.reserveScreenshotPath) {
    try {
      const reserved = await DESK.reserveScreenshotPath(dir, tcSuffix);
      fullPath = reserved?.path || '';
      name = reserved?.name || '';
    } catch (e) { console.error('[screenshot] reserve path error:', e); }
  } else {
    name = fallbackScreenshotName(Media.displayTime(), tcSuffix);
  }

  // 若為 MPV 模式
  if (Media.mpvMode && IS_DESKTOP && DESK && getPlayerAdapter() && getPlayerAdapter().screenshot && fullPath) {
    if (!withTimecode) {
      try {
        await getPlayerAdapter().screenshot(fullPath);
        await new Promise(r => setTimeout(r, 300));
        setStatus(`截圖已儲存：${name}`, 'ok');
      } catch (e) {
        console.error('[screenshot] mpv screenshot error:', e);
        showToast('截圖失敗');
      }
      return;
    } else {
      const tempPath = dir + '/.subtool_temp_shot.jpg';
      try {
        await getPlayerAdapter().screenshot(tempPath);
        await new Promise(r => setTimeout(r, 300));
        
        const b64 = await DESK.readB64(tempPath);
        if (!b64) throw new Error('Cannot read temp screenshot');
        
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res; img.onerror = rej;
          img.src = 'data:image/jpeg;base64,' + b64;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        const fontSize = Math.floor(canvas.height * 0.05);
        ctx.font = 'bold ' + fontSize + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const x = canvas.width / 2;
        const y = canvas.height * 0.95;
        const textWidth = ctx.measureText(tcStr).width;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(x - textWidth / 2 - 10, y - fontSize - 5, textWidth + 20, fontSize + 10);
        ctx.fillStyle = '#fff';
        ctx.fillText(tcStr, x, y);
        
        const outB64 = await new Promise(r => {
          canvas.toBlob(b => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.readAsDataURL(b);
          }, 'image/jpeg', 0.9);
        });
        
        const result = await DESK.writeScreenshot(fullPath, outB64);
        if (result) {
          setStatus(`截圖已儲存：${name}`, 'ok');
        } else {
          throw new Error('writeScreenshot failed');
        }
      } catch (e) {
        console.error('[screenshot] MPV timecode shot error:', e);
        showToast('截圖失敗');
      }
      return;
    }
  }

  // 瀏覽器或非 MPV 模式 (HTML5 Video)
  const canvas = document.createElement('canvas');
  canvas.width = State.videoWidth || 1920;
  canvas.height = State.videoHeight || 1080;
  const ctx = canvas.getContext('2d');
  
  const vid = document.getElementById('video');
  if (vid && vid.readyState >= 2) {
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  if (withTimecode) {
    const fontSize = Math.floor(canvas.height * 0.05);
    ctx.font = 'bold ' + fontSize + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x = canvas.width / 2;
    const y = canvas.height * 0.95;
    
    const textWidth = ctx.measureText(tcStr).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x - textWidth / 2 - 10, y - fontSize - 5, textWidth + 20, fontSize + 10);
    ctx.fillStyle = '#fff';
    ctx.fillText(tcStr, x, y);
  }
  
  canvas.toBlob(async (blob) => {
    try {
      if (fullPath && DESK) {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        const result = await DESK.writeScreenshot(fullPath, b64);
        if (result) setStatus(`截圖已儲存：${name}`, 'ok');
        else showToast('截圖儲存失敗');
        return;
      }
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`截圖已儲存：${name}`, 'ok');
    } catch (e) {
      console.error('[screenshot] browser screenshot save error:', e);
      showToast('截圖儲存失敗');
    }
  }, 'image/jpeg', 0.9);
}

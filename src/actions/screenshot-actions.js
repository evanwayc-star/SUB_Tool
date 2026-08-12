import { State } from '../state.js';
import { Media } from '../media.js';
import { getProjectDir } from '../project.js';
import { showToast, setStatus } from '../ui.js';
import { secToEncore } from '../time.js';
import { timecodeSuffix, screenshotDir, fallbackScreenshotName } from '../screenshot-target.js';
import { getPlayerAdapter } from '../media-player-adapter.js';

// 判斷是否在桌面版環境
const IS_DESKTOP = !!window.subtool;

export async function takeScreenshot(withTimecode = false) {
  if (!State.duration && !State.mediaPath) { showToast('尚未載入影音'); return; }

  // 存哪、叫什麼名字的規則在 screenshot-target.js（純函式，可測）；這裡只負責編排。
  const tcStr = withTimecode ? secToEncore(Media.displayTime(), State.fps, State.dropFrame) : '';
  const tcSuffix = withTimecode ? timecodeSuffix(tcStr) : '';
  const dir = screenshotDir({ projectDir: getProjectDir(), mediaPath: State.mediaPath });
  const DESK = window.subtool;

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
      // 不需時間碼，直接請 mpv 存檔
      try {
        await getPlayerAdapter().screenshot(fullPath);
        // mpv 非同步存檔，稍等一下讓它寫入
        await new Promise(r => setTimeout(r, 300));
        setStatus(`截圖已儲存：${name}`, 'ok');
      } catch (e) {
        console.error('[screenshot] mpv screenshot error:', e);
        showToast('截圖失敗');
      }
      return;
    } else {
      // 需時間碼：請 mpv 存到暫存檔，讀入 JS 加工
      const tempPath = dir + '/.subtool_temp_shot.jpg';
      try {
        await getPlayerAdapter().screenshot(tempPath);
        await new Promise(r => setTimeout(r, 300)); // 等待寫入
        
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
        
        // 畫時間碼
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
           // 清理暫存檔（嘗試刪除但忽略錯誤，因為沒有 expose unlink，此處留著會被覆蓋）
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

  // ================= 瀏覽器或非 MPV 模式 (HTML5 Video) =================
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

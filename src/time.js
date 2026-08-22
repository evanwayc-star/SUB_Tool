/* ==============================================================================
   SUB Tool — 時間與時碼換算核心 (Time & Timecode Conversion Core)
   ==============================================================================
   【架構與職責】
   負責專案內所有秒數（Seconds）與各字幕格式時碼（Timecode）之間的互相轉換：
   - UI 毫秒制顯示 (`fmtClock`)
   - SRT 格式時碼 (`secToSRT`, `srtToSec`)
   - ASS 格式時碼 (`secToASS`, `assToSec`)
   - SMPTE / Encore 時碼 (`secToEncore`, `encoreToSec`, `encoreParts`)
   - 影格吸附格網 (`snapTimeToFrame`, `getExactFps`)
   
   【FPS-SYNC 鐵律與不變量 (詳見 docs/FPS_時碼一致性.md)】
   1. `encoreParts()` 是「秒 → 時:分:秒:格」的唯一運算來源。播放器、字幕列表與時間軸刻度均共用之。
   2. `snapTimeToFrame()` 是唯一的影格吸附格網；Seek、Pause、拖曳、逐格均透過它對齊。
   3. 嚴禁在別處自行使用 `Math.floor(s/3600)` 拼湊時碼，避免相差一格之渲染漂移。
   4. 容差判斷：29.97 與 23.976 的精確 FPS 容差必須小於 0.024，防範整數 24/30 FPS 被誤判。
   ============================================================================== */
import { pad } from './util.js';

/**
 * 將秒數格式化為 UI 播放器毫秒制時鐘字串 (00:00:00.000)。
 * 
 * @param {number} s 時間（秒）
 * @returns {string} 格式化後的時鐘字串
 */
function fmtClock(s) {
  const safeSec = Number.isFinite(s) && s >= 0 ? s : 0;
  const ms = Math.round(safeSec * 1000);
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/**
 * 將秒數轉換為 SRT 字幕標準時碼格式 (00:00:00,000)。
 * 
 * @param {number} s 時間（秒）
 * @returns {string} SRT 時碼格式字串
 */
function secToSRT(s) {
  const safeSec = Number.isFinite(s) && s >= 0 ? s : 0;
  const ms = Math.round(safeSec * 1000);
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/**
 * 將秒數轉換為 ASS 字幕標準百分秒時碼格式 (0:00:00.00)。
 * 
 * 【FPS-SYNC 規範】
 * ASS 僅具備百分秒（10ms）精度。不可自行提前做半格補償，
 * 採「不晚於原始時間」的百分秒向下截斷，回匯並吸附後仍保證精準落回同一影格。
 * 
 * @param {number} s 時間（秒）
 * @param {number} [fps=25] 保留相容簽名
 * @returns {string} ASS 時碼字串
 */
function secToASS(s, fps = 25) {
  void fps;
  const sec = Number(s);
  if (!Number.isFinite(sec) || sec <= 0) return '0:00:00.00';
  const cs = Math.floor(sec * 100 + 0.0000001);
  return `${Math.floor(cs / 360000)}:${pad((cs / 6000) % 60)}:${pad((cs / 100) % 60)}.${pad(cs % 100, 2)}`;
}

/**
 * 取得標準化之精確格率 (Exact FPS)。
 * 
 * 處理非整數格率精度：
 * - 29.97 -> 30000 / 1001 (~29.97002997)
 * - 23.976 -> 24000 / 1001 (~23.976023976)
 * - 59.94 -> 60000 / 1001 (~59.94005994)
 * 
 * @param {number} fps 輸入的格率值
 * @returns {number} 精確浮點格率
 */
export function getExactFps(fps) {
  const rawFps = Number(fps);
  if (!Number.isFinite(rawFps) || rawFps <= 0) return 30;
  let exactFps = rawFps;
  if (Math.abs(rawFps - 29.97) < 0.01) exactFps = 30000 / 1001;
  else if (Math.abs(rawFps - 23.976) < 0.01) exactFps = 24000 / 1001;
  else if (Math.abs(rawFps - 59.94) < 0.01) exactFps = 60000 / 1001;
  return exactFps;
}

/**
 * 將秒數分解為 Encore 時碼分量 (時/分/秒/格)。
 * 
 * @param {number} s 時間（秒）
 * @param {number} fps 影格率
 * @param {boolean} [df=false] 是否啟用 SMPTE Drop-Frame (僅支援 29.97 / 59.94)
 * @returns {{hh: number, mm: number, ss: number, ff: number, df: boolean}} 時碼分量
 */
function encoreParts(s, fps, df = false) {
  const safeSec = Number.isFinite(s) && s >= 0 ? s : 0;
  const exactFps = getExactFps(fps);
  const timebase = Math.round(exactFps);

  // 29.97 Drop-Frame (SMPTE 標頭規範)
  if (df && Math.abs(exactFps - 30000 / 1001) < 0.01) {
    const n = Math.round(safeSec * exactFps);
    const D = Math.floor(n / 17982);
    const F = n % 17982;
    const adj = F < 2 ? 0 : Math.floor((F - 2) / 1798);
    const a = n + 2 * (D * 9 + adj);
    const ff = a % timebase;
    const rest = Math.floor(a / timebase);
    const ss = rest % 60;
    const mm = Math.floor(rest / 60) % 60;
    const hh = Math.floor(rest / 3600);
    return { hh, mm, ss, ff, df: true };
  }

  // 59.94 Drop-Frame
  if (df && Math.abs(exactFps - 60000 / 1001) < 0.01) {
    const n = Math.round(safeSec * exactFps);
    const D = Math.floor(n / 35964);
    const F = n % 35964;
    const adj = F < 4 ? 0 : Math.floor((F - 4) / 3596);
    const a = n + 4 * (D * 9 + adj);
    const ff = a % timebase;
    const rest = Math.floor(a / timebase);
    const ss = rest % 60;
    const mm = Math.floor(rest / 60) % 60;
    const hh = Math.floor(rest / 3600);
    return { hh, mm, ss, ff, df: true };
  }

  // 非 Drop-Frame (NDF)
  const n = Math.round(safeSec * exactFps);
  let tf = n;
  const ff = tf % timebase;
  tf = Math.floor(tf / timebase);
  const ss = tf % 60;
  tf = Math.floor(tf / 60);
  const mm = tf % 60;
  const hh = Math.floor(tf / 60);
  return { hh, mm, ss, ff, df: false };
}

/**
 * 將秒數格式化為完整 Encore 時碼字串 (00:00:00:00 或 00:00:00;00)。
 * 
 * @param {number} s 時間（秒）
 * @param {number} fps 影格率
 * @param {boolean} [df=false] 是否為 Drop-frame（分隔符為 ';'）
 * @returns {string} 時碼字串
 */
function secToEncore(s, fps, df = false) {
  const p = encoreParts(s, fps, df);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${p.df ? ';' : ':'}${pad(p.ff)}`;
}

/**
 * 將 SRT 時碼字串 (00:00:00,000) 轉換為秒數。
 * @param {string} t SRT 時碼字串
 * @returns {number} 時間（秒）
 */
function srtToSec(t) {
  if (typeof t !== 'string') return 0;
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4]) / Math.pow(10, m[4].length);
}

/**
 * 將 ASS 時碼字串 (0:00:00.00) 轉換為秒數。
 * @param {string} t ASS 時碼字串
 * @returns {number} 時間（秒）
 */
function assToSec(t) {
  if (typeof t !== 'string') return 0;
  const m = t.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4]) / Math.pow(10, m[4].length);
}

/**
 * 將 Encore 時碼字串 (00:00:00:00 或 00:00:00;00) 反向轉換為秒數。
 * 
 * @param {string} t Encore 時碼字串
 * @param {number} fps 影格率
 * @param {boolean} [df=false] 是否為 Drop-Frame 格式
 * @returns {number} 時間（秒）
 */
function encoreToSec(t, fps, df = false) {
  if (typeof t !== 'string') return 0;
  const m = t.trim().match(/(\d+):(\d+):(\d+)[:;](\d+)/);
  if (!m) return 0;
  const hh = +m[1];
  const mm = +m[2];
  const ss = +m[3];
  const ff = +m[4];

  const exactFps = getExactFps(fps);
  const timebase = Math.round(exactFps);

  if (df && Math.abs(exactFps - 30000 / 1001) < 0.01) {
    const totalMin = 60 * hh + mm;
    const n = timebase * 3600 * hh + timebase * 60 * mm + timebase * ss + ff - 2 * (totalMin - Math.floor(totalMin / 10));
    return n / exactFps;
  }

  if (df && Math.abs(exactFps - 60000 / 1001) < 0.01) {
    const totalMin = 60 * hh + mm;
    const n = timebase * 3600 * hh + timebase * 60 * mm + timebase * ss + ff - 4 * (totalMin - Math.floor(totalMin / 10));
    return n / exactFps;
  }

  // Non-Drop Frame (NDF)
  const n = (hh * 3600 + mm * 60 + ss) * timebase + ff;
  return n / exactFps;
}

/**
 * 把任意時間（秒）對齊吸附至最近的整數影格邊界。
 * 
 * @param {number} t 時間（秒）
 * @param {number} fps 影格率
 * @param {boolean} [df=false]
 * @returns {number} 吸附至影格邊界的時間（秒）
 */
function snapTimeToFrame(t, fps, df = false) {
  void df;
  const time = Number(t);
  if (!Number.isFinite(time)) return 0;
  if (!fps) return time;
  const exactFps = getExactFps(fps);
  return Math.round(time * exactFps) / exactFps;
}

export {
  fmtClock,
  secToSRT,
  secToASS,
  secToEncore,
  encoreParts,
  srtToSec,
  assToSec,
  encoreToSec,
  snapTimeToFrame,
};

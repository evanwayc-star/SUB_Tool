/* ==============================================================================
   SUB Tool — 交付清單（Delivery List）
   ==============================================================================

   使用者在「匯出交付清單」對話框裡編輯的那份清單，以及它全部的規則：
   預設檔名、副檔名、交付解析度推導、建議碼率、驗證、以及送出時要交給
   主程序的參數。

   【為什麼獨立成一支】
   這些規則原本住在 subio.js 的 showExportVideoDialog() 裡（415 行的閉包）。
   `draft` 是閉包變數，模組外完全取不到，於是：
     - 唯一的測試途徑是啟 jsdom、mock 六個模組、再戳 DOM；
     - 要以程式送出一份交付時，只能照著送出迴圈把參數重抄一份。
   規則與 DOM 綁死＝沒有接縫。這支模組就是那個接縫。

   【鐵律】
   - **零 import、零 DOM、零 I/O。** 需要的東西一律由呼叫端傳進來
     （專案名、fps、專案畫布尺寸…）。這是它能被直接測試的唯一原因，
     不要為了方便而 import State 或 Media。
   - 磁碟上的同名檔案檢查**不在這裡**——那是 I/O，留在對話框。
     這裡只做純規則的驗證（缺目錄／缺檔名／同一目錄內重複檔名）。
   - 交付解析度的寬度必須是偶數（H.264 要求），推導公式只有 deliveryResolution()
     一份，送出與 UI 都吃它。
============================================================================== */

const EXT_BY_FORMAT = { wav: '.wav', prores: '.mov', h264: '.mp4' };

/** 交付格式對應的副檔名；未知格式一律當 MP4。 */
export function extensionFor(format) {
  return EXT_BY_FORMAT[format] || '.mp4';
}

/* 專案代號：檔名慣例是 `ST_<代號>_<fps>fps…`，而素材檔名常常已經帶了
   `ST_` 或 `V_` 前綴，取第二段才是真正的代號。 */
export function projectTagFrom(mediaName) {
  const raw = (mediaName ? String(mediaName).replace(/\.[^.]+$/, '') : 'sequence').split('_');
  if ((raw[0] === 'V' || raw[0] === 'ST') && raw.length > 1) return raw[1];
  return raw[0];
}

/* 聲道編組寫進檔名的縮寫：Stereo→20FM、5.1→51FM、Mono→10FM。
   多條輸出 stream 以 + 相連（例：`_51FM+20FM`）。 */
function audioTagFrom(audioPlan) {
  const streams = audioPlan?.streams || audioPlan?.groups;
  if (!Array.isArray(streams) || streams.length === 0) return '';
  const parts = streams.map(g => {
    if (g.layout === 'stereo' || g.layout === 'stereoLtRt') return '20FM';
    if (g.layout === '5.1') return '51FM';
    if (g.layout === 'mono') return '10FM';
    return String(g.layout || '20').replace('.', '') + 'FM';
  });
  return '_' + parts.join('+');
}

/** 一列交付的預設檔名。純函式：同樣的輸入永遠得到同樣的名字。 */
export function defaultDeliveryName({ projectTag, fps, format, targetH, audioPlan }) {
  const ext = extensionFor(format);
  const isWav = format === 'wav';
  const tag = (!isWav && targetH > 0) ? '_' + targetH + 'p' : '';
  return `ST_${projectTag}_${Math.floor(fps || 25)}fps${audioTagFrom(audioPlan)}${tag}${ext}`;
}

/* 交付解析度：等比縮放到指定高度，寬度取偶數（H.264 的 yuv420p 要求寬高皆偶數；
   奇數寬會讓 ffmpeg 直接失敗）。targetH=0＝沿用專案畫布。 */
export function deliveryResolution({ canvasW, canvasH, targetH, isWav }) {
  const W = canvasW || 1920, H = canvasH || 1080;
  if (isWav || !(targetH > 0)) return { w: W, h: H };
  const h = targetH;
  let w = Math.round(h * (W / H));
  w -= (w % 2);
  return { w, h };
}

/* 依解析度給的建議碼率（kbps）。沿用切換解析度時的既有係數，
   讓「換成 720p」不會還留著 4K 的碼率。 */
export function suggestKbps({ w, h }) {
  return Math.round((w * h * 30 * 0.1) / 1000);
}

function joinPath(dir, name) {
  return String(dir || '').replace(/[/\\]+$/, '') + '\\' + name;
}

function newRow({ audioOnly, defaultAudioLayout, outDir = '' }) {
  return {
    format: audioOnly ? 'wav' : 'h264',
    kbps: 8000,
    targetH: 0,
    burnTimecode: false,
    audioPlan: JSON.parse(JSON.stringify(defaultAudioLayout || {})),
    customName: '',
    outDir,
  };
}

/**
 * 建立一份交付清單。
 *
 * @param {object} o
 * @param {string} o.projectTag        檔名用的專案代號（見 projectTagFrom）
 * @param {number} o.fps               專案 fps
 * @param {number} o.canvasW           專案畫布寬
 * @param {number} o.canvasH           專案畫布高
 * @param {boolean} o.audioOnly        序列內沒有影像 → 只能出 WAV
 * @param {object} o.defaultAudioLayout 新列的預設輸出編組
 * @param {boolean} o.desktop          桌面版才需要輸出目錄
 * @param {Array}  [o.initial]         既有的列（從音軌設定視窗折返時帶回來）
 */
export function createDeliveryList({
  projectTag, fps, canvasW, canvasH,
  audioOnly = false, defaultAudioLayout = {}, desktop = true, initial = null,
}) {
  const rows = Array.isArray(initial) && initial.length
    ? initial.map(r => ({ ...r }))
    : [newRow({ audioOnly, defaultAudioLayout })];

  const nameFor = r => defaultDeliveryName({
    projectTag, fps, format: r.format, targetH: r.targetH, audioPlan: r.audioPlan,
  });

  /* 使用者沒有自己改過名字的列，要跟著格式／解析度／編組變動重新產生。
     改過的列只換副檔名，不能把使用者打的名字蓋掉。 */
  const refreshName = r => { if (!r.nameModified) r.customName = nameFor(r); };

  const at = i => rows[i] || null;

  const api = {
    rows() { return rows; },
    count() { return rows.length; },
    get(i) { return at(i); },
    defaultNameFor(i) { const r = at(i); return r ? nameFor(r) : ''; },

    add() {
      const last = rows[rows.length - 1];
      const row = last
        ? { ...JSON.parse(JSON.stringify(last)), customName: '', nameModified: false, outDir: last.outDir }
        : newRow({ audioOnly, defaultAudioLayout });
      rows.push(row);
      refreshName(row);
      return row;
    },

    removeAt(i) { if (at(i)) rows.splice(i, 1); },

    setFormat(i, format) {
      const r = at(i); if (!r) return;
      r.format = format;
      if (!r.nameModified) r.customName = nameFor(r);
      else if (r.customName) r.customName = r.customName.replace(/\.[a-zA-Z0-9]+$/, '') + extensionFor(format);
    },

    /* 換解析度時一併更新 H.264 的碼率——1080p 的碼率套在 720p 上是浪費，
       套在 4K 上則會糊掉（v4.32 使用者回報「輸出像 proxy」的成因）。 */
    setTargetHeight(i, h) {
      const r = at(i); if (!r) return;
      r.targetH = Number(h) || 0;
      if (r.format === 'h264') {
        r.kbps = suggestKbps(deliveryResolution({ canvasW, canvasH, targetH: r.targetH, isWav: false }));
      }
      refreshName(r);
    },

    setKbps(i, kbps) { const r = at(i); if (r) r.kbps = parseInt(kbps, 10) || 0; },
    setBurnTimecode(i, on) { const r = at(i); if (r) r.burnTimecode = !!on; },
    setOutDir(i, dir) { const r = at(i); if (r) r.outDir = dir || ''; },

    setName(i, value) {
      const r = at(i); if (!r) return;
      let v = String(value == null ? '' : value).trim();
      const ext = extensionFor(r.format);
      if (v && !v.toLowerCase().endsWith(ext)) v += ext;
      r.customName = v;
      r.nameModified = (v !== nameFor(r));
    },

    /* 音軌設定視窗回來後套用：編組變了，沒改過名字的列要跟著換掉 `_51FM+20FM` 那一段。 */
    applyRow(i, next) {
      if (!at(i)) return;
      rows[i] = next;
      refreshName(rows[i]);
    },

    /**
     * 純規則驗證。回傳問題陣列（空＝可以送出）。
     * 每一筆帶 kind 供呼叫端決定要不要擋：`blocking` 才是不能送出。
     * 磁碟上是否已有同名檔案不在這裡——那是 I/O。
     */
    problems() {
      const out = [];
      if (rows.length === 0) {
        out.push({ kind: 'blocking', code: 'empty', index: -1, message: '清單不能為空' });
        return out;
      }
      if (desktop) {
        const i = rows.findIndex(r => !r.outDir);
        if (i !== -1) out.push({ kind: 'blocking', code: 'missing-dir', index: i, message: `錯誤：第 ${i + 1} 列缺少輸出目錄！` });
      }
      const n = rows.findIndex(r => !r.customName);
      if (n !== -1) out.push({ kind: 'blocking', code: 'missing-name', index: n, message: `錯誤：第 ${n + 1} 列缺少檔名！` });

      if (desktop) {
        /* 比對的是「目錄＋檔名」而不是單純檔名——同名但不同目錄是合法的。
           訊息要講清楚是「同一目錄內」重複，否則使用者會以為不同資料夾也不准同名。 */
        const paths = rows.map(r => joinPath(r.outDir, r.customName).toLowerCase());
        if (new Set(paths).size !== paths.length) {
          out.push({
            kind: 'blocking', code: 'duplicate-path', index: -1,
            message: '錯誤：交付清單在同一目錄內，有重複的檔名！',
            submitMessage: '錯誤：交付清單在同一目錄內，有重複的檔名！比較後面的序列會覆蓋掉前面的，請修改檔名再送出。',
          });
        }
      }
      return out;
    },

    /** 每一列的完整輸出路徑（桌面版用；供 I/O 層去問磁碟有沒有同名檔）。 */
    outPaths() {
      return rows.map(r => ({ dir: r.outDir, name: r.customName, path: joinPath(r.outDir, r.customName) }));
    },

    /**
     * 把清單轉成要交給主程序的匯出工作陣列。
     *
     * 這裡是「交付規格 → 匯出工作」的唯一轉換點：解析度、時間碼浮水印、
     * 輸出路徑都在這裡決定，呼叫端只負責把 snapshot 與 assText 遞進來。
     */
    toJobs({ clips, videoTracks, duration, assText, timelineStartTimecode, composeAudioPlan, compiledAudioPlan }) {
      return rows.map(r => {
        const isWav = r.format === 'wav';
        const { w, h } = deliveryResolution({ canvasW, canvasH, targetH: r.targetH, isWav });
        return {
          clips, videoTracks,
          width: w, height: h,
          fps: fps || 25,
          assText,
          format: r.format,
          duration,
          videoKbps: r.kbps,
          audioPlan: composeAudioPlan ? composeAudioPlan(compiledAudioPlan, r) : compiledAudioPlan,
          timecodeWatermark: (!isWav && r.burnTimecode) ? { start: timelineStartTimecode } : null,
          defaultName: r.customName,
          outPath: joinPath(r.outDir, r.customName),
        };
      });
    },
  };

  // 初始列可能是空名字（新建或從音軌視窗折返）→ 補上預設名
  rows.forEach(refreshName);
  return api;
}

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
   - **零 DOM、零 I/O；import 只准 `shared/` 底下的零相依純模組。**
     需要的東西一律由呼叫端傳進來（專案名、fps、專案畫布尺寸…）。
     這是它能被直接測試的唯一原因，不要為了方便而 import State 或 Media。
     ── v6.1.5 之前這裡寫的是「零 import」。那是用來代替真正想守的東西
        （沒有副作用、不必起 DOM 就能測）的一個近似；交付解析度的規則要與
        主行程共用時就得放寬。放寬到 `shared/`【不會】動搖那個目的，
        因為那些模組本身也不准 require 任何東西（見 shared/README.md）。
   - 磁碟上的同名檔案檢查**不在這裡**——那是 I/O，留在對話框。
     這裡只做純規則的驗證（缺目錄／缺檔名／同一目錄內重複檔名）。
   - 交付解析度的寬度必須是偶數（H.264 要求），推導公式只有 deliveryResolution()
     一份，送出與 UI 都吃它。
============================================================================== */
import { deliveryResolution, suggestKbps } from '../shared/delivery-resolution.cjs';

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

/* 聲道編組寫進檔名的邏輯：
   若全為 Mono，顯示 NCH-Mono（例：`_8CH-Mono`）。
   否則優先使用設定的使用者自訂名稱（並移除點、減號與空白，如 `2.0-ME` → `20ME`）；若無名稱則依 layout 給預設：Stereo→20FM、5.1→51FM。
   多條輸出 stream 以 + 相連（例：`_51FM+20ME`）。 */
function audioTagFrom(audioPlan) {
  const streams = audioPlan?.streams || audioPlan?.groups;
  if (!Array.isArray(streams) || streams.length === 0) return '';
  if (streams.every(g => g.layout === 'mono')) {
    return `_${streams.length}CH-Mono`;
  }
  const parts = streams.map(g => {
    let raw = '';
    if (g.name && g.name.trim()) raw = g.name.trim();
    else if (g.layout === 'stereo' || g.layout === 'stereoLtRt') raw = '20FM';
    else if (g.layout === '5.1') raw = '51FM';
    else if (g.layout === 'mono') raw = '10FM';
    else raw = String(g.layout || '20') + 'FM';
    return raw.replace(/[.\-\s]/g, '');
  });
  return '_' + parts.join('+');
}

/** 一列交付的預設檔名。純函式：同樣的輸入永遠得到同樣的名字。 */
export function defaultDeliveryName({ projectTag, fps, format, targetH, audioPlan, burnTimecode }) {
  const ext = extensionFor(format);
  const isWav = format === 'wav';
  const tag = (!isWav && targetH > 0) ? '_' + targetH + 'p' : '';
  const tcTag = burnTimecode ? '_TC' : '';
  return `ST_${projectTag}_${Math.floor(fps || 25)}fps${audioTagFrom(audioPlan)}${tag}${tcTag}${ext}`;
}

/* 交付解析度與建議碼率的規則住在 `shared/delivery-resolution.cjs`——
   匯出佇列監控（另一個 BrowserWindow）與主行程也要用它來改已入列工作的解析度，
   而那兩邊都拿不到 renderer 的 ES 模組。

   ── import ＋ export 兩件事都要做 ──
   `export { x } from '…'` 只是轉出，【不會】建立本地綁定；而本檔內部
   （setTargetHeight／toJobs）也在呼叫這兩個函式。只寫 export 會讓那些呼叫變成
   未定義——所幸 eslint 的 no-undef 擋得下來，這正是那條規則存在的理由。 */
export { deliveryResolution, suggestKbps };

function joinPath(dir, name) {
  const raw = String(dir || '');
  if (!raw) return name;
  // renderer 不能 import node:path；依原生選擇器回傳的目錄格式保留平台分隔符。
  // Windows dialog 回傳反斜線，macOS/Linux 回傳斜線。固定補 `\\` 會把
  // `/Users/.../output` 組成未獲 fileAuthority 授權的 `output\\file.mp4`。
  const separator = raw.includes('\\') ? '\\' : '/';
  const base = raw.replace(/[/\\]+$/, '');
  return (base || separator) + (base ? separator : '') + name;
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
    projectTag, fps, format: r.format, targetH: r.targetH, audioPlan: r.audioPlan, burnTimecode: r.burnTimecode
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
    setBurnTimecode(i, on) { 
      const r = at(i); 
      if (r) { 
        r.burnTimecode = !!on; 
        if (!r.nameModified) {
          refreshName(r); 
        } else {
          const ext = extensionFor(r.format);
          let base = r.customName;
          if (base.toLowerCase().endsWith(ext)) {
            base = base.slice(0, -ext.length);
          }
          if (on && !base.endsWith('_TC')) {
            r.customName = base + '_TC' + ext;
          } else if (!on && base.endsWith('_TC')) {
            r.customName = base.slice(0, -3) + ext;
          }
        }
      } 
    },
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
    toJobs({ clips, videoTracks, duration, assText, subtitleTracks, timelineStartTimecode, composeAudioPlan, compiledAudioPlan }) {
      return rows.map(r => {
        const isWav = r.format === 'wav';
        const { w, h } = deliveryResolution({ canvasW, canvasH, targetH: r.targetH, isWav });
        return {
          clips, videoTracks,
          width: w, height: h,
          /* 匯出佇列監控要能改已入列工作的解析度，那需要【專案畫布】的比例——
             width/height 是【已經算好的交付解析度】，不是畫布。反覆換解析度時
             用交付尺寸回推會累積捨入誤差（寬度取偶數），所以把畫布原值帶著走。
             targetH 則是為了讓下拉能顯示目前選的是哪一項（0＝來源解析度）。 */
          canvasW, canvasH, targetH: r.targetH,
          /* 會被燒進這份交付的字幕軌名稱。與 ASS 產生端同一條篩選規則
             （formats.js 依 tracks[tk].visible === false 排除），所以顯示不會說謊。 */
          subtitleTracks: Array.isArray(subtitleTracks) ? subtitleTracks.slice() : [],
          fps: fps || 25,
          assText,
          format: r.format,
          duration,
          videoKbps: r.kbps,
          audioPlan: composeAudioPlan ? composeAudioPlan(compiledAudioPlan, r) : compiledAudioPlan,
          timecodeWatermark: (!isWav && r.burnTimecode) ? { start: timelineStartTimecode } : null,
          /* 即使這一列沒有勾燒入 TC 也要存起來：匯出佇列監控可以事後把 TC 打開，
             那時必須用【送出當下的時間軸起點】重建 watermark。少了它就只能猜
             00:00:00:00——設過 In 點的專案會燒出錯的時間碼，而且畫面一切正常。 */
          timelineStartTimecode,
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

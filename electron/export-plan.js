/* ==============================================================================
   SUB Tool — 匯出計畫（純邏輯，無 I/O）
   ==============================================================================
   從 electron/main.js 抽出。這裡只做【決策】：把專案資料算成 ffmpeg 的
   filtergraph 片段、音訊路由與 bitrate。不開檔、不 spawn、不碰 Electron。

   為什麼要有這個接縫：匯出是本工具唯一的交付物，也是最容易「有產出但是錯的」
   的地方（見 docs/技術架構說明.md §0.6）。它原本整段長在 ipcMain.handle 裡，
   與 dialog、ffprobe spawn 糾纏，vitest 起不了 Electron，於是一行測試都沒有。

   本檔【只可】require `shared/` 底下的零相依純模組（那些是與 renderer 共用的
   領域規則，見 shared/README.md）。**不可** require electron／fs／child_process
   ——一旦碰了，vitest 就再也起不動它，測試會整批消失而沒有人發現。
   需要副作用的部分（找字型、探測音軌、硬體編碼器）一律由呼叫端傳入。
   這條由 tests/exportPlan.test.js 守著，而且純淨是【遞移】的：被 require 的
   shared/ 模組自己也不可以 require 任何東西。
============================================================================== */
/* ===== 專案音訊輸出（v4.36） =====
   audioPlan 將「來源檔案」與「專案匯流排」分開：
   - buses：每一條都是單聲道專案輸出，inputs 可在同一 bus 內混音；
   - streams：影片容器內的音訊 stream，將 bus 依 Mono / Stereo / LtRt / 5.1 編組。
   不把使用者提供的 id / 路徑塞進 filtergraph：id 只用於 Map 查找，filter label 一律由索引產生；
   路徑則是獨立的 spawn argv。這同時避免 Windows 路徑跳脫問題與 filter injection。 */
/* 與 renderer 共用的領域規則（零相依純模組，見 shared/README.md）。
   片段幾何是鐵律 §0.9、淡入淡出視窗是 clipFadeContract 守的那條——
   兩者以前在這裡各有一份手抄副本。 */
const { imageBox: sharedImageBox } = require('../shared/image-geometry.cjs');
const { clipLength } = require('../shared/clip-fade.cjs');
const { buildLimiterFilter } = require('../shared/audio-loudness.cjs');

const _EXPORT_LAYOUTS = Object.freeze({


  mono:       { channels: 1, channelLayout: 'mono',       channelNames: ['FC'],                             title: 'Mono' },
  stereo:     { channels: 2, channelLayout: 'stereo',     channelNames: ['FL', 'FR'],                       title: 'Stereo' },
  stereoLtRt: { channels: 2, channelLayout: 'stereo',     channelNames: ['FL', 'FR'],                       title: 'Stereo Lt/Rt' },
  // 注意：5.1 聲道在 FFmpeg 必須使用標準的 '5.1' 配置 (搭配 BL, BR) 而非 '5.1(side)' (搭配 SL, SR)。
  // 若使用 '5.1(side)'，AAC 編碼器會被迫啟用 PCE (Program Config Element) 標記非標準聲道位置，
  // 導致極多主流播放器與剪輯軟體（如 Premiere Pro）無法解碼而變成靜音。
  '5.1':      { channels: 6, channelLayout: '5.1',        channelNames: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], title: '5.1 (L, R, C, LFE, Ls, Rs)' },
});
/* WAV 的多聲道檔本質上仍是一條 interleaved stream；保留 bus 順序並以 WAVEFORMATEXTENSIBLE
   可辨識的 channel mask 寫出。18 軌是使用者明確需要的情境，這份清單涵蓋到 32 軌。 */
const _WAV_CHANNEL_ORDER = Object.freeze([
  'FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC',
  'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'WL', 'WR', 'SDL', 'SDR', 'LFE2',
  'TSL', 'TSR', 'BFC', 'BFL', 'BFR', 'SSL', 'SSR', 'TTL', 'TTR',
]);
function _finiteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function _filterNumber(v, fallback = 0) { return _finiteNumber(v, fallback).toFixed(6); }
/* stream.name 是可持久化的交付預設名稱（例如「M&E」、「5.1 主混音」）；它只作為
   container metadata 傳給 ffmpeg argv，仍移除控制字元並限制長度，絕不進入 filtergraph。 */
function _streamMetadataName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 255);
}
function _exportPlanError(message) { throw new Error('音訊輸出設定錯誤：' + message); }
function _normalizeAudioPlan(raw, { requireStreams = true } = {}) {
  if (raw == null) return null;
  if (!raw || !Array.isArray(raw.buses) || (requireStreams && !Array.isArray(raw.streams)))
    { console.error('AUDIO PLAN FAILED:', JSON.stringify(raw, null, 2)); _exportPlanError(requireStreams ? '缺少 buses 或 streams。' : '缺少 buses。'); }
  if (!raw.buses.length) _exportPlanError('至少需要一條專案音軌。');

  const ids = new Set();
  const buses = raw.buses.map((bus, bi) => {
    const id = typeof bus?.id === 'string' ? bus.id : '';
    if (!id) _exportPlanError(`第 ${bi + 1} 條專案音軌沒有 id。`);
    if (ids.has(id)) _exportPlanError(`專案音軌 id 重複：${id}`);
    ids.add(id);
    const inputs = (Array.isArray(bus.inputs) ? bus.inputs : []).map((input, ii) => {
      if (!input || typeof input.file !== 'string' || !input.file) _exportPlanError(`音軌 ${bi + 1} 的輸入 ${ii + 1} 缺少檔案。`);
      const trimStart = Math.max(0, _finiteNumber(input.trimStart, 0));
      const hasTrimEnd = input.trimEnd != null && input.trimEnd !== '';
      const trimEnd = hasTrimEnd ? Math.max(0, _finiteNumber(input.trimEnd, 0)) : null;
      if (trimEnd != null && trimEnd <= trimStart) _exportPlanError(`音軌 ${bi + 1} 的輸入 ${ii + 1} 範圍無效。`);
      const sourceStream = Number.isInteger(input.sourceStream) && input.sourceStream >= 0 ? input.sourceStream : null;
      const sourceChannel = Number.isInteger(input.sourceChannel) && input.sourceChannel >= 0 ? input.sourceChannel : null;
      if ((sourceStream == null) !== (sourceChannel == null))
        _exportPlanError(`音軌 ${bi + 1} 的輸入 ${ii + 1} 母素材聲道座標不完整。`);
      return {
        file: input.file,
        // 有值時從母素材的第 N 個 audio stream / 第 M 個 channel 取單聲道；
        // null 只保留給舊版「未分離聲道」的母素材輸入，絕不表示可用 preview cache。
        sourceStream,
        sourceChannel,
        offset: Math.max(0, _finiteNumber(input.offset, 0)),
        trimStart,
        trimEnd,
        volume: Math.max(0, Math.min(64, _finiteNumber(input.volume, 1))),
        fadeIn: Math.max(0, _finiteNumber(input.fadeIn, 0)),
        fadeOut: Math.max(0, _finiteNumber(input.fadeOut, 0)),
      };
    });
    return { id, inputs };
  });

  const rawStreams = Array.isArray(raw.streams) ? raw.streams : [];
  if (requireStreams && !rawStreams.length) _exportPlanError('至少需要一條輸出音訊 stream。');
  const streamIds = new Set();
  const assignedBusIds = new Set();
  /* 純 WAV 交付只取 buses 的順序，不應因影片輸出編組尚在編輯（例如 5.1 還少一條 bus）
     而失敗；影片匯出才驗證 streams 的 layout / bus 數。 */
  const streams = (requireStreams ? rawStreams : []).map((stream, si) => {
    const id = typeof stream?.id === 'string' && stream.id ? stream.id : `stream-${si + 1}`;
    if (streamIds.has(id)) _exportPlanError(`輸出 stream id 重複：${id}`);
    streamIds.add(id);
    const layout = String(stream?.layout || '');
    const spec = _EXPORT_LAYOUTS[layout];
    if (!spec) _exportPlanError(`不支援的輸出格式：${layout || '（空白）'}。`);
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (busIds.length !== spec.channels) _exportPlanError(`${spec.title} 需要 ${spec.channels} 條專案音軌。`);
    if (new Set(busIds).size !== busIds.length) _exportPlanError(`${spec.title} 不能重複使用同一條專案音軌。`);
    for (const busId of busIds) {
      if (!ids.has(busId)) _exportPlanError(`輸出 stream 引用了不存在的專案音軌：${String(busId)}`);
      if (assignedBusIds.has(busId)) _exportPlanError(`專案音軌不能同時指派到多條輸出 stream：${String(busId)}`);
      assignedBusIds.add(busId);
    }
    return { id, name: _streamMetadataName(stream?.name), layout, busIds, spec };
  });
  return { buses, streams, ...(raw.loudness ? { loudness: raw.loudness } : {}) };
}
function _planDuration(plan) {
  let end = 0;
  for (const bus of plan?.buses || []) for (const input of bus.inputs || []) {
    if (input.trimEnd != null) end = Math.max(end, input.offset + Math.max(0, input.trimEnd - input.trimStart));
  }
  return end;
}
function _joinFilter(inputLabels, channelLayout, channelNames, outputLabel) {
  const mapping = channelNames.map((name, i) => `${i}.0-${name}`).join('|');
  return `${inputLabels.join('')}join=inputs=${inputLabels.length}:channel_layout=${channelLayout}:map=${mapping}${outputLabel}`;
}
/* 將 plan buses 編譯成 ffmpeg filtergraph。每個母素材只開啟一次 -i，再以 a:N / pan 選取
   來源 Stream/Channel；因此輸出不會碰到預覽用 proxy 或單聲道 AAC cache。
   若同一母素材已作為影片輸入開啟，reusableMasterInputs 會直接重用那個 input，避免影片＋音訊
   各自重讀一次大型 MXF/MOV，維持母素材品質的同時縮短匯出時間。 */
function _buildPlannedAudio(plan, inputs, fc, inputIndex, duration, reusableMasterInputs = null) {
  const busLabels = new Map();
  let ii = inputIndex;
  const audioInputMap = new Map();
  
  const usedBusIds = new Set();
  if (plan.streams && plan.streams.length > 0) {
    plan.streams.forEach(s => s.busIds.forEach(id => usedBusIds.add(id)));
  } else {
    plan.buses.forEach(b => usedBusIds.add(b.id));
  }

  plan.buses.forEach((bus, bi) => {
    if (!usedBusIds.has(bus.id)) return;
    const parts = [];
    bus.inputs.forEach((input, pi) => {
      const reusable = reusableMasterInputs?.get(input.file);
      // 影片 input 已以 -ss=seekStart 打開；只有所需 audio 範圍在其後才可重用。
      // 否則另開同一母素材的 audio input，保證不會少掉時間軸較前面的外部音訊。
      const canReuse = reusable && input.trimStart >= reusable.seekStart - 0.000001;
      let mappedIdx, seekStart = 0;
      if (canReuse) {
        mappedIdx = reusable.index;
        seekStart = reusable.seekStart;
      } else {
        mappedIdx = audioInputMap.get(input.file);
        if (mappedIdx === undefined) {
          mappedIdx = ii++;
          inputs.push('-i', input.file);
          audioInputMap.set(input.file, mappedIdx);
        }
      }
      const label = `[apB${bi}I${pi}]`;
      const streamSelector = input.sourceStream == null ? '' : `:${input.sourceStream}`;
      let chain = `[${mappedIdx}:a${streamSelector}]`;
      // 有來源聲道座標時不可再讓 aformat 自動 downmix，否則路由到 A3/A4 的離散聲道
      // 可能被混入其他 channel。pan 先精準取出單聲道，再做 trim / gain / fade。
      if (input.sourceChannel != null) chain += `pan=mono|c0=c${input.sourceChannel},`;
      const trimStart = Math.max(0, input.trimStart - seekStart);
      const trimEnd = input.trimEnd == null ? null : Math.max(trimStart, input.trimEnd - seekStart);
      chain += `asetpts=PTS-STARTPTS,atrim=start=${_filterNumber(trimStart)}`;
      if (trimEnd != null) chain += `:end=${_filterNumber(trimEnd)}`;
      chain += ',asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono';
      if (Math.abs(input.volume - 1) > 0.000001) chain += `,volume=${_filterNumber(input.volume, 1)}`;
      const inputDuration = input.trimEnd == null ? null : input.trimEnd - input.trimStart;
      const fadeIn = inputDuration == null ? input.fadeIn : Math.min(input.fadeIn, inputDuration);
      const fadeOut = inputDuration == null ? 0 : Math.min(input.fadeOut, inputDuration);
      if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${_filterNumber(fadeIn)}`;
      if (fadeOut > 0) chain += `,afade=t=out:st=${_filterNumber(Math.max(0, inputDuration - fadeOut))}:d=${_filterNumber(fadeOut)}`;
      const offMs = Math.max(0, Math.round(input.offset * 1000));
      chain += `,adelay=${offMs}:all=1,atrim=0:${_filterNumber(duration)},asetpts=PTS-STARTPTS${label}`;
      fc.push(chain);
      parts.push(label);
    });
    const busLabel = `[apB${bi}]`;
    if (parts.length) {
      fc.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:dropout_transition=0,atrim=0:${_filterNumber(duration)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono${busLabel}`);
    } else {
      fc.push(`anullsrc=r=48000:cl=mono,atrim=0:${_filterNumber(duration)},asetpts=PTS-STARTPTS${busLabel}`);
    }
    busLabels.set(bus.id, busLabel);
  });
  const streamLabels = [];
  plan.streams.forEach((stream, si) => {
    const inputLabels = stream.busIds.map((id, ci) => {
      let l = busLabels.get(id);
      if (!l) {
        // [v5.4.9 修復] 若該輸出 stream 參照到的專案音軌(bus)被使用者在設定對話框中調降刪除了，
        // 為了避免 ffmpeg 生成 undefined 標籤導致 undefinedjoin= 崩潰，這裡以等長的無聲(anullsrc)軌道替補。
        l = `[apS${si}M${ci}]`;
        fc.push(`anullsrc=r=48000:cl=mono,atrim=0:${_filterNumber(duration)},asetpts=PTS-STARTPTS${l}`);
      }
      return l;
    });
    let label;
    if (stream.spec.channels === 1) label = inputLabels[0];
    else {
      label = `[apS${si}]`;
      fc.push(_joinFilter(inputLabels, stream.spec.channelLayout, stream.spec.channelNames, label));
    }
    const loudnessOpts = plan.loudness || stream.loudness;
    if (loudnessOpts?.enabled) {
      const normLabel = `[apS${si}Norm]`;
      const filterRes = buildLimiterFilter(loudnessOpts);
      fc.push(`${label}${filterRes.filter}${normLabel}`);
      label = normLabel;
    }
    streamLabels.push({ label, stream });
  });
  return { inputIndex: ii, busLabels, streamLabels };
}
function _buildWavOutput(busLabels, plan, fc) {
  const labels = plan.buses.map(bus => busLabels.get(bus.id));
  let label;
  let channels = labels.length;
  if (labels.length === 1) label = labels[0];
  else {
    if (labels.length > _WAV_CHANNEL_ORDER.length)
      _exportPlanError(`WAV 單檔目前最多可輸出 ${_WAV_CHANNEL_ORDER.length} 條獨立 mono 音軌。`);
    const names = _WAV_CHANNEL_ORDER.slice(0, labels.length);
    label = '[wavOut]';
    fc.push(_joinFilter(labels, names.join('+'), names, label));
  }
  if (plan.loudness?.enabled && label) {
    const normWav = '[wavNorm]';
    const filterRes = buildLimiterFilter(plan.loudness);
    fc.push(`${label}${filterRes.filter}${normWav}`);
    label = normWav;
  }
  return { label, channels };
}
// MP4 仍需 AAC，但不能用所有聲道共用的 192k：5.1 或多條 stereo 會明顯不足。
// 這是輸出編碼位元率；輸入始終由母素材直接解碼（見 _buildPlannedAudio）。
function aacBitrateForChannels(channels) {
  const n = Math.max(1, Math.floor(_finiteNumber(channels, 1)));
  return n >= 6 ? '640k' : (n >= 2 ? '320k' : '192k');
}

/* 匯出時間碼只接受 renderer 以 secToEncore() 產生的 SMPTE 字串。不要把任意 drawtext
   表達式交給 filtergraph，避免輸出設定成為 filter injection 的入口。 */
const _EXPORT_TIMECODE_RE = /^(\d{1,6}):([0-5]\d):([0-5]\d)([:;])(\d{2,3})$/;
function _exportTimecodeRate(fps) {
  const n = _finiteNumber(fps, 25);
  // drawtext 的 timecode rate 是名義 timebase：23.976→24、29.97→30、59.94→60。
  // 這裡若傳 30000/1001，FFmpeg 內部仍會取整數；明確傳 nominal rate 才能可靠套用 DF 規則。
  if (Math.abs(n - 23.976) < 0.01) return { rate: '24', timebase: 24 };
  if (Math.abs(n - 29.97) < 0.01) return { rate: '30', timebase: 30 };
  if (Math.abs(n - 59.94) < 0.01) return { rate: '60', timebase: 60 };
  const whole = Math.max(1, Math.min(240, Math.round(n)));
  return { rate: String(whole), timebase: whole };
}
function _normaliseExportTimecodeWatermark(raw, fps) {
  if (raw == null || raw === false) return null;
  if (!raw || typeof raw !== 'object' || typeof raw.start !== 'string')
    throw new Error('時間碼浮水印設定無效。');
  const start = raw.start.trim();
  const match = _EXPORT_TIMECODE_RE.exec(start);
  const spec = _exportTimecodeRate(fps);
  if (!match || Number(match[5]) >= spec.timebase)
    throw new Error('時間碼浮水印的起始時間碼無效。');
  const dropFrame = match[4] === ';';
  if (dropFrame && !['30', '60'].includes(spec.rate))
    throw new Error('Drop-frame 時碼只支援 29.97 或 59.94 FPS。');
  // FFmpeg 的 AVTimecode 以 '.' 也表示 drop-frame，輸出仍會使用 SMPTE 的 ';'；
  // 這避免 filtergraph 把未跳脫的分號誤判成下一條 filter 的分隔符。
  return { start: dropFrame ? start.replace(';', '.') : start, rate: spec.rate };
}
function _drawtextValue(value) {
  // filtergraph 仍會拆 : / ;，所以即使值有引號也必須逐一跳脫。
  return String(value).replace(/\\/g, '/').replace(/([:\\;'\[\]])/g, '\\$1');
}
/* fontFile 由呼叫端提供（尋找字型要讀檔，是副作用，留在 main.js）。
   本模組刻意保持純函式：不 require 任何東西，才能在 vitest 裡直接測。 */
function _buildExportTimecodeFilter(inputLabel, timecode, width, height, outputLabel, fontFile) {
  const font = fontFile;
  if (!font) throw new Error('找不到更紗黑體，無法壓入時間碼浮水印。');
  const fontSize = Math.max(18, Math.round(Math.min(width, height) * 0.032));
  const margin = Math.max(12, Math.round(Math.min(width, height) * 0.02));
  const padding = Math.max(5, Math.round(fontSize * 0.32));
  return `${inputLabel}drawtext=fontfile='${_drawtextValue(font)}':timecode='${_drawtextValue(timecode.start)}':r=${timecode.rate}:tc24hmax=0:x=${margin}:y=${margin}:fontcolor=0xFFF2C5:fontsize=${fontSize}:box=1:boxcolor=0x080A0CE6:boxborderw=${padding}:borderw=1:bordercolor=0xF59E0B:fix_bounds=1${outputLabel}`;
}

/* 圖片在【軌影格】上的矩形。這是 src/image-geometry.js imageBox() 的主程序版本，
   兩者必須逐位元等價——tests/imageGeomContract.test.js 以矩陣比對鎖住這件事。

   為什麼不是「renderer 算好最終矩形傳過來」（架構審查原本的提案）：
   圖片是先疊進軌影格、軌影格再帶著自己的透明度與疊層順序疊到畫布。
   直接送畫布座標會繞過那一層，PiP 圖片軌的透明度與遮蔽就會壞掉。
   共用公式、各自套用在自己的那一層，才是這裡正確的接縫。

   為什麼不讓 ffmpeg 用 force_original_aspect_ratio=decrease 自己算：
   那樣兩邊就是兩套實作，沒有任何機制保證它們一致。JS 算完給精確的 scale=w:h，
   contain 的邏輯就只剩一份。 */
/* 片段疊層幾何與預覽共用同一份實作（`shared/image-geometry.cjs`，見鐵律 §0.9）。
   v6.1.2 之前這裡是 `imageBoxForExport()`——與 src/image-geometry.js 的 imageBox()
   逐行相同的手抄副本，靠 imageGeomContract.test.js 比對兩份輸出。
   壞掉的樣子：預覽與匯出差幾十到上百 px，兩邊各自看起來都正常。

   參數名保留 frameW/frameH 的語意（匯出端傳的是【軌影格】尺寸，不是專案畫布）。 */
function imageBoxForExport({ frameW, frameH, natW, natH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  return sharedImageBox({ stageW: frameW, stageH: frameH, natW, natH, scale, posX, posY });
}

/* ==============================================================================
   交付規格 → ffmpeg argv
   ==============================================================================
   一份交付規格 ＋ 一份專案快照 → 一組完整的 ffmpeg 參數。ADR-0001 決定「一份交付
   一個 ffmpeg 程序」，所以這裡的單位就是「一組 argv」。

   這整段以前住在 _runJobLogic() 裡，和 fs.readFileSync、spawn、佇列廣播、進度回報
   糾纏在一起，因此鐵律 §0.1（三路一致）與 §0.4（Windows 路徑跳脫【兩層】）最容易
   靜默壞掉的那一段【一行測試都沒有】——音訊那半早就搬進本檔並有測試，影像那半沒有。

   副作用一律由 env 傳入，本函式只做決策：
     hwdecArgs()             硬體解碼參數（依偵測到的編碼器）
     vencArgsBitrate(kbps)   H.264 目標位元率參數
     proresArgs()            ProRes 參數
     encoderName             實際可用的視訊編碼器（VENC；null＝libx264）
     hasAudioStream(path)    ffprobe 探測（僅舊版 stereo 回退路徑用得到）
     fontsDir                字型根目錄（燒錄 ASS 的 fontsdir；null＝不加）
     timecodeFontFile        交付 TC 專用等寬字型檔

   回傳 { args, label, duration, plannedEncoder, isGpu, kbps, audioBitrates,
          audioChannels }；呼叫端只負責 spawn 與回報。 */
function buildDeliveryArgv(spec = {}, env = {}) {
  const {
    format, clips, videoTracks, width, height, fps, duration,
    videoKbps, audioPlan, timecodeWatermark, assFileName, outPath,
  } = spec;
  const {
    hwdecArgs = () => [],
    vencArgsBitrate = () => [],
    proresArgs = () => [],
    encoderName = null,
    hasAudioStream = () => true,
    fontsDir = null,
    timecodeFontFile = null,
  } = env;

  const isWav = format === 'wav';
  const isPro = format === 'prores';
  // 佇列顯示與 runFF 必須共用同一個實際交付時長：音訊 plan 的尾端若較長，
  // ffmpeg 會以它延長成品。
  const D = Math.max(0.05, _finiteNumber(duration, 0), _planDuration(audioPlan));

  if (isWav) {
    if (!audioPlan) _exportPlanError('WAV 匯出需要專案音軌路由資料。');
    const inputs = [], fc = [];
    const planned = _buildPlannedAudio(audioPlan, inputs, fc, 0, D);
    const wav = _buildWavOutput(planned.busLabels, audioPlan, fc);
    return {
      args: ['-y', ...inputs, '-filter_complex', fc.join(';'), '-map', wav.label,
        '-ar', '48000', '-c:a', 'pcm_s24le', outPath],
      label: `匯出 WAV PCM（${wav.channels} 軌）`,
      duration: D,
      plannedEncoder: 'pcm_s24le',
      isGpu: false,
      kbps: null,
      audioBitrates: null,
      audioChannels: wav.channels,
    };
  }

  const W = Math.max(2, Math.round(width || 1920)), H = Math.max(2, Math.round(height || 1080));
  const R = fps || 25;
  // ===== 多軌合成 filtergraph（v4.11.0）=====
  //  影像：每視訊軌各自 concat 成整條時間軸（片段放 offset、間隙【透明】），再由下而上 overlay 疊到黑底；
  //        上層片段覆蓋下層（比照預覽 top-occludes），透明間隙讓下層透出。
  //  音訊：所有片段各自套混音器音量後 adelay 到自身 offset，再全部 amix（全軌混音）。
  //  單軌、無重疊的序列＝此法之特例，結果與舊版 concat 相同。
  const list = clips || [];
  if (!list.length) throw new Error('沒有可匯出的影片段');
  const inputs = [], fc = [];
  const EPS = 0.01;
  const isPassthrough = !isWav && !isPro && !assFileName && !timecodeWatermark &&
    list.length === 1 && list[0].type === 'video' &&
    !list[0].crop && !list[0].transform &&
    !list[0].fadeIn && !list[0].fadeOut &&
    (list[0].opacity == null || list[0].opacity === 1) &&
    (list[0].scale == null || list[0].scale === 1) &&
    (list[0].posX == null || list[0].posX === 0.5) &&
    (list[0].posY == null || list[0].posY === 0.5) &&
    list[0].natW === W && list[0].natH === H &&
    (list[0].offset || 0) <= EPS &&
    (list[0].speed == null || list[0].speed === 1) &&
    (list[0].out - list[0].in) >= D - EPS &&
    (list[0].in || 0) <= EPS &&
    (!videoTracks || videoTracks.every(t => (t.scale == null || t.scale === 1) && (t.opacity == null || t.opacity === 1) && (t.posX == null || t.posX === 0.5) && (t.posY == null || t.posY === 0.5)));

  // 1) 去重複輸入：同一個實體檔案只開啟一次，避免建立過多 hwaccel 實例耗盡 VRAM
  // 並且計算每個實體檔案最早被用到的時間（minIn），用 -ss 加在 -i 前，避免 ffmpeg 從 0 開始慢速解碼 44GB 大檔！
  const uniqueVideoPaths = [...new Set(list.map(c => c.path))];
  const pathMinIn = new Map();
  const reusableMasterInputs = new Map();
  uniqueVideoPaths.forEach((p, inputIndex) => {
    const clipsForPath = list.filter(c => c.path === p);
    const isImg = clipsForPath[0].type === 'image';
    if (isImg) {
      pathMinIn.set(p, 0);
      // 靜態圖片必須以 image2 的 loop input 供應整段所需影格；若少了
      // -loop 1，filtergraph 只拿到第一格，後續時間軸就會變成黑畫面。
      // 指定輸入影格率也避免由 image2 預設 25fps 再轉成專案 FPS 時出現
      // 不必要的重複／丟格。
      inputs.push('-loop', '1', '-framerate', String(R), '-i', p);
    } else {
      const minIn = Math.max(0, Math.min(...clipsForPath.map(c => c.in)) - 0.5);
      pathMinIn.set(p, minIn);
      // 這個 input 本身就是母素材；音訊 routing 可重用它，不必再多開一次同一個 MXF/MOV。
      reusableMasterInputs.set(p, { index: inputIndex, seekStart: minIn });
      const hw = isPassthrough ? [] : hwdecArgs(); // passthrough 不需硬解
      inputs.push(...hw, '-ss', minIn.toFixed(3), '-i', p);
    }
  });
  const videoInputIndices = list.map(c => uniqueVideoPaths.indexOf(c.path));
  let ii = uniqueVideoPaths.length; // 之後的逐聲道音訊檔輸入從此接續編號

  let vc = null; // 疊層後的最終影像標籤
  if (isPassthrough) {
    vc = '0:v:0';
  } else {
    // 2) 黑底 + 逐視訊軌整條時間軸 → 由下而上 overlay（各軌可有 縮放/位置/透明度＝子母畫面 PiP）
    fc.push(`color=c=black:s=${W}x${H}:r=${R}:d=${D.toFixed(3)},format=yuv420p,setsar=1[base]`);
    const vtracks = (videoTracks && videoTracks.length) ? videoTracks : [{ vt: 0 }];
    let baseLabel = '[base]';
  vtracks.forEach((T, ti) => {
    const vt = T.vt || 0;
    const scale = Math.max(0.02, Math.min(1, +T.scale || 1));
    const opacity = Math.max(0, Math.min(1, T.opacity == null ? 1 : +T.opacity));
    const px = Math.max(0, Math.min(1, T.posX == null ? 0.5 : +T.posX));
    const py = Math.max(0, Math.min(1, T.posY == null ? 0.5 : +T.posY));
    const SW = Math.max(2, Math.round(scale * W)), SH = Math.max(2, Math.round(scale * H)); // 此軌影格尺寸（PiP 時縮小）
    const trk = list.map((c, i) => ({ c, i, vIdx: videoInputIndices[i] })).filter(x => (x.c.vtrack || 0) === vt).sort((a, b) => a.c.offset - b.c.offset);
    if (!trk.length) return;
    const segs = []; let cursor = 0, si = 0;
    const gap = (gd) => { const L = `t${ti}s${si++}`; fc.push(`color=c=black@0.0:s=${SW}x${SH}:r=${R}:d=${(+gd).toFixed(3)},format=yuva420p,setsar=1[${L}]`); segs.push(`[${L}]`); };
    for (const { c, vIdx } of trk) {
      if (c.offset > cursor + EPS) gap(c.offset - cursor);
      const L = `t${ti}s${si++}`;
      const fi = Math.max(0, +c.fadeIn || 0), fo = Math.max(0, +c.fadeOut || 0), clen = clipLength(c);
      const minIn = pathMinIn.get(c.path);
      const adjIn = c.in - minIn;
      const adjOut = c.out - minIn;

      let vchain = '';
      {
        /* 片段幾何必須與預覽同一組公式（src/image-geometry.js）：
             方框＝scale×軌影格 → 素材 contain 縮進方框 → 素材【中心】對到 (posX,posY)。

           v5.7.0 起【影片與圖片走同一條路】。在那之前影片是
             scale=SW:SH:force_original_aspect_ratio=decrease + pad 置中
           ——沒有逐片段幾何，而且 pad 把素材釘死在軌影格正中央。預設值
           （scale=1、pos=0.5）下兩者結果相同，所以舊專案的輸出不變；
           但那條路沒辦法表達「這一段自己要縮小／偏移」。

           ── 不能用 pad 定位（v4.6 以前的做法，實測有兩個硬傷）：
              a) pad 的位移得用「縮放後的實際尺寸」算，但 force_original_aspect_ratio=decrease
                 之後實際尺寸小於方框 → 非同比例素材會被貼到方框左上角。實測 1920×1080 專案
                 放 500×500 的圖、scale=1/posX=0.5，匯出落在 x=0~1076（正解是 420~1500）。
              b) scale>1 時 pad 位移為負 → ffmpeg 直接 "Padded dimensions cannot be smaller
                 than input dimensions" / -22，整支匯出失敗（不只圖片壞掉）。
           overlay 的 w/h 是縮放後的真實尺寸，可用負座標（超出畫面自動裁切），兩個問題一起解。 */
        const clipScale = Math.max(0.01, +c.scale || 1);
        const cw = Math.max(2, Math.round(clipScale * SW));
        const ch = Math.max(2, Math.round(clipScale * SH));
        const pxClip = Math.max(0, Math.min(1, c.posX == null ? 0.5 : +c.posX));
        const pyClip = Math.max(0, Math.min(1, c.posY == null ? 0.5 : +c.posY));
        const BG = `t${ti}ib${si}`, IM = `t${ti}im${si}`;
        fc.push(`color=c=black@0.0:s=${SW}x${SH}:r=${R}:d=${clen.toFixed(3)},format=yuva420p,setsar=1[${BG}]`);
        /* 有原生尺寸時用【與預覽同一條公式】算出精確矩形（imageBoxForExport ≡ image-geometry.imageBox），
           contain 的邏輯就只有一份。舊專案沒帶 natW/natH 時退回讓 ffmpeg 自己算，
           結果相同，只是少了「兩邊同一份實作」的保證。 */
        const box = (+c.natW > 0 && +c.natH > 0)
          ? imageBoxForExport({ frameW: SW, frameH: SH, natW: +c.natW, natH: +c.natH,
                                scale: clipScale, posX: pxClip, posY: pyClip })
          : null;
        if (box) {
          const bw = Math.max(2, Math.round(box.w)), bh = Math.max(2, Math.round(box.h));
          fc.push(`[${vIdx}:v]setpts=PTS-STARTPTS,trim=start=${adjIn}:end=${adjOut},setpts=PTS-STARTPTS,fps=${R},scale=${bw}:${bh},format=yuva420p,setsar=1[${IM}]`);
          vchain = `[${BG}][${IM}]overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}:format=auto:eof_action=pass,format=yuva420p,setsar=1`;
        } else {
          fc.push(`[${vIdx}:v]setpts=PTS-STARTPTS,trim=start=${adjIn}:end=${adjOut},setpts=PTS-STARTPTS,fps=${R},scale=${cw}:${ch}:force_original_aspect_ratio=decrease,format=yuva420p,setsar=1[${IM}]`);
          vchain = `[${BG}][${IM}]overlay=x=(W*${pxClip.toFixed(4)})-(w/2):y=(H*${pyClip.toFixed(4)})-(h/2):format=auto:eof_action=pass,format=yuva420p,setsar=1`;
        }
      }

      // 轉場：淡入/淡出（fade alpha＝淡到透明，讓下層/黑底露出→軌間溶接）
      if (fi > 0) vchain += `,fade=t=in:st=0:d=${Math.min(fi, clen).toFixed(3)}:alpha=1`;
      if (fo > 0) vchain += `,fade=t=out:st=${Math.max(0, clen - Math.min(fo, clen)).toFixed(3)}:d=${Math.min(fo, clen).toFixed(3)}:alpha=1`;
      fc.push(`${vchain}[${L}]`);
      segs.push(`[${L}]`);
      cursor = c.offset + clipLength(c);
    }
    if (cursor < D - EPS) gap(D - cursor);
    let trkLabel;
    if (segs.length > 1) { trkLabel = `[trkV${ti}]`; fc.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=0${trkLabel}`); }
    else { trkLabel = segs[0]; }
    if (opacity < 0.999) { const ol = `[trkO${ti}]`; fc.push(`${trkLabel}format=yuva420p,colorchannelmixer=aa=${opacity.toFixed(3)}${ol}`); trkLabel = ol; } // 透明度
    const out = `[ov${ti}]`;
    // 位置：px/py 0..1 → 以 overlay 表達式對映（scale=1 時 W-w=0＝滿版；PiP 時定位縮小影格）
    fc.push(`${baseLabel}${trkLabel}overlay=x=(W-w)*${px.toFixed(4)}:y=(H-h)*${py.toFixed(4)}:eof_action=pass:format=auto${out}`);
    baseLabel = out;
  });
  vc = baseLabel;
  }
  // 3) 音訊：有 project audioPlan 時，依 bus / stream 路由輸出；沒有時完整保留舊版
  // 「所有來源混成一條 stereo」的行為，讓既有專案與自動化呼叫不受影響。
  let plannedAudio = null;
  const audioInputMap = new Map();
  if (audioPlan) {
    plannedAudio = _buildPlannedAudio(audioPlan, inputs, fc, ii, D, reusableMasterInputs);
  } else {
    const aLabels = [];
    list.forEach((c, i) => {
      let al = null;
      if (Array.isArray(c.audio)) {
        if (!c.audio.length) return; // 全靜音 → 此片段不發聲
        const mono = [];
        c.audio.forEach((ch, j) => {
          const reusable = reusableMasterInputs.get(ch.file);
          const canReuse = reusable && c.in >= reusable.seekStart - 0.000001;
          let mappedIdx, seekStart = 0;
          if (canReuse) {
            mappedIdx = reusable.index;
            seekStart = reusable.seekStart;
          } else {
            mappedIdx = audioInputMap.get(ch.file);
            if (mappedIdx === undefined) { mappedIdx = ii++; inputs.push('-i', ch.file); audioInputMap.set(ch.file, mappedIdx); }
          }
          // 相容舊專案的逐聲道混音路徑：當 renderer 提供來源 stream/channel 時，
          // ch.file 已是母素材；必須先精準擷取該離散 channel，不能讓 ffmpeg 自行 downmix。
          const streamSelector = Number.isInteger(ch.sourceStream) && ch.sourceStream >= 0 ? `:${ch.sourceStream}` : '';
          let chain = `[${mappedIdx}:a${streamSelector}]`;
          if (Number.isInteger(ch.sourceChannel) && ch.sourceChannel >= 0)
            chain += `pan=mono|c0=c${ch.sourceChannel},`;
          chain += `asetpts=PTS-STARTPTS,atrim=start=${_filterNumber(Math.max(0, c.in - seekStart))}:end=${_filterNumber(Math.max(0, c.out - seekStart))},asetpts=PTS-STARTPTS,aresample=48000,volume=${_filterNumber(ch.volume, 1)}[am${i}_${j}]`;
          fc.push(chain);
          mono.push(`[am${i}_${j}]`);
        });
        al = `[aa${i}]`;
        fc.push(mono.length > 1
          ? `${mono.join('')}amix=inputs=${mono.length}:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo${al}`
          : `${mono[0]}aformat=sample_fmts=fltp:channel_layouts=stereo${al}`);
      } else if (c.type !== 'image' && hasAudioStream(c.path)) {
        al = `[aa${i}]`;
        const seekStart = reusableMasterInputs.get(c.path)?.seekStart || 0;
        fc.push(`[${videoInputIndices[i]}:a]asetpts=PTS-STARTPTS,atrim=start=${_filterNumber(Math.max(0, c.in - seekStart))}:end=${_filterNumber(Math.max(0, c.out - seekStart))},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${al}`);
      } else return;
      const offMs = Math.max(0, Math.round((c.offset || 0) * 1000));
      // 轉場：音訊淡入/淡出（與影像同步）
      const afi = Math.max(0, +c.fadeIn || 0), afo = Math.max(0, +c.fadeOut || 0), aclen = clipLength(c);
      const afParts = [];
      if (afi > 0) afParts.push(`afade=t=in:st=0:d=${Math.min(afi, aclen).toFixed(3)}`);
      if (afo > 0) afParts.push(`afade=t=out:st=${Math.max(0, aclen - Math.min(afo, aclen)).toFixed(3)}:d=${Math.min(afo, aclen).toFixed(3)}`);
      let asrc = al;
      if (afParts.length) { const afl = `[af${i}]`; fc.push(`${al}${afParts.join(',')}${afl}`); asrc = afl; }
      fc.push(`${asrc}adelay=${offMs}:all=1[ad${i}]`);
      aLabels.push(`[ad${i}]`);
    });
    if (aLabels.length) fc.push(`${aLabels.join('')}amix=inputs=${aLabels.length}:normalize=0:dropout_transition=0,atrim=0:${D.toFixed(3)},aresample=48000[ac]`);
    else fc.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS[ac]`);
  }

  // 燒錄字幕（可見軌）：ass 濾鏡讀取暫存 .ass；以 cwd=TMP + basename 引用避開路徑跳脫
  let vfinal = vc;
  if (assFileName) {
    // v4.25.4：fontsdir 指向 <專案根>/font → 燒錄用的字型與預覽（FontFace 同一批檔）一致，
    // 不必先安裝到系統。
    // ── 磁碟機冒號要跳【兩層】(v4.31.2 修)：filtergraph 先拆選項、選項值再拆一次，
    //    所以字面上得是 `C\\:/...`。只寫一個反斜線（舊版）→ ffmpeg 把 `:` 當成選項分隔符、
    //    整條 filterchain 解析失敗 → 匯出直接掛掉。此路徑僅在 font/ 存在時才加。
    const fdirArg = fontsDir ? ':fontsdir=' + fontsDir.replace(/\\/g, '/').replace(/:/g, '\\\\:') : '';
    fc.push(`${vc}ass=${assFileName}${fdirArg}[vout]`);
    vfinal = '[vout]';
  }
  // 時間碼是交付用 burn-in，必須接在 ASS 後面，才能保證始終位於字幕與所有影像之上。
  if (timecodeWatermark) {
    const tcOut = '[vtimecode]';
    fc.push(_buildExportTimecodeFilter(vfinal, timecodeWatermark, W, H, tcOut, timecodeFontFile));
    vfinal = tcOut;
  }

  // MP4：影像使用使用者指定的目標位元率；每條 AAC stream 依聲道數給足交付 bitrate。
  // ProRes 則固定輸出 24-bit PCM，避免母素材音訊再經有損 AAC 編碼。
  const kbps = Math.max(100, Math.min(200000, Math.round(videoKbps || 5000)));
  const audioMaps = plannedAudio
    ? plannedAudio.streamLabels.flatMap(({ label }) => ['-map', label])
    : ['-map', '[ac]'];
  const audioBitrates = isPro
    ? []
    : (plannedAudio
      ? plannedAudio.streamLabels.map(({ stream }) => aacBitrateForChannels(stream.spec.channels))
      : [aacBitrateForChannels(2)]);
  const encode = isPro
    ? proresArgs()
    : isPassthrough
      ? ['-c:v', 'copy', '-c:a', 'aac', ...audioBitrates.flatMap((bitrate, i) => [`-b:a:${i}`, bitrate]), '-movflags', '+faststart']
      : [...vencArgsBitrate(kbps), '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        ...audioBitrates.flatMap((bitrate, i) => [`-b:a:${i}`, bitrate]), '-movflags', '+faststart'];
  /* Lt/Rt 與普通 stereo 的 codec channel layout 都是 FL/FR；以 stream metadata 明確標示，
     方便剪輯軟體／檢視工具辨識交付意圖，不會把 Lt/Rt 誤標為離散 L/R。 */
  const audioMetadata = plannedAudio
    ? plannedAudio.streamLabels.flatMap(({ stream }, i) => ['-metadata:s:a:' + i, 'title=' + (stream.name || stream.spec.title)])
    : [];
  
  const args = ['-y', ...inputs];
  if (fc.length > 0) args.push('-filter_complex', fc.join(';'));
  args.push('-map', vfinal, ...audioMaps);
  if (!isPassthrough) args.push('-r', String(R));
  args.push(...encode, ...audioMetadata, outPath);

  // 進度標籤即顯示本次實際送出的編碼器（GPU 或 CPU）與位元率，使用者在狀態列就看得到
  const plannedEncoder = isPro ? 'prores_ks' : (isPassthrough ? 'copy' : (encoderName || 'libx264'));
  const isGpu = !isPro && plannedEncoder !== 'libx264' && plannedEncoder !== 'copy';
  const accel = isGpu ? 'GPU ' + plannedEncoder.replace('h264_', '').toUpperCase() : (isPassthrough ? 'Direct Stream Copy' : 'CPU ' + plannedEncoder);
  return {
    args,
    label: `匯出 ${isPro ? 'ProRes 422 HQ' : 'MP4 ' + (kbps / 1000).toFixed(1) + 'Mbps'}（${accel}）`,
    duration: D,
    plannedEncoder,
    isGpu,
    kbps: isPro ? null : kbps,
    audioBitrates: isPro ? null : audioBitrates,
    audioChannels: null,
  };
}

module.exports = {
  imageBoxForExport,
  buildDeliveryArgv,
  _EXPORT_LAYOUTS,
  _finiteNumber,
  _filterNumber,
  _exportPlanError,
  _normalizeAudioPlan,
  _planDuration,
  _buildPlannedAudio,
  _buildWavOutput,
  aacBitrateForChannels,
  _normaliseExportTimecodeWatermark,
  _buildExportTimecodeFilter,
  _drawtextValue,
};



/* ==============================================================================
   SUB Tool — 匯出計畫（純邏輯，無 I/O）
   ==============================================================================
   從 electron/main.js 抽出。這裡只做【決策】：把專案資料算成 ffmpeg 的
   filtergraph 片段、音訊路由與 bitrate。不開檔、不 spawn、不碰 Electron。

   為什麼要有這個接縫：匯出是本工具唯一的交付物，也是最容易「有產出但是錯的」
   的地方（見 docs/技術架構說明.md §0.6）。它原本整段長在 ipcMain.handle 裡，
   與 dialog、ffprobe spawn 糾纏，vitest 起不了 Electron，於是一行測試都沒有。

   本檔【不可】require 任何東西——保持零依賴就是它可測的保證。
   需要副作用的部分（找字型、探測音軌、硬體編碼器）一律由呼叫端傳入。
============================================================================== */
/* ===== 專案音訊輸出（v4.36） =====
   audioPlan 將「來源檔案」與「專案匯流排」分開：
   - buses：每一條都是單聲道專案輸出，inputs 可在同一 bus 內混音；
   - streams：影片容器內的音訊 stream，將 bus 依 Mono / Stereo / LtRt / 5.1 編組。
   不把使用者提供的 id / 路徑塞進 filtergraph：id 只用於 Map 查找，filter label 一律由索引產生；
   路徑則是獨立的 spawn argv。這同時避免 Windows 路徑跳脫問題與 filter injection。 */
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
    _exportPlanError(requireStreams ? '缺少 buses 或 streams。' : '缺少 buses。');
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
  return { buses, streams };
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
  plan.buses.forEach((bus, bi) => {
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
    const inputLabels = stream.busIds.map(id => busLabels.get(id));
    let label;
    if (stream.spec.channels === 1) label = inputLabels[0];
    else {
      label = `[apS${si}]`;
      fc.push(_joinFilter(inputLabels, stream.spec.channelLayout, stream.spec.channelNames, label));
    }
    streamLabels.push({ label, stream });
  });
  return { inputIndex: ii, busLabels, streamLabels };
}
function _buildWavOutput(busLabels, plan, fc) {
  const labels = plan.buses.map(bus => busLabels.get(bus.id));
  if (labels.length === 1) return { label: labels[0], channels: 1 };
  if (labels.length > _WAV_CHANNEL_ORDER.length)
    _exportPlanError(`WAV 單檔目前最多可輸出 ${_WAV_CHANNEL_ORDER.length} 條獨立 mono 音軌。`);
  const names = _WAV_CHANNEL_ORDER.slice(0, labels.length);
  const label = '[wavOut]';
  fc.push(_joinFilter(labels, names.join('+'), names, label));
  return { label, channels: labels.length };
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

/* 圖片在【軌影格】上的矩形。這是 src/imagegeom.js imageBox() 的主程序版本，
   兩者必須逐位元等價——tests/imageGeomContract.test.js 以矩陣比對鎖住這件事。

   為什麼不是「renderer 算好最終矩形傳過來」（架構審查原本的提案）：
   圖片是先疊進軌影格、軌影格再帶著自己的透明度與疊層順序疊到畫布。
   直接送畫布座標會繞過那一層，PiP 圖片軌的透明度與遮蔽就會壞掉。
   共用公式、各自套用在自己的那一層，才是這裡正確的接縫。

   為什麼不讓 ffmpeg 用 force_original_aspect_ratio=decrease 自己算：
   那樣兩邊就是兩套實作，沒有任何機制保證它們一致。JS 算完給精確的 scale=w:h，
   contain 的邏輯就只剩一份。 */
function imageBoxForExport({ frameW, frameH, natW, natH, scale = 1, posX = 0.5, posY = 0.5 } = {}) {
  const clamp01 = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
  };
  const SW = Math.max(0, _finiteNumber(frameW, 0)), SH = Math.max(0, _finiteNumber(frameH, 0));
  const s = Math.max(0.01, _finiteNumber(scale, 1));
  const boxW = SW * s, boxH = SH * s;
  const nw = Math.max(0, _finiteNumber(natW, 0)), nh = Math.max(0, _finiteNumber(natH, 0));
  let w = boxW, h = boxH;
  if (nw > 0 && nh > 0 && boxW > 0 && boxH > 0) {
    const k = Math.min(boxW / nw, boxH / nh); // contain
    w = nw * k; h = nh * k;
  }
  const cx = SW * clamp01(posX, 0.5), cy = SH * clamp01(posY, 0.5);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

module.exports = {
  imageBoxForExport,
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

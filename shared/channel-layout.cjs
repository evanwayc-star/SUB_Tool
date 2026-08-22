/* ==============================================================================
   SUB Tool — 來源聲道的展開順序 (Source Audio Channel Flattening)
   ==============================================================================
   【架構與職責】
   兩個行程（主行程 CommonJS 與渲染端 ES Module）共用的單一領域規則。
   
   【鐵律與不變量】
   ffprobe 的 `audio[]`（每個元素為一條音訊 stream，各自具備 channels 聲道數）
   攤平成一維的「來源聲道」清單。
   攤平的順序是跨行程契約，絕非內部實作細節：
   - 主行程 ingest 時依此順序將每條聲道抽出為 `ch_01.m4a`、`ch_02.m4a`…
   - 渲染端再依此扁平順序對應回 (sourceStream, sourceChannel)。
   若順序出現偏差，聲道將整組錯位（畫面與波形看似正常，但播放聲道內容錯誤）。
   
   CONTEXT.md 定義：來源聲道 ＝ 母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。
   ============================================================================== */

/**
 * 計算單一音訊 Stream 的有效聲道數。
 * 
 * 邊界防禦：
 * 若 stream 為空、channels 欄位缺失、非數值或小於等於 0，一律安全回傳 1，
 * 防止整條音訊 stream 消失或產生無效迴圈。
 * 
 * @param {object} [stream] ffprobe 音訊 stream 物件
 * @param {number} [stream.channels] 該 stream 包含的聲道數
 * @returns {number} 有效聲道數（至少為 1 的整數）
 */
function sourceChannelCount(stream) {
  const raw = stream ? Number(stream.channels) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

/**
 * 將 ffprobe 的音訊 Stream 陣列攤平為一維來源聲道描述清單。
 * 
 * @param {Array<{channels?: number}>} [audio] ffprobe 音訊 stream 陣列
 * @returns {Array<{sourceStream: number, sourceChannel: number, index: number}>}
 *          扁平化的來源聲道陣列，其中：
 *          - `sourceStream`: 原始 Stream 索引（0-based）
 *          - `sourceChannel`: 該 Stream 內的聲道索引（0-based）
 *          - `index`: 全域扁平流水號（0-based，對應抽出檔名的 index）
 */
function flattenSourceChannels(audio) {
  const out = [];
  const list = Array.isArray(audio) ? audio : [];
  for (let streamIndex = 0; streamIndex < list.length; streamIndex++) {
    const stream = list[streamIndex];
    const chCount = sourceChannelCount(stream);
    for (let channelIndex = 0; channelIndex < chCount; channelIndex++) {
      out.push({
        sourceStream: streamIndex,
        sourceChannel: channelIndex,
        index: out.length,
      });
    }
  }
  return out;
}

/**
 * 依扁平序號轉換為轉檔快取抽出的單聲道檔名（1-based，補零兩位）。
 * 
 * @param {number} index 扁平序號（0-based）
 * @returns {string} 抽出的音訊檔名（例如 `ch_01.m4a`）
 */
function channelFileName(index) {
  const safeIndex = Math.max(0, Math.floor(Number(index) || 0));
  return `ch_${String(safeIndex + 1).padStart(2, '0')}.m4a`;
}

module.exports = { sourceChannelCount, flattenSourceChannels, channelFileName };

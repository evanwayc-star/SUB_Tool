/* ==============================================================================
   SUB Tool — 來源聲道的展開順序（兩個行程共用的唯一一份）
   ==============================================================================

   ffprobe 的 `audio[]`（每個元素是一條音訊 stream，各自有 channels 數）
   攤平成一維的「來源聲道」清單。**攤平的順序是跨行程約定，不是實作細節。**

   主程序 ingest 時依這個順序把每條聲道抽成 `ch_01.m4a`、`ch_02.m4a`…，
   renderer 再依位置把它們對回 (sourceStream, sourceChannel)。順序只要有一邊改了，
   聲道就會整組對錯位——**畫面完全正常、波形也畫得出來**，
   只有把成品放進播放器才聽得出來是別條聲道。

   v6.1.2 之前這份邏輯在 src/ 與 electron/ 各有一份手抄實作，靠
   `tests/channelLayoutContract.test.js` 矩陣窮舉比對。那支測試證明的是
   「兩份副本目前一致」，不是規則本身正確——現在只有這一份，測試改為直接測它。

   CONTEXT.md：**來源聲道**＝母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。
============================================================================== */

/** 單一 stream 的聲道數（缺值或 0 一律當 1，才不會讓整條 stream 消失）。 */
function sourceChannelCount(stream) {
  return Math.max(1, (stream && stream.channels) || 1);
}

/**
 * ffprobe audio[] → 一維來源聲道清單。
 * @param {Array<{channels?:number}>} audio ffprobe 的音訊 stream 陣列
 * @returns {Array<{sourceStream:number, sourceChannel:number, index:number}>}
 *          index＝從 0 起算的扁平序號（主程序的 ch_NN 檔名就是 index+1）
 */
function flattenSourceChannels(audio) {
  const out = [];
  (Array.isArray(audio) ? audio : []).forEach((a, streamIndex) => {
    const ch = sourceChannelCount(a);
    for (let k = 0; k < ch; k++) {
      out.push({ sourceStream: streamIndex, sourceChannel: k, index: out.length });
    }
  });
  return out;
}

/** 扁平序號 → ingest 抽出的單聲道檔名（1-based，補零兩位）。 */
function channelFileName(index) {
  return `ch_${String(index + 1).padStart(2, '0')}.m4a`;
}

module.exports = { sourceChannelCount, flattenSourceChannels, channelFileName };

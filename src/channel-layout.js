/* ==============================================================================
   SUB Tool — 來源聲道的展開順序（renderer 側）
   ==============================================================================

   ffprobe 的 `audio[]`（每個元素是一條音訊 stream，各自有 channels 數）
   要攤平成一維的「來源聲道」清單。**攤平的順序是跨行程約定，不是實作細節。**

   主程序 ingest 時會依同一個順序把每條聲道抽成 `ch_01.m4a`、`ch_02.m4a`…，
   renderer 再依位置把它們對回 (sourceStream, sourceChannel)。兩邊的順序只要有一邊
   改了，聲道就會整組對錯位——**畫面完全正常、波形也畫得出來**，
   只有把成品放進播放器才聽得出來是別條聲道。

   【跨行程的接縫】
   主程序是 CommonJS（`electron/channel-layout.js`），無法 import 這一支；
   兩邊各自維護一份，由 `tests/channelLayoutContract.test.js` 矩陣窮舉比對。

   CONTEXT.md：**來源聲道**＝母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。
============================================================================== */

/**
 * ffprobe audio[] → 一維來源聲道清單。
 *
 * @param {Array<{channels?:number}>} audio ffprobe 的音訊 stream 陣列
 * @returns {Array<{sourceStream:number, sourceChannel:number, index:number}>}
 *          index＝從 0 起算的扁平序號（主程序的 ch_NN 檔名就是 index+1）
 */
export function flattenSourceChannels(audio) {
  const out = [];
  (audio || []).forEach((a, streamIndex) => {
    const ch = Math.max(1, a?.channels || 1);
    for (let k = 0; k < ch; k++) {
      out.push({ sourceStream: streamIndex, sourceChannel: k, index: out.length });
    }
  });
  return out;
}

/** 展開後每條聲道的顯示標籤（「聲道1」「聲道2」…；號碼是扁平序號，從 1 起算）。 */
export function sourceChannelLabels(audio) {
  return flattenSourceChannels(audio).map(c => `聲道${c.index + 1}`);
}

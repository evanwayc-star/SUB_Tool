/* ==============================================================================
   SUB Tool — 來源聲道的展開順序（主程序側）
   ==============================================================================

   ingest 時把 ffprobe 的 `audio[]` 攤平成一維聲道清單，並依這個順序把每條聲道
   抽成 `ch_01.m4a`、`ch_02.m4a`…。renderer（`src/channel-layout.js`）依同一個順序
   把檔案對回 (sourceStream, sourceChannel)。

   **順序是跨行程約定。** 任一邊改了，聲道就會整組對錯位——畫面完全正常、
   波形也畫得出來，只有把成品放進播放器才聽得出來是別條聲道。
   由 `tests/channelLayoutContract.test.js` 矩陣窮舉比對兩邊。
============================================================================== */

/** ffprobe audio[] → 一維來源聲道清單（與 renderer 端同序）。 */
function flattenSourceChannels(audio) {
  const out = [];
  (audio || []).forEach((a, streamIndex) => {
    const ch = Math.max(1, (a && a.channels) || 1);
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

module.exports = { flattenSourceChannels, channelFileName };

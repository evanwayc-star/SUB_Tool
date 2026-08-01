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
function sourceChannelCount(stream) {
  return Math.max(1, (stream && stream.channels) || 1);
}

function flattenSourceChannels(audio) {
  const out = [];
  (audio || []).forEach((a, streamIndex) => {
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

/**
 * ffprobe audio[] → 單次 ffmpeg ingest 的跨平台音訊規劃。
 *
 * Windows 與 macOS Electron 都由 electron/main.js 呼叫這一份；容器裡每個 stream 的
 * 每個 channel 都會得到自己的 Mono filter output 與 ch_NN.m4a，不依平台或
 * channel_layout 猜測 5.1／Stereo 編組。
 */
function buildAudioIngestPlan(audio) {
  const filters = [];
  const channels = [];
  const channelMaps = [];
  const waveContribs = [];
  const audioArr = Array.isArray(audio) ? audio : [];
  let channelIndex = 0;

  audioArr.forEach((stream, streamIndex) => {
    const count = sourceChannelCount(stream);
    const base = (stream && (stream.title || stream.lang)) || `音軌 ${streamIndex + 1}`;

    if (count === 1) {
      filters.push(`[0:a:${streamIndex}]asplit=2[co${channelIndex}][wv${streamIndex}]`);
      channels.push({
        label: base,
        file: channelFileName(channelIndex),
        sourceStream: streamIndex,
        sourceChannel: 0,
      });
      channelMaps.push(`[co${channelIndex}]`);
      waveContribs.push(`[wv${streamIndex}]`);
      channelIndex++;
      return;
    }

    const splitPads = Array.from({ length: count }, (_, sourceChannel) => `sp${streamIndex}_${sourceChannel}`);
    filters.push(
      `[0:a:${streamIndex}]asplit=${count + 1}${splitPads.map(pad => `[${pad}]`).join('')}[wv${streamIndex}]`,
    );
    for (let sourceChannel = 0; sourceChannel < count; sourceChannel++) {
      filters.push(`[${splitPads[sourceChannel]}]pan=mono|c0=c${sourceChannel}[co${channelIndex}]`);
      channels.push({
        label: `${base} · 聲道${sourceChannel + 1}`,
        file: channelFileName(channelIndex),
        sourceStream: streamIndex,
        sourceChannel,
      });
      channelMaps.push(`[co${channelIndex}]`);
      channelIndex++;
    }
    const average = (1 / count).toFixed(4);
    const sum = Array.from({ length: count }, (_, sourceChannel) => `${average}*c${sourceChannel}`).join('+');
    filters.push(`[wv${streamIndex}]pan=mono|c0=${sum}[wm${streamIndex}]`);
    waveContribs.push(`[wm${streamIndex}]`);
  });

  let waveLabel = null;
  if (waveContribs.length === 1) {
    waveLabel = waveContribs[0];
  } else if (waveContribs.length > 1) {
    filters.push(`${waveContribs.join('')}amix=inputs=${waveContribs.length}:normalize=0[wavemix]`);
    waveLabel = '[wavemix]';
  }

  return { filters, channels, channelMaps, waveLabel };
}

module.exports = { flattenSourceChannels, channelFileName, buildAudioIngestPlan };

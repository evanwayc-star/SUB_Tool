/* ==============================================================================
   SUB Tool — 單次 ffmpeg ingest 的音訊規劃（主程序側）
   ==============================================================================

   ingest 時把 ffprobe 的 `audio[]` 攤平成一維聲道清單，並依這個順序把每條聲道
   抽成 `ch_01.m4a`、`ch_02.m4a`…。renderer 依同一個順序把檔案對回
   (sourceStream, sourceChannel)。

   **展開順序是跨行程約定**，規則住在 `shared/channel-layout.cjs`——
   v6.1.2 之前這裡有一份與 renderer 逐行相同的手抄副本，現在只有那一份。
   本檔只留主程序專用的部分：filtergraph 規劃。
============================================================================== */
const { sourceChannelCount, flattenSourceChannels, channelFileName } = require('../shared/channel-layout.cjs');

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

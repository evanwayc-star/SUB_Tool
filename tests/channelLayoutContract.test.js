/* 來源聲道展開順序的【跨行程契約】。

   ⚠ v6.1.2 起兩側不再各有一份實作。規則收進 `shared/channel-layout.cjs`，
     renderer 與主程序都從那裡取用：

     src/channel-layout.js       → 轉出 shared 的 flattenSourceChannels()
     electron/channel-layout.js  → require 同一份

     因此本檔的比對「兩邊輸出相同」現在是恆真的——它守的東西變了：
     從「兩份手抄副本有沒有漂掉」變成「兩側的取用路徑有沒有接對」
     （例如某一側改回自己寫一份、或 re-export 漏掉名稱）。
     真正的規則正確性由下方對 flattenSourceChannels 本身的斷言負責。

   主程序 ingest 時依這個順序把每條聲道抽成 ch_01.m4a、ch_02.m4a…，
   renderer 再依位置把檔案對回 (sourceStream, sourceChannel)。

   壞掉的樣子：聲道整組對錯位。**畫面完全正常、波形也畫得出來**，
   混音器上看起來一切就緒——只有把成品放進播放器才聽得出來是別條聲道。

   CONTEXT.md：**來源聲道**＝母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。

   【這支測得到什麼、測不到什麼】
   測得到：兩側 flattenSourceChannels 的輸出逐項相同、扁平序號 → 檔名，以及 main.js
   實際使用的 buildAudioIngestPlan() 所產生之 channels[]／filtergraph 規劃。
   測不到：原生 ffmpeg binary 真正解碼特定母檔後的聲音內容；那一層仍需 §4 大檔真機驗收。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { flattenSourceChannels, sourceChannelLabels } from '../src/audio-routing-engine.js';

const require = createRequire(import.meta.url);
const main = require('../electron/media-intake-runtime.js');

/* 涵蓋單聲道、立體聲、5.1、多 stream 混合，以及缺欄位的防呆。 */
const MATRIX = [
  { label: '單一單聲道', audio: [{ channels: 1 }] },
  { label: '單一立體聲', audio: [{ channels: 2 }] },
  { label: '單一 5.1', audio: [{ channels: 6 }] },
  { label: '八條單聲道（MXF 常見）', audio: Array.from({ length: 8 }, () => ({ channels: 1 })) },
  { label: '立體聲 + 5.1', audio: [{ channels: 2 }, { channels: 6 }] },
  { label: '5.1 + 立體聲 + 單聲道', audio: [{ channels: 6 }, { channels: 2 }, { channels: 1 }] },
  { label: 'channels 缺漏視為 1', audio: [{}, { channels: 2 }] },
  { label: 'channels 為 0 視為 1', audio: [{ channels: 0 }] },
  { label: '空陣列', audio: [] },
];

describe('來源聲道展開：renderer ↔ 主程序', () => {
  for (const { label, audio } of MATRIX) {
    it(`${label}：兩側輸出完全相同`, () => {
      expect(flattenSourceChannels(audio)).toEqual(main.flattenSourceChannels(audio));
    });
  }

  it('攤平順序＝先走完 stream 0 的所有聲道，再走 stream 1', () => {
    const got = flattenSourceChannels([{ channels: 2 }, { channels: 3 }]);
    expect(got.map(c => `${c.sourceStream}:${c.sourceChannel}`))
      .toEqual(['0:0', '0:1', '1:0', '1:1', '1:2']);
  });

  it('扁平序號連續且從 0 起算（主程序的 ch_NN 就是 index+1）', () => {
    const got = flattenSourceChannels([{ channels: 2 }, { channels: 6 }]);
    expect(got.map(c => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('扁平序號 → 檔名（補零兩位、1-based）', () => {
    expect(main.channelFileName(0)).toBe('ch_01.m4a');
    expect(main.channelFileName(8)).toBe('ch_09.m4a');
    expect(main.channelFileName(9)).toBe('ch_10.m4a');
    expect(main.channelFileName(11)).toBe('ch_12.m4a');
  });

  it('5.1 的第一條聲道對到 ch_01，立體聲接在後面', () => {
    const got = flattenSourceChannels([{ channels: 6 }, { channels: 2 }]);
    expect(main.channelFileName(got[0].index)).toBe('ch_01.m4a');
    expect(main.channelFileName(got[6].index)).toBe('ch_07.m4a');
    expect(got[6]).toMatchObject({ sourceStream: 1, sourceChannel: 0 });
  });

  it('null／undefined 安全', () => {
    expect(flattenSourceChannels(null)).toEqual([]);
    expect(flattenSourceChannels(undefined)).toEqual(main.flattenSourceChannels(undefined));
  });
});

describe('桌面版原生 ingest 規劃', () => {
  for (const { label, audio } of MATRIX) {
    it(`${label}：ingest 規劃與 renderer 的來源聲道座標、順序完全相同`, () => {
      const plan = main.buildAudioIngestPlan(audio);
      expect(plan.channels.map(({ sourceStream, sourceChannel }, index) => ({
        sourceStream, sourceChannel, index,
      }))).toEqual(flattenSourceChannels(audio));
      expect(plan.channels.map(channel => channel.file))
        .toEqual(plan.channels.map((_, index) => main.channelFileName(index)));
    });
  }

  it('5.1 FM + 2.0 FM 會產生依序排列的 8 個獨立 Mono 來源聲道', () => {
    const plan = main.buildAudioIngestPlan([
      { channels: 6, title: '5.1 FM' },
      { channels: 2, title: '2.0 FM' },
    ]);

    expect(plan.channels).toEqual([
      { label: '5.1 FM · 聲道1', file: 'ch_01.m4a', sourceStream: 0, sourceChannel: 0 },
      { label: '5.1 FM · 聲道2', file: 'ch_02.m4a', sourceStream: 0, sourceChannel: 1 },
      { label: '5.1 FM · 聲道3', file: 'ch_03.m4a', sourceStream: 0, sourceChannel: 2 },
      { label: '5.1 FM · 聲道4', file: 'ch_04.m4a', sourceStream: 0, sourceChannel: 3 },
      { label: '5.1 FM · 聲道5', file: 'ch_05.m4a', sourceStream: 0, sourceChannel: 4 },
      { label: '5.1 FM · 聲道6', file: 'ch_06.m4a', sourceStream: 0, sourceChannel: 5 },
      { label: '2.0 FM · 聲道1', file: 'ch_07.m4a', sourceStream: 1, sourceChannel: 0 },
      { label: '2.0 FM · 聲道2', file: 'ch_08.m4a', sourceStream: 1, sourceChannel: 1 },
    ]);
    expect(plan.channelMaps).toEqual([
      '[co0]', '[co1]', '[co2]', '[co3]', '[co4]', '[co5]', '[co6]', '[co7]',
    ]);
    expect(plan.filters.filter(part => part.includes('pan=mono') && /\[co\d+\]$/.test(part)))
      .toEqual([
        '[sp0_0]pan=mono|c0=c0[co0]',
        '[sp0_1]pan=mono|c0=c1[co1]',
        '[sp0_2]pan=mono|c0=c2[co2]',
        '[sp0_3]pan=mono|c0=c3[co3]',
        '[sp0_4]pan=mono|c0=c4[co4]',
        '[sp0_5]pan=mono|c0=c5[co5]',
        '[sp1_0]pan=mono|c0=c0[co6]',
        '[sp1_1]pan=mono|c0=c1[co7]',
      ]);
  });
});

describe('聲道標籤', () => {
  it('號碼是扁平序號、從 1 起算（跨 stream 連續，不是每條 stream 重新算）', () => {
    expect(sourceChannelLabels([{ channels: 2 }, { channels: 2 }]))
      .toEqual(['聲道1', '聲道2', '聲道3', '聲道4']);
  });

  it('標籤數量等於展開後的聲道數', () => {
    for (const { audio } of MATRIX) {
      expect(sourceChannelLabels(audio)).toHaveLength(flattenSourceChannels(audio).length);
    }
  });
});

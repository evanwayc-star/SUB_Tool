/* 來源聲道展開順序的【跨行程契約】。

     src/channel-layout.js       flattenSourceChannels()  → renderer（ES module）
     electron/channel-layout.js  flattenSourceChannels()  → 主程序（CommonJS）

   主程序 ingest 時依這個順序把每條聲道抽成 ch_01.m4a、ch_02.m4a…，
   renderer 再依位置把檔案對回 (sourceStream, sourceChannel)。

   壞掉的樣子：聲道整組對錯位。**畫面完全正常、波形也畫得出來**，
   混音器上看起來一切就緒——只有把成品放進播放器才聽得出來是別條聲道。

   CONTEXT.md：**來源聲道**＝母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。

   【這支測得到什麼、測不到什麼】
   測得到：兩側 flattenSourceChannels 的輸出逐項相同，以及扁平序號 → 檔名的對應。
   測不到：main.js `_runIngest` 裡真正產生 channels[] 的那段迴圈——它與 filtergraph
   組建交纏、且是 async + spawn ffmpeg，vitest 起不了。那段已改為呼叫共用的
   channelFileName()，但「迴圈的走訪順序」本身仍只能靠這裡的規格與程式碼審查把關。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { flattenSourceChannels, sourceChannelLabels } from '../src/channel-layout.js';

const require = createRequire(import.meta.url);
const main = require('../electron/channel-layout.js');

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

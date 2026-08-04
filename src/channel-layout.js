/* ==============================================================================
   SUB Tool — 來源聲道的展開順序（renderer 側入口）
   ==============================================================================

   規則本身住在 `shared/channel-layout.cjs`——那是兩個行程共用的**唯一一份**。
   這裡只做 renderer 專用的東西（顯示標籤），並把共用的名稱轉出去，
   讓 renderer 的呼叫端維持 `from './channel-layout.js'` 的既有寫法。

   v6.1.2 之前這裡有一份與主程序逐行相同的手抄實作，靠契約測試比對兩份輸出。
   順序錯位的樣子：聲道整組對錯，畫面與波形都正常，只有放進播放器才聽得出來。

   CONTEXT.md：**來源聲道**＝母素材內可獨立讀取的一個聲道，以從 1 開始的號碼識別。
============================================================================== */
import { flattenSourceChannels, channelFileName } from '../shared/channel-layout.cjs';

export { flattenSourceChannels, channelFileName };

/** 展開後每條聲道的顯示標籤（「聲道1」「聲道2」…；號碼是扁平序號，從 1 起算）。 */
export function sourceChannelLabels(audio) {
  return flattenSourceChannels(audio).map(c => `聲道${c.index + 1}`);
}

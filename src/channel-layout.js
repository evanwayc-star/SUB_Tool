/* ==============================================================================
   SUB Tool — 來源聲道展開順序（Renderer 配接層）
   ==============================================================================
   【架構與職責】
   來源聲道展開的核心規則統一維護於 `shared/channel-layout.cjs`。
   本模組提供渲染端專屬的聲道顯示名稱與標籤生成。
   ============================================================================== */
import { flattenSourceChannels, channelFileName } from '../shared/channel-layout.cjs';

export { flattenSourceChannels, channelFileName };

/**
 * 取得展開後各聲道於 UI 介面上的繁體中文顯示標籤清單（「聲道1」「聲道2」…）。
 * 
 * @param {Array<{channels?: number}>} [audio] ffprobe 音訊 stream 陣列
 * @returns {string[]} 聲道顯示名稱陣列（例如 `['聲道1', '聲道2']`）
 */
export function sourceChannelLabels(audio) {
  return flattenSourceChannels(audio).map(c => `聲道${c.index + 1}`);
}

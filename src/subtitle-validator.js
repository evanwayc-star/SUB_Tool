/* ==============================================================================
   SUB Tool — 匯出前字幕防呆驗證器 (Pre-export Subtitle Validator)
   ==============================================================================
   【架構與職責】
   在使用者點擊匯出或送入轉檔佇列前，對專案內所有字幕軌進行品質與安全檢查：
   1. 無效時間碼（缺失 start/end 或 end <= start）。
   2. 時間碼重疊（同一軌道內相鄰字幕時間重疊）。
   3. 行數過多（超過 2 行換行，即 3 行以上字幕）。
   4. 字數過多（純文字長度超過 wordLimit 限制）。
   ============================================================================== */
import { State } from './state.js';
import { secToEncore } from './time.js';

/**
 * 執行匯出前字幕防呆驗證掃描。
 * 
 * @param {number|null} [wordLimit=null] 單句最大字數限制（若為 null 或 0 則不檢查字數）
 * @returns {string[]} 錯誤與警告訊息清單（若完全無誤則回傳空陣列）
 */
export function validateSubtitlesBeforeExport(wordLimit = null) {
  const errors = [];
  if (!State || !Array.isArray(State.cues)) return errors;

  // 分軌整理 cues 以便精確檢查同一軌道之重疊
  const tracksMap = new Map();
  for (const c of State.cues) {
    if (c.timed === false) continue;
    const tk = c.track || 0;
    if (!tracksMap.has(tk)) tracksMap.set(tk, []);
    tracksMap.get(tk).push(c);
  }

  for (const [tk, cues] of tracksMap.entries()) {
    // 依據開始時間遞增排序
    cues.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const text = (c.text || '').trim();
      const plainText = text.replace(/<[^>]+>/g, '').replace(/\\N/g, '\n');

      const trackLabel = `軌道 ${tk + 1}`;
      const timecode = typeof c.start === 'number' ? secToEncore(c.start, State.fps, State.dropFrame) : '??:??:??:??';
      const timeLabel = `[${timecode} 第 ${i + 1} 句]`;
      const prefix = `${trackLabel} ${timeLabel}`;

      // 1. 無效時間碼 (缺失或 start >= end)
      if (typeof c.start !== 'number' || typeof c.end !== 'number' || c.end <= c.start) {
        errors.push(`${prefix}: 無效的時間碼 (開始 >= 結束或缺失)`);
        continue;
      }

      // 2. 時間碼重疊檢查（含 0.01 秒微小浮點容差）
      if (i > 0) {
        const prevC = cues[i - 1];
        if (c.start < prevC.end - 0.01) {
          const currentStart = typeof c.start === 'number' ? secToEncore(c.start, State.fps, State.dropFrame) : '??:??:??:??';
          const prevEnd = typeof prevC.end === 'number' ? secToEncore(prevC.end, State.fps, State.dropFrame) : '??:??:??:??';
          errors.push(`${prefix}: 時間碼與前一句重疊 (本句開始 ${currentStart}, 前句結束 ${prevEnd})`);
        }
      }

      // 3. 行數過多檢查（超過 2 個換行）
      const lines = plainText.split('\n');
      if (lines.length >= 3) {
        errors.push(`${prefix}: 字幕超過 3 行 (${lines.length} 行)`);
      }

      // 4. 字數過多檢查（排除空白字元）
      if (wordLimit && !isNaN(wordLimit) && wordLimit > 0) {
        const charCount = plainText.replace(/\s/g, '').length;
        if (charCount > wordLimit) {
          errors.push(`${prefix}: 字數過多 (達 ${charCount} 字，上限 ${wordLimit} 字)`);
        }
      }
    }
  }

  return errors;
}

import { State } from './state.js';
import { effStyle } from './substyle.js';
import { secToEncore } from './time.js';

/**
 * 匯出前字幕防呆檢查 (Pre-export Subtitle Validation)
 * 掃描所有字幕軌，檢查以下四項：
 * 1. 無時間碼 (缺失 start/end 或 end <= start)
 * 2. 時間碼重疊 (與同一軌的其他字幕時間重疊)
 * 3. 行數過多 (包含大於等於 2 個換行符號 \n 或 \N，即 3 行以上)
 * 4. 字數過多 (純文字長度超過 wordLimit 字)
 * 
 * @param {number} wordLimit - 字數限制 (預設 30)
 * @returns {Array} - 錯誤清單，若無錯誤回傳空陣列
 */
export function validateSubtitlesBeforeExport(wordLimit = null) {
  const errors = [];
  if (!State || !State.cues) return errors;

  // 分軌整理 cues 以便檢查重疊
  const tracksMap = new Map();
  for (const c of State.cues) {
    if (c.timed === false) continue;
    const tk = c.track || 0;
    if (!tracksMap.has(tk)) tracksMap.set(tk, []);
    tracksMap.get(tk).push(c);
  }

  for (const [tk, cues] of tracksMap.entries()) {
    // 依據開始時間排序
    cues.sort((a, b) => a.start - b.start);

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const text = (c.text || '').trim();
      const plainText = text.replace(/<[^>]+>/g, '').replace(/\\N/g, '\n');
      
      const trackLabel = `軌道 ${tk + 1}`;
      const timecode = typeof c.start === 'number' ? secToEncore(c.start, State.fps, State.dropFrame) : '??:??:??:??';
      const timeLabel = `[${timecode} 第 ${i + 1} 句]`;
      const prefix = `${trackLabel} ${timeLabel}`;

      // 1. 無時間碼 (包含長度 <= 0)
      if (typeof c.start !== 'number' || typeof c.end !== 'number' || c.end <= c.start) {
        errors.push(`${prefix}: 無效的時間碼 (開始 >= 結束或缺失)`);
        continue;
      }

      // 2. 時間碼重疊
      if (i > 0) {
        const prevC = cues[i - 1];
        // 考慮微小的浮點數誤差 (例如 0.01s)
        if (c.start < prevC.end - 0.01) {
           const currentStart = typeof c.start === 'number' ? secToEncore(c.start, State.fps, State.dropFrame) : '??:??:??:??';
           const prevEnd = typeof prevC.end === 'number' ? secToEncore(prevC.end, State.fps, State.dropFrame) : '??:??:??:??';
           errors.push(`${prefix}: 時間碼與前一句重疊 (本句開始 ${currentStart}, 前句結束 ${prevEnd})`);
        }
      }

      // 3. 行數過多
      const lines = plainText.split('\n');
      if (lines.length >= 3) {
        errors.push(`${prefix}: 字幕超過 3 行 (${lines.length} 行)`);
      }

      // 4. 字數過多 (純字元計算) - 若 wordLimit 存在且大於 0 才檢查
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

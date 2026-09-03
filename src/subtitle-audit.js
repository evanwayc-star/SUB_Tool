/* ==============================================================================
   SUB Tool — Subtitle Quality & Audit Engine (src/subtitle-audit.js)
   ==============================================================================
   深層字幕品質診斷與版本比對模組（Subtitle Audit Engine）。
   提供單次遍歷（Single-pass）的結構化診斷分析：
   1. 時間碼完整性與重疊碰撞檢測 (Timecode & Overlap Collision)
   2. 行數、字數長度與 CPS 字元速率檢查 (Line count, Length, CPS)
   3. 特殊標籤、字型樣式、空白與連續無縫相同句檢測 (Tags, Trimming, Duplicates)
   4. 繁體字支援性與簡體字檢測 (Character Encoding & Variant Check)
   5. 匯出防呆驗證 (Pre-export Validation)
   ============================================================================== */

import { State } from './state.js';
import { secToEncore, getExactFps } from './time.js';
import { inspectSubtitleCharacters } from './subtitle-text-check.js';

/**
 * 檢測字幕時間重疊集合
 */
export function detectOverlaps(cues, eps = 0.001) {
  const set = new Set();
  const sorted = cues.filter(c => c && c.timed !== false).slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start >= sorted[i].end - eps) break;
      set.add(sorted[i].id);
      set.add(sorted[j].id);
    }
  }
  return set;
}

/**
 * 對字幕清單進行單次遍歷的完整品質診斷分析。
 * 
 * @param {Array} cues - 待分析的字幕陣列
 * @param {Object} [options={}] - 分析選項
 * @param {number} [options.checkLenLimit=0] - 單行長度上限
 * @param {string[]} [options.checkContains=[]] - 包含關鍵字檢查清單
 * @param {number} [options.fps=25] - 影格率
 * @returns {Object} 結構化品質診斷報告
 */
export function auditSubtitles(cues = [], options = {}) {
  if (!Array.isArray(cues)) cues = [];
  const checkLenLimit = options.checkLenLimit || 0;
  const checkContains = options.checkContains || [];
  const exactFps = getExactFps(Number(options.fps || State?.fps) || 25);

  const overlapSet = detectOverlaps(cues);
  const result = {
    overlapNums: [],
    multiNums: [],
    twoNums: [],
    blankNums: [],
    bNums: [],
    iNums: [],
    uNums: [],
    fontNums: [],
    posNums: [],
    trimNums: [],
    overLenNums: [],
    containsNums: [],
    nonTraditionalIssues: [],
    noTimeNums: [],
    consecutiveIdenticalNums: [],
    consecutiveIdenticalJoinedNums: []
  };

  const consecutiveIdenticalSet = new Set();
  const consecutiveIdenticalJoinedSet = new Set();

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const num = i + 1;
    const t = c.text || '';
    const trimmed = t.trim();
    const lower = t.toLowerCase();

    if (c.timed === false) result.noTimeNums.push(num);
    if (overlapSet.has(c.id)) result.overlapNums.push(num);

    if (!trimmed) {
      result.blankNums.push(num);
    } else {
      const lineCnt = (t.match(/\n/g) || []).length;
      if (lineCnt >= 2) result.multiNums.push(num);
      else if (lineCnt === 1) result.twoNums.push(num);
    }

    if (i > 0) {
      const prevTrimmed = (cues[i - 1].text || '').trim();
      if (prevTrimmed && prevTrimmed === trimmed) {
        consecutiveIdenticalSet.add(i);
        consecutiveIdenticalSet.add(num);
        const prev = cues[i - 1];
        if (
          prev.timed !== false &&
          c.timed !== false &&
          Number.isFinite(prev.end) &&
          Number.isFinite(c.start) &&
          Math.round(prev.end * exactFps) === Math.round(c.start * exactFps)
        ) {
          consecutiveIdenticalJoinedSet.add(i);
          consecutiveIdenticalJoinedSet.add(num);
        }
      }
    }

    if (/<\/?b>/i.test(t)) result.bNums.push(num);
    if (/<\/?i>/i.test(t)) result.iNums.push(num);
    if (/<\/?u>/i.test(t)) result.uNums.push(num);
    if (/<\/?font/i.test(t)) result.fontNums.push(num);
    if (/\{\\an\d\}/i.test(t)) result.posNums.push(num);

    if (/^[ 　]+|[ 　]+$/m.test(t)) result.trimNums.push(num);

    if (checkLenLimit && trimmed && t.split(/\n/).some(ln => ln.length > checkLenLimit)) {
      result.overLenNums.push(num);
    }

    if (checkContains.length && checkContains.some(kw => lower.includes(kw.toLowerCase()))) {
      result.containsNums.push(num);
    }

    const issue = inspectSubtitleCharacters(t);
    if (issue.simplified.length || issue.unsupported.length) {
      result.nonTraditionalIssues.push({ num, ...issue });
    }
  }

  result.consecutiveIdenticalNums = Array.from(consecutiveIdenticalSet).sort((a, b) => a - b);
  result.consecutiveIdenticalJoinedNums = Array.from(consecutiveIdenticalJoinedSet).sort((a, b) => a - b);
  return result;
}

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

export const analyzeSubtitles = auditSubtitles;

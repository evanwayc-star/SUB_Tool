/* ==============================================================================
   SUB Tool — 字幕編輯與批次操作管線 ("src/subtitle-edit-pipeline.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：以純函式實作字幕分割 (Split)、文字交換 (Swap)、
   相鄰合併 (Merge) 與空白區間修剪 (Trim)，提供高槓桿、不可變的編輯運算。
   ============================================================================== */

/**
 * 在指定時間點將一條字幕分割為前後兩段。
 * 
 * @param {object} cue 目標字幕物件
 * @param {number} splitTime 分割時間點（秒）
 * @param {string} newIdSecondSegment 第二段字幕的新 ID
 * @param {string} [text1] 第一段文字（可選，若無則按原文字）
 * @param {string} [text2] 第二段文字（可選）
 * @returns {{first: object, second: object}|null} 分割後的兩條字幕
 */
export function splitCueAtTime(cue, splitTime, newIdSecondSegment, text1 = null, text2 = null) {
  if (!cue || typeof cue !== 'object') return null;
  const start = Number(cue.start) || 0;
  const end = Number(cue.end) || 0;
  const st = Number(splitTime) || 0;

  if (st <= start || st >= end) return null;

  const first = {
    ...cue,
    end: Number(st.toFixed(3)),
    text: text1 != null ? String(text1) : (cue.text || ''),
  };

  const second = {
    ...cue,
    id: String(newIdSecondSegment),
    start: Number(st.toFixed(3)),
    end,
    text: text2 != null ? String(text2) : '',
  };

  return { first, second };
}

/**
 * 將兩條相鄰字幕合併為一條（起點取第一條，終點取第二條）。
 * 
 * @param {object} cue1 第一條字幕
 * @param {object} cue2 第二條字幕
 * @param {string} [joinSeparator='\n'] 文字合併分隔符
 * @returns {object|null} 合併後的新字幕
 */
export function mergeTwoCues(cue1, cue2, joinSeparator = '\n') {
  if (!cue1 || !cue2) return null;
  const start = Math.min(Number(cue1.start) || 0, Number(cue2.start) || 0);
  const end = Math.max(Number(cue1.end) || 0, Number(cue2.end) || 0);
  const t1 = (cue1.text || '').trim();
  const t2 = (cue2.text || '').trim();
  const text = t1 && t2 ? `${t1}${joinSeparator}${t2}` : (t1 || t2);

  return {
    ...cue1,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    text,
  };
}

/**
 * 交換兩條字幕的文字內容。
 * 
 * @param {object} cue1 字幕 1
 * @param {object} cue2 字幕 2
 * @returns {{cue1: object, cue2: object}|null} 文字互換後的字幕複本
 */
export function swapCueTexts(cue1, cue2) {
  if (!cue1 || !cue2) return null;
  return {
    cue1: { ...cue1, text: cue2.text || '' },
    cue2: { ...cue2, text: cue1.text || '' },
  };
}

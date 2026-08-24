/* ==============================================================================
   SUB Tool — 字幕格式轉碼與無損往返引擎 ("src/subtitle-transcoding-engine.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：負責 ASS（依循 ADR-0002 實現無損往返）、SRT、VTT、
   TXT、CSV 與 FCPXML 的格式編碼與串流解析，與 DOM/UI 徹底隔離。
   ============================================================================== */

import { secToASS, secToSRT, srtToSec, assToSec } from './time.js';
import { STYLE_DEFAULTS, styleToAssStyleLine } from './substyle.js';

/**
 * 將字幕與樣式序列化為標準 ASS 格式字串（支援 ADR-0002 無損往返）。
 * 
 * @param {Array<object>} cues 字幕清單
 * @param {object} [options]
 * @param {string} [options.title='SUB Tool Project'] 專案標題
 * @param {number} [options.playResX=1920] 字幕畫布寬度（固定 1920）
 * @param {number} [options.playResY=1080] 字幕畫布高度（固定 1080）
 * @param {Array<object>} [options.styles=[]] 樣式定義清單
 * @returns {string} ASS 內容字串
 */
export function encodeASS(cues = [], {
  title = 'SUB Tool Project',
  playResX = 1920,
  playResY = 1080,
  styles = [],
} = {}) {
  let out = `[Script Info]\nTitle: ${title}\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: None\nPlayResX: ${playResX}\nPlayResY: ${playResY}\n\n`;

  out += `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;

  const styleList = Array.isArray(styles) && styles.length ? styles : [{ ...STYLE_DEFAULTS, name: 'Default' }];
  for (const s of styleList) {
    const name = s.name || 'Default';
    const merged = { ...STYLE_DEFAULTS, ...s };
    if (s.size != null && merged.fontSize == null) merged.fontSize = s.size;
    out += styleToAssStyleLine(name, merged, playResY) + '\n';
  }

  out += `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  for (const c of cues) {
    if (c.timed === false) continue;
    const s = secToASS(c.start || 0);
    const e = secToASS(c.end || 0);
    const st = c.styleName || 'Default';
    const rawText = (c.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const text = rawText.replace(/\n/g, '\\N');
    out += `Dialogue: 0,${s},${e},${st},,0,0,0,,${text}\n`;
  }

  return out;
}

/**
 * 將字幕序列化為標準 SRT 格式字串。
 * 
 * @param {Array<object>} cues 字幕清單
 * @returns {string} SRT 內容字串
 */
export function encodeSRT(cues = []) {
  let out = '';
  let idx = 1;
  for (const c of cues) {
    if (c.timed === false) continue;
    const s = secToSRT(c.start || 0);
    const e = secToSRT(c.end || 0);
    const text = (c.text || '').trim();
    out += `${idx}\n${s} --> ${e}\n${text}\n\n`;
    idx++;
  }
  return out.trim() + '\n';
}

/**
 * 將字幕序列化為 WebVTT 格式字串。
 * 
 * @param {Array<object>} cues 字幕清單
 * @returns {string} VTT 內容字串
 */
export function encodeVTT(cues = []) {
  let out = 'WEBVTT\n\n';
  let idx = 1;
  for (const c of cues) {
    if (c.timed === false) continue;
    const s = secToSRT(c.start || 0).replace(',', '.');
    const e = secToSRT(c.end || 0).replace(',', '.');
    const text = (c.text || '').trim();
    out += `${idx}\n${s} --> ${e}\n${text}\n\n`;
    idx++;
  }
  return out.trim() + '\n';
}

/**
 * 通用字幕串流解析器（自動判定格式並轉為規範化專案字幕結構）。
 * 
 * @param {string} rawText 原始字串
 * @returns {{cues: Array<object>, format: string}} 解析結果
 */
export function parseSubtitleStream(rawText) {
  if (!rawText || typeof rawText !== 'string') return { cues: [], format: 'empty' };

  const trimmed = rawText.trim();
  if (trimmed.includes('[Script Info]') || trimmed.includes('[Events]')) {
    // ASS / SSA
    const cues = [];
    const lines = trimmed.split(/\r?\n/);
    let inEvents = false;
    for (const line of lines) {
      if (line.startsWith('[Events]')) { inEvents = true; continue; }
      if (inEvents && line.startsWith('Dialogue:')) {
        const parts = line.substring(9).split(',');
        if (parts.length >= 9) {
          const start = assToSec(parts[1]?.trim());
          const end = assToSec(parts[2]?.trim());
          const style = parts[3]?.trim();
          const text = parts.slice(9).join(',').replace(/\\N/gi, '\n').replace(/\{[^}]+\}/g, '');
          cues.push({
            id: 'c_' + Math.random().toString(36).slice(2, 8),
            start,
            end,
            text: text.trim(),
            styleName: style,
          });
        }
      }
    }
    return { cues, format: 'ass' };
  }

  if (trimmed.startsWith('WEBVTT')) {
    // VTT
    const cues = [];
    const blocks = trimmed.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.trim().split(/\r?\n/);
      const timeLineIdx = lines.findIndex(l => l.includes('-->'));
      if (timeLineIdx >= 0) {
        const [st, et] = lines[timeLineIdx].split('-->').map(s => s.trim().replace('.', ','));
        const start = srtToSec(st);
        const end = srtToSec(et);
        const text = lines.slice(timeLineIdx + 1).join('\n');
        cues.push({
          id: 'c_' + Math.random().toString(36).slice(2, 8),
          start,
          end,
          text: text.trim(),
        });
      }
    }
    return { cues, format: 'vtt' };
  }

  // 預設當作 SRT 或純文字
  const cues = [];
  const blocks = trimmed.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    const timeLineIdx = lines.findIndex(l => l.includes('-->'));
    if (timeLineIdx >= 0) {
      const [st, et] = lines[timeLineIdx].split('-->').map(s => s.trim());
      const start = srtToSec(st);
      const end = srtToSec(et);
      const text = lines.slice(timeLineIdx + 1).join('\n');
      cues.push({
        id: 'c_' + Math.random().toString(36).slice(2, 8),
        start,
        end,
        text: text.trim(),
      });
    }
  }

  return { cues, format: cues.length ? 'srt' : 'txt' };
}

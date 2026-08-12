import {
  anchorPct,
  effStyle,
  styleToCss,
  subtitleBackgroundCssMetrics,
} from './substyle.js';

function trackOf(cue, tracks){
  const index = Number.isInteger(cue?.track) ? cue.track : 0;
  return Array.isArray(tracks) ? tracks[index] : null;
}

function cueKey(cue){
  return cue?.id == null ? null : String(cue.id);
}

/* 純版面規則：measureLineWidth 是唯一 adapter。瀏覽器只判斷最寬行；
   ASS renderer 以同一行交給 libass 自己決定實際寬度，避免跨引擎字寬漂移。
   交付只消費凍結後的行索引與垂直幾何，不反查 DOM／State。 */
export function planSubtitleBackgroundLayouts(cues, tracks, { measureLineWidth, vww = 1920, vwh = 1080 } = {}){
  if(typeof measureLineWidth !== 'function') return {};
  const layouts = {};
  for(const cue of Array.isArray(cues) ? cues : []){
    const key = cueKey(cue);
    if(key == null) continue;
    const st = effStyle(cue, trackOf(cue, tracks));
    if(!st.bgBox) continue;
    const lines = String(cue.text || '').replace(/\r/g, '').split('\n');
    const measured = lines.map(line => {
      const res = measureLineWidth(line.trim(), st);
      if (typeof res === 'number') return { width: Number.isFinite(res) ? Math.max(0, res) : 0, height: 0 };
      return { 
        width: Number.isFinite(res?.width) ? Math.max(0, res.width) : 0,
        height: Number.isFinite(res?.height) ? Math.max(0, res.height) : 0 
      };
    });
    
    const widths = measured.map(m => m.width);
    const heights = measured.map(m => m.height);
    const metrics = subtitleBackgroundCssMetrics(st, 1);
    const anchor = anchorPct(st);
    
    const x = Math.round((st.posX / 100) * vww);
    const y = Math.round((st.posY / 100) * vwh);
    const radius = metrics.fontSize * 0.25;
    
    let lineIndex, boxW, boxH, absoluteX, absoluteY, textLines, offsetY;
    
    if (st.vertical) {
      const contentWidth = Math.max(metrics.lineHeight, metrics.lineHeight * lines.length);
      lineIndex = heights.reduce((tallest, height, index) =>
        height > heights[tallest] ? index : tallest, 0);
      
      boxW = contentWidth + metrics.padX * 2;
      boxH = heights[lineIndex] + metrics.padY * 2;
      
      const left = st.align === 'left' ? x : st.align === 'right' ? x - contentWidth : x - contentWidth / 2;
      absoluteX = left - metrics.padX;
      
      const anchorY = anchor.y; // top 0, middle 50, bottom 100
      absoluteY = y - (heights[lineIndex] * anchorY / 100) - metrics.padY;
      offsetY = absoluteY - y;
      
      textLines = [];
    } else {
      lineIndex = widths.reduce((widest, width, index) =>
        width > widths[widest] ? index : widest, 0);
        
      const contentHeight = Math.max(metrics.lineHeight, metrics.lineHeight * lines.length);
      
      boxW = widths[lineIndex] + metrics.padX * 2;
      boxH = contentHeight + metrics.padY * 2;
      
      const anchorX = anchor.x; // left 0, center 50, right 100
      absoluteX = x - (widths[lineIndex] * anchorX / 100) - metrics.padX;
      
      offsetY = -(contentHeight * anchor.y / 100) - metrics.padY;
      absoluteY = y + offsetY;
      
      const hAlign = { left: 4, center: 5, right: 6 }[st.align || 'center'];
      textLines = lines.map((line, i) => {
        const cy = Math.round(absoluteY + metrics.padY + i * metrics.lineHeight + metrics.lineHeight / 2);
        return { x, cy, hAlign, line };
      });
    }

    layouts[key] = {
      lineIndex,
      width: widths[lineIndex],
      widths,
      height: boxH,
      offsetY,
      absoluteX,
      absoluteY,
      boxW,
      boxH,
      radius,
      textLines,
    };
  }
  return layouts;
}

const documentMeasurers = new WeakMap();

function measurerFor(documentRef){
  let entry = documentMeasurers.get(documentRef);
  if(entry) return entry;
  const cache = new Map();
  const root = documentRef.createElement('div');
  root.dataset.subtitleBackgroundMeasure = 'true';
  root.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:max-content;height:max-content;contain:layout style paint;';
  documentRef.body.appendChild(root);
  entry = (line, st) => {
    const key = JSON.stringify([
      line, st.font, st.fontSize, st.bold, st.italic, st.letterSpacing,
    ]);
    if(cache.has(key)) return cache.get(key);
    const span = documentRef.createElement('span');
    span.textContent = line;
    span.style.cssText = styleToCss({
      ...st,
      bgBox: false,
      outline: 0,
      shadow: 0,
      angle: 0,
    }, 1);
    // styleToCss 的非底色路徑會為拖曳框預留 ink overflow；文字寬度量測不可吃它。
    span.style.position = 'relative';
    span.style.display = 'inline-block';
    span.style.width = 'max-content';
    span.style.height = 'auto';
    span.style.padding = '0';
    span.style.margin = '0';
    span.style.whiteSpace = 'pre';
    span.style.transform = 'none';
    span.style.background = 'transparent';
    span.style.textShadow = 'none';
    span.style.webkitTextStroke = '0 transparent';
    root.appendChild(span);
    const rect = span.getBoundingClientRect();
    const result = { width: rect.width, height: rect.height };
    span.remove();
    const fontSpec = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${subtitleBackgroundCssMetrics(st, 1).fontSize}px "${st.font}"`;
    // 字型尚未載入時不要把 fallback 寬度永久快取；下一次 refresh 可取得真實字型。
    if(!documentRef.fonts?.check || documentRef.fonts.check(fontSpec)) cache.set(key, result);
    return result;
  };
  documentMeasurers.set(documentRef, entry);
  return entry;
}

export function measureSubtitleBackgroundLayouts(cues, tracks, { documentRef=globalThis.document, vww = 1920, vwh = 1080 } = {}){
  if(!documentRef?.body || typeof documentRef.createElement !== 'function') return {};
  return planSubtitleBackgroundLayouts(cues, tracks, {
    measureLineWidth: measurerFor(documentRef),
    vww,
    vwh
  });
}

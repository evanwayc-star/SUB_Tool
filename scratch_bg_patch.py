import re

with open('src/substyle.js', 'r', encoding='utf-8') as f:
    substyle_code = f.read()

# Replace box-decoration-break with display:inline-block
substyle_search = "`box-decoration-break:clone;-webkit-box-decoration-break:clone;`;"
substyle_replace = "`display:inline-block;text-align:inherit;`;"
substyle_code = substyle_code.replace(substyle_search, substyle_replace)

with open('src/substyle.js', 'w', encoding='utf-8') as f:
    f.write(substyle_code)


with open('src/subtitle-background-layout.js', 'r', encoding='utf-8') as f:
    bg_code = f.read()

# Update measurerFor to return {width, height}
measurer_search = """    root.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    const fontSpec = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${subtitleBackgroundCssMetrics(st, 1).fontSize}px "${st.font}"`;
    // 字型尚未載入時不要把 fallback 寬度永久快取；下一次 refresh 可取得真實字型。
    if(!documentRef.fonts?.check || documentRef.fonts.check(fontSpec)) cache.set(key, width);
    return width;"""

measurer_replace = """    root.appendChild(span);
    const rect = span.getBoundingClientRect();
    const result = { width: rect.width, height: rect.height };
    span.remove();
    const fontSpec = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${subtitleBackgroundCssMetrics(st, 1).fontSize}px "${st.font}"`;
    // 字型尚未載入時不要把 fallback 寬度永久快取；下一次 refresh 可取得真實字型。
    if(!documentRef.fonts?.check || documentRef.fonts.check(fontSpec)) cache.set(key, result);
    return result;"""

bg_code = bg_code.replace(measurer_search, measurer_replace)

# Update planSubtitleBackgroundLayouts
plan_search = """    // 直書目前由一列一個 Dialogue 排版；其背景幾何不是水平文字塊，維持既有路徑。
    if(!st.bgBox || st.vertical) continue;
    const lines = String(cue.text || '').replace(/\\r/g, '').split('\\n');
    const widths = lines.map(line => {
      const width = Number(measureLineWidth(line, st));
      return Number.isFinite(width) ? Math.max(0, width) : 0;
    });
    const lineIndex = widths.reduce((widest, width, index) =>
      width > widths[widest] ? index : widest, 0);
    const metrics = subtitleBackgroundCssMetrics(st, 1);
    const contentHeight = Math.max(metrics.lineHeight, metrics.lineHeight * lines.length);
    const anchor = anchorPct(st);
    
    const x = Math.round((st.posX / 100) * vww);
    const y = Math.round((st.posY / 100) * vwh);
    const radius = metrics.fontSize * 0.25;
    const fudge = (widths[lineIndex] * 0.05) + (metrics.fontSize * 0.5);
    const boxW = widths[lineIndex] + metrics.padX * 2 + fudge;
    const boxH = contentHeight + metrics.padY * 2;
    const offsetY = -(contentHeight * anchor.y / 100) - metrics.padY;
    
    const anchorX = st.align === 'left' ? 0 : st.align === 'right' ? 100 : 50;
    const absoluteX = x - (widths[lineIndex] * anchorX / 100) - metrics.padX - (fudge * anchorX / 100);
    const absoluteY = y + offsetY;
    
    const hAlign = { left: 4, center: 5, right: 6 }[st.align || 'center'];
    const textLines = lines.map((line, i) => {
      const cy = Math.round(absoluteY + metrics.padY + i * metrics.lineHeight + metrics.lineHeight / 2);
      return { x, cy, hAlign, line };
    });

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
    };"""

plan_replace = """    if(!st.bgBox) continue;
    const lines = String(cue.text || '').replace(/\\r/g, '').split('\\n');
    const measured = lines.map(line => {
      const res = measureLineWidth(line, st);
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
    };"""

bg_code = bg_code.replace(plan_search, plan_replace)

with open('src/subtitle-background-layout.js', 'w', encoding='utf-8') as f:
    f.write(bg_code)

print("Patch applied")

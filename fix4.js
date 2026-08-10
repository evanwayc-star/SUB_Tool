const fs = require('fs');
let code = fs.readFileSync('src/substyle.js', 'utf8');

const startIdx = code.indexOf('export function styleToCss');
const endIdx = code.indexOf('/* 常見色的中文名');

const newCode = `export function styleToCss(st, ratio){
  const r = ratio || 1;
  const bgMetrics = subtitleBackgroundCssMetrics(st, r);
  const fs = bgMetrics.fontSize;
  let css = \\\`font-size:\\\${fs}px;color:\\\${st.color};\\\`+
    \\\`font-family:'\\\${st.font}','Noto Sans TC','Source Han Sans TC',sans-serif;\\\`+
    \\\`font-weight:\\\${st.bold ? 700 : 400};font-style:\\\${st.italic ? 'italic' : 'normal'};\\\`+
    \\\`line-height:\\\${effectiveSubtitleLineSpacing(st)};\\\`;
  const letterSpacing = effectiveVerticalLetterSpacing(st);
  if(letterSpacing) css += \\\`letter-spacing:\\\${(letterSpacing * r).toFixed(1)}px;\\\`;
  if(st.vertical) css += \\\`writing-mode:vertical-lr;text-orientation:upright;\\\`;
  if(st.angle) css += \\\`transform:rotate(\\\${st.angle}deg);transform-origin:\\\${originOf(st)};\\\`;
  if(st.bgBox){
    const pad = bgMetrics.padY.toFixed(1);
    const padH = bgMetrics.padX.toFixed(1);
    css += \\\`background:\\\${hexToRgba(st.bgColor, st.bgAlpha)};padding:\\\${pad}px \\\${padH}px;margin:-\\\${pad}px -\\\${padH}px;border-radius:.25em;\\\`+
           \\\`box-decoration-break:clone;-webkit-box-decoration-break:clone;\\\`;
    if(st.shadow > 0){
      const d = (st.shadow * r).toFixed(1);
      css += \\\`box-shadow:\\\${d}px \\\${d}px 0px rgba(0,0,0,.85);\\\`;
    }
  } else {
    const over = (((st.outline || 0) * 2 * r) + ((st.shadow || 0) * r) + 12).toFixed(1);
    css += \\\`padding:\\\${over}px;margin:-\\\${over}px;\\\`;
  }
  if(st.outline > 0){
    css += \\\`-webkit-text-stroke:\\\${(st.outline * 2 * r).toFixed(1)}px \\\${st.outlineColor};paint-order:stroke fill;\\\`;
  }
  if(st.shadow > 0 && !st.bgBox){
    const d = (st.shadow * r).toFixed(1);
    css += \\\`text-shadow:\\\${d}px \\\${d}px \\\${(st.shadow * r * 0.6).toFixed(1)}px rgba(0,0,0,.85);\\\`;
  }
  return css;
}
`;

code = code.substring(0, startIdx) + newCode + code.substring(endIdx);
fs.writeFileSync('src/substyle.js', code);

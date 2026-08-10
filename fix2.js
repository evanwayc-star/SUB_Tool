const fs = require('fs');
let code = fs.readFileSync('src/substyle.js', 'utf8');

const replacement = `  if(st.bgBox){
    const pad = bgMetrics.padY.toFixed(1);
    const padH = bgMetrics.padX.toFixed(1);
    css += \\\`background:\\\${hexToRgba(st.bgColor, st.bgAlpha)};padding:\\\${pad}px \\\${padH}px;margin:-\\\${pad}px -\\\${padH}px;border-radius:.25em;\\\`+
           \\\`box-decoration-break:clone;-webkit-box-decoration-break:clone;\\\`;
    if(st.shadow > 0){
      const d = (st.shadow * r).toFixed(1);
      css += \\\`box-shadow:\\\${d}px \\\${d}px 0px rgba(0,0,0,.85);\\\`;
    }
  } else {`;

code = code.replace(/  if\(st\.bgBox\)\{\r?\n    \/\/[^\n]+\r?\n    const pad = bgMetrics\.padY\.toFixed\(1\);\r?\n    const padH = bgMetrics\.padX\.toFixed\(1\);\r?\n  \} else \{/, replacement);

const replacement2 = `
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

code = code.replace(/    if\(st\.shadow > 0\)\{\r?\n      const d = \(st\.shadow \* r\)\.toFixed\(1\);\r?\n      css \+= `text-shadow:\$\{d\}px \$\{d\}px \$\{\(st\.shadow \* r \* 0\.6\)\.toFixed\(1\)\}px rgba\(0,0,0,\.85\);`;\r?\n    \}\r?\n  \}\r?\n  return css;\r?\n\}/, 
`    if(st.shadow > 0){
      const d = (st.shadow * r).toFixed(1);
      css += \\\`text-shadow:\\\${d}px \\\${d}px \\\${(st.shadow * r * 0.6).toFixed(1)}px rgba(0,0,0,.85);\\\`;
    }
  }` + replacement2);

fs.writeFileSync('src/substyle.js', code);

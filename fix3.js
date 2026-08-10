const fs = require('fs');
let code = fs.readFileSync('src/substyle.js', 'utf8');

code = code.replace(/  if\(st\.outline > 0\)\{\r?\n    css \+= `-webkit-text-stroke:\$\{\(st\.outline \* 2 \* r\)\.toFixed\(1\)\}px \$\{st\.outlineColor\};paint-order:stroke fill;`;\r?\n  \}\r?\n  if\(st\.shadow > 0 && !st\.bgBox\)\{\r?\n    const d = \(st\.shadow \* r\)\.toFixed\(1\);\r?\n    css \+= \\`text-shadow:\\\$\{d\}px \\\$\{d\}px \\\$\{\(st\.shadow \* r \* 0\.6\)\.toFixed\(1\)\}px rgba\(0,0,0,\.85\);\\`;\r?\n  \}\r?\n  return css;\r?\n\}/g,
`  if(st.outline > 0){
    css += \\\`-webkit-text-stroke:\\\${(st.outline * 2 * r).toFixed(1)}px \\\${st.outlineColor};paint-order:stroke fill;\\\`;
  }
  if(st.shadow > 0 && !st.bgBox){
    const d = (st.shadow * r).toFixed(1);
    css += \\\`text-shadow:\\\${d}px \\\${d}px \\\${(st.shadow * r * 0.6).toFixed(1)}px rgba(0,0,0,.85);\\\`;
  }
  return css;
}`);

fs.writeFileSync('src/substyle.js', code);

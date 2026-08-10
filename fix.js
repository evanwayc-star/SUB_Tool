const fs = require('fs');
let code = fs.readFileSync('src/substyle.js', 'utf8');
code = code.replace(/    \}\r?\n  \} else \{/g, '  } else {');
fs.writeFileSync('src/substyle.js', code);

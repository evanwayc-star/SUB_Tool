const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const configPath = process.argv[2];
if (!configPath) throw new Error('缺少字幕量測設定檔');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      webSecurity: false,
    },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,<body></body>');
    const fontUrl = pathToFileURL(config.fontPath).href;
    const result = await win.webContents.executeJavaScript(`(async () => {
      const family = ${JSON.stringify(config.family)};
      const face = new FontFace(family, ${JSON.stringify(`url("${fontUrl}")`)});
      await face.load();
      document.fonts.add(face);
      await document.fonts.ready;
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;height:max-content;';
      document.body.appendChild(root);
      const widths = [];
      for (const line of ${JSON.stringify(config.lines)}) {
        const span = document.createElement('span');
        span.textContent = line;
        span.style.cssText = ${JSON.stringify(config.css)};
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
        widths.push(span.getBoundingClientRect().width);
        span.remove();
      }
      return {
        widths,
        fontLoaded: document.fonts.check(${JSON.stringify(config.fontSpec)}),
      };
    })()`);
    process.stdout.write(`SUBTITLE_MEASURE:${JSON.stringify(result)}\n`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => {
  process.stderr.write(String(error && error.stack || error));
  app.exit(1);
});

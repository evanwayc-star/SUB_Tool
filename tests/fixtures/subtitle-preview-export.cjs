const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 960, height: 540, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, webSecurity: false } });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    await win.webContents.executeJavaScript(`(async () => {
      const fonts = ${JSON.stringify(config.fonts.map(font => ({ ...font, url: pathToFileURL(font.file).href })))};
      window.subtool = { fontsList: async () => ({ fonts }), fileURL: async file => fonts.find(f => f.file === file).url };
      await import(${JSON.stringify(pathToFileURL(path.join(directory, 'bundle.js')).href)});
      await window.fixture.loadFonts();
      await document.fonts.ready;
    })()`);
    const results = [];
    for (const [index, sample] of config.samples.entries()) {
      win.setContentSize(sample.width, sample.height);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const sample = ${JSON.stringify(sample)}, F = window.fixture;
        const st = F.effStyle(sample.cue, sample.track), anchor = F.anchorPct(st);
        document.body.style.cssText = 'margin:0;background:#101010;overflow:hidden';
        const root = document.getElementById('subtitle');
        root.style.cssText = 'position:absolute;left:'+st.posX+'%;top:'+st.posY+'%;transform:translate('+(-anchor.x)+'%,'+(-anchor.y)+'%);text-align:'+st.align;
        const span = root.firstElementChild;
        span.style.cssText = F.styleToCss(st, sample.height / 1080);
        span.textContent = sample.cue.text;
        const snapshot = {cues:[sample.cue],tracks:[sample.track],fps:23.976,dropFrame:false};
        const file = F.prepareSubtitleFileExport(snapshot,{formats:['ass']}).files[0];
        const font = document.createElement('canvas').getContext('2d');
        font.font = '1000px "'+st.font+'"';
        const metrics = font.measureText('Hg國');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {content:file.content,fontLoaded:document.fonts.check('50px "'+st.font+'"'),
          metrics:{ascent:metrics.fontBoundingBoxAscent,descent:metrics.fontBoundingBoxDescent}};
      })()`);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: sample.width, height: sample.height });
      fs.writeFileSync(path.join(directory, `${index}-preview.png`), image.toPNG());
      results.push(result);
    }
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results));
  } finally { win.destroy(); app.quit(); }
}).catch(error => { process.stderr.write(String(error?.stack || error)); app.exit(1); });

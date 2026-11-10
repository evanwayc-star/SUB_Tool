const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
const markerBits = 6;
if (config.samples.length >= 2 ** markerBits) throw new Error('Preview frame marker supports at most 63 samples');

async function captureSample(win, sample, index) {
  const deadline = Date.now() + 2000;
  let observed;
  do {
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: sample.width, height: sample.height });
    const size = image.getSize(), bitmap = image.toBitmap();
    let capturedSample = -1;
    if (size.width === sample.width && size.height === sample.height && bitmap.length === sample.width * sample.height * 4) {
      capturedSample = 0;
      for (let bit = 0; bit < markerBits; bit++) {
        const offset = (2 * sample.width + bit * 4 + 2) * 4;
        const level = bitmap[offset];
        if ((level !== 12 && level !== 20) || bitmap[offset + 1] !== level || bitmap[offset + 2] !== level) {
          capturedSample = -1;
          break;
        }
        if (level === 20) capturedSample |= 1 << bit;
      }
      if (capturedSample === index + 1) return image;
    }
    observed = { size, bytes: bitmap.length, sample: capturedSample - 1 };
    win.webContents.invalidate();
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  } while (Date.now() < deadline);
  throw new Error('Preview frame '+index+' was not presented: '+JSON.stringify(observed));
}

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
      const [width, height] = win.getContentSize();
      if (width !== sample.width || height !== sample.height) throw new Error('Unexpected preview viewport size: '+width+'x'+height);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const sample = ${JSON.stringify(sample)}, F = window.fixture;
        const st = F.effStyle(sample.cue, sample.track), anchor = F.anchorPct(st);
        document.body.style.cssText = 'margin:0;background:#101010;overflow:hidden';
        const root = document.getElementById('subtitle');
        root.style.cssText = 'position:absolute;left:'+st.posX+'%;top:'+st.posY+'%;transform:translate('+(-anchor.x)+'%,'+(-anchor.y)+'%);text-align:'+st.align;
        const span = root.firstElementChild;
        span.style.cssText = F.styleToCss(st, sample.height / 1080);
        span.textContent = sample.cue.text;
        // A renderer rAF does not acknowledge compositor presentation. Update this
        // marker with the subtitle and verify it in the captured bitmap. Its 12/20
        // levels stay below both existing pixel-bound thresholds on background 16;
        // the top-left cells are outside every subtitle in this fixture matrix.
        let marker = document.getElementById('frame-marker');
        if (!marker) {
          marker = document.createElement('div');
          marker.id = 'frame-marker';
          marker.style.cssText = 'position:fixed;left:0;top:0;display:flex;z-index:2147483647';
          document.body.append(marker);
        }
        marker.replaceChildren(...Array.from({length:${markerBits}}, (_, bit) => {
          const cell = document.createElement('div');
          const level = (${index + 1} & (1 << bit)) ? 20 : 12;
          cell.style.cssText = 'width:4px;height:4px;background:rgb('+level+','+level+','+level+')';
          return cell;
        }));
        const snapshot = {cues:[sample.cue],tracks:[sample.track],fps:23.976,dropFrame:false};
        const file = F.prepareSubtitleFileExport(snapshot,{formats:['ass']}).files[0];
        const font = document.createElement('canvas').getContext('2d');
        font.font = '1000px "'+st.font+'"';
        const metrics = font.measureText('Hg國');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {content:file.content,fontLoaded:document.fonts.check('50px "'+st.font+'"'),
          metrics:{ascent:metrics.fontBoundingBoxAscent,descent:metrics.fontBoundingBoxDescent}};
      })()`);
      const image = await captureSample(win, sample, index);
      fs.writeFileSync(path.join(directory, `${index}-preview.png`), image.toPNG());
      results.push(result);
    }
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results));
  } finally { win.destroy(); app.quit(); }
}).catch(error => { process.stderr.write(String(error?.stack || error)); app.exit(1); });

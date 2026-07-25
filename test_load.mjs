import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="videoSub"></div>
  <div id="videoWrap"></div>
  <video id="video"></video>
  <div id="tlScroll"></div>
  <div id="tlLayer"></div>
  <div id="tlTracks"></div>
  <canvas id="rulerCanvas"></canvas>
  <div id="sublist"></div>
  <div id="imageLayer"></div>
  <div id="appVersion"></div>
</body></html>`, { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLVideoElement = dom.window.HTMLVideoElement;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.performance = dom.window.performance;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
global.PointerEvent = dom.window.PointerEvent;
global.MouseEvent = dom.window.MouseEvent;

import('./src/app.js').then(() => {
  console.log("App loaded successfully!");
}).catch(err => {
  console.error("Error loading app:", err);
});

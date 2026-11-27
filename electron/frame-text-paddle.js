'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PNG } = require('pngjs');

const DET_SIDE = 960, REC_HEIGHT = 48, MAX_REC_WIDTH = 1536;
const MAX_PIXELS = 16 * 1024 * 1024, MAX_LINES = 24;
const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
const REC_MODELS = new Map([
  ['cjk', {model:'recognizer', dictionary:'characters.json'}],
  ['korean', {model:'korean', dictionary:'korean-characters.json'}],
  ['english', {model:'english', dictionary:'english-characters.json'}],
]);

// PNG is RGBA. Composite alpha onto white before bilinear sampling so hidden
// RGB values in a transparent region cannot introduce characters.
function channel(data, offset, c) {
  const alpha = data[offset + 3];
  return alpha === 255 ? data[offset + c] : 255 + (data[offset + c] - 255) * alpha / 255;
}

function tensorInput(image, box, width, height, paddedWidth, detector) {
  const plane = paddedWidth * height, output = new Float32Array(3 * plane);
  const left = new Int32Array(width), right = new Int32Array(width), mix = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(box.w - 1, (x + 0.5) * box.w / width - 0.5));
    left[x] = 4 * (box.x + Math.floor(sx));
    right[x] = 4 * (box.x + Math.min(box.w - 1, Math.floor(sx) + 1));
    mix[x] = sx - Math.floor(sx);
  }
  const scale = detector ? DET_STD.map(s => 1 / (255 * s)) : [1/127.5,1/127.5,1/127.5];
  const bias = detector ? DET_MEAN.map((m,c) => -m / DET_STD[c]) : [-1,-1,-1];
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(box.h - 1, (y + 0.5) * box.h / height - 0.5));
    const y0 = Math.floor(sy), fy = sy - y0;
    const top = 4 * image.width * (box.y + y0);
    const bottom = 4 * image.width * (box.y + Math.min(box.h - 1, y0 + 1));
    for (let x = 0; x < width; x++) {
      const fx = mix[x], a = top + left[x], b = top + right[x], d = bottom + left[x], e = bottom + right[x];
      for (let c = 0; c < 3; c++) {
        const rgb = 2 - c, av = channel(image.data, a, rgb), dv = channel(image.data, d, rgb);
        const hi = av + fx * (channel(image.data, b, rgb) - av);
        const lo = dv + fx * (channel(image.data, e, rgb) - dv);
        output[c * plane + y * paddedWidth + x] = (hi + fy * (lo - hi)) * scale[c] + bias[c];
      }
    }
  }
  return output;
}

// The direct recognizer has no layout model. Only try it on subtitle-height
// strips with a single band of horizontal contrast; a confident reading of
// one row alone is insufficient evidence that the entire crop has one row.
function singleLineStrip(image) {
  const {width, height, data} = image;
  if (height > 144 || width < 3.5 * height || width > height * 32) return false;
  const stride = Math.max(1, Math.ceil(width / 480)), scores = new Float32Array(height);
  let peak = 0;
  for (let y = 0; y < height; y++) {
    for (let x = stride; x < width; x += stride) {
      const at = 4 * (y * width + x), prev = at - 4 * stride;
      let diff = 0;
      for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(channel(data, at, c) - channel(data, prev, c)));
      if (diff > 32) scores[y] += Math.min(diff, 160);
    }
    peak = Math.max(peak, scores[y]);
  }
  if (peak < 96) return false;
  const minBand = Math.max(3, Math.ceil(height * 0.09)), minGap = Math.max(2, Math.ceil(height * 0.045));
  let first = -1, last = -1, bands = 0;
  for (let y = 0; y <= height; y++) {
    if (y < height && scores[y] >= peak * 0.18) {
      if (first < 0) first = y;
      last = y;
    } else if (first >= 0 && (y === height || y - last >= minGap)) {
      if (last - first + 1 >= minBand) bands++;
      first = -1;
    }
  }
  return bands === 1;
}

function decodeCtc(output, labels) {
  const stride = output.dims.at(-1);
  if (stride !== labels.length) throw new Error('本機 OCR 字典與識別模型不相容');
  const {data} = output, text = [];
  let previous = -1, total = 0;
  for (let t = 0; t < data.length; t += stride) {
    let best = 0;
    for (let c = 1; c < stride; c++) if (data[t + c] > data[t + best]) best = c;
    if (best !== 0 && best !== previous) {
      text.push(labels[best]);
      total += data[t + best];
    }
    previous = best;
  }
  return {text:text.join('').trim(), confidence:text.length ? Math.max(0, Math.min(1, total / text.length)) : 0};
}

function detectorBoxes(output, image) {
  const [height, width] = output.dims.slice(-2), probability = output.data;
  const size = width * height;
  if (!size || size > DET_SIDE * DET_SIDE || probability.length !== size) return [];
  const foreground = Uint8Array.from(probability, p => p >= 0.3 ? 1 : 0), queue = new Int32Array(size);
  const boxes = [];
  for (let first = 0; first < size; first++) {
    if (!foreground[first]) continue;
    let count = 1, sum = 0, x0 = width, x1 = 0, y0 = height, y1 = 0;
    queue[0] = first; foreground[first] = 0;
    for (let head = 0; head < count; head++) {
      const i = queue[head], x = i % width, y = (i - x) / width;
      x0 = Math.min(x0,x); x1 = Math.max(x1,x); y0 = Math.min(y0,y); y1 = Math.max(y1,y);
      sum += probability[i];
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const neighbor = yy * width + xx;
          if (foreground[neighbor]) { foreground[neighbor] = 0; queue[count++] = neighbor; }
        }
      }
    }
    const bw = x1 + 1 - x0, bh = y1 + 1 - y0;
    if (Math.min(bw,bh) < 3 || count < 8 || sum / count < 0.6) continue;
    // DB's distance is area * unclip_ratio / perimeter. Scale the expanded
    // box back to the original PNG before handing it to the recognizer.
    const grow = count * 1.5 / (2 * (bw + bh));
    const x = Math.max(0, Math.floor((x0 - grow) * image.width / width));
    const y = Math.max(0, Math.floor((y0 - grow) * image.height / height));
    const right = Math.min(image.width, Math.ceil((x1 + 1 + grow) * image.width / width));
    const bottom = Math.min(image.height, Math.ceil((y1 + 1 + grow) * image.height / height));
    boxes.push({x,y,w:right-x,h:bottom-y});
    if (boxes.length > MAX_LINES * 8) return [];
  }
  return boxes;
}

function readingOrder(boxes) {
  const rows = [];
  for (const box of boxes.sort((a,b) => a.y - b.y || a.x - b.x)) {
    const mid = box.y + box.h/2;
    const row = rows.find(r => Math.abs(r.mid - mid) <= Math.min(box.h, r.height) * 0.45);
    if (row) row.boxes.push(box);
    else rows.push({mid, height:box.h, boxes:[box]});
  }
  const lines = [];
  for (const row of rows.sort((a,b) => a.mid - b.mid)) {
    let last;
    for (const box of row.boxes.sort((a,b) => a.x - b.x)) {
      if (last && box.x - last.x - last.w <= Math.min(box.h,last.h)) {
        const right = Math.max(last.x + last.w, box.x + box.w), bottom = Math.max(last.y + last.h, box.y + box.h);
        last.y = Math.min(last.y, box.y); last.w = right - last.x; last.h = bottom - last.y;
      } else { last = {...box}; lines.push(last); }
    }
  }
  return lines;
}

function createPaddleReader(paddleDir) {
  const sessions = new Map(), dictionaries = new Map();
  let ort;
  function session(model) {
    if (!ort) {
      ort = require('onnxruntime-web');
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
    }
    if (!sessions.has(model)) {
      sessions.set(model, fs.readFile(path.join(paddleDir, model + '.onnx'))
        .then(bytes => ort.InferenceSession.create(bytes, {executionProviders:['wasm'], logSeverityLevel:3}))
        .catch(error => { sessions.delete(model); throw error; }));
    }
    return sessions.get(model);
  }
  async function infer(model, data, w, h, consume) {
    const engine = await session(model), input = new ort.Tensor('float32', data, [1,3,h,w]);
    let outputs;
    try {
      outputs = await engine.run({[engine.inputNames[0]]:input});
      return consume(outputs[engine.outputNames[0]]);
    } finally {
      input.dispose();
      for (const tensor of Object.values(outputs || {})) tensor.dispose();
    }
  }
  async function recognize(image, rect, config) {
    if (!dictionaries.has(config.model)) {
      dictionaries.set(config.model, fs.readFile(path.join(paddleDir,config.dictionary), 'utf8')
        .then(raw => ['', ...JSON.parse(raw), ' ']).catch(error => { dictionaries.delete(config.model); throw error; }));
    }
    const labels = await dictionaries.get(config.model);
    const actual = Math.max(1, Math.min(MAX_REC_WIDTH, Math.ceil(REC_HEIGHT * rect.w / rect.h)));
    const w = Math.max(320, actual);
    const data = tensorInput(image, rect, actual, REC_HEIGHT, w, false);
    const line = await infer(config.model, data, w, REC_HEIGHT, out => decodeCtc(out, labels));
    return {...line,rect};
  }
  return {async read(buffer, mode = 'cjk') {
    const config = REC_MODELS.get(mode);
    if (!config) throw new Error('不支援的本機 OCR 辨識模式');
    if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw new Error('無效的本機 OCR 圖片');
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('本機 OCR 圖片尺寸超出限制');
    const image = PNG.sync.read(buffer), full = {x:0, y:0, w:width, h:height};
    if (singleLineStrip(image)) {
      const direct = await recognize(image, full, config);
      if (direct.text && direct.confidence >= 0.96) return [direct];
    }
    const scale = Math.min(2, DET_SIDE / Math.max(width,height));
    const w = Math.max(32, Math.round(width * scale / 32) * 32), h = Math.max(32, Math.round(height * scale / 32) * 32);
    const data = tensorInput(image, full, w, h, w, true);
    const boxes = await infer('detector', data, w, h, out => readingOrder(detectorBoxes(out,image)));
    if (boxes.length > MAX_LINES) return [];
    const rows = [], deadline = Date.now() + 10000;
    for (const rect of boxes) {
      if (Date.now() >= deadline) return [];
      const line = await recognize(image, rect, config);
      if (!line.text) return [];
      rows.push(line);
    }
    return rows;
  }};
}

module.exports = { createPaddleReader };

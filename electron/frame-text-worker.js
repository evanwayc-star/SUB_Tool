'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { parentPort, workerData } = require('node:worker_threads');

const dataRoot = workerData.resourcesDir || path.resolve(__dirname, '..', 'node_modules');
const scriptsDir = workerData.resourcesDir ? path.join(dataRoot, 'scripts') : path.join(__dirname, 'frame-ocr', 'scripts');
const languageModels = { HanT: ['chi_tra'], HanS: ['chi_sim'], Latin: ['eng', 'fra', 'spa', 'deu'], Japanese: ['jpn'],
  Hangul: ['kor'], Arabic: ['ara'], Devanagari: ['hin'], Cyrillic: ['rus'], Greek: ['ell'], Hebrew: ['heb'], Thai: ['tha'] };
const modelNames = ['eng', 'chi_tra', 'chi_sim', 'jpn', 'kor', 'rus', 'ara', 'hin', 'fra', 'spa', 'deu'];
const commonScripts = new Set(Object.keys(languageModels));
const scriptAliases = { Han: 'HanT', Korean: 'Hangul', Katakana: 'Japanese', Hiragana: 'Japanese' };
const cjk = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
let core, common, detector, selected, scriptNames;
let selectedKey = '';

function newApi(langs, mode) {
  const api = new core.TessBaseAPI();
  if (api.Init(null, langs.join('+'), mode) !== 0) {
    core.destroy(api);
    throw new Error('無法載入本機文字辨識模型');
  }
  return api;
}
function disposeApi(api) {
  api.End();
  core.destroy(api);
}
function loadApi(names, mode, scriptModels = false) {
  const files = [];
  try {
    for (const name of names) {
      const dir = scriptModels ? scriptsDir : path.join(dataRoot, '@tesseract.js-data', name, '4.0.0_best_int');
      const file = name + '.traineddata';
      core.FS.writeFile(file, gunzipSync(fs.readFileSync(path.join(dir, file + '.gz'))));
      files.push(file);
    }
    return newApi(names, mode);
  } finally {
    for (const file of files) core.FS.unlink(file);
  }
}

function setImage(api, rect) {
  if (api.SetImageFile(1, 0) !== 0) throw new Error('無法解碼目前影格的 PNG 圖片');
  if (rect) api.SetRectangle(rect.x, rect.y, rect.w, rect.h);
}
function recognize(api, psm, rect) {
  setImage(api, rect);
  api.SetPageSegMode(psm);
  const text = api.GetUTF8Text().trim().replace(cjk, '');
  const confidence = api.MeanTextConf();
  const words = text.match(/[\p{L}\p{M}]{2,}/gu) || [];
  // Models may assign similar visual confidence to unrelated alphabets.
  // Two dictionary words provide an independent signal for short captions.
  const dictionary = words.length >= 2 ? words.filter(word => api.IsValidWord(word)).length / words.length : 0;
  const lines = [];
  for (const row of api.GetTSVText(0).split('\n')) {
    const cells = row.split('\t');
    if (cells[0] === '4') lines.push({ x: +cells[6], y: +cells[7], w: +cells[8], h: +cells[9] });
  }
  return { text, confidence, score: confidence + 16 * dictionary, lines };
}
function readLayout(api, width, height, rect) {
  if (rect) return recognize(api, 7, rect);
  const sparse = recognize(api, 11);
  if (!sparse.text) return recognize(api, 6);
  const { lines } = sparse;
  const tallest = Math.max(0, ...lines.map(line => line.h));
  const span = Math.max(...lines.map(line => line.y + line.h)) - Math.min(...lines.map(line => line.y));
  // A dense Han glyph can be segmented as several overlapping rows.
  if (lines.length && (width > 4 * height || sparse.confidence < 80) && span <= 1.8 * tallest) {
    const single = recognize(api, 7);
    if (single.text && single.confidence > sparse.confidence) return single;
  }
  return sparse;
}
function detectScript(rect) {
  setImage(detector, rect);
  const result = new core.OSResults();
  try {
    if (!detector.DetectOS(result)) return null;
    const best = result.best_result;
    const raw = result.unicharset.get_script_from_script_id(best.script_id);
    const name = scriptAliases[raw] || raw;
    return scriptNames.includes(name) ? { name, confidence: best.sconfidence } : null;
  } finally { core.destroy(result); detector.Clear(); }
}
function matchScript(script, text) {
  const name = script.replace(/_vert$/, '');
  if (name === 'Japanese') return /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]/u.test(text);
  const property = ({ HanS: 'Han', HanT: 'Han', Fraktur: 'Latin', Vietnamese: 'Latin' })[name] || name;
  return new RegExp('\\p{Script=' + property + '}', 'u').test(text);
}
function readScriptGroup(names, width, height, languages, rect) {
  const api = loadApi(languages || names, 1, !languages);
  try {
    const result = readLayout(api, width, height, rect);
    return names.some(name => matchScript(name, result.text)) ? result : null;
  } finally {
    disposeApi(api);
  }
}
function selectTranscription(width, height, baseline, previous, rect) {
  const script = detectScript(rect);
  let best = baseline;
  if (!script && !best.text) return '';
  const tried = new Set();
  const compare = (names, languages) => {
    if (!languages) names.forEach(name => tried.add(name));
    const candidate = readScriptGroup(names, width, height, languages, rect);
    const agrees = candidate?.text.replace(/\s/g, '') === best.text.replace(/\s/g, '');
    const kana = names[0] === 'Japanese' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(best.text);
    if (candidate?.text && (!best.text || candidate.score > best.score ||
        (languages?.length === 1 && candidate.confidence >= best.confidence - 1 && (agrees || kana)))) {
      best = candidate;
      if (!languages && best.confidence >= 85) {
        const winning = names.find(name => !['Fraktur','Vietnamese'].includes(name) && matchScript(name, best.text));
        if (winning) previous.script = winning;
      }
    }
  };
  const testedLanguages = new Set();
  const compareLanguage = name => {
    if (!languageModels[name] || testedLanguages.has(name)) return;
    testedLanguages.add(name);
    compare([name], languageModels[name]);
  };
  if (previous.script && best.confidence < 83) compare([previous.script]);
  if (script && languageModels[script.name] && script.confidence >= 0.5 &&
      (script.name !== 'Latin' || best.confidence < 90)) compareLanguage(script.name);
  // Script-specific models preserve Thai cluster spacing and Korean word boundaries.
  for (const name of ['Thai', 'Hangul', 'Devanagari', 'HanT', 'Japanese']) {
    if (matchScript(name, best.text)) compareLanguage(name);
  }
  if (best.confidence < 83) {
    for (const name of Object.keys(languageModels)) {
      compareLanguage(name);
      if (best.confidence >= 90) break;
    }
  }
  if (script && !tried.has(script.name) && (!commonScripts.has(script.name) || best.confidence < 84 ||
      (script.confidence >= 1 && !matchScript(script.name, best.text) && !previous.script))) {
    const vertical = script.name + '_vert';
    compare(height > width && scriptNames.includes(vertical) ? [vertical, script.name] : [script.name]);
  }
  // Short crops can lack sufficient script evidence. Compare models in small
  // groups so only the currently evaluated group occupies additional memory.
  if (best.confidence < 83) {
    const remaining = scriptNames.filter(name => !tried.has(name) && !name.endsWith('_vert') && !commonScripts.has(name));
    for (let i = 0; i < remaining.length; i += 4) {
      compare(remaining.slice(i, i + 4));
      if (best.confidence >= 92) break;
    }
  }
  return best.text;
}
async function readTesseractFrame({ png, width, height, languages = [] }) {
  if (!core) {
    const load = require(path.join(dataRoot, 'tesseract.js-core', 'tesseract-core-simd.js'));
    core = await load({ printErr() {} });
  }
  const key = languages.join('+');
  if (selected && key !== selectedKey) {
    disposeApi(selected);
    selected = null;
  }
  core.FS.writeFile('/input', Buffer.from(png, 'base64'));
  try {
    if (languages.length) {
      if (common) {
        disposeApi(common);
        disposeApi(detector);
        common = detector = null;
      }
      selected ||= loadApi(languages, 1);
      selectedKey = key;
      return readLayout(selected, width, height).text;
    }
    if (!common) {
      scriptNames = fs.readdirSync(scriptsDir).filter(name => /^[A-Z][A-Za-z_]+\.traineddata\.gz$/.test(name))
        .map(file => file.split('.')[0]);
      common = loadApi(modelNames, 1);
      detector = loadApi(['osd'], 0);
      detector.SetVariable('min_characters_to_try', '6');
    }
    const baseline = readLayout(common, width, height);
    const previous = {};
    const rows = [];
    for (const box of baseline.lines.slice().sort((a, b) => a.y - b.y)) {
      const row = rows.at(-1);
      if (!row || row.y + row.h - box.y < Math.min(row.h, box.h) * 0.25) {
        rows.push({ ...box });
        continue;
      }
      const right = Math.max(row.x + row.w, box.x + box.w);
      row.x = Math.min(row.x, box.x);
      row.w = right - row.x;
      row.h = Math.max(row.h, box.y + box.h - row.y);
    }
    // Distinct rows can carry different scripts. Keep the coordinates in the
    // original image, pad letter ascenders, and never cut into the next row.
    if (rows.length >= 2 && rows.length <= 8) {
      const output = [];
      for (const [i, r] of rows.entries()) {
        const pad = Math.ceil(r.h / 4);
        const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad, i ? rows[i-1].y + rows[i-1].h : 0);
        const rect = { x, y, w: Math.min(width, r.x + r.w + pad) - x,
          h: Math.min(height, r.y + r.h + pad, rows[i+1]?.y ?? height) - y };
        output.push(selectTranscription(width, height, readLayout(common, width, height, rect), previous, rect));
      }
      return output.join('\n').trim();
    }
    return selectTranscription(width, height, baseline, previous);
  } finally {
    (selected || common)?.Clear();
    core.FS.unlink('/input');
  }
}

const paddleDir = workerData.resourcesDir ? path.join(dataRoot, 'paddle') : path.join(__dirname, 'frame-ocr', 'paddle');
const usePaddle = fs.existsSync(path.join(paddleDir, 'detector.onnx'));
const cjkLanguages = new Set(['chi_tra', 'chi_sim', 'jpn']);
const eastAsianScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hangul = /\p{Script=Hangul}/u;
let paddle;

async function readAutomatic(bytes, request) {
  const cjkRows = await paddle.read(bytes, 'cjk');
  const text = cjkRows.map(row => row.text).join('\n');
  if (eastAsianScript.test(text) && cjkRows.every(row => row.confidence >= 0.95)) return text;
  const broad = await readTesseractFrame(request);
  // Require independent script evidence before asking the Korean specialist.
  // A Korean-only recognizer cannot confirm French, Armenian, Han, etc.
  if (!hangul.test(broad) || [...broad].some(c => /\p{L}/u.test(c) && !/[\p{Script=Hangul}\p{Script=Latin}]/u.test(c))) return broad;
  const rows = await paddle.read(bytes, 'korean');
  if (!rows.length || rows.some(row => row.confidence < 0.95)) return broad;
  const korean = rows.map(row => row.text).join('\n');
  if ((korean.match(/\p{Script=Hangul}/gu) || []).length < 2) return broad;
  const compact = str => str.replace(/\s/gu, '').toLowerCase();
  const candidate = compact(korean);
  // A specialist can drop English words/numbers even at high confidence.
  const tokens = broad.match(/[\p{Script=Latin}\p{N}]+/gu) || [];
  return compact(broad) === candidate || tokens.some(token => !candidate.includes(compact(token))) ? broad : korean;
}

async function readFrame(request) {
  const { languages } = request;
  if (!usePaddle || languages.some(id => !cjkLanguages.has(id) && id !== 'kor' && id !== 'eng')) {
    return readTesseractFrame(request);
  }
  paddle ||= require('./frame-text-paddle').createPaddleReader(paddleDir);
  const bytes = Buffer.from(request.png, 'base64');
  if (!languages.length) return readAutomatic(bytes, request);
  const modes = [];
  if (languages.some(id => cjkLanguages.has(id))) modes.push('cjk');
  if (languages.includes('kor')) modes.push('korean');
  if (!modes.length) modes.push('english');

  // Both the Korean and CJK models include Latin letters. Compare the same
  // detected lines when both specialists were requested; a page may contain both.
  let rows = [];
  let multilingual;
  const combinedReading = () => multilingual ??= readTesseractFrame(request);
  for (const mode of modes) {
    const candidates = await paddle.read(bytes, mode);
    if (!candidates.length) continue;
    if (!rows.length) { rows = candidates; continue; }
    if (rows.length !== candidates.length) return combinedReading();
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i], b = candidates[i];
      const center = r => r.y + r.h / 2;
      if (Math.abs(center(a.rect) - center(b.rect)) > Math.max(a.rect.h, b.rect.h) / 2) return combinedReading();
      // A confident row from one alphabet can silently omit words in the other.
      // Keep a combined reading only when both scripts corroborate characters
      // in that same row. Never concatenate two incompatible transcriptions.
      if (Math.min(a.confidence, b.confidence) >= 0.85 && eastAsianScript.test(a.text) && hangul.test(b.text)) {
        const combined = (await combinedReading()).split(/\n+/).filter(Boolean);
        const line = combined[i];
        if (combined.length === rows.length && [...a.text].some(c => eastAsianScript.test(c) && line.includes(c)) &&
            [...b.text].some(c => hangul.test(c) && line.includes(c))) {
          rows[i] = {...a, text:line};
          continue;
        }
      }
      if (b.confidence > a.confidence) rows[i] = b;
    }
  }
  const text = rows.map(r => r.text).join('\n');
  return rows.length && rows.every(row => row.confidence >= 0.85) ? text : combinedReading();
}

parentPort.on('message', async request => {
  try { parentPort.postMessage({ id: request.id, text: await readFrame(request) }); }
  catch (error) { parentPort.postMessage({ id: request.id, error: '本機單格文字辨識失敗：' + error.message }); }
});

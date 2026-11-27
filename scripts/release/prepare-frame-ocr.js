'use strict';

// Download at development/packaging time. The installed OCR worker reads only
// local files. Source hashes cover the upstream bytes before gzip compression.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { gzip, gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const manifest = require('../../electron/frame-ocr/tessdata-fast.json');
const paddleModels = require('../../electron/frame-ocr/paddle-models.json');
const compress = promisify(gzip), decompress = promisify(gunzip);
const directory = path.resolve(__dirname, '../../electron/frame-ocr/scripts');

function verified(bytes, entry) {
  return bytes.length === entry.size && createHash('sha256').update(bytes).digest('hex') === entry.sha256;
}

async function atomicWrite(destination, bytes) {
  const staged = destination + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(staged, bytes, {flag:'wx'});
    await fs.rename(staged, destination);
  } finally {
    await fs.rm(staged, {force:true});
  }
}

async function prepareModel({destination, url, entry, compressed}, quick) {
  try {
    if (quick && (await fs.stat(destination)).size > 0) return;
    const existing = await fs.readFile(destination);
    const raw = compressed ? await decompress(existing, {maxOutputLength:entry.size}) : existing;
    if (verified(raw, entry)) return;
  } catch (error) {
    if (error.code !== 'ENOENT' && !error.code?.startsWith('Z_') && error.code !== 'ERR_BUFFER_TOO_LARGE') throw error;
  }
  const response = await fetch(url, {signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw Error(`下載 OCR 資源 ${url} 失敗（HTTP ${response.status}）`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (!verified(raw, entry)) throw Error(`OCR 資源 ${url} 的大小或 SHA-256 不符`);
  await atomicWrite(destination, compressed ? await compress(raw) : raw);
}

async function prepare(quick = false) {
  await fs.mkdir(directory, {recursive:true});
  const paddleDir = path.join(directory, '..', 'paddle');
  await fs.mkdir(paddleDir, {recursive:true});
  const assets = Object.entries(manifest.files).map(([source, entry]) => {
    const compressed = source.startsWith('script/');
    return {entry, compressed, destination:path.join(directory, compressed ? path.basename(source) + '.gz' : 'LICENSE.txt'),
      url:`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${manifest.revision}/${source}`};
  });
  for (const [filename, entry] of Object.entries(paddleModels)) {
    assets.push({entry, destination:path.join(paddleDir, filename),
      url:`https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`});
  }
  const pending = assets.values();
  await Promise.all(Array.from({length:3}, async () => {
    for (const asset of pending) await prepareModel(asset, quick);
  }));
  for (const [configName, dictionaryName] of [
    ['recognition.yml', 'characters.json'], ['korean.yml', 'korean-characters.json'], ['english.yml', 'english-characters.json'],
  ]) {
    const config = require('js-yaml').load(await fs.readFile(path.join(paddleDir, configName), 'utf8'));
    const dictionary = JSON.stringify(config.PostProcess.character_dict);
    const destination = path.join(paddleDir, dictionaryName);
    const existing = await fs.readFile(destination, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (existing !== dictionary) await atomicWrite(destination, dictionary);
  }
}

module.exports = () => prepare();
if (require.main === module) {
  prepare(process.argv.includes('--if-missing')).catch(error => { console.error(error.message); process.exitCode = 1; });
}

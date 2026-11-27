'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSettingsFile } = require('./settings-file');

const authHeaders = new Map([
  ['google', 'x-goog-api-key'], ['groq', 'Authorization'], ['openai', 'Authorization'],
  ['azure', 'Ocp-Apim-Subscription-Key'], ['elevenlabs', 'xi-api-key'],
]);

function destinationProvider(raw, method) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
  const { hostname, pathname, searchParams } = url;
  if (hostname === 'generativelanguage.googleapis.com') {
    if (method === 'GET' && /^\/v1(?:beta)?\/models$/.test(pathname) &&
        [...searchParams.keys()].every(key => key === 'pageToken')) return 'google';
    if (method === 'POST' && !url.search && (/^\/v1(?:beta)?\/models\/[a-z0-9.-]+:generateContent$/.test(pathname)
      || pathname === '/v1beta/interactions')) return 'google';
  }
  if (method !== 'POST') return null;
  if (/^[a-z0-9-]+\.api\.cognitive\.microsoft\.com$/.test(hostname) && pathname === '/speechtotext/transcriptions:transcribe' &&
      /^\?api-version=\d{4}-\d{2}-\d{2}$/.test(url.search)) return 'azure';
  if (url.search) return null;
  if (hostname === 'api.openai.com' && pathname === '/v1/audio/transcriptions') return 'openai';
  if (hostname === 'api.groq.com' && pathname === '/openai/v1/audio/transcriptions') return 'groq';
  if (hostname === 'api.elevenlabs.io' && pathname === '/v1/speech-to-text') return 'elevenlabs';
  return null;
}

function createSpeechCloud({ configDir, safeStorage, request = fetch }) {
  const file = createSettingsFile({filePath:() => path.join(configDir(), 'speech-credentials.json')});
  const active = new Map();
  const usable = async () => safeStorage.isAsyncEncryptionAvailable
    ? (await safeStorage.isAsyncEncryptionAvailable()) && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    : safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  const decrypt = async bytes => safeStorage.decryptStringAsync
    ? (await safeStorage.decryptStringAsync(bytes)).result : safeStorage.decryptString(bytes);
  async function status() {
    const keys = file.read();
    const ready = Object.fromEntries([...authHeaders.keys()].map(provider => [provider, false]));
    if (!Object.keys(ready).some(provider => typeof keys[provider] === 'string') || !(await usable())) return ready;
    for (const provider of authHeaders.keys()) {
      if (typeof keys[provider] !== 'string') continue;
      try { ready[provider] = !!(await decrypt(Buffer.from(keys[provider], 'base64'))); }
      catch { /* A key copied from another OS account needs to be entered again. */ }
    }
    return ready;
  }
  async function save(keys) {
    const changes = {};
    for (const [provider, value] of Object.entries(keys || {})) {
      if (!authHeaders.has(provider) || typeof value !== 'string' || !/^[!-~]{1,4096}$/.test(value)) throw new Error('無效的語音辨識金鑰');
      if (!(await usable())) throw new Error('系統加密尚未就緒，請重試儲存語音金鑰');
      const bytes = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value);
      if (await decrypt(bytes) !== value) throw new Error('無法驗證加密後的語音金鑰');
      changes[provider] = bytes.toString('base64');
    }
    if (Object.keys(changes).length) {
      fs.mkdirSync(configDir(), {recursive:true});
      file.update(current => ({...current, ...changes}));
    }
    return status();
  }
  async function send(sender, input) {
    const { id, url, method, contentType, body, provider } = input || {};
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
        typeof url !== 'string' || url.length > 12000 || !authHeaders.has(provider) || destinationProvider(url, method) !== provider ||
        (method === 'GET' ? body != null : !(body instanceof Uint8Array) || body.byteLength > 32 * 1024 * 1024 ||
          typeof contentType !== 'string' || !/^(application\/json|multipart\/form-data; boundary=[a-zA-Z0-9_-]{1,128})$/.test(contentType)))
      throw new Error('無效的語音服務請求');
    const job = sender.id + '/' + id;
    if (active.has(job) || sender.isDestroyed()) throw new Error('語音請求已失效');
    const controller = new AbortController();
    const stop = () => controller.abort();
    const onNavigation = (event, _url, inPlace, mainFrame) => {
      if ((event.isMainFrame ?? mainFrame) && !(event.isSameDocument ?? inPlace)) stop();
    };
    active.set(job, controller);
    sender.once('destroyed', stop);
    sender.once('render-process-gone', stop);
    sender.on('did-start-navigation', onNavigation);
    try {
      const stored = file.read()[provider];
      if (!stored || !(await usable())) throw new Error('請重新儲存語音辨識金鑰');
      const key = await decrypt(Buffer.from(stored, 'base64'));
      controller.signal.throwIfAborted();
      const headers = { [authHeaders.get(provider)]: ['groq', 'openai'].includes(provider) ? 'Bearer ' + key : key };
      if (method === 'POST') headers['Content-Type'] = contentType;
      const response = await request(url, {method, headers, body:body ?? undefined, credentials:'omit', redirect:'error', signal:controller.signal});
      const content = (await response.text()).split(key).join('[已隱藏金鑰]');
      controller.signal.throwIfAborted();
      return { status:response.status, text:content, retryAfter:response.headers.get('retry-after') };
    } finally {
      active.delete(job);
      sender.removeListener('destroyed', stop);
      sender.removeListener('render-process-gone', stop);
      sender.removeListener('did-start-navigation', onNavigation);
    }
  }
  return { status, save, send, cancel:(sender, id) => active.get(sender.id + '/' + id)?.abort() };
}
module.exports = { createSpeechCloud };

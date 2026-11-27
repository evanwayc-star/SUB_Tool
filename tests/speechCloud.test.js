import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSpeech, storedSpeechKey } from '../src/speech-cloud.js';

const require = createRequire(import.meta.url);
const { createSpeechCloud } = require('../electron/speech-cloud.js');
const destinations = {
  google: ['https://generativelanguage.googleapis.com/v1beta/interactions', 'x-goog-api-key'],
  openai: ['https://api.openai.com/v1/audio/transcriptions', 'Authorization'],
  groq: ['https://api.groq.com/openai/v1/audio/transcriptions', 'Authorization'],
  elevenlabs: ['https://api.elevenlabs.io/v1/speech-to-text', 'xi-api-key'],
  azure: [
    'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
    'Ocp-Apim-Subscription-Key'
  ]
};
const keyFor = provider => 'synthetic-fixture-' + provider;
const directories = [];

function storage() {
  const secret = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    async encryptStringAsync(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, iv);
      const payload = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]);
    },
    async decryptStringAsync(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') };
    }
  };
}

function owner(id) {
  return Object.assign(new EventEmitter(), { id, mainFrame: {}, isDestroyed: () => false });
}

function fixture(request = vi.fn(async () => new Response('ok'))) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtool-speech-cloud-'));
  directories.push(dir);
  const safeStorage = storage();
  const options = { configDir: () => dir, safeStorage, request };
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('unexpected network access');
    })
  );
  return { cloud: createSpeechCloud(options), dir, options, request, safeStorage };
}

// Use the actual preload and main registrations, with in-process test IPC.
function register(cloud, sender) {
  const main = fs.readFileSync('electron/main.js', 'utf8');
  const routesToTest = new Set([
    'speech:keys-status',
    'speech:keys-save',
    'speech:cloud-request',
    'speech:cloud-cancel'
  ]);
  const statements = parse(main, { ecmaVersion: 'latest', sourceType: 'script' }).body;
  const guard = statements.find(
    node => node.type === 'FunctionDeclaration' && node.id.name === 'speechCloudSender'
  );
  const registrations = statements.filter(node => {
    const call = node.expression;
    return (
      call?.callee?.object?.name === 'ipcMain' &&
      call.callee.property?.name === 'handle' &&
      routesToTest.has(call.arguments[0]?.value)
    );
  });
  expect(guard).toBeDefined();
  expect(registrations).toHaveLength(routesToTest.size);
  const routes = new Map();
  vm.runInNewContext([guard, ...registrations].map(node => main.slice(node.start, node.end)).join('\n'), {
    speechCloud: cloud,
    ipcMain: { handle: (name, fn) => routes.set(name, fn) },
    isMainWindowSender: event => event.sender === sender,
    _isAppQuitting: false
  });
  const event = { sender, senderFrame: sender.mainFrame };
  const invoke = vi.fn(async (channel, value) => routes.get(channel)(event, value));
  let api;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, value) => {
        api = value;
      }
    },
    ipcRenderer: { invoke, on() {}, send() {} },
    webUtils: {}
  };
  vm.runInNewContext(fs.readFileSync('electron/preload.js', 'utf8'), {
    require: () => electron,
    Uint8Array,
    ArrayBuffer,
    Promise,
    RangeError,
    TypeError
  });
  vi.stubGlobal('window', { subtool: api });
  return { api, invoke, routes, event };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) {
    const real = fs.realpathSync(dir);
    if (
      path.dirname(real) !== fs.realpathSync(tmpdir()) ||
      !path.basename(real).startsWith('subtool-speech-cloud-')
    )
      throw new Error('Temporary speech-test directory changed');
    fs.rmSync(real, { recursive: true, force: true });
  }
});

it('returns decryption status from another instance, preserves working keys on a failed save', async () => {
  const { cloud, dir, options, safeStorage } = fixture();
  expect(await cloud.save({ google: keyFor('google'), openai: keyFor('openai') })).toMatchObject({
    google: true,
    openai: true,
    groq: false
  });
  const stored = fs.readFileSync(path.join(dir, 'speech-credentials.json'), 'utf8');
  expect(stored).not.toContain('synthetic-fixture');
  expect(await createSpeechCloud(options).status()).toMatchObject({ google: true, openai: true });
  const differentAccount = createSpeechCloud({ ...options, safeStorage: storage() });
  expect(await differentAccount.status()).toMatchObject({ google: false, openai: false });
  safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
  await expect(cloud.save({ google: 'synthetic-change' })).rejects.toThrow('系統加密');
  expect(await cloud.status()).toMatchObject({ google: false, openai: false });
  expect(fs.readFileSync(path.join(dir, 'speech-credentials.json'), 'utf8')).toBe(stored);
});

it('routes renderer submissions through the owner IPC and supplies only the selected credential', async () => {
  const { cloud, request } = fixture();
  const sender = owner(17),
    { api, invoke, routes, event } = register(cloud, sender);
  const keys = Object.fromEntries(Object.keys(destinations).map(provider => [provider, keyFor(provider)]));
  await api.saveSpeechKeys(keys);
  expect(Object.values(await api.speechKeyStatus())).toEqual(Object.keys(keys).map(() => true));
  for (const [provider, [url, header]] of Object.entries(destinations)) {
    const form = new FormData();
    form.set('file', new Blob(['synthetic audio']), 'audio.wav');
    const headers = {
      [header]: header === 'Authorization' ? 'Bearer ' + storedSpeechKey(provider) : storedSpeechKey(provider)
    };
    request.mockImplementationOnce(async () => new Response('echo ' + keyFor(provider)));
    const response = await fetchSpeech(url, { method: 'POST', headers, body: form });
    expect(await response.text()).toBe('echo [已隱藏金鑰]');
    const envelope = invoke.mock.lastCall[1];
    expect(envelope.provider).toBe(provider);
    expect(envelope).not.toHaveProperty('headers');
    expect(JSON.stringify(envelope)).not.toContain('synthetic-fixture');
    const [destination, init] = request.mock.lastCall;
    expect(destination).toBe(url);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(init.headers).toEqual({
      [header]: header === 'Authorization' ? 'Bearer ' + keys[provider] : keys[provider],
      'Content-Type': expect.stringMatching(/^multipart\/form-data; boundary=/)
    });
    expect(new TextDecoder().decode(init.body)).toContain('synthetic audio');
  }
  const calls = request.mock.calls.length;
  expect(() => routes.get('speech:keys-status')({ ...event, senderFrame: {} }, {})).toThrow('此視窗');
  expect(() => routes.get('speech:keys-status')({ sender: owner(18), senderFrame: {} }, {})).toThrow(
    '此視窗'
  );
  await expect(
    api.speechCloudRequest({
      ...invoke.mock.calls.find(call => call[0] === 'speech:cloud-request')[1],
      provider: 'groq',
      url: destinations.azure[0]
    })
  ).rejects.toThrow('無效');
  expect(request).toHaveBeenCalledTimes(calls);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['cancel', 'destroyed', 'render-process-gone', 'navigation'])(
  'stops an in-flight request on %s and removes its lifecycle listeners',
  async reason => {
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    const { cloud } = fixture(
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            started(signal);
          })
      )
    );
    const sender = owner(7),
      { api } = register(cloud, sender);
    await api.saveSpeechKeys({ openai: keyFor('openai') });
    const controller = new AbortController();
    const pending = fetchSpeech(destinations.openai[0], {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + storedSpeechKey('openai'), 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal
    });
    const outcome = pending.then(
      () => null,
      error => error
    );
    const live = await ready;
    sender.emit('did-start-navigation', {}, 'about:blank', true, true);
    sender.emit('did-start-navigation', {}, 'about:blank', false, false);
    expect(live.aborted).toBe(false);
    if (reason === 'navigation')
      sender.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });
    else if (reason === 'cancel') controller.abort();
    else sender.emit(reason);
    expect((await outcome).name).toBe('AbortError');
    for (const name of ['destroyed', 'did-start-navigation', 'render-process-gone'])
      expect(sender.listenerCount(name)).toBe(0);
  }
);

it.each([
  [429, 'request rate reached', '0', 2],
  [429, 'insufficient_quota', '0', 1],
  [429, 'billing limit', '0', 1],
  [429, 'credits_exhausted', '0', 1],
  [429, 'temporarily busy', '1.5', 1],
  [429, 'temporarily busy', null, 1],
  [429, 'temporarily busy', '90', 1],
  [500, 'server error', '0', 1],
  [503, 'busy', '0', 1]
])('makes the permitted number of submissions for status %s, %s', async (status, text, retryAfter, count) => {
  const headers = retryAfter === null ? {} : { 'Retry-After': retryAfter };
  const transport = vi.fn(async () => new Response(text, { status, headers }));
  vi.stubGlobal('fetch', transport);
  const response = await fetchSpeech(destinations.google[0], {
    method: 'POST',
    headers: { 'x-goog-api-key': 'synthetic' },
    body: 'audio'
  });
  expect(response.status).toBe(status);
  expect(transport).toHaveBeenCalledTimes(count);
  expect(transport.mock.calls.every(([, init]) => init.body === 'audio')).toBe(true);
});

it('binds cancellation to the sender and discards a late body returned after navigation', async () => {
  let finishBody, started, signal;
  const startedReading = new Promise(resolve => {
    started = resolve;
  });
  const { cloud } = fixture(async (_url, init) => {
    signal = init.signal;
    return {
      status: 200,
      headers: new Headers(),
      text: () => {
        started();
        return new Promise(resolve => {
          finishBody = resolve;
        });
      }
    };
  });
  const sender = owner(21);
  await cloud.save({ google: keyFor('google') });
  const pending = cloud.send(sender, {
    id: 'same-id',
    provider: 'google',
    method: 'GET',
    url: 'https://generativelanguage.googleapis.com/v1beta/models'
  });
  const outcome = pending.catch(e => e);
  await startedReading;
  cloud.cancel(owner(22), 'same-id');
  expect(signal.aborted).toBe(false);
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  finishBody('late result');
  expect((await outcome).name).toBe('AbortError');
  expect(sender.listenerCount('did-start-navigation')).toBe(0);
});

it('does not resubmit an ambiguous network failure or a cancelled retry delay', async () => {
  const transport = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('network interrupted'))
    .mockResolvedValue(new Response('rate exceeded', { status: 429, headers: { 'Retry-After': '20' } }));
  vi.stubGlobal('fetch', transport);
  const init = { method: 'POST', headers: { 'x-goog-api-key': 'synthetic' }, body: 'audio' };
  await expect(fetchSpeech(destinations.google[0], init)).rejects.toThrow('network interrupted');
  const controller = new AbortController();
  const result = fetchSpeech(destinations.google[0], { ...init, signal: controller.signal }).catch(e => e);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  controller.abort();
  expect((await result).name).toBe('AbortError');
  expect(transport).toHaveBeenCalledTimes(2);
});

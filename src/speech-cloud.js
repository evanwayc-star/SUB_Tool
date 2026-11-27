const STORED_KEY = 'subtool-saved-credential-';
export const storedSpeechKey = provider => STORED_KEY + provider;

async function send(input, init) {
  const bridge = globalThis.window?.subtool;
  const credential = Object.values(init.headers || {}).find(value =>
    typeof value === 'string' && value.replace(/^Bearer /, '').startsWith(STORED_KEY));
  if (!credential) return fetch(input, init);
  if (!bridge?.speechCloudRequest) throw new Error('桌面語音金鑰無法使用，請重開辨識視窗');
  const provider = credential.replace(/^Bearer /, '').slice(STORED_KEY.length);
  const id = crypto.randomUUID();
  const signal = init.signal;
  signal?.throwIfAborted();
  const request = new Request(input, {method:init.method || 'GET', body:init.body,
    headers:init.headers['Content-Type'] ? {'Content-Type':init.headers['Content-Type']} : undefined});
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  signal?.throwIfAborted();
  const abort = () => { void bridge.cancelSpeechCloudRequest(id).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once:true});
  try {
    const result = await bridge.speechCloudRequest({id, url:request.url, method:request.method, provider,
      contentType:request.headers.get('content-type'), body});
    signal?.throwIfAborted();
    return new Response([204, 205, 304].includes(result.status) ? null : result.text, {status:result.status,
      headers:result.retryAfter ? {'Retry-After':result.retryAfter} : {}});
  } finally { signal?.removeEventListener('abort', abort); }
}

// Retry only a confirmed temporary rejection, never an ambiguous upload or an exhausted account.
export async function fetchSpeech(input, init) {
  const response = await send(input, init);
  const header = response.headers?.get?.('Retry-After');
  if (response.status !== 429 || !header || !response.clone) return response;
  const info = await response.clone().text();
  if (/quota|billing|spend.limit|insufficient.credit|credits?[\s_-]+(?:balance|exhausted|limit)|resource.exhausted.*daily/i.test(info)) return response;
  const delay = /^\d+$/.test(header) ? Number(header) * 1000 :
    /GMT$/i.test(header) ? Date.parse(header) - Date.now() : NaN;
  if (!Number.isFinite(delay) || delay > 30_000) return response;
  init.signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(init.signal.reason); };
    const timer = setTimeout(() => { init.signal?.removeEventListener('abort', stop); resolve(); }, Math.max(0, delay));
    init.signal?.addEventListener('abort', stop, {once:true});
  });
  init.signal?.throwIfAborted();
  return send(input, init);
}

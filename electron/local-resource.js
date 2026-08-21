'use strict';

/* Renderer 可讀的本機資源閘道。
   外部只看到不可猜、且不含磁碟路徑的 URL；路徑 identity、capability 重查、
   MIME、Range 與串流都留在這個 module，BrowserWindow 不必再關閉 webSecurity。 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { fileURLToPath } = require('url');

const LOCAL_RESOURCE_SCHEME = 'subtool-local';
const RESOURCE_HOST = 'resource';

const MIME_BY_EXTENSION = Object.freeze({
  '.aac': 'audio/aac',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.avi': 'video/x-msvideo',
  '.bmp': 'image/bmp',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mxf': 'application/mxf',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function registerLocalResourceScheme(protocolModule) {
  protocolModule.registerSchemesAsPrivileged([{
    scheme: LOCAL_RESOURCE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

function parseSingleRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { unsatisfiable: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return { unsatisfiable: true };
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function createLocalResourceServer({
  fileAuthority,
  protocolModule,
  sessionModule,
  fsModule = fs,
  pathModule = path,
  randomBytes = crypto.randomBytes,
  ResponseClass = globalThis.Response,
} = {}) {
  if (!fileAuthority || !protocolModule || !sessionModule || typeof ResponseClass !== 'function') {
    throw new TypeError('local resource server requires FileAuthority, protocol, session and Response');
  }

  const tokenToFile = new Map();
  const fileToToken = new Map();
  const internalDocuments = new Set();
  let installed = false;
  const caseInsensitivePaths = pathModule === path.win32 ||
    (pathModule === path && process.platform === 'win32');

  const canonicalPath = file => {
    if (typeof file !== 'string' || !file) return null;
    try {
      const resolved = pathModule.resolve(file);
      return caseInsensitivePaths ? resolved.toLowerCase() : resolved;
    } catch (error) { return null; }
  };

  const responseHeaders = (file, length) => ({
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': String(length),
    'Content-Type': MIME_BY_EXTENSION[pathModule.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });

  const denied = () => new ResponseClass(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'Content-Length': '0' },
  });

  async function handle(request) {
    let parsed;
    try { parsed = new URL(request.url); } catch (error) { return denied(); }
    const token = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    if (parsed.protocol !== `${LOCAL_RESOURCE_SCHEME}:` || parsed.hostname !== RESOURCE_HOST ||
        !/^[a-f0-9]{48}$/.test(token) || parsed.search || parsed.hash) return denied();

    const entry = tokenToFile.get(token);
    // URL 只證明 renderer 曾拿到 token；每一次實際讀取仍重新詢問唯一的 FileAuthority。
    if (!entry || !fileAuthority.canExposeFileURL(entry.file)) return denied();

    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      return new ResponseClass(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return new ResponseClass(null, {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS', 'Content-Length': '0' },
      });
    }

    let stat;
    try { stat = await fsModule.promises.stat(entry.file); } catch (error) { return denied(); }
    if (!stat.isFile()) return denied();

    const range = parseSingleRange(request.headers.get('range'), stat.size);
    if (range?.unsatisfiable) {
      return new ResponseClass(null, {
        status: 416,
        headers: {
          ...responseHeaders(entry.file, 0),
          'Content-Range': `bytes */${stat.size}`,
        },
      });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;
    const headers = responseHeaders(entry.file, length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    if (method === 'HEAD' || stat.size === 0) {
      return new ResponseClass(null, { status: range ? 206 : 200, headers });
    }

    const stream = fsModule.createReadStream(entry.file, { start, end });
    return new ResponseClass(Readable.toWeb(stream), {
      status: range ? 206 : 200,
      headers,
    });
  }

  return Object.freeze({
    install() {
      if (installed) return;
      protocolModule.handle(LOCAL_RESOURCE_SCHEME, handle);
      // file: 主頁本身在 Chromium 中仍可讀其他 file: URL，即使 webSecurity=true。
      // 只准主行程宣告的固定 HTML 以 main-frame 載入；所有 fetch/media/sub-frame
      // literal file: 請求一律取消，renderer 因此只能走上面的 capability protocol。
      sessionModule.defaultSession.webRequest.onBeforeRequest(
        { urls: ['file://*/*'] },
        (details, callback) => {
          let key = null;
          try { key = canonicalPath(fileURLToPath(details.url)); } catch (error) {}
          callback({ cancel: details.resourceType !== 'mainFrame' || !key || !internalDocuments.has(key) });
        },
      );
      installed = true;
    },

    allowInternalDocument(file) {
      const key = canonicalPath(file);
      if (!key) throw new TypeError('internal document path must be valid');
      internalDocuments.add(key);
    },

    loadApplicationDocument(window, builtDocument) {
      if (!window?.loadFile || !window?.loadURL) {
        return Promise.reject(new TypeError('application window loader is required'));
      }
      if (fsModule.existsSync?.(builtDocument)) {
        const key = canonicalPath(builtDocument);
        if (!key) return Promise.reject(new TypeError('application document path must be valid'));
        internalDocuments.add(key);
        return Promise.resolve(window.loadFile(builtDocument));
      }
      const html = `<!doctype html><meta charset="utf-8"><title>SUB Tool 尚未建置</title>
<body style="margin:0;background:#1b1b1d;color:#eee;font:16px/1.6 system-ui;display:grid;place-items:center;min-height:100vh">
<main><h1>找不到 production build</h1><p>請在專案目錄執行 <code>npm run build</code>，再重新啟動 SUB Tool。</p></main></body>`;
      return Promise.resolve(window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`));
    },

    urlFor(file) {
      if (!fileAuthority.canExposeFileURL(file)) return null;
      const key = canonicalPath(file);
      if (!key) return null;
      let token = fileToToken.get(key);
      if (!token) {
        do { token = randomBytes(24).toString('hex'); } while (tokenToFile.has(token));
        fileToToken.set(key, token);
        tokenToFile.set(token, { file: pathModule.resolve(file) });
      }
      return `${LOCAL_RESOURCE_SCHEME}://${RESOURCE_HOST}/${token}`;
    },
  });
}

module.exports = {
  LOCAL_RESOURCE_SCHEME,
  createLocalResourceServer,
  registerLocalResourceScheme,
};

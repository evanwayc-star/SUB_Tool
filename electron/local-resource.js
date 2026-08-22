/* ==============================================================================
   SUB Tool — 本機媒體資源自訂協定伺服器 (Local Resource Protocol Gateway)
   ==============================================================================
   【架構與職責】
   提供渲染端（Renderer）透過安全 Capability Token 存取本機音視訊與圖檔資源。
   
   【安全鐵律】
   1. 外部只看到不可猜測的 48 位元 Hex Token，絕不將本機絕對磁碟路徑暴露在 DOM/URL 中。
   2. 每次 HTTP 請求（包含 Range 串流讀取）均即時透過 `FileAuthority` 重新校驗讀取權限。
   3. 支援 HTTP 206 Partial Content (Range: bytes=start-end) 串流，確保 Web 播放器能快速 Seek。
   4. BrowserWindow 毋須關閉 `webSecurity` 即可安全載入媒體。
   ============================================================================== */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { fileURLToPath } = require('url');

/** 本機媒體自訂協定名稱 */
const LOCAL_RESOURCE_SCHEME = 'subtool-local';

/** 本機媒體協定主機名稱 */
const RESOURCE_HOST = 'resource';

/** 副檔名與 Content-Type MIME 對應表 */
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

/**
 * 註冊特權協定（必須在 Electron app ready 事件前呼叫）。
 * @param {import('electron').Protocol} protocolModule Electron protocol 模組
 */
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

/**
 * 解析 HTTP Range 標頭（僅支援單一 byte range）。
 * 
 * @param {string|null} value Range 標頭字串（例如 `bytes=0-1023` 或 `bytes=100-`）
 * @param {number} size 檔案總位元組大小
 * @returns {{start?: number, end?: number, unsatisfiable?: boolean}|null} 解析結果
 */
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

/**
 * 建立本機媒體資源伺服器閘道。
 * 
 * @param {object} options
 * @param {import('./file-authority').FileAuthority} options.fileAuthority
 * @param {import('electron').Protocol} options.protocolModule
 * @param {import('electron').Session} options.sessionModule
 * @param {object} [options.fsModule=fs]
 * @param {object} [options.pathModule=path]
 * @param {Function} [options.randomBytes=crypto.randomBytes]
 * @param {typeof Response} [options.ResponseClass=globalThis.Response]
 */
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
    } catch (error) {
      return null;
    }
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

  /**
   * 處理 subtool-local:// 協定之 HTTP 請求。
   */
  async function handle(request) {
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch (error) {
      return denied();
    }

    const token = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    if (
      parsed.protocol !== `${LOCAL_RESOURCE_SCHEME}:` ||
      parsed.hostname !== RESOURCE_HOST ||
      !/^[a-f0-9]{48}$/.test(token) ||
      parsed.search ||
      parsed.hash
    ) {
      return denied();
    }

    const entry = tokenToFile.get(token);
    // URL 只證明 renderer 曾拿到 token；每一次實際讀取仍重新向 FileAuthority 授權校驗
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
    try {
      stat = await fsModule.promises.stat(entry.file);
    } catch (error) {
      return denied();
    }
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
    /** 安裝自訂協定處理器與請求過濾器 */
    install() {
      if (installed) return;
      protocolModule.handle(LOCAL_RESOURCE_SCHEME, handle);
      sessionModule.defaultSession.webRequest.onBeforeRequest(
        { urls: ['file://*/*'] },
        (details, callback) => {
          let key = null;
          try {
            key = canonicalPath(fileURLToPath(details.url));
          } catch (error) {}
          callback({ cancel: details.resourceType !== 'mainFrame' || !key || !internalDocuments.has(key) });
        },
      );
      installed = true;
    },

    /** 登記允許載入的主程式內部 HTML 檔案 */
    allowInternalDocument(file) {
      const key = canonicalPath(file);
      if (!key) throw new TypeError('internal document path must be valid');
      internalDocuments.add(key);
    },

    /** 安全載入應用程式主視窗檔案 */
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

    /**
     * 為指定的本機檔案生成受控 capability URL。
     * @param {string} file 檔案絕對路徑
     * @returns {string|null} subtool-local:// 協定 URL
     */
    urlFor(file) {
      if (!fileAuthority.canExposeFileURL(file)) return null;
      const key = canonicalPath(file);
      if (!key) return null;
      let token = fileToToken.get(key);
      if (!token) {
        do {
          token = randomBytes(24).toString('hex');
        } while (tokenToFile.has(token));
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

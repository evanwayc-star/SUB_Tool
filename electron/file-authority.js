/* ==============================================================================
   SUB Tool — 檔案能力權威管理 (File Capability Authority)
   ==============================================================================
   【架構與職責】
   主行程中樞安全機制：管理檔案與目錄的各項能力（Read, Write, Delivery, Screenshot, Log）。
   
   【安全鐵律】
   1. 渲染端（Renderer）傳入的路徑永遠只是「未授權請求」，查詢 URL 或 stat 絕不能自動取得授權。
   2. 只有主程序透過原生系統對話框（Open/Save Dialog）、作業系統開啟事件或受管內部快取確認之來源，
      方可精確授予特定能力。
   3. 專案檔（.subtool）僅針對媒體與片段所明示的 path 授予讀取能力，嚴格禁止遞迴盲目掃描整個 JSON。
   ============================================================================== */
'use strict';

const path = require('path');

/** 專案檔副檔名正規表達式 */
const PROJECT_FILE = /\.(subtool|json)$/i;

/** 截圖影像副檔名正規表達式 */
const SCREENSHOT_FILE = /\.(jpg|jpeg|png)$/i;

/** 帶時碼截圖暫存檔名（受控固定檔名） */
const TEMP_SCREENSHOT_FILE = '.subtool_temp_shot.jpg';

/** 佇列執行記錄副檔名正規表達式 */
const QUEUE_LOG_FILE = /\.log$/i;

/**
 * 從專案資料物件中萃取明確宣告的外部媒體檔案路徑。
 * 
 * 安全限制：
 * 僅限 `project.media.path`、`project.clips[].path` 及 `project.externalAudioSources[].path`，
 * 避免字幕文字或備註中看似路徑的字串意外取得讀取權限。
 * 
 * @param {object} [project] 專案資料物件
 * @returns {string[]} 萃取之有效外部檔案路徑清單
 */
function collectProjectMediaPaths(project) {
  const paths = [];
  const seen = new Set();
  const add = value => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };

  add(project?.media?.path);

  const clips = Array.isArray(project?.clips) ? project.clips : [];
  for (const clip of clips) {
    add(clip?.path);
  }

  const audioSources = Array.isArray(project?.externalAudioSources) ? project.externalAudioSources : [];
  for (const source of audioSources) {
    add(source?.path);
  }

  return paths;
}

/**
 * 解析專案檔 Buffer，支援多種字元編碼（UTF-8, UTF-16LE, UTF-16BE 及含 BOM 格式）。
 * 
 * @param {Buffer} buffer 專案檔二進位內容
 * @returns {object|null} 解析後的 JSON 專案物件，若解析失敗或格式不符則回傳 null
 */
function parseProjectBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  let text;

  // UTF-16LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    text = buffer.subarray(2).toString('utf16le');
  } 
  // UTF-16BE BOM
  else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      const byte = body[i];
      body[i] = body[i + 1];
      body[i + 1] = byte;
    }
    text = body.toString('utf16le');
  } 
  // UTF-8 BOM
  else if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    text = buffer.subarray(3).toString('utf8');
  } 
  // 無 BOM 採樣啟發式偵測
  else {
    let zeroEven = 0;
    let zeroOdd = 0;
    const sampleLength = Math.min(buffer.length, 4000);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) {
        if (i % 2 === 0) zeroEven++;
        else zeroOdd++;
      }
    }

    if (zeroOdd > sampleLength * 0.15 && zeroOdd > zeroEven * 3) {
      text = buffer.toString('utf16le');
    } else if (zeroEven > sampleLength * 0.15 && zeroEven > zeroOdd * 3) {
      const body = Buffer.from(buffer);
      for (let i = 0; i + 1 < body.length; i += 2) {
        const byte = body[i];
        body[i] = body[i + 1];
        body[i + 1] = byte;
      }
      text = body.toString('utf16le');
    } else {
      text = buffer.toString('utf8');
    }
  }

  try {
    const project = JSON.parse(text);
    return project && typeof project === 'object' && !Array.isArray(project) ? project : null;
  } catch (error) {
    return null;
  }
}

/**
 * 從專案二進位 Buffer 中安全解析並萃取媒體路徑。
 * 
 * @param {Buffer} buffer 專案檔二進位資料
 * @returns {string[]} 媒體路徑清單
 */
function collectProjectMediaPathsFromBuffer(buffer) {
  const project = parseProjectBuffer(buffer);
  return project ? collectProjectMediaPaths(project) : [];
}

/**
 * 檔案能力權威管理器類別。
 */
class FileAuthority {
  /**
   * @param {object} [options]
   * @param {string[]} [options.internalDirectories=[]] 預設授權之內部系統目錄清單
   * @param {object} [options.pathModule=path] 注入之路徑模組（便於跨平台或單元測試）
   * @param {boolean} [options.caseInsensitive] 是否忽略路徑大小寫（Windows 預設為 true）
   */
  constructor({ internalDirectories = [], pathModule = path, caseInsensitive } = {}) {
    this._path = pathModule;
    this._caseInsensitive = caseInsensitive ?? (pathModule === path.win32 || process.platform === 'win32');
    this._readDirectories = new Set();
    this._writeDirectories = new Set();
    this._internalDirectories = new Set();
    this._readFiles = new Set();
    this._writeFiles = new Set();
    this._deliveryDirectories = new Set();
    this._deliveryFiles = new Set();
    this._screenshotDirectories = new Set();
    this._queueLogDirectories = new Set();

    for (const directory of internalDirectories) {
      this.grantInternalDirectory(directory);
    }
  }

  /**
   * 標準化絕對路徑字串並處理大小寫。
   * @private
   * @param {string} value 輸入路徑
   * @returns {string|null} 正規化後之路徑
   */
  _resolve(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const resolved = this._path.resolve(value);
      return this._caseInsensitive ? resolved.toLowerCase() : resolved;
    } catch (error) {
      return null;
    }
  }

  /**
   * 判斷 candidate 路徑是否在 root 目錄範圍之內。
   * @private
   */
  _isWithin(candidate, root) {
    if (candidate === root) return true;
    const separator = this._path.sep;
    return candidate.startsWith(root.endsWith(separator) ? root : root + separator);
  }

  /**
   * 檢查候選路徑是否命中目錄能力集合之一。
   * @private
   */
  _matchesDirectoryCapability(candidate, directories) {
    for (const root of directories) {
      if (this._isWithin(candidate, root)) return true;
    }
    return false;
  }

  /**
   * 授予目錄存取能力。
   * @private
   */
  _grantDirectory(value, { read = true, write = true } = {}) {
    const directory = this._resolve(value);
    if (!directory) return false;
    if (read) this._readDirectories.add(directory);
    if (write) this._writeDirectories.add(directory);
    return true;
  }

  /** 授予內部系統目錄讀寫能力。 */
  grantInternalDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._internalDirectories.add(resolved);
    return this._grantDirectory(directory);
  }

  /** 授予受管快取目錄讀寫能力。 */
  grantManagedCacheDirectory(directory) {
    return this.grantInternalDirectory(directory);
  }

  /** 授予信任目錄能力。 */
  grantTrustedDirectory(directory, options) {
    return this._grantDirectory(directory, options);
  }

  /** 授予單一受信任檔案的讀取或寫入能力。 */
  grantTrustedFile(file, { read = true, write = false } = {}) {
    const resolved = this._resolve(file);
    if (!resolved) return false;
    if (read) this._readFiles.add(resolved);
    if (write) this._writeFiles.add(resolved);
    return true;
  }

  /**
   * 授予專案檔能力：
   * 專案檔本身具備覆寫能力，並精確只允許其底下的 `.subtool_AutoSave` 子目錄寫入。
   * 專案父目錄同時授予截圖儲存能力。
   */
  grantProjectFile(file) {
    if (!this.grantTrustedFile(file, { read: true, write: true })) return false;
    const autosaveDirectory = this._path.join(this._path.dirname(file), '.subtool_AutoSave');
    this._grantDirectory(autosaveDirectory, { read: false, write: true });
    const parent = this._path.dirname(file);
    this.grantScreenshotDirectory(parent);
    return true;
  }

  /** 授予交付輸出目錄寫入能力。 */
  grantDeliveryDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._deliveryDirectories.add(resolved);
    return true;
  }

  /** 授予具體交付輸出檔案寫入能力。 */
  grantDeliveryFile(file) {
    const resolved = this._resolve(file);
    if (!resolved) return false;
    this._deliveryFiles.add(resolved);
    return true;
  }

  /** 授予截圖儲存目錄寫入能力。 */
  grantScreenshotDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._screenshotDirectories.add(resolved);
    return true;
  }

  /** 授予佇列失敗記錄 (.log) 開啟能力。 */
  grantQueueLogDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._queueLogDirectories.add(resolved);
    return true;
  }

  /** 授予受控暫存截圖檔之讀取能力。 */
  grantTemporaryScreenshotRead(file) {
    if (this._path.basename(file || '').toLowerCase() !== TEMP_SCREENSHOT_FILE) return false;
    if (!this.canWriteScreenshot(file)) return false;
    return this.grantTrustedFile(file, { read: true, write: false });
  }

  /** 檢查檔案是否具備讀取權限。 */
  canRead(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._readFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._readDirectories));
  }

  /** 檢查檔案是否具備寫入權限。 */
  canWrite(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._writeFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._writeDirectories));
  }

  /** 檢查檔案是否具備交付輸出寫入權限。 */
  canWriteDelivery(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._deliveryFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._deliveryDirectories));
  }

  /** 檢查檔案是否允許在檔案總管/Finder 定位顯示。 */
  canRevealDeliveryOutput(file) {
    const candidate = this._resolve(file);
    return !!candidate && this._deliveryFiles.has(candidate);
  }

  /** 檢查記錄檔是否允許使用系統 Shell 開啟。 */
  canOpenQueueLog(file) {
    const candidate = this._resolve(file);
    return !!candidate && QUEUE_LOG_FILE.test(file || '') &&
      this._matchesDirectoryCapability(candidate, this._queueLogDirectories);
  }

  /** 檢查目錄是否為授權之截圖目錄。 */
  canUseScreenshotDirectory(directory) {
    const candidate = this._resolve(directory);
    return !!candidate && this._screenshotDirectories.has(candidate);
  }

  /** 檢查檔案是否位於受管內部快取或工作目錄內。 */
  canManageInternalFile(file) {
    const candidate = this._resolve(file);
    return !!candidate && this._matchesDirectoryCapability(candidate, this._internalDirectories);
  }

  /** 檢查檔案是否允許生成 local-resource capability URL。 */
  canExposeFileURL(file) {
    return this.canRead(file);
  }

  /** 檢查檔案是否允許查詢 stat 檔案資訊。 */
  canStat(file) {
    return this.canRead(file);
  }

  /** 檢查目錄是否允許列出檔案內容。 */
  canListDirectory(directory) {
    const candidate = this._resolve(directory);
    return !!candidate && this._matchesDirectoryCapability(candidate, this._deliveryDirectories);
  }

  /** 檢查檔案是否允許寫入為專案檔 (.subtool / .json)。 */
  canWriteProject(file) {
    return PROJECT_FILE.test(file || '') && this.canWrite(file);
  }

  /** 檢查檔案是否允許寫入為截圖圖片。 */
  canWriteScreenshot(file) {
    const candidate = this._resolve(file);
    return !!candidate && SCREENSHOT_FILE.test(file || '') && (
      this.canWrite(file) || this._matchesDirectoryCapability(candidate, this._screenshotDirectories)
    );
  }
}

/**
 * 檢查指定的子路徑或檔名在解析後是否嚴格位於根目錄範圍之內（防範路徑穿越）。
 * 
 * @param {string} root 使用者選擇的輸出根目錄絕對路徑
 * @param {string} name 欲輸出的相對路徑或檔名
 * @returns {boolean} 若完整路徑落在 root 目錄內（或剛好為 root）則回傳 true，否則回傳 false
 */
function isPathContained(root, name) {
  if (typeof root !== 'string' || !root || typeof name !== 'string') {
    return false;
  }
  const r = path.resolve(root);
  const full = path.resolve(r, name);
  return full === r || full.startsWith(r + path.sep);
}

module.exports = {
  FileAuthority,
  PROJECT_FILE,
  SCREENSHOT_FILE,
  TEMP_SCREENSHOT_FILE,
  QUEUE_LOG_FILE,
  collectProjectMediaPaths,
  collectProjectMediaPathsFromBuffer,
  parseProjectBuffer,
  isPathContained,
};


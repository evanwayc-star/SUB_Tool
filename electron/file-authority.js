/* SUB Tool — 檔案能力權威
   renderer 傳入的路徑永遠只是「請求」，不能因為查詢 file URL／stat 就自動變成授權。
   只有主程序已確認的來源（原生對話框、作業系統開檔事件、內部快取）才可授予能力。 */
const path = require('path');

const PROJECT_FILE = /\.(subtool|json)$/i;
const SCREENSHOT_FILE = /\.(jpg|jpeg|png)$/i;
const TEMP_SCREENSHOT_FILE = '.subtool_temp_shot.jpg';
const QUEUE_LOG_FILE = /\.log$/i;

/* 專案檔能在桌面版重開的外部來源只有這三個明確欄位。
   不可遞迴掃描整份 JSON，否則字幕文字／備註裡看似路徑的字串也會意外取得能力。 */
function collectProjectMediaPaths(project) {
  const paths = [];
  const seen = new Set();
  const add = value => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };
  add(project?.media?.path);
  for (const clip of Array.isArray(project?.clips) ? project.clips : []) add(clip?.path);
  for (const source of Array.isArray(project?.externalAudioSources) ? project.externalAudioSources : []) add(source?.path);
  return paths;
}

function parseProjectBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) text = buffer.subarray(2).toString('utf16le');
  else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) { const byte = body[i]; body[i] = body[i + 1]; body[i + 1] = byte; }
    text = body.toString('utf16le');
  } else if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) text = buffer.subarray(3).toString('utf8');
  else {
    let zeroEven = 0, zeroOdd = 0;
    const sampleLength = Math.min(buffer.length, 4000);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) { if (i % 2 === 0) zeroEven++; else zeroOdd++; }
    }
    if (zeroOdd > sampleLength * 0.15 && zeroOdd > zeroEven * 3) text = buffer.toString('utf16le');
    else if (zeroEven > sampleLength * 0.15 && zeroEven > zeroOdd * 3) {
      const body = Buffer.from(buffer);
      for (let i = 0; i + 1 < body.length; i += 2) { const byte = body[i]; body[i] = body[i + 1]; body[i + 1] = byte; }
      text = body.toString('utf16le');
    } else text = buffer.toString('utf8');
  }
  try {
    const project = JSON.parse(text);
    return project && typeof project === 'object' && !Array.isArray(project) ? project : null;
  } catch (error) { return null; }
}

function collectProjectMediaPathsFromBuffer(buffer) {
  const project = parseProjectBuffer(buffer);
  return project ? collectProjectMediaPaths(project) : [];
}

class FileAuthority {
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
    for (const directory of internalDirectories) this.grantInternalDirectory(directory);
  }

  _resolve(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const resolved = this._path.resolve(value);
      return this._caseInsensitive ? resolved.toLowerCase() : resolved;
    } catch (error) {
      return null;
    }
  }

  _isWithin(candidate, root) {
    if (candidate === root) return true;
    const separator = this._path.sep;
    return candidate.startsWith(root.endsWith(separator) ? root : root + separator);
  }

  _matchesDirectoryCapability(candidate, directories) {
    for (const root of directories) {
      if (this._isWithin(candidate, root)) return true;
    }
    return false;
  }

  _grantDirectory(value, { read = true, write = true } = {}) {
    const directory = this._resolve(value);
    if (!directory) return false;
    if (read) this._readDirectories.add(directory);
    if (write) this._writeDirectories.add(directory);
    return true;
  }

  grantInternalDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._internalDirectories.add(resolved);
    return this._grantDirectory(directory);
  }

  grantManagedCacheDirectory(directory) {
    return this.grantInternalDirectory(directory);
  }

  grantTrustedDirectory(directory, options) {
    return this._grantDirectory(directory, options);
  }

  grantTrustedFile(file, { read = true, write = false } = {}) {
    const resolved = this._resolve(file);
    if (!resolved) return false;
    if (read) this._readFiles.add(resolved);
    if (write) this._writeFiles.add(resolved);
    return true;
  }

  /* 專案本身可以覆寫，同時只允許它自己的 autosave 子目錄寫入。
     不能把 project parent 變成一般 read/write directory：那會讓 renderer 用
     fs:fileURL/readB64 偷看同層檔案，或覆寫旁邊另一份 .subtool。 */
  grantProjectFile(file) {
    if (!this.grantTrustedFile(file, { read: true, write: true })) return false;
    const autosaveDirectory = this._path.join(this._path.dirname(file), '.subtool_AutoSave');
    this._grantDirectory(autosaveDirectory, { read: false, write: true });
    const parent = this._path.dirname(file);
    this.grantScreenshotDirectory(parent);
    return true;
  }

  /* 交付輸出與截圖是使用者在不同 native dialog 明示的寫入能力。
     它們刻意不復用一般 write directory，因此各 IPC 只能寫自己的副檔名類型。 */
  grantDeliveryDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._deliveryDirectories.add(resolved);
    return true;
  }

  grantDeliveryFile(file) {
    const resolved = this._resolve(file);
    if (!resolved) return false;
    this._deliveryFiles.add(resolved);
    return true;
  }

  grantScreenshotDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._screenshotDirectories.add(resolved);
    return true;
  }

  // 開啟失敗記錄是 shell 的另一條能力邊界。佇列目錄不應因此變成可由
  // renderer 任意讀取／開啟的 userData 根，只允許其中實際的 .log 記錄。
  grantQueueLogDirectory(directory) {
    const resolved = this._resolve(directory);
    if (!resolved) return false;
    this._queueLogDirectories.add(resolved);
    return true;
  }

  /* 帶時間碼的 mpv 截圖必須先由 mpv 寫入一個固定的暫存檔，再由 renderer
     讀回繪製文字。只把這個受控檔名升格成精確 read capability，絕不讓整個
     截圖目錄變成 read root。 */
  grantTemporaryScreenshotRead(file) {
    if (this._path.basename(file || '').toLowerCase() !== TEMP_SCREENSHOT_FILE) return false;
    if (!this.canWriteScreenshot(file)) return false;
    return this.grantTrustedFile(file, { read: true, write: false });
  }

  canRead(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._readFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._readDirectories));
  }

  canWrite(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._writeFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._writeDirectories));
  }

  canWriteDelivery(file) {
    const candidate = this._resolve(file);
    return !!candidate && (this._deliveryFiles.has(candidate) || this._matchesDirectoryCapability(candidate, this._deliveryDirectories));
  }

  canRevealDeliveryOutput(file) {
    const candidate = this._resolve(file);
    // 選擇輸出目錄只授予「寫入候選」；真正交付工作通過驗證後才會升格
    // 為精確輸出檔，避免 renderer 藉由 shell 打開同一資料夾內任意檔案。
    return !!candidate && this._deliveryFiles.has(candidate);
  }

  canOpenQueueLog(file) {
    const candidate = this._resolve(file);
    return !!candidate && QUEUE_LOG_FILE.test(file || '') &&
      this._matchesDirectoryCapability(candidate, this._queueLogDirectories);
  }

  canUseScreenshotDirectory(directory) {
    const candidate = this._resolve(directory);
    return !!candidate && this._screenshotDirectories.has(candidate);
  }

  canManageInternalFile(file) {
    const candidate = this._resolve(file);
    return !!candidate && this._matchesDirectoryCapability(candidate, this._internalDirectories);
  }

  canExposeFileURL(file) {
    return this.canRead(file);
  }

  canStat(file) {
    return this.canRead(file);
  }

  canListDirectory(directory) {
    const candidate = this._resolve(directory);
    return !!candidate && this._matchesDirectoryCapability(candidate, this._deliveryDirectories);
  }

  canWriteProject(file) {
    return PROJECT_FILE.test(file || '') && this.canWrite(file);
  }

  canWriteScreenshot(file) {
    const candidate = this._resolve(file);
    return !!candidate && SCREENSHOT_FILE.test(file || '') && (
      this.canWrite(file) || this._matchesDirectoryCapability(candidate, this._screenshotDirectories)
    );
  }
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
};

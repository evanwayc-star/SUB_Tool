'use strict';

/* ============================================================================
   SUB Tool — Windows mpv 原生宿主（electron/mpv-host.js）
   ============================================================================

   mpv 不是 renderer 裡的一個 <video>：它是一個 child process，透過 named pipe
   控制，並嵌在兩個透明 BrowserWindow（畫面宿主與 guide）之間。把這些生命週期
   狀態留在 main.js，會讓一般 IPC handler 不得不同時知道 process、socket、HWND、
   視窗層級、字幕暫存與水印重建的細節。

   本模組只管理那一個 Windows-native aggregate；main.js 保留授權檢查、IPC 通道與
   主視窗本身。所有 Electron／Node 副作用均由建構時注入，因此可用假 child、pipe、
   BrowserWindow 測 launch/replace/quit/guide lifecycle，不需要真的安裝 mpv。
============================================================================ */

const MPV_TIMECODE_RE = /^\d{1,6}:[0-5]\d:[0-5]\d[:;]\d{2,3}$/;

function createMpvHost(deps) {
  const {
    BrowserWindow, spawn, createConnection, fs, path, url,
    getMainWindow, supported, findExecutable, ensureTmp, tmpDir, tempFiles,
    guideHtml, fontsDir, onEvent, log = () => {},
    now = () => Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;

  let executable = null;
  let proc = null;
  let client = null;
  let requestId = 0;
  const callbacks = new Map();
  let buffer = '';
  let generation = 0;

  let hostWin = null;
  let guideWin = null;
  let rect = null;
  let appliedBounds = null;
  let visible = true;
  let guide = null;
  let imagesHtml = '';
  let timecodeWatermark = '';
  let timecodeWatermarkRect = null;
  let subFile = null;
  let subAdded = false;

  const alive = win => !!(win && !win.isDestroyed());
  const mainWindow = () => {
    const win = getMainWindow?.();
    return alive(win) ? win : null;
  };
  const sendEvent = event => { try { onEvent?.(event); } catch (error) {} };
  const safeDestroy = win => { try { if (alive(win)) win.destroy(); } catch (error) {} };
  const safeHide = win => { try { if (alive(win)) win.hide(); } catch (error) {} };

  function normaliseTimecodeRect(raw) {
    if (raw == null) return { ok: true, rect: null };
    if (!raw || typeof raw !== 'object') return { ok: false, rect: null };
    const x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), h = Number(raw.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { ok: false, rect: null };
    return {
      ok: true,
      rect: {
        x: Math.round(Math.max(-10000, Math.min(10000, x))),
        y: Math.round(Math.max(-10000, Math.min(10000, y))),
        w: Math.round(Math.max(1, Math.min(20000, w))),
        h: Math.round(Math.max(1, Math.min(20000, h))),
      },
    };
  }

  function normaliseTimecodeWatermark(raw) {
    if (raw == null || raw === '') return { ok: true, text: '', rect: null };
    const data = typeof raw === 'string' ? { text: raw } : raw;
    if (!data || typeof data !== 'object' || typeof data.text !== 'string') return { ok: false, text: '', rect: null };
    const text = data.text.trim();
    if (!text) return { ok: true, text: '', rect: null };
    const checkedRect = normaliseTimecodeRect(data.rect);
    if (!MPV_TIMECODE_RE.test(text) || !checkedRect.ok) return { ok: false, text: '', rect: null };
    return { ok: true, text, rect: checkedRect.rect };
  }

  function sameRect(a, b) {
    return a === b || !!(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
  }

  function guideHasVisibleContent() {
    return !!(guide || imagesHtml || timecodeWatermark);
  }

  function executeGuide(script) {
    if (!alive(guideWin)) return false;
    try {
      guideWin.webContents.executeJavaScript(script, true).catch(() => {});
      return true;
    } catch (error) { return false; }
  }

  function showGuide() {
    if (!visible || !guideHasVisibleContent() || !alive(guideWin)) return false;
    try { guideWin.showInactive(); guideWin.moveTop(); return true; } catch (error) { return false; }
  }

  function applyBounds(nextRect) {
    if (!alive(hostWin) || !nextRect) return false;
    rect = nextRect;
    const parent = mainWindow();
    if (!parent) return false;
    try {
      const content = parent.getContentBounds();
      const next = {
        x: Math.round(content.x + nextRect.x),
        y: Math.round(content.y + nextRect.y),
        width: Math.max(1, Math.round(nextRect.w)),
        height: Math.max(1, Math.round(nextRect.h)),
      };
      const same = appliedBounds && appliedBounds.x === next.x && appliedBounds.y === next.y
        && appliedBounds.width === next.width && appliedBounds.height === next.height;
      if (same) return true;
      appliedBounds = next;
      hostWin.setBounds(next);
      if (alive(guideWin)) guideWin.setBounds(next);
      return true;
    } catch (error) { return false; }
  }

  function clearCallbacks(value = null) {
    for (const { resolve, timer } of callbacks.values()) {
      try { clearTimer(timer); resolve(value); } catch (error) {}
    }
    callbacks.clear();
  }

  function detachClient({ destroy = true, emitDisconnected = false } = {}) {
    const current = client;
    client = null;
    buffer = '';
    clearCallbacks(null);
    if (destroy && current) { try { current.destroy(); } catch (error) {} }
    if (emitDisconnected) sendEvent({ event: 'disconnected' });
  }

  function destroyWindows() {
    safeDestroy(hostWin);
    safeDestroy(guideWin);
    hostWin = null;
    guideWin = null;
    rect = null;
    appliedBounds = null;
    visible = true;
    guide = null;
    imagesHtml = '';
    subFile = null;
    subAdded = false;
  }

  function stopProcess() {
    const current = proc;
    proc = null;
    if (current) { try { current.kill(); } catch (error) {} }
  }

  function quit() {
    generation++;
    detachClient();
    stopProcess();
    destroyWindows();
  }

  function detect() {
    if (!supported?.()) return null;
    if (executable) return executable;
    executable = findExecutable?.() || null;
    return executable;
  }

  function send(command, wantReply = false) {
    if (!client) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = ++requestId;
      if (wantReply) {
        const timer = setTimer(() => {
          const callback = callbacks.get(id);
          if (!callback) return;
          callbacks.delete(id);
          callback.resolve(null);
        }, 5000);
        callbacks.set(id, { resolve, timer });
      } else {
        resolve(null);
      }
      try {
        client.write(JSON.stringify(wantReply ? { command, request_id: id } : { command }) + '\n');
      } catch (error) {
        const callback = callbacks.get(id);
        if (callback) {
          callbacks.delete(id);
          clearTimer(callback.timer);
          callback.resolve(null);
        }
      }
    });
  }

  function attachClient(connected, token) {
    client = connected;
    buffer = '';
    connected.on('data', chunk => {
      if (connected !== client || token !== generation) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (typeof message.request_id === 'number' && callbacks.has(message.request_id)) {
            const callback = callbacks.get(message.request_id);
            callbacks.delete(message.request_id);
            clearTimer(callback.timer);
            callback.resolve(message.data ?? null);
          } else if (message.event === 'property-change' || message.event === 'end-file') {
            sendEvent(message);
          }
        } catch (error) {}
      }
    });
    connected.on('close', () => {
      if (connected !== client) return;
      detachClient({ destroy: false, emitDisconnected: true });
    });
  }

  function connectPipe(pipeName, token) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let settled = false;
      const pipePath = '\\\\.\\pipe\\' + pipeName;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const tryConnect = () => {
        if (settled) return;
        if (token !== generation) return fail(new Error('mpv 啟動已被新的媒體取代'));
        let next;
        try { next = createConnection(pipePath); } catch (error) { next = null; }
        if (!next) {
          if (attempts++ < 20) { setTimer(tryConnect, 300); return; }
          return fail(new Error('mpv pipe connect timeout'));
        }
        next.once('connect', () => {
          if (settled) return;
          if (token !== generation) {
            try { next.destroy(); } catch (error) {}
            return fail(new Error('mpv 啟動已被新的媒體取代'));
          }
          settled = true;
          attachClient(next, token);
          resolve(next);
        });
        next.once('error', () => {
          try { next.destroy(); } catch (error) {}
          if (settled) return;
          if (attempts++ < 20) { setTimer(tryConnect, 300); return; }
          fail(new Error('mpv pipe connect timeout'));
        });
      };
      tryConnect();
    });
  }

  function createHostWindows() {
    const parent = mainWindow();
    if (!parent) throw new Error('mpv：主視窗尚未初始化');
    hostWin = new BrowserWindow({
      parent, frame: false, show: true, transparent: true,
      hasShadow: false, skipTaskbar: true, thickFrame: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, acceptFirstMouse: false,
      webPreferences: { offscreen: false, backgroundThrottling: false },
    });
    try { hostWin.setIgnoreMouseEvents(true, { forward: true }); } catch (error) {}
    try { hostWin.setMenu(null); } catch (error) {}
    hostWin.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');

    guideWin = new BrowserWindow({
      parent, frame: false, show: false, transparent: true,
      hasShadow: false, skipTaskbar: true, thickFrame: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false,
      webPreferences: {
        offscreen: false, backgroundThrottling: false, webSecurity: false,
      },
    });
    /* guide 只有原生畫面上的視覺職責；所有 pointer 都穿透到主 renderer 的
       #imageLayer，避免兩條拖曳 state machine 競爭同一個 gesture。 */
    try { guideWin.setIgnoreMouseEvents(true, { forward: true }); } catch (error) {}
    try { guideWin.setMenu(null); } catch (error) {}
  }

  async function loadGuideDocument() {
    ensureTmp?.();
    const guidePath = path.join(tmpDir, 'mpv-guide.html');
    fs.writeFileSync(guidePath, guideHtml, 'utf8');
    await guideWin.loadURL(url.pathToFileURL(guidePath).href);
  }

  async function launch({ src, bounds, audio } = {}) {
    if (!supported?.()) throw new Error('目前 macOS 版不啟用 Windows 專用的 mpv 嵌入');
    if (typeof src !== 'string' || !src) throw new Error('mpv：來源路徑無效');
    quit();
    const token = ++generation;
    const exe = detect();
    if (!exe) throw new Error('找不到 mpv，請安裝 mpv 或設定 MPV_PATH 環境變數（https://mpv.io）');

    try {
      createHostWindows();
      await loadGuideDocument();
      visible = true;
      applyBounds(bounds);
      if (timecodeWatermark) {
        applyTimecodeWatermark();
        showGuide();
      }

      const handle = hostWin.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();
      const logPath = path.join(tmpDir, 'mpv-last.log');
      ensureTmp?.();
      let logStream = null;
      try { logStream = fs.createWriteStream(logPath); } catch (error) {}
      const pipeName = 'subtool-mpv-' + now();
      const args = [
        '--wid=' + hwnd,
        '--input-ipc-server=\\\\.\\pipe\\' + pipeName,
        '--no-config', '--no-terminal', '--no-osc',
        '--no-input-default-bindings', '--input-vo-keyboard=no', '--cursor-autohide=no',
        '--vo=gpu', '--gpu-context=d3d11', '--hwdec=auto',
        '--keep-open=always', '--pause', '--hr-seek=yes', '--sid=no',
      ];
      const fontDir = fontsDir?.();
      if (fontDir) args.push('--sub-fonts-dir=' + fontDir, '--embeddedfonts=no');
      if (Array.isArray(audio) && audio.length > 1) {
        const aids = [];
        for (let i = 0; i < audio.length; i++) aids.push(`[aid${i + 1}]`);
        args.push(`--lavfi-complex=${aids.join('')}amix=inputs=${audio.length}:normalize=0[ao]`);
      }
      args.push('--', src);
      const spawned = spawn(exe, args, { detached: false, stdio: ['ignore', 'ignore', logStream ? 'pipe' : 'ignore'] });
      proc = spawned;
      if (logStream && spawned.stderr) spawned.stderr.pipe(logStream);
      log('[mpv] launch wid=' + hwnd + ' bounds=' + JSON.stringify(rect) + ' src=' + src);
      spawned.on('error', error => log('[mpv] spawn error:', error && error.message));
      spawned.on('close', code => {
        if (proc !== spawned) return;
        log('[mpv] proc closed, code=' + code);
        proc = null;
        // child 自行崩潰／結束時，pipe 的 close 有時不會及時到；不能讓原生
        // host／guide 留在主視窗上方變成一塊透明卻攔截 z-order 的殼。
        generation++;
        detachClient({ emitDisconnected: true });
        destroyWindows();
      });
      await connectPipe(pipeName, token);
      if (token !== generation) throw new Error('mpv 啟動已被新的媒體取代');
      client.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
      client.write(JSON.stringify({ command: ['observe_property', 2, 'pause'] }) + '\n');
      client.write(JSON.stringify({ command: ['observe_property', 3, 'duration'] }) + '\n');
      await delay(400);
      const duration = await send(['get_property', 'duration'], true);
      return { ok: true, duration: typeof duration === 'number' ? duration : 0 };
    } catch (error) {
      if (token === generation) quit();
      throw error;
    }
  }

  function setVisible(nextVisible) {
    visible = !!nextVisible;
    if (!alive(hostWin)) return false;
    if (visible) {
      try { hostWin.show(); hostWin.moveTop(); } catch (error) {}
      if (rect) applyBounds(rect);
      showGuide();
    } else {
      safeHide(hostWin);
      safeHide(guideWin);
    }
    return true;
  }

  function reapplyBounds() {
    return !!(alive(hostWin) && visible && rect && applyBounds(rect));
  }

  function showForParentRestore() {
    if (!alive(hostWin) || !visible) return false;
    try { hostWin.show(); } catch (error) {}
    reapplyBounds();
    showGuide();
    return true;
  }

  function hideForParent() {
    safeHide(hostWin);
    safeHide(guideWin);
  }

  function setGuide(raw) {
    const values = raw && [raw.x, raw.y, raw.w, raw.h];
    if (!values || values.some(value => !Number.isFinite(value)) || raw.w <= 0 || raw.h <= 0) {
      guide = null;
      if (alive(guideWin)) {
        executeGuide('window.setGuide(null)');
        if (!guideHasVisibleContent()) safeHide(guideWin);
      }
      return false;
    }
    guide = { x: +raw.x, y: +raw.y, w: +raw.w, h: +raw.h };
    if (!alive(guideWin)) return true;
    executeGuide(`window.setGuide(${JSON.stringify(guide)})`);
    showGuide();
    return true;
  }

  function setImageGuide(data) {
    imagesHtml = (data && data.html) || (typeof data === 'string' ? data : '');
    const imageRect = data && data.rect;
    if (!alive(guideWin)) return true;
    executeGuide(`window.setImages(${JSON.stringify(imagesHtml)}, ${JSON.stringify(imageRect)})`);
    if (guideHasVisibleContent()) {
      showGuide();
    } else {
      safeHide(guideWin);
    }
    return true;
  }

  function applyTimecodeWatermark() {
    return executeGuide(`window.setTimecodeWatermark(${JSON.stringify(timecodeWatermark)}, ${JSON.stringify(timecodeWatermarkRect)})`);
  }

  function setTimecodeWatermark(raw) {
    const next = normaliseTimecodeWatermark(raw);
    if (!next.ok) return false;
    const changed = timecodeWatermark !== next.text || !sameRect(timecodeWatermarkRect, next.rect);
    timecodeWatermark = next.text;
    timecodeWatermarkRect = next.rect;
    if (!alive(guideWin)) return true;
    if (changed) applyTimecodeWatermark();
    if (timecodeWatermark) showGuide();
    else if (!guideHasVisibleContent()) safeHide(guideWin);
    return true;
  }

  function setSubtitles(assText) {
    if (!client) return null;
    try {
      if (!subFile) {
        ensureTmp?.();
        subFile = path.join(tmpDir, 'subtool-mpv-' + now() + '.ass');
        tempFiles?.add(subFile);
      }
      fs.writeFileSync(subFile, assText || '', 'utf8');
    } catch (error) { return null; }
    if (!subAdded) {
      subAdded = true;
      return send(['sub-add', subFile, 'select']);
    }
    return send(['sub-reload']);
  }

  async function loadFile(filePath) {
    if (!client) return null;
    subAdded = false;
    await send(['set_property', 'pause', true]);
    await send(['set_property', 'lavfi-complex', '']);
    log('[mpv] loadfile:', filePath);
    await send(['loadfile', filePath, 'replace'], true);
    for (let i = 0; i < 80; i++) {
      const duration = await send(['get_property', 'duration'], true);
      if (typeof duration === 'number' && duration > 0) return { ok: true, duration };
      await delay(100);
    }
    log('[mpv] loadfile: duration not ready after 8s:', filePath);
    return { ok: false, duration: 0 };
  }

  return {
    detect,
    launch,
    quit,
    dispose: quit,
    setBounds: applyBounds,
    setVisible,
    reapplyBounds,
    showForParentRestore,
    hideForParent,
    setGuide,
    setImageGuide,
    setTimecodeWatermark,
    clearTimecodeWatermark: () => setTimecodeWatermark(null),
    setSubtitles,
    setSubVisible: value => send(['set_property', 'sub-visibility', !!value]),
    loadFile,
    seek: time => send(['seek', time, 'absolute']),
    screenshot: filePath => send(['screenshot-to-file', filePath, 'subtitles']),
    play: () => send(['set_property', 'pause', false]),
    pause: () => send(['set_property', 'pause', true]),
    mute: value => send(['set_property', 'mute', value]),
    rate: value => send(['set_property', 'speed', value]),
    brightness: value => send(['set_property', 'brightness', Math.max(-100, Math.min(0, Math.round(value)))]),
    isPresent: () => alive(hostWin),
    snapshot: () => ({ visible, hasHostWindow: alive(hostWin), hasGuideWindow: alive(guideWin), hasClient: !!client, hasProcess: !!proc, rect }),
  };
}

module.exports = { createMpvHost };

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
const { StringDecoder } = require('node:string_decoder');
const { randomBytes } = require('node:crypto');
const { captureOutputDirectory, captureOutputAuthority, assertOutputAuthority } = require('./export-lease');
const { sourceClockTime, playerClockTime } = require('../shared/media-source-clock.cjs');

function createMpvTemporaryFiles(fs, path, tmpDir, ensureTmp, rootAuthority) {
  const records = new Set();
  let root = rootAuthority || null;
  function check(record, fd) {
    assertOutputAuthority(record.authority, record.file, fs);
    const entry = fs.lstatSync(record.file, { bigint: true });
    const opened = fd == null ? entry : fs.fstatSync(fd, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || !opened.isFile()
      || entry.dev !== record.dev || entry.ino !== record.ino
      || opened.dev !== record.dev || opened.ino !== record.ino) throw new Error('mpv 暫存檔身分已變更');
  }
  function create(extension) {
    ensureTmp?.();
    root ||= captureOutputDirectory(tmpDir, fs);
    const file = path.join(tmpDir, 'subtool-mpv-' + randomBytes(16).toString('hex') + '.' + extension);
    const authority = captureOutputAuthority(file, root, fs);
    const fd = fs.openSync(file, 'wx+');
    let record;
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      record = { file, authority, dev: stat.dev, ino: stat.ino, busy: false };
      records.add(record);
      check(record, fd);
    } finally { fs.closeSync(fd); }
    return record;
  }
  function write(record, content) {
    check(record);
    const fd = fs.openSync(record.file, 'r+');
    try { check(record, fd); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, content, 'utf8'); check(record, fd); }
    finally { fs.closeSync(fd); }
  }
  function stream(record) {
    check(record);
    const fd = fs.openSync(record.file, 'r+');
    try {
      check(record, fd);
      const result = fs.createWriteStream(record.file, { fd, autoClose: true });
      record.busy = true;
      result.once('close', () => { record.busy = false; });
      return result;
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  function remove(record) {
    if (!record || record.busy || !records.has(record)) return false;
    try { check(record); fs.unlinkSync(record.file); records.delete(record); return true; }
    catch (error) {
      if (error.code === 'ENOENT') { records.delete(record); return true; }
      return false;
    }
  }
  function cleanup() { for (const record of records) remove(record); return records.size === 0; }
  function owns(record) { try { check(record); return true; } catch (error) { return false; } }
  return { create, write, stream, remove, cleanup, owns };
}

function createMpvHost(deps) {
  const {
    BrowserWindow, spawn, createConnection, fs, path, url, allowInternalDocument,
    getMainWindow, supported, findExecutable, ensureTmp, tmpDir, tempRootAuthority,
    guideHtml, fontsDir, onEvent, describeSource, log = () => {},
    now = () => Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;
  const temporaryFiles = deps.temporaryFiles || createMpvTemporaryFiles(fs, path, tmpDir, ensureTmp, tempRootAuthority);

  let executable = null;
  let disposed = false;
  let resumeWhenIdle = false;
  let draining = 0;
  let proc = null;
  let processLog = null;
  let lastLogFile = null;
  let client = null;
  let requestId = 0;
  const callbacks = new Map();
  let pendingPresentation = null;
  let pendingFileLoad = null;
  let fileLoadSession = null;
  let fileLoadPhase = null;
  let nextSourceObserverId = 10;
  const sourceObserverSessions = new Set();
  // mpv 由 --pause 啟動。暫停中的 seek 會更新 time-pos／畫格，卻不保證在
  // unpause 前送 playback-restart；播放中的 seek 則仍要等 restart 才能視為呈現完成。
  let playerPaused = true;
  let playbackCommandGeneration = 0;
  let directionGeneration = 0;
  let sourceAudioGraph = '';
  let buffer = '';
  let generation = 0;
  let sourceClock = null;
  const playerTime = time => Math.max(0, playerClockTime(time, sourceClock));
  const sourceTime = time => sourceClockTime(time, sourceClock);
  const sourceDuration = time => Math.max(0, sourceTime(time)) || 0;
  // ffprobe already reports duration from video source zero; unlike mpv's
  // player-clock duration it must not be converted through sourceClock again.
  const readySourceDuration = (duration, info) => {
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      const observed = sourceDuration(duration);
      if (Number.isFinite(observed) && observed > 0) return observed;
    }
    return typeof info?.duration === 'number' && Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 0;
  };

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
  let subOwner = null;
  let guideOwner = null;
  let subAdded = false;
  const liveChildren = new Set();
  const liveLogs = new Set();
  const retiredFiles = new Set();

  function resumeIfIdle() {
    if (!resumeWhenIdle || draining || liveChildren.size || liveLogs.size) return false;
    disposed = false;
    resumeWhenIdle = false;
    return true;
  }

  function resume() {
    resumeWhenIdle = true;
    return resumeIfIdle();
  }

  function cleanRetiredFiles() {
    if (liveChildren.size) return;
    for (const owner of retiredFiles) {
      if (temporaryFiles.remove(owner)) retiredFiles.delete(owner);
    }
  }

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
    for (const { resolve, reject, requireSuccess, timer } of callbacks.values()) {
      try {
        clearTimer(timer);
        if (requireSuccess) reject(new Error('mpv 已中斷，命令未完成'));
        else resolve(value);
      } catch (error) {}
    }
    callbacks.clear();
  }

  function settlePresentation(request, value = null) {
    if (!request || request !== pendingPresentation) return false;
    pendingPresentation = null;
    request.resolve(value);
    return true;
  }

  function cancelPresent() {
    return settlePresentation(pendingPresentation, null);
  }

  function settleFileLoad(ready) {
    const waiter = pendingFileLoad;
    if (!waiter) return;
    pendingFileLoad = null;
    clearTimer(waiter.timer);
    waiter.resolve(ready);
  }

  function waitForFileLoad(session, { firstFrame = false } = {}) {
    settleFileLoad(false);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null, session, firstFrame, entryId: null, reading: false };
      pendingFileLoad = waiter;
      waiter.timer = setTimer(() => {
        if (pendingFileLoad === waiter) settleFileLoad(false);
      }, firstFrame ? 15000 : 8000);
    });
  }

  function acknowledgeFileLoad(session, receipt) {
    const waiter = pendingFileLoad;
    if (!waiter || waiter.session !== session || session !== fileLoadSession) return;
    const entryId = receipt?.playlist_entry_id;
    if (!Number.isSafeInteger(entryId) || entryId < 0) return settleFileLoad(false);
    session.entryId = entryId;
    waiter.entryId = entryId;
    maybeFinishFileLoad(waiter);
  }

  function releaseSourceObservers(session) {
    const observers=session?.observers;
    if (!observers) return;
    session.observers=null;
    sourceObserverSessions.delete(session);
    if (session.client!==client || session.generation!==generation) return;
    for (const id of Object.values(observers)) void send(['unobserve_property',id]).catch(()=>{});
  }

  async function installSourceObservers(session) {
    const owns=()=>session===fileLoadSession&&session.client===client&&session.generation===generation;
    if (!owns()) return false;
    const observers={ 'time-pos':nextSourceObserverId++, pause:nextSourceObserverId++ };
    session.observers=observers;
    sourceObserverSessions.add(session);
    session.observersReady=false;
    session.pendingObserverEvents={};
    try {
      for (const [name,id] of Object.entries(observers)) {
        await send(['observe_property',id,name],true,{requireSuccess:true});
        if (!owns()) { releaseSourceObservers(session); return false; }
      }
      session.observersReady=true;
      return true;
    } catch (error) {
      releaseSourceObservers(session);
      throw error;
    }
  }

  function publishSourceProperty(session,message) {
    const event={...message,sourceSessionId:session.sourceSessionId};
    if(event.name==='time-pos'&&session.awaitingPositioning) event.beforeSourcePositioning=true;
    if(event.name==='time-pos'&&typeof event.data==='number') event.data=sourceTime(event.data);
    if(!event.beforeSourcePositioning) observePresentationEvent(event);
    sendEvent(event);
  }

  function refreshPauseForSession(session) {
    const current=()=>session===fileLoadSession&&!session.loading&&session.observersReady
      &&session.client===client&&session.generation===generation;
    if(!current()) return;
    if(session.pauseQuery){session.pauseAgain=true;return;}
    const intent=session.playbackIntentId??null;
    const commandGeneration=playbackCommandGeneration;
    session.pauseQuery=true;
    void send(['get_property','pause'],true,{requireSuccess:true}).then(value=>{
      if(!current()||commandGeneration!==playbackCommandGeneration
        ||intent!==(session.playbackIntentId??null)||typeof value!=='boolean') return;
      playerPaused=value;
      sendEvent({event:'property-change',name:'pause',data:value,sourceSessionId:session.sourceSessionId,playbackIntentId:intent});
    }).catch(()=>{}).finally(()=>{
      session.pauseQuery=false;
      if(session.pauseAgain){session.pauseAgain=false;if(current())refreshPauseForSession(session);}
    });
  }

  function publishPendingSourceProperties(session) {
    const pending=session.pendingObserverEvents;
    session.pendingObserverEvents={};
    if(pending?.pause) refreshPauseForSession(session);
    if(pending?.['time-pos']) publishSourceProperty(session,pending['time-pos']);
  }

  // mpv property notifications carry no source identity. A late notification
  // is only a reason to query the *currently confirmed* source; its payload is
  // never used as evidence. Bind the query and reply to the same load session
  // and playlist entry, including when the same path is loaded again.
  function refreshDurationForSession(session) {
    if (session && session === fileLoadSession && session.loading
      && session.client === client && session.generation === generation) {
      // The initial get_property may already be in flight. Re-query after the
      // matched load completes so its older snapshot cannot hide this update.
      session.durationAgain = true;
      return;
    }
    const phase = fileLoadPhase;
    const current = () => !!session && session === fileLoadSession && !session.loading
      && session.client === client && session.generation === generation
      && phase === fileLoadPhase && phase?.loaded && !phase.ended && phase.entryId === session.entryId;
    if (!current()) return;
    if (session.durationQuery) { session.durationAgain = true; return; }
    session.durationQuery = true;
    void send(['get_property', 'duration'], true, { requireSuccess: true }).then(raw => {
      if (!current() || typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return;
      const duration = sourceDuration(raw);
      if (Number.isFinite(duration) && duration > 0) {
        sendEvent({ event: 'property-change', name: 'duration', data: duration, sourceSessionId: session.sourceSessionId });
      }
    }).catch(() => {}).finally(() => {
      session.durationQuery = false;
      if (session.durationAgain) {
        session.durationAgain = false;
        if (current()) refreshDurationForSession(session);
      }
    });
  }

  function maybeFinishFileLoad(waiter) {
    if (!waiter) return;
    const phase = fileLoadPhase;
    const owns = () => waiter === pendingFileLoad && waiter?.session === fileLoadSession
      && waiter.session.client === client && waiter.session.generation === generation
      && phase === fileLoadPhase && waiter.entryId != null && waiter.entryId === phase?.entryId;
    if (!owns()) return;
    if (phase.ended) return settleFileLoad(false);
    if (!phase.loaded || (waiter.firstFrame && !phase.restarted) || waiter.reading) return;
    waiter.reading = true;
    // path 是查詢當下的來源，不能替排隊的舊 file-loaded 作證。先以 loadfile
    // ACK 的 entry ID 配對 start-file 後的事件，再核對路徑；同路徑重載也分開。
    const canonical = value => typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : null;
    void send(['get_property', 'path'], true, { requireSuccess: true }).then(async loadedPath => {
      if (!owns()) return;
      if (canonical(loadedPath) !== canonical(waiter.session.path)) {
        waiter.reading = false;
        return;
      }
      if (!waiter.firstFrame) return settleFileLoad(true);
      // launch 原有首幀契約：同 entry 的 restart 後才讀回有限來源時鐘。
      const time = await send(['get_property', 'time-pos'], true, { requireSuccess: true });
      if (owns()) settleFileLoad(typeof time === 'number' && Number.isFinite(time));
    }).catch(() => {
      if (owns()) settleFileLoad(false);
    });
  }

  function maybeFinishPresentation(request) {
    if (!request || request !== pendingPresentation) return;
    if (request.waitForFrame) {
      if (!request.commandAcknowledged || !request.restarted) return;
      if (!request.frameReady) {
        if (request.readingFrame) return;
        request.readingFrame = true;
        // A paused seek ACK/time-pos can describe only the requested position
        // while mpv is still seeking and the VO retains the previous frame.
        // Capture waits for restart, then reads the actual stopped source PTS.
        void send(['get_property', 'time-pos'], true, { requireSuccess: true }).then(raw => {
          if (request !== pendingPresentation) return;
          const observed = typeof raw === 'number' ? sourceTime(raw) : raw;
          if (!Number.isFinite(observed) || !presentationMatches(request, observed)) return;
          request.presentedSourceTime = observed;
          request.frameReady = true;
          maybeFinishPresentation(request);
        }).catch(() => settlePresentation(request));
        return;
      }
    }
    if (!request.commandAcknowledged || request.presentedSourceTime == null) return;
    if (!request.waitForFrame && !request.confirmedAfterAck) return;
    if (!playerPaused && !request.restarted) return;
    settlePresentation(request, {
      backend: 'mpv',
      presentedSourceTime: request.presentedSourceTime,
      ...(request.knownFrame?{presentedSourceDuration:request.frameDuration}:{}),
    });
  }

  function observePresentationEvent(message) {
    if (message.event === 'property-change' && message.name === 'pause') {
      playerPaused = !!message.data;
    }
    const request = pendingPresentation;
    if (!request) return;
    if (message.event === 'property-change' && message.name === 'time-pos' && request.commandAcknowledged) {
      const presented = typeof message.data === 'number' ? message.data : NaN;
      if (Number.isFinite(presented) && presentationMatches(request,presented)) {
        request.presentedSourceTime = presented;
      }
    } else if (message.event === 'playback-restart' && request.commandAcknowledged) {
      request.restarted = true;
    }
    maybeFinishPresentation(request);
  }

  function detachClient({ destroy = true, emitDisconnected = false } = {}) {
    playbackCommandGeneration++;
    directionGeneration++;
    sourceAudioGraph = '';
    const current = client;
    const sourceSessionId = fileLoadSession?.sourceSessionId;
    client = null;
    buffer = '';
    playerPaused = true;
    clearCallbacks(null);
    cancelPresent();
    settleFileLoad(false);
    fileLoadSession = null;
    sourceObserverSessions.clear();
    fileLoadPhase = null;
    sourceClock = null;
    if (destroy && current) { try { current.destroy(); } catch (error) {} }
    if (emitDisconnected) sendEvent({ event: 'disconnected', ...(sourceSessionId ? { sourceSessionId } : {}) });
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

  function openProcessLog() {
    let stream;
    let fileOwner;
    try { fileOwner = temporaryFiles.create('log'); stream = temporaryFiles.stream(fileOwner); }
    catch (error) { log('[mpv] 無法建立記錄：', error.message); }
    if (!stream) { temporaryFiles.remove(fileOwner); return null; }
    const previousLog = lastLogFile;
    lastLogFile = fileOwner;
    temporaryFiles.remove(previousLog);
    stream.once('close', () => { if (lastLogFile !== fileOwner) temporaryFiles.remove(fileOwner); });
    const closed = new Promise(resolve => stream.once('close', resolve));
    liveLogs.add(closed);
    void closed.then(() => { liveLogs.delete(closed); resumeIfIdle(); });
    const owner = { stream, source: null, closed: false };
    // WriteStream open/write failures are asynchronous. Diagnostic I/O must
    // never become an unhandled error that takes down the native player host.
    stream.on('error', error => {
      log('[mpv] 無法寫入記錄：', error.message);
      closeProcessLog(owner);
    });
    return owner;
  }

  function closeProcessLog(owner = processLog) {
    if (!owner || owner.closed) return;
    owner.closed = true;
    if (processLog === owner) processLog = null;
    try { owner.source?.unpipe(owner.stream); } catch (error) {}
    // Continue draining stderr after a log failure so a full pipe cannot stall mpv.
    try { owner.source?.resume(); } catch (error) {}
    try { owner.stream.destroy(); } catch (error) {}
  }

  function quit() {
    generation++;
    detachClient();
    stopProcess();
    closeProcessLog();
    destroyWindows();
    temporaryFiles.remove(guideOwner);
    if (subOwner) retiredFiles.add(subOwner);
    guideOwner = null;
    subOwner = null;
    cleanRetiredFiles();
  }

  async function disposeAndWait() {
    disposed = true;
    resumeWhenIdle = false;
    draining++;
    try {
      quit();
      const pending = [...liveChildren, ...liveLogs];
      if (pending.length) {
        let timer;
        const timedOut = await Promise.race([
          Promise.all(pending).then(() => false),
          new Promise(resolve => { timer = setTimeout(() => resolve(true), 2000); }),
        ]);
        clearTimeout(timer);
        if (timedOut) { log('[mpv] 等待程序或記錄關閉逾時，保留尚未安全回收的暫存檔'); return false; }
      }
      cleanRetiredFiles();
      const removed = temporaryFiles.cleanup?.() ?? true;
      lastLogFile = null;
      if (!removed) log('[mpv] 部分暫存檔已變更或無法移除，保留原狀');
      return liveChildren.size === 0 && liveLogs.size === 0 && retiredFiles.size === 0 && removed;
    } finally { draining--; resumeIfIdle(); }
  }

  function detect() {
    if (!supported?.()) return null;
    if (executable) return executable;
    executable = findExecutable?.() || null;
    return executable;
  }

  function send(command, wantReply = false, { requireSuccess = false, onSuccess = null } = {}) {
    if (!client) return requireSuccess ? Promise.reject(new Error('mpv 尚未連線')) : Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      if (wantReply) {
        const timer = setTimer(() => {
          const callback = callbacks.get(id);
          if (!callback) return;
          callbacks.delete(id);
          if (requireSuccess) callback.reject(new Error('mpv 命令逾時'));
          else callback.resolve(null);
        }, 5000);
        callbacks.set(id, { resolve, reject, requireSuccess, onSuccess, timer });
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
          if (requireSuccess) callback.reject(error);
          else callback.resolve(null);
        }
      }
    });
  }

  function presentationMatches(request,presented){
    // time-pos is actual player evidence; a duration never widens the symmetric
    // seek tolerance. It only permits the source frame containing this target.
    return request.knownFrame
      ? Math.abs(presented-request.frameStart)<=2e-6
      : Math.abs(presented-request.targetTime)<=request.tolerance;
  }

  function present(time, { exact = false, tolerance = 1.5 / 30, frameTarget = time, frameStart = null, frameDuration = 0, waitForFrame = false } = {}) {
    cancelPresent();
    const startedAt = now();
    const targetTime = Math.max(0, Number(time) || 0);
    const request = {
      targetTime,
      tolerance: Math.max(0, Number(tolerance) || 0),
      frameTarget: Number(frameTarget),
      frameStart: frameStart==null?null:Number(frameStart),
      frameDuration: Math.max(0,Number(frameDuration)||0),
      knownFrame:frameStart!=null&&Number.isFinite(Number(frameStart))&&frameDuration>0
        &&frameTarget>=Number(frameStart)-1e-9&&frameTarget<Number(frameStart)+frameDuration-1e-9,
      commandAcknowledged: false,
      confirmedAfterAck: false,
      waitForFrame,
      frameReady: false,
      readingFrame: false,
      restarted: false,
      presentedSourceTime: null,
      resolve: null,
    };
    const promise = new Promise(resolve => { request.resolve = resolve; });
    const session=fileLoadSession;
    const positioningGeneration=session?(session.positioningGeneration=(session.positioningGeneration||0)+1):0;
    pendingPresentation = request;
    const command = exact
      ? ['seek', playerTime(targetTime), 'absolute+exact']
      : ['set_property', 'time-pos', playerTime(targetTime)];
    send(command, true, { requireSuccess: true, onSuccess:()=>{
      if (request !== pendingPresentation) return;
      request.commandAcknowledged = true;
      if(session===fileLoadSession&&session?.positioningGeneration===positioningGeneration) session.awaitingPositioning=false;
    } }).then(async () => {
      if (request !== pendingPresentation) return;
      maybeFinishPresentation(request);
      if (request.waitForFrame) return;
      if (request !== pendingPresentation) return;
      // 定位到「已經正在顯示的同一格」時，mpv 可以只回覆 command 而不再送
      // property-change。向播放器讀回實際 time-pos，避免這種有效定位占住 session。
      const raw = await send(['get_property', 'time-pos'], true, { requireSuccess: true });
      const observed = typeof raw === 'number' ? sourceTime(raw) : raw;
      if (request !== pendingPresentation) return;
      request.confirmedAfterAck = true;
      if (Number.isFinite(observed) && presentationMatches(request,observed)) {
        request.presentedSourceTime = observed;
      } else request.presentedSourceTime = null;
      maybeFinishPresentation(request);
    }).catch(() => settlePresentation(request));
    return promise.then(result => {
      const elapsed = now() - startedAt;
      if (elapsed >= 1000) log('[mpv] slow present:', Math.round(elapsed) + 'ms', 'target=' + targetTime);
      return result;
    });
  }

  async function setDirection(value) {
    const backward = value === 'backward';
    const token = ++directionGeneration;
    const directionClient = client;
    const directionSource = fileLoadSession;
    const audioGraph = sourceAudioGraph;
    const owns = () => token === directionGeneration && directionClient === client
      && directionSource === fileLoadSession;
    if (!directionClient || directionSource?.loading) return false;
    const command = args => send(args, true, { requireSuccess: true });
    const restore = async () => {
      await command(['set_property', 'play-direction', 'forward']);
      if (!owns()) return false;
      await command(['set_property', 'hwdec', 'auto']);
      if (!owns()) return false;
      // Restore even when an earlier clear acknowledgement is still pending:
      // commands already written to the same pipe retain their mutation order.
      if (audioGraph) await command(['set_property', 'lavfi-complex', audioGraph]);
      return owns();
    };
    try {
      if (!backward) return await restore();
      // Reverse shuttle is silent. An explicit multi-aid amix graph still
      // decodes every input while muted and can stall MPEG-2 MXF reversal.
      // Keep its exact configuration here, with the source that owns it.
      if (audioGraph) await command(['set_property', 'lavfi-complex', '']);
      if (!owns()) return false;
      // mpv 官方明確說明硬體解碼的 frame ownership 會讓 reversal buffer
      // 失去約束，甚至耗盡 GPU 記憶體。只在倒播期間切軟解；正播仍保留 auto。
      await command(['set_property', 'hwdec', 'no']);
      if (!owns()) return false;
      await command(['set_property', 'play-direction', 'backward']);
      return owns();
    } catch (error) {
      // A failed backward setup must not strand the forward source with its
      // graph removed. A newer direction/source owns its own recovery.
      if (backward && owns()) {
        try { await restore(); } catch (restoreError) {}
      }
      throw error;
    }
  }

  function attachClient(connected, token) {
    client = connected;
    buffer = '';
    // Pipe chunk 不是 UTF-8 字元邊界；每條連線持有自己的半字元，
    // 避免中文 path 損毀後無法確認 file-loaded，也不沿用舊連線殘留。
    const decoder = new StringDecoder('utf8');
    connected.on('data', chunk => {
      if (connected !== client || token !== generation) return;
      buffer += decoder.write(chunk);
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
            if (callback.requireSuccess && message.error !== 'success') {
              callback.reject(new Error('mpv 命令失敗：' + (message.error || '無效的命令回覆')));
            } else {
              callback.onSuccess?.();
              callback.resolve(message.data ?? null);
            }
          } else if (message.event === 'start-file') {
            fileLoadPhase = { entryId: message.playlist_entry_id, loaded: false, restarted: false, ended: false };
          } else if (message.event === 'file-loaded') {
            if (fileLoadPhase) fileLoadPhase.loaded = true;
            maybeFinishFileLoad(pendingFileLoad);
            sendEvent(message);
          } else if (message.event === 'property-change' || message.event === 'end-file' || message.event === 'playback-restart') {
            if (message.event === 'playback-restart' && fileLoadPhase?.loaded && !fileLoadPhase.ended) {
              fileLoadPhase.restarted = true;
              maybeFinishFileLoad(pendingFileLoad);
            } else if (message.event === 'end-file' && fileLoadPhase && message.playlist_entry_id === fileLoadPhase.entryId) {
              fileLoadPhase.ended = true;
              maybeFinishFileLoad(pendingFileLoad);
            }
            if (message.event === 'property-change' && message.name === 'duration') {
              refreshDurationForSession(fileLoadSession);
              continue;
            }
            if (message.event === 'property-change' && (message.name === 'time-pos' || message.name === 'pause')) {
              const session=fileLoadSession;
              if(!session||session.client!==client||session.generation!==generation
                ||session.observers?.[message.name]!==message.id) continue;
              if(session.loading||!session.observersReady) session.pendingObserverEvents[message.name]=message;
              else if(message.name==='pause') refreshPauseForSession(session);
              else publishSourceProperty(session,message);
              continue;
            }
            if (message.event === 'property-change' && typeof message.data === 'number') {
              if (message.name === 'time-pos') message.data = sourceTime(message.data);
            }
            if (message.event === 'end-file') {
              const session = fileLoadSession;
              // A replaced entry may finish after the new entry has started.
              // Only the loadfile ACK's entry can identify this source, even
              // when two successive loads use exactly the same path.
              if (!session || session.client !== client || session.generation !== generation
                || session.entryId == null || message.playlist_entry_id !== session.entryId) continue;
              message.sourceSessionId = session.sourceSessionId;
            }
            observePresentationEvent(message);
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
        offscreen: false, backgroundThrottling: false, webSecurity: true,
      },
    });
    /* guide 只有原生畫面上的視覺職責；所有 pointer 都穿透到主 renderer 的
       #imageLayer，避免兩條拖曳 state machine 競爭同一個 gesture。 */
    try { guideWin.setIgnoreMouseEvents(true, { forward: true }); } catch (error) {}
    try { guideWin.setMenu(null); } catch (error) {}
  }

  async function loadGuideDocument() {
    guideOwner = temporaryFiles.create('html');
    temporaryFiles.write(guideOwner, guideHtml);
    const guidePath = guideOwner.file;
    allowInternalDocument?.(guidePath);
    await guideWin.loadURL(url.pathToFileURL(guidePath).href);
  }

  async function launch({ src, bounds, audio } = {}) {
    if (disposed) throw new Error('mpv 宿主已關閉');
    if (!supported?.()) throw new Error('目前 macOS 版不啟用 Windows 專用的 mpv 嵌入');
    if (typeof src !== 'string' || !src) throw new Error('mpv：來源路徑無效');
    quit();
    const token = ++generation;
    const exe = detect();
    if (!exe) throw new Error('找不到 mpv，請安裝 mpv 或設定 MPV_PATH 環境變數（https://mpv.io）');

    let startupSession = null;
    try {
      const info = describeSource ? await describeSource(src) : null;
      if (token !== generation) throw new Error('mpv 啟動已被新的媒體取代');
      sourceClock = info?.video || null;
      createHostWindows();
      await loadGuideDocument();
      // loadURL yields while quit()/launch() can transfer ownership of the shared
      // windows. A stale launch must stop before touching that newer host or spawning.
      if (token !== generation) throw new Error('mpv 啟動已被新的媒體取代');
      visible = true;
      applyBounds(bounds);
      if (timecodeWatermark) {
        applyTimecodeWatermark();
        showGuide();
      }

      const handle = hostWin.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();
      ensureTmp?.();
      const logOwner = openProcessLog();
      processLog = logOwner;
      // quit() 會先要求舊 child 結束，但舊 named pipe 可能還活著。同一毫秒
      // 換片時必須使用新的位址，否則新連線可能接到舊 mpv。
      const pipeName = 'subtool-mpv-' + process.pid + '-' + token + '-' + now();
      const args = [
        '--wid=' + hwnd,
        '--input-ipc-server=\\\\.\\pipe\\' + pipeName,
        '--no-config', '--no-terminal', '--no-osc',
        '--no-input-default-bindings', '--input-vo-keyboard=no', '--cursor-autohide=no',
        '--vo=gpu', '--gpu-context=d3d11', '--hwdec=auto',
        '--keep-open=always', '--idle=yes', '--pause', '--hr-seek=yes', '--hr-seek-framedrop=no',
        '--sub-delay=' + playerTime(0),
        // 反向播放需要把 GOP 先正向解碼再倒序交給 VO。cache 與 decode queue
        // 若未明確開啟，長 GOP／廣播容器會在每一批之間反覆停住。
        '--cache=yes', '--vd-queue-enable=yes',
        '--demuxer-max-bytes=256MiB', '--demuxer-max-back-bytes=192MiB',
        '--demuxer-readahead-secs=10', '--demuxer-backward-playback-step=10', '--sid=no',
      ];
      const fontDir = fontsDir?.();
      if (fontDir) args.push('--sub-fonts-dir=' + fontDir, '--embeddedfonts=no');
      if (Array.isArray(audio) && audio.length > 1) {
        const aids = [];
        for (let i = 0; i < audio.length; i++) aids.push(`[aid${i + 1}]`);
        sourceAudioGraph = `${aids.join('')}amix=inputs=${audio.length}:normalize=0[ao]`;
        args.push('--lavfi-complex=' + sourceAudioGraph);
      }
      const spawned = spawn(exe, args, { windowsHide: true, detached: false, stdio: ['ignore', 'ignore', logOwner ? 'pipe' : 'ignore'] });
      proc = spawned;
      const childClosed = new Promise(resolve => spawned.once('close', resolve));
      liveChildren.add(childClosed);
      void childClosed.then(() => { liveChildren.delete(childClosed); cleanRetiredFiles(); resumeIfIdle(); });
      if (logOwner && spawned.stderr) {
        logOwner.source = spawned.stderr;
        spawned.stderr.pipe(logOwner.stream);
      }
      log('[mpv] launch wid=' + hwnd + ' bounds=' + JSON.stringify(rect) + ' src=' + src);
      spawned.on('error', error => {
        log('[mpv] spawn error:', error && error.message);
        closeProcessLog(logOwner);
      });
      spawned.on('close', code => {
        closeProcessLog(logOwner);
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
      client.write(JSON.stringify({ command: ['observe_property', 3, 'duration'] }) + '\n');
      // Load only after attaching the pipe: CLI playback could finish its initial
      // file-loaded/restart before a client connects. --pause stays in force, and
      // the first load preserves the launch's multi-aid graph (unlike loadFile).
      startupSession = { client, generation: token, path: src, loading: true, awaitingPositioning:false, sourceSessionId: randomBytes(16).toString('hex') };
      fileLoadSession = startupSession;
      const ready = waitForFileLoad(startupSession, { firstFrame: true });
      const receipt = await send(['loadfile', src, 'replace'], true, { requireSuccess: true });
      acknowledgeFileLoad(startupSession, receipt);
      const loaded = await ready;
      if (token !== generation || fileLoadSession !== startupSession) throw new Error('mpv 啟動已被新的媒體取代');
      if (!loaded) throw new Error('mpv 初始畫格未在期限內就緒');
      if (!await installSourceObservers(startupSession)) throw new Error('mpv 啟動已被新的媒體取代');
      const duration = await send(['get_property', 'duration'], true);
      if (token !== generation || fileLoadSession !== startupSession) throw new Error('mpv 啟動已被新的媒體取代');
      startupSession.loading = false;
      publishPendingSourceProperties(startupSession);
      if (startupSession.durationAgain) { startupSession.durationAgain = false; refreshDurationForSession(startupSession); }
      return { ok: true, duration: readySourceDuration(duration, info), sourceSessionId: startupSession.sourceSessionId };
    } catch (error) {
      if (token === generation && (!startupSession || fileLoadSession === startupSession)) quit();
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
    if (subOwner) {
      try { temporaryFiles.write(subOwner, assText || ''); }
      catch (error) {
        // A replaced or unavailable file must never be reopened for writing.
        // Give mpv a fresh track instead of losing future live updates.
        retiredFiles.add(subOwner);
        subOwner = null;
        subFile = null;
        subAdded = false;
      }
    }
    try {
      if (!subFile) {
        subOwner = temporaryFiles.create('ass');
        subFile = subOwner.file;
        temporaryFiles.write(subOwner, assText || '');
      }
    } catch (error) {
      temporaryFiles.remove(subOwner);
      subOwner = null;
      subFile = null;
      return null;
    }
    if (!subAdded) {
      subAdded = true;
      return send(['sub-add', subFile, 'select']);
    }
    return send(['sub-reload']);
  }

  async function loadFile(filePath) {
    if (!client) return null;
    directionGeneration++;
    settleFileLoad(false);
    const previousSource = fileLoadSession?.loading ? null : fileLoadSession;
    if(fileLoadSession?.loading) releaseSourceObservers(fileLoadSession);
    const session = { client, generation, path: filePath, loading: true, awaitingPositioning:true, sourceSessionId: randomBytes(16).toString('hex') };
    fileLoadSession = session;
    const current = () => session === fileLoadSession && session.client === client && session.generation === generation;
    const superseded = () => ({ ok: false, duration: 0 });
    // 同一個 mpv process 會沿用 pipe，但舊來源的呈現請求絕不可由新來源的
    // time-pos／playback-restart 完成。
    cancelPresent();
    subAdded = false;
    let info;
    try {
      info = describeSource ? await describeSource(filePath) : null;
    } catch (error) {
      // A rejected probe has not changed mpv's source or its saved audio graph.
      if (current()) {
        fileLoadSession = previousSource;
        if(!previousSource) for(const old of [...sourceObserverSessions]) releaseSourceObservers(old);
      }
      throw error;
    }
    if (!current()) return superseded();
    await send(['set_property', 'pause', true]);
    if (!current()) return superseded();
    sourceAudioGraph = '';
    await send(['set_property', 'lavfi-complex', '']);
    if (!current()) return superseded();
    log('[mpv] loadfile:', filePath);
    sourceClock = info?.video || null;
    await send(['set_property', 'sub-delay', playerTime(0)]);
    if (!current()) return superseded();
    for(const old of [...sourceObserverSessions]) if(old!==session) releaseSourceObservers(old);
    // 建立 waiter 後才送命令，避免快速載入的 file-loaded 先於 command ack 到達。
    const ready = waitForFileLoad(session);
    try {
      const receipt = await send(['loadfile', filePath, 'replace'], true, { requireSuccess: true });
      acknowledgeFileLoad(session, receipt);
    } catch (error) {
      if (!current()) return superseded();
      settleFileLoad(false);
      throw error;
    }
    if (!await ready || !current()) {
      log('[mpv] loadfile: matching source load did not complete:', filePath);
      return { ok: false, duration: 0 };
    }
    if (!await installSourceObservers(session)) return superseded();
    const duration = await send(['get_property', 'duration'], true);
    if (!current()) return superseded();
    session.loading = false;
    publishPendingSourceProperties(session);
    if (session.durationAgain) { session.durationAgain = false; refreshDurationForSession(session); }
    return { ok: true, duration: readySourceDuration(duration, info), sourceSessionId: session.sourceSessionId };
  }

  return {
    detect,
    logPath: () => lastLogFile && (temporaryFiles.owns?.(lastLogFile) ?? true) ? lastLogFile.file : null,
    launch,
    quit,
    dispose: quit,
    disposeAndWait,
    resume,
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
    // time-pos 讓最新目標立即取代舊目標，適合一般連續逐格；少數 HEVC MP4 在
    // frame boundary 會把 time-pos 呈現到下一格，改用 mpv 的 absolute+exact command。
    seek: async (time, { exact = false } = {}) => {
      const session=fileLoadSession;
      const positioningGeneration=session?(session.positioningGeneration=(session.positioningGeneration||0)+1):0;
      const command=exact?['seek',playerTime(time),'absolute+exact']:['set_property','time-pos',playerTime(time)];
      const result=await send(command,true,{requireSuccess:true,onSuccess:()=>{
        if(session===fileLoadSession&&session?.positioningGeneration===positioningGeneration) session.awaitingPositioning=false;
      }});
      return result;
    },
    present,
    cancelPresent,
    screenshot: filePath => send(['screenshot-to-file', filePath, 'subtitles'], true, { requireSuccess: true })
      .then(() => ({ ok: true })),
    play: (options = {}) => {
      const commandGeneration=++playbackCommandGeneration,session=fileLoadSession,previousPaused=playerPaused;
      if(fileLoadSession) fileLoadSession.playbackIntentId=typeof options?.intentId==='string'?options.intentId:null;
      // Keep the ordered play/pause intent for presentation; a late ACK must
      // not overwrite a newer pause. The Promise proves command acceptance,
      // not frame presentation, and rejects pipe/command/timeout failures.
      playerPaused = false;
      return send(['set_property', 'pause', false], true, { requireSuccess: true }).catch(error=>{
        if(commandGeneration===playbackCommandGeneration&&session===fileLoadSession) playerPaused=previousPaused;
        throw error;
      });
    },
    pause: (options = {}) => {
      const commandGeneration=++playbackCommandGeneration,session=fileLoadSession,previousPaused=playerPaused;
      if(fileLoadSession) fileLoadSession.playbackIntentId=typeof options?.intentId==='string'?options.intentId:null;
      playerPaused = true;
      return send(['set_property', 'pause', true],true,{requireSuccess:true}).catch(error=>{
        if(commandGeneration===playbackCommandGeneration&&session===fileLoadSession) playerPaused=previousPaused;
        throw error;
      });
    },
    direction: setDirection,
    // The renderer uses this acknowledgment as the handoff boundary before
    // starting another audio carrier. Pipe writes alone do not prove mpv has
    // applied the mute, and a disconnected player must not report success.
    mute: value => send(['set_property', 'mute', value], true, { requireSuccess: true }),
    rate: value => send(['set_property', 'speed', value]),
    brightness: value => send(['set_property', 'brightness', Math.max(-100, Math.min(0, Math.round(value)))]),
    isPresent: () => alive(hostWin),
    snapshot: () => ({ visible, hasHostWindow: alive(hostWin), hasGuideWindow: alive(guideWin), hasClient: !!client, hasProcess: !!proc, rect }),
  };
}

module.exports = { createMpvHost };

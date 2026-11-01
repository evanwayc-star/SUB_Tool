'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DISC_FORMATS, discFormat, discAudioStreams, discEncoding } = require('./disc-encoding');
const { bdVideoMode } = require('../shared/delivery-formats.cjs');
const WORK_PREFIX = 'subtool-disc-';

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function abortIfNeeded(signal) { if (signal?.aborted) throw fail('ABORT_ERR', '光碟合成已取消'); }
function directoryIdentity(directory) {
  const stat = fsSync.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('INVALID_DISC_TEMP', '光碟暫存目錄不可為連結');
  return { dev: String(stat.dev), ino: String(stat.ino), realpath: fsSync.realpathSync.native(directory) };
}
function assertDirectoryIdentity(directory, expected) {
  if (!expected || typeof expected.dev !== 'string' || typeof expected.ino !== 'string' || typeof expected.realpath !== 'string') {
    throw fail('INVALID_DISC_TEMP', '光碟暫存目錄缺少原始身分');
  }
  const actual = directoryIdentity(directory);
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || key(actual.realpath) !== key(expected.realpath)) {
    throw fail('INVALID_DISC_TEMP', '光碟暫存目錄身分已變更，已保留檔案');
  }
}
async function prepareDiscOutput(format, { tempDir } = {}) {
  const spec = discFormat(format);
  if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir)) throw fail('INVALID_DISC_TEMP', '光碟暫存目錄必須為絕對路徑');
  const parentIdentity = directoryIdentity(tempDir);
  const created = await fs.mkdtemp(path.toNamespacedPath(path.join(tempDir, WORK_PREFIX)));
  const workDir = path.join(tempDir, path.basename(created));
  assertDirectoryIdentity(tempDir, parentIdentity);
  const workIdentity = directoryIdentity(workDir);
  return { workDir, encodedPath: path.join(workDir, `internal${spec.extension}`), parentIdentity, workIdentity };
}

function assertDiscWorkspace({ workDir, parentIdentity, workIdentity, outputLink } = {}, { tempDir, allowMissing = false } = {}) {
  if (typeof workDir !== 'string' || typeof tempDir !== 'string') throw fail('INVALID_DISC_TEMP', '光碟暫存路徑無效');
  const absolute = path.resolve(workDir), parent = path.resolve(tempDir);
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith(WORK_PREFIX)) {
    throw fail('INVALID_DISC_TEMP', '拒絕清除非本工作的光碟暫存目錄');
  }
  assertDirectoryIdentity(parent, parentIdentity);
  try { assertDirectoryIdentity(absolute, workIdentity); }
  catch (error) { if (allowMissing && error.code === 'ENOENT' && workIdentity) return false; throw error; }
  const link = path.join(absolute, 'out');
  let stat;
  try { stat = fsSync.lstatSync(link, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat) {
    if (!outputLink || !stat.isSymbolicLink() || String(stat.dev) !== outputLink.dev || String(stat.ino) !== outputLink.ino
      || typeof outputLink.target?.path !== 'string') {
      throw fail('INVALID_DISC_TEMP', '光碟輸出短路徑缺少原始身分，已保留檔案');
    }
    assertDirectoryIdentity(outputLink.target.path, outputLink.target.identity);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(fsSync.realpathSync.native(link)) !== key(outputLink.target.path)) {
      throw fail('INVALID_DISC_TEMP', '光碟輸出短路徑目標已變更，已保留檔案');
    }
  }
  return true;
}

async function cleanupDiscOutput(stage, { tempDir } = {}) {
  if (!assertDiscWorkspace(stage, { tempDir, allowMissing: true })) return;
  // Keep the checks and removal synchronous to avoid an event-loop gap. The OS
  // calls themselves are still separate; this does not eliminate external races.
  fsSync.rmSync(path.resolve(stage.workDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function nativeDiscPaths(directory = path.join(__dirname, 'disc')) {
  return Object.fromEntries(['dvdauthor', 'mkisofs', 'tsmuxer'].map(name => [name,
    path.join(directory, `${name === 'tsmuxer' ? 'tsMuxeR' : name}${process.platform === 'win32' ? '.exe' : ''}`)]));
}

async function stopNative(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function runNative(executable, args, { cwd, signal, onProgress, onProcess, onOutputStart, assertOutput } = {}) {
  abortIfNeeded(signal);
  if (typeof executable !== 'string' || !executable) throw fail('DISC_NATIVE_MISSING', '缺少光碟合成工具');
  await fs.access(executable).catch(() => { throw fail('DISC_NATIVE_MISSING', `找不到光碟合成工具：${path.basename(executable)}`); });
  abortIfNeeded(signal);
  await onOutputStart?.();
  abortIfNeeded(signal);
  assertOutput?.();
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let detail = '';
  let nativeError = null, stopping = null, resolveClosed, rejectSpawn;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    rejectSpawn = reject;
  });
  // Kill/send failures are errors from a still-owned writer, not close evidence.
  // Store the stop promise before killing: a failed kill may emit error again.
  const stop = () => {
    if (!stopping) stopping = Promise.resolve().then(() => stopNative(child));
    return stopping;
  };
  child.on('error', error => {
    nativeError ||= error;
    rejectSpawn(nativeError);
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      resolveClosed({ code: null, childSignal: null });
    } else void stop().catch(() => {});
  });
  child.once('close', (code, childSignal) => resolveClosed({ code, childSignal }));
  const receive = chunk => {
    const text = chunk.toString('utf8'); detail = (detail + text).slice(-16000);
    const match = /(?:^|\s)(\d+(?:\.\d+)?)%/.exec(text);
    if (match && onProgress) onProgress(Math.min(100, Number(match[1])));
  };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  const pipeError = error => {
    nativeError ||= error;
    // A broken pipe does not prove that the writer has stopped. Terminate it
    // and keep the workspace until the child's close event confirms it exited.
    void stop().catch(() => {});
  };
  child.stdout.on('error', pipeError); child.stderr.on('error', pipeError);
  const abort = () => { void stop().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await spawned;
    if (nativeError) throw nativeError;
    await onProcess?.(child);
    const result = await closed;
    if (nativeError) throw nativeError;
    abortIfNeeded(signal);
    if (result.code !== 0) throw fail('DISC_AUTHORING_FAILED', `${path.basename(executable)} 合成失敗（${result.code ?? result.childSignal}）：${detail.trim()}`);
  } catch (error) {
    await stop().catch(() => {});
    await closed;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function dvdAuthorXml(audioPlan) {
  const audio = discAudioStreams('dvd-iso', audioPlan);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<dvdauthor dest="dvd">\n` +
    '  <vmgm><fpc>jump title 1;</fpc><menus><video format="ntsc" /></menus></vmgm>\n' +
    '  <titleset><titles><video format="ntsc" aspect="16:9" resolution="720x480" widescreen="nopanscan" />\n' +
    audio.map(stream => `    <audio format="ac3" channels="${stream.channels}" samplerate="48khz"${stream.layout === 'stereoLtRt' ? ' dolby="surround"' : ''} />\n`).join('') +
    '    <pgc><vob file="internal.mpg" /><post>exit;</post></pgc>\n  </titles></titleset>\n</dvdauthor>\n';
}

function blurayMeta(audioPlan, fps = 24) {
  const audio = discAudioStreams('bd-iso', audioPlan);
  if (!bdVideoMode(fps)) throw fail('INVALID_BD_FPS', 'BD 封裝不支援此影格率');
  return 'MUXOPT --blu-ray --vbr --vbv-len=500 --auto-chapters=5 --label="BD"\n' +
    `V_MPEG4/ISO/AVC, "internal.ts", track=256, fps=${fps}, insertSEI, contSPS\n` +
    audio.map((_, index) => `A_AC3, "internal.ts", track=${257 + index}${index === 0 ? ', default' : ''}\n`).join('');
}

function udfVolumeLabel(field) {
  const length = field[field.length - 1];
  if (field[0] !== 8 || length < 2 || length >= field.length) return '';
  return field.toString('latin1', 1, length).replace(/\0+$/, '');
}

function validUdfTag(descriptor, id, sector) {
  if (descriptor.readUInt16LE(0) !== id || descriptor.readUInt32LE(12) !== sector) return false;
  let tagSum = 0;
  for (let index = 0; index < 16; index++) {
    if (index !== 4) tagSum = (tagSum + descriptor[index]) & 255;
  }
  if (tagSum !== descriptor[4]) return false;
  const crcLength = descriptor.readUInt16LE(10);
  if (!crcLength || crcLength > descriptor.length - 16) return false;
  let crc = 0;
  for (let index = 16; index < 16 + crcLength; index++) {
    crc ^= descriptor[index] << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc === descriptor.readUInt16LE(8);
}

async function verifyDiscIso(format, outPath) {
  const spec = discFormat(format);
  const file = await fs.open(outPath, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 32768 || size % 2048 !== 0) throw fail('INVALID_DISC_ISO', '光碟映像大小或扇區排列無效');
    if (size > spec.capacityBytes) throw fail('DISC_CAPACITY_EXCEEDED', `光碟映像超過 ${spec.capacityBytes / 1e9} GB 容量上限`);
    const descriptors = Buffer.alloc(2048 * 16);
    await file.read(descriptors, 0, descriptors.length, 2048 * 16);
    if (!descriptors.includes(Buffer.from('BEA01')) || !descriptors.includes(Buffer.from(format === 'bd-iso' ? 'NSR03' : 'NSR02'))) {
      throw fail('INVALID_DISC_ISO', '合成結果缺少正確 UDF 光碟檔案系統');
    }
    const anchor = Buffer.alloc(2048);
    const anchorRead = await file.read(anchor, 0, anchor.length, 256 * 2048);
    if (anchorRead.bytesRead !== anchor.length || !validUdfTag(anchor, 2, 256)) {
      throw fail('INVALID_DISC_ISO', '光碟映像缺少 UDF anchor');
    }
    const sequenceBytes = anchor.readUInt32LE(16), sequenceStart = anchor.readUInt32LE(20) * 2048;
    if (!sequenceBytes || sequenceBytes > 1024 * 1024 || sequenceStart + sequenceBytes > size) {
      throw fail('INVALID_DISC_ISO', 'UDF 描述區超出光碟映像');
    }
    let revision = 0;
    let volumeLabel = '';
    for (let offset = 0; offset < sequenceBytes; offset += 2048) {
      const descriptor = Buffer.alloc(2048);
      const read = await file.read(descriptor, 0, descriptor.length, sequenceStart + offset);
      if (read.bytesRead !== descriptor.length) throw fail('INVALID_DISC_ISO', 'UDF 描述區不完整');
      if (descriptor.readUInt16LE(0) !== 6) continue;
      if (!validUdfTag(descriptor, 6, sequenceStart / 2048 + offset / 2048)) {
        throw fail('INVALID_DISC_ISO', 'UDF logical volume 描述符校驗失敗');
      }
      if (descriptor.readUInt32LE(212) !== 2048 || descriptor.toString('ascii', 217, 236) !== '*OSTA UDF Compliant') {
        throw fail('INVALID_DISC_ISO', 'UDF logical volume 無效');
      }
      revision = descriptor.readUInt16LE(240);
      volumeLabel = udfVolumeLabel(descriptor.subarray(84, 212));
      break;
    }
    if (revision !== (format === 'bd-iso' ? 0x250 : 0x102)) {
      throw fail('INVALID_DISC_ISO', '光碟 UDF 版本不符 DVD 1.02／BD 2.50 規格');
    }
    const expectedLabel = format === 'bd-iso' ? 'BD' : 'DVD';
    if (volumeLabel !== expectedLabel) {
      throw fail('INVALID_DISC_ISO', `光碟標籤應為 ${expectedLabel}，實際為 ${volumeLabel || '空白'}`);
    }
    return { outputFiles: [outPath], container: 'iso', capacityBytes: spec.capacityBytes, bytes: size,
      udfVersion: format === 'bd-iso' ? '2.50' : '1.02', volumeLabel };
  } finally { await file.close(); }
}

async function finalizeDiscOutput(format, encodedPath, outPath, { signal, nativePaths = nativeDiscPaths(), audioPlan, fps, onProgress, onProcess, onOutputStart, onOutputLink, assertOutput, nativeWorkRoot } = {}) {
  const spec = discFormat(format);
  discAudioStreams(format, audioPlan);
  abortIfNeeded(signal);
  if (!path.isAbsolute(encodedPath) || path.basename(encodedPath) !== `internal${spec.extension}`
    || !path.isAbsolute(outPath) || path.extname(outPath).toLowerCase() !== '.iso') {
    throw fail('INVALID_DISC_PATH', '光碟合成路徑無效');
  }
  const cwd = path.dirname(encodedPath);
  if (!path.basename(cwd).startsWith(WORK_PREFIX)) throw fail('INVALID_DISC_TEMP', '光碟來源不是本工作暫存檔');
  const options = { cwd: nativeWorkRoot ? path.join(nativeWorkRoot, path.basename(cwd)) : cwd,
    signal, onProgress, onProcess, assertOutput };
  if (format === 'dvd-iso') {
    assertOutput?.();
    fsSync.writeFileSync(path.join(cwd, 'disc.xml'), dvdAuthorXml(audioPlan), { encoding: 'utf8', flag: 'wx' });
    await runNative(nativePaths.dvdauthor, ['-x', 'disc.xml'], options);
    abortIfNeeded(signal);
    for (const filename of ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.BUP', 'VTS_01_1.VOB']) {
      assertOutput?.();
      const stat = await fs.stat(path.join(cwd, 'dvd', 'VIDEO_TS', filename));
      if (!stat.size) throw fail('INVALID_DISC_STRUCTURE', `DVD 缺少內容：${filename}`);
    }
    // mkisofs' Cygwin build accepts Windows forward-slash paths, including spaces.
    await runNative(nativePaths.mkisofs, ['-dvd-video', '-udf', '-V', 'DVD', '-o', outPath.replace(/\\/g, '/'), 'dvd'], { ...options, onOutputStart });
  } else {
    assertOutput?.();
    fsSync.writeFileSync(path.join(cwd, 'disc.meta'), blurayMeta(audioPlan, fps), { encoding: 'utf8', flag: 'wx' });
    let outputArg = outPath;
    let startOutput = onOutputStart;
    let assertNativeOutput = assertOutput;
    if (process.platform === 'win32' && nativeWorkRoot) {
      // tsMuxeR cannot open a long absolute output path. This junction lives
      // inside the owned work directory and points to the already-authorized
      // output parent; the original stage remains the sole deliverable inode.
      const outputLink = path.join(cwd, 'out');
      outputArg = path.join(options.cwd, 'out', path.basename(outPath));
      let linkIdentity, targetPath;
      const key = value => path.resolve(value).toLowerCase();
      const assertLink = () => {
        assertOutput?.();
        const stat = fsSync.lstatSync(outputLink, { bigint: true });
        if (!linkIdentity || !stat.isSymbolicLink() || String(stat.dev) !== linkIdentity.dev
          || String(stat.ino) !== linkIdentity.ino || key(fsSync.realpathSync.native(outputLink)) !== key(targetPath)) {
          throw fail('INVALID_DISC_TEMP', '光碟輸出短路徑身分已變更，已保留檔案');
        }
        const expected = fsSync.lstatSync(outPath, { bigint: true });
        const actual = fsSync.lstatSync(path.join(outputLink, path.basename(outPath)), { bigint: true });
        if (!actual.isFile() || actual.isSymbolicLink() || String(actual.dev) !== String(expected.dev)
          || String(actual.ino) !== String(expected.ino)) {
          throw fail('INVALID_DISC_TEMP', '光碟輸出短路徑未指向原始成品暫存檔');
        }
      };
      startOutput = async () => {
        await onOutputStart?.();
        abortIfNeeded(signal);
        assertOutput?.();
        targetPath = fsSync.realpathSync.native(path.dirname(outPath));
        const targetIdentity = directoryIdentity(targetPath);
        fsSync.symlinkSync(targetPath, outputLink, 'junction'); // EEXIST never grants ownership.
        const stat = fsSync.lstatSync(outputLink, { bigint: true });
        if (!stat.isSymbolicLink() || key(fsSync.realpathSync.native(outputLink)) !== key(targetPath)) {
          throw fail('INVALID_DISC_TEMP', '光碟輸出短路徑目標已變更，已保留檔案');
        }
        linkIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
        await onOutputLink?.({ ...linkIdentity, target: { path: targetPath, identity: targetIdentity } });
        abortIfNeeded(signal);
        assertLink();
      };
      assertNativeOutput = assertLink;
    }
    await runNative(nativePaths.tsmuxer, ['disc.meta', outputArg],
      { ...options, onOutputStart: startOutput, assertOutput: assertNativeOutput });
  }
  abortIfNeeded(signal);
  return verifyDiscIso(format, outPath);
}

module.exports = { DISC_FORMATS, discEncoding, prepareDiscOutput, assertDiscWorkspace, cleanupDiscOutput, nativeDiscPaths, finalizeDiscOutput, dvdAuthorXml, blurayMeta, verifyDiscIso };

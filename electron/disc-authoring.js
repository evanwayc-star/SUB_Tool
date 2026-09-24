'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { DISC_FORMATS, discFormat, discAudioStreams, discEncoding } = require('./disc-encoding');
const { bdVideoMode } = require('../shared/delivery-formats.cjs');
const WORK_PREFIX = 'subtool-disc-';

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function abortIfNeeded(signal) { if (signal?.aborted) throw fail('ABORT_ERR', '光碟合成已取消'); }
async function prepareDiscOutput(format, { tempDir } = {}) {
  const spec = discFormat(format);
  if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir)) throw fail('INVALID_DISC_TEMP', '光碟暫存目錄必須為絕對路徑');
  const workDir = await fs.mkdtemp(path.join(tempDir, WORK_PREFIX));
  return { workDir, encodedPath: path.join(workDir, `internal${spec.extension}`) };
}

async function cleanupDiscOutput({ workDir } = {}, { tempDir } = {}) {
  if (typeof workDir !== 'string' || typeof tempDir !== 'string') throw fail('INVALID_DISC_TEMP', '光碟暫存路徑無效');
  const absolute = path.resolve(workDir), parent = path.resolve(tempDir);
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith(WORK_PREFIX)) {
    throw fail('INVALID_DISC_TEMP', '拒絕清除非本工作的光碟暫存目錄');
  }
  const stat = await fs.lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('INVALID_DISC_TEMP', '光碟暫存目錄不可為連結');
  await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

async function runNative(executable, args, { cwd, signal, onProgress, onProcess, onOutputStart } = {}) {
  abortIfNeeded(signal);
  if (typeof executable !== 'string' || !executable) throw fail('DISC_NATIVE_MISSING', '缺少光碟合成工具');
  await fs.access(executable).catch(() => { throw fail('DISC_NATIVE_MISSING', `找不到光碟合成工具：${path.basename(executable)}`); });
  abortIfNeeded(signal);
  await onOutputStart?.();
  abortIfNeeded(signal);
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let detail = '';
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, childSignal) => resolve({ code, childSignal }));
  });
  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // Keep a rejection handler installed while the lease callback is pending.
  void closed.catch(() => {});
  const receive = chunk => {
    const text = chunk.toString('utf8'); detail = (detail + text).slice(-16000);
    const match = /(?:^|\s)(\d+(?:\.\d+)?)%/.exec(text);
    if (match && onProgress) onProgress(Math.min(100, Number(match[1])));
  };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  const abort = () => { void stopNative(child).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await spawned;
    await onProcess?.(child);
    const result = await closed;
    abortIfNeeded(signal);
    if (result.code !== 0) throw fail('DISC_AUTHORING_FAILED', `${path.basename(executable)} 合成失敗（${result.code ?? result.childSignal}）：${detail.trim()}`);
  } catch (error) {
    await stopNative(child);
    await closed.catch(() => {});
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
    if (anchorRead.bytesRead !== anchor.length || anchor.readUInt16LE(0) !== 2) {
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

async function finalizeDiscOutput(format, encodedPath, outPath, { signal, nativePaths = nativeDiscPaths(), audioPlan, fps, onProgress, onProcess, onOutputStart } = {}) {
  const spec = discFormat(format);
  discAudioStreams(format, audioPlan);
  abortIfNeeded(signal);
  if (!path.isAbsolute(encodedPath) || path.basename(encodedPath) !== `internal${spec.extension}`
    || !path.isAbsolute(outPath) || path.extname(outPath).toLowerCase() !== '.iso') {
    throw fail('INVALID_DISC_PATH', '光碟合成路徑無效');
  }
  const cwd = path.dirname(encodedPath);
  if (!path.basename(cwd).startsWith(WORK_PREFIX)) throw fail('INVALID_DISC_TEMP', '光碟來源不是本工作暫存檔');
  const options = { cwd, signal, onProgress, onProcess };
  if (format === 'dvd-iso') {
    await fs.writeFile(path.join(cwd, 'disc.xml'), dvdAuthorXml(audioPlan), 'utf8');
    await runNative(nativePaths.dvdauthor, ['-x', 'disc.xml'], options);
    abortIfNeeded(signal);
    for (const filename of ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.BUP', 'VTS_01_1.VOB']) {
      const stat = await fs.stat(path.join(cwd, 'dvd', 'VIDEO_TS', filename));
      if (!stat.size) throw fail('INVALID_DISC_STRUCTURE', `DVD 缺少內容：${filename}`);
    }
    // mkisofs' Cygwin build accepts Windows forward-slash paths, including spaces.
    await runNative(nativePaths.mkisofs, ['-dvd-video', '-udf', '-V', 'DVD', '-o', outPath.replace(/\\/g, '/'), 'dvd'], { ...options, onOutputStart });
  } else {
    await fs.writeFile(path.join(cwd, 'disc.meta'), blurayMeta(audioPlan, fps), 'utf8');
    await runNative(nativePaths.tsmuxer, ['disc.meta', outPath], { ...options, onOutputStart });
  }
  abortIfNeeded(signal);
  return verifyDiscIso(format, outPath);
}

module.exports = { DISC_FORMATS, discEncoding, prepareDiscOutput, cleanupDiscOutput, nativeDiscPaths, finalizeDiscOutput, dvdAuthorXml, blurayMeta, verifyDiscIso };

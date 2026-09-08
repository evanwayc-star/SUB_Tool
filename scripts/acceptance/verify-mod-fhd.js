/* 用法：node scripts/acceptance/verify-mod-fhd.js
 * 用合成場序與雙聲道音調驗收 MOD-FHD 的真實 TS 成品；輸出留在系統 temp。
 * 走正式 buildDeliveryArgv + watchdog，驗證封裝收尾在 lease 釋放前完成。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const { buildDeliveryArgv, _normaliseExportTimecodeWatermark } = require('../../electron/export-plan');
const { spawnExportWatchdog } = require('../../electron/export-watchdog');
const { listLeases } = require('../../electron/export-lease');

const root = path.resolve(__dirname, '../..');
const ffmpeg = path.join(root, 'electron/ffmpeg/ffmpeg.exe');
const ffprobe = path.join(root, 'electron/ffmpeg/ffprobe.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-mod-fhd-'));
const duration = 90 * 1001 / 30000;
function ff(args, binary = false) {
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    windowsHide: true, encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}
function probe(file) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_programs', '-show_format', '-of', 'json', file], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }));
}

function inspectTransport(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.length % 188, 0);
  const pcr = [], pat = [], audioFrames = [];
  let pes = [];
  const finishPes = () => {
    if (!pes.length) return;
    const p = Buffer.concat(pes); pes = [];
    assert.equal(p.readUIntBE(0, 3), 1);
    const end = 6 + p.readUInt16BE(4);
    let cursor = 9 + p[8];
    while (cursor < end) {
      assert.equal(p[cursor], 255);
      assert.equal(p[cursor + 1] & 0xfe, 0xf8); // MPEG-2, layer=0
      assert.equal(p[cursor + 1] & 1, 1); // no CRC
      assert.equal(p[cursor + 2] >> 6, 1); // AAC LC
      assert.equal((p[cursor + 2] >> 2) & 15, 3); // 48 kHz
      const size = ((p[cursor + 3] & 3) << 11) | (p[cursor + 4] << 3) | (p[cursor + 5] >> 5);
      assert.ok(size >= 7 && cursor + size <= end);
      audioFrames.push(size);
      cursor += size;
    }
    assert.equal(cursor, end);
  };
  for (let offset = 0; offset < data.length; offset += 188) {
    const p = data.subarray(offset, offset + 188);
    assert.equal(p[0], 0x47);
    const pid = ((p[1] & 31) << 8) | p[2];
    const adaptation = (p[3] >> 4) & 3;
    if (pid === 0 && (p[1] & 64)) pat.push(offset);
    if ((adaptation & 2) && p[4] >= 7 && (p[5] & 16)) {
      assert.equal(pid, 4131);
      const base = p[6] * 33554432 + p[7] * 131072 + p[8] * 512 + p[9] * 2 + (p[10] >> 7);
      pcr.push({ offset, tick: base * 300 + ((p[10] & 1) << 8) + p[11] });
    }
    if (pid !== 4130 || !(adaptation & 1)) continue;
    if (p[1] & 64) finishPes();
    const start = 4 + ((adaptation & 2) ? p[4] + 1 : 0);
    pes.push(p.subarray(start));
  }
  finishPes();
  assert.ok(audioFrames.length > 100);
  assert.ok(pcr.length > 50);
  const rates = pcr.slice(1).map((p, i) => (p.offset - pcr[i].offset) * 8 * 27000000 / (p.tick - pcr[i].tick));
  assert.ok(rates.every(r => Math.abs(r - 7980000) < 50), 'PCR 對應封包率必須為 7.98 Mbps');
  assert.ok(pcr.slice(1).every((p, i) => (p.tick - pcr[i].tick) / 27000000 < 0.041), 'PCR 間隔');
  assert.ok(pat.slice(1).every((p, i) => (p - pat[i]) * 8 / 7980000 < 0.101), 'PAT 間隔');
  assert.ok(pat.length > 20);
  assert.ok(audioFrames.every(n => n > 7));
  const aacKbps = audioFrames.reduce((a,b) => a+b, 0) * 8 / (audioFrames.length * 1024 / 48000) / 1000;
  assert.ok(Math.abs(aacKbps - 256) < 20, 'AAC 平均碼率應接近 256 kbps');
  return { packets: data.length / 188, pcrCount: pcr.length, muxBitrate: rates[0], aacFrames: audioFrames.length, aacKbps };
}

async function verify(source, name, overlay) {
  const outPath = path.join(dir, `${name}.ts`);
  const font = fs.readdirSync(path.join(root, 'font'), { recursive: true }).find(f => /sarasa.*\.ttf$/i.test(f));
  const plan = buildDeliveryArgv({ format: 'mod-fhd', width: 640, height: 360, fps: 25,
    videoKbps: 1000, duration, outPath,
    clips: [{ path: source, type: 'video', in: 0, out: duration, offset: 0, natW: 640, natH: 360, fps: 29.97 }],
    ...(overlay ? { assFileName: 'burn.ass', timecodeWatermark: _normaliseExportTimecodeWatermark({ start: '00:00:12:00' }, 29.97) } : {}),
  }, { timecodeFontFile: font && path.join(root, 'font', font), hasAudioStream: () => true });
  let log = '';
  const controller = spawnExportWatchdog({ ffmpegPath: ffmpeg, args: plan.args, cwd: dir,
    outPath, outputFormat: 'mod-fhd', jobId: `export-mod-${name}`, queueDir: path.join(dir, 'queue'),
  }, { onStderr: chunk => { log += chunk.toString(); } });
  await controller.ready;
  const result = await controller.completion;
  fs.writeFileSync(path.join(dir, `${name}.log`), log);
  assert.ok(result.ok, JSON.stringify(result) + '\n' + log.slice(-2500));
  assert.equal(listLeases(path.join(dir, 'queue')).length, 0);
  const info = probe(outPath);
  const v = info.streams.find(s => s.codec_type === 'video');
  const a = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(info.format.format_name, 'mpegts');
  assert.equal(v.codec_name, 'h264'); assert.equal(v.profile, 'High'); assert.equal(v.level, 41);
  assert.equal(v.width, 1920); assert.equal(v.height, 1080); assert.equal(v.field_order, 'tt');
  assert.equal(v.avg_frame_rate, '30000/1001'); assert.equal(v.sample_aspect_ratio, '1:1');
  assert.equal(a.codec_name, 'aac'); assert.equal(a.profile, 'LC'); assert.equal(a.channels, 2);
  assert.equal(a.sample_rate, '48000'); assert.equal(a.tags.language, 'eng');
  assert.equal(info.programs[0].pmt_pid, 1280); assert.equal(info.programs[0].pcr_pid, 4131);
  assert.equal(parseInt(v.id), 4131); assert.equal(parseInt(a.id), 4130);
  assert.ok(Math.abs(Number(v.duration) - duration) < 0.05);
  const headerTrace = spawnSync(ffmpeg, ['-hide_banner', '-i', outPath, '-map', '0:v:0', '-c', 'copy',
    '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(headerTrace.status, 0);
  const trace = headerTrace.stderr;
  for (const key of ['mb_adaptive_frame_field_flag', 'nal_hrd_parameters_present_flag', 'entropy_coding_mode_flag']) {
    assert.match(trace, new RegExp(`${key}[^\\r\\n]+ = 1`));
  }
  assert.match(trace, /max_num_ref_frames[^\r\n]+ = 4/);
  assert.match(trace, /cbr_flag\[0\][^\r\n]+ = 1/);
  const frameInfo = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=key_frame,pict_type', '-of', 'json', outPath], { windowsHide: true, encoding: 'utf8' })).frames;
  assert.equal(frameInfo.length, 90);
  const keyframes = frameInfo.flatMap((f,i) => f.key_frame ? [i] : []);
  assert.equal(keyframes[0], 0);
  const boundaries = [...keyframes, frameInfo.length];
  assert.ok(boundaries.slice(1).every((n,i) => n - boundaries[i] <= 32));
  let bCount = 0;
  for (const frame of frameInfo) { bCount = frame.pict_type === 'B' ? bCount + 1 : 0; assert.ok(bCount <= 2); }
  if (overlay) ff(['-i', outPath, '-vf', 'select=eq(n\\,60),crop=420:90:0:0', '-frames:v', '1',
    path.join(dir, `${name}-tc-frame60.png`)]);
  ff(['-i', outPath, '-f', 'null', '-']); // 整支完整解碼
  const pixels = ff(['-i', outPath, '-vf', 'crop=16:16:960:500,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], true);
  const mean = parity => [...pixels].filter((_, i) => Math.floor(i / 16) % 2 === parity).reduce((a,b) => a+b,0) / 128;
  assert.ok(mean(1) - mean(0) > 100, `場序應上暗下亮：${mean(0)} / ${mean(1)}`);
  const summary = { name, outPath, video: { codec: v.codec_name, profile: v.profile, level: v.level, fieldOrder: v.field_order,
    fps: v.avg_frame_rate, duration: v.duration }, audio: { codec: a.codec_name, sampleRate: a.sample_rate, channels: a.channels },
    fieldMeans: [mean(0), mean(1)], keyframes, transport: inspectTransport(outPath) };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

(async () => {
  const progressive = path.join(dir, 'fields-progressive.mov');
  const interlaced = path.join(dir, 'fields-interlaced.mov');
  ff(['-f', 'lavfi', '-i', `nullsrc=s=640x360:r=60000/1001:d=${duration},geq=lum='if(mod(N,2),200,32)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', `aevalsrc=0.15*sin(2*PI*440*t)|0.15*sin(2*PI*880*t):s=48000:d=${duration}`,
    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', progressive]);
  ff(['-i', progressive, '-vf', 'tinterlace=mode=interleave_top', '-c:v', 'libx264', '-crf', '10',
    '-flags:v', '+ilme+ildct', '-x264-params', 'tff=1', '-c:a', 'copy', interlaced]);
  fs.writeFileSync(path.join(dir, 'burn.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\nStyle: Default,Arial,48,&H00FFFFFF,2\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:03.00,Default,MOD-FHD\n');
  const results = [await verify(progressive, 'progressive-with-tc', true), await verify(interlaced, 'interlaced', false)];
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: ${dir}`);
})().catch(error => { console.error(error); console.error(`Evidence: ${dir}`); process.exitCode = 1; });

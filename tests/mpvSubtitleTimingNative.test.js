// @subtool-ci windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { renderASS } from '../src/formats.js';
import { Seq } from '../src/sequence.js';
import { mpvSubtitleTiming } from '../src/sequence-time.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const { ffmpeg } = nativeTestTools();
const mpv = process.env.MPV_PATH || path.resolve('electron/mpv/mpv.exe');
const width = 256, height = 144, pixels = width * height;

// Encode the frame number into the top eight cells. The subtitle is the
// only bright content below the center, even when decoding in reverse.
function sourceFrames(count) {
  const bytes = Buffer.alloc(pixels * count);
  for (let n = 0; n < count; n++) {
    for (let bit = 0; bit < 8; bit++) {
      if (!(n & (1 << bit))) continue;
      for (let y = 0; y < 8; y++) {
        const x = n * pixels + y * width + bit * 10;
        bytes.fill(255, x, x + 8);
      }
    }
  }
  return bytes;
}

describe.skipIf(process.platform !== 'win32' || !fs.existsSync(ffmpeg) || !fs.existsSync(mpv))('mpv subtitle frame pixels', () => {
  it.each([
    { fps: 30, sourceRate: '60000/1001', offset: 394.394, start: 395.5, seen: [66, 67], reverse: false },
    { fps: 25, sourceRate: '50', offset: 0, start: 1, seen: [50, 51], reverse: true },
  ])('honors the project frame and both half-frame ties ($sourceRate, reverse=$reverse)', ({fps, sourceRate, offset, start, seen, reverse}) => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(tempRoot, 'subtool-mpv-sub-cadence-'));
    const run = {cwd:dir, windowsHide:true, timeout:20_000, maxBuffer:8 * 1024 * 1024};
    try {
      const count = 100;
      execFileSync(ffmpeg, ['-v','error','-f','rawvideo','-pixel_format','gray','-video_size',width+'x'+height,
        '-framerate',sourceRate,'-i','pipe:0','-c:v','libx264','-g','1','-pix_fmt','yuv420p','source.mp4'],
      {...run,input:sourceFrames(count)});
      const clip = {in:0,out:2,offset,speed:1,reverse};
      const cue = {id:'cue',start,end:start + 1/fps,track:0,timed:true,text:'FRAME TEST'};
      const timing = mpvSubtitleTiming(clip, fps);
      const ranges = Seq.timedRangesForSource([cue],clip).map(timing.range);
      fs.writeFileSync(path.join(dir,'preview.ass'),renderASS(ranges,{fps}));
      execFileSync(mpv, ['--no-config','--no-audio','--no-terminal','--untimed','--vo=image','--vo-image-format=png',
        '--vo-image-outdir=images','--sub-file=preview.ass','--sub-speed='+timing.clock.speed,'--sub-delay='+timing.clock.origin,
        ...(reverse ? ['--play-dir=backward','--start=100%'] : []),'source.mp4'],run);
      const raw = execFileSync(ffmpeg,['-v','error','-i','images/%08d.png','-pix_fmt','gray','-f','rawvideo','pipe:1'],run);
      const ids = [], visible = [];
      for (let frame = 0; frame < raw.length; frame += pixels) {
        let n = 0;
        for (let bit = 0; bit < 8; bit++) if (raw[frame + 4*width + 10*bit + 4] > 128) n |= 1 << bit;
        ids.push(n);
        if (raw.subarray(frame + pixels / 2, frame + pixels).some(value => value > 150)) visible.push(n);
      }
      for (const n of [seen[0]-1,...seen,seen.at(-1)+1]) expect(ids).toContain(n);
      expect(visible).toEqual(reverse ? [...seen].reverse() : seen);
    } finally {
      if (fs.realpathSync(dir) === dir && path.dirname(dir) === tempRoot
        && path.basename(dir).startsWith('subtool-mpv-sub-cadence-')) fs.rmSync(dir,{recursive:true,force:true});
    }
  });
});

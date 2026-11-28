import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { buildIngestArgs } = require('../electron/ffmpeg-execution-engine.js');
const { encodeCheckpointedProxy } = require('../electron/preview-proxy-checkpoints.js');

const option = (args, name) => args[args.indexOf(name) + 1];
const input = {
  src: 'camera.mov', needsProxy: true, proxyPath: 'proxy.mp4', encoder: 'libx264',
  channels: [{ file: 'channel.m4a' }], chMaps: ['0:a:0'],
};

describe('preview MP4 timecode tracks', () => {
  it.each([false, true])('suppresses the synthetic timecode track only for the preview output (stream=%s)', isStream => {
    const args = buildIngestArgs({ ...input, isStream });
    const proxy = args.indexOf(input.proxyPath);
    expect(option(args.slice(0, proxy), '-write_tmcd')).toBe('0');
    expect(args.slice(proxy + 1)).not.toContain('-write_tmcd');
    expect(buildIngestArgs({ ...input, needsProxy: false })).not.toContain('-write_tmcd');
  });

  it('suppresses tmcd when copying a prefix, encoding parts and joining with old checkpoint receipts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtool-proxy-tmcd-'));
    try {
      const proxy = path.join(dir, 'proxy.mp4');
      const args = buildIngestArgs({ ...input, proxyPath: proxy });
      const plan = { dir, args, meta: { proxy }, assertRetryOwner() {} };
      const execute = vi.fn(async (argv, { outputDescriptor }) => {
        if (argv.includes('-vf')) {
          const firstTick = option(argv, '-vf').match(/trim=start_pts=(\d+)/)[1];
          fs.writeFileSync(outputDescriptor, firstTick);
        }
      });
      const job = {
        plan, request: { src: input.src, duration: 2.002 }, video: { streamStart: 0 },
        sourceContent: { sha256: 'camera' }, seconds: 1, execute,
        prefix: { path: path.join(dir, 'stream.mp4'), end: 0.5005, verify() {} },
        describe: file => ({ video: { presentationTimestampOffset: -Number(fs.readFileSync(file, 'utf8')) / 1e6 } }),
        verify() {}, progress() {},
      };
      // Seed the receipt with the previous unmodified ingest argv.
      const legacyArgs = args.slice();
      legacyArgs.splice(legacyArgs.indexOf('-write_tmcd'), 2);
      await encodeCheckpointedProxy({ ...job, plan: { ...plan, args: legacyArgs } });
      const firstPass = execute.mock.calls.map(([argv]) => argv);
      expect(firstPass).toHaveLength(4); // prefix, two parts, assembly
      for (const argv of firstPass) {
        const outputIndex = argv.indexOf(proxy);
        const mp4 = outputIndex < 0 ? argv : argv.slice(0, outputIndex);
        expect(option(mp4, '-write_tmcd')).toBe('0');
        expect(option(mp4, '-video_track_timescale')).toBe('1000000');
        expect(option(mp4, '-movie_timescale')).toBe('1000000');
      }
      expect(firstPass.at(-1).slice(firstPass.at(-1).indexOf(proxy) + 1)).not.toContain('-write_tmcd');

      execute.mockClear();
      await encodeCheckpointedProxy(job);
      expect(execute.mock.calls.map(([argv]) => option(argv, '-c:v'))).toEqual(['copy', 'copy']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

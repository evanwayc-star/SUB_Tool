// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDeliveryList } from '../src/delivery-list.js';
import { buildExportJobs, freezeExportSubmission, subtitleCuesForSubmission, runFrozenExportSubmission } from '../src/subio.js';
import { runVideoExportCommand, videoExportCapability } from '../src/export-job-engine.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const snapshot = {
  clips: [{ id: 'program', path: 'C:/master/program.mov', type: 'video', in: 10, out: 14, offset: 0, vtrack: 0 }],
  videoTracks: [{ vt: 0, scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }],
  timelineStart: 10,
  duration: 4,
  audioPlan: { streams: [] },
  audioOnly: false,
};

describe('frozen export submission', () => {
  it('keeps subtitles, track visibility, fps, and timecode from the moment the work is submitted', () => {
    const source = {
      cues: [{ id: 'cue-1', start: 11, end: 12, text: '已凍結', track: 0 }],
      tracks: [{ name: '對白', visible: true }],
      fps: 25,
      dropFrame: false,
      mediaName: 'program.mov',
      canvasW: 1920,
      canvasH: 1080,
      defaultAudioLayout: { streams: [] },
      hasCustomRange: true,
    };
    const submission = freezeExportSubmission(snapshot, source);
    source.cues[0].text = '送出後修改';
    source.tracks[0].visible = false;
    source.fps = 29.97;

    const list = createDeliveryList({
      projectTag: 'program', fps: submission.fps, canvasW: submission.canvasW, canvasH: submission.canvasH,
      desktop: true,
    });
    list.setOutDir(0, 'D:/deliverables');
    list.setBurnTimecode(0, true);
    const submittedList = createDeliveryList({
      projectTag: 'program', fps: submission.fps, canvasW: submission.canvasW, canvasH: submission.canvasH,
      desktop: true,
      initial: structuredClone(list.rows()),
    });
    // Simulate an edit made after clicking submit while the async overwrite
    // check is still in flight.  It must not change the already captured row.
    list.setFormat(0, 'prores');
    list.setName(0, 'after-click.mov');

    const [job] = buildExportJobs(submission, submittedList);

    expect(job.assText).toContain('已凍結');
    expect(job.assText).not.toContain('送出後修改');
    expect(job.subtitleTracks).toEqual(['對白']);
    expect(job.fps).toBe(25);
    expect(job.timecodeWatermark).toEqual({ start: '00:00:10:00' });
    expect(job.format).toBe('h264');
    expect(job.defaultName).toMatch(/\.mp4$/);
  });

  it('freezes the preview-matched subtitle background geometry into the queued ASS', () => {
    const source = {
      cues: [{ id: 'boxed', start: 11, end: 12, text: '短行\n較長的第二行', track: 0 }],
      tracks: [{ name: '對白', visible: true, bgBox: true, bgColor: '#000000', bgAlpha: 0.5 }],
      backgroundLayouts: {
        'boxed': {
          lineIndex: 1,
          height: 140,
          offsetY: -70,
          textLines: [{ x: 960, cy: 972, hAlign: 5 }, { x: 960, cy: 1002, hAlign: 5 }],
        },
      },
      fps: 25,
    };
    const submission = freezeExportSubmission(snapshot, source);
    source.backgroundLayouts.boxed.lineIndex = 0;
    const list = createDeliveryList({ projectTag: 'program', desktop: true });
    list.setOutDir(0, 'D:/deliverables');

    const [job] = buildExportJobs(submission, list);

    expect(submission.backgroundLayouts.boxed.lineIndex).toBe(1);
    expect(job.assText).toContain('Track0_Text');
    expect(job.assText).toContain('\\q2');
    expect(job.assText).toContain('較長的第二行');
  });

  it('captures project and delivery rows before asynchronous conflict I/O', async () => {
    let resolveConflict;
    const conflictGate = new Promise(resolve => { resolveConflict = resolve; });
    const live = { project: 'A', rows: [{ name: 'A.mp4' }] };
    let dispatched;

    const pending = runFrozenExportSubmission({
      capture: () => structuredClone(live),
      checkConflicts: async frozen => {
        expect(frozen).toEqual({ project: 'A', rows: [{ name: 'A.mp4' }] });
        await conflictGate;
        return true;
      },
      dispatch: async frozen => { dispatched = frozen; },
    });
    live.project = 'B';
    live.rows[0].name = 'B.mp4';
    resolveConflict();

    await expect(pending).resolves.toEqual({ status: 'submitted', value: undefined });
    expect(dispatched).toEqual({ project: 'A', rows: [{ name: 'A.mp4' }] });
  });

  it('derives queue subtitle metadata from the same visible in-range cues rendered into ASS', () => {
    const submission = freezeExportSubmission(snapshot, {
      cues: [
        { id: 'before', start: 9, end: 10, text: 'range 前', track: 0 },
        { id: 'hidden', start: 11, end: 12, text: '隱藏', track: 1 },
        { id: 'after', start: 14, end: 15, text: 'range 後', track: 2 },
        { id: 'overlap', start: 9.5, end: 10.5, text: '實際燒入', track: 3 },
      ],
      tracks: [
        { name: '之前', visible: true },
        { name: '隱藏軌', visible: false },
        { name: '之後', visible: true },
        { name: '對白', visible: true },
      ],
      fps: 25,
    });
    const list = createDeliveryList({ projectTag: 'program', desktop: true });
    list.setOutDir(0, 'D:/deliverables');

    expect(subtitleCuesForSubmission(submission)).toEqual([
      expect.objectContaining({ id: 'overlap', start: 0, end: 0.5 }),
    ]);
    const [job] = buildExportJobs(submission, list);
    expect(job.assText).toContain('實際燒入');
    expect(job.assText).not.toContain('range 前');
    expect(job.assText).not.toContain('隱藏');
    expect(job.assText).not.toContain('range 後');
    expect(job.subtitleTracks).toEqual(['對白']);
  });

  it('reports no burned subtitle tracks when no Dialogue is emitted', () => {
    const submission = freezeExportSubmission(snapshot, {
      cues: [], tracks: [{ name: '空軌', visible: true }], fps: 25,
    });
    const list = createDeliveryList({ projectTag: 'program', desktop: true });
    list.setOutDir(0, 'D:/deliverables');

    const [job] = buildExportJobs(submission, list);
    expect(job.assText).toBeNull();
    expect(job.subtitleTracks).toEqual([]);
  });

  it('fails closed for the unsupported web video delivery surface', () => {
    expect(videoExportCapability(false)).toEqual({
      supported: false,
      message: '網頁版不支援影片／多聲道 WAV 交付，請使用 Electron 桌面版',
    });
    expect(videoExportCapability(true).supported).toBe(true);
  });

  it('does not let the web keyboard command enter the video export handler', async () => {
    const opened = [];
    const notices = [];
    await expect(runVideoExportCommand({
      isDesktop: false,
      openExport: () => { opened.push('opened'); },
      notify: message => notices.push(message),
    })).resolves.toBe(false);

    expect(opened).toEqual([]);
    expect(notices).toEqual(['網頁版不支援影片／多聲道 WAV 交付，請使用 Electron 桌面版']);
  });

  it('keeps the desktop-only delivery button hidden until desktop initialization', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html;
    const button = document.querySelector('[data-act="exp-video"]');
    expect(button).not.toBeNull();
    expect(getComputedStyle(button).display).toBe('none');
  });
});

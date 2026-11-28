// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assToSec } from '../src/time.js';

let State, StateModule, History, Subio, Timeline, Subtitles, Renderer, Media, audit;
let unsubscribe;
const bridge = { launch: vi.fn(async () => ({ ok: true, sourceSessionId: 'shift-fixture', duration: 6000 })),
  subSet: vi.fn(async () => true), pause: vi.fn(async () => true), play: vi.fn(async () => true),
  seek: vi.fn(async () => true), loadfile: vi.fn(async () => true),
  setGuide: vi.fn(async () => true), setImageGuide: vi.fn(async () => true),
  setTimecodeWatermark: vi.fn(async () => true), setViewport: vi.fn(async () => true) };

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'), 'text/html').body.innerHTML;
  window.subtool = { isDesktop: true, mpv: bridge };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => new Proxy({ measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  Object.defineProperty(document.getElementById('tlScroll'), 'clientWidth', { configurable: true, value: 600 });
  StateModule = await import('../src/state.js'); ({ State } = StateModule);
  ({ History } = await import('../src/history.js'));
  Subio = await import('../src/subio.js'); Timeline = await import('../src/timeline-renderer.js');
  Subtitles = await import('../src/subtitles.js'); Renderer = await import('../src/video-renderer.js');
  audit = await import('../src/subtitle-audit.js'); ({ Media } = await import('../src/media.js'));
  const { resetPlayerAdapter } = await import('../src/media-player-adapter.js');
  await resetPlayerAdapter(window.subtool).enterMpv({ src: 'fixture.mov' });
  const { on } = await import('../src/events.js');
  on('render:videoSub', Renderer.renderVideoSub);
  on('mpv:refreshSubs', Renderer.refreshMpvSubs);
  // Real app render:all composition; no import of the bootstrap or native app.
  unsubscribe = on('render:all', () => {
    Subtitles.renderSubList(); Timeline.renderCueBlocks(); Renderer.renderVideoSub(); Subtitles.updateTlSel(); Renderer.refreshMpvSubs();
  });
});
beforeEach(() => {
  vi.clearAllTimers(); vi.clearAllMocks();
  Object.assign(State, { tracks: [{ name: '字幕', visible: true, locked: false }], cues: [], notes: [], listTrack: 0,
    trackCount: 1, clips: [], externalAudioState: [], videoTracks: [{ name: '影片', visible: true }], fps: 25,
    dropFrame: false, duration: 6000, playing: true, currentTime: 0, viewStart: 0, pxPerSec: 10, presetEdit: null, safeFrame: false });
  StateModule.clearSelection();
  document.getElementById('subStyleFilter').value = '';
  document.getElementById('tcShiftSel').value = 'all';
  document.getElementById('tlTracks').innerHTML = '<div class="tl-track" data-track="0"></div>';
  History.reset();
});
afterAll(() => { unsubscribe?.(); vi.clearAllTimers(); vi.useRealTimers(); });

it('refreshes the paused subtitle, its measured background and mpv ASS when a font is registered or replaced under the same name', async () => {
  const { loadFonts, assFontName } = await import('../src/substyle.js');
  const { measureSubtitleBackgroundLayouts } = await import('../src/subtitle-background-layout.js');
  const alias = 'Imported Font';
  State.tracks[0].font = alias;
  State.tracks[0].bgBox = true;
  State.playing = false;
  State.cues = [{ id: 'font-preview', start: 0, end: 5, text: 'WWW\niiiii', track: 0 }];
  History.reset();

  const source = { name: alias, file: 'imported.ttf', family: 'First Family' };
  window.subtool.fontsList = async () => ({ fonts: [{ ...source }] });
  window.subtool.fileURL = async () => 'font-url';
  const fontsProperty = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: new Set() });
  vi.stubGlobal('FontFace', class { async load() { return this; } });
  vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }));

  const bounds = HTMLElement.prototype.getBoundingClientRect;
  const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.parentElement?.hasAttribute('data-subtitle-background-measure')) return bounds.call(this);
    // Changing the face reverses which line owns the background despite identical text and CSS.
    const wideW = assFontName(alias) === 'First Family';
    return { width: (this.textContent === 'WWW') === wideW ? 100 : 50, height: 20 };
  });
  const currentLine = () => document.querySelector('#videoSub .line');
  const widest = () => measureSubtitleBackgroundLayouts(State.cues, State.tracks)['font-preview'].lineIndex;
  try {
    Renderer.renderVideoSub();
    const fallback = currentLine();
    expect(fallback?.textContent).toBe('WWWiiiii');
    expect(widest()).toBe(1);
    await loadFonts();
    await vi.advanceTimersByTimeAsync(160);
    const first = currentLine();
    expect(first).not.toBe(fallback);
    expect(widest()).toBe(0);
    expect(bridge.subSet.mock.lastCall[0]).toContain('Style: Track0,First Family,');

    source.family = 'Replacement Family';
    await loadFonts(true);
    await vi.advanceTimersByTimeAsync(160);
    expect(currentLine()).not.toBe(first);
    expect(widest()).toBe(1);
    expect(bridge.subSet.mock.lastCall[0]).toContain('Style: Track0,Replacement Family,');
    expect(History.stack).toHaveLength(1);
  } finally {
    measured.mockRestore();
    vi.unstubAllGlobals();
    if (fontsProperty) Object.defineProperty(document, 'fonts', fontsProperty);
    else delete document.fonts;
    delete window.subtool.fontsList;
    delete window.subtool.fileURL;
  }
});

describe('batch subtitle shifts and preview work', () => {
  it('shifts all cues, refreshes actual ASS once, and leaves transport and playback intent unchanged', async () => {
    State.cues = Array.from({ length: 80 }, (_, index) => ({ id: `cue-${index}`, start: 2 * index, end: 2 * index + 1, text: `字幕 ${index}`, track: 0 }));
    History.reset(); document.getElementById('tcShiftInput').value = '00:00:02:00';
    Subio.applyTcShift(1);
    await vi.advanceTimersByTimeAsync(160);
    expect(State.cues.map(cue => [cue.start, cue.end])).toEqual(Array.from({ length: 80 }, (_, index) => [2 * index + 2, 2 * index + 3]));
    expect(History.stack).toHaveLength(2);
    expect(bridge.subSet).toHaveBeenCalledTimes(1);
    const [ass,,clock] = bridge.subSet.mock.calls[0];
    const dialogue = ass.split(/\r?\n/).filter(line=>line.startsWith('Dialogue:'));
    expect(dialogue).toHaveLength(80);
    for (const [index,line] of dialogue.entries()) {
      const [,start,end] = line.split(',');
      const on = clock.origin + assToSec(start)*clock.speed;
      const off = clock.origin + assToSec(end)*clock.speed;
      const cue = State.cues[index];
      expect(on).toBeGreaterThan(cue.start - 1 / State.fps);
      expect(on).toBeLessThanOrEqual(cue.start);
      expect(off).toBeGreaterThan(cue.end - 1 / State.fps);
      expect(off).toBeLessThanOrEqual(cue.end);
    }
    expect(State.playing).toBe(true);
    for (const command of ['launch', 'pause', 'play', 'seek', 'loadfile']) expect(bridge[command]).not.toHaveBeenCalled();
  });
  it('keeps overlap DOM bounded when a backwards shift clamps many subtitles to the first frame', () => {
    const count = 60;
    State.cues = Array.from({ length: count }, (_, index) => ({ id: `cue-${index}`, start: index + 1, end: index + 1.5, text: `字幕 ${index}`, track: 0 }));
    History.reset(); document.getElementById('tcShiftInput').value = '00:10:00:00';
    Subio.applyTcShift(-1);
    expect(State.cues.every(cue => cue.start === 0 && cue.end === 1 / 25)).toBe(true);
    expect(document.querySelectorAll('.cue-block')).toHaveLength(count);
    const overlaps = [...document.querySelectorAll('.cue-overlap')];
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps.length).toBeLessThanOrEqual(count - 1);
    expect(History.stack).toHaveLength(2);
  });
  it('preserves every visible overlap range against a pairwise oracle without enumerating every pair', () => {
    const cues = [
      { id: 'a', start: 0, end: 10, track: 0 }, { id: 'b', start: 2, end: 5, track: 0 },
      { id: 'c', start: 3, end: 8, track: 0 }, { id: 'd', start: 9, end: 12, track: 0 },
      { id: 'touch', start: 12, end: 13, track: 0 }, { id: 'other', start: 1, end: 8, track: 1 },
      { id: 'untimed', start: 0, end: 20, track: 0, timed: false }
    ];
    const ranges = audit.subtitleOverlapRanges(cues, { start: 2.5, end: 11 });
    expect(ranges.length).toBeLessThan(cues.length);
    for (let time = 0; time <= 14; time += .125) {
      const active = cues.filter(cue => cue.timed !== false && cue.track === 0 && cue.start <= time && cue.end > time);
      const warning = ranges.some(range => range.track === 0 && range.start <= time && range.end > time);
      expect(warning, `time ${time}`).toBe(time >= 2.5 && time < 11 && active.length >= 2);
    }
    for (const range of ranges) {
      const pair = [range.id1, range.id2].map(id => cues.find(cue => cue.id === id));
      expect(pair.every(cue => cue.track === range.track && cue.start <= range.start && cue.end >= range.end)).toBe(true);
    }
    expect(audit.subtitleOverlapRanges(Array.from({ length: 2000 }, (_, index) => ({ id: `dense-${index}`, start: 0, end: .04 })))).toHaveLength(1999);
  });
  it('keeps an overlap selectable in both directions between its actual subtitle pair', () => {
    State.cues = [{ id: 'first', start: 0, end: 4, text: '第一句', track: 0 },
      { id: 'second', start: 2, end: 6, text: '第二句', track: 0 }];
    Timeline.renderCueBlocks();
    const seek = vi.spyOn(Media, 'seek').mockResolvedValue(true);
    try {
      const overlap = document.querySelector('.cue-overlap');
      expect(overlap.dataset).toMatchObject({ id1: 'first', id2: 'second' });
      expect(overlap.style.left).toBe('20px'); expect(overlap.style.width).toBe('20px');
      overlap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2, clientX: 30 }));
      expect(State.selectedId).toBe('first');
      document.querySelector('.cue-overlap').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2, clientX: 30 }));
      expect(State.selectedId).toBe('second');
    } finally { seek.mockRestore(); }
  });
});

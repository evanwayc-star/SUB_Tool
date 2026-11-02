// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';

let State, Subtitles, SubFormats, analyzeSubtitles;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync('index.html', 'utf8'), 'text/html').body.innerHTML;
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('src/styles.css', 'utf8');
  document.head.appendChild(style);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}) }));
  ({ State } = await import('../src/state.js'));
  Subtitles = await import('../src/subtitles.js');
  ({ SubFormats } = await import('../src/formats.js'));
  ({ analyzeSubtitles } = await import('../src/subtitle-audit.js'));
});

beforeEach(() => {
  Object.assign(State, {
    tracks: [{ name: '字幕軌', visible: true, locked: false }], listTrack: 0,
    cues: [], selectedId: null, selectedIds: [], clips: [], notes: [], presetEdit: null,
    videoTracks: [{ visible: true }], externalAudioState: [], fps: 25, dropFrame: false,
  });
  document.getElementById('subStyleFilter').value = '';
});

afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  { label: '單行 URL', text: 'https://example.com/a//b', kind: 'direct', lines: 1 },
  { label: 'TXT 匯入的單行 URL', text: 'https://example.com/a//b', kind: 'txt', lines: 1 },
  { label: '單行字面雙斜線', text: '上//下', kind: 'direct', lines: 1 },
  { label: 'URL 加真正換行', text: 'https://example.com/a//b\n下一行', kind: 'direct', lines: 2 },
  { label: '三行字幕', text: '第一行\n第二行\n第三行', kind: 'direct', lines: 3 },
  { label: 'TXT 舊式換行', text: '上//下', kind: 'txt', lines: 2 },
])('$label 的列表警示與檢查結果一致', ({ text, kind, lines }) => {
  const cue = kind === 'txt' ? SubFormats.parseTXT(text)[0] : { text, start: 1, end: 2 };
  State.cues = [{ ...cue, id: 'line-count', track: 0 }];
  Subtitles.renderSubList();
  const row = document.querySelector('#sublist .sub-row');
  expect(row.classList.contains('two-line')).toBe(lines === 2);
  expect(row.classList.contains('multi-line')).toBe(lines >= 3);
  expect(row.querySelectorAll('.line-break-mark')).toHaveLength(lines - 1);
  const audit = analyzeSubtitles(State.cues, { fps: 25 });
  expect(audit.twoNums).toEqual(lines === 2 ? [1] : []);
  expect(audit.multiNums).toEqual(lines >= 3 ? [1] : []);
  if (text.startsWith('https://')) {
    expect(row.querySelector('.txt').textContent).toContain('https://example.com/a//b');
    if (lines === 1) expect(getComputedStyle(row.querySelector('.txt')).color).not.toBe('rgb(221, 68, 68)');
  }
});

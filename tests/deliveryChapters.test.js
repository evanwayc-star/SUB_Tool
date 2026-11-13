import { describe, expect, it, vi } from 'vitest';
import { createDeliveryList } from '../src/delivery-list.js';
import { chaptersForSubmission, createDeliverySubmission, freezeExportSubmission } from '../src/delivery-submission.js';
import { normalizeDeliveryChapters, serializeDeliveryChapters } from '../shared/delivery-chapters.cjs';

function project() {
  return freezeExportSubmission({ clips: [{ path: 'C:/master.mov', in: 0, out: 10, offset: 0 }],
    timelineStart: 10, duration: 10, audioOnly: false, videoTracks: [{ vt: 0 }], audioPlan: null }, {
    notes: [{ time: 9, text: '範圍外' }, { time: 12, text: '核對 #1;=\\' }, { time: 20, text: '終點不包含' }],
    cues: [
      { start: 9, end: 11, text: '跨越起點', style: { bold: false } },
      { start: 12, end: 13, text: '預設字幕' },
      { start: 12, end: 14, text: '逐句樣式', style: { italic: true } },
      { start: 15, end: 16, text: '繼承軌道', track: 1 },
      { start: 16, end: 17, text: '隱藏軌', track: 2, style: { bold: true } },
      { start: 17, end: 18, text: '未定時', timed: false, style: { bold: true } },
    ], tracks: [{}, { italic: true }, { visible: false }],
  });
}

describe('optional review chapters', () => {
  it('only exports frozen notes within the range, ignoring old custom style switches', () => {
    const p = project();
    expect(chaptersForSubmission(p)).toEqual([]);
    expect(chaptersForSubmission(p, { chapterStyled: true, customStyles: true })).toEqual([]);
    expect(chaptersForSubmission(p, { chapterNotes: true, chapterStyled: true, customStyles: true })).toEqual([
      { start: 0, end: 2, title: '影片開始' },
      { start: 2, end: 10, title: '備註：核對 #1;=\\', kind: 'note' },
    ]);
  });

  it('removes frozen legacy styled-only chapters including their generated opening chapter', () => {
    const old = [{ start: 0, title: '影片開始' }, { start: 2, title: '自訂字幕：舊字幕' }, { start: 4, title: '自訂字幕：另一句' }];
    expect(normalizeDeliveryChapters(old, 10, 'h264')).toEqual([]);
    expect(serializeDeliveryChapters(old, 10, 'prores')).toBeNull();
    expect(normalizeDeliveryChapters([...old, { start: 6, title: '備註：仍要保留' }], 10, 'h264')).toEqual([
      { start: 0, end: 6, title: '影片開始' }, { start: 6, end: 10, title: '備註：仍要保留' },
    ]);
  });

  it('does not guess how to split ambiguous legacy note/style titles', () => {
    expect(() => normalizeDeliveryChapters([{ start: 1, title: '備註：文字 ／ 自訂字幕：可能也是備註原文' }], 10, 'h264'))
      .toThrow('重新加入');
  });

  it('preserves arbitrary typed note text across repeated normalization and serialization', () => {
    const p = project(); p.notes = [{ time: 11, text: '原文 ／ 自訂字幕：這仍是備註 #;=' }];
    const chapters = chaptersForSubmission(p, { chapterNotes: true });
    expect(chapters[1]).toEqual({ start: 1, end: 10, kind: 'note', title: '備註：原文 ／ 自訂字幕：這仍是備註 #;=' });
    expect(normalizeDeliveryChapters(normalizeDeliveryChapters(chapters, 10, 'h264'), 10, 'prores')).toEqual(chapters);
    expect(serializeDeliveryChapters(chapters, 10, 'h264')).toContain('title=備註：原文 ／ 自訂字幕：這仍是備註 \\#\\;\\=');
  });

  it('keeps typed note provenance when an old opening marker shares its millisecond', () => {
    const title = '備註：原文 ／ 自訂字幕：保留';
    const clean = normalizeDeliveryChapters([{ start: 0, title: '影片開始' }, { start: 0.0001, title, kind: 'note' }], 1, 'h264');
    expect(clean).toEqual([{ start: 0, end: 1, title: `影片開始 ／ ${title}`, kind: 'note' }]);
    expect(normalizeDeliveryChapters(clean, 1, 'h264')).toEqual(clean);
    expect(serializeDeliveryChapters(clean, 1, 'prores')).toContain(`title=影片開始 ／ ${title}`);
  });

  it('drops obsolete style switches when restoring delivery rows and keeps the note choice', () => {
    const first = createDeliveryList({ projectTag: 'review', fps: 25, canvasW: 64, canvasH: 48 });
    const initial = first.rows().map(row => ({ ...row, chapterNotes: true, chapterStyled: true, customStyles: true }));
    const restored = createDeliveryList({ projectTag: 'review', fps: 25, canvasW: 64, canvasH: 48, initial });
    restored.setChapterOptions(0, { chapterStyled: true, customStyles: true });
    expect(restored.get(0).chapterNotes).toBe(true);
    expect(restored.get(0)).not.toHaveProperty('chapterStyled'); expect(restored.get(0)).not.toHaveProperty('customStyles');
  });

  it('rounds/merges millisecond markers, preserves Unicode and escapes metadata controls', () => {
    const chapters = [{ start: 0.0001, title: '海#;=\\\n檢查' }, { start: 0.0002, title: '重合' }, { start: 0.9999, title: '尾' }];
    const clean = normalizeDeliveryChapters(chapters, 1, 'h264');
    expect(clean).toEqual([{ start: 0, end: 0.999, title: '海#;=\\ 檢查 ／ 重合' }, { start: 0.999, end: 1, title: '尾' }]);
    expect(serializeDeliveryChapters(clean, 1, 'prores')).toContain('title=海\\#\\;\\=\\\\ 檢查 ／ 重合');
    expect(() => normalizeDeliveryChapters([{ start: NaN, title: '錯' }], 1, 'h264')).toThrow('無效');
    expect(() => normalizeDeliveryChapters([{ start: 0, title: '錯' }], 1, 'wav')).toThrow('不支援');
  });

  it('counts the opening chapter in the limit and normalization remains repeatable', () => {
    const markers = Array.from({ length: 10000 }, (_, index) => ({ start: index + 1, title: String(index) }));
    expect(() => normalizeDeliveryChapters(markers, 10002, 'h264')).toThrow('含開頭章節');
    const accepted = normalizeDeliveryChapters(markers.slice(1), 10002, 'h264');
    expect(normalizeDeliveryChapters(accepted, 10002, 'h264')).toEqual(accepted);
  });

  it('submits each row with independent switches, retains notes in the frozen snapshot and drops unsupported format chapters', async () => {
    const p = project();
    const list = createDeliveryList({ projectTag: 'review', fps: 25, canvasW: 64, canvasH: 48 });
    list.setOutDir(0, 'C:/output'); list.setName(0, 'notes.mp4');
    list.setChapterOptions(0, { chapterNotes: true });
    list.add(); list.setName(1, 'styles.mov'); list.setFormat(1, 'prores');
    list.setChapterOptions(1, { chapterNotes: false, chapterStyled: true });
    const desktop = { listDir: vi.fn(async () => []), exportVideo: vi.fn(async job => job.defaultName) };
    const submission = createDeliverySubmission({ list, initialProject: p, readProject: () => p,
      isCurrent: () => true, desktop, confirmOverwrite: async () => true });
    await submission.submit();
    const sent = desktop.exportVideo.mock.calls.map(([job]) => job);
    expect(sent).toHaveLength(2);
    expect(sent[0].chapters).toEqual([{ start: 0, end: 2, title: '影片開始' }, { start: 2, end: 10, title: '備註：核對 #1;=\\', kind: 'note' }]);
    expect(sent[1].chapters).toEqual([]);
    for (const job of sent) {
      expect(job.assText).toContain('跨越起點'); expect(job.assText).toContain('逐句樣式'); expect(job.assText).toContain('繼承軌道');
    }
    expect(p.notes[0].text).toBe('範圍外');
  });
});

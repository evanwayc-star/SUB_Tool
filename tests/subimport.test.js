import { describe, expect, it } from 'vitest';
import { SubFormats } from '../src/formats.js';
import { buildSubtitleImportPlan } from '../src/project-intake-engine.js';
import { effStyle } from '../src/substyle.js';
import { getExactFps } from '../src/time.js';

const fps = 29.97;
const exactFps = getExactFps(fps);
const sourceTrack = {
  name: '原始主字幕', visible: true, locked: false,
  font: 'Noto Sans TC', bold: true, italic: false, fontSize: 72, color: '#ffffff',
  letterSpacing: 1, lineSpacing: 1.25, outline: 2, outlineColor: '#000000', shadow: 1,
  vertical: false, bgBox: true, bgColor: '#001122', bgAlpha: 0.6,
  posX: 50, posY: 86, align: 'center', valign: 'bottom', angle: 0,
};
const sourceCue = {
  id: 'source-cue', start: 30 / exactFps, end: 65 / exactFps, text: '第一行\n第二行', track: 0,
  style: { fontSize: 88, color: '#33ccff', posX: 42, angle: 15, bgBox: false },
};

function selfExportedAss() {
  return SubFormats.toASS(
    [sourceCue], fps, [sourceTrack], 1920, 1080,
    { includeMetadata: true, dropFrame: false },
  );
}

describe('SUB Tool ASS import plan', () => {
  it('匯入新軌時還原原始軌道、逐句樣式與 29.97 的影格位置', () => {
    const parsed = SubFormats.parseASS(selfExportedAss());
    const plan = buildSubtitleImportPlan(parsed, { fps, target: 'new' });

    expect(plan).toMatchObject({ usedMetadata: true, usedFrameTiming: true, trackPatch: sourceTrack });
    expect(plan.cues).toHaveLength(1);
    expect(Math.round(plan.cues[0].start * exactFps)).toBe(30);
    expect(Math.round(plan.cues[0].end * exactFps)).toBe(65);
    expect(plan.cues[0]).toMatchObject({ text: sourceCue.text, timed: true, style: sourceCue.style });
  });

  it('匯入既有軌時不改動既有軌，改以完整逐句樣式保留原始外觀', () => {
    const parsed = SubFormats.parseASS(selfExportedAss());
    const plan = buildSubtitleImportPlan(parsed, { fps, target: 'existing' });
    const existingTrack = { font: 'Different Font', fontSize: 40, color: '#ff0000', posY: 20 };

    expect(plan.trackPatch).toBeNull();
    expect(effStyle({ style: plan.cues[0].style }, existingTrack)).toEqual(effStyle(sourceCue, sourceTrack));
  });

  it('目標 FPS 不同時保留原始秒數，不偽造原始影格號', () => {
    const parsed = SubFormats.parseASS(selfExportedAss());
    const plan = buildSubtitleImportPlan(parsed, { fps: 24, target: 'new' });

    expect(plan.usedMetadata).toBe(true);
    expect(plan.usedFrameTiming).toBe(false);
    expect(plan.cues[0].start).toBe(sourceCue.start);
    expect(plan.cues[0].end).toBe(sourceCue.end);
  });

  it.each(['new', 'existing'].flatMap(target => [fps, 24].map(targetFps => ({ target, targetFps }))))
  ('合併多軌 ASS 匯入 $target 目的軌（$targetFps FPS）保留全部原稿、時間與各自生效樣式', ({ target, targetFps }) => {
    const verticalPreset = { vertical: true, font: 'Arial', fontSize: 60, lineSpacing: 1.8,
      color: '#ffee00', posX: 65, posY: 70, align: 'right', valign: 'top' };
    const tracks = [sourceTrack, { name: '直書譯文', visible: true, ...verticalPreset }];
    const cues = [
      sourceCue,
      { id: 'vertical', start: 70 / exactFps, end: 100 / exactFps,
        track: 1, text: '直書\n第二列', style: { fontSize: 68, color: '#00ff88', angle: -12 } },
      { id: 'untimed', start: 0, end: 0, track: 1, text: '尚未定時原稿', timed: false },
    ];
    const parsed = SubFormats.parseASS(SubFormats.toASS(
      cues, fps, tracks, 1920, 1080, { includeMetadata: true },
    ));
    const destinationTrack = target === 'new' ? {} : {
      font: 'Different Font', fontSize: 35, color: '#ff0000', vertical: false, lineSpacing: 1,
    };
    const plan = buildSubtitleImportPlan(parsed, { fps: targetFps, target });

    expect(plan).toMatchObject({ usedMetadata: true, usedFrameTiming: targetFps === fps, sourceTrackCount: 2 });
    expect(plan.trackPatch).toBeNull();
    expect(plan.cues.map(cue => ({ start: cue.start, end: cue.end, text: cue.text, timed: cue.timed })))
      .toEqual(cues.map(cue => ({ start: cue.start, end: cue.end, text: cue.text, timed: cue.timed !== false })));
    expect(plan.cues[0].style).toMatchObject({ fontSize: 88, lineSpacing: 1.25, color: '#33ccff', bgBox: false });
    expect(plan.cues[1].style).toMatchObject({ font: 'Arial', fontSize: 68, lineSpacing: 1.8,
      color: '#00ff88', vertical: true, posX: 65, posY: 70, angle: -12 });
    for (let index = 0; index < cues.length; index++) {
      expect(effStyle({ style: plan.cues[index].style }, destinationTrack))
        .toEqual(effStyle(cues[index], tracks[cues[index].track]));
    }
  });

  it.each(['missing', 'invalid'])('多軌 ASS 的 %s metadata 仍以標準 Dialogue 匯入', metadataState => {
    const text = SubFormats.toASS([
      { start: 1, end: 2, text: '標準主字幕', track: 0 },
      { start: 3, end: 4, text: '標準譯文', track: 1 },
      { start: 0, end: 0, text: '僅存於中繼資料的原稿', track: 1, timed: false },
    ], fps, [sourceTrack, { fontSize: 60 }], 1920, 1080, { includeMetadata: true })
      .replace(/^; SUBTOOL-META:.*\n/gm, '');
    const file = metadataState === 'invalid'
      ? text.replace('[Script Info]', '[Script Info]\n; SUBTOOL-META:1:1/2:broken') : text;
    const plan = buildSubtitleImportPlan(SubFormats.parseASS(file), { fps, target: 'new' });

    expect(plan).toMatchObject({ usedMetadata: false, usedFrameTiming: false, trackPatch: null });
    expect(plan.cues).toHaveLength(2);
    expect(plan.cues[0]).toMatchObject({ start: 1, end: 2, text: '標準主字幕', style: { fontSize: 72 } });
    expect(plan.cues[1]).toMatchObject({ start: 3, end: 4, text: '標準譯文', style: { fontSize: 60 } });
  });

  it('舊版 SUB Tool ASS 依目前 29.97 fps 修回舊百分秒造成的一格偏移', () => {
    const legacy = `[Script Info]
; Script generated by SUB Tool
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.01,0:00:00.05,Default,atg1,0,0,0,,第一格
Dialogue: 0,0:00:00.05,0:00:00.08,Default,atg1,0,0,0,,第二格
Dialogue: 0,0:00:00.98,0:00:01.02,Default,atg1,0,0,0,,第三十格
Dialogue: 0,0:01:00.04,0:01:00.08,Default,atg1,0,0,0,,第一千八百格`;

    const plan = buildSubtitleImportPlan(SubFormats.parseASS(legacy), { fps, target: 'new' });

    expect(plan).toMatchObject({ usedMetadata: false, usedLegacyTiming: true });
    expect(plan.cues.map(cue => Math.round(cue.start * exactFps))).toEqual([1, 2, 30, 1800]);
  });

  it('新版本沒有 metadata 的標準 ASS 不會被當成舊版再推進一格', () => {
    const standard = SubFormats.toASS([
      { start: 30 / exactFps, end: 31 / exactFps, text: '新版本', track: 0 },
    ], fps);
    const plan = buildSubtitleImportPlan(SubFormats.parseASS(standard), { fps, target: 'new' });

    expect(plan.usedLegacyTiming).toBe(false);
    expect(Math.round(plan.cues[0].start * exactFps)).toBe(30);
  });
});

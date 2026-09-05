import { describe, expect, it, vi } from 'vitest';

import {
  buildAudioClipMenu,
  buildAudioTrackMenu,
  buildVideoClipMenu,
  normalizeWaveOptions,
} from '../src/timeline-context-menu-model.js';

const WAVE_OPTIONS = [
  { selection: 'mix', label: 'MIX（所有聲道）', ready: true },
  { selection: 'ch1', label: 'Ch 1', ready: true },
];

function itemIds(items) {
  return items.map(item => item.id);
}

function itemById(items, id) {
  return items.find(item => item.id === id);
}

function expectCleanSeparators(items) {
  expect(items[0]?.id).not.toBe('separator');
  expect(items.at(-1)?.id).not.toBe('separator');

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].id !== 'separator') continue;
    expect(items[index - 1]?.id).not.toBe('separator');
    expect(items[index + 1]?.id).not.toBe('separator');
  }

  const stableIds = itemIds(items).filter(id => id !== 'separator');
  expect(new Set(stableIds).size).toBe(stableIds.length);
}

describe('normalizeWaveOptions', () => {
  it('統一字串與物件格式，並保留準備狀態', () => {
    expect(normalizeWaveOptions([
      'mix',
      { selection: 'ch1', label: 'Ch 1' },
      { id: 'ch2', label: 'Ch 2', ready: false },
      { value: 3 },
    ])).toEqual([
      { selection: 'mix', label: 'MIX（所有聲道）', ready: true },
      { selection: 'ch1', label: 'Ch 1', ready: true },
      { selection: 'ch2', label: 'Ch 2', ready: false },
      { selection: '3', label: '3', ready: true },
    ]);
  });

  it('非陣列輸入回傳空選項', () => {
    expect(normalizeWaveOptions(null)).toEqual([]);
    expect(normalizeWaveOptions({ selection: 'mix' })).toEqual([]);
  });
});

describe('影片／圖片片段右鍵選單', () => {
  it('未鎖定影片依安全定位、剪輯、聲音、排列、轉場、移除分組', () => {
    const items = buildVideoClipMenu({
      name: 'master.mov',
      canReveal: true,
      canSplit: true,
      trimmed: true,
      trackIndex: 1,
      hasPrevious: true,
      hasNext: true,
      hasFade: true,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      'reveal_source',
      'seek_clip_start',
      'separator',
      'split_at_playhead',
      'edit_duration',
      'edit_geometry',
      'reset_trim',
      'separator',
      'detach_audio',
      'hard_limiter',
      'audio_routing',
      'separator',
      'move_track_up',
      'move_track_down',
      'swap_previous',
      'swap_next',
      'separator',
      'fade',
      'crossfade_previous',
      'separator',
      'remove_clip',
    ]);
    expect(items[0]).toMatchObject({ heading: true, label: '🎬 master.mov' });
    expect(itemById(items, 'reveal_source')?.label).toBe('📂 在檔案管理器中顯示');
    expect(itemById(items, 'audio_routing')?.label).toBe('🎧 音訊配線…');
    expect(itemById(items, 'remove_clip')?.label).toBe('🗑 從時間軸移除此片段');
    expectCleanSeparators(items);
  });

  it('圖片保留剪輯與排列組，但完整省略影音組', () => {
    const items = buildVideoClipMenu({
      name: 'still.png',
      isImage: true,
      canReveal: true,
      canSplit: true,
      trimmed: true,
      trackIndex: 1,
      hasPrevious: true,
      hasNext: true,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      'reveal_source',
      'seek_clip_start',
      'separator',
      'split_at_playhead',
      'edit_duration',
      'edit_geometry',
      'reset_trim',
      'separator',
      'move_track_up',
      'move_track_down',
      'swap_previous',
      'swap_next',
      'separator',
      'fade',
      'crossfade_previous',
      'separator',
      'remove_clip',
    ]);
    expect(items[0]).toMatchObject({ heading: true, label: '🖼 still.png' });
    expect(itemIds(items)).not.toContain('detach_audio');
    expect(itemIds(items)).not.toContain('audio_routing');
    expectCleanSeparators(items);
  });

  it.each([
    { name: '鎖定影片', isImage: false, heading: '🎬 locked.mov' },
    { name: '鎖定圖片', isImage: true, heading: '🖼 locked.png' },
  ])('$name 只保留檔案定位與播放頭安全操作', ({ isImage, heading }) => {
    const items = buildVideoClipMenu({
      name: isImage ? 'locked.png' : 'locked.mov',
      isImage,
      locked: true,
      canReveal: true,
      canSplit: true,
      trimmed: true,
      trackIndex: 1,
      hasPrevious: true,
      hasNext: true,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      'locked_status',
      'reveal_source',
      'seek_clip_start',
    ]);
    expect(items[0]).toMatchObject({ heading: true, label: heading });
    expect(itemById(items, 'locked_status')).toMatchObject({
      note: true,
      tone: 'locked',
      label: '🔒 此視訊軌已鎖定',
    });
    expectCleanSeparators(items);
  });

  it('canReveal 只決定是否顯示檔案定位，builder 不解析 primary path', () => {
    const hidden = buildVideoClipMenu({ name: 'primary.mov', canReveal: false });
    const visible = buildVideoClipMenu({ name: 'primary.mov', canReveal: true });

    expect(itemIds(hidden)).not.toContain('reveal_source');
    expect(itemIds(visible)).toContain('reveal_source');
    expectCleanSeparators(hidden);
    expectCleanSeparators(visible);
  });

  it('原音已分離時顯示狀態，不留下可點的分離或配線動作', () => {
    const items = buildVideoClipMenu({ name: 'detached.mov', audioDetached: true });

    expect(itemById(items, 'audio_detached_status')).toMatchObject({ note: true });
    expect(itemIds(items)).not.toContain('detach_audio');
    expect(itemIds(items)).not.toContain('audio_routing');
    expectCleanSeparators(items);
  });
});

describe('音訊片段右鍵選單', () => {
  it.each([
    { locked: false, expectedHeadingIndex: 0 },
    { locked: true, expectedHeadingIndex: 0 },
  ])('影片原音 locked=$locked 仍保留定位、辨識、配線與波形', ({ locked }) => {
    const items = buildAudioClipMenu({
      name: 'master.mov',
      external: false,
      locked,
      canReveal: true,
      waveOptions: WAVE_OPTIONS,
      selectedWave: 'ch1',
    });
    const expected = [
      'heading',
      ...(locked ? ['locked_status'] : []),
      'reveal_source',
      'speech_recognition',
      'separator',
      'hard_limiter',
      'audio_routing',
      'separator',
      'wave_heading',
      'wave:mix',
      'wave:ch1',
    ];

    expect(itemIds(items)).toEqual(expected);
    expect(itemById(items, 'wave:ch1')?.checked).toBe(true);
    expect(itemById(items, 'wave:mix')?.checked).toBe(false);
    expectCleanSeparators(items);
  });

  it('未鎖定外部音訊依定位、分析、片段、配線、波形、移除分組', () => {
    const items = buildAudioClipMenu({
      name: 'voice.wav',
      external: true,
      canReveal: true,
      canSplit: true,
      enabled: true,
      waveOptions: WAVE_OPTIONS,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      'reveal_source',
      'speech_recognition',
      'separator',
      'seek_audio_start',
      'split_at_playhead',
      'toggle_audio',
      'separator',
      'hard_limiter',
      'audio_routing',
      'separator',
      'wave_heading',
      'wave:mix',
      'wave:ch1',
      'separator',
      'remove_audio',
    ]);
    expect(itemById(items, 'remove_audio')?.label).toBe('🗑 從時間軸移除此片段');
    expectCleanSeparators(items);
  });

  it('鎖定外部音訊隱藏切割與移除，其他安全操作維持原順序', () => {
    const items = buildAudioClipMenu({
      name: 'locked.wav',
      external: true,
      locked: true,
      canReveal: true,
      canSplit: true,
      enabled: false,
      waveOptions: WAVE_OPTIONS,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      'locked_status',
      'reveal_source',
      'speech_recognition',
      'separator',
      'seek_audio_start',
      'toggle_audio',
      'separator',
      'hard_limiter',
      'audio_routing',
      'separator',
      'wave_heading',
      'wave:mix',
      'wave:ch1',
    ]);
    expect(itemIds(items)).not.toContain('split_at_playhead');
    expect(itemIds(items)).not.toContain('remove_audio');
    expect(itemById(items, 'toggle_audio')?.label).toContain('開啟');
    expectCleanSeparators(items);
  });

  it('沒有波形選項時只顯示非互動的準備狀態', () => {
    const items = buildAudioClipMenu({ name: 'waiting.wav', external: true });

    expect(itemIds(items)).toContain('wave_preparing');
    expect(itemById(items, 'wave_preparing')).toMatchObject({ note: true });
    expect(itemIds(items).some(id => id.startsWith('wave:'))).toBe(false);
    expectCleanSeparators(items);
  });
});

describe('音訊軌道空白區與列頭選單', () => {
  it.each([false, true])('locked=%s 依序顯示定位、配線與波形', locked => {
    const items = buildAudioTrackMenu({
      name: 'track.wav',
      external: true,
      locked,
      canReveal: true,
      waveOptions: WAVE_OPTIONS,
    });

    expect(itemIds(items)).toEqual([
      'heading',
      ...(locked ? ['locked_status'] : []),
      'reveal_source',
      'separator',
      'hard_limiter',
      'audio_routing',
      'separator',
      'wave_heading',
      'wave:mix',
      'wave:ch1',
    ]);
    expectCleanSeparators(items);
  });
});

describe('動作 callback 契約', () => {
  it('鎖定影片仍可執行檔案定位與播放頭定位', () => {
    const revealSource = vi.fn();
    const seekStart = vi.fn();
    const items = buildVideoClipMenu(
      { name: 'locked.mov', locked: true, canReveal: true },
      { revealSource, seekStart }
    );

    itemById(items, 'reveal_source').act();
    itemById(items, 'seek_clip_start').act();

    expect(revealSource).toHaveBeenCalledOnce();
    expect(seekStart).toHaveBeenCalledOnce();
  });

  it('鎖定外部音訊仍可定位檔案，且波形 callback 收到選定的 selection', () => {
    const revealSource = vi.fn();
    const selectWave = vi.fn();
    const items = buildAudioClipMenu(
      {
        name: 'locked.wav',
        external: true,
        locked: true,
        canReveal: true,
        waveOptions: WAVE_OPTIONS,
      },
      { revealSource, selectWave }
    );

    itemById(items, 'reveal_source').act();
    itemById(items, 'wave:ch1').act();

    expect(revealSource).toHaveBeenCalledOnce();
    expect(selectWave).toHaveBeenCalledOnce();
    expect(selectWave).toHaveBeenCalledWith('ch1');
  });
});

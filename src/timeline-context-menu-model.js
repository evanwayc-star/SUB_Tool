/* SUB Tool — 時間軸媒體右鍵選單模型
   只描述項目、順序與鎖定可用性；DOM 呈現與實際命令留在 menus.js。 */

function action(id, label, act, extra = {}) {
  return {
    id,
    label,
    ...extra,
    ...(typeof act === 'function' ? { act } : {}),
  };
}

function heading(label) {
  return { id: 'heading', heading: true, label };
}

function note(id, label, tone = '') {
  return { id, note: true, tone, label };
}

function appendGroup(items, entries, { separator = true } = {}) {
  const visible = entries.filter(Boolean);
  if (!visible.length) return;
  if (separator && items.length && !items.at(-1)?.sep) {
    items.push({ id: 'separator', sep: true });
  }
  items.push(...visible);
}

export function normalizeWaveOptions(rawOptions) {
  return (Array.isArray(rawOptions) ? rawOptions : []).map((item, index) => {
    if (typeof item === 'string') {
      return {
        selection: item,
        label: item === 'mix' ? 'MIX（所有聲道）' : item,
        ready: true,
      };
    }
    const selection = item?.selection ?? item?.id ?? item?.value ?? (index === 0 ? 'mix' : '');
    return {
      selection: String(selection),
      label: item?.label || (selection === 'mix' ? 'MIX（所有聲道）' : String(selection)),
      ready: item?.ready !== false,
    };
  }).filter(item => item.selection);
}

function waveformItems(options, selected, actions) {
  if (!options.length) {
    return [note('wave_preparing', '波形正在準備中…')];
  }
  return [
    { id: 'wave_heading', heading: true, label: '顯示此素材的波形' },
    ...options.map(option => action(
      `wave:${option.selection}`,
      option.ready ? option.label : `${option.label}（準備中）`,
      () => actions.selectWave?.(option.selection),
      { checked: String(selected || 'mix') === option.selection }
    )),
  ];
}

export function buildVideoClipMenu(context, actions = {}) {
  const {
    name = '未命名素材',
    isImage = false,
    locked = false,
    canReveal = false,
    canSplit = false,
    trimmed = false,
    audioDetached = false,
    trackIndex = 0,
    hasPrevious = false,
    hasNext = false,
    hasFade = false,
  } = context || {};

  const typeLabel = isImage ? '圖片' : '影片';
  const items = [heading(`${isImage ? '🖼' : '🎬'} ${name}`)];
  if (locked) items.push(note('locked_status', `🔒 此視訊軌已鎖定`, 'locked'));

  appendGroup(items, [
    canReveal ? action('reveal_source', '📂 在檔案管理器中顯示', actions.revealSource) : null,
    action('seek_clip_start', '⏱ 播放頭移到此片段開頭', actions.seekStart),
  ], { separator: false });

  if (locked) return items;

  appendGroup(items, [
    canSplit ? action('split_at_playhead', '✂ 在播放點切割（Ctrl+K）', actions.splitAtPlayhead) : null,
    action('edit_duration', '⏳ 修改持續時間…', actions.editDuration),
    action('edit_geometry', `📐 ${typeLabel}大小與位置…`, actions.editGeometry),
    trimmed ? action('reset_trim', '↺ 重設修剪（還原完整長度）', actions.resetTrim) : null,
  ]);

  if (!isImage) {
    appendGroup(items, audioDetached
      ? [note('audio_detached_status', '🔇 此影片原音已解除連結')]
      : [
          action('detach_audio', '🔗✂ 影音分離', actions.detachAudio),
          action('audio_routing', '🎧 音訊配線…', actions.openAudioRouting),
        ]);
  }

  appendGroup(items, [
    action('move_track_up', `⬆ 移到上層視訊軌（V${trackIndex + 2}）`, actions.moveTrackUp),
    trackIndex > 0 ? action('move_track_down', `⬇ 移到下層視訊軌（V${trackIndex}）`, actions.moveTrackDown) : null,
    hasPrevious ? action('swap_previous', '◀ 與前一段交換（同軌）', actions.swapPrevious) : null,
    hasNext ? action('swap_next', '▶ 與後一段交換（同軌）', actions.swapNext) : null,
  ]);

  appendGroup(items, [
    action('fade', `🎞 淡入淡出（轉場）${hasFade ? ' ✓' : ''}…`, actions.editFade),
    action('crossfade_previous', '🔀 與前一段交叉溶接…', actions.editCrossfade),
  ]);

  appendGroup(items, [
    action('remove_clip', '🗑 從時間軸移除此片段', actions.removeClip),
  ]);
  return items;
}

export function buildAudioClipMenu(context, actions = {}) {
  const {
    name = '音訊素材',
    external = false,
    locked = false,
    canReveal = false,
    canSplit = false,
    enabled = true,
    waveOptions = [],
    selectedWave = 'mix',
  } = context || {};

  const items = [heading(`${external ? '🎵' : '🔊'} ${name}`)];
  if (locked) items.push(note('locked_status', '🔒 此音訊軌已鎖定', 'locked'));

  appendGroup(items, [
    canReveal ? action('reveal_source', '📂 在檔案管理器中顯示', actions.revealSource) : null,
    action('speech_recognition', '🎙 語音辨識／文本匹配…', actions.openSpeechRecognition),
  ], { separator: false });

  if (external) {
    appendGroup(items, [
      action('seek_audio_start', '⏱ 播放頭移到此片段開頭', actions.seekStart),
      !locked && canSplit
        ? action('split_at_playhead', '✂ 在播放點切割（Ctrl+K）', actions.splitAtPlayhead)
        : null,
      action(
        'toggle_audio',
        enabled ? '🔇 關閉此片段聲音' : '🔊 開啟此片段聲音',
        actions.toggleAudio
      ),
    ]);
  }

  appendGroup(items, [
    action('audio_routing', '🎧 音訊配線…', actions.openAudioRouting),
  ]);
  appendGroup(items, waveformItems(waveOptions, selectedWave, actions));

  if (external && !locked) {
    appendGroup(items, [
      action('remove_audio', '🗑 從時間軸移除此片段', actions.removeAudio),
    ]);
  }
  return items;
}

export function buildAudioTrackMenu(context, actions = {}) {
  const {
    name = '音訊素材',
    external = false,
    locked = false,
    canReveal = false,
    waveOptions = [],
    selectedWave = 'mix',
  } = context || {};

  const items = [heading(`${external ? '🎵' : '🔊'} ${name}`)];
  if (locked) items.push(note('locked_status', '🔒 此音訊軌已鎖定', 'locked'));
  appendGroup(items, [
    canReveal ? action('reveal_source', '📂 在檔案管理器中顯示', actions.revealSource) : null,
  ], { separator: false });
  appendGroup(items, [
    action('audio_routing', '🎧 音訊配線…', actions.openAudioRouting),
  ]);
  appendGroup(items, waveformItems(waveOptions, selectedWave, actions));
  return items;
}

'use strict';

// Chapters are delivery-relative seconds. They are optional review markers,
// independent of subtitle burn-in and of the chosen output frame rate.
function supportsDeliveryChapters(format) {
  return format === 'h264' || format === 'prores';
}

function normalizeDeliveryChapters(chapters, duration, format) {
  if (chapters == null) return [];
  if (!Array.isArray(chapters) || chapters.length > 10000) throw new Error('影片書籤清單無效或超過 10000 筆');
  if (!chapters.length) return [];
  if (!supportsDeliveryChapters(format)) throw new Error('此交付格式不支援影片書籤，請使用 MP4 或 MOV');
  const endMs = Math.round(Number(duration) * 1000);
  if (!Number.isSafeInteger(endMs) || endMs <= 0) throw new Error('影片書籤的輸出時長無效');
  const grouped = new Map();
  let removedLegacyStyles = false;
  for (const chapter of chapters) {
    if (!chapter || !Number.isFinite(chapter.start) || chapter.start < 0 || chapter.start >= Number(duration)
      || typeof chapter.title !== 'string' || !chapter.title.trim()) throw new Error('影片書籤的時間或標題無效');
    const start = Math.min(endMs - 1, Math.round(chapter.start * 1000));
    const title = chapter.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!title) throw new Error('影片書籤標題不可空白');
    const note = chapter.kind === 'note';
    if (!note) {
      // Old queues froze merged titles without recording their origin. A
      // mixed note/style title is ambiguous: never truncate a user's note.
      const parts = title.split(' ／ ');
      if (parts.some(part => part.startsWith('自訂字幕：'))) {
        if (!title.startsWith('自訂字幕：') || parts.some(part => part.startsWith('備註：')))
          throw new Error('舊版影片書籤混有自訂樣式字幕，請移除舊交付後重新加入只含備註的書籤');
        removedLegacyStyles = true;
        continue;
      }
    }
    const entry = grouped.get(start) || { titles: [], notes: false };
    if (!entry.titles.includes(title)) entry.titles.push(title);
    // Legacy style titles were already rejected/removed above. Keep a note's
    // provenance when an old opening or generic marker shares its time.
    entry.notes = entry.notes || note;
    grouped.set(start, entry);
  }
  if (!grouped.size || (removedLegacyStyles && grouped.size === 1 && grouped.has(0)
    && !grouped.get(0).notes && grouped.get(0).titles.join(' ／ ') === '影片開始')) return [];
  // QuickTime chapter tracks begin at zero: without an opening chapter the
  // first real review marker is moved to 0 by MP4/MOV readers.
  if (!grouped.has(0)) grouped.set(0, { titles: ['影片開始'], notes: false });
  if (grouped.size > 10000) throw new Error('影片書籤含開頭章節不可超過 10000 筆');
  const starts = [...grouped.keys()].sort((a, b) => a - b);
  return starts.map((start, index) => ({
    start: start / 1000,
    end: (starts[index + 1] ?? endMs) / 1000,
    title: grouped.get(start).titles.join(' ／ '),
    ...(grouped.get(start).notes ? { kind: 'note' } : {}),
  }));
}

// FFmetadata escapes are data, never filtergraph or shell syntax.
// https://ffmpeg.org/ffmpeg-formats.html#Metadata-1
function serializeDeliveryChapters(chapters, duration, format) {
  const clean = normalizeDeliveryChapters(chapters, duration, format);
  if (!clean.length) return null;
  return ';FFMETADATA1\n' + clean.map(chapter => [
    '[CHAPTER]', 'TIMEBASE=1/1000',
    `START=${Math.round(chapter.start * 1000)}`, `END=${Math.round(chapter.end * 1000)}`,
    // FFmpeg's line reader treats even an escaped final backslash as a line
    // continuation. A trailing display space prevents consuming the next chapter.
    `title=${chapter.title.replace(/([\\=;#])/g, '\\$1')}${chapter.title.endsWith('\\') ? ' ' : ''}`,
  ].join('\n')).join('\n') + '\n';
}

module.exports = { supportsDeliveryChapters, normalizeDeliveryChapters, serializeDeliveryChapters };

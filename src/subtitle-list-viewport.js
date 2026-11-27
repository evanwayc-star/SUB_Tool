// Variable-height subtitle rows share one scrolling surface. Unknown heights
// are estimates until ResizeObserver measures the actual laid-out row.
export function subtitleListViewport(root, repaint) {
  const overscan = 8;
  const estimate = 52;
  let cues = [], positions = new Map(), offsets = [0], heights = new WeakMap();
  let width = 0, frame = null;
  const sizedRows = new Set();

  function rebuildOffsets() {
    offsets = [0];
    for (const cue of cues) offsets.push(offsets[offsets.length - 1] + (heights.get(cue) || estimate));
  }
  function indexAt(y) {
    let low = 0, high = cues.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid + 1] <= y) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, cues.length - 1);
  }
  function schedule() {
    if (frame !== null || cues.length <= 80) return;
    frame = requestAnimationFrame(() => { frame = null; if (cues.length > 80) repaint(); });
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    if (cues.length <= 80) return;
    const anchor = indexAt(root.scrollTop);
    const before = offsets[anchor];
    let changed = false;
    for (const entry of entries) {
      if (entry.target === root) {
        if (width !== entry.contentRect.width) {
          width = entry.contentRect.width;
          heights = new WeakMap();
          changed = true;
        }
        schedule();
        continue;
      }
      const cue = cues[positions.get(entry.target.dataset.id)];
      const height = entry.borderBoxSize?.[0]?.blockSize;
      if (cue && sizedRows.has(entry.target) && height > 0 && heights.get(cue) !== height) {
        heights.set(cue, height);
        changed = true;
      }
    }
    if (changed) {
      rebuildOffsets();
      // Keep the same subtitle under the reader when estimates above it settle.
      if (offsets[anchor] !== before) root.scrollTop += offsets[anchor] - before;
      schedule();
    }
  });
  root?.addEventListener?.('scroll', schedule, { passive: true });
  if (root?.nodeType === 1 && observer) observer.observe(root);

  return {
    setCues(next) {
      cues = next;
      positions = new Map(cues.map((cue, i) => [cue.id, i]));
      rebuildOffsets();
      root.classList?.toggle('windowed', cues.length > 80);
    },
    get cues() { return cues; },
    cue(id) { return cues[positions.get(id)]; },
    slots(pinnedIds) {
      if (cues.length <= 80) return cues.map(cue => ({ cue }));
      const start = Math.max(0, indexAt(root.scrollTop) - overscan);
      const end = Math.min(cues.length, indexAt(root.scrollTop + root.clientHeight) + overscan + 1);
      const indices = new Set();
      for (let i = start; i < end; i++) indices.add(i);
      for (const id of pinnedIds) if (positions.has(id)) indices.add(positions.get(id));
      const slots = [];
      let cursor = 0;
      for (const index of [...indices].sort((a,b) => a-b)) {
        if (index > cursor) slots.push({ gap: offsets[index] - offsets[cursor] });
        slots.push({ cue: cues[index] });
        cursor = index + 1;
      }
      if (cursor < cues.length) slots.push({ gap: offsets[cues.length] - offsets[cursor] });
      return slots;
    },
    reveal(id) {
      const index = positions.get(id);
      if (index === undefined || cues.length <= 80) return;
      root.scrollTop = offsets[index];
      repaint(id);
    },
    observeRows(rows) {
      if (!observer) return;
      const next = new Set(cues.length > 80 ? rows : []);
      for (const row of sizedRows) if (!next.has(row)) { observer.unobserve(row); sizedRows.delete(row); }
      for (const row of next) if (!sizedRows.has(row)) { observer.observe(row); sizedRows.add(row); }
    },
  };
}

export function paintSubtitleBlocks(trackRows, displayList) {
  // Clear old cues and overlaps
  for (const row of trackRows) {
    row.querySelectorAll('.cue-block, .cue-overlap').forEach(e => e.remove());
  }

  for (const c of displayList.cues) {
    const row = trackRows[Math.min(c.track, trackRows.length - 1)];
    if (!row) continue;
    const el = document.createElement('div');
    let cls = 'cue-block';
    if (c.selected) cls += ' sel';
    if (c.selectedMulti) cls += ' multi';
    if (c.primary) cls += ' primary';
    el.className = cls;
    el.style.left = c.x + 'px';
    el.style.width = Math.max(2, c.w) + 'px';
    el.dataset.id = c.id;
    const styleMarker = c.hasStyle ? '<span title="此句有樣式覆蓋" style="color:var(--accent)">✱ </span>' : '';
    const displayIndex = c.isLast ? `${c.cueIndex} ＃` : c.cueIndex;
    const idxHtml = c.cueIndex ? `<div style="padding:0 8px 0 12px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.7);pointer-events:none;display:flex;align-items:center;">${displayIndex}</div>` : '';
    el.innerHTML = '<div class="edge l"></div><div style="flex:1;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-height:1.2;pointer-events:none;padding:0 6px;">' + styleMarker + c.htmlText + '</div>' + idxHtml + '<div class="edge r"></div>';
    row.appendChild(el);
  }

  for (const ov of displayList.overlaps) {
    const row = trackRows[Math.min(ov.track, trackRows.length - 1)];
    if (!row) continue;
    const el = document.createElement('div');
    el.className = 'cue-overlap';
    el.style.left = ov.x + 'px';
    el.style.width = Math.max(2, ov.w) + 'px';
    el.dataset.id1 = ov.id1;
    el.dataset.id2 = ov.id2;
    row.appendChild(el);
  }
}
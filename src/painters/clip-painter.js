export function paintClipBlocks(container, displayList) {
  if (!container) return;
  container.innerHTML = '';
  
  const rowByV = [];
  for (const rowConfig of displayList.rows) {
    const row = document.createElement('div');
    row.className = 'vtrack-row' + (rowConfig.visible ? '' : ' hidden-tk');
    row.style.top = rowConfig.top + 'px';
    row.style.height = rowConfig.height + 'px';
    row.dataset.vtrack = rowConfig.vtrack;
    container.appendChild(row);
    rowByV[rowConfig.vtrack] = row;
  }

  for (const c of displayList.clips) {
    const row = rowByV[c.vtrack] || rowByV[0];
    if (!row) continue;
    const el = document.createElement('div');
    let cls = 'clip-block';
    if (c.active) cls += ' active';
    if (c.selected) cls += ' selected';
    if (c.locked) cls += ' locked';
    el.className = cls;
    el.style.left = c.x + 'px';
    el.style.width = Math.max(6, c.w) + 'px';
    el.dataset.clipId = c.id;
    el.dataset.vtrack = c.vtrack;
    
    try {
      const icon = c.isImg ? '🖼️' : '🎬';
      const trimmedMarker = c.trimmed ? ' ✂' : '';
      const fadeMarker = c.hasFade ? ' ⌁' : '';
      el.innerHTML = `<div class="edge l"></div><div class="clip-label">${icon} ${c.escapedName}${trimmedMarker}${fadeMarker}</div><div class="edge r"></div>`;
      row.appendChild(el);
    } catch(err) {
      console.error('renderClipBlocks error on clip', c, err);
      el.innerHTML = `<div class="edge l"></div><div class="clip-label">⚠️ ERROR</div><div class="edge r"></div>`;
      row.appendChild(el);
    }
  }
}

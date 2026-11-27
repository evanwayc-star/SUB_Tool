// Bounds are half-open source pixels throughout. Cut out the intersection as
// at most four non-overlapping strips so both add and subtract stay exact.
function subtract(rect, cut) {
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  const x = Math.max(rect.x, cut.x), y = Math.max(rect.y, cut.y);
  const endX = Math.min(right, cut.x + cut.width), endY = Math.min(bottom, cut.y + cut.height);
  if (x >= endX || y >= endY) return [rect];
  return [
    {x:rect.x, y:rect.y, width:rect.width, height:y - rect.y},
    {x:rect.x, y:endY, width:rect.width, height:bottom - endY},
    {x:rect.x, y, width:x - rect.x, height:endY - y},
    {x:endX, y, width:right - endX, height:endY - y},
  ].filter(piece => piece.width > 0 && piece.height > 0);
}

function mergeAdjacent(rects, pos, size, across, breadth) {
  rects.sort((a, b) => a[across] - b[across] || a[breadth] - b[breadth] || a[pos] - b[pos]);
  const merged = [];
  for (const rect of rects) {
    const prev = merged.at(-1);
    if (prev && prev[across] === rect[across] && prev[breadth] === rect[breadth] && prev[pos] + prev[size] === rect[pos]) {
      merged[merged.length - 1] = {...prev, [size]:prev[size] + rect[size]};
    } else merged.push(rect);
  }
  return merged;
}

function applyBrush(base, mode, rect, frame) {
  if (mode === 'add' && base === null) return null;
  let pieces = mode === 'replace' ? [] : (base ?? [frame]).flatMap(piece => subtract(piece, rect));
  if (mode !== 'subtract') pieces.push(rect);
  if (pieces.reduce((area, piece) => area + piece.width * piece.height, 0) === frame.width * frame.height) return null;
  let before;
  do {
    before = pieces.length;
    pieces = mergeAdjacent(pieces, 'x', 'width', 'y', 'height');
    pieces = mergeAdjacent(pieces, 'y', 'height', 'x', 'width');
  } while (before !== pieces.length);
  return pieces;
}

function rectPath({x, y, width, height}) {
  return `M${x} ${y}h${width}v${height}h-${width}Z`;
}

// On a shared edge the two rectangles cancel. Drawing only the unpaired
// spans leaves one outline around a union, including the outline of a hole.
function outlinePath(rects) {
  const rows = new Map(), columns = new Map();
  function add(edges, at, start, end) {
    if (!edges.has(at)) edges.set(at, new Set());
    const ends = edges.get(at);
    for (const p of [start, end]) {
      if (ends.has(p)) ends.delete(p);
      else ends.add(p);
    }
  }
  for (const {x, y, width, height} of rects) {
    add(rows, y, x, x + width);
    add(rows, y + height, x, x + width);
    add(columns, x, y, y + height);
    add(columns, x + width, y, y + height);
  }
  const lines = [];
  for (const edges of [rows, columns]) {
    for (const [at, ends] of edges) {
      const points = [...ends].sort((a, b) => a - b);
      for (let i = 0; i < points.length; i += 2) {
        lines.push(edges === rows ? `M${points[i]} ${at}H${points[i + 1]}` : `M${at} ${points[i]}V${points[i + 1]}`);
      }
    }
  }
  return lines.join('');
}

export function mountPlayheadOcrRegion(container, canvas, onChange, onSubmit) {
  const {width, height} = canvas, frame = {x:0, y:0, width, height};
  const document = container.ownerDocument;
  const stage = document.createElement('div'), surface = document.createElement('button');
  stage.className = 'playhead-ocr-stage';
  surface.type = 'button';
  surface.className = 'playhead-ocr-surface';
  surface.style.setProperty('--frame-aspect', String(width / height));
  surface.setAttribute('aria-label', '編輯辨識範圍，按 Enter 開始辨識');
  surface.setAttribute('aria-describedby', 'playheadOcrGestures playheadOcrRegionKeys');
  surface.append(canvas);
  surface.insertAdjacentHTML('beforeend', `<svg class="playhead-ocr-selection" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" hidden>
    <path class="playhead-ocr-shade" fill-rule="evenodd"/><path class="playhead-ocr-edge" vector-effect="non-scaling-stroke"/>
    <path class="playhead-ocr-brush" vector-effect="non-scaling-stroke"/></svg>`);
  const overlay = surface.lastElementChild;
  const [shade, edge, brush] = overlay.children;
  stage.append(surface);
  const help = document.createElement('div');
  help.className = 'playhead-ocr-help';
  help.innerHTML = `<p id="playheadOcrGestures">拖曳取代選區 · Shift＋拖曳加入 · Alt＋拖曳扣除 · 雙擊回到整張</p>
    <p id="playheadOcrRegionKeys" class="playhead-ocr-keys">方向鍵移動最近的框，Shift＋方向鍵調整寬高，Alt 微調一像素。Home 重設，Enter 開始辨識。</p>`;
  container.append(stage, help);

  const clamp = (n, max) => Math.max(0, Math.min(max, n));
  let selection = null, lastEdit = null, drag = null;
  function paint(rects, preview = null) {
    overlay.toggleAttribute('hidden', rects === null && !preview);
    shade.setAttribute('d', rects === null ? '' : rectPath(frame) + rects.map(rectPath).join(''));
    edge.setAttribute('d', rects ? outlinePath(rects) : '');
    brush.setAttribute('d', preview ? rectPath(preview) : '');
  }
  function commit(edit) {
    lastEdit = edit;
    selection = edit ? applyBrush(edit.base, edit.mode, edit.rect, frame) : null;
    paint(selection);
    onChange(selection && selection.map(rect => ({...rect})));
  }
  function point(event, initial = false) {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
    if (initial && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
    return {x:clamp(x, 1) * width, y:clamp(y, 1) * height, box};
  }
  function brushAt(event) {
    const {start} = drag, end = point(event);
    if (!end || Math.abs(end.x - start.x) * end.box.width / width < 3 ||
        Math.abs(end.y - start.y) * end.box.height / height < 3) return null;
    const x = Math.floor(Math.min(start.x, end.x) + 1e-9), y = Math.floor(Math.min(start.y, end.y) + 1e-9);
    return {x, y, width:Math.ceil(Math.max(start.x, end.x) - 1e-9) - x, height:Math.ceil(Math.max(start.y, end.y) - 1e-9) - y};
  }
  function finishDrag() {
    if (!drag) return;
    const {id} = drag;
    drag = null;
    if (surface.hasPointerCapture?.(id)) surface.releasePointerCapture(id);
    paint(selection);
  }
  const listeners = new AbortController();
  const listen = (element, type, fn) => element.addEventListener(type, fn, {signal:listeners.signal});
  listen(surface, 'pointerdown', event => {
    if (drag || event.button !== 0 || event.isPrimary === false) return;
    const start = point(event, true);
    if (!start) return;
    event.preventDefault();
    surface.focus({preventScroll:true});
    surface.setPointerCapture?.(event.pointerId);
    drag = {id:event.pointerId, start, mode:event.altKey ? 'subtract' : event.shiftKey ? 'add' : 'replace'};
  });
  listen(document.defaultView, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const rect = brushAt(event);
    paint(rect ? applyBrush(selection, drag.mode, rect, frame) : selection, rect);
  });
  listen(document.defaultView, 'pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const rect = brushAt(event), mode = drag.mode;
    finishDrag();
    if (rect) commit({base:selection, mode, rect});
  });
  for (const type of ['pointercancel','lostpointercapture']) {
    listen(surface, type, event => { if (event.pointerId === drag?.id) finishDrag(); });
  }
  listen(document.defaultView, 'blur', finishDrag);
  listen(surface, 'dblclick', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    commit(null);
  });
  listen(surface, 'keydown', event => {
    if (drag || event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Home') {
      event.preventDefault(); event.stopPropagation();
      commit(null);
      return;
    }
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (!horizontal && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); event.stopPropagation();
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 3));
    const edit = lastEdit ?? {base:null, mode:'replace', rect:{x:Math.floor((width - w) / 2), y:Math.floor((height - h) / 2), width:w, height:h}};
    const rect = {...edit.rect};
    const coord = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height', limit = horizontal ? width : height;
    const step = event.altKey ? 1 : Math.max(1, Math.round(limit / 100));
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
    if (event.shiftKey) rect[size] = Math.max(1, clamp(rect[size] + delta, limit - rect[coord]));
    else rect[coord] = clamp(rect[coord] + delta, limit - rect[size]);
    commit({...edit, rect});
  });
  // Native Enter, Space and assistive activation emit detail zero. A pointer
  // click (also the clicks preceding a double-click) must never start OCR.
  listen(surface, 'click', event => {
    if (event.detail === 0 && !drag && selection?.length !== 0) onSubmit();
  });
  return () => {
    listeners.abort();
    finishDrag();
    stage.remove();
    help.remove();
  };
}

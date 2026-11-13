'use strict';

// Renderer rectangles use CSS pixels; Electron bounds and shapes use DIP.
// A fully covered window must be hidden: setShape([]) means remove the shape.
const MAX_OCCLUDERS = 64;
const MAX_REGIONS = 8192;

function normaliseMpvRect(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, w, h } = value;
  if (![x, y, w, h].every(Number.isFinite) || Math.abs(x) > 100000 || Math.abs(y) > 100000
    || w <= 0 || h <= 0 || w > 32768 || h > 32768) return null;
  return { x, y, w, h };
}

function normaliseMpvViewport(value) {
  if (!value || typeof value.visible !== 'boolean' || !Array.isArray(value.occluders)
    || value.occluders.length > MAX_OCCLUDERS) return null;
  const bounds = normaliseMpvRect(value.bounds);
  const occluders = Array.from(value.occluders, normaliseMpvRect);
  if (!bounds || occluders.some(rect => !rect)) return null;
  return { bounds, visible: value.visible, occluders };
}

function subtract(region, hole) {
  const left = Math.max(region.x, hole.x), top = Math.max(region.y, hole.y);
  const right = Math.min(region.x + region.width, hole.x + hole.width);
  const bottom = Math.min(region.y + region.height, hole.y + hole.height);
  if (right <= left || bottom <= top) return [region];
  const parts = [
    { x: region.x, y: region.y, width: region.width, height: top - region.y },
    { x: region.x, y: bottom, width: region.width, height: region.y + region.height - bottom },
    { x: region.x, y: top, width: left - region.x, height: bottom - top },
    { x: right, y: top, width: region.x + region.width - right, height: bottom - top },
  ];
  return parts.filter(part => part.width > 0 && part.height > 0);
}

function mpvWindowRegion(rect, occluders, pageZoom = 1) {
  const zoom = Number.isFinite(pageZoom) && pageZoom >= .1 && pageZoom <= 10 ? pageZoom : 1;
  const bounds = { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom),
    width: Math.max(1, Math.round(rect.w * zoom)), height: Math.max(1, Math.round(rect.h * zoom)) };
  let shape = [{ x: 0, y: 0, width: bounds.width, height: bounds.height }];
  let intersected = false;
  for (const rect of occluders) {
    // Round holes outward so a fractional CSS edge cannot leave native pixels
    // above the HTML panel. Shapes are relative to the rounded window origin.
    const x = Math.max(0, Math.floor(rect.x * zoom) - bounds.x);
    const y = Math.max(0, Math.floor(rect.y * zoom) - bounds.y);
    const right = Math.min(bounds.width, Math.ceil((rect.x + rect.w) * zoom) - bounds.x);
    const bottom = Math.min(bounds.height, Math.ceil((rect.y + rect.h) * zoom) - bounds.y);
    if (right <= x || bottom <= y) continue;
    intersected = true;
    const hole = { x, y, width: right - x, height: bottom - y };
    shape = shape.flatMap(region => subtract(region, hole));
    if (shape.length > MAX_REGIONS) throw new RangeError('mpv window region too complex');
    if (!shape.length) break;
  }
  return { bounds, shape: intersected ? shape : [], covered: !shape.length, zoom };
}

module.exports = { normaliseMpvRect, normaliseMpvViewport, mpvWindowRegion };

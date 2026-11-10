import { State } from './state.js';
import { validProjectCanvas } from '../shared/project-canvas.cjs';
export { validProjectCanvas, MAX_CANVAS_DIMENSION, MAX_CANVAS_PIXELS } from '../shared/project-canvas.cjs';

// Source metadata remains separate: importing/relinking media never replaces
// an explicit project canvas, and returning to Auto uses the current source.
export function projectCanvasSize(state = State) {
  if (validProjectCanvas(state.projectCanvas)) return { width: state.projectCanvas.width, height: state.projectCanvas.height };
  const width = Number(state.videoWidth), height = Number(state.videoHeight);
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? { width, height } : { width: 1920, height: 1080 };
}

export function projectCanvasRect(width, height, state = State) {
  if (!(width > 0 && height > 0)) return null;
  const canvas = projectCanvasSize(state);
  const scale = Math.min(width / canvas.width, height / canvas.height);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

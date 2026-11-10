import { State } from './state.js';
import { Project } from './project.js';
import { History, recordHistory } from './history.js';
import { openModal, setStatus } from './ui.js';
import { emit } from './events.js';
import { projectCanvasSize, validProjectCanvas, MAX_CANVAS_DIMENSION } from './project-canvas.js';
import { prepareProjectCanvasPreview, cancelProjectCanvasPreview, syncProjectCanvasPreview } from './project-canvas-preview.js';

export function showProjectSettings() {
  const ownsWorkspace = Project.captureWorkspaceOwnership();
  const ownsHistory = History.captureOwnership();
  const initial = State.projectCanvas;
  const { width, height } = projectCanvasSize();
  let release = () => {};
  let applying = false;
  const owns = () => session.isCurrent() && ownsWorkspace() && ownsHistory() && State.projectCanvas === initial;
  const discard = () => { release(); cancelProjectCanvasPreview(); };
  const session = openModal('專案畫布設定', `
    <p>設定預覽構圖與新交付的預設比例；每份交付仍可另選輸出解析度。套用時會暫停原生預覽。</p>
    <label for="projectCanvasMode">畫布尺寸</label>
    <select id="projectCanvasMode">
      <option value="auto" ${!initial ? 'selected' : ''}>自動（依主影片；未載入時為 1920 × 1080）</option>
      <option value="custom" ${initial ? 'selected' : ''}>自訂</option>
    </select>
    <div style="display:flex;gap:12px;margin:14px 0;align-items:center">
      <label>寬度 <input id="projectCanvasWidth" type="number" min="2" max="${MAX_CANVAS_DIMENSION}" step="1" value="${width}" style="width:100px"> px</label>
      <span aria-hidden="true">×</span>
      <label>高度 <input id="projectCanvasHeight" type="number" min="2" max="${MAX_CANVAS_DIMENSION}" step="1" value="${height}" style="width:100px"> px</label>
    </div>
    <label for="projectCanvasPreset">常用尺寸</label>
    <select id="projectCanvasPreset">
      <option value="">選擇尺寸…</option>
      <option value="1920x1080">1920 × 1080（Full HD）</option>
      <option value="3840x2160">3840 × 2160（4K UHD）</option>
      <option value="1280x720">1280 × 720（HD）</option>
      <option value="1080x1920">1080 × 1920（直式）</option>
      <option value="1080x1080">1080 × 1080（正方形）</option>
    </select>
    <p class="muted">寬高須為 2–8192 的整數，總像素不超過 8192 × 4320。影片等比例置入畫布，未填滿處留黑邊。字幕座標系統維持 1920 × 1080。</p>
    <p id="projectCanvasError" role="alert" style="color:var(--red);min-height:1.4em"></p>`, [
      { label: '取消', act: () => session.close() },
      { label: '套用', primary: true, id: 'projectCanvasApply', act: async () => {
        if (applying) return;
        if (!owns()) {
          discard(); session.close(); return;
        }
        const next = mode.value === 'auto' ? null : { width: Number(w.value), height: Number(h.value) };
        if (next && !validProjectCanvas(next)) {
          document.getElementById('projectCanvasError').textContent = '請輸入有效的整數寬高（2–8192），總像素不得超過 8192 × 4320。';
          return;
        }
        if (next?.width !== initial?.width || next?.height !== initial?.height) {
          applying = true;
          sync();
          const button = document.getElementById('projectCanvasApply');
          button.disabled = true;
          try {
            if (!await prepareProjectCanvasPreview(next, owns)) {
              if (session.isCurrent()) session.close();
              return;
            }
          } catch (error) {
            if (owns()) {
              document.getElementById('projectCanvasError').textContent = '無法套用畫布：' + (error?.message || error);
              void syncProjectCanvasPreview();
            }
            return;
          } finally {
            applying = false;
            if (owns()) { button.disabled = false; sync(); }
          }
          if (!owns()) return;
          State.projectCanvas = next;
          recordHistory('設定專案畫布');
          emit('render:all');
          emit('render:trackStyle');
          emit('project:canvasChanged');
        }
        release();
        session.close({ committed: true });
        const size = projectCanvasSize();
        setStatus(`專案畫布：${size.width} × ${size.height}${next ? '' : '（自動）'}`, 'ok');
      } },
    ], { onDismiss: discard, onReplaced: discard, width: '520px' });
  const mode = document.getElementById('projectCanvasMode');
  const w = document.getElementById('projectCanvasWidth'), h = document.getElementById('projectCanvasHeight');
  const preset = document.getElementById('projectCanvasPreset');
  const sync = () => {
    w.disabled = h.disabled = applying || mode.value === 'auto';
    mode.disabled = preset.disabled = applying;
  };
  mode.addEventListener('change', sync);
  preset.addEventListener('change', () => {
    if (!preset.value) return;
    [w.value, h.value] = preset.value.split('x');
    mode.value = 'custom'; sync();
  });
  for (const input of [w, h]) input.addEventListener('input', () => { preset.value = ''; });
  sync();
  release = Project.onWorkspaceInvalidated(() => { discard(); session.close(); });
  return session;
}

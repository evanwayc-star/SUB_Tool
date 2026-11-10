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
    <div class="project-canvas-form">
    <p class="project-canvas-intro">設定預覽構圖與新交付的預設比例。每份交付仍可另選輸出解析度。</p>
    <div class="project-canvas-field"><label for="projectCanvasMode">尺寸來源</label>
    <select id="projectCanvasMode" aria-describedby="projectCanvasModeHelp">
      <option value="auto" ${!initial ? 'selected' : ''}>自動（依主影片；未載入時為 1920 × 1080）</option>
      <option value="custom" ${initial ? 'selected' : ''}>自訂</option>
    </select><p id="projectCanvasModeHelp" class="project-canvas-help">自訂尺寸保存在專案中，不會隨匯入素材改變。</p></div>
    <div class="project-canvas-field"><label for="projectCanvasPreset">常用尺寸</label>
    <select id="projectCanvasPreset">
      <option value="">選擇尺寸…</option>
      <option value="1920x1080">1920 × 1080（Full HD）</option>
      <option value="3840x2160">3840 × 2160（4K UHD）</option>
      <option value="1280x720">1280 × 720（HD）</option>
      <option value="1080x1920">1080 × 1920（直式）</option>
      <option value="1080x1080">1080 × 1080（正方形）</option>
    </select></div>
    <div class="project-canvas-dimensions">
      <div class="project-canvas-field"><label for="projectCanvasWidth">寬度（px）</label><input id="projectCanvasWidth" type="number" min="2" max="${MAX_CANVAS_DIMENSION}" step="1" value="${width}" aria-describedby="projectCanvasLimits projectCanvasError"></div>
      <div class="project-canvas-field"><label for="projectCanvasHeight">高度（px）</label><input id="projectCanvasHeight" type="number" min="2" max="${MAX_CANVAS_DIMENSION}" step="1" value="${height}" aria-describedby="projectCanvasLimits projectCanvasError"></div>
    </div>
    <p id="projectCanvasLimits" class="project-canvas-help">寬高為 2–8192 的整數，總像素不超過 8192 × 4320。</p>
    <p id="projectCanvasError" class="project-canvas-error" role="alert" hidden></p>
    <div class="project-canvas-summary"><span>畫布尺寸</span><output id="projectCanvasSummary" for="projectCanvasMode projectCanvasWidth projectCanvasHeight"></output></div>
    <p class="project-canvas-help">影片等比例置入，未填滿處留黑邊。字幕座標系統維持 1920 × 1080；套用時會暫停原生預覽。</p>
    </div>`, [
      { label: '取消', act: () => session.close() },
      { label: '套用', primary: true, id: 'projectCanvasApply', act: async () => {
        if (applying) return;
        if (!owns()) {
          discard(); session.close(); return;
        }
        const next = mode.value === 'auto' ? null : { width: Number(w.value), height: Number(h.value) };
        if (next && !validProjectCanvas(next)) {
          showError('請輸入有效的整數寬高（2–8192），總像素不得超過 8192 × 4320。');
          const invalid=[w,h].filter(input=>!Number.isInteger(Number(input.value))||Number(input.value)<2||Number(input.value)>MAX_CANVAS_DIMENSION);
          const fields=invalid.length?invalid:[w,h];
          fields.forEach(input=>input.setAttribute('aria-invalid','true'));fields[0].focus();
          return;
        }
        clearError();
        if (next?.width !== initial?.width || next?.height !== initial?.height) {
          applying = true;
          sync();
          const button = document.getElementById('projectCanvasApply');
          button.disabled = true;
          button.textContent = '套用中…';
          try {
            if (!await prepareProjectCanvasPreview(next, owns)) {
              if (session.isCurrent()) session.close();
              return;
            }
          } catch (error) {
            if (owns()) {
              showError('無法套用畫布：' + (error?.message || error) + '。請重試。');
              void syncProjectCanvasPreview();
            }
            return;
          } finally {
            applying = false;
            if (owns()) { button.disabled = false; button.textContent='套用'; sync(); }
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
  const showError = message => {const error=document.getElementById('projectCanvasError');error.textContent=message;error.hidden=!message;};
  const clearError = () => {showError('');for(const input of [w,h])input.removeAttribute('aria-invalid');};
  const sync = () => {
    w.disabled = h.disabled = applying || mode.value === 'auto';
    mode.disabled = preset.disabled = applying;
    const size=mode.value==='auto'?projectCanvasSize({...State,projectCanvas:null}):{width:Number(w.value),height:Number(h.value)};
    document.getElementById('projectCanvasSummary').textContent=mode.value==='auto'||validProjectCanvas(size)?`${size.width} × ${size.height}${mode.value==='auto'?'（自動）':''}`:'請輸入有效尺寸';
    document.querySelector('.project-canvas-form').setAttribute('aria-busy',String(applying));
  };
  mode.addEventListener('change', () => {clearError();sync();});
  preset.addEventListener('change', () => {
    if (!preset.value) return;
    [w.value, h.value] = preset.value.split('x');
    mode.value = 'custom'; clearError(); sync();
  });
  for (const input of [w, h]) input.addEventListener('input', () => { preset.value = '';clearError();sync(); });
  sync();
  release = Project.onWorkspaceInvalidated(() => { discard(); session.close(); });
  return session;
}

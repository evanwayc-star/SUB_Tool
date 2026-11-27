import { $ } from './dom.js';
import { Media } from './media.js';
import { Project } from './project.js';
import { DESK, State } from './state.js';
import { secToEncore } from './time.js';
import { openModal, showToast } from './ui.js';
import { capturePlayheadOcrCanvas, encodePlayheadOcrRegion } from './playhead-ocr-frame.js';
import { mountPlayheadOcrRegion } from './playhead-ocr-region.js';
import { commitPlayheadOcrCue, PLAYHEAD_OCR_DURATION_SECONDS } from './playhead-ocr-cue.js';
import { FRAME_TEXT_LANGUAGES } from '../shared/screen-text-options.cjs';

// Repeated captures in the same editing session usually share a language and subtitle style.
let lastLanguages = [], lastWhiteSubtitles = false;

export async function openPlayheadOcr() {
  if (!DESK?.recognizeFrameText) {
    showToast('請在桌面版使用播放點本機 OCR。');
    return;
  }
  if ($('modalBg')?.classList.contains('show') && $('playheadOcrStatus')) return;

  const time = Media.displayTime();
  const { fps, dropFrame } = State;
  const ownsWorkspace = Project.captureWorkspaceOwnership();
  const controller = new AbortController();
  const { signal } = controller;
  // Freeze the keypress frame before opening the selector. Encoding waits for the user's crop.
  const capture = capturePlayheadOcrCanvas(time, { signal });
  let frame, originalText, disposeRegion, unsubscribe;
  let selection = null, active = null, cancellation = Promise.resolve();
  let phase = 'capture';
  function stopAttempt() {
    const job = active;
    if (!job) return;
    active = null;
    job.controller.abort();
    if (job.requestId) cancellation = Promise.resolve(DESK.cancelFrameText?.(job.requestId)).catch(() => {});
  }
  const dismiss = () => {
    controller.abort();
    stopAttempt();
    disposeRegion?.();
    unsubscribe?.();
    frame = null;
  };
  const languages = Object.entries(FRAME_TEXT_LANGUAGES).map(([id, name]) =>
    `<label><input type="checkbox" value="${id}"${lastLanguages.includes(id) ? ' checked' : ''}>${name}</label>`).join('');
  const modal = openModal('辨識播放點文字', `<div class="recognition-review">
    <p id="playheadOcrStatus" role="status">正在擷取播放點畫格…</p>
    <div id="playheadOcrOptions" hidden>
      <details class="playhead-ocr-languages"><summary id="playheadOcrLanguageSummary">辨識語言</summary>
        <fieldset class="playhead-ocr-language-list"><legend>可複選，留空自動辨識</legend>${languages}</fieldset>
      </details>
      <label><input type="checkbox" id="playheadOcrWhite"${lastWhiteSubtitles ? ' checked' : ''}>白字字幕增強</label>
    </div>
    <div id="playheadOcrRegion" hidden></div>
    <div id="playheadOcrLabel" hidden><label>字幕文字<textarea id="playheadOcrText" rows="5" dir="auto" aria-describedby="playheadOcrHint"></textarea></label>
    <p id="playheadOcrHint" class="cue-edit-hint">Enter 建立字幕 · Shift+Enter 換行</p></div>
    </div>`, [
    { label:'取消', act:() => modal.close() },
    { label:'開始辨識', id:'playheadOcrStart', hidden:true, primary:true, act:recognize },
    { label:'返回框選', id:'playheadOcrBack', hidden:true, act:() => {
      stopAttempt();
      choose();
      start.focus({ preventScroll:true });
    } },
    { label:'重新框選', id:'playheadOcrReselect', hidden:true, act:() => choose() },
    { label:'建立字幕', id:'playheadOcrConfirm', hidden:true, primary:true, act:confirm },
  ], { width:'860px', closeOnBackdrop:false, onDismiss:dismiss, onReplaced:dismiss });

  const status = $('playheadOcrStatus'), region = $('playheadOcrRegion'), options = $('playheadOcrOptions');
  const editor = $('playheadOcrLabel'), input = $('playheadOcrText'), button = $('playheadOcrConfirm');
  const start = $('playheadOcrStart'), back = $('playheadOcrBack'), reselect = $('playheadOcrReselect');
  const current = () => modal.isCurrent() && !signal.aborted && ownsWorkspace();
  unsubscribe = Project.onWorkspaceInvalidated(() => modal.close());
  button.disabled = true;
  function updateLanguages() {
    lastLanguages = [...options.querySelectorAll('fieldset input:checked')].map(field => field.value);
    $('playheadOcrLanguageSummary').textContent = '辨識語言 · ' +
      (lastLanguages.map(id => FRAME_TEXT_LANGUAGES[id]).join('、') || '自動');
  }
  options.querySelector('fieldset').onchange = updateLanguages;
  $('playheadOcrWhite').onchange = event => { lastWhiteSubtitles = event.target.checked; };
  updateLanguages();

  function updateSelection(value) {
    selection = value;
    start.disabled = selection?.length === 0;
    if (phase === 'select') {
      status.textContent = value === null ? '目前範圍：整張畫格' :
        (start.disabled ? '目前沒有選取範圍。拖曳選取，或雙擊畫面選取整張。' : '目前範圍：已框選的區域');
    }
  }
  function choose(message) {
    if (!current() || !frame) return;
    phase = 'select';
    originalText = undefined;
    region.hidden = options.hidden = false;
    editor.hidden = true;
    start.style.display = '';
    back.style.display = reselect.style.display = button.style.display = 'none';
    button.disabled = true;
    updateSelection(selection);
    if (message) status.textContent = message;
  }

  async function recognize() {
    if (phase !== 'select' || !current() || selection?.length === 0) return;
    phase = 'recognize';
    const job = { controller:new AbortController(), requestId:null };
    active = job;
    const ownsJob = () => current() && active === job;
    const chosenLanguages = lastLanguages.slice();
    const whiteSubtitles = lastWhiteSubtitles;
    region.hidden = options.hidden = true;
    start.style.display = 'none';
    back.style.display = '';
    back.focus({ preventScroll:true });
    status.textContent = selection ? '正在本機辨識框內文字…' : '正在本機辨識整張畫格…';
    try {
      const pngBase64 = await encodePlayheadOcrRegion(frame.canvas, selection, { signal:job.controller.signal, whiteSubtitles });
      await cancellation;
      if (!ownsJob()) return;
      job.requestId = crypto.randomUUID();
      const result = await DESK.recognizeFrameText({ pngBase64, requestId:job.requestId, languages:chosenLanguages });
      if (!ownsJob()) return;
      if (typeof result?.text !== 'string') throw new Error('本機辨識引擎沒有傳回文字結果。');
      originalText = input.value = result.text;
      phase = 'review';
      editor.hidden = false;
      back.style.display = 'none';
      reselect.style.display = button.style.display = '';
      const target = `OCR 軌 · ${secToEncore(frame.time, fps, dropFrame)} · ${PLAYHEAD_OCR_DURATION_SECONDS} 秒`;
      status.textContent = originalText.trim() ? target : `沒有辨識到文字，可重新框選或手動輸入。${target}`;
      button.disabled = !input.value.trim();
      input.focus({ preventScroll:true });
    } catch (error) {
      if (ownsJob()) choose((error.message || '本機畫面文字辨識失敗。') + ' 可重新框選。');
    } finally {
      if (active === job) active = null;
    }
  }
  function confirm() {
    if (phase !== 'review' || !current() || !input.value.trim()) return;
    try {
      commitPlayheadOcrCue({ text:input.value, time:frame.time, fps, dropFrame, originalText, provider:'builtin' });
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    dismiss();
    modal.close({ committed:true });
  }
  input.oninput = () => { button.disabled = !input.value.trim(); };
  input.onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229
        || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !button.disabled) confirm();
  };
  try {
    const captured = await capture;
    if (!current()) return;
    frame = captured;
    disposeRegion = mountPlayheadOcrRegion(region, frame.canvas, updateSelection, recognize);
    choose();
  } catch (error) {
    if (current()) status.textContent = error.message || '無法取得播放點畫格。';
  }
}

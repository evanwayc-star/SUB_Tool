/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/dom.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — DOM 元素參照 */
/* DOM 快捷 */
const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const video   = typeof document !== 'undefined' ? $('video') : null;
const tlScroll= typeof document !== 'undefined' ? $('tlScroll') : null;
const tlLayer = typeof document !== 'undefined' ? $('tlLayer') : null;
const tlTracks= typeof document !== 'undefined' ? $('tlTracks') : null;
const rulerCv = typeof document !== 'undefined' ? $('rulerCanvas') : null;
const sublist = typeof document !== 'undefined' ? $('sublist') : null;
const imageLayer = typeof document !== 'undefined' ? $('imageLayer') : null;
export function isTextEntry(element) {
  if (!element || element.matches?.(':disabled, [readonly]')) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') {
    return ['text','search','url','tel','email','password','number','date','datetime-local','month','time','week'].includes(element.type);
  }
  if (element.isContentEditable || element.contentEditable === 'true' || element.contentEditable === 'plaintext-only') return true;
  const editable = element.closest?.('[contenteditable]');
  return !!editable && ['','true','plaintext-only'].includes(editable.getAttribute('contenteditable').toLowerCase());
}
export function setEnterDefault(button, enabled) {
  button.toggleAttribute('data-enter-default', enabled);
  if (enabled) button.setAttribute('aria-keyshortcuts', 'Enter');
  else button.removeAttribute('aria-keyshortcuts');
}
export { $, video, tlScroll, tlLayer, tlTracks, rulerCv, sublist, imageLayer };

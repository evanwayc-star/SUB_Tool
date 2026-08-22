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
export { $, video, tlScroll, tlLayer, tlTracks, rulerCv, sublist, imageLayer };

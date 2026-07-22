/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/dom.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作或狀態覆寫。
============================================================================== */
/* SUB Tool — DOM 元素參照 */
/* DOM 快捷 */
const $ = id => document.getElementById(id);
const video   = $('video');
const tlScroll= $('tlScroll');
const tlLayer = $('tlLayer');
const tlTracks= $('tlTracks');
const rulerCv = $('rulerCanvas');
const waveCv  = $('waveCanvas');
const sublist=$('sublist');
const imageLayer=$('imageLayer');
export { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv, sublist, imageLayer };


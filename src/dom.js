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
export { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv, sublist };

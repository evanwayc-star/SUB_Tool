/* media-view.js — 媒體事件到 UI 渲染的橋接層
   media.js 發 emit('media:*')，本模組訂閱後呼叫對應的 UI 函式。
   目的：讓 media.js 不再直接 import 任何 UI 模組（mixer / timeline）。 */
import { on } from './events.js';
import { renderAudioTracks, clearMeterStrips } from './mixer.js';
import { drawTimeline, updatePlayhead } from './timeline.js';
import { Media, Wave } from './media.js';
import { $ } from './dom.js';
import { escapeHTML } from './util.js';

export function initMediaView() {
  on('media:audioTracks', renderAudioTracks);
  on('media:timeline',    drawTimeline);
  on('media:clearMeters',  clearMeterStrips);
  on('media:playhead',     updatePlayhead);
  on('media:srcSel',       renderSrcSel);
}

/** 原本住在 Wave 物件裡的 _renderSrcSel，搬到這裡成為純 view 函式。 */
function renderSrcSel() {
  const sel=$('waveSrcSel'); if(!sel) return;
  const activeSrcId = Media.activeSource || 'video';
  const matching = Wave.sources.map((s,i) => ({s, i}))
      .filter(x => (x.s.sourceId || 'video') === activeSrcId);
  const show = matching.length > 1;
  sel.innerHTML = matching.map(x =>
    `<option value="${x.i}">${escapeHTML(String(x.s.label ?? ''))}</option>`
  ).join('');
  if(!matching.find(x => x.i === Wave.srcIdx) && matching.length > 0){
    Wave.selectSource(matching[0].i);
  }
  sel.value = String(Math.max(0, Wave.srcIdx));
  sel.style.display = show ? '' : 'none';
}

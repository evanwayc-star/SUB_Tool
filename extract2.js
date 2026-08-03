const fs = require('fs');

const appFile = 'src/app.js';
let appCode = fs.readFileSync(appFile, 'utf8');

// Capture block from `let _mpvSubT` down to `function styleChanged`
const startIdx = appCode.indexOf('let _mpvSubT=null;');
const endIdx = appCode.indexOf('function styleChanged(){');

if (startIdx === -1 || endIdx === -1) {
  console.error("Could not find bounds");
  process.exit(1);
}

let extractedBlock = appCode.substring(startIdx, endIdx);
let newAppCode = appCode.substring(0, startIdx) + appCode.substring(endIdx);

// Also extract `previewDrag.bind(...)`
const previewDragStart = newAppCode.indexOf('const previewDrag = createPreviewDrag({');
let previewDragBlock = '';
if (previewDragStart !== -1) {
  previewDragBlock = newAppCode.substring(previewDragStart);
  newAppCode = newAppCode.substring(0, previewDragStart);
}

// Modify previewDragBlock to be exported
previewDragBlock = previewDragBlock.replace('const previewDrag', 'export const previewDrag');

// Add setFirstLoad to extracted block
extractedBlock = extractedBlock.replace(
  'let _firstLoad=true;',
  'export let _firstLoad=true;\\nexport function setFirstLoad(v){ _firstLoad=v; }'
);

let rendererCode = `import { $, video, tlScroll, tlLayer } from './dom.js';
import { State, isSel, setSelection, deselect, IS_DESKTOP, saveConfig, trackVisible, videoTrackVisible } from './state.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { emit, on } from './events.js';
import { getExactFps, secToEncore } from './time.js';
import { effStyle, styleToCss, ASS_PLAY_RES, anchorPct } from './substyle.js';
import { escapeHTML } from './util.js';
import { getPlayerAdapter } from './media-player-adapter.js';
import { toASSFromState } from './subio.js';
import { createPreviewDrag } from './pointer-interaction.js';
import { drawTimeline } from './timeline.js';
import { imageBoxOnStage } from './imagegeom.js';
import { fadeAlphaAtTimeline } from './clip-fade.js';
import { recordHistory } from './history.js';
import { showToast } from './ui.js';
import { refreshSelectionUI } from './subtitles.js';

` + extractedBlock;

rendererCode += '\\n' + previewDragBlock;

// Fix up the _presetEdit to State.presetEdit
rendererCode = rendererCode.replace(/_presetEdit/g, 'State.presetEdit');
newAppCode = newAppCode.replace(/_presetEdit/g, 'State.presetEdit');
newAppCode = newAppCode.replace('let State.presetEdit = null;', 'State.presetEdit = null;');
newAppCode = newAppCode.replace('function State.presetEditBegin', 'function _presetEditBegin');
newAppCode = newAppCode.replace('function State.presetEditEnd', 'function _presetEditEnd');
newAppCode = newAppCode.replace(/_firstLoad = false/g, 'setFirstLoad(false)');

// Add import to app.js
const importLine = `"use strict";
import { refreshMpvSubs, renderVideoSub, _syncMpvPanel, renderImageOverlays, _selectImageClip, _imageBoxOf, _stageRect, drawSafeFrame, renderTimecodeWatermark, toggleSafeFrame, toggleTimecodeWatermark, _setSubtitleHover, previewDrag, _firstLoad, setFirstLoad } from './video-renderer.js';
const _videoSub = document.getElementById('videoSub');
const _videoWrap = document.getElementById('videoWrap');\\n`;
newAppCode = newAppCode.replace('"use strict";\\n', importLine);

const funcsToExport = [
  'refreshMpvSubs', 'renderVideoSub', '_syncMpvPanel', 'renderImageOverlays',
  '_selectImageClip', '_imageBoxOf', '_stageRect', 'drawSafeFrame', 'renderTimecodeWatermark',
  'toggleSafeFrame', 'toggleTimecodeWatermark', '_setSubtitleHover'
];

funcsToExport.forEach(f => {
  rendererCode = rendererCode.split("function " + f + "(").join("export function " + f + "(");
});

fs.writeFileSync('src/video-renderer.js', rendererCode);
fs.writeFileSync('src/app.js', newAppCode);

console.log("Extraction successful!");

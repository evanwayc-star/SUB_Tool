import re

app_js = open('src/app.js', 'r', encoding='utf-8').read()

blocks_to_extract = [
    r"function refreshMpvSubs\(revealAfter=false, live=false\)\{.*?(?=\/\* mpv 是 OS)",
    r"\/\* mpv 是 OS .*?function _syncMpvPanel\(\)\{.*?(?=const _videoSub =)",
    r"const _videoSub = \$\('videoSub'\);\nconst _videoWrap = \$\('videoWrap'\);\nlet _videoSubSig = '';\nlet _mpvSubtitleDrag = false;\nlet _hoveredSubEl = null;\n",
    r"function _sendMpvSubtitleGuide\(el\)\{.*?(?=function _setSubtitleHover)",
    r"function _setSubtitleHover\(el\)\{.*?(?=\/\* 影片畫面在)",
    r"let _lastStageH = 0;\nfunction renderVideoSub\(\)\{.*?(?=\n\n\n\n\n)",
    r"let _mpvSubT=null;\nlet _lastMpvSubSend=0;\nlet _revealMpvSubsAfterRefresh=false;\nlet _firstLoad=true;\n"
]

extracted_text = "\n\n/* --- Extracted from app.js --- */\n"
for block in blocks_to_extract:
    match = re.search(block, app_js, re.DOTALL)
    if match:
        extracted_text += match.group(0) + "\n"
        app_js = app_js.replace(match.group(0), "")
    else:
        print("Could not find block: ", block[:30])

app_view_js = open('src/app-view.js', 'r', encoding='utf-8').read()

# Add necessary imports for the extracted blocks
new_imports = """
import { getExactFps } from './time.js';
import { effStyle, styleToCss, ASS_PLAY_RES } from './substyle.js';
import { on, emit } from './events.js';
import { toASSFromState } from './subio.js';
import { escapeHTML } from './util.js';
"""
# Note: $ and Media are already imported in app-view.js
app_view_js = app_view_js.replace("import { getPlayerAdapter } from './media-player-adapter.js';", 
                                  "import { getPlayerAdapter } from './media-player-adapter.js';\n" + new_imports)

app_view_js += extracted_text

app_view_js += """
export { renderVideoSub, refreshMpvSubs, _setSubtitleHover as setSubtitleHover };

export function initAppViewSubtitles() {
  on('render:videoSub', renderVideoSub);
  on('render:mpvSubs', refreshMpvSubs);
  on('app:syncMpvPanel', _syncMpvPanel);
  on('app:setSubtitleHover', _setSubtitleHover);
  on('app:mpvSubtitleDrag', (isDragging) => { _mpvSubtitleDrag = isDragging; });
  on('app:firstLoad', (val) => { _firstLoad = val; });
}
"""
open('src/app-view.js', 'w', encoding='utf-8').write(app_view_js)

# Update app.js
app_js = app_js.replace('import { getStageRect, drawSafeFrame, toggleSafeFrame, syncMpvTimecodeWatermark, renderTimecodeWatermark, toggleTimecodeWatermark } from \'./app-view.js\';',
                        'import { getStageRect, drawSafeFrame, toggleSafeFrame, syncMpvTimecodeWatermark, renderTimecodeWatermark, toggleTimecodeWatermark, renderVideoSub, refreshMpvSubs, setSubtitleHover, initAppViewSubtitles } from \'./app-view.js\';\ninitAppViewSubtitles();')

# Replace direct calls with emit
app_js = app_js.replace('renderVideoSub();', 'emit("render:videoSub");')
app_js = app_js.replace('refreshMpvSubs(', 'emit("render:mpvSubs", ')
app_js = app_js.replace('_syncMpvPanel();', 'emit("app:syncMpvPanel");')
app_js = app_js.replace('_setSubtitleHover(', 'emit("app:setSubtitleHover", ')
app_js = app_js.replace('_mpvSubtitleDrag =', 'emit("app:mpvSubtitleDrag", ')
app_js = app_js.replace('_firstLoad=', 'emit("app:firstLoad", ')

# Export updates in app.js
app_js = app_js.replace('renderVideoSub,', 'renderVideoSub: renderVideoSub,')
app_js = app_js.replace('refreshMpvSubs,', 'refreshMpvSubs: refreshMpvSubs,')
app_js = app_js.replace('setSubtitleHover: _setSubtitleHover,', 'setSubtitleHover: setSubtitleHover,')
app_js = app_js.replace('on(\'mpv:refreshSubs\', refreshMpvSubs);', 'on(\'mpv:refreshSubs\', (revealAfter, live)=>emit("render:mpvSubs", revealAfter, live));')
app_js = app_js.replace('on(\'mpv:sync\', _syncMpvPanel);', 'on(\'mpv:sync\', ()=>emit("app:syncMpvPanel"));')

open('src/app.js', 'w', encoding='utf-8').write(app_js)

print("VideoSub extracted")

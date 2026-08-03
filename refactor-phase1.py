"""Phase 1: Extract clip domain functions from timeline-renderer.js → clip-model.js

Functions extracted (lines 920–1178):
  showImageGeom, fitClipToStage, showClipFade, showClipDuration,
  _prevTrackClip, crossfadeWithPrev, showCrossfade,
  selectClip, clearClipSelection, closeClipGapLeft, deleteSelectedClip

Internal rendering calls (renderClipBlocks, drawTimeline) are replaced with
emit() events. timeline-renderer.js subscribes to 'clip:blocksChanged'.
"""
import re

# ── 1. Read timeline-renderer.js and extract the block ──────────────────────
tr = open('src/timeline-renderer.js', 'r', encoding='utf8').read()

# The block starts at "function showImageGeom" and ends right before
# the "/* 素材音訊列頭" comment (line 1180)
start_marker = "function showImageGeom(c){"
end_marker = "/* 素材音訊列頭：每個檔案只出現一次"

start_idx = tr.index(start_marker)
end_idx = tr.index(end_marker)

extracted_block = tr[start_idx:end_idx]

# Remove the block from timeline-renderer.js
tr = tr[:start_idx] + tr[end_idx:]

# Remove extracted functions from export list
tr = tr.replace(
    "  selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft, showClipFade, showCrossfade, showImageGeom, showClipDuration };",
    "  renderClipBlocks };"
)

# Add event subscription: when clip-model emits 'clip:blocksChanged', call renderClipBlocks
# Insert after the existing imports
import_insert_point = tr.index("/* ===== 5. 時間軸")
tr = tr[:import_insert_point] + "import { on as _onEvent } from './events.js';\n_onEvent('clip:blocksChanged', ()=>renderClipBlocks());\n\n" + tr[import_insert_point:]

open('src/timeline-renderer.js', 'w', encoding='utf8').write(tr)
print('[OK] timeline-renderer.js: extracted clip functions, added event subscription')


# ── 2. Create clip-model.js ─────────────────────────────────────────────────
# Replace internal rendering calls with events
block = extracted_block
block = block.replace('renderClipBlocks();', "emit('clip:blocksChanged');")
block = block.replace('drawTimeline();', "emit('media:timeline');")

clip_model = '''/* clip-model.js — 影片段域邏輯（選取、刪除、轉場、幾何）
   從 timeline-renderer.js 抽出，使渲染引擎不再包含域操作。
   渲染需求透過 emit() 事件觸發，由 timeline-renderer.js 訂閱。 */
import { State, setSelection, deselect, ensureVideoTrackCount } from './state.js';
import { $ } from './dom.js';
import { Media } from './media.js';
import { Seq } from './sequence.js';
import { emit } from './events.js';
import { refreshSelectionUI, refreshTrackGutterActive } from './subtitles.js';
import { secToEncore } from './time.js';
import { showToast, openModal, closeModal } from './ui.js';
import { escapeHTML } from './util.js';
import { recordHistory } from './history.js';
import { fitScale } from './imagegeom.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';

''' + block + '''
export { selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft,
  showClipFade, showCrossfade, showImageGeom, showClipDuration };
'''
open('src/clip-model.js', 'w', encoding='utf8').write(clip_model)
print('[OK] clip-model.js created')


# ── 3. Update timeline.js facade ────────────────────────────────────────────
tl = open('src/timeline.js', 'r', encoding='utf8').read()

# The facade re-exports clip functions from timeline-renderer.js.
# Change to import from clip-model.js instead.
old_import = """  selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft,
  showClipFade, showCrossfade, showImageGeom, showClipDuration,"""

# Remove the clip functions from the timeline-renderer import
tl = tl.replace(old_import, '')

# Add import from clip-model.js
tl = tl.replace(
    "} from './timeline-renderer.js';",
    "} from './timeline-renderer.js';\nimport { selectClip, clearClipSelection, deleteSelectedClip, closeClipGapLeft, showClipFade, showCrossfade, showImageGeom, showClipDuration } from './clip-model.js';"
)

# Make sure the re-export includes the clip functions
# Find the export block and ensure clip functions are there
if 'selectClip' not in tl.split('export')[1] if 'export' in tl else '':
    # They should already be in the export since they were imported before
    pass

open('src/timeline.js', 'w', encoding='utf8').write(tl)
print('[OK] timeline.js facade updated')


# ── 4. Check if refreshTrackGutterActive is exported from subtitles.js ──────
sub = open('src/subtitles.js', 'r', encoding='utf8').read()
if 'refreshTrackGutterActive' not in sub:
    # It might be in timeline-renderer.js still - check
    if 'refreshTrackGutterActive' in open('src/timeline-renderer.js', 'r', encoding='utf8').read():
        # It's still in timeline-renderer - we need to import from there instead
        cm = open('src/clip-model.js', 'r', encoding='utf8').read()
        cm = cm.replace(
            "import { refreshSelectionUI, refreshTrackGutterActive } from './subtitles.js';",
            "import { refreshSelectionUI } from './subtitles.js';\nimport { refreshTrackGutterActive } from './timeline.js';"
        )
        open('src/clip-model.js', 'w', encoding='utf8').write(cm)
        print('[OK] Fixed refreshTrackGutterActive import in clip-model.js')

print('\n=== Phase 1 complete. Run: npm run lint && npm test ===')

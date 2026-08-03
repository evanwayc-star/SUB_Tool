"""Phase 2: Decouple UI rendering from media.js via event bus."""
import re

# ── 1. Patch media.js ──────────────────────────────────────────────────────
m = open('src/media.js', 'r', encoding='utf8').read()

# Add emit import after last existing import line
last_import = m.rfind("import ")
end_of_last_import = m.index('\n', last_import) + 1
m = m[:end_of_last_import] + "import { emit } from './events.js';\n" + m[end_of_last_import:]

# Remove UI imports
m = re.sub(r"import \{ renderAudioTracks, clearMeterStrips \} from '\./mixer\.js';\r?\n", '', m)
m = re.sub(r"import \{ drawTimeline, updatePlayhead \} from '\./timeline\.js';\r?\n", '', m)

# Replace UI calls with emit (order matters – longer first)
m = m.replace('renderAudioTracks()', "emit('media:audioTracks')")
m = m.replace('clearMeterStrips()',   "emit('media:clearMeters')")
m = m.replace('drawTimeline()',       "emit('media:timeline')")
m = m.replace('updatePlayhead()',     "emit('media:playhead')")

# Wave._renderSrcSel / this._renderSrcSel  →  emit
m = m.replace('Wave._renderSrcSel()', "emit('media:srcSel')")
m = m.replace('this._renderSrcSel()', "emit('media:srcSel')")

# Remove _renderSrcSel method body from Wave object
# Find it and replace with nothing (it starts with "_renderSrcSel(){" and ends before "async fromFile")
pat = re.compile(
    r'  _renderSrcSel\(\)\{.*?\n  \},\s*\n',
    re.DOTALL
)
m = pat.sub('', m)

open('src/media.js', 'w', encoding='utf8').write(m)
print('[OK] media.js patched')

# ── 2. Create media-view.js ────────────────────────────────────────────────
view = r"""/* media-view.js — 媒體事件到 UI 渲染的橋接層
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
"""
open('src/media-view.js', 'w', encoding='utf8').write(view)
print('[OK] media-view.js created')

# ── 3. Patch app.js ────────────────────────────────────────────────────────
a = open('src/app.js', 'r', encoding='utf8').read()
# Add import at the very top (before the first line)
a = "import { initMediaView } from './media-view.js';\n" + a
# Call initMediaView() right after initUI()
a = a.replace('initUI();', 'initUI();\n  initMediaView();', 1)
open('src/app.js', 'w', encoding='utf8').write(a)
print('[OK] app.js patched')

# ── 4. Patch test ──────────────────────────────────────────────────────────
t = open('tests/webLargeMediaAudio.test.js', 'r', encoding='utf8').read()
# The test uses vi.resetModules() + dynamic imports. We need to also import
# and init media-view after the dynamic imports of media/mixer.
old = "({ renderAudioTracks } = await import('../src/mixer.js'));"
new = old + "\n  const { initMediaView } = await import('../src/media-view.js');\n  initMediaView();"
t = t.replace(old, new)
open('tests/webLargeMediaAudio.test.js', 'w', encoding='utf8').write(t)
print('[OK] test patched')

print('\n=== Phase 2 complete. Run: npm run lint && npm test ===')

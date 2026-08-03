import re
import os

app_js = open('src/app.js', 'r', encoding='utf-8').read()

app_js = app_js.replace('let _presetEdit = null;', '')
app_js = app_js.replace('_presetEdit=', 'State.presetEdit=')
app_js = app_js.replace('_presetEdit =', 'State.presetEdit =')
app_js = app_js.replace('_presetEdit.', 'State.presetEdit.')
app_js = app_js.replace('_presetEdit?', 'State.presetEdit?')
app_js = app_js.replace('const E=_presetEdit;', 'const E=State.presetEdit;')
app_js = re.sub(r'\b_presetEdit\b', 'State.presetEdit', app_js)

open('src/app.js', 'w', encoding='utf-8').write(app_js)

state_js = open('src/state.js', 'r', encoding='utf-8').read()
if 'presetEdit: null' not in state_js:
    state_js = state_js.replace('audioProject: {},', 'audioProject: {},\n  presetEdit: null,')
    open('src/state.js', 'w', encoding='utf-8').write(state_js)

print("Step 1 done")

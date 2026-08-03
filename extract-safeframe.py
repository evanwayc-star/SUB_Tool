import re

app_js = open('src/app.js', 'r', encoding='utf-8').read()

block1 = r"\/\* 影片畫面在.*?\*\/.*?const STAGE_FALLBACK_W = 1920, STAGE_FALLBACK_H = 1080;\nfunction _stageRect\(\)\{.*?(?=\/\* 安全框（v4\.33）)"
app_js = re.sub(block1, "", app_js, flags=re.DOTALL)

block2 = r"\/\* 安全框（v4\.33）.*?\*\/\nconst _safeFrame = \$\('safeFrame'\);\nfunction drawSafeFrame\(\)\{.*?(?=function toggleSafeFrame)"
app_js = re.sub(block2, "", app_js, flags=re.DOTALL)

block3 = r"function toggleSafeFrame\(\)\{.*?(?=\/\* 時間碼浮水印：)"
app_js = re.sub(block3, "", app_js, flags=re.DOTALL)

app_js = app_js.replace('_stageRect()', 'getStageRect(_videoWrap)')
app_js = app_js.replace('getStageRect: _stageRect', 'getStageRect: () => getStageRect(_videoWrap)')
app_js = app_js.replace('drawSafeFrame()', 'drawSafeFrame(_videoWrap)')

app_js = app_js.replace('import { createPreviewDrag } from \'./pointer-interaction.js\';', 'import { createPreviewDrag } from \'./pointer-interaction.js\';\nimport { getStageRect, drawSafeFrame, toggleSafeFrame } from \'./app-view.js\';')

open('src/app.js', 'w', encoding='utf-8').write(app_js)

print("Safe frame extracted")

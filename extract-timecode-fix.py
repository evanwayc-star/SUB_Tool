import re

app_js = open('src/app.js', 'r', encoding='utf-8').read()

block1 = r"\/\* 時間碼浮水印：.*?\*\/\nconst _timecodeWatermark = \$\('timecodeWatermark'\);\nlet _mpvTimecodeWatermarkSig = '';\n\nfunction syncMpvTimecodeWatermark\(text, rect\)\{.*?(?=function renderTimecodeWatermark)"
app_js = re.sub(block1, "", app_js, flags=re.DOTALL)

block2 = r"function renderTimecodeWatermark\(\)\{.*?(?=function toggleTimecodeWatermark)"
app_js = re.sub(block2, "", app_js, flags=re.DOTALL)

block3 = r"function toggleTimecodeWatermark\(\)\{.*?(?=let _lastStageH = 0;)"
app_js = re.sub(block3, "", app_js, flags=re.DOTALL)

open('src/app.js', 'w', encoding='utf-8').write(app_js)

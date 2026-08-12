import re

with open('docs/版本變更紀錄.md', 'r', encoding='utf-8') as f:
    code = f.read()

search_text = "## [v6.3.17]"

replace_text = """## [v6.3.18]
- 新增：字幕右鍵選單新增「拷貝樣式」與「貼上樣式」選項。
  - 原因：使用者需要快速複製並套用特定字幕的視覺樣式到其他字幕上。
  - 驗證方法：對某句字幕按右鍵選擇「拷貝樣式」，再對其他字幕按右鍵選擇「貼上樣式」，樣式應能成功套用。
- 修復：跨軌道複製與貼上字幕時，字幕樣式未能保留的問題。
  - 原因：在 `pasteCues` 中，字幕被貼到當前軌道時未正確進行樣式保護轉換。現在透過 `planCueStyleAssignment` 保留原始視覺設定。
  - 驗證方法：選取一或多句字幕並複製（Ctrl+C 或選單拷貝），再於其他樣式不同的軌道上貼上，觀察貼上後的字幕視覺外觀不變。

## [v6.3.17]"""

code = code.replace(search_text, replace_text)

with open('docs/版本變更紀錄.md', 'w', encoding='utf-8') as f:
    f.write(code)

print("Changelog updated")

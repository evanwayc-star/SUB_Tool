# 簡體字檢測報告與自動化腳本 (開發者指南)

## 📝 簡介
這份文件提供了字幕檔（.srt）簡體字檢測的自動化 Python 腳本，並規範了檢測報告的輸出格式。程式會將檢測結果自動輸出為 Markdown 格式，方便團隊閱讀、追蹤，也利於整合至 GitHub/GitLab 等版控系統中直接預覽。

## 🚀 核心 Python 檢測腳本
開發者請使用以下腳本進行檢測。該腳本採用了「逐字比對」與「繁體白名單」機制，大幅降低 OpenCC 轉換異體字時的誤判率，並會自動產出 `.md` 格式的報告。

```python
import opencc
import datetime
import os

def generate_markdown_report(srt_file_path, report_file_path):
    # 採用基礎簡轉繁，不進行地區慣用語轉換 (避免屏幕轉螢幕導致長度或字元不符)
    converter = opencc.OpenCC('s2t')
    
    # 台灣常用字白名單，避免 OpenCC 異體字轉換造成誤判 (例如：台->臺)
    whitelist = set(['台', '裡', '著', '面', '才', '只', '它', '嘆', '夠', '峰', '群', '妳'])
    
    report_lines = []
    report_lines.append(f"# 🎬 字幕簡體字檢測報告")
    report_lines.append(f"**檢測檔案:** `{os.path.basename(srt_file_path)}`")
    report_lines.append(f"**檢測時間:** `{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`\n")
    report_lines.append("## 🔍 檢測結果清單\n")
    
    issue_count = 0

    try:
        with open(srt_file_path, 'r', encoding='utf-8') as f:
            for line_number, line in enumerate(f, start=1):
                original_line = line.strip()
                
                # 略過空白行與時間軸
                if not original_line or '-->' in original_line or original_line.isdigit():
                    continue
                    
                converted_line = converter.convert(original_line)
                
                # 發現差異，進行逐字比對
                if original_line != converted_line:
                    found_simplified_chars = []
                    if len(original_line) == len(converted_line):
                        for orig_char, conv_char in zip(original_line, converted_line):
                            if orig_char != conv_char and orig_char not in whitelist:
                                found_simplified_chars.append(orig_char)
                    else:
                        found_simplified_chars.append("長度不同，可能有特殊字元")
                    
                    # 紀錄有問題的行數與字元
                    if found_simplified_chars:
                        issue_count += 1
                        report_lines.append(f"### 🚩 行號：{line_number}")
                        report_lines.append(f"- **發現簡體字：** `{'`, `'.join(found_simplified_chars)}`")
                        report_lines.append(f"- **原句內容：** > {original_line}\n")
                        
        # 總結統計
        if issue_count == 0:
            report_lines.insert(4, "🎉 **完美！未檢測出任何非預期的簡體字。**\n")
        else:
            report_lines.insert(4, f"⚠️ **共發現 {issue_count} 處疑似包含簡體字的台詞，請協助確認。**\n")
            
        # 寫入 Markdown 報告
        with open(report_file_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(report_lines))
            
        print(f"✅ 報告已成功生成：{report_file_path}")
        
    except FileNotFoundError:
        print(f"❌ 找不到檔案：{srt_file_path}")
    except Exception as e:
        print(f"❌ 發生錯誤：{e}")

# 執行範例
if __name__ == '__main__':
    # 請替換為實際的字幕檔路徑
    # generate_markdown_report('movie_subtitle.srt', 'simplified_check_report.md')
    pass
```

## 📊 報告輸出範例 (Expected Output)
腳本執行後產生的 `simplified_check_report.md` 會自動排版成以下易讀的格式：

---
> # 🎬 字幕簡體字檢測報告
> **檢測檔案:** `movie_subtitle.srt`
> **檢測時間:** `2026-07-24 10:25:00`
> 
> ⚠️ **共發現 2 處疑似包含簡體字的台詞，請協助確認。**
> 
> ## 🔍 檢測結果清單
> 
> ### 🚩 行號：15
> - **發現簡體字：** `这`, `样`
> - **原句內容：** > 这件事情怎么会变成这样？
> 
> ### 🚩 行號：42
> - **發現簡體字：** `发`
> - **原句內容：** > 我的头发掉得很嚴重。
---

## 🛠️ 維護建議
如果開發者在未來的檢查中發現有「繁體字」被誤報（例如某些罕用字），只需將該字元加入腳本頂端的 `whitelist` 集合中即可，白名單會隨著專案進行越來越精準。

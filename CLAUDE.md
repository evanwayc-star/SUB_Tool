@AGENTS.md

# Claude Code 的規則入口

第一行使用 Claude Code 的 `@` import，開場即載入共用規則。規則本體只寫在 [AGENTS.md](AGENTS.md)，本檔只保留 Claude Code 專屬接線。

保留第一行原樣：不可換成 Markdown 連結、包進反引號或改成 Windows 符號連結。Markdown 連結曾讓規則看似有入口、實際未載入；反引號也會使 import 被略過。Windows 符號連結另受管理員權限或開發者模式限制。

在 Claude Code 執行 `/context`，確認 Memory files 同時列出 `CLAUDE.md` 與 `AGENTS.md`。缺少後者時，先修正載入，再開始工作。

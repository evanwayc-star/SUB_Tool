@AGENTS.md

---

# 給 Claude Code 的補充

上面第一行的 `@AGENTS.md` 是 Claude Code 的 **import 語法**，會在每次 session 開場把
`AGENTS.md` 全文載入 context。**不要改成 Markdown 連結，也不要把它包進反引號**——
那樣 import 不會生效，規則等於沒載入。

> **真實事故**：這個檔案原本寫的是 ``[`AGENTS.md`](AGENTS.md)`` 這種 Markdown 連結，
> 看起來像是「已經指過去了」，實際上 Claude Code **只自動讀 `CLAUDE.md`，不讀 `AGENTS.md`**
> （官方文件原文：*Claude Code reads `CLAUDE.md`, not `AGENTS.md`*）。
> 於是 `AGENTS.md` 那 100 多行規則從來沒進過 context，只能靠模型自己想到去讀。
> Import 解析還會**刻意跳過反引號內的內容**，所以那個寫法是雙重失效。

Windows 上**不要**改用符號連結（`ln -s AGENTS.md CLAUDE.md`）——那需要管理員權限或開發者模式；
官方建議就是用 `@` import。

**規則本體一律寫在 `AGENTS.md`，不要複製到這裡。** 兩份規則遲早漂掉，那正是本專案發生過的事
（見 `AGENTS.md` §0）。這個檔案只放 Claude Code 專屬的內容。

## 驗證 import 有沒有生效

在 session 裡執行 `/context`，看 **Memory files** 底下有沒有同時列出 `CLAUDE.md` 與 `AGENTS.md`。
沒列到就是沒載入。

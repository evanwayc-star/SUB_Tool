# Domain docs

那些工程 skill 在探索本 repo 時，該怎麼消費領域文件。

## 探索之前先讀

- 根目錄的 **`CONTEXT.md`**（領域詞彙表）
- **`docs/adr/`** —— 讀與你即將動的區域相關的 ADR（架構決策記錄）

本 repo 是**單一 context**，沒有 `CONTEXT-MAP.md`，也沒有 context 專屬的
`src/<context>/docs/adr/`。

> **這些檔案不存在時，安靜跳過就好。** 不要特別指出它們缺席，也不要一開始就
> 建議建立。`/domain-modeling`（由 `/grill-with-docs` 與
> `/improve-codebase-architecture` 帶起）會在真的解決了某個詞彙或決策時
> **順勢建立**它們。

## 檔案結構

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-<決策標題>.md
│   └── 0002-<決策標題>.md
└── src/
```

## 用詞彙表裡的詞

輸出裡提到領域概念時（issue 標題、重構提案、假說、測試名稱），
用 `CONTEXT.md` 定義的那個詞，不要漂移到詞彙表明確避開的同義字。

這對本專案特別重要：它由 **Antigravity IDE、Claude Code、OpenAI Codex
三個工具並行維護**（見 `AGENTS.md` §6）。三方若各自從程式碼推測用詞，
同一個東西很快就會有三種叫法，而且沒有人會發現。

如果你要用的概念還不在詞彙表裡，那是一個訊號——要嘛你正在發明這個專案沒有的
語言（重新考慮），要嘛是真的有缺口（記下來給 `/domain-modeling`）。

## ADR 衝突要講出來

如果你的輸出與既有 ADR 牴觸，**明講**，不要默默覆蓋：

> _與 ADR-0007（維持 vanilla JS，不遷移框架）牴觸——但值得重開，因為……_

這條與 `AGENTS.md` §0 的精神一致：本專案吃過最多虧的就是
「兩份說法並存、沒有人發現它們已經不一致」。

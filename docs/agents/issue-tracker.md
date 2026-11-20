# GitHub Issues 工作流程

需求、PRD 與任務使用 GitHub Issues。在 clone 內執行 `gh`，由 Git remote 決定儲存庫。票單與提交訊息用繁體中文，識別字及標籤保留原文。

**PRs as a request surface: no.** 外部 PR 排除於需求 triage。編號類型不明時，先用 `gh pr view <n>` 判斷。

## 讀票與更新

`fetch the relevant ticket` 指讀取 Issue、標籤與留言。`publish to the issue tracker` 指建立 Issue。多行內文寫入 UTF-8 暫存檔，用 `--body-file` 保留換行。標籤見[分流對照](triage-labels.md)。

```bash
gh issue list --state open --json number,title,labels,assignees
gh issue view <n> --comments
gh issue create --title "需求標題" --body-file <檔案>
gh issue comment <n> --body-file <檔案>
gh issue edit <n> --remove-label needs-triage --add-label ready-for-agent
gh issue close <n>
```

## Wayfinder

- **Map** 使用 `wayfinder:map`，內文維護 `Notes`、`Decisions-so-far`、`Fog`。
- **子票** 連成 GitHub sub-issue，依用途標 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。若無 sub-issues，用 map 的 task list 連結，子票開頭寫 `Part of #<map>`。
- **阻塞** 用 GitHub issue dependencies。以下先讀前置票的數字 database ID，再將它設為子票的 blocker：

```bash
gh api repos/<owner>/<repo>/issues/<blocker-number> --jq .id
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>
```

`issue_dependencies_summary.blocked_by` 計算仍開啟的 blocker。若無原生 dependencies，在子票開頭寫 `Blocked by: #<n>, #<n>`，逐票確認全部關閉。

**領票順序**：依 map 順序找第一張開啟、無 blocker、無 assignee 的子票。本 session 第一個寫入動作是 `gh issue edit <n> --add-assignee "@me"`。完成後先留言附結果與證據，再關票，最後將摘要及連結寫入 map 的 `Decisions-so-far`。

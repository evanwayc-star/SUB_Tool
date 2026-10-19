# Issue tracker：GitHub

需求、PRD 與任務放在 GitHub Issues，以 `gh` CLI 操作。在 clone 中執行時，CLI 依 Git remote 判斷 repository。Issue 內容與提交訊息使用繁體中文，程式識別字與標籤保留原文。

## 讀取與更新

```bash
gh issue view <number> --comments
gh issue list --state open --json number,title,body,labels,comments
gh issue create --title "需求標題" --body-file <UTF-8暫存檔>
gh issue comment <number> --body-file <UTF-8暫存檔>
gh issue edit <number> --add-label "ready-for-agent"
gh issue edit <number> --remove-label "needs-triage"
gh issue close <number>
```

讀票時一併查看標籤與留言。多行內文先寫 UTF-8 暫存檔，用 `--body-file` 保留實際換行，避免把字面 `\n` 當成換行。角色映射以 [triage-labels.md](triage-labels.md)為準。

Skill 要求「publish to the issue tracker」即建立 GitHub Issue；要求「fetch the relevant ticket」即讀取該 Issue 與留言。

## 外部 Pull request

**PRs as a request surface: no.**

外部 PR 不納入需求 triage。GitHub 的 Issue 與 PR 共用編號空間；只有 `#number` 而不確定類型時，可先以 `gh pr view <number>` 判斷，再讀對應資源。不要因編號相同就把 PR 當成需求票。

## Wayfinder 的 map 與子票

Map 是標有 `wayfinder:map` 的 Issue，內文維護 Notes、Decisions-so-far、Fog。子票使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`，並以 GitHub sub-issue 連到 map。

若 repository 不支援 sub-issues，改在 map 放 task list，子票開頭寫 `Part of #<map>`。認領後 assign 給執行者。

### 阻塞關係

優先使用 GitHub 原生 issue dependencies；`issue_id` 必須是 blocker 的數字 database ID：

```bash
gh api repos/<owner>/<repo>/issues/<blocker-number> --jq .id
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>
```

不可傳 `#number` 或 `node_id`。即時閘門看 `issue_dependencies_summary.blocked_by`，該值只計未關閉的 blocker。若不支援原生 dependencies，子票開頭寫 `Blocked by: #<n>, #<n>`，並逐一核對狀態；全部關閉才解除阻塞。

### 找到可以開始的下一張票

1. 列出 map 的未關閉子票，範圍依 sub-issues 或 map task list 確認。
2. 排除仍被阻塞或已有 assignee 的票。
3. 按 map 順序取第一張，以 `gh issue edit <n> --add-assignee @me` 認領；認領是該 session 的第一個寫入動作。
4. 完成後先留言記錄結果與證據，再關票，最後把摘要與連結追加至 map 的 Decisions-so-far。

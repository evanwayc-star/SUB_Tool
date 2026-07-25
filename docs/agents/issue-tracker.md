# Issue tracker：GitHub

本 repo 的 issue 與 PRD 都放在 **GitHub Issues**，一律用 `gh` CLI 操作。
`gh` 在 clone 內執行會自動從 `git remote -v` 推斷 repo，不必指定。

## 慣例

- **建立 issue**：`gh issue create --title "..." --body "..."`。多行內容用 heredoc。
- **讀取 issue**：`gh issue view <number> --comments`，並一併取得 labels。
- **列出 issue**：
  ```bash
  gh issue list --state open --json number,title,body,labels,comments \
    --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```
  視需要加 `--label` 與 `--state` 過濾。
- **留言**：`gh issue comment <number> --body "..."`
- **加／移除標籤**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **關閉**：`gh issue close <number> --comment "..."`

> **本專案的 issue 內容用繁體中文撰寫**，與提交訊息一致（見 `AGENTS.md` §5）。
> 指令、標籤字串與程式碼識別字維持英文。

## Pull request 是否為需求來源

**PRs as a request surface: no.**
_(若本 repo 要把外部 PR 也當成功能請求，改成 `yes`；`/triage` 會讀這個旗標。)_

設為 `yes` 時，PR 會走與 issue 相同的標籤與狀態，改用 `gh pr` 對應指令：

- **讀取 PR**：`gh pr view <number> --comments`，差異用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：
  ```bash
  gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments
  ```
  只保留 `authorAssociation` 為 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的
  （排除 `OWNER`／`MEMBER`／`COLLABORATOR`，那是自己人進行中的 PR）。
- **留言／標籤／關閉**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 與 PR **共用同一個編號空間**，所以看到 `#42` 無法直接判斷是哪一種——
先試 `gh pr view 42`，失敗再退回 `gh issue view 42`。

## 當 skill 說「publish to the issue tracker」

建立一個 GitHub issue。

## 當 skill 說「fetch the relevant ticket」

執行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一個 issue，**子票**是它的 child issue。

- **Map**：一個標了 `wayfinder:map` 的 issue，內容是 Notes／Decisions-so-far／Fog。
  `gh issue create --label wayfinder:map`。
- **子票**：以 GitHub sub-issue 連到 map（用 `gh api` 打 sub-issues endpoint）。
  若該 repo 未啟用 sub-issues，改在 map 內文放 task list，並在子票開頭寫
  `Part of #<map>`。標籤用 `wayfinder:<type>`（`research`／`prototype`／`grilling`／`task`）。
  認領後把票 assign 給執行者。
- **Blocking**：用 GitHub **原生 issue dependencies**（這是 UI 看得到的正規表示法）。
  ```bash
  gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by \
    -F issue_id=<blocker-db-id>
  ```
  **`<blocker-db-id>` 是 blocker 的數字 database id**，用
  `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 取得——
  **不是** `#number`，**也不是** `node_id`。這裡搞錯會靜默建出錯誤的相依。
  GitHub 會回報 `issue_dependencies_summary.blocked_by`（只算未關閉的 blocker，
  那就是即時的閘門）。若該 repo 不支援 dependencies，退回在子票開頭寫
  `Blocked by: #<n>, #<n>`。**所有 blocker 都關閉時，該票才算解除封鎖。**
- **Frontier 查詢**（找出現在可以動工的票）：列出 map 底下未關閉的子票
  （`gh issue list --state open`，範圍限定在 map 的 sub-issues／task list），
  排除仍有未關閉 blocker 的（`issue_dependencies_summary.blocked_by > 0`，
  或 `Blocked by` 行裡還有未關閉的 issue），也排除已有 assignee 的；
  剩下的照 map 內的順序取第一張。
- **認領**：`gh issue edit <n> --add-assignee @me`——這是該 session 的第一個寫入動作。
- **結案**：`gh issue comment <n> --body "<answer>"` → `gh issue close <n>` →
  把 context 指標（gist + 連結）追加到 map 的 Decisions-so-far。

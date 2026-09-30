# Harnessboard

[English](README.md) · **繁體中文**

**用來執行 Claude Code agent 的本機 harness 與任務看板。** 每個任務都在獨立的 git worktree
裡以 headless 方式執行 `claude`。Harnessboard 會把工作交接給新的 session，讓每個 session
的上下文都保持精簡；訂閱額度快用完時也會自動暫停。

> **狀態：早期開發中（0.0.x）。** 執行器、`hb` CLI、網頁看板和 Loop 自主模式都可以使用；
> Windows 與 macOS 還沒有在實機上測試過。

## 為什麼用它

- **上下文保持精簡**：到了收尾門檻（依任務大小為視窗的 30～50%），會要求 agent 先 commit
  並寫一份交接筆記，下一個 session 再從這份筆記重新開始。
- **平行且互相隔離**：每個任務有自己的 worktree 和分支，審核時看的是一份乾淨的 diff。
- **會看額度**：讀取 CLI 回報的用量，快到上限時不再啟動新 session，額度重置後自動續跑。
- **沿用現有登入**：直接呼叫你已經登入的 `claude` CLI，不需要 API key。

## 需求

- Node.js ≥ 22.13（見 `.nvmrc`）
- Git
- 已登入的 [Claude Code](https://docs.claude.com/en/docs/claude-code)
- Linux、macOS 或 Windows（在 Windows 上，Claude Code 需要 Git for Windows）

## 快速開始

```bash
pnpm install && pnpm build           # 從原始碼建置；npm 套件之後提供
alias hb="node $PWD/packages/server/dist/cli.js"

hb serve                             # 終端機 1：排程器、API 和網頁看板
                                     # → 開啟 http://127.0.0.1:4317
cd ~/my-project                      # 終端機 2：任何 git repository
hb add "Fix the flaky date test"     # 建立並排入任務（在自己的 worktree 執行）
hb ls                                # 每個任務的狀態和上下文 %
hb logs 1 -f                         # 即時查看 agent 輸出
hb diff 1                            # 審核改了什麼
hb open 1                            # 在 Claude Code 互動模式中接手這個 session
hb done 1                            # 標記為已審核完成
```

| 指令                                                                                | 用途                                |
| ----------------------------------------------------------------------------------- | ----------------------------------- |
| `hb add <提示> [--size small\|medium\|large] [--soft N --hard N] [--allow 規則...]` | 建立並排入任務                      |
| `hb loop <目標> --verify <指令>`（其餘選項與 `add` 相同）                           | 建立 Loop 任務（見下方）            |
| `add`／`loop` 加上 `--reviewer <agent>`                                             | 由另一個 agent 審查每一步（見下方） |
| `hb agents`                                                                         | 列出 agent 設定檔與是否能執行       |
| `hb ls` / `hb show <id>`                                                            | 列出任務／顯示 session 與上下文用量 |
| `hb logs <id> [-f]`                                                                 | 印出或持續追蹤紀錄                  |
| `hb stop <id>` / `hb resume <id>`                                                   | 停止，或重新排入                    |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                    | 審核、互動接手、完成                |

## Loop 模式

一個 session 做不完的目標，可以用 `hb loop`。做法參考 Anthropic 對長時間執行 agent 的建議：

```bash
hb loop "A CLI calculator with add, subtract, multiply and divide" --verify "npm test"
```

1. **初始 session**：agent 把目標拆成小的 feature，寫出 `feature_list.json` 和
   `progress.md` 並 commit。這一輪不實作任何功能。
2. **每個 session 做一項 feature**：之後每個 session 都從乾淨的上下文開始，先讀進度筆記，
   再實作下一項未完成的 feature、執行驗證指令、標記為通過並 commit。
3. **harness 自己檢查**：每個 session 結束後，Harnessboard 會在 worktree 裡自己執行一次
   `--verify`。只有這個指令成功，feature 才算完成；失敗時，輸出會交給下一個 session。
4. **完成或停下來等審核**：所有 feature 都通過且驗證成功時，任務移到「待審核」。
   如果清單裡的 feature 被刪掉，或連續 `loopStallSessions`（預設 3）個 session 都沒有通過
   驗證的進度，任務會以失敗狀態停下。

驗證指令是必填的，也可以在 repository 的 `.harnessboard.json` 用 `verifyCommand` 設定。
這個指令由你提供，不是由 agent 決定。它透過系統 shell（`sh` 或 `cmd.exe`）執行，
逾時上限 10 分鐘（`verifyTimeoutMinutes`）。agent 只被允許執行這一個指令。

## 審查者：讓 agent 互相監督

幫任務指定審查者後，每完成一步，都會先交給第二個 agent 檢查，通過後任務才繼續。
「一步」指的是完成一個單一任務，或 Loop 中一項 feature 通過驗證。

```bash
hb add "Add input validation to the signup form" --reviewer opus
```

- **唯讀**：審查者在同一個 worktree 裡執行，但只能讀檔案和執行 `git diff`、`git log`、
  `git show`。萬一它還是改了東西，任務會停下來交給你處理。
- **結論**：審查者回覆的開頭必須是 `VERDICT: APPROVE` 或 `VERDICT: CHANGES`，
  後面接要修改的內容。要求修改的內容會交給實作者的下一個 session。
- **有上限**：要求修改超過 `maxReviewRounds`（2）輪，或回覆裡沒有結論時，
  任務會進入「待審核」，由你決定。
- **預設審查者**：設定裡的 `defaultReviewer`（網頁設定也能改）會套用到新任務；
  單一任務可以用 `--reviewer none` 關閉審查。

目前審查者可以是任何 Claude Code 設定檔，例如使用不同模型的設定檔。之後計畫加入 Codex、
Gemini 等 provider，就能讓不同廠商的 agent 互相檢查。

## 網頁看板

`hb serve` 同時在 **http://127.0.0.1:4317** 提供看板：

- **依狀態分欄**：待辦、排隊中、執行中、等待額度、待審核、完成、已停止／失敗。
  拖曳卡片可以排入執行、停止或標為完成；不合理的移動會被擋下。
- **每張卡片都有上下文條**：預算內是藍色，超過收尾門檻變黃色，超過強制門檻變紅色。
  兩個門檻在條上都有刻度。
- **Loop 任務**：卡片上顯示已驗證的 feature 進度；Features 分頁列出每一項 feature，
  以及上次驗證失敗的輸出。
- **額度條**：顯示 5 小時和 7 天的用量，並標出暫停門檻。
- **任務面板**：即時紀錄、相對於基準分支的 diff、session 歷史，以及繼續、停止、完成按鈕。
  也可以複製 `hb open <id>` 指令，到 Claude Code 接手。
- **設定**：同時執行數、額度暫停比例和預設任務大小，會存到使用者設定檔。
- **語言**：English 和繁體中文，自動跟隨瀏覽器語言，也可以在頁首切換。

API 只接受 loopback 的 `Host` 標頭，而且每個寫入請求都必須帶自訂標頭。
因此你瀏覽的其他網頁無法透過瀏覽器操控你的 agent。

## 上下文預算怎麼運作

| 任務大小         | 收尾門檻：要求 agent commit 並寫交接筆記 | 強制門檻：結束 session |
| ---------------- | ---------------------------------------- | ---------------------- |
| `small`          | 30 %                                     | 40 %                   |
| `medium`（預設） | 40 %                                     | 50 %                   |
| `large`          | 50 %                                     | 60 %                   |

下一個 session 會以原始任務加上交接筆記重新開始。百分比是相對於模型的上下文視窗，
視窗大小由 CLI 回報。

## 設定

設定分層，後面的覆蓋前面的：內建預設值 < 使用者設定檔 < 環境變數 < CLI 參數。

- **使用者設定檔**：平台設定目錄下的 `config.json`（Linux 為 `~/.config/harnessboard`）。
- **環境變數**：`HARNESSBOARD_HOME`（資料目錄）、`HARNESSBOARD_PORT`、`HARNESSBOARD_MAX_CONCURRENT`、
  `HARNESSBOARD_LANG`（`en`、`zh-TW`），以及套用到 `claude` 這個 agent 設定檔的
  `HARNESSBOARD_CLAUDE_PATH`／`HARNESSBOARD_MODEL`。
- **每個 repository**：`.harnessboard.json`，可設定 `baseRef`、`allowedTools`、`contextPolicy` 和
  `verifyCommand`。

**Agent 設定檔**：每個設定檔指定一個 agent CLI 以及執行方式。`claude` 一定存在；
其他設定檔可以加在 `config.json`，例如再設定一個使用不同模型的 Claude：

```json
{
  "agents": {
    "claude": { "provider": "claude-code", "command": "claude", "model": null },
    "opus": { "provider": "claude-code", "command": "claude", "model": "opus" }
  }
}
```

目前支援的 provider：`claude-code`。之後要加入 Codex、Gemini 等其他 CLI 的設計，寫在
[docs/architecture.md](docs/architecture.md)。

**權限**：任務以 `--permission-mode acceptEdits` 執行，另外允許幾個 git 指令，讓 agent 可以
commit。要允許更多指令用 `--allow`。`--skip-permissions` 會關閉所有檢查，只能在沙盒環境使用。

## 開發

```bash
corepack enable        # 提供專案指定的 pnpm 版本
pnpm install
pnpm test              # 使用假的 claude CLI，不需要帳號
pnpm lint && pnpm typecheck
pnpm --filter @harnessboard/web dev   # 可熱重載的介面；/api 會轉到執行中的 `hb serve`
```

參與開發請看 [CONTRIBUTING.md](CONTRIBUTING.md)，各版本的變更請看 [CHANGELOG.md](CHANGELOG.md)。
Harnessboard 依賴的 Claude Code 輸出格式記錄在
[docs/stream-json-notes.md](docs/stream-json-notes.md)。

## 授權

[Apache-2.0](LICENSE)。Harnessboard 是獨立專案，與 Anthropic 沒有關係。

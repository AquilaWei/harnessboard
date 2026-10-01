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
| `hb loop <目標> [--verify <指令>]`（其餘選項與 `add` 相同）                         | 建立 Loop 任務（見下方）            |
| `hb plan <id>`／`hb feedback <id> <意見>`／`hb approve <id> --verify <指令>`        | 檢視、討論、確認 Loop 規格          |
| `add`／`loop` 加上 `--reviewer <agent>`                                             | 由另一個 agent 審查每一步（見下方） |
| `hb agents`                                                                         | 列出 agent 設定檔與是否能執行       |
| `hb ls` / `hb show <id>`                                                            | 列出任務／顯示 session 與上下文用量 |
| `hb logs <id> [-f]`                                                                 | 印出或持續追蹤紀錄                  |
| `hb stop <id>` / `hb resume <id>`                                                   | 停止，或重新排入                    |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                    | 審核、互動接手、完成                |
| `hb delete <id>`                                                                    | 刪除沒在執行的任務（見下方）        |
| `hb allow <id> [--suggested] [--rule 規則...]`／`hb deny <id> [原因]`               | 回覆 agent 正在等的工具請求         |
| `add`／`loop` 加上 `--preset git,node,...`；`hb tools <id> [規則...]`               | 選擇允許的工具；查看或修改          |

**刪除任務**（`hb delete`，或任務面板裡的「刪除」）會刪掉它的紀錄和 worktree 資料夾，
還沒 commit 的修改也會一起消失。分支會保留，已經 commit 的成果仍然可以合併；不需要時再用
`git branch -D` 刪除。執行中的任務要先停止才能刪除。

## Loop 模式

一個 session 做不完的目標，可以用 `hb loop`。做法參考 Anthropic 對長時間執行 agent 的建議；
而且在開工之前，會先跟 Claude 確認好規格。

```bash
hb loop "A CLI calculator with add, subtract, multiply and divide"
```

1. **規劃 session**：agent 把目標拆成小的 feature，每項都附上驗收標準，寫進
   `feature_list.json` 和 `progress.md`。
   - 它也會提出建議的驗證指令（例如 `npm test`），並列出需要你決定的問題。
   - 這一輪不實作任何功能。
2. **你確認規格**：任務會停在「需要你處理」。打開任務的「規格」分頁（或執行
   `hb plan <id>`），可以看到 feature、驗收標準、問題和建議的指令。接著二選一：
   - **回覆意見**（`hb feedback <id> "..."`）：規劃者接續同一段對話修改規劃，再請你確認，
     可以來回很多輪。想即時討論，可以用 `hb open <id>` 在 Claude Code 裡開啟同一個 session。
   - **確認開工**（`hb approve <id> --verify "<指令>"`）：確認或修改驗證指令，
     然後以當下的規劃開始實作。
3. **每個 session 做一項 feature**：之後每個 session 都從乾淨的上下文開始，先讀進度筆記，
   再照驗收標準實作下一項未完成的 feature、執行驗證指令、標記為通過並 commit。
4. **harness 自己檢查**：每個 session 結束後，Harnessboard 會在 worktree 裡自己執行一次
   驗證指令。只有這個指令成功，feature 才算完成；失敗時，輸出會交給下一個 session。
5. **完成或停下來等審核**：所有 feature 都通過且驗證成功時，任務移到「待審核」。
   如果清單裡的 feature 被刪掉，或連續 `loopStallSessions`（預設 3）個 session 都沒有通過
   驗證的進度，任務會以失敗狀態停下。

驗證指令一定由你決定。規劃者的建議要等你確認開工才生效，agent 也只被允許執行你確認的
那一個指令。它透過系統 shell（`sh` 或 `cmd.exe`）執行，逾時上限 10 分鐘
（`verifyTimeoutMinutes`）。也可以一開始就指定，用 `--verify`，或在 `.harnessboard.json`
設定 `verifyCommand`。
加上 `--no-confirm-plan` 可以跳過確認，規劃完就直接開工；這時必須提供驗證指令。

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

- **4 個階段，一個螢幕放得下**：
  - **草稿**
  - **進行中**：排隊中、執行中、等待額度
  - **需要你處理**：待審核、失敗、已停止
  - **完成**

  每張卡片會用文字標籤標出確切狀態。

- **每張卡片都用一句話說明狀況**，例如「claude 正在做第 2 項 feature（共 3 項）」、
  「reviewer 正在審查最新一步」、「額度不足暫停中，20:40 繼續」。
- **每張卡片都有下一步的按鈕**：開始、停止、審核或重試。拖曳到其他階段也可以，規則跟按鈕一樣。
- **任務面板**：
  - 最上方說明目前狀況，以及你可以做的動作，例如「標為完成」「再執行一次」。
  - **時間軸**：每個 session 的角色和 agent、交接、驗證結果，以及審查結論和意見。
  - **變更**：相對於基準分支的 diff。
  - **紀錄**：即時紀錄。
  - **詳細資訊**：路徑、agent、上下文預算。
  - 也可以複製 `hb open <id>` 指令，到 Claude Code 接手。
- **選擇 repository**：可以直接輸入路徑（支援 `~`），或按「瀏覽…」一層層點選資料夾，
  git repository 會有標記。欄位會即時檢查你選的路徑：資料夾不存在、不是 repository
  （並提示修正指令），或還沒有任何 commit。
- **上下文條**：session 執行中才顯示。預算內是藍色，超過收尾門檻變黃色，超過上限變紅色，
  兩個門檻都有刻度。Loop 任務另外顯示已驗證的 feature 進度。
- **額度**：頁首顯示 5 小時的用量，點開可以看兩個區間的用量和暫停門檻。
- **設定**：
  - 同時執行數、額度暫停比例、預設任務大小、預設審查者，會存到使用者設定檔。
  - 列出各 agent 設定檔，以及它的 CLI 能不能執行。
  - 語言（English、繁體中文）和外觀（跟隨系統、淺色、深色），只套用在目前的瀏覽器。

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

**權限**：任務以 `--permission-mode acceptEdits` 執行，再加上一份允許的工具規則，例如
`Bash(npm *)`：

- **權限組**在「新增任務」對話框裡勾選（或用 `--preset`），涵蓋常見需求：`git`（預設，讓 agent 可以 commit）、`node`、`python`、`gradle`、
  `docker`、`web`（`WebFetch`、`WebSearch`）和 `files`。`docker` 幾乎等於全開，因為容器
  可以掛載任何資料夾。
- 單條規則用 `--allow` 加上。不是工具規則的內容（例如一段說明文字）會直接被拒絕，
  不會默默失效。
- **其他工具會先問你，不會直接拒絕**：agent 想用規則沒涵蓋的工具時，任務會暫停在
  「等你允許」。你可以允許這一次、允許並把規則加進任務（會預填 agent 建議的規則，例如
  `Bash(node *)`），或拒絕並附上原因讓 agent 知道。終端機用 `hb allow <id> [--suggested]
[--rule 規則...]` 和 `hb deny <id> [原因]`。等待中的任務會佔著執行名額；審查者不會被詢問，
  一律唯讀。
- 任務沒在執行時可以修改規則：看板上是「詳細資料 → 允許的工具 → 編輯」，終端機用
  `hb tools <id> 規則...`。
- `--skip-permissions` 會關閉所有檢查，只能在沙盒環境使用。

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

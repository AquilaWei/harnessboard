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
- **會看額度**：讀取 CLI 回報的用量，快到上限時不再啟動新 session（你對工具請求的回覆也會先暫存），額度重置後自動續跑。
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

| 指令                                                                                | 用途                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `hb add <提示> [--size small\|medium\|large] [--soft N --hard N] [--allow 規則...]` | 建立並排入任務                              |
| `hb loop <目標> [--verify <指令>]`（其餘選項與 `add` 相同）                         | 建立 Loop 任務（見下方）                    |
| `add` 加上 `--criteria <文字>`／`--no-discuss`                                      | 直接給驗收標準，或跳過討論                  |
| `hb plan <id>`／`hb feedback <id> <意見>`／`hb approve <id> [--verify <指令>]`      | 檢視、討論、確認驗收標準或規格              |
| `add`／`loop` 加上 `--reviewer <agent>`                                             | 由另一個 agent 審查每一步（見下方）         |
| `add`／`loop` 加上 `--model <m>`／`--reviewer-model <m>`；`hb models <id>`          | 每個任務各自選模型；查看或修改              |
| `hb agents`                                                                         | 列出 agent 設定檔，以及找到但還沒設定的 CLI |
| `hb ls` / `hb show <id>`                                                            | 列出任務／顯示 session 與上下文用量         |
| `hb logs <id> [-f]`                                                                 | 印出或持續追蹤紀錄                          |
| `hb stop <id>` / `hb resume <id>`                                                   | 停止，或重新排入                            |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                    | 審核、互動接手、完成                        |
| `hb chat <id> <訊息>`                                                               | 傳訊息給任務的 agent，印出它的回覆          |
| `hb commits <id>`                                                                   | 列出任務分支上的 commit                     |
| `hb merge <id>`                                                                     | 把審核過的任務合併回基準分支                |
| `hb delete <id>`                                                                    | 刪除沒在執行的任務（見下方）                |
| `hb allow <id> [--suggested] [--rule 規則...] [--global]`／`hb deny <id> [原因]`    | 回覆 agent 正在等的工具請求                 |
| `add`／`loop` 加上 `--no-auto-approve`；`hb auto <id> [on\|off]`；`hb global-tools` | 調整詢問多寡：見下方「權限」                |
| `add`／`loop` 加上 `--preset git,node,...`；`hb tools <id> [規則...]`               | 選擇允許的工具；查看或修改                  |

**合併任務**（`hb merge`，或在待審核任務的面板按「合併到 main」）會用一個合併 commit
（`Merge task #N: <標題>`）把任務分支合併回它出發的分支，任務的每個 commit 都會保留。
合併後任務標為完成，它的 worktree 和分支會移除。

- 只有當你的工作目錄正好切在那個分支上時才會變動，而且是快轉到合併結果；如果會覆蓋你
  本地的修改，git 會拒絕。
- 如果基準分支在這段期間也改了同一段程式，基準分支不會有任何變動。harness 會改成把基準
  分支合併進任務的 worktree，交給任務的 agent 解決衝突並 commit。任務會回到待審核（有
  審查者的話也會再審一次），確認沒問題後再合併一次。
- 「只標為完成，不合併」保留原本的做法：分支留著讓你自己合併。
- 需要 git 2.38 以上。

**刪除任務**（`hb delete`，或任務面板裡的「刪除」）會刪掉它的紀錄和 worktree 資料夾，
還沒 commit 的修改也會一起消失。分支會保留，已經 commit 的成果仍然可以合併；不需要時再用
`git branch -D` 刪除。執行中的任務要先停止才能刪除。

## 桌面程式

不想開終端機？桌面程式會自己啟動伺服器，並在獨立視窗裡顯示看板。**點圖示，看板就出來了。**

- **下載**：每個版本的安裝檔都放在
  [Releases](https://github.com/AquilaWei/harnessboard/releases) 頁面，附有
  `SHA256SUMS.txt` 可以核對。下載的 AppImage 要先 `chmod +x` 才能執行。
- **或自己打包**：步驟見下方的[自己打包安裝檔](#自己打包安裝檔)。
- **安裝檔**：Linux 有 .deb（Debian、Ubuntu）、.rpm（Fedora、openSUSE）和 AppImage（任何發行版），macOS 有 .dmg（Intel 和 Apple 晶片），
  Windows 有安裝程式（.exe）。
- **仍然需要**：git 和 agent CLI（`claude`、`codex`）。程式會用跟終端機一樣的方式找到它們，
  包括 `~/.local/bin`、nvm 和 Homebrew 安裝的。
- **關掉視窗會繼續在背景執行**，留在系統匣／選單列，任務照跑。要結束請在那裡按
  **結束 Harnessboard**，執行中的 agent 會被正常停止。沒有系統匣的桌面（例如原生 GNOME），
  再開一次程式就會把視窗叫回來。
- **可以和 `hb` 一起用**：如果 `hb serve` 已經在跑，程式會直接顯示那個伺服器，不會再開第二個。
  `hb` 指令也能操作程式啟動的伺服器。
- **伺服器記錄檔**：`<資料資料夾>/logs/desktop-server.log`。
- **目前還沒有簽章**，第一次開啟時：
  - **macOS**：在程式上按右鍵 → **打開** → **打開**（或到「系統設定」→「隱私權與安全性」→
    **強制打開**）。
  - **Windows**：SmartScreen 提示出現時，按**其他資訊** → **仍要執行**。

### 自己打包安裝檔

每個作業系統只能打包自己的安裝檔：.dmg 要在 Mac 上打包，.exe 要在 Windows 上打包。
每次打版本 tag，CI 都會在三個平台跑同樣的步驟。檔案會放在 **`packages/desktop/release/`**，
檔名帶版號（`Harnessboard-0.0.19-…`）。

**每個作業系統都要先有**：Node.js ≥ 22.13、Git，以及這個 repo 的 clone。如果找不到
`corepack`（Node 25 起不再內建），用 `npm install --global corepack@latest` 裝上。
拉了新的程式碼後，打包前要再跑一次 `pnpm build`：`dist` 打包的是最後一次建置的結果。
第一次執行 `dist` 會下載 Electron（約 100 MB）。

#### Linux：Ubuntu / Debian

```bash
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux deb AppImage   # → .deb 和 .AppImage
V=$(node -p "require('./packages/server/package.json').version")
sudo apt install ./packages/desktop/release/Harnessboard-$V-linux-amd64.deb
```

- **這裡用 .deb**：會把 Harnessboard 加到應用程式選單，並裝好需要的套件。
- AppImage 需要 `libfuse2`（24.04 是 `libfuse2t64`）。在 24.04 上還可能被 AppArmor 的沙箱規則
  擋下，.deb 不會。

#### Linux：Fedora

```bash
sudo dnf install rpm-build libxcrypt-compat   # rpmbuild，以及 fpm 工具需要的 libcrypt.so.1
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux rpm      # → .rpm
V=$(node -p "require('./packages/server/package.json').version")
sudo dnf install ./packages/desktop/release/Harnessboard-$V-linux-x86_64.rpm
```

- 裝好後 Harnessboard 會出現在應用程式選單。用 `sudo dnf remove Harnessboard` 移除；
  任務資料留在資料資料夾，不會被刪。
- 沒裝 `libxcrypt-compat` 的話，打包會停在 `libcrypt.so.1: cannot open shared object file`：
  electron-builder 下載的 `fpm` 工具需要它。`--linux AppImage` 則不需要。
- **為什麼不用 Flatpak？** Harnessboard 要執行 `claude`、`codex`、git 和你專案自己的工具，
  Flatpak 的沙箱會把這些全部擋在外面，結果每個指令都得跳出沙箱執行。

#### macOS

```bash
xcode-select --install                        # 還沒裝的話：Git 和建置工具
corepack enable
pnpm install && pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @harnessboard/desktop dist   # → 兩個 .dmg
V=$(node -p "require('./packages/server/package.json').version")
open packages/desktop/release/Harnessboard-$V-mac-arm64.dmg   # Apple 晶片；Intel 用 -mac-x64
```

- 把 **Harnessboard** 拖到「應用程式」。
- `CSC_IDENTITY_AUTO_DISCOVERY=false` 讓 electron-builder 不去用鑰匙圈裡找到的開發者憑證簽章；
  打包出來的是 ad hoc 簽章，跟發佈的版本一樣。

#### Windows

在 PowerShell 裡執行，需要先裝好 [Git for Windows](https://git-scm.com/download/win)：

```powershell
corepack enable                               # 這一行要用系統管理員身分開 PowerShell
pnpm install; pnpm build
pnpm --filter @harnessboard/desktop dist      # → .exe 安裝程式
$V = node -p "require('./packages/server/package.json').version"
.\packages\desktop\release\Harnessboard-$V-win-x64.exe
```

- `corepack enable` 會寫入 Node.js 的安裝資料夾，所以要用系統管理員身分的 PowerShell 跑一次；
  其他指令不用。
- 安裝程式只安裝給你自己的帳號，可以選安裝資料夾。

目前只有 Fedora 的步驟在實機上跑過（打包 .rpm）；Ubuntu、macOS 和 Windows 的步驟是 CI 跑的那一套。

## 驗收標準：先討論再開工

沒有驗收標準的任務不會馬上開始改程式。Claude 會先跟你確認「怎樣才算完成」。

```bash
hb add "加上深色模式切換"                                  # 先討論驗收標準
hb add "加上深色模式切換" --criteria "- 重新整理後仍保持設定"   # 直接開工
```

1. **唯讀討論：** Claude 只閱讀 repo、不改任何東西，接著提出驗收標準並詢問不清楚的地方。
   任務會停在「需要你處理」。
2. **由你決定**（「驗收標準」分頁，或 `hb plan <id>`）：
   - **回覆**（`hb feedback <id> "..."`）：Claude 在同一段對話裡回答並修改驗收標準。
   - **確認**（`hb approve <id>`，或用 `--criteria "..."` 改用你自己的寫法）：可以先修改
     驗收標準再確認。之後規格作者會把你們談定的內容寫成規格檔。
3. **規格提交：** 你確認之後，規格作者會把談定的內容（目標、需求、不做的事、驗收標準）寫進
   `docs/specs/<編號>-<標題>.md` 並 commit，除此之外不改任何檔案。能接續討論時就接續，
   讓每個決定都寫進檔案；若它沒有 commit，Harnessboard 會代為提交。
4. **依標準檢查：** 驗收標準會存在任務上。之後每個 agent 都會被告知先讀規格檔，實作者以此為
   目標，審查者也會逐項檢查。

討論由**規格作者**負責，預設就是執行者，也可以指定別的 agent：
`hb add "..." --spec codex --spec-model <model>`、新增任務對話框的**規格作者**選單，或
`hb models <id> --spec <agent>`。規格作者與執行者不同時，對話不會接續：你確認之後，執行者
會根據確認的驗收標準開一個新的 session。

**測試者（選用）**：加上**測試者**後，執行者每完成一步都會先交給它，再進入審查。它會補寫
該步缺少的測試、執行測試、提交測試，並回覆 `TESTS: PASS` 或 `TESTS: FAIL`。失敗會退回給執行者
（與審查相同，最多兩輪，之後交給你）；通過才進入審查者。它只能修改測試檔，動到其他檔案
任務就會停止。用法：`--tester codex --tester-model <model>`、**測試者**選單，或
`hb models <id> --tester <agent|none>`。只適用於單一任務。

**角色之間的交接**：每個角色在回覆最後寫一段 `## Notes`，交代給後面的角色：做了什麼、做了
哪些決定、哪裡沒把握、下一位該檢查什麼。Harnessboard 會記錄每一段，依時間順序寫進任務工作目錄
裡的 `.harnessboard/notes.md`，下一個角色開始前會被要求先讀它。這個檔案只由 Harnessboard
寫入：每個工作階段開始前都會從它自己的紀錄重新產生，所以沒有 agent 能改動別人的交接；git 也會
忽略它，不會進到任何 commit。可以在任務的**交接**分頁閱讀。沒寫交接段落的角色，會記下整段回覆。
和你的討論不在其中，討論的結果就是規格檔。

審查者要求修改時，修好的版本會先再經過測試者（如果有設定），再回到審查者。

建立任務時就填好的驗收標準會直接採用。`--no-discuss`（或在新增任務對話框取消勾選）
則不設驗收標準直接開工。

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
  任務會進入「待審核」，由你決定。從那裡送回繼續做時，會帶著最後一次審查的意見，
  審查者的輪數也重新計算。
- **逐項完成的任務**：每一步只審查已標為完成的 feature，還沒輪到的不算缺失。
- **預設審查者**：設定裡的 `defaultReviewer`（網頁設定也能改）會套用到新任務；
  單一任務可以用 `--reviewer none` 關閉審查。
- **你的開發規範**：在 `reviewGuidelines`（設定檔或網頁設定）列出規範檔，例如
  coding-standards skill。每次審查都會引用檔案當下的內容，違反規範就算必須修改。
  任何 agent 都適用，Codex 也一樣：

  ```json
  { "reviewGuidelines": ["~/.claude/skills/coding-standards/SKILL.md"] }
  ```

**模型**：每個任務可以分別替執行者和審查者選模型，例如用 Haiku 實作、用 Opus 審查：
`hb add "..." --model haiku --reviewer claude --reviewer-model opus`，或在「新增任務」對話框
的模型選單選。審查者可以是任何 Claude Code 或 Codex 設定檔，讓不同廠商的 agent 互相檢查（Gemini 規劃中）。

模型選單會列出各平台提供給你帳號的模型和說明：Claude Code 讀它自己 `/model` 選單用的目錄
（快取在 `~/.claude` 下；還沒有快取時改列別名 `opus`、`sonnet`、`fable`、`haiku`），Codex 讀它的
模型目錄（`codex debug models`）。舊模型放在**更多模型**底下，也仍然可以手動輸入其他模型 ID。
命令列可用 `hb agents --models <設定檔>` 查看。

## 網頁看板

`hb serve` 同時在 **http://127.0.0.1:4317** 提供看板：

- **名稱旁邊有版本號**：標題列會顯示伺服器的版本（例如 `v0.0.21`），瀏覽器和桌面程式都一樣。
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
  - 最上方說明目前狀況，以及你可以做的動作，例如「標為完成」「照審查意見繼續」。
    審查者仍要求修改時，它的意見會直接列在這裡。
  - **時間軸**：每個 session 的角色和 agent、交接、驗證結果，以及審查結論和意見。
  - **變更**：任務分支上的 commit（點開可看該次的修改），以及相對於基準分支的 diff。
  - **紀錄**：即時紀錄。
  - **詳細資訊**：路徑、agent、上下文預算。
  - **對話：** 任務停止或完成後，可以在任務自己的對話裡直接跟 agent 溝通。它記得目前為止
    的工作，也能修改檔案，但仍受任務的工具規則和權限詢問限制。`/compact` 之類的 slash
    指令會原樣送出。回覆結束後任務會回到原本的狀態。想在 Claude Code 裡操作的話，這個
    分頁也能複製 `hb open <id>` 指令。
- **選擇 repository**：可以直接輸入路徑（支援 `~`），或按「瀏覽…」一層層點選資料夾，
  git repository 會有標記。欄位會即時檢查你選的路徑：資料夾不存在、不是 repository
  （並提示修正指令），或還沒有任何 commit。
- **上下文條**：session 執行中才顯示。預算內是藍色，超過收尾門檻變黃色，超過上限變紅色，
  兩個門檻都有刻度。Loop 任務另外顯示已驗證的 feature 進度。
- **額度**：頁首分別顯示你用到的每個平台（Claude、Codex）的 5 小時用量，點開可以看兩個區間的
  用量和暫停門檻；各平台各自暫停。Claude Code 執行時會回報用量；Codex 不會，所以 Harnessboard
  每分鐘從 Codex 自己存在 `~/.codex/sessions` 的紀錄讀取，你自己在 Codex 裡用掉的也會算進去。
- **設定**：
  - 同時執行數、額度暫停比例、預設任務大小、預設審查者，會存到使用者設定檔。
  - 列出各 agent 設定檔，以及它的 CLI 能不能執行。
  - 語言（English、繁體中文）和外觀（跟隨系統、淺色、深色），只套用在目前的瀏覽器。

API 只接受 loopback 的 `Host` 標頭，以及你為[手機存取](#手機存取)加入的遠端主機，而且每個寫入請求都
必須帶自訂標頭。因此你瀏覽的其他網頁無法透過瀏覽器操控你的 agent。

## 手機存取

在任何地方用手機追進度、核准、回答和建立任務。看板留在你的電腦上，手機經由
[Tailscale](https://tailscale.com) 連過來，不會對網際網路開放任何東西。

1. **安裝 Tailscale**：電腦和手機都裝好，登入同一個 tailnet。在 Tailscale 管理後台打開
   MagicDNS 和 HTTPS 憑證。
2. **加入遠端主機**：在電腦上打開 **設定 → 手機存取**，會顯示這台電腦的 Tailscale 名稱
   （`<machine>.<tailnet>.ts.net`）；按 **加為遠端主機**，再按 **儲存**。
3. **讓 tailnet 連得到看板**：執行一次區塊裡顯示的指令（port 是看板的 port，預設 4317）：

   ```bash
   tailscale serve --bg 4317
   ```

   第一次 HTTPS 連線可能要等 30 秒左右，Tailscale 正在簽發憑證。要關掉時執行
   `tailscale serve reset`。

4. **配對手機**：按 **配對手機**，用手機相機掃描 QR code。配對碼只能用一次，5 分鐘內有效。
   幫手機取個名字，再按 **建立通行金鑰**，手機會要求指紋、臉部或螢幕鎖。通行金鑰建立後才算配對完成。
5. **加到主畫面**（Android 可選；iPhone 要收推播就必須加）：在 Chrome 選單選 **加到主畫面**
   （Safari 在分享選單裡）。之後從主畫面的 Harnessboard 圖示打開，看板會以全螢幕開啟，沒有網址列。
6. **開啟推播通知**（可選）：在手機上打開 **設定**，打開 **任務需要我時通知我**，再允許通知。
   任務等你允許、核准、審查，或失敗時，手機會收到推播，看板關著也收得到。點一下會打開那個任務、
   停在需要你處理的分頁（看板鎖定時先解鎖）。推播只帶任務的編號、標題和狀態，不會帶改動或對話內容。
   關掉這個選項或撤銷手機，就不會再收到推播。

**通行金鑰怎麼保護看板**

- **解鎖**：每次在手機上打開看板（重新整理或伺服器重新啟動都算），以及 30 分鐘沒有使用之後，
  看板都會鎖定。按 **解鎖** 會要求通行金鑰。
- **敏感操作**：距離上次確認超過 5 分鐘時會再問一次，包括建立、開始、核准、回答、合併或刪除任務，
  以及修改設定、agent、工具規則或已配對的裝置。確認後操作會接著完成。
- **手機遺失**：在 **設定 → 手機存取 → 已配對的裝置** 撤銷它，它的下一個請求就會被拒絕。
  沒有備用碼，新手機照同樣步驟配對即可。
- **App 內建的瀏覽器**（例如 LINE）不能使用通行金鑰。看板會提示你；從 App 的選單改用 Chrome
  或 Safari 開啟，配對碼會一起帶過去。
- **在電腦本機上**完全不變：不用配對，也不用通行金鑰。

**建議的 Tailscale 設定**

- 擁有 tailnet 的帳號開啟 **兩步驟登入**。
- 開啟 **裝置核准**，新裝置沒經過你同意就加不進 tailnet。
- 設定 **存取規則（ACL）**，只讓你的手機連到這台電腦，tailnet 裡的其他裝置或分享進來的節點連配對頁面都打不開。

**限制**

- **電腦必須開著**，而且 Harnessboard 在執行（桌面程式或 `hb serve`）。電腦睡眠時連不到。
- **iPhone 的推播通知**需要 iOS 16.4 以上，並從主畫面打開看板；直接在 Safari 裡，開關會顯示收不到推播。
- Tailscale Funnel（公開網際網路）一律拒絕。其他 HTTPS 反向代理也可以用，把它的主機名稱加為遠端主機即可。

## 上下文預算怎麼運作

| 任務大小         | 收尾門檻：要求 agent commit 並寫交接筆記 | 強制門檻：結束 session |
| ---------------- | ---------------------------------------- | ---------------------- |
| `small`          | 30 %                                     | 40 %                   |
| `medium`（預設） | 40 %                                     | 50 %                   |
| `large`          | 50 %                                     | 60 %                   |

下一個 session 會以原始任務加上交接筆記重新開始。百分比是相對於模型的上下文視窗，
視窗大小由 CLI 回報。

**壓縮上下文：** agent 的一個回合結束時（實作者完成一步、審查者給出結論、一次對話回覆），
如果上下文已達 30 % 以上，Harnessboard 會在 session 結束前送出 `/compact`。不會為了壓縮
而中斷工作，回合的結果也還是 agent 自己的回覆。之後再接續同一段對話時（對話、額度暫停後
繼續、驗收標準確認後開工），上下文就會比較小。可以用 `--compact <百分比>` 或 context policy
裡的 `compactPct` 調整，設成 `0` 則關閉。回合進行中仍然適用收尾與強制門檻。

## 設定

設定分層，後面的覆蓋前面的：內建預設值 < 使用者設定檔 < 環境變數 < CLI 參數。

- **使用者設定檔**：平台設定目錄下的 `config.json`（Linux 為 `~/.config/harnessboard`）；
  有設定 `HARNESSBOARD_HOME` 時改放在那個目錄。
- **環境變數**：`HARNESSBOARD_HOME`（資料目錄和設定檔）、`HARNESSBOARD_PORT`、`HARNESSBOARD_MAX_CONCURRENT`、
  `HARNESSBOARD_LANG`（`en`、`zh-TW`），以及套用到 `claude` 這個 agent 設定檔的
  `HARNESSBOARD_CLAUDE_PATH`／`HARNESSBOARD_MODEL`。
- **每個 repository**：`.harnessboard.json`，可設定 `baseRef`、`allowedTools`、`contextPolicy` 和
  `verifyCommand`。

**Agent 設定檔**：每個設定檔指定一個 agent CLI 以及執行方式。`claude` 一定存在。
Harnessboard 會在 PATH 上找 `claude` 和 `codex` 指令，找到但還沒有設定檔的會提示你
（`hb serve` 的輸出、`hb agents`，以及**設定 → Agents**）。在**設定**裡按一下就能加入，或用：

```bash
hb agents --add codex                  # 建立名為 codex 的設定檔，使用 CLI 預設模型
hb agents --add codex --id fast --model gpt-6-luna
```

設定檔存在 `config.json`，也可以直接手寫，例如再設定一個使用不同模型的 Claude：

```json
{
  "agents": {
    "claude": { "provider": "claude-code", "command": "claude", "model": null },
    "opus": { "provider": "claude-code", "command": "claude", "model": "opus" },
    "codex": { "provider": "codex", "command": "codex", "model": null }
  }
}
```

目前支援的 provider：`claude-code` 和 `codex`。Codex 設定檔使用已登入的
[Codex CLI](https://github.com/openai/codex)（`codex exec`），用 ChatGPT 方案登入就不需要 API 金鑰。
Codex 不能逐項詢問工具權限，由它自己的沙箱決定，所以權限規則與提示對它不適用。之後要加入 Gemini
等其他 CLI 的設計，寫在 [docs/architecture.md](docs/architecture.md)。

**權限**：任務以 `--permission-mode acceptEdits` 執行，再加上一份允許的工具規則，例如
`Bash(npm *)`：

- **權限組**在「新增任務」對話框裡勾選（或用 `--preset`），涵蓋常見需求：`git`（預設，讓 agent 可以 commit）、`node`、`python`、`gradle`、
  `docker`、`web`（`WebFetch`、`WebSearch`）和 `files`。`docker` 幾乎等於全開，因為容器
  可以掛載任何資料夾。
- 單條規則用 `--allow` 加上。不是工具規則的內容（例如一段說明文字）會直接被拒絕，
  不會默默失效。
- **危險的工具會先問你，不會直接拒絕**：自動允許（預設，見下方）開啟時，只有危險的工具
  會讓任務暫停；關閉時，規則沒涵蓋的工具都會。任務會暫停在「等你允許」。你可以允許這一次、允許並把規則加進任務（會預填 agent 建議的規則，例如
  `Bash(node *)`），或拒絕並附上原因讓 agent 知道。終端機用 `hb allow <id> [--suggested]
[--rule 規則...]` 和 `hb deny <id> [原因]`。等待中的任務會佔著執行名額；審查者不會被詢問，
  一律唯讀。
- 任務沒在執行時可以修改規則：看板上是「詳細資料 → 允許的工具 → 編輯」，終端機用
  `hb tools <id> 規則...`。
- **所有任務共用的規則：** 在權限詢問按「所有任務都允許」（或 `hb allow <id> --global`），
  規則會存進你使用者設定裡的 `allowedTools`。每個任務的 session 除了自己的規則，也會帶上
  這些規則。可以在「設定」或用 `hb global-tools [規則...]` 修改。
- **自動允許**（預設開啟；建立任務時或在「詳細資料」勾選，`--no-auto-approve`，或
  `hb auto <id> on|off`）：規則沒涵蓋的工具會直接允許，只有危險的才會詢問，並說明原因。
  危險的包括毀掉系統或家目錄（`rm -rf /`、`rm -rf ~`）、寫入磁碟（`mkfs`、
  `dd of=/dev/...`）、關機、寫入系統路徑（`/etc`、`/usr`、`~/.ssh`、`~/.claude`…），
  以及在 worktree 以外遞迴刪除。`git push`、`sudo`、網路指令、容器和 MCP 工具都會直接
  允許。危險的請求只能允許這一次，不會提供「記住規則」。這種清單不可能涵蓋所有風險，所以
  它只是安全網，不等於沙盒。任務執行中也可以切換。0.0.10 之前建立的任務維持原本的設定。
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

[Apache-2.0](LICENSE)。Harnessboard 是獨立專案，與 Anthropic 沒有關係。網頁介面所打包的第三方套件授權見
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

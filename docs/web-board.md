# Web board

`hb serve` also serves the board at **http://127.0.0.1:4317**:

- **Version next to the name:** the header shows the server's version (for example
  `v0.0.21`), in the browser and in the desktop app alike.
- **Four stages that fit one screen:**
  - **Draft**
  - **In progress:** queued, running, or waiting for quota
  - **Needs you:** ready for review, failed, or stopped
  - **Done**

  Each card shows its exact state as a labelled chip.

- **Every card says what is happening** in one sentence, for example "claude is building
  feature 2 of 3", "reviewer is reviewing the latest step", or "Paused for quota; continues
  at 20:40".
- **Every card has one button** for the next step: Start, Stop, Review or Retry. Dragging
  between stages still works and follows the same rules.
- **Task panel:**
  - At the top, the current situation and what you can do about it (for example Mark done
    or Continue with the review). When the reviewer still wants changes, its points are shown
    right there.
  - **Timeline:** each session with its role and agent, handoffs, verification results,
    and reviews with their findings.
  - **Changes:** the commits on the task branch (open one for its patch), then the diff against the base branch.
  - **Log:** the live log.
  - **Details:** tokens, estimated cost and time; paths, agents and budget. The cost is the
    CLI's estimate at API prices; a subscription is not charged per token. A task in review or
    done also shows a one-line summary under its status.
  - **Chat:** talk to the agent in the task's own conversation. It remembers the work so
    far and may change files, under the task's tool rules and permission prompts. Slash
    commands such as `/compact` are sent as they are. The task goes back to its status when
    the reply ends.
    - **While the task is busy**, your message waits as _pending_ and is sent when the
      current step ends; the workflow then carries on. Cancel it until then.
    - To work in Claude Code itself, the tab also copies `hb open <id>`.
- **Picking a repository:** type a path (`~` works) or click Browse… to walk through your
  folders. Git repositories are marked. The field checks what you picked right away: missing
  folder, not a repository (with the command to fix it), or no commits yet.
- **Context meter** while a session runs. It is blue under budget, amber past the wrap-up
  point and red past the limit, with ticks at both. Loop tasks also show verified feature
  progress.
- **Quota:** the header shows the 5-hour usage of each platform you use (Claude, Codex);
  click one for both windows and the pause level. Each platform pauses on its own. Claude
  Code reports usage while it runs; Codex does not, so Harnessboard reads it every minute
  from the session logs Codex keeps under `~/.codex/sessions`, which also counts what you
  used in Codex yourself.
- **Settings:**
  - Concurrency, quota pause level, default task size and default reviewer. These are saved
    to your user config file.
  - The agent profiles and whether each CLI runs.
  - Language (English, 繁體中文) and theme (system, light, dark), which apply to this browser
    only.
  - **Notify me when a task needs me:** a desktop notification from this browser when a task
    waits for permission, approval or review, or fails, while the board is open but not in
    front. Click it to open the task.

The API accepts only loopback `Host` headers, plus the remote hosts you add for
[phone access](phone-access.md), and it requires a custom header on every write. A web page you
visit cannot drive your agents through the browser.

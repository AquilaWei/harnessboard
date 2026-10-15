# Web board

New tasks automatically discuss their specification in Draft. Only explicit spec
approval moves them to Pending, where normal quota and slot scheduling applies.
Prefilled criteria are discussion input, not approval. This applies to the UI, CLI
and API; `confirmPlan` and `queue` creation fields are deprecated and ignored.
CLI `--no-discuss` and `--no-confirm-plan` are no longer supported; `--no-queue`
is deprecated and does not prevent automatic discussion.

`hb serve` also serves the board at **http://127.0.0.1:4317**:

- **Version next to the name:** the header shows the server's version (for example
  `v0.0.21`), in the browser and in the desktop app alike.
- **Five stages that fit one screen:**
  - **Draft:** not started, or its spec is being planned with an agent
  - **Pending:** planned and waiting; the harness starts these by itself, one at a time,
    when the agent's quota allows. Drag a card above or below another to set its order;
    dropping in blank space puts it last.
  - **In progress:** queued, running, or waiting for quota
  - **Needs you:** ready for review, failed, or stopped
  - **Done**

  Each card shows its exact state as a labelled chip.

- **Every card says what is happening** in one sentence, for example "claude is building
  feature 2 of 3", "reviewer is reviewing the latest step", or "Paused for quota; continues
  at 20:40".
- **Every card has one button** for the next step: Plan the spec, Start, Stop, Review or
  Retry. Dragging between stages still works and follows the same rules. You can drag an
  idle task to **Draft** to discuss it again. Only tasks with a confirmed spec can
  move to **Pending** or **In progress**; a running task has to be stopped first.
- **Plan now, run later:** **Plan the spec** discusses a draft with the agent while it stays
  in Draft. When you approve the criteria or plan, the task moves to **Pending** instead of
  starting. Pending tasks start in order whenever quota is available and a slot is free, so
  after the quota resets they are taken up one by one. **Start** on a pending card runs it
  now. Reopening a done task keeps its branch and history; asking for a change on a draft
  that already has a spec rejects or approves the revision like any spec change.
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
    - **After you switch the implementer to another agent**, that agent answers in a new
      conversation, starting from the task and the worktree, and keeps it for the next
      chat and its next workflow step.
    - **While the task is busy**, your message waits as _pending_ and is sent when the
      current step ends; the workflow then carries on. Cancel it until then.
    - To work in Claude Code itself, the tab also copies `hb open <id>`.
- **Models and reasoning effort:** in **New task** and in the task's agents editor, each
  role has a **Reasoning effort** select next to its model. It lists only the levels the
  chosen model offers (with "Profile default", the profile's own model), and each level's
  description shows as its tooltip. **Default** names the level that will apply when one is
  known: the profile's effort, else the CLI's default (Codex names one; Claude Code does
  not). Switching to a model without the chosen level resets it to Default. The select is
  hidden for Gemini CLI, for a model typed by hand, and for "Profile default" when the
  profile names no model. The editor's summary shows the level after the model (`· High`). A stored
  level the model does not offer stays selected as "(not offered by this model)" until you
  pick another.
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
  used in Codex yourself. It is also read at startup, before any task starts. A running
  session also stops as soon as its platform reaches the pause level, and continues in the
  same conversation after the reset. A task that hits the limit waits until the reset time
  the platform gives, or `quotaRetryMinutes` when none is known.
- **Settings:**
  - Concurrency, quota pause level, default task size and default reviewer. These are saved
    to your user config file.
  - The agent profiles and whether each CLI runs, with each profile's default **Reasoning
    effort** (see [configuration](configuration.md#config-files-agents-and-permissions)),
    saved with Save.
  - Language (English, 繁體中文) and theme (system, light, dark), which apply to this browser
    only.
  - **Notify me when a task needs me:** a desktop notification from this browser when a task
    waits for permission, approval or review, or fails, while the board is open but not in
    front. Click it to open the task.

The API accepts only loopback `Host` headers, plus this computer's own Tailscale name and any
`remoteHosts` in `config.json`, for [phone access](phone-access.md), and it requires a custom header on every write. A web page you
visit cannot drive your agents through the browser.

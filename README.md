# opencode-tasks

Scheduled task runner plugin for [OpenCode](https://opencode.ai). Define recurring tasks as markdown files with cron schedules, or let agents schedule one-off tasks via tool calls. A background daemon executes tasks on schedule via `opencode run`.

## Installation

### 1. Add the plugin to your OpenCode config

```json
{
  "plugin": ["opencode-tasks"]
}
```

### 2. Install the scheduler daemon

The daemon runs every 60 seconds and executes any tasks that are due. It auto-detects your platform (macOS launchd or Linux systemd).

```bash
bunx opencode-tasks --install
```

`--install` stages a self-contained copy of the daemon (its `dist/`, bundled
`node_modules/`, and packaged resources) into `~/.local/share/opencode-tasks/`
and points the launchd plist / systemd unit at that copy. This makes the
running daemon independent of how `opencode-tasks` was obtained — `bunx`,
`bun add -g`, or a `bun link`'d checkout — so it won't break if a `bunx`
temp cache is purged, a checkout is moved, or the package is unlinked. The
only thing that matters is re-running `--install` after upgrading. The
installer also resolves a stable absolute `bun` path (preferring the `mise`
shim over a version-pinned `mise` install so bun upgrades don't break it).

### 3. Install the agent skill (optional)

This gives the agent context on how to use the scheduling tools, especially around permissions.

```bash
bunx opencode-tasks --install-skill
```

## Quick start

Create a task file at `~/.config/opencode/tasks/daily-standup.md`:

```yaml
---
schedule: "0 9 * * 1-5"
cwd: ~/projects/my-app
---

Summarize all git commits from yesterday. Include the files changed and a brief
description of each change. Format as a bulleted list.
```

That's it. The scheduler will run this task every weekday at 9 AM.

## Recurring tasks

Recurring tasks are markdown files in `~/.config/opencode/tasks/`. The filename (without `.md`) is used as the task name.

The file has YAML frontmatter followed by the prompt that gets sent to the agent.

### Frontmatter reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | string | no | — | Human-readable description. |
| `schedule` | string | yes | — | 5-field cron expression. Uses system local timezone. |
| `cwd` | string | yes | — | Working directory. Supports `~` expansion. |
| `session_name` | string | no | — | If set, reuses the same session across runs. If omitted, creates a fresh session each run. |
| `model` | string | no | user default | Model in `provider/model` format (e.g., `anthropic/claude-sonnet-4-6`). |
| `agent` | string | no | user default | Agent to use. |
| `permission` | object | no | opencode defaults | Permission config. Same schema as the `permission` key in `opencode.json`. See [Permissions](#permissions). |
| `enabled` | boolean | no | `true` | Set to `false` to temporarily disable without deleting. |

### Cron expression reference

```
┌───────── minute (0-59)
│ ┌───────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌───────── month (1-12)
│ │ │ │ ┌───────── day of week (0-7, 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1-5` | Every weekday at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Every Sunday at midnight |
| `0 9 1 * *` | First day of every month at 9:00 AM |

### Examples

**Daily branch cleanup** (reuses the same session):

```yaml
---
description: Clean up merged git branches
schedule: "0 9 * * *"
cwd: ~/projects/my-app
session_name: daily-cleanup
permission:
  bash:
    "*": "allow"
    "git push *": "deny"
  edit: "deny"
---

Check for local branches that have been merged into main and delete them.
List any branches that look stale but haven't been merged yet.
```

**Weekly project report** (fresh session each time):

```yaml
---
description: Generate a weekly summary of project activity
schedule: "0 8 * * 1"
cwd: ~/projects/my-app
model: anthropic/claude-sonnet-4-6
permission:
  bash:
    "*": "allow"
  edit: "deny"
---

Generate a weekly summary of project activity for the past 7 days.
Include commits, files changed, open PRs, and a brief velocity analysis.
```

## One-off tasks

Agents can schedule one-off tasks using the `schedule_task` tool. These are stored in a SQLite database and executed once at the scheduled time.

The agent has access to these tools:

| Tool | Description |
|------|-------------|
| `schedule_task` | Schedule a one-off task for a specific time |
| `list_tasks` | List all recurring and one-off tasks |
| `cancel_task` | Cancel a pending one-off task or disable a recurring task |
| `task_history` | View execution history for a task |
| `get_task_instructions` | Get the full frontmatter format for recurring tasks |

Example agent interaction:

> "Schedule a task to run the test suite tomorrow at 8 AM"

The agent will call `schedule_task` with the appropriate prompt, time, working directory, and permissions.

## Session loops (`/loop`)

`/loop` schedules a recurring prompt that fires **inside the current session** on a fixed interval. It's modeled after Claude Code's `/loop` and is meant for in-session automation: polling a deployment, waiting on CI, watching a long-running process. Unlike recurring/one-off tasks, loops post into the active opencode session and don't spawn new ones.

Install the slash commands the first time (also installed by `--install-skill`):

```bash
bunx opencode-tasks --install-commands
```

| Command | What it does |
|---------|--------------|
| `/loop 5m check the deploy` | Posts "check the deploy" into this session every 5 minutes. |
| `/loop check the deploy` | Same, with the default interval (5m). |
| `/loop 5m` | Default maintenance prompt, every 5 minutes. |
| `/loop` | Default interval and prompt. |
| `/loop-list` | List active loops in this session. |
| `/loop-stop <id>` | Stop a specific loop. |
| `/loop-stop` | Stop every loop in this session. |

Interval format: `<N><unit>` where unit is `m` (minutes, 1–59), `h` (hours, 1–23), or `d` (days, 1–31). Sub-minute intervals are not supported (opencode's cron is minute-resolution).

### Lifecycle

- Loops are persisted to SQLite, so they survive `opencode --resume` — the plugin re-arms timers the first time it sees an event for that session.
- Each loop has a default 3-day expiry, after which it auto-disables.
- When a session is deleted, its loops are cleaned up automatically.
- Timers live in the plugin process; they only fire while opencode is running with that session open.

### Differences from recurring tasks

| | Recurring task | Session loop |
|---|---|---|
| Where it runs | A fresh `opencode run` subprocess | Inside the active session |
| Driver | OS scheduler daemon (launchd/systemd) | Plugin in-process timers |
| Requires opencode open? | No | Yes |
| Survives restart? | Yes | Yes (re-armed via `--resume`) |
| Defined by | Markdown file in `~/.config/opencode/tasks/` | `/loop` slash command |

## Permissions

Scheduled tasks run in the background with no user present. Any permission set to `"ask"` will effectively be **denied** since there's nobody to approve the prompt.

**Don't use `"ask"` in a scheduled task.** Use `"allow"` for things the task needs to do and `"deny"` for things it shouldn't. There is no third option in a non-interactive session.

Most permissions (`bash`, `edit`, `read`) default to `"allow"` and work fine without explicit configuration.

### Rule order matters

OpenCode evaluates permission rules in declaration order, and the **last matching rule wins** — not the most specific. This is the opposite of how many other permission systems work, and it's a common source of confusion.

In practice: put the catch-all `"*"` rule *first*, and put more specific overrides *after* it. If you flip the order, the catch-all will silently override every specific rule above it.

```yaml
# WRONG — "*": "deny" comes last, so it overrides "git *": "allow".
# git commands will be denied at runtime.
bash:
  "git *": "allow"
  "*": "deny"

# RIGHT — catch-all first, specifics after.
bash:
  "*": "deny"
  "git *": "allow"
```

The example task above (`"*": "allow"` followed by `"git push *": "deny"`) follows this pattern: the catch-all allows everything, and the more specific deny rule comes after to carve out an exception.

### `external_directory` — the common gotcha

The `external_directory` permission defaults to `"ask"`, which means **any file access outside the task's `cwd` will silently fail** in background execution.

If your task reads or writes files outside its working directory, you must explicitly allow those paths:

```yaml
permission:
  external_directory:
    "/tmp/*": "allow"
    "~/other-project/*": "allow"
```

### Rule of thumb

Ask: "Will this task touch any files outside its `cwd`?" If yes, add `external_directory` rules.

## CLI reference

The `opencode-tasks` CLI manages the scheduler daemon and provides task visibility. All commands are available via `bunx`.

```
bunx opencode-tasks --install            Install the system scheduler (launchd/systemd)
bunx opencode-tasks --uninstall          Remove the system scheduler
bunx opencode-tasks --install-skill      Install the scheduled-tasks agent skill
                                         (also installs the /loop slash commands)
bunx opencode-tasks --install-commands   Install just the /loop slash commands
bunx opencode-tasks --status             Show scheduler and task status
bunx opencode-tasks --list               List all tasks with next run times
bunx opencode-tasks --help               Show help
```

The following commands are used internally by the scheduler daemon and generally don't need to be run manually:

```
opencode-tasks --run-once           Run one scheduler tick
opencode-tasks --exec-task <id>     Execute a specific task (used by worker processes)
```

### Example output

```
$ bunx opencode-tasks --status

Scheduler: installed (macos-launchd)
  Plist: ~/Library/LaunchAgents/ai.opencode.scheduled-tasks.plist

Recurring tasks: 2 (1 enabled, 1 disabled)
  daily-cleanup              next: 2026-03-31T13:00:00.000Z   last: completed 2026-03-30T13:00:12.000Z
  weekly-report              disabled

One-off tasks: 1 pending
  abc123def4...  "Run migration check"  scheduled: 2026-03-30T19:00:00.000Z
```

## Session behavior

By default, each task run creates a fresh OpenCode session. This is good for independent, stateless tasks.

If you set `session_name`, the task reuses the same session across runs. The agent can see previous messages and build on prior context. This is useful for tasks like:

- A daily standup that references yesterday's summary
- An ongoing code review that accumulates findings
- A monitoring task that tracks changes over time

```yaml
session_name: daily-standup
```

The session is created on the first run and reused on subsequent runs. Session ID mappings are stored in the SQLite database.

## Architecture

The plugin has three components:

1. **Plugin** (`dist/plugin.js`) — Loaded by OpenCode's Bun-based plugin runtime. Exposes tools to the agent and reads/writes the SQLite database. Uses `bun:sqlite`.

2. **CLI** (`dist/cli.js`, bin: `opencode-tasks`) — Standalone Bun script. Manages the scheduler daemon, runs scheduler ticks, and executes task workers. Uses `bun:sqlite`.

3. **Task files** (`~/.config/opencode/tasks/*.md`) — User-editable recurring task definitions with YAML frontmatter.

Both the plugin and CLI read/write the same SQLite database at `~/.config/opencode/.tasks.db`.

### How tasks execute

```
launchd/systemd (every 60s)
  └─ opencode-tasks --run-once        # scheduler tick
       ├─ checks which tasks are due
       ├─ spawns worker for each due task  # returns immediately
       │    └─ opencode-tasks --exec-task <id>
       │         └─ opencode run ...       # full LLM session
       │              └─ updates DB on completion
       └─ reaps any crashed workers
```

The scheduler tick is non-blocking — it spawns detached worker processes and exits immediately. Each worker runs `opencode run` synchronously, captures the session ID from the JSON output, and updates the database when done.

Concurrency is managed via PID tracking. If a task is already running (its worker PID is still alive), the scheduler skips it.

## Prerequisites

[Bun](https://bun.sh) is required. Both the plugin and CLI use `bun:sqlite` for database access.

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Watch mode
bun run dev
bun test --watch
```

### Project structure

```
src/
  cli.ts              # CLI entry point (opencode-tasks)
  plugin.ts           # OpenCode plugin entry point + /loop command handlers
  lib/
    types.ts          # Shared TypeScript types
    db.ts             # SQLite database (schema, migrations, CRUD)
    sqlite.ts         # SQLite abstraction (bun:sqlite)
    tasks.ts          # Task file parser (frontmatter validation)
    cron.ts           # Cron evaluation (isDue, nextRunTime)
    loops.ts          # /loop argument parsing + interval/cron helpers
    loop-runtime.ts   # In-process timer runtime for session loops
    runner.ts         # Task execution (spawn workers, run opencode)
    installer.ts      # Platform detection + launchd/systemd installation
    __tests__/        # Unit tests
examples/             # Example task files
skill/                # Agent skill (SKILL.md)
commands/             # Slash command markdown (/loop, /loop-stop, /loop-list)
```

## License

MIT

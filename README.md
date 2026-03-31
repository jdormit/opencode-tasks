# opencode-scheduled-tasks

Scheduled task runner plugin for [OpenCode](https://opencode.ai). Define recurring tasks as markdown files with cron schedules, or let agents schedule one-off tasks via tool calls. A background daemon executes tasks on schedule via `opencode run`.

## Installation

### 1. Add the plugin to your OpenCode config

```json
{
  "plugin": ["opencode-scheduled-tasks"]
}
```

### 2. Install the scheduler daemon

The daemon runs every 60 seconds and executes any tasks that are due. It auto-detects your platform (macOS launchd or Linux systemd).

```bash
npx opencode-scheduler --install
```

### 3. Install the agent skill (optional)

This gives the agent context on how to use the scheduling tools, especially around permissions.

```bash
npx opencode-scheduler --install-skill
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

## Permissions

Scheduled tasks run in the background with no user present. Any permission set to `"ask"` will effectively be **denied** since there's nobody to approve the prompt.

Most permissions (`bash`, `edit`, `read`) default to `"allow"` and work fine without explicit configuration.

### `external_directory` — the common gotcha

The `external_directory` permission defaults to `"ask"`, which means **any file access outside the task's `cwd` will silently fail** in background execution.

If your task reads or writes files outside its working directory, you must explicitly allow those paths:

```yaml
permission:
  external_directory:
    "/tmp/*": "allow"
    "~/other-project/*": "allow"
```

For one-off tasks, pass permissions as a JSON string to the `schedule_task` tool:

```json
{"bash": {"*": "allow"}, "external_directory": {"/tmp/*": "allow"}}
```

### Rule of thumb

Ask: "Will this task touch any files outside its `cwd`?" If yes, add `external_directory` rules.

## CLI reference

The `opencode-scheduler` CLI manages the scheduler daemon and provides task visibility.

```
opencode-scheduler                  Run one scheduler tick (default)
opencode-scheduler --run-once       Run one scheduler tick (explicit)
opencode-scheduler --install        Install the system scheduler (launchd/systemd)
opencode-scheduler --uninstall      Remove the system scheduler
opencode-scheduler --install-skill  Install the scheduled-tasks agent skill
opencode-scheduler --status         Show scheduler and task status
opencode-scheduler --list           List all tasks with next run times
opencode-scheduler --help           Show help
```

All commands are also available via `npx`:

```bash
npx opencode-scheduler --status
```

### Example output

```
$ npx opencode-scheduler --status

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

2. **CLI** (`dist/cli.js`, bin: `opencode-scheduler`) — Standalone Node.js script. Manages the scheduler daemon, runs scheduler ticks, and executes task workers. Uses `better-sqlite3`.

3. **Task files** (`~/.config/opencode/tasks/*.md`) — User-editable recurring task definitions with YAML frontmatter.

Both the plugin and CLI read/write the same SQLite database at `~/.config/opencode/.tasks.db`.

### How tasks execute

```
launchd/systemd (every 60s)
  └─ opencode-scheduler --run-once        # scheduler tick
       ├─ checks which tasks are due
       ├─ spawns worker for each due task  # returns immediately
       │    └─ opencode-scheduler --exec-task <id>
       │         └─ opencode run ...       # full LLM session
       │              └─ updates DB on completion
       └─ reaps any crashed workers
```

The scheduler tick is non-blocking — it spawns detached worker processes and exits immediately. Each worker runs `opencode run` synchronously, captures the session ID from the JSON output, and updates the database when done.

Concurrency is managed via PID tracking. If a task is already running (its worker PID is still alive), the scheduler skips it.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run dev
npm run test:watch
```

### Project structure

```
src/
  cli.ts              # CLI entry point (opencode-scheduler)
  plugin.ts           # OpenCode plugin entry point
  lib/
    types.ts          # Shared TypeScript types
    db.ts             # SQLite database (schema, migrations, CRUD)
    sqlite.ts         # Runtime-agnostic SQLite abstraction (bun:sqlite / better-sqlite3)
    tasks.ts          # Task file parser (frontmatter validation)
    cron.ts           # Cron evaluation (isDue, nextRunTime)
    runner.ts         # Task execution (spawn workers, run opencode)
    installer.ts      # Platform detection + launchd/systemd installation
    __tests__/        # Unit tests
examples/             # Example task files
skill/                # Agent skill (SKILL.md)
```

## License

MIT

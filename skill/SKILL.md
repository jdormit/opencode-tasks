---
name: scheduled-tasks
description: Create and manage scheduled tasks for OpenCode. Use when the user wants to schedule one-off or recurring tasks, check task status, or learn how to set up recurring task files. Provides guidance on permissions, cron schedules, and the scheduler daemon.
---

# Scheduled Tasks for OpenCode

You have access to tools for scheduling OpenCode tasks. Tasks can be one-off (run once at a specific time) or recurring (defined as markdown files with cron schedules).

## Available Tools

- `schedule_task` - Schedule a one-off task to run at a specific time
- `list_tasks` - List all scheduled tasks (recurring and one-off)
- `cancel_task` - Cancel a pending one-off task or disable a recurring task
- `task_history` - Get execution history for a task
- `get_task_instructions` - Get the full frontmatter format for recurring task files

## Permissions for Scheduled Tasks

**This is critical.** Scheduled tasks run via `opencode run` in the background with no user present to approve permission prompts. Any permission set to `"ask"` (the default for some permissions) will effectively be denied.

**Rule of thumb: never use `"ask"` in a scheduled task.** There is nobody around to answer the prompt. Use `"allow"` for things the task should be able to do and `"deny"` for things it shouldn't. If you find yourself reaching for `"ask"`, you almost certainly want `"deny"` instead.

You MUST explicitly set permissions for any operations the task needs to perform. The most commonly needed permissions are:

### `bash` permission
Required for any shell commands. Default is `"allow"` for most commands.

### `edit` permission  
Required for file modifications. Default is `"allow"`.

### `external_directory` permission
**This is the most commonly missed permission.** It defaults to `"ask"`, which means any file access outside the task's `cwd` will be silently denied in background execution.

If a task needs to read or write files outside its working directory (e.g., writing to `/tmp`, reading from another project), you MUST allow those paths:

```json
{
  "external_directory": {
    "/tmp/*": "allow",
    "~/other-project/*": "allow"
  }
}
```

### `read` permission
Required for reading files. Default is `"allow"` except for `.env` files.

### Example: Comprehensive permissions for a task

For a one-off task via the `schedule_task` tool, pass permissions as a JSON string:

```json
{
  "bash": { "*": "allow" },
  "edit": "allow",
  "external_directory": { "/tmp/*": "allow" }
}
```

For a recurring task markdown file:

```yaml
permission:
  bash:
    "*": "allow"
  edit: "allow"
  external_directory:
    "/tmp/*": "allow"
    "~/other-project/*": "allow"
```

### Rule order matters — put `"*"` first, specifics after

OpenCode evaluates permission rules **in declaration order**, and the **last matching rule wins**. This is the opposite of the "most specific rule wins" behavior in many other systems. The catch-all `"*"` pattern, if placed *last*, will silently override every more-specific rule above it.

This trap is especially dangerous in scheduled tasks because a misordered `"*": "ask"` will deny everything (since there's no one to answer the prompt), even commands you explicitly tried to allow.

```yaml
# BAD — "git" is supposedly allowed, but the trailing "*" rule wins.
# Every git command effectively becomes "ask", which means denied.
bash:
  "git *": "allow"
  "rg *": "allow"
  "*": "ask"

# GOOD — catch-all goes first; specifics override it.
# (And in a scheduled task, prefer "deny" over "ask" for the catch-all.)
bash:
  "*": "deny"
  "git *": "allow"
  "rg *": "allow"
```

### Rule of thumb

When creating a scheduled task, always ask yourself: "Will this task touch any files outside its `cwd`?" If yes, add `external_directory` rules for those paths.

## One-off Tasks

Use the `schedule_task` tool to create tasks that run once at a specific time.

Key parameters:
- `prompt` - What the opencode agent should do
- `description` - Human-readable label
- `cwd` - Working directory (absolute path or `~` for home)
- `scheduled_at` - ISO 8601 timestamp (e.g., `2026-03-31T09:00:00`)
- `permission` - JSON string with permission config (see above)
- `session_name` - If set, reuses the same session across runs. Omit for fresh session each run.
- `model` - Optional model override (e.g., `anthropic/claude-sonnet-4-6`)
- `agent` - Optional agent override

## Recurring Tasks

Recurring tasks are markdown files in `~/.config/opencode/tasks/`. Use `get_task_instructions` to get the full frontmatter format, then create the file using file tools.

Key points:
- The filename (without `.md`) is the task name (e.g., `daily-cleanup.md` -> task name `daily-cleanup`)
- `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week)
- The markdown body is the prompt sent to the agent
- Set `enabled: false` to temporarily disable without deleting

### Common cron patterns
- `0 9 * * *` - Every day at 9:00 AM (local time)
- `0 9 * * 1-5` - Every weekday at 9:00 AM
- `*/30 * * * *` - Every 30 minutes
- `0 0 * * 0` - Every Sunday at midnight
- `0 9 1 * *` - First day of every month at 9:00 AM

## Scheduler Daemon

Tasks only execute when the scheduler daemon is installed. It runs every 60 seconds via launchd (macOS) or systemd (Linux).

Install: `bunx opencode-tasks --install`
Uninstall: `bunx opencode-tasks --uninstall`
Check status: `bunx opencode-tasks --status`

If the daemon is not installed, warn the user and suggest they install it.

## Session Behavior

- By default (no `session_name`), each run creates a fresh session. Good for independent tasks.
- If `session_name` is set, the same session is reused across runs. Good for tasks that build on previous context (e.g., a daily standup that references yesterday's work).

## Session Loops (`/loop`)

There's a third scheduling primitive aimed at the active user session: `/loop`. Unlike recurring or one-off tasks (which spawn new `opencode run` subprocesses), a session loop fires a prompt **into the session that created it**, on a fixed interval.

Use `/loop` when the user wants something to happen *while they're working* in the current opencode session — polling a deployment, watching CI, repeatedly checking a long-running script. Use a recurring task or `schedule_task` when the work should happen in the background regardless of whether the user is around.

Slash commands (installed via `bunx opencode-tasks --install-commands` or `--install-skill`):

| Command | What it does |
|---------|--------------|
| `/loop 5m check the deploy` | Posts "check the deploy" into the current session every 5 minutes |
| `/loop check the deploy` | Same, with the default 5-minute interval |
| `/loop 5m` | Default maintenance prompt at 5-minute intervals |
| `/loop-list` | Show active loops in this session |
| `/loop-stop <id>` | Stop a specific loop |
| `/loop-stop` | Stop every loop in this session |

Interval format is `<N><unit>` where unit is `m` (1–59 minutes), `h` (1–23 hours), or `d` (1–31 days). Sub-minute intervals (`30s`) are rejected because opencode's cron resolution is one minute.

Loops have a 3-day default expiry, survive `opencode --resume`, and are automatically deleted when the session is deleted.

**The user invokes `/loop` themselves.** You don't have a tool for it — it's a CLI feature, not an agent feature. If a user asks you to "loop" something, point them at the `/loop` command.

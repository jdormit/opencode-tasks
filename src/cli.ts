import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { TaskDatabase, getDefaultDbPath } from "./lib/db.js";
import { readAllTasks } from "./lib/tasks.js";
import { isDue, getNextRunTime } from "./lib/cron.js";
import {
  spawnWorker,
  isProcessAlive,
  execTaskAndUpdateDb,
} from "./lib/runner.js";
import {
  install,
  uninstall,
  getInstallInfo,
  isInstalled,
} from "./lib/installer.js";
import {
  scheduleOneoffTask,
  formatScheduledTaskMessage,
  ScheduleTaskError,
} from "./lib/schedule.js";
import type { TaskExecConfig } from "./lib/types.js";

/** Absolute path to this script (used to spawn worker subprocesses) */
const SCHEDULER_PATH = fileURLToPath(import.meta.url);

/**
 * Reap completed worker processes.
 *
 * For each task with status='running' and a PID set, check if the
 * process is still alive. If it's dead, the worker either completed
 * normally (and already updated the DB) or crashed. If the DB still
 * shows 'running', the worker crashed -- mark it as failed.
 */
function reapWorkers(db: TaskDatabase): void {
  // Reap recurring task runs
  for (const run of db.getRunningTaskRuns()) {
    if (!run.pid) continue;
    if (!isProcessAlive(run.pid)) {
      // Worker exited but didn't update DB -> it crashed
      db.completeTaskRun(run.id, "failed", {
        error: `Worker process (PID ${run.pid}) exited unexpectedly`,
      });
      log(
        `Reaped crashed worker for "${run.taskName}" (PID ${run.pid})`,
        "error"
      );
    }
  }

  // Reap one-off tasks
  for (const task of db.getRunningOneoffTasks()) {
    if (!task.pid) continue;
    if (!isProcessAlive(task.pid)) {
      db.updateOneoffTaskStatus(task.id, "failed", {
        error: `Worker process (PID ${task.pid}) exited unexpectedly`,
      });
      log(
        `Reaped crashed worker for one-off "${task.description}" (PID ${task.pid})`,
        "error"
      );
    }
  }
}

/**
 * Run one scheduler tick: reap dead workers, check all tasks,
 * and spawn workers for any that are due.
 */
function runTick(): void {
  const db = new TaskDatabase(getDefaultDbPath());

  try {
    // Phase 1: Clean up stale records (no PID, very old)
    const staleCount = db.cleanupStaleRuns();
    if (staleCount > 0) {
      log(`Cleaned up ${staleCount} stale running record(s)`);
    }

    // Phase 2: Reap completed/crashed workers
    reapWorkers(db);

    // Phase 3: Check recurring tasks and spawn workers for due ones
    const { tasks, errors } = readAllTasks();
    for (const { file, error } of errors) {
      log(`Error parsing task file "${file}": ${error}`, "error");
    }

    for (const task of tasks) {
      if (!task.enabled) continue;

      if (db.hasRunningTask(task.name)) {
        continue; // Already running, skip silently
      }

      const lastRun = db.getLastSuccessfulTaskRun(task.name);
      if (!isDue(task.schedule, lastRun?.startedAt)) {
        continue;
      }

      log(`Spawning worker for recurring task: ${task.name}`);
      const run = db.createTaskRun(task.name);

      try {
        const pid = spawnWorker(SCHEDULER_PATH, run.id, false);
        db.setTaskRunPid(run.id, pid);
        log(`  Worker spawned (PID ${pid}, run ${run.id})`);
      } catch (err: any) {
        db.completeTaskRun(run.id, "failed", {
          error: `Failed to spawn worker: ${err.message}`,
        });
        log(`  Failed to spawn worker: ${err.message}`, "error");
      }
    }

    // Phase 4: Check one-off tasks and spawn workers for due ones
    const dueTasks = db.getDueOneoffTasks();
    for (const task of dueTasks) {
      if (db.hasRunningOneoffTask(task.id)) {
        continue;
      }

      log(`Spawning worker for one-off task: ${task.description} (${task.id})`);
      db.updateOneoffTaskStatus(task.id, "running");

      try {
        const pid = spawnWorker(SCHEDULER_PATH, task.id, true);
        db.updateOneoffTaskStatus(task.id, "running", { pid });
        log(`  Worker spawned (PID ${pid})`);
      } catch (err: any) {
        db.updateOneoffTaskStatus(task.id, "failed", {
          error: `Failed to spawn worker: ${err.message}`,
        });
        log(`  Failed to spawn worker: ${err.message}`, "error");
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Execute a single task synchronously (worker subprocess mode).
 *
 * Called via: scheduler --exec-task <runId> [--oneoff]
 * Runs opencode run, parses output, updates DB, then exits.
 */
async function execTask(runId: string, isOneoff: boolean): Promise<void> {
  const db = new TaskDatabase(getDefaultDbPath());

  try {
    let config: TaskExecConfig;

    if (isOneoff) {
      const task = db.getOneoffTask(runId);
      if (!task) {
        throw new Error(`One-off task not found: ${runId}`);
      }
      config = {
        name: `oneoff-${task.id.slice(0, 8)}`,
        prompt: task.prompt,
        cwd: task.cwd,
        sessionName: task.sessionName,
        model: task.model,
        agent: task.agent,
        permission: task.permission,
      };
    } else {
      // For recurring tasks, we need to look up the task file by name
      // The run ID maps to a task_runs record which has the task_name
      const runs = db.getTaskRunHistory(runId, 1);
      // runId here is actually the task_runs.id, look it up directly
      const allRuns = db.getRunningTaskRuns();
      const run = allRuns.find((r) => r.id === runId);
      if (!run) {
        throw new Error(`Task run not found: ${runId}`);
      }

      const { tasks } = readAllTasks();
      const task = tasks.find((t) => t.name === run.taskName);
      if (!task) {
        throw new Error(`Task file not found for: ${run.taskName}`);
      }

      config = {
        name: task.name,
        prompt: task.prompt,
        cwd: task.cwd,
        sessionName: task.sessionName,
        model: task.model,
        agent: task.agent,
        permission: task.permission,
      };
    }

    await execTaskAndUpdateDb(config, runId, isOneoff, db);
  } finally {
    db.close();
  }
}

// --- CLI display commands ---

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_STATUS_LIMIT = 3;

/**
 * Format a single one-off task as a multi-line block for display.
 * Used by both --list and --status so output stays consistent.
 */
function formatOneoffTask(task: import("./lib/types.js").OneoffTask): string {
  const idShort = task.id.length > 12 ? `${task.id.slice(0, 12)}...` : task.id;
  const lines: string[] = [];
  lines.push(`  ${idShort}  [${task.status}]  "${task.description}"`);

  if (task.status === "pending") {
    lines.push(`    scheduled: ${localTime(task.scheduledAt)}`);
  } else if (task.status === "running") {
    if (task.executedAt) {
      lines.push(`    started: ${localTime(task.executedAt)}`);
    }
    if (task.pid) {
      lines.push(`    pid: ${task.pid}`);
    }
  } else {
    // completed / failed / cancelled
    if (task.executedAt) {
      lines.push(`    executed: ${localTime(task.executedAt)}`);
    } else {
      lines.push(`    scheduled: ${localTime(task.scheduledAt)}`);
    }
  }

  if (task.sessionId) {
    lines.push(`    session: ${task.sessionId}`);
  }
  if (task.error) {
    const truncated =
      task.error.length > 200 ? `${task.error.slice(0, 200)}...` : task.error;
    // Indent multi-line errors so the report stays readable.
    const indented = truncated.split("\n").join("\n      ");
    lines.push(`    error: ${indented}`);
  }
  return lines.join("\n");
}

function listTasks(limit: number): void {
  const db = new TaskDatabase(getDefaultDbPath());

  try {
    const { tasks, errors } = readAllTasks();
    if (errors.length > 0) {
      for (const { file, error } of errors) {
        console.error(`Error in "${file}": ${error}`);
      }
    }

    if (tasks.length > 0) {
      console.log("Recurring tasks:");
      console.log("");
      for (const task of tasks) {
        const lastRun = db.getLastTaskRun(task.name);
        const statusStr = task.enabled ? "enabled" : "disabled";
        let nextStr = "";
        let lastStr = "never";

        if (task.enabled) {
          try {
            nextStr = `next: ${localTime(getNextRunTime(task.schedule))}`;
          } catch {
            nextStr = "next: invalid cron";
          }
        }

        if (lastRun) {
          lastStr = `${lastRun.status} ${localTime(lastRun.startedAt)}`;
        }

        console.log(
          `  ${task.name.padEnd(24)} ${statusStr.padEnd(10)} ${nextStr.padEnd(40)} last: ${lastStr}`
        );
      }
    } else {
      console.log("No recurring tasks found.");
    }

    const oneoffs = db.getRecentOneoffTasks(limit);
    if (oneoffs.length > 0) {
      console.log("");
      console.log(`Recent one-off tasks (last ${oneoffs.length}):`);
      console.log("");
      for (const task of oneoffs) {
        console.log(formatOneoffTask(task));
      }
    }
  } finally {
    db.close();
  }
}

function showStatus(limit: number): void {
  const info = getInstallInfo();
  const platform = info.platform === "unsupported" ? "unknown" : info.platform;

  if (info.installed) {
    console.log(`Scheduler: installed (${platform})`);
    if (info.details) {
      console.log(`  ${info.details}`);
    }
  } else {
    console.log(`Scheduler: not installed (detected platform: ${platform})`);
    console.log("  Run: bunx opencode-tasks --install");
  }

  console.log("");

  const db = new TaskDatabase(getDefaultDbPath());
  try {
    const { tasks, errors } = readAllTasks();
    const enabled = tasks.filter((t) => t.enabled);
    const disabled = tasks.filter((t) => !t.enabled);

    console.log(
      `Recurring tasks: ${tasks.length} (${enabled.length} enabled, ${disabled.length} disabled)`
    );

    for (const task of tasks) {
      const lastRun = db.getLastTaskRun(task.name);
      if (!task.enabled) {
        console.log(`  ${task.name.padEnd(24)} disabled`);
        continue;
      }

      let nextStr = "";
      try {
        nextStr = `next: ${localTime(getNextRunTime(task.schedule))}`;
      } catch {
        nextStr = "next: invalid cron";
      }

      let lastStr = "never run";
      if (lastRun) {
        lastStr = `${lastRun.status} ${localTime(lastRun.startedAt)}`;
        if (lastRun.sessionId) {
          lastStr += `  session: ${lastRun.sessionId}`;
        }
      }

      console.log(
        `  ${task.name.padEnd(24)} ${nextStr.padEnd(44)} last: ${lastStr}`
      );
    }

    if (errors.length > 0) {
      console.log("");
      console.log(`Task file errors: ${errors.length}`);
      for (const { file, error } of errors) {
        console.log(`  ${file}: ${error}`);
      }
    }

    const oneoffs = db.getRecentOneoffTasks(limit);
    if (oneoffs.length > 0) {
      console.log("");
      console.log(`Recent one-off tasks (last ${oneoffs.length}):`);
      for (const task of oneoffs) {
        console.log(formatOneoffTask(task));
      }
    }

    console.log("");
    console.log("To view a task session: opencode -s <session-id>");
  } finally {
    db.close();
  }
}

/**
 * Parse a `--limit <n>` flag from a list of args. Returns the parsed
 * value (a positive integer) or the supplied default. Throws on
 * malformed input.
 */
export function parseLimitArg(args: string[], defaultLimit: number): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === "--limit" || arg === "-n") {
      value = args[i + 1];
      if (value === undefined) {
        throw new Error(`Flag ${arg} requires a value`);
      }
    } else if (arg.startsWith("--limit=")) {
      value = arg.slice("--limit=".length);
    } else {
      continue;
    }

    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `Invalid value for --limit: "${value}" (must be a positive integer)`
      );
    }
    return n;
  }
  return defaultLimit;
}

/**
 * Format an ISO timestamp as local time (e.g., "2026-03-30 5:12 PM")
 */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function log(message: string, level: "info" | "error" = "info"): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}]`;
  if (level === "error") {
    console.error(`${prefix} ERROR: ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * Find a packaged resource (skill files, command files) by walking
 * candidate paths from both the bundled (dist/cli.js) and source
 * (src/cli.ts) layouts.
 */
function resolvePackageResource(relPath: string): string | undefined {
  const cliPath = fileURLToPath(import.meta.url);
  const candidates = [
    // bundled: dist/cli.js -> ../<relPath>
    join(dirname(dirname(cliPath)), relPath),
    // source: src/cli.ts -> ../<relPath>
    join(dirname(cliPath), "..", relPath),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Install the scheduled-tasks skill to ~/.config/opencode/skills/
 * and the /loop slash command markdown files to ~/.config/opencode/command/.
 */
function installSkill(): void {
  const skillSrc = resolvePackageResource(join("skill", "SKILL.md"));
  if (!skillSrc) {
    console.error("Could not find skill/SKILL.md in the package.");
    process.exit(1);
  }
  doInstallSkill(skillSrc);

  console.log("");
  installCommands();
}

function doInstallSkill(srcPath: string): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const destDir = join(home, ".config", "opencode", "skills", "scheduled-tasks");
  const destPath = join(destDir, "SKILL.md");

  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcPath, destPath);

  console.log("Skill installed successfully!");
  console.log(`  Source: ${srcPath}`);
  console.log(`  Installed to: ${destPath}`);
  console.log("");
  console.log("The 'scheduled-tasks' skill is now available to OpenCode agents.");
  console.log("Agents will automatically discover it and can load it when relevant.");
}

/**
 * Install the /loop, /loop-stop, /loop-list slash commands into
 * ~/.config/opencode/commands/.
 *
 * Earlier versions of this package wrote to the singular
 * ~/.config/opencode/command/ directory (a mistake -- opencode looks
 * for `commands/`). If we find leftover files there from a previous
 * install, remove them so they don't shadow the correct ones.
 */
const COMMAND_FILES = ["loop.md", "loop-stop.md", "loop-list.md"];

function installCommands(): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const destDir = join(home, ".config", "opencode", "commands");
  mkdirSync(destDir, { recursive: true });

  const installed: string[] = [];
  const missing: string[] = [];

  for (const file of COMMAND_FILES) {
    const src = resolvePackageResource(join("commands", file));
    if (!src) {
      missing.push(file);
      continue;
    }
    const dest = join(destDir, file);
    copyFileSync(src, dest);
    installed.push(dest);
  }

  // Clean up stale files from the singular `command/` directory written
  // by 0.5.0. Only delete files we previously wrote -- never touch
  // unrelated user files.
  const legacyDir = join(home, ".config", "opencode", "command");
  const cleaned: string[] = [];
  for (const file of COMMAND_FILES) {
    const legacyPath = join(legacyDir, file);
    if (existsSync(legacyPath)) {
      try {
        unlinkSync(legacyPath);
        cleaned.push(legacyPath);
      } catch {
        // Non-fatal: warn but keep going.
      }
    }
  }

  if (installed.length > 0) {
    console.log("Slash commands installed:");
    for (const p of installed) console.log(`  ${p}`);
    console.log("");
    console.log(
      "Available in any opencode session: /loop, /loop-stop, /loop-list"
    );
  }
  if (cleaned.length > 0) {
    console.log("");
    console.log("Removed stale files from a previous install:");
    for (const p of cleaned) console.log(`  ${p}`);
  }
  if (missing.length > 0) {
    console.error("");
    console.error("Could not find these command files in the package:");
    for (const f of missing) console.error(`  commands/${f}`);
    console.error("(Slash commands will not be available until this is fixed.)");
  }
}

// --- --schedule-task command ---

interface ScheduleTaskFlags {
  prompt?: string;
  description?: string;
  cwd?: string;
  task?: string;
  at?: string;
  now: boolean;
  sessionName?: string;
  model?: string;
  agent?: string;
  permission?: string;
  help: boolean;
}

const SCHEDULE_TASK_VALUE_FLAGS: Record<string, keyof ScheduleTaskFlags> = {
  "--prompt": "prompt",
  "--description": "description",
  "--cwd": "cwd",
  "--task": "task",
  "--at": "at",
  "--session-name": "sessionName",
  "--model": "model",
  "--agent": "agent",
  "--permission": "permission",
};

/**
 * Parse the args following `--schedule-task`. Supports both
 * `--flag value` and `--flag=value` forms.
 *
 * Throws on unknown flags or missing values.
 */
export function parseScheduleTaskArgs(args: string[]): ScheduleTaskFlags {
  const flags: ScheduleTaskFlags = { now: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--now") {
      flags.now = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }

    // Support --flag=value
    let name = arg;
    let inlineValue: string | undefined;
    const eqIdx = arg.indexOf("=");
    if (arg.startsWith("--") && eqIdx !== -1) {
      name = arg.slice(0, eqIdx);
      inlineValue = arg.slice(eqIdx + 1);
    }

    const key = SCHEDULE_TASK_VALUE_FLAGS[name];
    if (!key) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    let value: string | undefined;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      value = args[++i];
      if (value === undefined) {
        throw new Error(`Flag ${name} requires a value`);
      }
    }

    (flags as any)[key] = value;
  }

  return flags;
}

async function scheduleTaskCommand(args: string[]): Promise<void> {
  let flags: ScheduleTaskFlags;
  try {
    flags = parseScheduleTaskArgs(args);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    printScheduleTaskUsage();
    process.exit(1);
  }

  if (flags.help) {
    printScheduleTaskUsage();
    return;
  }

  // Mutually exclusive: --prompt vs --task
  if (flags.prompt && flags.task) {
    console.error("Error: --prompt and --task are mutually exclusive.");
    process.exit(1);
  }
  if (!flags.prompt && !flags.task) {
    console.error("Error: one of --prompt or --task is required.");
    printScheduleTaskUsage();
    process.exit(1);
  }

  // Mutually exclusive: --at vs --now
  if (flags.at && flags.now) {
    console.error("Error: --at and --now are mutually exclusive.");
    process.exit(1);
  }

  // Build the schedule options. When neither --at nor --now is given,
  // we default to --now (no scheduledAt -> "now" in the helper).
  const scheduledAt = flags.at;

  let description: string;
  let prompt: string;
  let cwd: string;
  let sessionName: string | undefined;
  let model: string | undefined;
  let agent: string | undefined;
  let permission: string | undefined;

  if (flags.task) {
    const { tasks, errors } = readAllTasks();
    if (errors.length > 0) {
      for (const { file, error } of errors) {
        console.error(`Warning: error in task file "${file}": ${error}`);
      }
    }
    const recurring = tasks.find((t) => t.name === flags.task);
    if (!recurring) {
      console.error(`Error: no recurring task found with name "${flags.task}".`);
      if (tasks.length > 0) {
        console.error("Available tasks:");
        for (const t of tasks) {
          console.error(`  ${t.name}`);
        }
      } else {
        console.error("(No recurring tasks defined.)");
      }
      process.exit(1);
    }

    prompt = recurring.prompt;
    cwd = flags.cwd ?? recurring.cwd;
    description =
      flags.description ?? `Ad-hoc run of recurring task: ${recurring.name}`;
    sessionName = flags.sessionName ?? recurring.sessionName;
    model = flags.model ?? recurring.model;
    agent = flags.agent ?? recurring.agent;
    permission =
      flags.permission ??
      (recurring.permission ? JSON.stringify(recurring.permission) : undefined);
  } else {
    if (!flags.description) {
      console.error("Error: --description is required when using --prompt.");
      process.exit(1);
    }
    if (!flags.cwd) {
      console.error("Error: --cwd is required when using --prompt.");
      process.exit(1);
    }
    prompt = flags.prompt!;
    description = flags.description;
    cwd = flags.cwd;
    sessionName = flags.sessionName;
    model = flags.model;
    agent = flags.agent;
    permission = flags.permission;
  }

  const db = new TaskDatabase(getDefaultDbPath());
  try {
    const task = scheduleOneoffTask(db, {
      description,
      prompt,
      cwd,
      scheduledAt,
      sessionName,
      model,
      agent,
      permission,
      // CLI accepts past dates (--now produces a current ISO that may
      // slip a few ms past by the time it's compared).
      rejectPastDate: false,
    });
    console.log(formatScheduledTaskMessage(task));

    if (!isInstalled()) {
      console.error("");
      console.error(
        "Warning: the opencode-tasks daemon is not installed. Tasks will only execute"
      );
      console.error(
        "when the scheduler is run manually (e.g. `opencode-tasks --run-once`)."
      );
      console.error("Install the daemon with: bunx opencode-tasks --install");
    }
  } catch (err) {
    if (err instanceof ScheduleTaskError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}

function printUsage(): void {
  console.log(`opencode-tasks - CLI for OpenCode scheduled tasks

Usage:
  opencode-tasks --run-once         Run one scheduler tick
  opencode-tasks --install          Install the system scheduler (launchd/systemd)
  opencode-tasks --uninstall        Remove the system scheduler
  opencode-tasks --install-skill    Install the scheduled-tasks agent skill
                                    (also installs the /loop slash commands)
  opencode-tasks --install-commands Install just the /loop slash commands
  opencode-tasks --status [--limit N]
                                    Show scheduler status and the most recent
                                    one-off tasks (default: ${DEFAULT_STATUS_LIMIT})
  opencode-tasks --list [--limit N]
                                    List recurring tasks plus the most recent
                                    one-off tasks (default: ${DEFAULT_LIST_LIMIT})
  opencode-tasks --schedule-task    Schedule a one-off task
                                    (use --schedule-task --help for options)
  opencode-tasks --help             Show this help message
`);
}

function printScheduleTaskUsage(): void {
  console.log(`opencode-tasks --schedule-task - Schedule a one-off task

Usage:
  Ad-hoc prompt:
    opencode-tasks --schedule-task --prompt <text> --description <text> \\
      --cwd <path> [timing] [options]

  Run an existing recurring task as a one-off:
    opencode-tasks --schedule-task --task <name> [timing] [options]

Timing (defaults to --now if omitted):
  --at <iso>                ISO 8601 timestamp to run at (must be in the future)
  --now                     Enqueue to run on the next scheduler tick

Options:
  --description <text>      Human-readable description (required with --prompt;
                            optional with --task, defaults to a generated label)
  --cwd <path>              Working directory (~ expanded; required with --prompt)
  --session-name <name>     Reuse a named session across runs
  --model <provider/model>  Model to use
  --agent <name>            Agent to use
  --permission <json>       JSON string matching opencode.json permission schema
  --help                    Show this help

Notes:
  When --task is used, the recurring task's prompt, cwd, model, agent,
  permission, and session_name are copied into the new one-off. Any of those
  fields can be overridden by passing the matching flag.
`);
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "--install":
      await install();
      break;
    case "--uninstall":
      await uninstall();
      break;
    case "--install-skill":
      installSkill();
      break;
    case "--install-commands":
      installCommands();
      break;
    case "--status": {
      let limit: number;
      try {
        limit = parseLimitArg(args.slice(1), DEFAULT_STATUS_LIMIT);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      showStatus(limit);
      break;
    }
    case "--list": {
      let limit: number;
      try {
        limit = parseLimitArg(args.slice(1), DEFAULT_LIST_LIMIT);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      listTasks(limit);
      break;
    }
    case "--schedule-task":
      await scheduleTaskCommand(args.slice(1));
      break;
    case "--help":
    case "-h":
      printUsage();
      break;
    case "--exec-task": {
      const runId = args[1];
      if (!runId) {
        console.error("--exec-task requires a run ID");
        process.exit(1);
      }
      const isOneoff = args.includes("--oneoff");
      await execTask(runId, isOneoff);
      break;
    }
    case "--run-once":
      runTick();
      break;
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Only run main() when this file is executed directly, not when imported
// (e.g. by tests). Compares the resolved entry point to this module's URL.
const entryUrl = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).href
  : undefined;
if (entryUrl === import.meta.url) {
  main().catch((err) => {
    console.error("Fatal error:", err.message ?? err);
    process.exit(1);
  });
}

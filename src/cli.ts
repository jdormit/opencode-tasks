import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
} from "./lib/installer.js";
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

function listTasks(): void {
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
            nextStr = `next: ${getNextRunTime(task.schedule)}`;
          } catch {
            nextStr = "next: invalid cron";
          }
        }

        if (lastRun) {
          lastStr = `${lastRun.status} ${lastRun.startedAt}`;
        }

        console.log(
          `  ${task.name.padEnd(24)} ${statusStr.padEnd(10)} ${nextStr.padEnd(40)} last: ${lastStr}`
        );
      }
    } else {
      console.log("No recurring tasks found.");
    }

    const oneoffs = db.listOneoffTasks({ status: "pending" });
    if (oneoffs.length > 0) {
      console.log("");
      console.log("Pending one-off tasks:");
      console.log("");
      for (const task of oneoffs) {
        console.log(
          `  ${task.id.slice(0, 12)}...  "${task.description}"  scheduled: ${task.scheduledAt}`
        );
      }
    }
  } finally {
    db.close();
  }
}

function showStatus(): void {
  const info = getInstallInfo();
  const platform = info.platform === "unsupported" ? "unknown" : info.platform;

  if (info.installed) {
    console.log(`Scheduler: installed (${platform})`);
    if (info.details) {
      console.log(`  ${info.details}`);
    }
  } else {
    console.log(`Scheduler: not installed (detected platform: ${platform})`);
    console.log("  Run: npx opencode-scheduler --install");
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
        nextStr = `next: ${getNextRunTime(task.schedule)}`;
      } catch {
        nextStr = "next: invalid cron";
      }

      let lastStr = "never run";
      if (lastRun) {
        lastStr = `${lastRun.status} ${lastRun.startedAt}`;
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

    const pendingOneoffs = db.listOneoffTasks({ status: "pending" });
    if (pendingOneoffs.length > 0) {
      console.log("");
      console.log(`One-off tasks: ${pendingOneoffs.length} pending`);
      for (const task of pendingOneoffs) {
        console.log(
          `  ${task.id.slice(0, 12)}...  "${task.description}"  scheduled: ${task.scheduledAt}`
        );
      }
    }
  } finally {
    db.close();
  }
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
 * Install the scheduled-tasks skill to ~/.config/opencode/skills/
 */
function installSkill(): void {
  const cliPath = fileURLToPath(import.meta.url);
  const packageRoot = dirname(dirname(cliPath)); // dist/cli.js -> package root
  const skillSrc = join(packageRoot, "skill", "SKILL.md");

  if (!existsSync(skillSrc)) {
    // When running from source (src/cli.ts), try repo root
    const altSrc = join(dirname(dirname(cliPath)), "skill", "SKILL.md");
    if (!existsSync(altSrc)) {
      console.error("Could not find SKILL.md in the package.");
      console.error("Looked at:", skillSrc, "and", altSrc);
      process.exit(1);
    }
    doInstallSkill(altSrc);
    return;
  }

  doInstallSkill(skillSrc);
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

function printUsage(): void {
  console.log(`opencode-scheduler - CLI for OpenCode scheduled tasks

Usage:
  opencode-scheduler                Run one scheduler tick (default)
  opencode-scheduler --run-once     Run one scheduler tick (explicit)
  opencode-scheduler --install      Install the system scheduler (launchd/systemd)
  opencode-scheduler --uninstall    Remove the system scheduler
  opencode-scheduler --install-skill  Install the scheduled-tasks agent skill
  opencode-scheduler --status       Show scheduler and task status
  opencode-scheduler --list         List all tasks with next run times
  opencode-scheduler --help         Show this help message

Internal (used by spawned workers):
  opencode-scheduler --exec-task <runId> [--oneoff]
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
    case "--status":
      showStatus();
      break;
    case "--list":
      listTasks();
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
    case undefined:
      runTick();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message ?? err);
  process.exit(1);
});

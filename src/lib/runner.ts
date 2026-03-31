import { spawn } from "node:child_process";
import type { TaskDatabase } from "./db.js";
import type { TaskExecConfig } from "./types.js";
import { expandPath } from "./tasks.js";

/**
 * Parse a session ID from opencode's JSON-formatted output.
 *
 * When `opencode run --format json` is used, events are emitted as
 * newline-delimited JSON. We look for session-related events that
 * contain a session ID.
 */
export function parseSessionIdFromJsonOutput(
  output: string
): string | undefined {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.properties?.info?.id?.startsWith("ses_")) {
        return event.properties.info.id;
      }
      if (event.sessionID?.startsWith("ses_")) {
        return event.sessionID;
      }
      if (event.properties?.sessionID?.startsWith("ses_")) {
        return event.properties.sessionID;
      }
    } catch {
      // Not JSON, skip
    }
  }
  return undefined;
}

/**
 * Check if a process with the given PID is still alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the opencode run command args and environment for a task.
 */
export function buildTaskCommand(
  task: TaskExecConfig,
  db: TaskDatabase
): { args: string[]; env: Record<string, string>; cwd: string } {
  const sessionArgs: string[] = [];
  if (task.sessionName) {
    const mapping = db.getSessionMapping(task.sessionName);
    if (mapping) {
      sessionArgs.push("--session", mapping.sessionId);
    } else {
      sessionArgs.push("--title", task.sessionName);
    }
  } else {
    sessionArgs.push(
      "--title",
      `${task.name} - ${new Date().toISOString()}`
    );
  }

  const args = ["run", ...sessionArgs, "--format", "json"];
  if (task.model) args.push("--model", task.model);
  if (task.agent) args.push("--agent", task.agent);
  args.push(task.prompt);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (task.permission) {
    env.OPENCODE_PERMISSION = JSON.stringify(task.permission);
  }

  return { args, env, cwd: expandPath(task.cwd) };
}

/**
 * Spawn a worker process to execute a task asynchronously.
 *
 * The worker is another invocation of the scheduler script with
 * --exec-task, which runs the task synchronously and updates the DB
 * when done. This function returns immediately with the PID.
 */
export function spawnWorker(
  schedulerPath: string,
  runId: string,
  isOneoff: boolean
): number {
  const args = ["--exec-task", runId];
  if (isOneoff) args.push("--oneoff");

  const child = spawn(process.execPath, [schedulerPath, ...args], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn worker process");
  }

  return child.pid;
}

/**
 * Execute a task synchronously and update the DB with the result.
 *
 * This is called by the --exec-task worker subprocess. It runs
 * `opencode run` to completion, parses the output, and writes
 * the result back to the DB.
 */
export async function execTaskAndUpdateDb(
  task: TaskExecConfig,
  runId: string,
  isOneoff: boolean,
  db: TaskDatabase
): Promise<void> {
  const { args, env, cwd } = buildTaskCommand(task, db);

  // Use spawn instead of execFile -- opencode run can hang with
  // execFile due to TTY detection / buffer issues
  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve) => {
    const child = spawn("opencode", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });

  const success = exitCode === 0;

  const sessionId = parseSessionIdFromJsonOutput(stdout);

  // Update session map if needed
  if (task.sessionName && sessionId) {
    db.upsertSessionMapping(task.sessionName, sessionId, task.name);
  }

  // Update DB record
  if (isOneoff) {
    db.updateOneoffTaskStatus(runId, success ? "completed" : "failed", {
      sessionId,
      error: success ? undefined : stderr.slice(0, 4096),
    });
  } else {
    db.completeTaskRun(runId, success ? "completed" : "failed", {
      sessionId,
      error: success ? undefined : stderr.slice(0, 4096),
    });
  }
}

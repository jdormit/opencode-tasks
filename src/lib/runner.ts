import { spawn } from "node:child_process";
import type { TaskDatabase } from "./db.js";
import type { TaskExecConfig } from "./types.js";
import { expandPath } from "./tasks.js";

/**
 * Extract a session ID from a single parsed JSON event, if present.
 * Returns undefined if the event doesn't contain a session ID in any
 * of the known shapes.
 */
function sessionIdFromEvent(event: any): string | undefined {
  if (event?.properties?.info?.id?.startsWith?.("ses_")) {
    return event.properties.info.id;
  }
  if (event?.sessionID?.startsWith?.("ses_")) {
    return event.sessionID;
  }
  if (event?.properties?.sessionID?.startsWith?.("ses_")) {
    return event.properties.sessionID;
  }
  return undefined;
}

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
      const sid = sessionIdFromEvent(JSON.parse(line));
      if (sid) return sid;
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
 * `opencode run` to completion, streams the output line-by-line, and:
 *
 * 1. As soon as the session ID is observed in the JSON event stream,
 *    writes it to the DB so external tooling can find the running session.
 * 2. When the run finishes, writes the final status (completed/failed)
 *    and any captured error.
 */
export async function execTaskAndUpdateDb(
  task: TaskExecConfig,
  runId: string,
  isOneoff: boolean,
  db: TaskDatabase
): Promise<void> {
  const { args, env, cwd } = buildTaskCommand(task, db);

  let sessionId: string | undefined;

  const onSessionId = (sid: string): void => {
    if (sessionId) return;
    sessionId = sid;
    try {
      if (isOneoff) {
        db.setOneoffTaskSessionId(runId, sid);
      } else {
        db.setTaskRunSessionId(runId, sid);
      }
      if (task.sessionName) {
        db.upsertSessionMapping(task.sessionName, sid, task.name);
      }
    } catch {
      // Don't let DB errors here kill the run; we'll try again at completion.
    }
  };

  // Use spawn instead of execFile -- opencode run can hang with
  // execFile due to TTY detection / buffer issues
  const { stderr, exitCode } = await new Promise<{
    stderr: string;
    exitCode: number;
  }>((resolve) => {
    const child = spawn("opencode", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      // Process complete lines; keep any trailing partial line in the buffer.
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        if (sessionId) continue; // already found, skip parse work
        try {
          const sid = sessionIdFromParsedLine(line);
          if (sid) onSessionId(sid);
        } catch {
          // Not JSON, skip
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      // Flush any final line that wasn't terminated by a newline.
      if (!sessionId && stdoutBuffer.trim()) {
        try {
          const sid = sessionIdFromParsedLine(stdoutBuffer);
          if (sid) onSessionId(sid);
        } catch {
          // ignore
        }
      }
      resolve({ stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      resolve({ stderr: err.message, exitCode: 1 });
    });
  });

  const success = exitCode === 0;

  // Final DB update with status and any error.
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

/**
 * Try to parse a single line of opencode JSON output and return the
 * session ID if present. Throws if the line isn't valid JSON.
 */
function sessionIdFromParsedLine(line: string): string | undefined {
  return sessionIdFromEvent(JSON.parse(line));
}

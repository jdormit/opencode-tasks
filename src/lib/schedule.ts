import type { TaskDatabase } from "./db.js";
import { expandPath } from "./tasks.js";
import type { OneoffTask, PermissionConfig } from "./types.js";

export interface ScheduleOneoffTaskOptions {
  description: string;
  prompt: string;
  cwd: string;
  /** ISO 8601 timestamp. If undefined, schedules for "now" (current time). */
  scheduledAt?: string;
  sessionName?: string;
  model?: string;
  agent?: string;
  /** Either an already-parsed permission config or a JSON string */
  permission?: PermissionConfig | string;
  createdBySession?: string;
  /**
   * If true, reject scheduledAt values that are in the past.
   * The plugin tool sets this to true; the CLI accepts past values
   * (e.g. --now produces a current timestamp that may slip slightly past).
   */
  rejectPastDate?: boolean;
}

export class ScheduleTaskError extends Error {}

/**
 * Validate, normalize, and create a one-off task in the database.
 *
 * Shared between the `schedule_task` plugin tool and the
 * `--schedule-task` CLI command so they have identical semantics.
 *
 * Throws `ScheduleTaskError` for user-facing validation failures.
 */
export function scheduleOneoffTask(
  db: TaskDatabase,
  opts: ScheduleOneoffTaskOptions
): OneoffTask {
  // Resolve scheduled time. If omitted, schedule for "now" so the
  // next scheduler tick will pick it up.
  let scheduledAtIso: string;
  if (opts.scheduledAt === undefined) {
    scheduledAtIso = new Date().toISOString();
  } else {
    const scheduledDate = new Date(opts.scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      throw new ScheduleTaskError(
        `Invalid date format "${opts.scheduledAt}". Use ISO 8601 format (e.g. '2026-03-31T09:00:00').`
      );
    }
    if (opts.rejectPastDate && scheduledDate <= new Date()) {
      throw new ScheduleTaskError(
        `Scheduled time "${opts.scheduledAt}" is in the past.`
      );
    }
    scheduledAtIso = scheduledDate.toISOString();
  }

  // Normalize permission: accept either an object or a JSON string.
  let permission: PermissionConfig | undefined;
  if (opts.permission !== undefined) {
    if (typeof opts.permission === "string") {
      try {
        permission = JSON.parse(opts.permission);
      } catch {
        throw new ScheduleTaskError(
          `Invalid permission JSON: ${opts.permission}`
        );
      }
    } else {
      permission = opts.permission;
    }
  }

  const cwd = expandPath(opts.cwd);

  return db.createOneoffTask({
    description: opts.description,
    prompt: opts.prompt,
    cwd,
    scheduledAt: scheduledAtIso,
    sessionName: opts.sessionName,
    model: opts.model,
    agent: opts.agent,
    permission,
    createdBySession: opts.createdBySession,
  });
}

/**
 * Format the standard "task scheduled successfully" message.
 * Used by both the plugin tool and the CLI so output is identical.
 *
 * The caller is responsible for appending any scheduler-not-installed
 * warning, since the warning surface differs between contexts.
 */
export function formatScheduledTaskMessage(task: OneoffTask): string {
  return (
    `Task scheduled successfully!\n` +
    `  ID: ${task.id}\n` +
    `  Description: ${task.description}\n` +
    `  Scheduled for: ${task.scheduledAt}\n` +
    `  Working directory: ${task.cwd}\n` +
    `  Session: ${task.sessionName ? `named (${task.sessionName})` : "new (fresh each run)"}`
  );
}

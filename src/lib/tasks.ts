import matter from "gray-matter";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { RecurringTask, TaskFrontmatter } from "./types.js";

export const DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TASK_TIMEOUT_MS = 2_147_483_647;

const TIMEOUT_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parse a duration string, or a numeric number of seconds, into milliseconds. */
export function parseTimeout(value: unknown): number {
  if (typeof value === "number") {
    const timeoutMs = value * 1000;
    if (
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= MAX_TASK_TIMEOUT_MS
    ) {
      return timeoutMs;
    }
    throw new Error("Invalid timeout");
  }

  if (typeof value === "string") {
    const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
    if (match) {
      const timeoutMs = Number(match[1]) * TIMEOUT_UNITS[match[2]];
      if (
        timeoutMs > 0 &&
        timeoutMs <= MAX_TASK_TIMEOUT_MS &&
        Number.isSafeInteger(timeoutMs)
      ) {
        return timeoutMs;
      }
    }
  }

  throw new Error("Invalid timeout");
}

/**
 * Get the default tasks directory path
 */
export function getTasksDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", "opencode", "tasks");
}

/**
 * Expand ~ to home directory in a path
 */
export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return join(home, p.slice(2));
  }
  return p;
}

/**
 * Validate task frontmatter and return errors
 */
function validateFrontmatter(
  data: Record<string, any>,
  fileName: string
): string[] {
  const errors: string[] = [];

  if (data.description !== undefined && typeof data.description !== "string") {
    errors.push("Invalid 'description' field (must be a string)");
  }

  if (!data.schedule || typeof data.schedule !== "string") {
    errors.push("Missing or invalid 'schedule' field");
  }

  if (!data.cwd || typeof data.cwd !== "string") {
    errors.push("Missing or invalid 'cwd' field");
  }

  if (data.session_name !== undefined && typeof data.session_name !== "string") {
    errors.push("Invalid 'session_name' field (must be a string)");
  }

  if (data.model !== undefined && typeof data.model !== "string") {
    errors.push("Invalid 'model' field (must be a string)");
  }

  if (data.agent !== undefined && typeof data.agent !== "string") {
    errors.push("Invalid 'agent' field (must be a string)");
  }

  if (data.timeout !== undefined) {
    try {
      parseTimeout(data.timeout);
    } catch {
      errors.push(
        "Invalid 'timeout' field (must be a positive duration such as '30m' or numeric seconds)"
      );
    }
  }

  if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
    errors.push("Invalid 'enabled' field (must be a boolean)");
  }

  return errors;
}

/**
 * Parse a single task markdown file into a RecurringTask
 */
export function parseTaskFile(filePath: string): RecurringTask {
  const content = readFileSync(filePath, "utf-8");
  const fileName = basename(filePath);
  const { data, content: body } = matter(content);
  const fm = data as TaskFrontmatter;

  const errors = validateFrontmatter(data, fileName);
  if (errors.length > 0) {
    throw new Error(
      `Invalid task file "${fileName}":\n  - ${errors.join("\n  - ")}`
    );
  }

  const name = fileName.replace(/\.md$/, "");

  return {
    name,
    description: fm.description,
    schedule: fm.schedule,
    cwd: fm.cwd,
    sessionName: fm.session_name,
    model: fm.model,
    agent: fm.agent,
    timeoutMs:
      fm.timeout === undefined
        ? DEFAULT_TASK_TIMEOUT_MS
        : parseTimeout(fm.timeout),
    permission: fm.permission,
    enabled: fm.enabled ?? true,
    prompt: body.trim(),
    filePath,
  };
}

/**
 * Read all task files from the tasks directory.
 * Returns successfully parsed tasks and logs errors for invalid ones.
 */
export function readAllTasks(
  tasksDir?: string
): { tasks: RecurringTask[]; errors: Array<{ file: string; error: string }> } {
  const dir = tasksDir ?? getTasksDir();
  const tasks: RecurringTask[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  if (!existsSync(dir)) {
    return { tasks, errors };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const task = parseTaskFile(filePath);
      tasks.push(task);
    } catch (err: any) {
      errors.push({ file, error: err.message });
    }
  }

  return { tasks, errors };
}

/**
 * Update the enabled field in a task's frontmatter.
 * Preserves the rest of the file content.
 */
export function setTaskEnabled(filePath: string, enabled: boolean): void {
  const content = readFileSync(filePath, "utf-8");
  const { data, content: body } = matter(content);
  data.enabled = enabled;
  const updated = matter.stringify(body, data);
  writeFileSync(filePath, updated);
}

import matter from "gray-matter";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { RecurringTask, TaskFrontmatter } from "./types.js";

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

  if (!data.name || typeof data.name !== "string") {
    errors.push("Missing or invalid 'name' field");
  } else {
    const expectedName = fileName.replace(/\.md$/, "");
    if (data.name !== expectedName) {
      errors.push(
        `'name' field "${data.name}" does not match filename "${expectedName}"`
      );
    }
  }

  if (!data.description || typeof data.description !== "string") {
    errors.push("Missing or invalid 'description' field");
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

  return {
    name: fm.name,
    description: fm.description,
    schedule: fm.schedule,
    cwd: fm.cwd,
    sessionName: fm.session_name,
    model: fm.model,
    agent: fm.agent,
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

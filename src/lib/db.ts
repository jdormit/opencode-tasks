import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, type Database } from "./sqlite.js";
import type {
  OneoffTask,
  OneoffTaskStatus,
  PermissionConfig,
  SessionMapping,
  TaskRun,
  TaskRunStatus,
} from "./types.js";

const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS oneoff_tasks (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  session_mode TEXT NOT NULL DEFAULT 'new',
  session_name TEXT,
  model TEXT,
  agent TEXT,
  permission TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  session_id TEXT,
  error TEXT,
  created_by_session TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  session_id TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS session_map (
  session_name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_V2 = `
ALTER TABLE task_runs ADD COLUMN pid INTEGER;
ALTER TABLE oneoff_tasks ADD COLUMN pid INTEGER;
`;

export class TaskDatabase {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  private initialize(): void {
    const versionExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
      )
      .get();

    if (!versionExists) {
      // Fresh database: create all tables, then run migrations
      this.db.exec(SCHEMA_V1);
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(1);
    }

    const row = this.db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number } | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.migrate(currentVersion);
    }
  }

  private migrate(fromVersion: number): void {
    if (fromVersion < 2) {
      // V2: Add pid columns for async worker tracking
      // Run each ALTER separately since SQLite doesn't support multi-ALTER
      const statements = MIGRATION_V2.trim().split(";").filter(Boolean);
      for (const stmt of statements) {
        try {
          this.db.exec(stmt.trim() + ";");
        } catch {
          // Column may already exist if migration was partially applied
        }
      }
      this.db
        .prepare(
          "INSERT OR REPLACE INTO schema_version (version) VALUES (?)"
        )
        .run(2);
    }
  }

  // --- One-off tasks ---

  createOneoffTask(task: {
    description: string;
    prompt: string;
    cwd: string;
    scheduledAt: string;
    sessionName?: string;
    model?: string;
    agent?: string;
    permission?: PermissionConfig;
    createdBySession?: string;
  }): OneoffTask {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO oneoff_tasks (id, description, prompt, cwd, scheduled_at, session_name, model, agent, permission, created_by_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        task.description,
        task.prompt,
        task.cwd,
        task.scheduledAt,
        task.sessionName ?? null,
        task.model ?? null,
        task.agent ?? null,
        task.permission ? JSON.stringify(task.permission) : null,
        task.createdBySession ?? null
      );
    return this.getOneoffTask(id)!;
  }

  getOneoffTask(id: string): OneoffTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM oneoff_tasks WHERE id = ?")
      .get(id) as any;
    return row ? this.mapOneoffRow(row) : undefined;
  }

  listOneoffTasks(options?: {
    status?: OneoffTaskStatus | "all";
  }): OneoffTask[] {
    const status = options?.status ?? "all";
    let rows: any[];
    if (status === "all") {
      rows = this.db
        .prepare("SELECT * FROM oneoff_tasks ORDER BY scheduled_at ASC")
        .all();
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM oneoff_tasks WHERE status = ? ORDER BY scheduled_at ASC"
        )
        .all(status);
    }
    return rows.map((r) => this.mapOneoffRow(r));
  }

  getDueOneoffTasks(): OneoffTask[] {
    return this.db
      .prepare(
        "SELECT * FROM oneoff_tasks WHERE status = 'pending' AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY scheduled_at ASC"
      )
      .all()
      .map((r: any) => this.mapOneoffRow(r));
  }

  updateOneoffTaskStatus(
    id: string,
    status: OneoffTaskStatus,
    extra?: { sessionId?: string; error?: string; pid?: number }
  ): void {
    const executedAt =
      status === "running" ? new Date().toISOString() : undefined;
    this.db
      .prepare(
        `UPDATE oneoff_tasks SET status = ?, executed_at = COALESCE(?, executed_at), session_id = COALESCE(?, session_id), error = ?, pid = COALESCE(?, pid) WHERE id = ?`
      )
      .run(
        status,
        executedAt ?? null,
        extra?.sessionId ?? null,
        extra?.error ?? null,
        extra?.pid ?? null,
        id
      );
  }

  setTaskRunPid(id: string, pid: number): void {
    this.db
      .prepare("UPDATE task_runs SET pid = ? WHERE id = ?")
      .run(pid, id);
  }

  cancelOneoffTask(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE oneoff_tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
      )
      .run(id);
    return result.changes > 0;
  }

  // --- Task runs (recurring) ---

  createTaskRun(taskName: string, pid?: number): TaskRun {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO task_runs (id, task_name, started_at, pid) VALUES (?, ?, ?, ?)"
      )
      .run(id, taskName, startedAt, pid ?? null);
    return { id, taskName, startedAt, status: "running", pid };
  }

  completeTaskRun(
    id: string,
    status: "completed" | "failed",
    extra?: { sessionId?: string; error?: string }
  ): void {
    const completedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_runs SET status = ?, completed_at = ?, session_id = COALESCE(?, session_id), error = ? WHERE id = ?`
      )
      .run(
        status,
        completedAt,
        extra?.sessionId ?? null,
        extra?.error ?? null,
        id
      );
  }

  getLastTaskRun(taskName: string): TaskRun | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_name = ? ORDER BY started_at DESC LIMIT 1"
      )
      .get(taskName) as any;
    return row ? this.mapTaskRunRow(row) : undefined;
  }

  getLastSuccessfulTaskRun(taskName: string): TaskRun | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_name = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1"
      )
      .get(taskName) as any;
    return row ? this.mapTaskRunRow(row) : undefined;
  }

  getTaskRunHistory(taskName: string, limit: number = 10): TaskRun[] {
    return this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_name = ? ORDER BY started_at DESC LIMIT ?"
      )
      .all(taskName, limit)
      .map((r: any) => this.mapTaskRunRow(r));
  }

  hasRunningTask(taskName: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM task_runs WHERE task_name = ? AND status = 'running' LIMIT 1"
      )
      .get(taskName);
    return !!row;
  }

  hasRunningOneoffTask(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM oneoff_tasks WHERE id = ? AND status = 'running' LIMIT 1"
      )
      .get(id);
    return !!row;
  }

  /**
   * Get all running task runs (for PID-based reaping).
   */
  getRunningTaskRuns(): TaskRun[] {
    return this.db
      .prepare("SELECT * FROM task_runs WHERE status = 'running'")
      .all()
      .map((r: any) => this.mapTaskRunRow(r));
  }

  /**
   * Get all running one-off tasks (for PID-based reaping).
   */
  getRunningOneoffTasks(): OneoffTask[] {
    return this.db
      .prepare("SELECT * FROM oneoff_tasks WHERE status = 'running'")
      .all()
      .map((r: any) => this.mapOneoffRow(r));
  }

  /**
   * Mark stale running records as failed.
   * A record is stale if it has a PID set and that process is no longer alive,
   * or if it has no PID and is older than maxAgeMs (fallback for records
   * created before async execution was added).
   */
  cleanupStaleRuns(maxAgeMs: number = 2 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    // Clean up old records without PIDs (legacy / fallback)
    const taskRunResult = this.db
      .prepare(
        "UPDATE task_runs SET status = 'failed', completed_at = datetime('now'), error = 'Timed out (stale running record)' WHERE status = 'running' AND pid IS NULL AND started_at < ?"
      )
      .run(cutoff);

    const oneoffResult = this.db
      .prepare(
        "UPDATE oneoff_tasks SET status = 'failed', error = 'Timed out (stale running record)' WHERE status = 'running' AND pid IS NULL AND executed_at < ?"
      )
      .run(cutoff);

    return taskRunResult.changes + oneoffResult.changes;
  }

  // --- Session map ---

  getSessionMapping(sessionName: string): SessionMapping | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_map WHERE session_name = ?")
      .get(sessionName) as any;
    return row ? this.mapSessionMapRow(row) : undefined;
  }

  upsertSessionMapping(
    sessionName: string,
    sessionId: string,
    taskName?: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_map (session_name, session_id, task_name, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(session_name) DO UPDATE SET
           session_id = excluded.session_id,
           task_name = COALESCE(excluded.task_name, session_map.task_name),
           updated_at = datetime('now')`
      )
      .run(sessionName, sessionId, taskName ?? null);
  }

  // --- Row mappers ---

  private mapOneoffRow(row: any): OneoffTask {
    return {
      id: row.id,
      description: row.description,
      prompt: row.prompt,
      cwd: row.cwd,
      scheduledAt: row.scheduled_at,
      sessionName: row.session_name ?? undefined,
      model: row.model ?? undefined,
      agent: row.agent ?? undefined,
      permission: row.permission ? JSON.parse(row.permission) : undefined,
      status: row.status as OneoffTaskStatus,
      createdAt: row.created_at,
      executedAt: row.executed_at ?? undefined,
      sessionId: row.session_id ?? undefined,
      error: row.error ?? undefined,
      createdBySession: row.created_by_session ?? undefined,
      pid: row.pid ?? undefined,
    };
  }

  private mapTaskRunRow(row: any): TaskRun {
    return {
      id: row.id,
      taskName: row.task_name,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      status: row.status as TaskRunStatus,
      sessionId: row.session_id ?? undefined,
      error: row.error ?? undefined,
      pid: row.pid ?? undefined,
    };
  }

  private mapSessionMapRow(row: any): SessionMapping {
    return {
      sessionName: row.session_name,
      sessionId: row.session_id,
      taskName: row.task_name ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Get the default database path
 */
export function getDefaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return `${home}/.config/opencode/.tasks.db`;
}

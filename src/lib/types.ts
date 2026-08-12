/**
 * Permission configuration - mirrors the opencode.json permission schema.
 * Can be a simple action string or a per-tool object with glob patterns.
 */
export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRule =
  | PermissionAction
  | Record<string, PermissionAction>;

export type PermissionConfig = Record<string, PermissionRule>;

/**
 * A recurring task definition parsed from a markdown file in ~/.config/opencode/tasks/
 */
export interface RecurringTask {
  /** Unique task identifier (must match filename without .md) */
  name: string;
  /** Human-readable description (optional for recurring tasks) */
  description?: string;
  /** Cron expression (5-field standard cron) */
  schedule: string;
  /** Working directory for task execution. Supports ~ expansion. */
  cwd: string;
  /** Session name. If set, reuses the same session across runs. If absent, creates a fresh session each run. */
  sessionName?: string;
  /** Model in provider/model format */
  model?: string;
  /** Agent to use */
  agent?: string;
  /** Maximum run time in milliseconds */
  timeoutMs: number;
  /** Permission config (same schema as opencode.json permission key) */
  permission?: PermissionConfig;
  /** Whether the task is active */
  enabled: boolean;
  /** The prompt (markdown body of the task file) */
  prompt: string;
  /** Absolute path to the source .md file */
  filePath: string;
}

/**
 * Task frontmatter as parsed from YAML (before normalization)
 */
export interface TaskFrontmatter {
  description?: string;
  schedule: string;
  cwd: string;
  session_name?: string;
  model?: string;
  agent?: string;
  /** Maximum run time, as a duration string or seconds */
  timeout?: string | number;
  permission?: PermissionConfig;
  enabled?: boolean;
}

/**
 * Status of a one-off task
 */
export type OneoffTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Status of a recurring task run
 */
export type TaskRunStatus = "running" | "completed" | "failed";

/**
 * A one-off task stored in SQLite
 */
export interface OneoffTask {
  id: string;
  description: string;
  prompt: string;
  cwd: string;
  scheduledAt: string;
  sessionName?: string;
  model?: string;
  agent?: string;
  permission?: PermissionConfig;
  status: OneoffTaskStatus;
  createdAt: string;
  executedAt?: string;
  sessionId?: string;
  error?: string;
  createdBySession?: string;
  /** PID of the worker process executing this task */
  pid?: number;
}

/**
 * A run record for a recurring task
 */
export interface TaskRun {
  id: string;
  taskName: string;
  startedAt: string;
  completedAt?: string;
  status: TaskRunStatus;
  sessionId?: string;
  error?: string;
  /** PID of the worker process executing this task */
  pid?: number;
}

/**
 * Session name to session ID mapping
 */
export interface SessionMapping {
  sessionName: string;
  sessionId: string;
  taskName?: string;
  updatedAt: string;
}

/**
 * A "session loop" — a recurring prompt that posts a message into a
 * specific opencode session on a schedule. Unlike recurring or one-off
 * tasks (which run `opencode run` in a fresh subprocess), loops are
 * driven by in-process timers in the plugin and use
 * `client.session.promptAsync` to inject the prompt into the existing
 * session that created the loop.
 *
 * State lives in SQLite so loops survive plugin reloads (e.g.
 * `opencode --resume`). Timers themselves are ephemeral and rebuilt
 * lazily from the DB the first time we see an event for a session.
 */
export interface SessionLoop {
  id: string;
  sessionId: string;
  prompt: string;
  /** 5-field cron expression */
  schedule: string;
  /** Human-readable interval label, e.g. "5m", "2h" — for display only */
  intervalLabel?: string;
  /** Working directory captured at loop creation time */
  cwd: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  /** ISO timestamp after which the loop should stop firing (optional) */
  expiresAt?: string;
}

/**
 * Unified task config passed to the runner (works for both recurring and one-off)
 */
export interface TaskExecConfig {
  name: string;
  prompt: string;
  cwd: string;
  sessionName?: string;
  model?: string;
  agent?: string;
  /** Maximum run time in milliseconds. Omitted for unbounded one-off tasks. */
  timeoutMs?: number;
  permission?: PermissionConfig;
}

/**
 * Result of a task execution
 */
export interface RunResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

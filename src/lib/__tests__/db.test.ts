import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskDatabase } from "../db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: TaskDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-tasks-test-"));
  db = new TaskDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("TaskDatabase", () => {
  describe("oneoff tasks", () => {
    it("creates and retrieves a one-off task", () => {
      const task = db.createOneoffTask({
        description: "Test task",
        prompt: "Do something",
        cwd: "/tmp",
        scheduledAt: "2026-12-31T00:00:00.000Z",
      });

      expect(task.id).toBeDefined();
      expect(task.description).toBe("Test task");
      expect(task.prompt).toBe("Do something");
      expect(task.cwd).toBe("/tmp");
      expect(task.status).toBe("pending");
      expect(task.sessionName).toBeUndefined();

      const retrieved = db.getOneoffTask(task.id);
      expect(retrieved).toEqual(task);
    });

    it("creates a task with named session", () => {
      const task = db.createOneoffTask({
        description: "Named session task",
        prompt: "Do something",
        cwd: "/tmp",
        scheduledAt: "2026-12-31T00:00:00.000Z",
        sessionName: "my-session",
        model: "anthropic/claude-sonnet-4-6",
        agent: "build",
      });

      expect(task.sessionName).toBe("my-session");
      expect(task.model).toBe("anthropic/claude-sonnet-4-6");
      expect(task.agent).toBe("build");
    });

    it("lists tasks by status", () => {
      db.createOneoffTask({
        description: "Task 1",
        prompt: "p1",
        cwd: "/tmp",
        scheduledAt: "2026-12-31T00:00:00.000Z",
      });
      const task2 = db.createOneoffTask({
        description: "Task 2",
        prompt: "p2",
        cwd: "/tmp",
        scheduledAt: "2026-12-31T00:00:00.000Z",
      });
      db.cancelOneoffTask(task2.id);

      const all = db.listOneoffTasks({ status: "all" });
      expect(all).toHaveLength(2);

      const pending = db.listOneoffTasks({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].description).toBe("Task 1");

      const cancelled = db.listOneoffTasks({ status: "cancelled" });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].description).toBe("Task 2");
    });

    it("gets due one-off tasks", () => {
      // Past scheduled time
      db.createOneoffTask({
        description: "Due task",
        prompt: "p1",
        cwd: "/tmp",
        scheduledAt: "2020-01-01T00:00:00.000Z",
      });
      // Future scheduled time
      db.createOneoffTask({
        description: "Future task",
        prompt: "p2",
        cwd: "/tmp",
        scheduledAt: "2099-01-01T00:00:00.000Z",
      });

      const due = db.getDueOneoffTasks();
      expect(due).toHaveLength(1);
      expect(due[0].description).toBe("Due task");
    });

    it("updates task status", () => {
      const task = db.createOneoffTask({
        description: "Test",
        prompt: "p",
        cwd: "/tmp",
        scheduledAt: "2020-01-01T00:00:00.000Z",
      });

      db.updateOneoffTaskStatus(task.id, "running");
      let updated = db.getOneoffTask(task.id)!;
      expect(updated.status).toBe("running");
      expect(updated.executedAt).toBeDefined();

      db.updateOneoffTaskStatus(task.id, "completed", {
        sessionId: "ses_abc123",
      });
      updated = db.getOneoffTask(task.id)!;
      expect(updated.status).toBe("completed");
      expect(updated.sessionId).toBe("ses_abc123");
    });

    it("cancels only pending tasks", () => {
      const task = db.createOneoffTask({
        description: "Test",
        prompt: "p",
        cwd: "/tmp",
        scheduledAt: "2026-12-31T00:00:00.000Z",
      });

      expect(db.cancelOneoffTask(task.id)).toBe(true);
      expect(db.getOneoffTask(task.id)!.status).toBe("cancelled");

      // Can't cancel again
      expect(db.cancelOneoffTask(task.id)).toBe(false);
    });
  });

  describe("task runs", () => {
    it("creates and completes a task run", () => {
      const run = db.createTaskRun("daily-cleanup");
      expect(run.taskName).toBe("daily-cleanup");
      expect(run.status).toBe("running");

      db.completeTaskRun(run.id, "completed", {
        sessionId: "ses_abc",
      });

      const last = db.getLastTaskRun("daily-cleanup");
      expect(last).toBeDefined();
      expect(last!.status).toBe("completed");
      expect(last!.sessionId).toBe("ses_abc");
      expect(last!.completedAt).toBeDefined();
    });

    it("returns run history in reverse chronological order", () => {
      const run1 = db.createTaskRun("task1");
      db.completeTaskRun(run1.id, "completed");

      // Backdate run1 so run2 is clearly newer
      (db as any).db
        .prepare("UPDATE task_runs SET started_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", run1.id);

      const run2 = db.createTaskRun("task1");
      db.completeTaskRun(run2.id, "failed", { error: "something broke" });

      const history = db.getTaskRunHistory("task1");
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("failed");
      expect(history[1].status).toBe("completed");
    });

    it("checks for running tasks", () => {
      expect(db.hasRunningTask("task1")).toBe(false);

      const run = db.createTaskRun("task1");
      expect(db.hasRunningTask("task1")).toBe(true);

      db.completeTaskRun(run.id, "completed");
      expect(db.hasRunningTask("task1")).toBe(false);
    });

    it("gets last successful run only", () => {
      const run1 = db.createTaskRun("task1");
      db.completeTaskRun(run1.id, "completed");

      const run2 = db.createTaskRun("task1");
      db.completeTaskRun(run2.id, "failed");

      const lastSuccess = db.getLastSuccessfulTaskRun("task1");
      expect(lastSuccess).toBeDefined();
      expect(lastSuccess!.id).toBe(run1.id);
    });
  });

  describe("session map", () => {
    it("creates and retrieves a session mapping", () => {
      db.upsertSessionMapping("my-session", "ses_abc123", "daily-cleanup");

      const mapping = db.getSessionMapping("my-session");
      expect(mapping).toBeDefined();
      expect(mapping!.sessionId).toBe("ses_abc123");
      expect(mapping!.taskName).toBe("daily-cleanup");
    });

    it("upserts session mapping", () => {
      db.upsertSessionMapping("my-session", "ses_old");
      db.upsertSessionMapping("my-session", "ses_new");

      const mapping = db.getSessionMapping("my-session");
      expect(mapping!.sessionId).toBe("ses_new");
    });

    it("returns undefined for missing mapping", () => {
      const mapping = db.getSessionMapping("nonexistent");
      expect(mapping).toBeUndefined();
    });
  });

  describe("stale cleanup", () => {
    it("cleans up stale running records", () => {
      // Create a running task run with old timestamp
      const run = db.createTaskRun("task1");

      // Manually backdate the started_at
      (db as any).db
        .prepare("UPDATE task_runs SET started_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", run.id);

      const cleaned = db.cleanupStaleRuns();
      expect(cleaned).toBe(1);

      const updated = db.getLastTaskRun("task1");
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toContain("stale");
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { TaskDatabase } from "../db.js";
import {
  scheduleOneoffTask,
  formatScheduledTaskMessage,
  ScheduleTaskError,
} from "../schedule.js";

let db: TaskDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-schedule-test-"));
  db = new TaskDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scheduleOneoffTask", () => {
  it("creates a task with all fields", () => {
    const task = scheduleOneoffTask(db, {
      description: "Test",
      prompt: "Do something",
      cwd: "/tmp",
      scheduledAt: "2099-01-01T00:00:00.000Z",
      sessionName: "my-session",
      model: "anthropic/claude-sonnet-4-6",
      agent: "build",
      permission: { bash: { "*": "allow" }, edit: "allow" },
    });

    expect(task.id).toBeDefined();
    expect(task.description).toBe("Test");
    expect(task.prompt).toBe("Do something");
    expect(task.cwd).toBe("/tmp");
    expect(task.scheduledAt).toBe("2099-01-01T00:00:00.000Z");
    expect(task.sessionName).toBe("my-session");
    expect(task.model).toBe("anthropic/claude-sonnet-4-6");
    expect(task.agent).toBe("build");
    expect(task.permission).toEqual({ bash: { "*": "allow" }, edit: "allow" });
    expect(task.status).toBe("pending");
  });

  it("defaults scheduledAt to 'now' when omitted", () => {
    const before = Date.now();
    const task = scheduleOneoffTask(db, {
      description: "Now",
      prompt: "p",
      cwd: "/tmp",
    });
    const after = Date.now();

    const t = new Date(task.scheduledAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("accepts permission as a JSON string", () => {
    const task = scheduleOneoffTask(db, {
      description: "perm-string",
      prompt: "p",
      cwd: "/tmp",
      permission: '{"bash":{"*":"allow"},"edit":"allow"}',
    });
    expect(task.permission).toEqual({ bash: { "*": "allow" }, edit: "allow" });
  });

  it("rejects invalid permission JSON", () => {
    expect(() =>
      scheduleOneoffTask(db, {
        description: "bad-perm",
        prompt: "p",
        cwd: "/tmp",
        permission: "{not json",
      })
    ).toThrow(ScheduleTaskError);
  });

  it("expands ~ in cwd", () => {
    const task = scheduleOneoffTask(db, {
      description: "tilde",
      prompt: "p",
      cwd: "~/projects/foo",
    });
    expect(task.cwd).toBe(join(homedir(), "projects/foo"));
  });

  it("rejects an invalid scheduledAt", () => {
    expect(() =>
      scheduleOneoffTask(db, {
        description: "bad-date",
        prompt: "p",
        cwd: "/tmp",
        scheduledAt: "not a date",
      })
    ).toThrow(ScheduleTaskError);
  });

  it("rejects a past date when rejectPastDate is true", () => {
    expect(() =>
      scheduleOneoffTask(db, {
        description: "past",
        prompt: "p",
        cwd: "/tmp",
        scheduledAt: "2000-01-01T00:00:00.000Z",
        rejectPastDate: true,
      })
    ).toThrow(ScheduleTaskError);
  });

  it("allows a past date when rejectPastDate is false (default)", () => {
    const task = scheduleOneoffTask(db, {
      description: "past-ok",
      prompt: "p",
      cwd: "/tmp",
      scheduledAt: "2000-01-01T00:00:00.000Z",
    });
    expect(task.scheduledAt).toBe("2000-01-01T00:00:00.000Z");
  });
});

describe("formatScheduledTaskMessage", () => {
  it("includes core fields and a 'fresh each run' session note when no name", () => {
    const task = scheduleOneoffTask(db, {
      description: "Hello",
      prompt: "p",
      cwd: "/tmp",
      scheduledAt: "2099-01-01T00:00:00.000Z",
    });
    const msg = formatScheduledTaskMessage(task);
    expect(msg).toContain("Task scheduled successfully!");
    expect(msg).toContain(`ID: ${task.id}`);
    expect(msg).toContain("Description: Hello");
    expect(msg).toContain("Scheduled for: 2099-01-01T00:00:00.000Z");
    expect(msg).toContain("Working directory: /tmp");
    expect(msg).toContain("Session: new (fresh each run)");
  });

  it("includes the named session when provided", () => {
    const task = scheduleOneoffTask(db, {
      description: "Hello",
      prompt: "p",
      cwd: "/tmp",
      scheduledAt: "2099-01-01T00:00:00.000Z",
      sessionName: "my-session",
    });
    const msg = formatScheduledTaskMessage(task);
    expect(msg).toContain("Session: named (my-session)");
  });
});

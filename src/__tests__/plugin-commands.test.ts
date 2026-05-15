import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../lib/db.js";
import { LoopRuntime } from "../lib/loop-runtime.js";
import {
  handleLoopCommand,
  handleLoopStopCommand,
  handleLoopListCommand,
  handleLoopEvent,
} from "../lib/loop-commands.js";

let tmpDir: string;
let db: TaskDatabase;
let runtime: LoopRuntime;
let timers: Array<{ ms: number; cb: () => void }>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-plugin-cmd-"));
  db = new TaskDatabase(join(tmpDir, "test.db"));
  timers = [];
  runtime = new LoopRuntime({
    db,
    deliver: async () => {},
    setTimeoutFn: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleLoopCommand", () => {
  it("creates a loop with the parsed interval and prompt", () => {
    const out = handleLoopCommand("5m check the deploy", "ses_a", "/tmp", db, runtime);
    expect(out.visible).toMatch(/Loop scheduled/);
    expect(out.visible).toContain("every 5m");
    expect(out.visible).toContain("check the deploy");
    // Context summary plumbed for the LLM acknowledgement.
    expect(out.context).toContain("scheduled");
    expect(out.context).toContain("check the deploy");
    expect(out.context).toContain("5m");

    const rows = db.listLoopsForSession("ses_a");
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("*/5 * * * *");
    expect(rows[0].cwd).toBe("/tmp");
    expect(rows[0].prompt).toBe("check the deploy");
    expect(runtime.armedCount()).toBe(1);
  });

  it("uses the default interval when only a prompt is given", () => {
    const out = handleLoopCommand("check things", "ses_a", "/tmp", db, runtime);
    expect(out.visible).toContain("every 5m");
    expect(out.context).toContain("check things");
    const rows = db.listLoopsForSession("ses_a");
    expect(rows[0].schedule).toBe("*/5 * * * *");
    expect(rows[0].prompt).toBe("check things");
  });

  it("uses the default prompt when only an interval is given", () => {
    const out = handleLoopCommand("10m", "ses_a", "/tmp", db, runtime);
    expect(out.visible).toContain("every 10m");
    expect(out.context).toMatch(/default maintenance prompt/);
    const rows = db.listLoopsForSession("ses_a");
    expect(rows[0].schedule).toBe("*/10 * * * *");
    expect(rows[0].prompt.length).toBeGreaterThan(0);
  });

  it("uses defaults when no args are given", () => {
    const out = handleLoopCommand("", "ses_a", "/tmp", db, runtime);
    expect(out.visible).toContain("every 5m");
    expect(db.listLoopsForSession("ses_a")).toHaveLength(1);
  });

  it("rejects sub-minute intervals", () => {
    const out = handleLoopCommand("30s do thing", "ses_a", "/tmp", db, runtime);
    expect(out.visible).toMatch(/^Error:/);
    expect(out.context).toMatch(/failed to handle/);
    expect(db.listLoopsForSession("ses_a")).toHaveLength(0);
    expect(runtime.armedCount()).toBe(0);
  });

  it("sets a default expiry on new loops", () => {
    handleLoopCommand("5m test", "ses_a", "/tmp", db, runtime);
    const row = db.listLoopsForSession("ses_a")[0];
    expect(row.expiresAt).toBeDefined();
    expect(new Date(row.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("handleLoopStopCommand", () => {
  it("with no args, disables every active loop in the session", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    handleLoopCommand("10m b", "ses_a", "/tmp", db, runtime);
    handleLoopCommand("5m c", "ses_b", "/tmp", db, runtime);
    expect(runtime.armedCount()).toBe(3);

    const out = handleLoopStopCommand("", "ses_a", db, runtime);
    expect(out.visible).toMatch(/Stopped 2 loops/);
    expect(out.context).toContain("stopped all 2 active loops");
    expect(db.listEnabledLoopsForSession("ses_a")).toHaveLength(0);
    // The other session is untouched.
    expect(db.listEnabledLoopsForSession("ses_b")).toHaveLength(1);
  });

  it("with no args and no loops, reports nothing-to-stop", () => {
    const out = handleLoopStopCommand("", "ses_a", db, runtime);
    expect(out.visible).toMatch(/No active loops/i);
    expect(out.context).toMatch(/no active loops/i);
  });

  it("disables a specific loop by full id", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    const loop = db.listLoopsForSession("ses_a")[0];

    const out = handleLoopStopCommand(loop.id, "ses_a", db, runtime);
    expect(out.visible).toMatch(/Stopped loop/);
    expect(out.context).toContain("stopped the loop");
    expect(db.getSessionLoop(loop.id)!.enabled).toBe(false);
  });

  it("matches by id prefix when the prefix is long enough", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    const loop = db.listLoopsForSession("ses_a")[0];
    const prefix = loop.id.slice(0, 8);

    const out = handleLoopStopCommand(prefix, "ses_a", db, runtime);
    expect(out.visible).toMatch(/Stopped loop/);
    expect(db.getSessionLoop(loop.id)!.enabled).toBe(false);
  });

  it("reports no-match when id doesn't match", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    const out = handleLoopStopCommand("deadbeef", "ses_a", db, runtime);
    expect(out.visible).toMatch(/No loop matching/);
    expect(out.context).toMatch(/no matching loop/);
  });

  it("reports already-stopped for a disabled loop", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    const loop = db.listLoopsForSession("ses_a")[0];
    handleLoopStopCommand(loop.id, "ses_a", db, runtime);
    const out = handleLoopStopCommand(loop.id, "ses_a", db, runtime);
    expect(out.visible).toMatch(/already stopped/);
    expect(out.context).toMatch(/already stopped/);
  });
});

describe("handleLoopListCommand", () => {
  it("reports an empty session", () => {
    const out = handleLoopListCommand("ses_a", db);
    expect(out.visible).toMatch(/No active loops/i);
    expect(out.context).toMatch(/no active loops/i);
  });

  it("lists active loops only", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    handleLoopCommand("10m b", "ses_a", "/tmp", db, runtime);
    const loops = db.listLoopsForSession("ses_a");
    db.disableSessionLoop(loops[0].id);

    const out = handleLoopListCommand("ses_a", db);
    expect(out.visible).toContain("Active loops (1)");
    expect(out.visible).toContain(loops[1].id);
    expect(out.visible).not.toContain(loops[0].id);
    expect(out.context).toContain("1 active loop");
  });
});

describe("handleLoopEvent", () => {
  it("re-arms loops on the first event for a session (--resume case)", () => {
    // Pre-populate the DB as if from a previous opencode run.
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p1",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p2",
      schedule: "*/10 * * * *",
      cwd: "/tmp",
    });

    // No loops armed yet (fresh runtime).
    expect(runtime.armedCount()).toBe(0);

    handleLoopEvent({ type: "session.idle", sessionID: "ses_a" }, db, runtime);
    expect(runtime.armedCount()).toBe(2);

    // Subsequent events are a no-op (won't double-arm).
    handleLoopEvent({ type: "session.idle", sessionID: "ses_a" }, db, runtime);
    expect(runtime.armedCount()).toBe(2);
  });

  it("re-arm also recognizes properties.info.id-shaped events", () => {
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    handleLoopEvent(
      { type: "session.updated", properties: { info: { id: "ses_a" } } },
      db,
      runtime
    );
    expect(runtime.armedCount()).toBe(1);
  });

  it("ignores events without a session id", () => {
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    handleLoopEvent({ type: "lsp.updated" }, db, runtime);
    expect(runtime.armedCount()).toBe(0);
  });

  it("clears timers and deletes rows on session.deleted", () => {
    handleLoopCommand("5m p1", "ses_a", "/tmp", db, runtime);
    handleLoopCommand("10m p2", "ses_a", "/tmp", db, runtime);
    handleLoopCommand("5m p3", "ses_b", "/tmp", db, runtime);
    expect(runtime.armedCount()).toBe(3);
    expect(db.listLoopsForSession("ses_a")).toHaveLength(2);

    handleLoopEvent(
      {
        type: "session.deleted",
        properties: { info: { id: "ses_a" } },
      },
      db,
      runtime
    );

    expect(db.listLoopsForSession("ses_a")).toHaveLength(0);
    expect(db.listLoopsForSession("ses_b")).toHaveLength(1);
    // Only the ses_b loop should remain armed.
    expect(runtime.armedCount()).toBe(1);
  });

  it("session.deleted with no session id is a no-op", () => {
    handleLoopCommand("5m a", "ses_a", "/tmp", db, runtime);
    handleLoopEvent({ type: "session.deleted" }, db, runtime);
    expect(db.listLoopsForSession("ses_a")).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../db.js";
import { LoopRuntime } from "../loop-runtime.js";

/**
 * A tiny fake timer that lets tests "tick" manually. Each `setTimeoutFn`
 * call records a pending callback; `tickAll()` fires every pending
 * callback once and returns the count. This is enough to drive the
 * runtime's re-arming logic deterministically.
 */
class FakeClock {
  private next = 1;
  private pending = new Map<number, () => void>();

  setTimeoutFn = (cb: () => void, _ms: number): number => {
    const id = this.next++;
    this.pending.set(id, cb);
    return id;
  };

  clearTimeoutFn = (id: number): void => {
    this.pending.delete(id);
  };

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Fire all currently-pending callbacks. New callbacks registered as
   * a side effect are NOT fired -- caller can invoke `tickAll()` again
   * to drain them.
   */
  async tickAll(): Promise<number> {
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    for (const [, cb] of snapshot) {
      cb();
    }
    // Let microtasks (the async fireLoop body) run to completion.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return snapshot.length;
  }
}

let tmpDir: string;
let db: TaskDatabase;
let clock: FakeClock;
let delivered: Array<{ loopId: string }>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-loop-rt-"));
  db = new TaskDatabase(join(tmpDir, "test.db"));
  clock = new FakeClock();
  delivered = [];
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(opts?: {
  deliver?: (l: any) => Promise<void>;
}): LoopRuntime {
  return new LoopRuntime({
    db,
    deliver:
      opts?.deliver ??
      (async (loop) => {
        delivered.push({ loopId: loop.id });
      }),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

describe("LoopRuntime", () => {
  it("arms a freshly-created loop", () => {
    const rt = makeRuntime();
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      intervalLabel: "5m",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);

    expect(rt.isArmed(loop.id)).toBe(true);
    expect(rt.armedCount()).toBe(1);
  });

  it("ensureSessionArmed loads loops from DB on first call only", () => {
    const rt = makeRuntime();
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p1",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p2",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });

    rt.ensureSessionArmed("ses_a");
    expect(rt.armedCount()).toBe(2);

    // Second call is a no-op even if more rows exist.
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p3",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.ensureSessionArmed("ses_a");
    expect(rt.armedCount()).toBe(2);
  });

  it("ensureSessionArmed skips disabled loops", () => {
    const rt = makeRuntime();
    const a = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p1",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p2",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.disableSessionLoop(a.id);

    rt.ensureSessionArmed("ses_a");
    expect(rt.armedCount()).toBe(1);
    expect(rt.isArmed(a.id)).toBe(false);
  });

  it("ensureSessionArmed disables expired loops", () => {
    const rt = makeRuntime();
    const past = new Date(Date.now() - 1000).toISOString();
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
      expiresAt: past,
    });

    rt.ensureSessionArmed("ses_a");
    expect(rt.armedCount()).toBe(0);
    expect(db.getSessionLoop(loop.id)!.enabled).toBe(false);
  });

  it("fires the deliverer when the timer triggers and re-arms", async () => {
    const rt = makeRuntime();
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);

    expect(clock.pendingCount()).toBe(1);
    await clock.tickAll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].loopId).toBe(loop.id);
    // Should have re-armed after firing.
    expect(rt.armedCount()).toBe(1);
    // lastRunAt stamped.
    expect(db.getSessionLoop(loop.id)!.lastRunAt).toBeDefined();
  });

  it("does not re-arm a loop that was disabled mid-tick", async () => {
    const rt = makeRuntime({
      deliver: async (loop) => {
        delivered.push({ loopId: loop.id });
        db.disableSessionLoop(loop.id);
      },
    });
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);
    await clock.tickAll();

    expect(delivered).toHaveLength(1);
    expect(rt.armedCount()).toBe(0);
  });

  it("does not deliver a loop disabled before firing", async () => {
    const rt = makeRuntime();
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);
    db.disableSessionLoop(loop.id);

    await clock.tickAll();
    expect(delivered).toHaveLength(0);
    expect(rt.armedCount()).toBe(0);
  });

  it("does not deliver an expired loop and disables it", async () => {
    const rt = makeRuntime();
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);

    // Expire it before the timer fires.
    (db as any).db
      .prepare("UPDATE session_loops SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), loop.id);

    await clock.tickAll();
    expect(delivered).toHaveLength(0);
    expect(db.getSessionLoop(loop.id)!.enabled).toBe(false);
  });

  it("clearSession clears every timer for that session", () => {
    const rt = makeRuntime();
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p1",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p2",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    db.createSessionLoop({
      sessionId: "ses_b",
      prompt: "p3",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });

    rt.ensureSessionArmed("ses_a");
    rt.ensureSessionArmed("ses_b");
    expect(rt.armedCount()).toBe(3);

    rt.clearSession("ses_a");
    expect(rt.armedCount()).toBe(1);

    // After clearing, ensureSessionArmed should be willing to re-arm.
    rt.ensureSessionArmed("ses_a");
    expect(rt.armedCount()).toBe(3);
  });

  it("delivery errors don't kill the loop", async () => {
    let calls = 0;
    const rt = makeRuntime({
      deliver: async (loop) => {
        calls++;
        throw new Error("boom");
      },
    });
    const loop = db.createSessionLoop({
      sessionId: "ses_a",
      prompt: "p",
      schedule: "*/5 * * * *",
      cwd: "/tmp",
    });
    rt.armNewLoop(loop);

    await clock.tickAll();
    expect(calls).toBe(1);
    // Should have re-armed for the next tick.
    expect(rt.armedCount()).toBe(1);
  });
});

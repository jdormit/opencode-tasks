import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../db.js";
import {
  listActiveLoops,
  startLoop,
  stopAllLoops,
  stopLoopById,
} from "../loop-actions.js";
import { LoopRuntime } from "../loop-runtime.js";

let tmpDir: string;
let db: TaskDatabase;
let runtime: LoopRuntime;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-loop-actions-"));
  db = new TaskDatabase(join(tmpDir, "test.db"));
  runtime = new LoopRuntime({
    db,
    deliver: async () => {},
    setTimeoutFn: () => ({}),
    clearTimeoutFn: () => {},
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function start(sessionId = "ses_a", prompt = "check CI") {
  return startLoop({
    db,
    runtime,
    sessionId,
    cwd: "/tmp/project",
    intervalLabel: "5m",
    prompt,
  });
}

describe("startLoop", () => {
  it("creates and arms a loop", () => {
    const result = start();

    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    expect(result.loop.prompt).toBe("check CI");
    expect(result.loop.schedule).toBe("*/5 * * * *");
    expect(result.loop.intervalLabel).toBe("5m");
    expect(result.loop.expiresAt).toBeDefined();
    expect(runtime.isArmed(result.loop.id)).toBe(true);
  });

  it("rejects invalid intervals and empty prompts", () => {
    expect(
      startLoop({
        db,
        runtime,
        sessionId: "ses_a",
        cwd: "/tmp/project",
        intervalLabel: "30s",
        prompt: "check CI",
      }).kind
    ).toBe("invalid");
    expect(
      startLoop({
        db,
        runtime,
        sessionId: "ses_a",
        cwd: "/tmp/project",
        intervalLabel: "5m",
        prompt: "   ",
      }).kind
    ).toBe("invalid");
    expect(db.listLoopsForSession("ses_a")).toHaveLength(0);
  });
});

describe("listActiveLoops", () => {
  it("returns enabled loops from only the requested session", () => {
    const active = start("ses_a", "active");
    const stopped = start("ses_a", "stopped");
    start("ses_b", "other session");
    if (active.kind !== "started" || stopped.kind !== "started") return;
    db.disableSessionLoop(stopped.loop.id);

    expect(listActiveLoops(db, "ses_a").map((loop) => loop.id)).toEqual([
      active.loop.id,
    ]);
  });

  it("disables expired loops and clears their timers", () => {
    const started = start();
    if (started.kind !== "started") return;
    (db as any).db
      .prepare("UPDATE session_loops SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), started.loop.id);

    expect(listActiveLoops(db, "ses_a", runtime)).toHaveLength(0);
    expect(db.getSessionLoop(started.loop.id)?.enabled).toBe(false);
    expect(runtime.isArmed(started.loop.id)).toBe(false);
  });
});

describe("stopLoopById", () => {
  it("disables one loop and clears its timer", () => {
    const first = start("ses_a", "first");
    const second = start("ses_a", "second");
    if (first.kind !== "started" || second.kind !== "started") return;

    const result = stopLoopById(db, runtime, "ses_a", first.loop.id);

    expect(result.kind).toBe("stopped");
    expect(db.getSessionLoop(first.loop.id)?.enabled).toBe(false);
    expect(runtime.isArmed(first.loop.id)).toBe(false);
    expect(db.getSessionLoop(second.loop.id)?.enabled).toBe(true);
    expect(runtime.isArmed(second.loop.id)).toBe(true);
  });

  it("accepts an eight-character id prefix", () => {
    const started = start();
    if (started.kind !== "started") return;

    expect(
      stopLoopById(db, runtime, "ses_a", started.loop.id.slice(0, 8)).kind
    ).toBe("stopped");
  });

  it("does not stop loops from another session", () => {
    const started = start("ses_b");
    if (started.kind !== "started") return;

    expect(stopLoopById(db, runtime, "ses_a", started.loop.id).kind).toBe(
      "not-found"
    );
    expect(db.getSessionLoop(started.loop.id)?.enabled).toBe(true);
  });

  it("reports an already-stopped loop", () => {
    const started = start();
    if (started.kind !== "started") return;
    stopLoopById(db, runtime, "ses_a", started.loop.id);

    expect(stopLoopById(db, runtime, "ses_a", started.loop.id).kind).toBe(
      "already-stopped"
    );
  });
});

describe("stopAllLoops", () => {
  it("stops every active loop in one session", () => {
    start("ses_a", "first");
    start("ses_a", "second");
    start("ses_b", "other session");

    const result = stopAllLoops(db, runtime, "ses_a");

    expect(result.kind).toBe("stopped");
    expect(listActiveLoops(db, "ses_a")).toHaveLength(0);
    expect(listActiveLoops(db, "ses_b")).toHaveLength(1);
    expect(runtime.armedCount()).toBe(1);
  });
});

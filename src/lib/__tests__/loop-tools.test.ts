import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../db.js";
import { LoopRuntime } from "../loop-runtime.js";
import {
  executeListLoopsTool,
  executeStartLoopTool,
  executeStopLoopTool,
} from "../loop-tools.js";

let tmpDir: string;
let db: TaskDatabase;
let runtime: LoopRuntime;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-loop-tools-"));
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

const context = { sessionID: "ses_a", directory: "/tmp/project" };

describe("executeStartLoopTool", () => {
  it("starts a loop in the calling session with a default interval", () => {
    const output = executeStartLoopTool(
      { prompt: "check the deployment" },
      context,
      db,
      runtime
    );

    expect(output).toContain("Loop scheduled");
    expect(output).toContain("every 5m");
    const [loop] = db.listEnabledLoopsForSession("ses_a");
    expect(loop.prompt).toBe("check the deployment");
    expect(loop.cwd).toBe("/tmp/project");
    expect(runtime.isArmed(loop.id)).toBe(true);
  });

  it("returns interval validation errors without creating a loop", () => {
    const output = executeStartLoopTool(
      { prompt: "check", interval: "30s" },
      context,
      db,
      runtime
    );

    expect(output).toMatch(/^Error:/);
    expect(db.listLoopsForSession("ses_a")).toHaveLength(0);
  });
});

describe("executeListLoopsTool", () => {
  it("lists only active loops in the calling session", () => {
    executeStartLoopTool({ prompt: "mine" }, context, db, runtime);
    executeStartLoopTool(
      { prompt: "theirs" },
      { sessionID: "ses_b", directory: "/tmp/other" },
      db,
      runtime
    );

    const output = executeListLoopsTool(context, db, runtime);

    expect(output).toContain("mine");
    expect(output).not.toContain("theirs");
  });
});

describe("executeStopLoopTool", () => {
  it("stops the requested loop in the calling session", () => {
    executeStartLoopTool({ prompt: "mine" }, context, db, runtime);
    const [loop] = db.listEnabledLoopsForSession("ses_a");

    const output = executeStopLoopTool({ id: loop.id }, context, db, runtime);

    expect(output).toContain(`Stopped loop ${loop.id}`);
    expect(db.getSessionLoop(loop.id)?.enabled).toBe(false);
    expect(runtime.isArmed(loop.id)).toBe(false);
  });

  it("cannot stop a loop from another session", () => {
    executeStartLoopTool(
      { prompt: "theirs" },
      { sessionID: "ses_b", directory: "/tmp/other" },
      db,
      runtime
    );
    const [loop] = db.listEnabledLoopsForSession("ses_b");

    expect(
      executeStopLoopTool({ id: loop.id }, context, db, runtime)
    ).toContain("No loop matching");
    expect(db.getSessionLoop(loop.id)?.enabled).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduledTasksPlugin } from "../plugin.js";

let tmpDir: string;
let originalHome: string | undefined;
let plugin: Awaited<ReturnType<typeof ScheduledTasksPlugin>>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-plugin-tools-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  plugin = await ScheduledTasksPlugin({
    directory: "/tmp/project",
    client: {
      app: { log: async () => {} },
      session: { promptAsync: async () => {} },
    },
  } as any);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loop tool registration", () => {
  it("exposes start, list, and stop tools", () => {
    expect(plugin.tool?.start_loop).toBeDefined();
    expect(plugin.tool?.list_loops).toBeDefined();
    expect(plugin.tool?.stop_loop).toBeDefined();
  });

  it("requires stop_loop to receive an id", () => {
    const idSchema = plugin.tool!.stop_loop.args.id;

    expect(idSchema.safeParse(undefined).success).toBe(false);
    expect(idSchema.safeParse("").success).toBe(false);
    expect(idSchema.safeParse("deadbeef").success).toBe(true);
  });
});

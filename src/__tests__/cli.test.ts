import { describe, it, expect } from "bun:test";
import { parseScheduleTaskArgs } from "../cli.js";

describe("parseScheduleTaskArgs", () => {
  it("parses --flag value form", () => {
    const flags = parseScheduleTaskArgs([
      "--prompt",
      "do the thing",
      "--description",
      "desc",
      "--cwd",
      "/tmp",
    ]);
    expect(flags.prompt).toBe("do the thing");
    expect(flags.description).toBe("desc");
    expect(flags.cwd).toBe("/tmp");
    expect(flags.now).toBe(false);
    expect(flags.help).toBe(false);
  });

  it("parses --flag=value form", () => {
    const flags = parseScheduleTaskArgs([
      "--prompt=hello",
      "--cwd=/tmp",
      "--at=2099-01-01T00:00:00Z",
    ]);
    expect(flags.prompt).toBe("hello");
    expect(flags.cwd).toBe("/tmp");
    expect(flags.at).toBe("2099-01-01T00:00:00Z");
  });

  it("recognizes --now and --help as boolean flags", () => {
    const flags = parseScheduleTaskArgs(["--now", "--task", "cleanup"]);
    expect(flags.now).toBe(true);
    expect(flags.task).toBe("cleanup");

    const helpFlags = parseScheduleTaskArgs(["--help"]);
    expect(helpFlags.help).toBe(true);
  });

  it("parses all supported flags", () => {
    const flags = parseScheduleTaskArgs([
      "--task",
      "my-task",
      "--at",
      "2099-01-01T00:00:00Z",
      "--session-name",
      "sess",
      "--model",
      "anthropic/claude-sonnet-4-6",
      "--agent",
      "build",
      "--permission",
      '{"bash":"allow"}',
    ]);
    expect(flags.task).toBe("my-task");
    expect(flags.at).toBe("2099-01-01T00:00:00Z");
    expect(flags.sessionName).toBe("sess");
    expect(flags.model).toBe("anthropic/claude-sonnet-4-6");
    expect(flags.agent).toBe("build");
    expect(flags.permission).toBe('{"bash":"allow"}');
  });

  it("throws on unknown flags", () => {
    expect(() => parseScheduleTaskArgs(["--bogus", "x"])).toThrow(
      /Unknown flag/
    );
  });

  it("throws when a value flag is missing its value", () => {
    expect(() => parseScheduleTaskArgs(["--prompt"])).toThrow(
      /requires a value/
    );
  });
});

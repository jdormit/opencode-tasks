import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseTaskFile, readAllTasks, expandPath, setTaskEnabled } from "../tasks.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-tasks-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    expect(expandPath("~/projects")).toBe(join(home, "projects"));
    expect(expandPath("~")).toBe(home);
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandPath("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandPath("./foo/bar")).toBe("./foo/bar");
  });
});

describe("parseTaskFile", () => {
  it("parses a valid task file", () => {
    const filePath = join(tmpDir, "test-task.md");
    writeFileSync(
      filePath,
      `---
description: A test task
schedule: "0 9 * * *"
cwd: ~/projects
---

Do the thing.
`
    );

    const task = parseTaskFile(filePath);
    expect(task.name).toBe("test-task");
    expect(task.description).toBe("A test task");
    expect(task.schedule).toBe("0 9 * * *");
    expect(task.cwd).toBe("~/projects");
    expect(task.sessionName).toBeUndefined();
    expect(task.enabled).toBe(true);
    expect(task.prompt).toBe("Do the thing.");
    expect(task.filePath).toBe(filePath);
  });

  it("derives name from filename", () => {
    const filePath = join(tmpDir, "my-cool-task.md");
    writeFileSync(
      filePath,
      `---
schedule: "0 9 * * *"
cwd: /tmp
---

Prompt.
`
    );

    const task = parseTaskFile(filePath);
    expect(task.name).toBe("my-cool-task");
  });

  it("parses a task file without description", () => {
    const filePath = join(tmpDir, "no-desc.md");
    writeFileSync(
      filePath,
      `---
schedule: "0 9 * * *"
cwd: ~/projects
---

Do the thing.
`
    );

    const task = parseTaskFile(filePath);
    expect(task.name).toBe("no-desc");
    expect(task.description).toBeUndefined();
    expect(task.schedule).toBe("0 9 * * *");
  });

  it("parses all optional fields", () => {
    const filePath = join(tmpDir, "full-task.md");
    writeFileSync(
      filePath,
      `---
description: A full task
schedule: "0 9 * * 1-5"
cwd: ~/projects/app
session_name: my-session
model: anthropic/claude-sonnet-4-6
agent: build
permission:
  bash:
    "*": "allow"
  edit: "deny"
enabled: false
---

Full prompt here.
`
    );

    const task = parseTaskFile(filePath);
    expect(task.name).toBe("full-task");
    expect(task.sessionName).toBe("my-session");
    expect(task.model).toBe("anthropic/claude-sonnet-4-6");
    expect(task.agent).toBe("build");
    expect(task.permission).toEqual({
      bash: { "*": "allow" },
      edit: "deny",
    });
    expect(task.enabled).toBe(false);
  });

  it("throws on missing required fields", () => {
    const filePath = join(tmpDir, "bad-task.md");
    writeFileSync(
      filePath,
      `---
description: has description but no schedule or cwd
---

Missing fields.
`
    );

    expect(() => parseTaskFile(filePath)).toThrow("Invalid task file");
  });
});

describe("readAllTasks", () => {
  it("reads all .md files from a directory", () => {
    writeFileSync(
      join(tmpDir, "task-a.md"),
      `---
schedule: "0 9 * * *"
cwd: /tmp
---

Prompt A.
`
    );

    writeFileSync(
      join(tmpDir, "task-b.md"),
      `---
schedule: "0 10 * * *"
cwd: /tmp
---

Prompt B.
`
    );

    const { tasks, errors } = readAllTasks(tmpDir);
    expect(tasks).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(tasks.map((t) => t.name).sort()).toEqual(["task-a", "task-b"]);
  });

  it("returns errors for invalid files without crashing", () => {
    writeFileSync(
      join(tmpDir, "good.md"),
      `---
schedule: "0 9 * * *"
cwd: /tmp
---

Good prompt.
`
    );

    writeFileSync(join(tmpDir, "bad.md"), "no frontmatter at all");

    const { tasks, errors } = readAllTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("good");
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("bad.md");
  });

  it("returns empty arrays for nonexistent directory", () => {
    const { tasks, errors } = readAllTasks("/nonexistent/path");
    expect(tasks).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe("setTaskEnabled", () => {
  it("updates the enabled field in frontmatter", () => {
    const filePath = join(tmpDir, "toggle.md");
    writeFileSync(
      filePath,
      `---
schedule: "0 9 * * *"
cwd: /tmp
enabled: true
---

Prompt.
`
    );

    setTaskEnabled(filePath, false);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("enabled: false");

    setTaskEnabled(filePath, true);
    const content2 = readFileSync(filePath, "utf-8");
    expect(content2).toContain("enabled: true");
  });
});

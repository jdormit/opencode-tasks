import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveBunPath,
  sanitizePath,
  getDaemonDir,
  stageDaemon,
} from "../installer.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-tasks-installer-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sanitizePath", () => {
  it("strips bunx temp directory entries", () => {
    const input = [
      "/var/folders/k9/abc/T/bunx-501-opencode-tasks@latest/node_modules/.bin",
      "/Users/jdormit/.local/bin",
      "/private/var/folders/k9/abc/T/bunx-123-foo/node_modules/.bin",
      "/opt/homebrew/bin",
    ].join(":");
    const result = sanitizePath(input);
    expect(result).toBe("/Users/jdormit/.local/bin:/opt/homebrew/bin");
  });

  it("leaves a clean PATH unchanged", () => {
    const input = "/usr/local/bin:/usr/bin:/bin";
    expect(sanitizePath(input)).toBe(input);
  });

  it("handles empty entries gracefully", () => {
    const input = "/usr/bin::/bin";
    expect(sanitizePath(input)).toBe("/usr/bin:/bin");
  });
});

describe("getDaemonDir", () => {
  it("returns ~/.local/share/opencode-tasks under the given home", () => {
    expect(getDaemonDir({ HOME: "/Users/test" })).toBe(
      "/Users/test/.local/share/opencode-tasks"
    );
  });
});

describe("resolveBunPath", () => {
  // Helper: an existsFn backed by a set of paths that "exist".
  const existsIn =
    (paths: string[]) =>
    (p: string): boolean =>
      paths.includes(p);

  it("prefers the mise shim when execPath is a mise install and the shim exists", () => {
    const execPath =
      "/Users/test/.local/share/mise/installs/bun/1.3.11/bin/bun";
    const shim = "/Users/test/.local/share/mise/shims/bun";
    const result = resolveBunPath(execPath, {}, existsIn([execPath, shim]));
    expect(result).toBe(shim);
  });

  it("honors MISE_DATA_DIR when deriving the shim", () => {
    const execPath = "/custom/mise/installs/bun/1.3.11/bin/bun";
    const shim = "/custom/mise/shims/bun";
    const result = resolveBunPath(
      execPath,
      { MISE_DATA_DIR: "/custom/mise" },
      existsIn([execPath, shim])
    );
    expect(result).toBe(shim);
  });

  it("falls back to execPath when execPath is a mise install but the shim is missing", () => {
    const execPath =
      "/Users/test/.local/share/mise/installs/bun/1.3.11/bin/bun";
    const result = resolveBunPath(execPath, {}, existsIn([execPath]));
    expect(result).toBe(execPath);
  });

  it("uses execPath unchanged for a Homebrew install", () => {
    const execPath = "/opt/homebrew/bin/bun";
    const result = resolveBunPath(execPath, {}, existsIn([execPath]));
    expect(result).toBe(execPath);
  });

  it("uses execPath unchanged for a ~/.bun install", () => {
    const execPath = "/Users/test/.bun/bin/bun";
    const result = resolveBunPath(execPath, {}, existsIn([execPath]));
    expect(result).toBe(execPath);
  });

  it("recognizes a mise shims path directly and keeps it", () => {
    const shim = "/Users/test/.local/share/mise/shims/bun";
    const result = resolveBunPath(shim, {}, existsIn([shim]));
    expect(result).toBe(shim);
  });
});

describe("stageDaemon", () => {
  // Build a fake package root with dist + node_modules + resource dirs.
  function makePackageRoot(root: string): void {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), "// cli");
    writeFileSync(join(root, "dist", "plugin.js"), "// plugin");
    mkdirSync(join(root, "node_modules", "gray-matter"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "gray-matter", "index.js"),
      "module.exports = {};"
    );
    mkdirSync(join(root, "skill"), { recursive: true });
    writeFileSync(join(root, "skill", "SKILL.md"), "# skill");
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "loop.md"), "# loop");
    mkdirSync(join(root, "examples"), { recursive: true });
    writeFileSync(join(root, "examples", "example.md"), "# example");
  }

  it("copies dist, node_modules, and resource dirs into the daemon dir", () => {
    const pkgRoot = join(tmpDir, "pkg");
    const daemonDir = join(tmpDir, "daemon");
    makePackageRoot(pkgRoot);

    const cliPath = stageDaemon(pkgRoot, daemonDir);

    expect(existsSync(join(daemonDir, "dist", "cli.js"))).toBe(true);
    expect(existsSync(join(daemonDir, "dist", "plugin.js"))).toBe(true);
    expect(
      existsSync(join(daemonDir, "node_modules", "gray-matter", "index.js"))
    ).toBe(true);
    expect(existsSync(join(daemonDir, "skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(daemonDir, "commands", "loop.md"))).toBe(true);
    expect(existsSync(join(daemonDir, "examples", "example.md"))).toBe(true);
    // Returns the staged cli.js path.
    expect(cliPath).toBe(join(daemonDir, "dist", "cli.js"));
  });

  it("returns a cli.js path that actually exists after staging", () => {
    const pkgRoot = join(tmpDir, "pkg");
    const daemonDir = join(tmpDir, "daemon");
    makePackageRoot(pkgRoot);

    const cliPath = stageDaemon(pkgRoot, daemonDir);
    expect(existsSync(cliPath)).toBe(true);
  });

  it("overwrites a previous staged copy (idempotent re-stage)", () => {
    const pkgRoot = join(tmpDir, "pkg");
    const daemonDir = join(tmpDir, "daemon");
    makePackageRoot(pkgRoot);

    // Pre-existing stale file that should be cleared/overwritten.
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(join(daemonDir, "dist", "cli.js"), "// STALE");

    stageDaemon(pkgRoot, daemonDir);
    expect(readFileSync(join(daemonDir, "dist", "cli.js"), "utf-8")).toBe(
      "// cli"
    );
  });

  it("skips resource dirs that are absent in the package root", () => {
    const pkgRoot = join(tmpDir, "pkg");
    const daemonDir = join(tmpDir, "daemon");
    // Minimal root: only dist + node_modules, no skill/commands/examples.
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(join(pkgRoot, "dist", "cli.js"), "// cli");
    mkdirSync(join(pkgRoot, "node_modules"), { recursive: true });
    writeFileSync(join(pkgRoot, "node_modules", "placeholder"), "x");

    expect(() => stageDaemon(pkgRoot, daemonDir)).not.toThrow();
    expect(existsSync(join(daemonDir, "dist", "cli.js"))).toBe(true);
    expect(existsSync(join(daemonDir, "skill"))).toBe(false);
  });
});

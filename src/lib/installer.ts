import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "macos-launchd" | "linux-systemd" | "unsupported";

const LAUNCHD_LABEL = "ai.opencode.scheduled-tasks";
const SYSTEMD_SERVICE = "opencode-tasks.service";
const SYSTEMD_TIMER = "opencode-tasks.timer";

/**
 * Detect the platform and init system
 */
export function detectPlatform(): Platform {
  if (process.platform === "darwin") return "macos-launchd";
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--version"], { stdio: "ignore" });
      return "linux-systemd";
    } catch {
      // systemctl not found or not working
    }
  }
  return "unsupported";
}

/**
 * Resolve the absolute path to the CLI script.
 *
 * Since tsup bundles installer.ts into cli.js, import.meta.url
 * already points to the CLI script when running from the bundle.
 * When running from source (ts-node/tsx), we walk up to find dist/cli.js.
 * As a final fallback, we look for the `opencode-tasks` bin on PATH.
 */
function resolveSchedulerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);

  // Case 1: We ARE the CLI script (bundled by tsup)
  if (basename(thisFile) === "cli.js") {
    return resolve(thisFile);
  }

  // Case 2: Running from source (src/lib/installer.ts)
  // Walk up to find dist/cli.js
  const candidates = [
    join(dirname(dirname(thisFile)), "..", "dist", "cli.js"), // from src/lib/
    join(dirname(thisFile), "..", "dist", "cli.js"),          // from src/
    join(dirname(dirname(thisFile)), "cli.js"),               // from dist/lib/ (if unbundled)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  // Case 3: Fallback to PATH lookup
  try {
    const result = execFileSync("which", ["opencode-tasks"], {
      encoding: "utf-8",
    }).trim();
    if (result) return resolve(result);
  } catch {
    // not found
  }

  throw new Error(
    "Could not find the opencode-tasks script. " +
      "Make sure the package is properly installed."
  );
}

/**
 * Resolve the package root (the directory containing dist/, node_modules/,
 * skill/, commands/, examples/) from the resolved scheduler script path.
 *
 * The scheduler lives at <root>/dist/cli.js, so the root is two levels up.
 */
function resolvePackageRoot(): string {
  return dirname(dirname(resolveSchedulerPath()));
}

/**
 * Resolve a stable, absolute path to the bun binary to bake into the
 * launchd plist / systemd unit.
 *
 * launchd and systemd invoke the binary with a minimal environment and no
 * PATH resolution, so we must hand them an absolute path. `process.execPath`
 * is the bun that ran the installer, but if that points at a *version-pinned*
 * mise install (e.g. .../mise/installs/bun/1.3.11/bin/bun) the path breaks the
 * next time bun is upgraded and the old version is pruned.
 *
 * Strategy:
 *   - If execPath is a mise install or mise shim, prefer the stable mise
 *     shim (<miseRoot>/shims/bun), which re-resolves to the active bun
 *     across upgrades. Honor $MISE_DATA_DIR when deriving the root.
 *   - Otherwise (Homebrew /opt/homebrew/bin/bun, official installer
 *     ~/.bun/bin/bun, etc.) the path is already stable -- use it unchanged.
 *   - If the preferred shim doesn't exist, fall back to execPath.
 */
export function resolveBunPath(
  execPath: string,
  env: Record<string, string | undefined> = process.env,
  existsFn: (p: string) => boolean = existsSync
): string {
  // Already a mise shim -- keep it (it's the stable path we'd pick anyway).
  if (/[/\\]mise[/\\]shims[/\\]bun$/.test(execPath)) {
    return execPath;
  }

  // mise version-pinned install: .../mise/installs/<tool>/<version>/bin/<bin>
  const installMatch = execPath.match(
    /^(.*[/\\]mise)[/\\]installs[/\\][^/\\]+[/\\][^/\\]+[/\\]bin[/\\][^/\\]+$/
  );
  if (installMatch) {
    const miseRoot = env.MISE_DATA_DIR ?? installMatch[1];
    const shim = join(miseRoot, "shims", "bun");
    if (existsFn(shim)) {
      return shim;
    }
    // Shim missing for some reason -- the pinned path is better than nothing.
    return execPath;
  }

  // Homebrew, ~/.bun, system installs: already stable, use as-is.
  return execPath;
}

/**
 * Resolve a stable bun path and verify it actually launches (`bun --version`)
 * before it gets baked into a long-lived service definition. Falls back to
 * the raw execPath if the preferred path can't be executed.
 */
function resolveAndValidateBunPath(): string {
  const preferred = resolveBunPath(process.execPath);
  if (preferred === process.execPath) return preferred;
  try {
    execFileSync(preferred, ["--version"], { stdio: "ignore" });
    return preferred;
  } catch {
    // Preferred path doesn't launch under a clean env -- use the binary we
    // know works (the one currently running the installer).
    return process.execPath;
  }
}

/**
 * Remove volatile bunx temp-cache entries (under <tmp>/bunx-*) from a PATH
 * string. Those directories are periodically purged by the OS, so baking
 * them into a long-lived service environment is a foot-gun.
 */
export function sanitizePath(pathStr: string): string {
  return pathStr
    .split(":")
    .filter((entry) => entry.length > 0)
    .filter((entry) => !/[/\\]bunx-[^/\\]*/.test(entry))
    .join(":");
}

/**
 * Stable, install-method-independent directory the daemon is staged into.
 * Mirrors getLogDir()'s use of ~/.local/share. Once staged here the daemon
 * survives bunx temp purges, `bun unlink`, and moving the source checkout.
 */
export function getDaemonDir(
  env: Record<string, string | undefined> = process.env
): string {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  return join(home, ".local", "share", "opencode-tasks");
}

const STAGED_RESOURCE_DIRS = ["dist", "node_modules", "skill", "commands", "examples"];

/**
 * Copy a self-contained snapshot of the package (dist, node_modules, and
 * packaged resource dirs) from `packageRoot` into `daemonDir`, then return
 * the absolute path to the staged dist/cli.js.
 *
 * Each top-level dir is removed and recopied so re-installs are idempotent.
 * `dist` and `node_modules` must exist; the resource dirs are optional.
 */
export function stageDaemon(packageRoot: string, daemonDir: string): string {
  mkdirSync(daemonDir, { recursive: true });

  for (const name of STAGED_RESOURCE_DIRS) {
    const src = join(packageRoot, name);
    const dest = join(daemonDir, name);
    if (!existsSync(src)) {
      // dist / node_modules are required; resource dirs are optional.
      if (name === "dist" || name === "node_modules") {
        throw new Error(
          `Cannot stage daemon: required directory "${name}" not found in ${packageRoot}`
        );
      }
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }

  const cliPath = join(daemonDir, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Staged daemon is missing dist/cli.js at ${cliPath}`);
  }
  return cliPath;
}

function getHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function getLogDir(): string {
  const dir = join(getHome(), ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- macOS launchd ---

function getLaunchdPlistPath(): string {
  return join(
    getHome(),
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );
}

function generateLaunchdPlist(
  bunPath: string,
  schedulerPath: string
): string {
  const logDir = getLogDir();
  const currentPath = sanitizePath(
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${schedulerPath}</string>
    <string>--run-once</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${join(logDir, "scheduler.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, "scheduler.err")}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
</dict>
</plist>`;
}

async function installLaunchd(): Promise<void> {
  const bunPath = resolveAndValidateBunPath();
  // Stage a self-contained copy of the daemon into a stable app-support dir,
  // then point the plist at the staged cli.js -- never at a volatile bunx
  // temp dir or the source checkout.
  const packageRoot = resolvePackageRoot();
  const daemonDir = getDaemonDir();
  const schedulerPath = stageDaemon(packageRoot, daemonDir);
  const plistPath = getLaunchdPlistPath();

  // Ensure LaunchAgents directory exists
  mkdirSync(dirname(plistPath), { recursive: true });

  // Unload if already loaded
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    // Not loaded, that's fine
  }

  // Write plist
  const plist = generateLaunchdPlist(bunPath, schedulerPath);
  writeFileSync(plistPath, plist);

  // Load
  execFileSync("launchctl", ["load", plistPath]);

  console.log("Scheduler installed (macOS launchd)");
  console.log(`  Plist: ${plistPath}`);
  console.log(`  Bun:   ${bunPath}`);
  console.log(`  Daemon: ${daemonDir}`);
  console.log(`  Script: ${schedulerPath}`);
  console.log(`  Interval: every 60 seconds`);
  console.log(`  Logs: ${getLogDir()}/scheduler.{log,err}`);
}

async function uninstallLaunchd(): Promise<void> {
  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    console.log("Scheduler is not installed (no launchd plist found)");
    return;
  }

  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    // Already unloaded
  }

  unlinkSync(plistPath);
  console.log("Scheduler uninstalled (macOS launchd)");
  console.log(`  Removed: ${plistPath}`);
}

function isLaunchdInstalled(): boolean {
  return existsSync(getLaunchdPlistPath());
}

// --- Linux systemd ---

function getSystemdDir(): string {
  return join(getHome(), ".config", "systemd", "user");
}

function generateSystemdService(
  bunPath: string,
  schedulerPath: string
): string {
  const currentPath = sanitizePath(
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
  );

  return `[Unit]
Description=OpenCode Scheduled Tasks Runner

[Service]
Type=oneshot
KillMode=process
ExecStart=${bunPath} ${schedulerPath} --run-once
Environment=PATH=${currentPath}
`;
}

function generateSystemdTimer(): string {
  return `[Unit]
Description=OpenCode Scheduled Tasks Timer

[Timer]
OnBootSec=60
OnUnitActiveSec=60
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
}

async function installSystemd(): Promise<void> {
  const bunPath = resolveAndValidateBunPath();
  // Stage a self-contained copy of the daemon into a stable app-support dir,
  // then point the unit at the staged cli.js (see installLaunchd).
  const packageRoot = resolvePackageRoot();
  const daemonDir = getDaemonDir();
  const schedulerPath = stageDaemon(packageRoot, daemonDir);
  const systemdDir = getSystemdDir();

  mkdirSync(systemdDir, { recursive: true });

  const servicePath = join(systemdDir, SYSTEMD_SERVICE);
  const timerPath = join(systemdDir, SYSTEMD_TIMER);

  // Stop if already running
  try {
    execFileSync("systemctl", ["--user", "stop", SYSTEMD_TIMER], {
      stdio: "ignore",
    });
  } catch {
    // Not running
  }

  // Write unit files
  writeFileSync(servicePath, generateSystemdService(bunPath, schedulerPath));
  writeFileSync(timerPath, generateSystemdTimer());

  // Reload, enable, start
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", SYSTEMD_TIMER]);
  execFileSync("systemctl", ["--user", "start", SYSTEMD_TIMER]);

  console.log("Scheduler installed (Linux systemd)");
  console.log(`  Service: ${servicePath}`);
  console.log(`  Timer:   ${timerPath}`);
  console.log(`  Bun:     ${bunPath}`);
  console.log(`  Daemon:  ${daemonDir}`);
  console.log(`  Script:  ${schedulerPath}`);
  console.log(`  Interval: every 60 seconds`);
}

async function uninstallSystemd(): Promise<void> {
  const systemdDir = getSystemdDir();
  const servicePath = join(systemdDir, SYSTEMD_SERVICE);
  const timerPath = join(systemdDir, SYSTEMD_TIMER);

  if (!existsSync(timerPath) && !existsSync(servicePath)) {
    console.log("Scheduler is not installed (no systemd units found)");
    return;
  }

  try {
    execFileSync("systemctl", ["--user", "stop", SYSTEMD_TIMER], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "disable", SYSTEMD_TIMER], {
      stdio: "ignore",
    });
  } catch {
    // Already stopped/disabled
  }

  if (existsSync(servicePath)) unlinkSync(servicePath);
  if (existsSync(timerPath)) unlinkSync(timerPath);

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // Best effort
  }

  console.log("Scheduler uninstalled (Linux systemd)");
  console.log(`  Removed: ${servicePath}`);
  console.log(`  Removed: ${timerPath}`);
}

function isSystemdInstalled(): boolean {
  const systemdDir = getSystemdDir();
  return existsSync(join(systemdDir, SYSTEMD_TIMER));
}

// --- Public API ---

/**
 * Install the scheduler for the detected platform
 */
export async function install(): Promise<void> {
  const platform = detectPlatform();

  switch (platform) {
    case "macos-launchd":
      await installLaunchd();
      break;
    case "linux-systemd":
      await installSystemd();
      break;
    case "unsupported":
      console.error(
        "Unsupported platform. Supported: macOS (launchd), Linux (systemd)."
      );
      console.error("You can still run the scheduler manually:");
      console.error("  bunx opencode-tasks --run-once");
      process.exit(1);
  }
}

/**
 * Uninstall the scheduler for the detected platform
 */
export async function uninstall(): Promise<void> {
  const platform = detectPlatform();

  switch (platform) {
    case "macos-launchd":
      await uninstallLaunchd();
      break;
    case "linux-systemd":
      await uninstallSystemd();
      break;
    case "unsupported":
      console.error("No supported init system found.");
      process.exit(1);
  }
}

/**
 * Check if the scheduler is installed
 */
export function isInstalled(): boolean {
  const platform = detectPlatform();
  switch (platform) {
    case "macos-launchd":
      return isLaunchdInstalled();
    case "linux-systemd":
      return isSystemdInstalled();
    default:
      return false;
  }
}

/**
 * Get info about the current installation
 */
export function getInstallInfo(): {
  installed: boolean;
  platform: Platform;
  details?: string;
} {
  const platform = detectPlatform();
  const installed = isInstalled();

  let details: string | undefined;
  if (installed) {
    switch (platform) {
      case "macos-launchd":
        details = `Plist: ${getLaunchdPlistPath()}`;
        break;
      case "linux-systemd":
        details = `Timer: ${join(getSystemdDir(), SYSTEMD_TIMER)}`;
        break;
    }
  }

  return { installed, platform, details };
}

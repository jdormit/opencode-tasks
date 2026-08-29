/**
 * Helpers for the `/loop` slash command: parsing user input, converting
 * interval labels into cron expressions, and formatting confirmation
 * messages.
 *
 * The loop runtime itself (timer management, prompt injection) lives in
 * `src/plugin.ts`. These functions are pure so they can be unit-tested
 * without an opencode session.
 */

import { getNextRunTime } from "./cron.js";
import type { SessionLoop } from "./types.js";

/** Default interval used when the user passes a bare prompt with no interval. */
export const DEFAULT_INTERVAL_LABEL = "5m";

/** Default expiry for a freshly-created loop. Matches Claude Code's `/loop`. */
export const DEFAULT_LOOP_EXPIRY_DAYS = 3;

export class LoopArgError extends Error {}

export interface ParsedLoopArgs {
  intervalLabel: string;
  prompt: string;
  /**
   * True if the caller omitted the prompt entirely (i.e. `/loop` or
   * `/loop 5m`). The plugin uses this to fall back to a default
   * maintenance prompt or a project-specific `loop.md` body.
   */
  promptOmitted: boolean;
  /**
   * True if the caller omitted the interval (i.e. `/loop check things`).
   * In that case `intervalLabel` is set to `DEFAULT_INTERVAL_LABEL`.
   */
  intervalOmitted: boolean;
}

const INTERVAL_RE = /^(\d+)([smhd])$/i;

/**
 * Parse the raw `arguments` string passed by opencode's command system.
 *
 * Grammar (mirroring Claude Code's `/loop`):
 *   /loop                       -> interval default, prompt default
 *   /loop <interval>            -> given interval, prompt default
 *   /loop <prompt>              -> default interval, given prompt
 *   /loop <interval> <prompt>   -> given interval and prompt
 *
 * Interval format: number + s/m/h/d (case-insensitive).
 */
export function parseLoopArgs(raw: string): ParsedLoopArgs {
  const trimmed = (raw ?? "").trim();

  if (!trimmed) {
    return {
      intervalLabel: DEFAULT_INTERVAL_LABEL,
      prompt: "",
      promptOmitted: true,
      intervalOmitted: true,
    };
  }

  // Split on the first whitespace run. The first token may or may not
  // be an interval label; if not, the whole input is the prompt.
  const wsIdx = trimmed.search(/\s/);
  if (wsIdx === -1) {
    // Single token. Is it an interval?
    if (INTERVAL_RE.test(trimmed)) {
      return {
        intervalLabel: trimmed.toLowerCase(),
        prompt: "",
        promptOmitted: true,
        intervalOmitted: false,
      };
    }
    return {
      intervalLabel: DEFAULT_INTERVAL_LABEL,
      prompt: trimmed,
      promptOmitted: false,
      intervalOmitted: true,
    };
  }

  const first = trimmed.slice(0, wsIdx);
  const rest = trimmed.slice(wsIdx + 1).trim();

  if (INTERVAL_RE.test(first)) {
    return {
      intervalLabel: first.toLowerCase(),
      prompt: rest,
      promptOmitted: rest.length === 0,
      intervalOmitted: false,
    };
  }

  return {
    intervalLabel: DEFAULT_INTERVAL_LABEL,
    prompt: trimmed,
    promptOmitted: false,
    intervalOmitted: true,
  };
}

export interface IntervalCron {
  cron: string;
  /** Approximate number of minutes between firings; useful for logs. */
  approxMinutes: number;
}

/**
 * Convert an interval label like "5m", "2h", "1d" into a 5-field cron
 * expression. Throws `LoopArgError` for invalid input or for intervals
 * shorter than 1 minute (the minimum opencode supports).
 *
 * Mapping (chosen so the cron evenly divides the natural cycle):
 *   Nm  -> "* / N * * * *"  (every N minutes)
 *   Nh  -> "0 * / N * * *"  (top of every Nth hour)
 *   Nd  -> "0 0 * / N * *"  (midnight every Nth day of month)
 */
export function intervalToCron(label: string): IntervalCron {
  const m = label.match(INTERVAL_RE);
  if (!m) {
    throw new LoopArgError(
      `Invalid interval "${label}". Use a number followed by s/m/h/d (e.g. 5m, 2h, 1d).`
    );
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();

  if (!Number.isInteger(n) || n <= 0) {
    throw new LoopArgError(
      `Invalid interval "${label}". The numeric part must be a positive integer.`
    );
  }

  if (unit === "s") {
    throw new LoopArgError(
      `Sub-minute intervals (like "${label}") aren't supported. Use 1m or longer.`
    );
  }

  if (unit === "m") {
    if (n > 59) {
      throw new LoopArgError(
        `Minute interval "${label}" is too large. Use hours (e.g. "${Math.round(n / 60)}h") for intervals \u2265 1 hour.`
      );
    }
    return { cron: `*/${n} * * * *`, approxMinutes: n };
  }

  if (unit === "h") {
    if (n > 23) {
      throw new LoopArgError(
        `Hour interval "${label}" is too large. Use days (e.g. "${Math.round(n / 24)}d") for intervals \u2265 1 day.`
      );
    }
    return { cron: `0 */${n} * * *`, approxMinutes: n * 60 };
  }

  // unit === "d"
  if (n > 31) {
    throw new LoopArgError(
      `Day interval "${label}" is too large. Maximum is 31d.`
    );
  }
  return { cron: `0 0 */${n} * *`, approxMinutes: n * 60 * 24 };
}

/**
 * Compute milliseconds from `now` until the next firing of the given
 * cron expression.
 */
export function msUntilNextCronTick(
  cron: string,
  now: Date = new Date()
): number {
  const next = new Date(getNextRunTime(cron, now));
  return Math.max(0, next.getTime() - now.getTime());
}

/**
 * Default expiry for a new loop, expressed as an ISO timestamp.
 */
export function defaultExpiry(
  now: Date = new Date(),
  days: number = DEFAULT_LOOP_EXPIRY_DAYS
): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returns true if the loop has expired and should no longer fire.
 */
export function isExpired(loop: SessionLoop, now: Date = new Date()): boolean {
  if (!loop.expiresAt) return false;
  return new Date(loop.expiresAt).getTime() <= now.getTime();
}

export function formatLoopConfirmation(
  loop: SessionLoop,
  opts?: { schedulerWarning?: string; stopHint?: string }
): string {
  const lines = [
    `Loop scheduled.`,
    `  ID: ${loop.id}`,
    `  Cadence: every ${loop.intervalLabel ?? loop.schedule}`,
    `  Prompt: ${truncate(loop.prompt, 200)}`,
  ];
  if (loop.expiresAt) {
    lines.push(`  Expires: ${loop.expiresAt}`);
  }
  lines.push(
    `  ${opts?.stopHint ?? `Stop with: /loop-stop ${loop.id}  (or /loop-stop to stop all loops in this session)`}`
  );
  if (opts?.schedulerWarning) {
    lines.push("");
    lines.push(opts.schedulerWarning);
  }
  return lines.join("\n");
}

export function formatLoopStopped(loops: SessionLoop[]): string {
  if (loops.length === 0) {
    return "No active loops to stop.";
  }
  if (loops.length === 1) {
    return `Stopped loop ${loops[0].id} (was: every ${loops[0].intervalLabel ?? loops[0].schedule}).`;
  }
  const lines = [`Stopped ${loops.length} loops:`];
  for (const l of loops) {
    lines.push(`  ${l.id}  every ${l.intervalLabel ?? l.schedule}`);
  }
  return lines.join("\n");
}

export function formatLoopList(
  loops: SessionLoop[],
  opts?: { emptyHint?: string }
): string {
  if (loops.length === 0) {
    return `No active loops in this session. ${opts?.emptyHint ?? "Use `/loop <interval> <prompt>` to start one."}`;
  }
  const lines = [`Active loops (${loops.length}):`];
  for (const l of loops) {
    lines.push("");
    lines.push(`  ${l.id}`);
    lines.push(`    Cadence: every ${l.intervalLabel ?? l.schedule}`);
    lines.push(`    Prompt:  ${truncate(l.prompt, 200)}`);
    if (l.lastRunAt) lines.push(`    Last:    ${l.lastRunAt}`);
    if (l.expiresAt) lines.push(`    Expires: ${l.expiresAt}`);
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

/**
 * Pure handlers for the `/loop`, `/loop-stop`, `/loop-list` slash
 * commands, plus the corresponding event-hook helper.
 *
 * These live in a separate module from `src/plugin.ts` because
 * opencode's plugin loader (`getLegacyPlugins` in
 * packages/opencode/src/plugin/index.ts) iterates every named export
 * of a plugin module and tries to invoke each as a plugin factory.
 * If we exported these handlers from `plugin.ts` they'd get called
 * with `(PluginInput, options)` instead of their real signatures,
 * producing confusing runtime errors. Keeping them here makes the
 * plugin entry point export only the plugin factory itself.
 */

import type { TaskDatabase } from "./db.js";
import {
  parseLoopArgs,
  intervalToCron,
  defaultExpiry,
  formatLoopConfirmation,
  formatLoopStopped,
  formatLoopList,
  LoopArgError,
} from "./loops.js";
import { LoopRuntime, type LoopLogger } from "./loop-runtime.js";

/**
 * Fallback prompt used when the user invokes `/loop` with no prompt
 * argument. Mirrors Claude Code's "built-in maintenance prompt" idea
 * but stays brief and provider-neutral.
 */
export const LOOP_DEFAULT_PROMPT =
  "Continue making progress on the current task. If you're blocked or waiting on input, summarize the state in one or two lines and stop.";

/**
 * Result returned by every `/loop*` slash command handler.
 *
 * The two strings serve different audiences:
 *
 *  - `visible` is shown to the user in the transcript via a part
 *    marked `ignored: true`. It's the full human-readable confirmation
 *    or error.
 *
 *  - `context` is fed to the LLM via a part marked `synthetic: true`,
 *    wrapped in instructions that tell the model to acknowledge the
 *    action in one short conversational sentence. Keep it as a brief
 *    factual summary ("scheduled a loop running '<prompt>' every 5m"),
 *    not the full confirmation -- the LLM only needs enough to phrase
 *    a natural reply.
 */
export interface LoopCommandReply {
  visible: string;
  context: string;
}

/**
 * Truncate text for inclusion in a `context` string so a long
 * user-supplied prompt doesn't bloat the synthetic LLM hint.
 */
function shortPrompt(text: string, max: number = 100): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}

/**
 * Extract a session ID from a plugin event, if present. Matches the
 * known event shapes (`event.properties.info.id`, `event.sessionID`,
 * `event.properties.sessionID`).
 */
export function sessionIdFromEvent(event: any): string | undefined {
  const candidates = [
    event?.properties?.info?.id,
    event?.sessionID,
    event?.properties?.sessionID,
    event?.properties?.info?.sessionID,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("ses_")) return c;
  }
  return undefined;
}

/**
 * Process an opencode plugin event for the session-loop runtime:
 *
 * - For any event carrying a session id (other than session.deleted),
 *   lazily re-arm timers for that session if we haven't seen it yet.
 * - On session.deleted, clear timers and delete persisted loops.
 */
export function handleLoopEvent(
  event: any,
  db: TaskDatabase,
  runtime: LoopRuntime,
  logger?: LoopLogger
): void {
  const sessionId = sessionIdFromEvent(event);

  if (event?.type === "session.deleted" && sessionId) {
    try {
      runtime.clearSession(sessionId);
      const removed = db.deleteLoopsForSession(sessionId);
      if (removed > 0 && logger) {
        logger.info(
          `Cleaned up ${removed} session loop(s) for deleted session ${sessionId}`
        );
      }
    } catch {
      // Non-fatal.
    }
    return;
  }

  if (sessionId) {
    try {
      runtime.ensureSessionArmed(sessionId);
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Handle `/loop [interval] [prompt]`. Inserts a new `session_loops`
 * row, arms a timer via the runtime, and returns the confirmation
 * text plus a short context summary for the LLM acknowledgement.
 */
export function handleLoopCommand(
  args: string,
  sessionId: string,
  cwd: string,
  db: TaskDatabase,
  runtime: LoopRuntime
): LoopCommandReply {
  let parsed;
  try {
    parsed = parseLoopArgs(args);
  } catch (err: any) {
    return { visible: `Error: ${err.message}`, context: errorContext(err.message) };
  }

  let cron: string;
  try {
    cron = intervalToCron(parsed.intervalLabel).cron;
  } catch (err: any) {
    if (err instanceof LoopArgError) {
      return { visible: `Error: ${err.message}`, context: errorContext(err.message) };
    }
    throw err;
  }

  const prompt = parsed.promptOmitted ? LOOP_DEFAULT_PROMPT : parsed.prompt;

  const loop = db.createSessionLoop({
    sessionId,
    prompt,
    schedule: cron,
    intervalLabel: parsed.intervalLabel,
    cwd,
    expiresAt: defaultExpiry(),
  });

  runtime.armNewLoop(loop);

  const label = loop.intervalLabel ?? loop.schedule;
  const context = parsed.promptOmitted
    ? `scheduled a /loop running the default maintenance prompt every ${label}`
    : `scheduled a /loop running "${shortPrompt(prompt)}" every ${label}`;

  return { visible: formatLoopConfirmation(loop), context };
}

/**
 * Handle `/loop-stop [id]`. With no argument, disables every active
 * loop in the session. With an argument, disables that specific loop
 * (matched by full or short id prefix).
 */
export function handleLoopStopCommand(
  args: string,
  sessionId: string,
  db: TaskDatabase,
  runtime: LoopRuntime
): LoopCommandReply {
  const trimmed = (args ?? "").trim();

  if (!trimmed) {
    const enabled = db.listEnabledLoopsForSession(sessionId);
    for (const loop of enabled) {
      runtime.clearLoop(loop.id);
    }
    db.disableLoopsForSession(sessionId);
    const visible = formatLoopStopped(enabled);
    let context: string;
    if (enabled.length === 0) {
      context = "ran /loop-stop but there were no active loops to stop";
    } else if (enabled.length === 1) {
      context = "stopped the single active loop in this session";
    } else {
      context = `stopped all ${enabled.length} active loops in this session`;
    }
    return { visible, context };
  }

  // Match by full id, or by short prefix (>=8 chars) for convenience.
  const all = db.listLoopsForSession(sessionId);
  const candidates = all.filter(
    (l) => l.id === trimmed || (trimmed.length >= 8 && l.id.startsWith(trimmed))
  );

  if (candidates.length === 0) {
    const visible = `No loop matching "${trimmed}" in this session. Run /loop-list to see active loops.`;
    return {
      visible,
      context: `tried to /loop-stop "${trimmed}" but no matching loop exists in this session`,
    };
  }
  if (candidates.length > 1) {
    const visible = `Ambiguous id "${trimmed}" matches ${candidates.length} loops; provide more characters.`;
    return {
      visible,
      context: `tried to /loop-stop "${trimmed}" but it matched ${candidates.length} loops ambiguously`,
    };
  }

  const loop = candidates[0];
  if (!loop.enabled) {
    return {
      visible: `Loop ${loop.id} is already stopped.`,
      context: `tried to /loop-stop a loop that was already stopped`,
    };
  }
  runtime.clearLoop(loop.id);
  db.disableSessionLoop(loop.id);
  const label = loop.intervalLabel ?? loop.schedule;
  return {
    visible: formatLoopStopped([loop]),
    context: `stopped the loop that ran "${shortPrompt(loop.prompt)}" every ${label}`,
  };
}

/**
 * Handle `/loop-list`. Reports all active loops for the current
 * session.
 */
export function handleLoopListCommand(
  sessionId: string,
  db: TaskDatabase
): LoopCommandReply {
  const loops = db.listEnabledLoopsForSession(sessionId);
  const visible = formatLoopList(loops);
  const context =
    loops.length === 0
      ? "showed the /loop-list output; there are no active loops in this session"
      : `showed the /loop-list output with ${loops.length} active loop${loops.length === 1 ? "" : "s"}`;
  return { visible, context };
}

/**
 * Build the `context` string used when reporting an internal error
 * (e.g. handler exception).
 */
function errorContext(message: string): string {
  return `failed to handle the slash command with the error: ${shortPrompt(message, 160)}`;
}
